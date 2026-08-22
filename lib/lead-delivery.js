const { randomUUID } = require('node:crypto');
const db = require('./supabase');

function clean(value, max = 200) { return value == null ? '' : String(value).trim().slice(0, max); }
function compact(value) {
  if (Array.isArray(value)) return value.map(compact).filter(item => item !== undefined);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== '').map(([key, item]) => [key, compact(item)]));
}
function redact(value) {
  if (!value || typeof value !== 'object') return value;
  const blocked = /token|authorization|secret|password|auth_code|^key$/i;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, blocked.test(key) ? '[REDACTED]' : redact(item)]));
}
function clientIp(req) {
  return clean(req.headers['x-forwarded-for']).split(',')[0] || clean(req.headers['x-real-ip']) || clean(req.socket && req.socket.remoteAddress);
}

function prepareLead(body, req) {
  return {
    id: randomUUID(), first_name: clean(body.first_name, 80), last_name: clean(body.last_name, 80),
    email: clean(body.email, 254).toLowerCase(), phone: clean(body.phone, 30),
    address: clean(body.address, 200), address2: clean(body.address2, 100), city: clean(body.city, 100),
    state: clean(body.state, 2).toUpperCase(), zip: clean(body.zip, 10), payload: body,
    consent_text: clean(body.consent_text, 4000), consent_timestamp: clean(body.consent_timestamp, 40) || new Date().toISOString(),
    trusted_form_cert_url: clean(body.xxTrustedFormCertUrl, 500), source_url: clean(body.page_url, 1000),
    ip_address: clientIp(req), user_agent: clean(req.headers['user-agent'], 500), delivery_status: 'pending'
  };
}

async function insertLead(lead) {
  await db.request('leads', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(lead) });
  return lead;
}
async function saveLead(body, req) { const lead = prepareLead(body, req); await insertLead(lead); return lead; }

function runtimeBuyers() {
  let buyers;
  try { buyers = JSON.parse(process.env.BUYER_ROUTING_CONFIG_V2 || process.env.BUYER_ROUTING_CONFIG || '[]'); }
  catch { throw new Error('Deployed buyer routing configuration is invalid JSON'); }
  if (!Array.isArray(buyers)) throw new Error('Deployed buyer routing configuration must be an array');
  return buyers.filter(buyer => buyer && buyer.delivery_mode !== 'off').sort((a, b) => (a.priority || 100) - (b.priority || 100));
}

async function resolveBuyers(loadPublished = async () => db.request('buyers?published_config=not.is.null&select=published_config')) {
  let environmentError = null;
  try {
    const buyers = runtimeBuyers();
    if (buyers.length) return { buyers, source: 'vercel_environment', environmentError: null };
  } catch (error) {
    environmentError = error;
  }
  const rows = await loadPublished();
  const buyers = rows.map(row => row && row.published_config).filter(buyer => buyer && buyer.delivery_mode !== 'off').sort((a, b) => (a.priority || 100) - (b.priority || 100));
  if (buyers.length) return { buyers, source: 'supabase_recovery', environmentError: environmentError ? environmentError.message : null };
  if (environmentError) throw environmentError;
  return { buyers: [], source: 'none', environmentError: null };
}

function endpointFor(buyer, stage) {
  if (buyer.adapter === 'jangl_auto') {
    const base = clean(process.env.JANGL_API_BASE_URL, 1000).replace(/\/$/, '');
    if (stage === 'ping') return buyer.ping_endpoint_url || (base ? `${base}/ping` : '');
    if (stage === 'post') return buyer.post_endpoint_url || (base ? `${base}/post` : '');
    if (stage === 'direct') return buyer.direct_endpoint_url || buyer.post_endpoint_url || (base ? `${base}/post` : '');
  }
  if (stage === 'ping') return buyer.ping_endpoint_url;
  if (stage === 'post') return buyer.post_endpoint_url;
  return buyer.direct_endpoint_url;
}

function attemptRecord(lead, buyer, stage, payload, result, started, attemptNumber) {
  return {
    lead_id: lead.id, buyer_id: buyer.id, stage, mode: buyer.delivery_mode, environment: buyer.environment,
    attempt_number: attemptNumber, status: result.status, request_payload: redact(payload), response_payload: redact(result.body),
    http_status: result.httpStatus || null, price: result.price == null ? null : result.price,
    external_reference: result.externalReference || null, error: result.error || null,
    latency_ms: Date.now() - started, completed_at: new Date().toISOString(), created_at: new Date(started).toISOString()
  };
}

async function sendStage(lead, buyer, stage, payload, attemptNumber = 1) {
  const started = Date.now();
  let result;
  try {
    const endpoint = endpointFor(buyer, stage);
    if (!endpoint) throw new Error(`No ${stage} endpoint configured`);
    const secret = buyer.auth_env_var ? process.env[buyer.auth_env_var] : '';
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json', ...(buyer.headers || {}) };
    if (secret && buyer.adapter !== 'leadportal_ipr') headers.Authorization = buyer.auth_scheme ? `${buyer.auth_scheme} ${secret}` : secret;
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(buyer.timeout_ms || 12000) });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 4000) }; }
    const upstream = buyer.adapter === 'leadportal_ipr' && body.response ? body.response : body;
    const upstreamStatus = String(upstream.status || '').toLowerCase();
    const rejectedStatuses = ['denied', 'rejected', 'error', 're-ping', 'unmatched'];
    const accepted = response.ok && !rejectedStatuses.includes(upstreamStatus);
    result = { accepted, status: accepted ? 'accepted' : 'rejected', httpStatus: response.status, body, price: Number(upstream.price) || null, externalReference: upstream.confirmation_id || upstream.lead_id || upstream.id || null };
  } catch (error) {
    result = { accepted: false, status: 'error', error: clean(error.message, 1000), body: null };
  }
  return { ...result, attempt: attemptRecord(lead, buyer, stage, payload, result, started, attemptNumber) };
}

function genericPayload(lead) { return { lead_id: lead.id, ...lead.payload }; }
function leadPortalPayload(lead, buyer, stage, leadId) {
  const body = lead.payload || {};
  const request = compact({
    Format: 'JSON', Key: buyer.auth_env_var ? process.env[buyer.auth_env_var] : '', API_Action: 'iprSubmitLead',
    Mode: stage === 'direct' ? 'full' : stage, Lead_ID: stage === 'post' ? leadId : undefined,
    Return_Best_Price: 1, Return_Min_Duration: stage === 'ping' ? 1 : undefined,
    TYPE: buyer.lead_type || buyer.campaign_name, Test_Lead: buyer.environment === 'test' ? 1 : undefined,
    Trusted_Form_URL: lead.trusted_form_cert_url, LeadiD_Token: body.leadid_token || body.universal_leadid,
    TCPA_Language: lead.consent_text, Origin_Phone: clean(lead.phone).replace(/\D/g, ''),
    First_Name: lead.first_name, Last_Name: lead.last_name, Email: lead.email, Address: lead.address,
    City: lead.city, State: lead.state, ZIP: lead.zip, SRC: buyer.source_code,
    Terminating_Phone: clean(buyer.terminating_phone).replace(/\D/g, '')
  });
  return { Request: request };
}
function janglPayload(lead, buyer, stage, authCode) {
  const body = lead.payload || {};
  const vehicle = suffix => compact({ year: Number.parseInt(clean(body[`year${suffix}`]), 10), make: clean(body[`make${suffix}`], 80), model: clean(body[`model${suffix}`], 100) });
  const vehicles = [vehicle('')];
  if (String(body.second_vehicle).toLowerCase() === 'yes') vehicles.push(vehicle('_2'));
  const driver = compact({
    birth_date: clean(body.birthdate, 10), relationship: 'Self', license_state: clean(body.state, 2).toUpperCase(),
    residence_type: String(body.own_or_rent).toLowerCase() === 'own' ? 'Own' : String(body.own_or_rent).toLowerCase() === 'rent' ? 'Rent' : undefined,
    ...(stage === 'ping' ? {} : { first_name: clean(body.first_name, 80), last_name: clean(body.last_name, 80) })
  });
  for (const incident of Array.isArray(body.incidents) ? body.incidents.slice(0, 10) : []) {
    const item = { [incident.type === 'Ticket' ? 'ticket_date' : incident.type === 'Accident' ? 'accident_date' : 'violation_date']: clean(incident.date, 10) };
    if (incident.type === 'Ticket') (driver.tickets ||= []).push(item);
    if (incident.type === 'Accident') (driver.accidents ||= []).push(item);
    if (incident.type === 'Major Violation') (driver.major_violations ||= []).push(item);
  }
  const base = {
    meta: compact({ originally_created: lead.consent_timestamp, source_id: clean(buyer.campaign_id || process.env.JANGL_SOURCE_ID, 100), offer_id: clean(buyer.campaign_name || process.env.JANGL_OFFER_ID, 200), trusted_form_cert_url: lead.trusted_form_cert_url, tcpa_compliant: true, tcpa_consent_text: lead.consent_text, user_agent: lead.user_agent, landing_page_url: lead.source_url }),
    data: compact({ drivers: [driver], vehicles, requested_policy: { coverage_type: clean(body.coverage_type, 30) }, current_policy: String(body.has_coverage).toLowerCase() === 'yes' ? { insurance_company: clean(body.former_insurer, 120) } : undefined })
  };
  if (stage === 'ping') return { ...base, contact: { phone_last_four: clean(body.phone).replace(/\D/g, '').slice(-4), zip_code: clean(body.zip, 10), ip_address: lead.ip_address } };
  return { ...(authCode ? { auth_code: authCode } : {}), ...base, contact: compact({ first_name: lead.first_name, last_name: lead.last_name, email: lead.email, phone: clean(lead.phone).replace(/\D/g, ''), address: lead.address, address2: lead.address2, city: lead.city, state: lead.state, zip_code: lead.zip, ip_address: lead.ip_address }) };
}
function payloadFor(lead, buyer, stage, authCode) {
  if (buyer.adapter === 'jangl_auto') return janglPayload(lead, buyer, stage, authCode);
  if (buyer.adapter === 'leadportal_ipr') return leadPortalPayload(lead, buyer, stage, authCode);
  const full = genericPayload(lead);
  if (stage === 'ping') return { lead_id: lead.id, zip: lead.zip, state: lead.state, phone_last_four: clean(lead.phone).replace(/\D/g, '').slice(-4), data: lead.payload };
  return authCode ? { ...full, auth_code: authCode } : full;
}

async function deliverToBuyer(lead, buyer, attemptNumber = 1) {
  const attempts = [];
  if (buyer.delivery_mode === 'off') return { accepted: false, status: 'off', attempts };
  if (buyer.delivery_mode === 'direct_post') {
    const result = await sendStage(lead, buyer, 'direct', payloadFor(lead, buyer, 'direct'), attemptNumber);
    attempts.push(result.attempt); delete result.attempt; return { ...result, attempts };
  }
  if (buyer.delivery_mode !== 'ping_post') throw new Error(`Unsupported delivery mode: ${buyer.delivery_mode}`);
  const pingResult = await sendStage(lead, buyer, 'ping', payloadFor(lead, buyer, 'ping'), attemptNumber);
  attempts.push(pingResult.attempt); delete pingResult.attempt;
  if (!pingResult.accepted) return { ...pingResult, attempts };
  if (buyer.adapter === 'jangl_auto' && !pingResult.body.auth_code) {
    attempts[attempts.length - 1].status = 'rejected'; attempts[attempts.length - 1].error = 'Ping response did not include auth_code';
    return { accepted: false, status: 'rejected', error: 'Ping response did not include auth_code', attempts };
  }
  const continuationId = buyer.adapter === 'leadportal_ipr' ? pingResult.body?.response?.lead_id : pingResult.body.auth_code;
  if (buyer.adapter === 'leadportal_ipr' && !continuationId) {
    attempts[attempts.length - 1].status = 'rejected'; attempts[attempts.length - 1].error = 'Ping response did not include response.lead_id';
    return { accepted: false, status: 'rejected', error: 'Ping response did not include response.lead_id', attempts };
  }
  let postResult = await sendStage(lead, buyer, 'post', payloadFor(lead, buyer, 'post', continuationId), attemptNumber);
  attempts.push(postResult.attempt); delete postResult.attempt;
  if (buyer.adapter === 'jangl_auto' && postResult.body && postResult.body.status === 're-ping') {
    const reping = await sendStage(lead, buyer, 'ping', payloadFor(lead, buyer, 'ping'), attemptNumber);
    attempts.push(reping.attempt); delete reping.attempt;
    if (!reping.accepted || !reping.body.auth_code) return { ...reping, accepted: false, attempts };
    postResult = await sendStage(lead, buyer, 'post', payloadFor(lead, buyer, 'post', reping.body.auth_code), attemptNumber);
    attempts.push(postResult.attempt); delete postResult.attempt;
  }
  return { ...postResult, attempts };
}

async function routeLead(lead, buyers) {
  if (!buyers) buyers = (await resolveBuyers()).buyers;
  return Promise.all(buyers.map(async buyer => ({ buyer, result: await deliverToBuyer(lead, buyer) })));
}
async function persistDelivery(lead, deliveries) {
  const attempts = deliveries.flatMap(item => item.result.attempts || []);
  if (attempts.length) await db.request('buyer_attempts', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(attempts) });
  const accepted = deliveries.some(item => item.result.accepted);
  const status = accepted ? 'accepted' : deliveries.length ? 'failed' : 'no_buyers';
  await db.request(`leads?id=eq.${lead.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ delivery_status: status, processed_at: new Date().toISOString() }) });
  return status;
}
async function persistRoutingFailure(lead, error) {
  const message = clean(error && error.message ? error.message : error, 1000) || 'Unknown buyer routing failure';
  await db.request(`leads?id=eq.${lead.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ delivery_status: 'failed', routing_error: message, processed_at: new Date().toISOString() }) });
  return message;
}

async function processLead(lead, dependencies = {}) {
  const save = dependencies.insertLead || insertLead;
  const deliver = dependencies.routeLead || routeLead;
  const persist = dependencies.persistDelivery || persistDelivery;
  const persistFailure = dependencies.persistRoutingFailure || persistRoutingFailure;
  const [saveOutcome, deliveryOutcome] = await Promise.allSettled([save(lead), deliver(lead)]);
  if (saveOutcome.status === 'rejected') throw saveOutcome.reason;
  if (deliveryOutcome.status === 'rejected') {
    console.error('Buyer delivery error:', lead.id, deliveryOutcome.reason.message);
    await persistFailure(lead, deliveryOutcome.reason);
    return [];
  }
  await persist(lead, deliveryOutcome.value);
  return deliveryOutcome.value;
}

module.exports = { prepareLead, insertLead, saveLead, runtimeBuyers, resolveBuyers, routeLead, persistDelivery, persistRoutingFailure, processLead, deliverToBuyer, redact, payloadFor };

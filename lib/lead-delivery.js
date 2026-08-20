const { randomUUID } = require('node:crypto');
const db = require('./supabase');

function clean(value, max = 200) {
  return value == null ? '' : String(value).trim().slice(0, max);
}

function redact(value) {
  if (!value || typeof value !== 'object') return value;
  const blocked = /token|authorization|secret|password|auth_code/i;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, blocked.test(key) ? '[REDACTED]' : redact(item)]));
}

function clientIp(req) {
  return clean(req.headers['x-forwarded-for']).split(',')[0] || clean(req.headers['x-real-ip']) || clean(req.socket && req.socket.remoteAddress);
}

function leadRecord(body, req) {
  return {
    id: randomUUID(),
    first_name: clean(body.first_name, 80), last_name: clean(body.last_name, 80),
    email: clean(body.email, 254).toLowerCase(), phone: clean(body.phone, 30),
    address: clean(body.address, 200), address2: clean(body.address2, 100), city: clean(body.city, 100),
    state: clean(body.state, 2).toUpperCase(), zip: clean(body.zip, 10),
    payload: body, consent_text: clean(body.consent_text, 4000),
    consent_timestamp: clean(body.consent_timestamp, 40) || new Date().toISOString(),
    trusted_form_cert_url: clean(body.xxTrustedFormCertUrl, 500),
    source_url: clean(body.page_url, 1000), ip_address: clientIp(req),
    user_agent: clean(req.headers['user-agent'], 500), delivery_status: 'pending'
  };
}

async function saveLead(body, req) {
  const record = leadRecord(body, req);
  const rows = await db.request('leads', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(record) });
  return rows[0];
}

async function enabledBuyers(environment) {
  return db.request(`buyers?delivery_mode=neq.off&environment=eq.${encodeURIComponent(environment)}&select=*&order=priority.asc`);
}

async function createAttempt(lead, buyer, stage, payload, attemptNumber = 1) {
  const rows = await db.request('buyer_attempts', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ lead_id: lead.id, buyer_id: buyer.id, stage, mode: buyer.delivery_mode, environment: buyer.environment, attempt_number: attemptNumber, status: 'started', request_payload: redact(payload) })
  });
  return rows[0];
}

async function finishAttempt(id, started, result) {
  return db.request(`buyer_attempts?id=eq.${id}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
      status: result.status, http_status: result.httpStatus || null, response_payload: redact(result.body),
      price: result.price == null ? null : result.price, external_reference: result.externalReference || null,
      error: result.error || null, latency_ms: Date.now() - started, completed_at: new Date().toISOString()
    })
  });
}

function endpointFor(buyer, stage) {
  if (stage === 'ping') return buyer.ping_endpoint_url;
  if (stage === 'post') return buyer.post_endpoint_url;
  return buyer.direct_endpoint_url;
}

async function sendStage(lead, buyer, stage, payload, attemptNumber = 1) {
  const attempt = await createAttempt(lead, buyer, stage, payload, attemptNumber);
  const started = Date.now();
  try {
    const endpoint = endpointFor(buyer, stage);
    if (!endpoint) throw new Error(`No ${stage} endpoint configured`);
    const secret = buyer.auth_env_var ? process.env[buyer.auth_env_var] : '';
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json', ...(buyer.headers || {}) };
    if (secret) headers.Authorization = buyer.auth_scheme ? `${buyer.auth_scheme} ${secret}` : secret;
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(buyer.timeout_ms || 12000) });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 4000) }; }
    const accepted = response.ok && !['denied', 'rejected', 'error'].includes(String(body.status || '').toLowerCase());
    const result = { status: accepted ? 'accepted' : 'rejected', httpStatus: response.status, body, price: Number(body.price) || null, externalReference: body.confirmation_id || body.id || null };
    await finishAttempt(attempt.id, started, result);
    return { ...result, accepted };
  } catch (error) {
    await finishAttempt(attempt.id, started, { status: 'error', error: clean(error.message, 1000) });
    return { accepted: false, status: 'error', error: error.message };
  }
}

function genericPayload(lead) { return { lead_id: lead.id, ...lead.payload }; }

function compact(value) {
  if (Array.isArray(value)) return value.map(compact).filter(item => item !== undefined);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== '').map(([key, item]) => [key, compact(item)]));
}

function janglPayload(lead, stage, authCode) {
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
    meta: compact({ originally_created: lead.consent_timestamp || lead.created_at, source_id: clean(process.env.JANGL_SOURCE_ID, 100), offer_id: lead.id, trusted_form_cert_url: lead.trusted_form_cert_url, tcpa_compliant: true, tcpa_consent_text: lead.consent_text, user_agent: lead.user_agent, landing_page_url: lead.source_url }),
    data: compact({ drivers: [driver], vehicles, requested_policy: { coverage_type: clean(body.coverage_type, 30) }, current_policy: String(body.has_coverage).toLowerCase() === 'yes' ? { insurance_company: clean(body.former_insurer, 120) } : undefined })
  };
  if (stage === 'ping') return { ...base, contact: { phone_last_four: clean(body.phone).replace(/\D/g, '').slice(-4), zip_code: clean(body.zip, 10), ip_address: lead.ip_address } };
  return { ...(authCode ? { auth_code: authCode } : {}), ...base, contact: compact({ first_name: lead.first_name, last_name: lead.last_name, email: lead.email, phone: clean(lead.phone).replace(/\D/g, ''), address: lead.address, address2: lead.address2, city: lead.city, state: lead.state, zip_code: lead.zip, ip_address: lead.ip_address }) };
}

function payloadFor(lead, buyer, stage, authCode) {
  if (buyer.adapter === 'jangl_auto') return janglPayload(lead, stage, authCode);
  const full = genericPayload(lead);
  if (stage === 'ping') return { lead_id: lead.id, zip: lead.zip, state: lead.state, phone_last_four: clean(lead.phone).replace(/\D/g, '').slice(-4), data: lead.payload };
  return authCode ? { ...full, auth_code: authCode } : full;
}

async function deliverToBuyer(lead, buyer, attemptNumber = 1) {
  if (buyer.delivery_mode === 'off') return { accepted: false, status: 'off' };
  if (buyer.delivery_mode === 'direct_post') return sendStage(lead, buyer, 'direct', payloadFor(lead, buyer, 'direct'), attemptNumber);
  if (buyer.delivery_mode !== 'ping_post') throw new Error(`Unsupported delivery mode: ${buyer.delivery_mode}`);
  const ping = payloadFor(lead, buyer, 'ping');
  const pingResult = await sendStage(lead, buyer, 'ping', ping, attemptNumber);
  if (!pingResult.accepted) return pingResult;
  if (buyer.adapter === 'jangl_auto' && !pingResult.body.auth_code) return { accepted: false, status: 'rejected', error: 'Ping response did not include auth_code' };
  return sendStage(lead, buyer, 'post', payloadFor(lead, buyer, 'post', pingResult.body.auth_code), attemptNumber);
}

async function routeLead(lead) {
  const environment = process.env.BUYER_ENVIRONMENT === 'production' ? 'production' : 'test';
  const buyers = await enabledBuyers(environment);
  const results = [];
  for (const buyer of buyers) results.push({ buyer, result: await deliverToBuyer(lead, buyer) });
  const accepted = results.some(item => item.result.accepted);
  await db.request(`leads?id=eq.${lead.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ delivery_status: accepted ? 'accepted' : buyers.length ? 'failed' : 'no_buyers', processed_at: new Date().toISOString() }) });
  return results;
}

module.exports = { saveLead, routeLead, deliverToBuyer, redact, payloadFor };

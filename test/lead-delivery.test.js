const test = require('node:test');
const assert = require('node:assert/strict');
const { payloadFor, redact, runtimeBuyers, processLead } = require('../lib/lead-delivery');

const lead = {
  id: '11111111-1111-4111-8111-111111111111', first_name: 'Ada', last_name: 'Lovelace',
  email: 'ada@example.com', phone: '(202) 555-0100', address: '1 Main St', city: 'New York', state: 'NY', zip: '10001',
  consent_text: 'Consent', consent_timestamp: '2026-08-20T12:00:00Z', ip_address: '127.0.0.1',
  payload: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', phone: '2025550100', state: 'NY', zip: '10001', year: '2024', make: 'Honda', model: 'Civic', birthdate: '1990-01-01', coverage_type: 'Standard' }
};

test('raw direct post contains complete lead data', () => {
  const value = payloadFor(lead, { adapter: 'raw_json' }, 'direct');
  assert.equal(value.lead_id, lead.id);
  assert.equal(value.email, 'ada@example.com');
});

test('Jangl ping excludes identity and exposes last four only', () => {
  const value = payloadFor(lead, { adapter: 'jangl_auto' }, 'ping');
  assert.equal(value.contact.phone_last_four, '0100');
  assert.equal(value.data.drivers[0].first_name, undefined);
  assert.equal(value.contact.email, undefined);
});

test('Jangl post contains auth code and contact identity', () => {
  const previous = process.env.JANGL_OFFER_ID;
  process.env.JANGL_OFFER_ID = 'offer-42';
  const value = payloadFor(lead, { adapter: 'jangl_auto' }, 'post', 'abc123');
  assert.equal(value.auth_code, 'abc123');
  assert.equal(value.contact.first_name, 'Ada');
  assert.equal(value.meta.offer_id, 'offer-42');
  if (previous === undefined) delete process.env.JANGL_OFFER_ID; else process.env.JANGL_OFFER_ID = previous;
});

test('Jangl buyer campaign fields override legacy global campaign variables', () => {
  const previousSource = process.env.JANGL_SOURCE_ID;
  const previousOffer = process.env.JANGL_OFFER_ID;
  process.env.JANGL_SOURCE_ID = 'legacy-source';
  process.env.JANGL_OFFER_ID = 'legacy-offer';
  const value = payloadFor(lead, { adapter: 'jangl_auto', campaign_id: '1016830', campaign_name: 'Idillo Auto Insurance - AUTOWISERATE' }, 'direct');
  assert.equal(value.meta.source_id, '1016830');
  assert.equal(value.meta.offer_id, 'Idillo Auto Insurance - AUTOWISERATE');
  if (previousSource === undefined) delete process.env.JANGL_SOURCE_ID; else process.env.JANGL_SOURCE_ID = previousSource;
  if (previousOffer === undefined) delete process.env.JANGL_OFFER_ID; else process.env.JANGL_OFFER_ID = previousOffer;
});

test('LeadPortal direct post uses its required request envelope and redacts its key', () => {
  process.env.TEST_LEADPORTAL_TOKEN = 'private-key';
  const buyer = { adapter: 'leadportal_ipr', environment: 'test', auth_env_var: 'TEST_LEADPORTAL_TOKEN', lead_type: 'II-AutoInsurance', source_code: 'II-AutoInsurance', terminating_phone: '800-555-8888' };
  const value = payloadFor({ ...lead, trusted_form_cert_url: 'https://cert.trustedform.com/test' }, buyer, 'direct');
  assert.equal(value.Request.Mode, 'full');
  assert.equal(value.Request.Key, 'private-key');
  assert.equal(value.Request.API_Action, 'iprSubmitLead');
  assert.equal(value.Request.TYPE, 'II-AutoInsurance');
  assert.equal(value.Request.SRC, 'II-AutoInsurance');
  assert.equal(value.Request.Terminating_Phone, '8005558888');
  assert.equal(value.Request.Test_Lead, 1);
  assert.equal(redact(value).Request.Key, '[REDACTED]');
  delete process.env.TEST_LEADPORTAL_TOKEN;
});

test('LeadPortal post includes lead ID returned by ping', () => {
  const value = payloadFor(lead, { adapter: 'leadportal_ipr', lead_type: 'II-AutoInsurance', source_code: 'II-AutoInsurance', terminating_phone: '8005558888' }, 'post', '1234');
  assert.equal(value.Request.Mode, 'post');
  assert.equal(value.Request.Lead_ID, '1234');
});

test('redaction removes nested credentials', () => {
  assert.deepEqual(redact({ authorization: 'secret', nested: { api_token: 'secret', ok: 1 } }), { authorization: '[REDACTED]', nested: { api_token: '[REDACTED]', ok: 1 } });
});

test('runtime routing loads every buyer enabled in Admin without a database query', () => {
  const previousConfigV2 = process.env.BUYER_ROUTING_CONFIG_V2;
  process.env.BUYER_ROUTING_CONFIG_V2 = JSON.stringify([
    { id: '1', name: 'Off', delivery_mode: 'off', environment: 'test', priority: 1 },
    { id: '2', name: 'Production', delivery_mode: 'direct_post', environment: 'production', priority: 2 },
    { id: '3', name: 'Test', delivery_mode: 'ping_post', environment: 'test', priority: 3 }
  ]);
  assert.deepEqual(runtimeBuyers().map(buyer => buyer.id), ['2', '3']);
  if (previousConfigV2 === undefined) delete process.env.BUYER_ROUTING_CONFIG_V2; else process.env.BUYER_ROUTING_CONFIG_V2 = previousConfigV2;
});

test('runtime routing rejects a missing deployment snapshot', () => {
  const previousConfigV2 = process.env.BUYER_ROUTING_CONFIG_V2;
  delete process.env.BUYER_ROUTING_CONFIG_V2;
  assert.throws(() => runtimeBuyers(), /BUYER_ROUTING_CONFIG_V2 is not configured/);
  if (previousConfigV2 === undefined) delete process.env.BUYER_ROUTING_CONFIG_V2; else process.env.BUYER_ROUTING_CONFIG_V2 = previousConfigV2;
});

test('runtime routing rejects a snapshot with no active buyer', () => {
  const previousConfigV2 = process.env.BUYER_ROUTING_CONFIG_V2;
  process.env.BUYER_ROUTING_CONFIG_V2 = JSON.stringify([{ id: '3', delivery_mode: 'off' }]);
  assert.throws(() => runtimeBuyers(), /contains no active buyers/);
  if (previousConfigV2 === undefined) delete process.env.BUYER_ROUTING_CONFIG_V2; else process.env.BUYER_ROUTING_CONFIG_V2 = previousConfigV2;
});

test('lead insert and buyer routing start concurrently', async () => {
  let releaseInsert;
  let routeStarted = false;
  const insertGate = new Promise(resolve => { releaseInsert = resolve; });
  const running = processLead({ id: 'lead-1' }, {
    insertLead: async () => { await insertGate; },
    routeLead: async () => { routeStarted = true; return []; },
    persistDelivery: async () => {}
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(routeStarted, true);
  releaseInsert();
  await running;
});

test('routing exceptions are stored as failures instead of no buyers', async () => {
  let storedError;
  await processLead({ id: 'lead-2' }, {
    insertLead: async () => {},
    routeLead: async () => { throw new Error('BUYER_ROUTING_CONFIG_V2 is invalid JSON'); },
    persistRoutingFailure: async (_lead, error) => { storedError = error.message; },
    persistDelivery: async () => { throw new Error('should not mark no_buyers'); }
  });
  assert.equal(storedError, 'BUYER_ROUTING_CONFIG_V2 is invalid JSON');
});

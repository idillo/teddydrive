const test = require('node:test');
const assert = require('node:assert/strict');
const { payloadFor, redact } = require('../lib/lead-delivery');

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
  const value = payloadFor(lead, { adapter: 'jangl_auto' }, 'post', 'abc123');
  assert.equal(value.auth_code, 'abc123');
  assert.equal(value.contact.first_name, 'Ada');
});

test('redaction removes nested credentials', () => {
  assert.deepEqual(redact({ authorization: 'secret', nested: { api_token: 'secret', ok: 1 } }), { authorization: '[REDACTED]', nested: { api_token: '[REDACTED]', ok: 1 } });
});

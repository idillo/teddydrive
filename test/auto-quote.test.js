const test = require('node:test');
const assert = require('node:assert/strict');
const { requireFields, buildPing } = require('../api/auto-quote')._test;

test('required field validation identifies missing values', () => {
  assert.throws(() => requireFields({ email: 'a@example.com' }, ['email', 'phone']), /phone/);
});

test('ping payload limits phone disclosure', () => {
  const result = buildPing({ phone: '2025550100', zip: '10001', birthdate: '1990-01-01', state: 'NY', year: '2024', make: 'Honda', model: 'Civic', coverage_type: 'Standard' }, { headers: {}, socket: {} });
  assert.equal(result.contact.phone_last_four, '0100');
  assert.equal(result.contact.phone, undefined);
});

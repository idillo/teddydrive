const test = require('node:test');
const assert = require('node:assert/strict');
const { requireFields } = require('../api/auto-quote')._test;

test('required field validation identifies missing values', () => {
  assert.throws(() => requireFields({ email: 'a@example.com' }, ['email', 'phone']), /phone/);
});

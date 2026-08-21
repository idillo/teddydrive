const test = require('node:test');
const assert = require('node:assert/strict');
const { tokenKey } = require('../lib/vercel-admin');

test('buyer token environment keys are deterministic and safe', () => {
  assert.equal(tokenKey('6ca7c122-aac8-4a78-a3fe-1dcb43a1730f'), 'BUYER_6CA7C122AAC84A78A3FE1DCB43A1730F_TOKEN');
});

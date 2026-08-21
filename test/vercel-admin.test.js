const test = require('node:test');
const assert = require('node:assert/strict');
const { tokenKey, routingBuyer } = require('../lib/vercel-admin');

test('buyer token environment keys are deterministic and safe', () => {
  assert.equal(tokenKey('6ca7c122-aac8-4a78-a3fe-1dcb43a1730f'), 'BUYER_6CA7C122AAC84A78A3FE1DCB43A1730F_TOKEN');
});

test('published buyer configuration excludes database-only draft state', () => {
  const config = routingBuyer({ id: '1', name: 'Buyer', delivery_mode: 'direct_post', environment: 'production', auth_env_var: 'BUYER_TOKEN', published_config: { old: true }, published_at: 'yesterday' });
  assert.equal(config.name, 'Buyer');
  assert.equal(config.auth_env_var, 'BUYER_TOKEN');
  assert.equal(config.published_config, undefined);
  assert.equal(config.published_at, undefined);
});

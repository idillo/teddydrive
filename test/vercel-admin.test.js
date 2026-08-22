const test = require('node:test');
const assert = require('node:assert/strict');
const { tokenKey, routingBuyer, publishRouting } = require('../lib/vercel-admin');

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

test('routing deployment starts only after Vercel returns the exact saved snapshot', async () => {
  const previous = {
    token: process.env.VERCEL_API_TOKEN,
    project: process.env.VERCEL_PROJECT_ID,
    hook: process.env.VERCEL_DEPLOY_HOOK_URL,
    fetch: global.fetch
  };
  process.env.VERCEL_API_TOKEN = 'vercel-token';
  process.env.VERCEL_PROJECT_ID = 'project-id';
  process.env.VERCEL_DEPLOY_HOOK_URL = 'https://deploy.example/hook';
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === 'https://deploy.example/hook') return new Response(JSON.stringify({ job: { id: 'job-1' } }), { status: 200 });
    if (options.method === 'PATCH') return new Response('{}', { status: 200 });
    if (url.endsWith('/env/env-routing')) {
      const snapshot = JSON.stringify([routingBuyer({ id: '1', name: 'Buyer', delivery_mode: 'direct_post', environment: 'production' })]);
      return new Response(JSON.stringify({ value: snapshot }), { status: 200 });
    }
    return new Response(JSON.stringify({ envs: [{ id: 'env-routing', key: 'BUYER_ROUTING_CONFIG_V2', target: ['production', 'preview'] }] }), { status: 200 });
  };
  try {
    await publishRouting([{ id: '1', name: 'Buyer', delivery_mode: 'direct_post', environment: 'production' }]);
    const update = calls.find(call => call.options.method === 'PATCH');
    assert.equal(JSON.parse(update.options.body).type, 'encrypted');
    assert.equal(calls.at(-1).url, 'https://deploy.example/hook');
  } finally {
    global.fetch = previous.fetch;
    if (previous.token === undefined) delete process.env.VERCEL_API_TOKEN; else process.env.VERCEL_API_TOKEN = previous.token;
    if (previous.project === undefined) delete process.env.VERCEL_PROJECT_ID; else process.env.VERCEL_PROJECT_ID = previous.project;
    if (previous.hook === undefined) delete process.env.VERCEL_DEPLOY_HOOK_URL; else process.env.VERCEL_DEPLOY_HOOK_URL = previous.hook;
  }
});

test('routing deployment does not start when Vercel verification differs', async () => {
  const previous = {
    token: process.env.VERCEL_API_TOKEN,
    project: process.env.VERCEL_PROJECT_ID,
    hook: process.env.VERCEL_DEPLOY_HOOK_URL,
    fetch: global.fetch
  };
  process.env.VERCEL_API_TOKEN = 'vercel-token';
  process.env.VERCEL_PROJECT_ID = 'project-id';
  process.env.VERCEL_DEPLOY_HOOK_URL = 'https://deploy.example/hook';
  let hookCalls = 0;
  global.fetch = async (url, options = {}) => {
    if (url === 'https://deploy.example/hook') { hookCalls++; return new Response('{}', { status: 200 }); }
    if (options.method === 'PATCH') return new Response('{}', { status: 200 });
    if (url.endsWith('/env/env-routing')) return new Response(JSON.stringify({ value: '[]' }), { status: 200 });
    return new Response(JSON.stringify({ envs: [{ id: 'env-routing', key: 'BUYER_ROUTING_CONFIG_V2', target: ['production', 'preview'] }] }), { status: 200 });
  };
  try {
    await assert.rejects(() => publishRouting([{ id: '1', name: 'Buyer', delivery_mode: 'direct_post', environment: 'production' }]), /deployment was not started/);
    assert.equal(hookCalls, 0);
  } finally {
    global.fetch = previous.fetch;
    if (previous.token === undefined) delete process.env.VERCEL_API_TOKEN; else process.env.VERCEL_API_TOKEN = previous.token;
    if (previous.project === undefined) delete process.env.VERCEL_PROJECT_ID; else process.env.VERCEL_PROJECT_ID = previous.project;
    if (previous.hook === undefined) delete process.env.VERCEL_DEPLOY_HOOK_URL; else process.env.VERCEL_DEPLOY_HOOK_URL = previous.hook;
  }
});

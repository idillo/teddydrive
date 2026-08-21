const API = 'https://api.vercel.com';
function required(name) { const value = process.env[name]; if (!value) throw new Error(`${name} is not configured`); return value; }
function query() { const team = process.env.VERCEL_TEAM_ID; return team ? `?teamId=${encodeURIComponent(team)}` : ''; }
async function vercel(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options, headers: { Authorization: `Bearer ${required('VERCEL_API_TOKEN')}`, 'Content-Type': 'application/json', ...options.headers }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || body.message || `Vercel API failed (${response.status})`);
  return body;
}
function tokenKey(id) { return `BUYER_${String(id).replace(/-/g, '').toUpperCase()}_TOKEN`; }
async function upsertEnvironmentVariables(items) {
  const project = encodeURIComponent(required('VERCEL_PROJECT_ID'));
  const existingResponse = await vercel(`/v10/projects/${project}/env${query()}`);
  const existing = Array.isArray(existingResponse) ? existingResponse : existingResponse.envs || [];
  const creates = [];
  const results = [];
  for (const item of items) {
    const payload = { key: item.key, value: item.value, type: 'sensitive', target: ['production', 'preview'], comment: 'Managed by TeddyDrive Admin' };
    const current = existing.find(variable => variable.key === item.key);
    if (current) {
      const { key, ...update } = payload;
      results.push(await vercel(`/v10/projects/${project}/env/${encodeURIComponent(current.id)}${query()}`, { method: 'PATCH', body: JSON.stringify(update) }));
    } else {
      creates.push(payload);
    }
  }
  if (creates.length) results.push(await vercel(`/v10/projects/${project}/env${query()}`, { method: 'POST', body: JSON.stringify(creates) }));
  return results;
}
async function saveBuyerToken(id, token) {
  const key = tokenKey(id);
  await upsertEnvironmentVariables([{ key, value: token }]);
  return key;
}
function routingBuyer({ id, name, campaign_name, campaign_id, lead_type, source_code, terminating_phone, delivery_mode, adapter, environment, priority, direct_endpoint_url, ping_endpoint_url, post_endpoint_url, auth_env_var, auth_scheme, headers, timeout_ms }) {
  return { id, name, campaign_name, campaign_id, lead_type, source_code, terminating_phone, delivery_mode, adapter, environment, priority, direct_endpoint_url, ping_endpoint_url, post_endpoint_url, auth_env_var, auth_scheme, headers, timeout_ms };
}
async function publishRouting(buyers) {
  const safe = buyers.map(routingBuyer);
  await upsertEnvironmentVariables([{ key: 'BUYER_ROUTING_CONFIG', value: JSON.stringify(safe) }]);
  const hook = required('VERCEL_DEPLOY_HOOK_URL');
  const response = await fetch(hook, { method: 'POST' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `Deploy hook failed (${response.status})`);
  return body;
}
module.exports = { tokenKey, routingBuyer, saveBuyerToken, publishRouting };

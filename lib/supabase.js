const SUPABASE_URL = () => String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SECRET_KEY = () => process.env.SUPABASE_SECRET_KEY || '';
const SUPABASE_PUBLISHABLE_KEY = () => process.env.SUPABASE_PUBLISHABLE_KEY || '';

function configured() {
  return Boolean(SUPABASE_URL() && SUPABASE_SECRET_KEY());
}

async function request(path, options = {}) {
  if (!configured()) throw new Error('Supabase server configuration is incomplete');
  const response = await fetch(`${SUPABASE_URL()}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SECRET_KEY(),
      Authorization: `Bearer ${SUPABASE_SECRET_KEY()}`,
      'Content-Type': 'application/json',
      ...options.headers
    }
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!response.ok) {
    const error = new Error(data && data.message ? data.message : `Supabase request failed (${response.status})`);
    error.statusCode = response.status;
    error.details = data;
    throw error;
  }
  return data;
}

async function verifyAdmin(accessToken) {
  if (!accessToken || !SUPABASE_URL() || !SUPABASE_PUBLISHABLE_KEY()) return null;
  const response = await fetch(`${SUPABASE_URL()}/auth/v1/user`, {
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY(), Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) return null;
  const user = await response.json();
  const allowed = String(process.env.ADMIN_EMAILS || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
  if (!user.email || !allowed.includes(user.email.toLowerCase())) return null;
  return user;
}

module.exports = { configured, request, verifyAdmin };

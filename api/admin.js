const { randomUUID } = require('node:crypto');
const db = require('../lib/supabase');
const { deliverToBuyer, persistDelivery, resolveBuyers } = require('../lib/lead-delivery');
const { routingBuyer, saveBuyerToken, publishRouting } = require('../lib/vercel-admin');

function bearer(req) {
  const value = String(req.headers.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}

function text(value, max = 500) { return value == null ? '' : String(value).trim().slice(0, max); }
function queryValue(value) { return Array.isArray(value) ? value[0] : value; }

async function audit(user, action, targetType, targetId, details = {}) {
  await db.request('admin_audit_log', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ admin_email: user.email, action, target_type: targetType, target_id: targetId, details }) });
}

function csvCell(value) {
  const raw = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `"${raw.replace(/"/g, '""')}"`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const action = text(queryValue(req.query.action), 40);
  if (action === 'config' && req.method === 'GET') {
    return res.status(200).json({ supabaseUrl: process.env.SUPABASE_URL || '', publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY || '' });
  }
  const user = await db.verifyAdmin(bearer(req));
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    if (req.method === 'GET' && action === 'leads') {
      const search = text(queryValue(req.query.search), 100).replace(/[(),*]/g, ' ').trim();
      const status = text(queryValue(req.query.status), 30);
      const from = text(queryValue(req.query.from), 30);
      const to = text(queryValue(req.query.to), 30);
      const page = Math.max(0, Number(queryValue(req.query.page)) || 0);
      const limit = Math.min(200, Math.max(1, Number(queryValue(req.query.limit)) || 50));
      const filters = ['select=id,first_name,last_name,email,phone,state,zip,delivery_status,routing_error,created_at,processed_at', 'order=created_at.desc', `offset=${page * limit}`, `limit=${limit}`];
      if (status) filters.push(`delivery_status=eq.${encodeURIComponent(status)}`);
      if (from) filters.push(`created_at=gte.${encodeURIComponent(from)}`);
      if (to) filters.push(`created_at=lte.${encodeURIComponent(to)}`);
      if (search) filters.push(`or=${encodeURIComponent(`(first_name.ilike.*${search}*,last_name.ilike.*${search}*,email.ilike.*${search}*,phone.ilike.*${search}*,id.eq.${/^[0-9a-f-]{36}$/i.test(search) ? search : '00000000-0000-0000-0000-000000000000'})`)}`);
      return res.status(200).json(await db.request(`leads?${filters.join('&')}`));
    }
    if (req.method === 'GET' && action === 'routing-status') {
      try {
        const resolved = await resolveBuyers();
        return res.status(200).json({ buyers: resolved.buyers.map(({ id, name, environment, delivery_mode, adapter }) => ({ id, name, environment, delivery_mode, adapter })), source: resolved.source, environmentError: resolved.environmentError, error: null });
      } catch (error) {
        return res.status(200).json({ buyers: [], error: text(error.message, 1000) });
      }
    }
    if (req.method === 'GET' && action === 'lead') {
      const id = text(queryValue(req.query.id), 36);
      const leads = await db.request(`leads?id=eq.${encodeURIComponent(id)}&select=*`);
      if (!leads[0]) return res.status(404).json({ error: 'Lead not found' });
      const attempts = await db.request(`buyer_attempts?lead_id=eq.${encodeURIComponent(id)}&select=*,buyers(name,campaign_name,campaign_id)&order=created_at.asc`);
      return res.status(200).json({ lead: leads[0], attempts });
    }
    if (req.method === 'GET' && action === 'buyers') return res.status(200).json(await db.request('buyers?select=*&order=priority.asc'));
    if (req.method === 'GET' && action === 'export') {
      const search = text(queryValue(req.query.search), 100).replace(/[(),*]/g, ' ').trim();
      const status = text(queryValue(req.query.status), 30);
      const from = text(queryValue(req.query.from), 30);
      const to = text(queryValue(req.query.to), 30);
      const filters = ['select=id,created_at,first_name,last_name,email,phone,state,zip,delivery_status', 'order=created_at.desc', 'limit=10000'];
      if (status) filters.push(`delivery_status=eq.${encodeURIComponent(status)}`);
      if (from) filters.push(`created_at=gte.${encodeURIComponent(from)}`);
      if (to) filters.push(`created_at=lte.${encodeURIComponent(to)}`);
      if (search) filters.push(`or=${encodeURIComponent(`(first_name.ilike.*${search}*,last_name.ilike.*${search}*,email.ilike.*${search}*,phone.ilike.*${search}*,id.eq.${/^[0-9a-f-]{36}$/i.test(search) ? search : '00000000-0000-0000-0000-000000000000'})`)}`);
      const rows = await db.request(`leads?${filters.join('&')}`);
      const headers = ['id','created_at','first_name','last_name','email','phone','state','zip','delivery_status'];
      const csv = [headers.join(','), ...rows.map(row => headers.map(key => csvCell(row[key])).join(','))].join('\n');
      await audit(user, 'export_leads', 'lead', '', { count: rows.length });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="teddydrive-leads.csv"');
      return res.status(200).send(csv);
    }
    if (req.method === 'PATCH' && action === 'buyer') {
      const body = req.body || {};
      const id = text(body.id, 36);
      const allowedModes = new Set(['off','direct_post','ping_post']);
      if (!id || !allowedModes.has(body.delivery_mode)) return res.status(400).json({ error: 'Invalid buyer or delivery mode' });
      const update = {
        name: text(body.name, 120), campaign_name: text(body.campaign_name, 200) || null,
        campaign_id: text(body.campaign_id, 100) || null, delivery_mode: body.delivery_mode,
        environment: body.environment === 'production' ? 'production' : 'test', priority: Number(body.priority) || 100,
        adapter: ['jangl_auto','leadportal_ipr'].includes(body.adapter) ? body.adapter : 'raw_json',
        lead_type: text(body.lead_type, 100) || null, source_code: text(body.source_code, 100) || null,
        terminating_phone: text(body.terminating_phone, 30) || null,
        direct_endpoint_url: text(body.direct_endpoint_url, 1000) || null,
        ping_endpoint_url: text(body.ping_endpoint_url, 1000) || null,
        post_endpoint_url: text(body.post_endpoint_url, 1000) || null,
        auth_env_var: text(body.auth_env_var, 100) || null, auth_scheme: text(body.auth_scheme, 30) || null,
        timeout_ms: Math.min(30000, Math.max(1000, Number(body.timeout_ms) || 12000)), updated_at: new Date().toISOString()
      };
      const apiToken = text(body.api_token, 4000);
      if (apiToken) update.auth_env_var = await saveBuyerToken(id, apiToken);
      await db.request(`buyers?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(update) });
      await audit(user, 'update_buyer', 'buyer', id, { delivery_mode: update.delivery_mode, environment: update.environment });
      return res.status(200).json({ success: true });
    }
    if (req.method === 'POST' && action === 'buyer') {
      const body = req.body || {};
      const rows = await db.request('buyers', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ name: text(body.name, 120), delivery_mode: 'off', environment: 'test' }) });
      await audit(user, 'create_buyer', 'buyer', rows[0].id);
      return res.status(201).json(rows[0]);
    }
    if (req.method === 'POST' && action === 'publish-buyer') {
      const buyerId = text((req.body || {}).buyer_id, 36);
      const buyers = await db.request(`buyers?id=eq.${encodeURIComponent(buyerId)}&select=*`);
      if (!buyers[0]) return res.status(404).json({ error: 'Buyer not found' });
      const selected = routingBuyer(buyers[0]);
      const publishedRows = await db.request('buyers?published_config=not.is.null&select=id,published_config');
      const routing = publishedRows.filter(row => row.id !== buyerId).map(row => row.published_config);
      if (selected.delivery_mode !== 'off') routing.push(selected);
      routing.sort((a, b) => (a.priority || 100) - (b.priority || 100));
      const deployment = await publishRouting(routing);
      const publishedAt = new Date().toISOString();
      await db.request(`buyers?id=eq.${encodeURIComponent(buyerId)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ published_config: selected.delivery_mode === 'off' ? null : selected, published_at: publishedAt }) });
      await audit(user, 'publish_buyer_routing', 'buyer', buyerId, { buyer_name: selected.name, delivery_mode: selected.delivery_mode, environment: selected.environment, deployment_job: deployment.job?.id || deployment.id || null });
      return res.status(202).json({ success: true, deployment });
    }
    if (req.method === 'POST' && (action === 'retry' || action === 'test')) {
      const body = req.body || {};
      const buyers = await db.request(`buyers?id=eq.${encodeURIComponent(text(body.buyer_id, 36))}&select=*`);
      if (!buyers[0]) return res.status(404).json({ error: 'Buyer not found' });
      if (action === 'test' && buyers[0].delivery_mode === 'off') {
        return res.status(400).json({ error: 'Select Direct Post or Ping/Post and save first.' });
      }
      if (action === 'test' && buyers[0].environment !== 'test') {
        return res.status(400).json({ error: 'Test controls only call test buyers' });
      }
      let lead;
      if (action === 'retry') {
        const leads = await db.request(`leads?id=eq.${encodeURIComponent(text(body.lead_id, 36))}&select=*`);
        lead = leads[0];
      } else {
        const payload = { test: true, first_name: 'Test', last_name: 'Lead', email: 'test@example.com', phone: '2025550100', address: '1 Test Street', city: 'New York', state: 'NY', zip: '10001', year: '2024', make: 'Honda', model: 'Civic', birthdate: '1990-01-01', coverage_type: 'Standard', own_or_rent: 'Rent', has_coverage: 'No', second_vehicle: 'No', consent_text: 'Synthetic admin test; not a consumer lead.', consent_timestamp: new Date().toISOString() };
        const testRows = await db.request('leads', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({
          first_name: payload.first_name, last_name: payload.last_name, email: payload.email, phone: payload.phone,
          address: payload.address, city: payload.city, state: payload.state, zip: payload.zip,
          consent_text: payload.consent_text, consent_timestamp: payload.consent_timestamp,
          trusted_form_cert_url: `https://cert.trustedform.com/${randomUUID()}`,
          source_url: 'https://teddydrive.com/auto-quote.html', ip_address: '192.0.2.1',
          user_agent: 'TeddyDrive Admin Synthetic Test/1.0', is_test: true, delivery_status: 'pending', payload
        }) });
        lead = testRows[0];
      }
      if (!lead) return res.status(404).json({ error: 'Lead not found' });
      const count = action === 'retry' ? await db.request(`buyer_attempts?lead_id=eq.${lead.id}&buyer_id=eq.${buyers[0].id}&select=id`) : [];
      const result = await deliverToBuyer(lead, buyers[0], count.length + 1);
      await persistDelivery(lead, [{ buyer: buyers[0], result }]);
      await audit(user, action === 'retry' ? 'retry_buyer' : 'test_buyer', 'buyer', buyers[0].id, { lead_id: lead.id, result: result.status });
      return res.status(200).json(result);
    }
    return res.status(404).json({ error: 'Unknown admin action' });
  } catch (error) {
    console.error('Admin API error:', error.message);
    return res.status(500).json({ error: `Admin operation failed: ${text(error.message, 500)}` });
  }
};

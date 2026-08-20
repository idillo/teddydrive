const db = require('../lib/supabase');

module.exports = async function handler(req, res) {
  const expected = process.env.CRON_SECRET;
  if (!expected || req.headers.authorization !== `Bearer ${expected}`) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await db.request('buyers?select=id&limit=1');
    return res.status(200).json({ ok: true, checked_at: new Date().toISOString() });
  } catch (error) {
    console.error('Supabase keep-alive failed:', error.message);
    return res.status(503).json({ ok: false });
  }
};

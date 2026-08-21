const { prepareLead, processLead } = require('../lib/lead-delivery');

const COVERAGE_TYPES = new Set(['State Minimum', 'Standard', 'Preferred', 'Premium']);
function clean(value, max = 200) { return value == null ? '' : String(value).trim().slice(0, max); }
function normalizeKey(value) { return clean(value).toLowerCase(); }
function requireFields(body, fields) {
  const missing = fields.filter(field => !clean(body[field]));
  if (missing.length) {
    const error = new Error(`Missing required fields: ${missing.join(', ')}`);
    error.statusCode = 400;
    throw error;
  }
}
function validate(body) {
  requireFields(body, ['zip','year','make','model','birthdate','coverage_type','first_name','last_name','email','phone','address','city','state','consent_text','consent_timestamp']);
  if (normalizeKey(body.has_coverage) === 'yes') requireFields(body, ['former_insurer']);
  if (normalizeKey(body.second_vehicle) === 'yes') requireFields(body, ['year_2', 'make_2', 'model_2']);
  if (!COVERAGE_TYPES.has(clean(body.coverage_type, 30))) {
    const error = new Error('Invalid coverage type'); error.statusCode = 400; throw error;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ success: false, message: 'Method not allowed' }); }
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    validate(body);
    const lead = prepareLead(body, req);
    await processLead(lead);
    return res.status(202).json({ success: true, lead_id: lead.id });
  } catch (error) {
    const status = Number(error.statusCode) || 500;
    if (status >= 500) console.error('Auto quote integration error:', error.message);
    return res.status(status).json({ success: false, message: status >= 500 ? 'We could not submit your request.' : error.message });
  }
};

module.exports._test = { requireFields, validate };

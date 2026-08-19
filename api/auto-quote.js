const { randomUUID } = require('node:crypto');

const DEFAULT_API_BASE = 'https://api.jangl.com/v2/auto_insurance';

const maritalStatuses = {
  single: 'Single', married: 'Married', divorced: 'Divorced',
  separated: 'Separated', widowed: 'Widowed', 'domestic partner': 'Domestic Partner'
};

const educationLevels = {
  'high school': 'High School Diploma',
  'some college': 'Some College',
  'associate degree': 'Associate Degree',
  "bachelor's degree": 'Bachelors Degree',
  'graduate degree': 'Masters Degree'
};

const primaryUses = {
  'commute to work': 'Commute Work', pleasure: 'Pleasure',
  business: 'Business', school: 'Commute School'
};

function clean(value, max = 200) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, max);
}

function normalizeKey(value) {
  return clean(value).toLowerCase();
}

function minimumInsuredSince(value) {
  const years = { '1–2 years': 1, '3–4 years': 3, '5+ years': 5 }[clean(value)];
  if (!years) return undefined;
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
}

function firstHeader(value) {
  return clean(Array.isArray(value) ? value[0] : value).split(',')[0].trim();
}

function requestIp(req) {
  return firstHeader(req.headers['x-forwarded-for']) ||
    firstHeader(req.headers['x-real-ip']) ||
    firstHeader(req.socket && req.socket.remoteAddress);
}

function requireFields(body, fields) {
  const missing = fields.filter(field => !clean(body[field]));
  if (missing.length) {
    const error = new Error(`Missing required fields: ${missing.join(', ')}`);
    error.statusCode = 400;
    throw error;
  }
}

function buildVehicle(body, suffix = '') {
  const year = Number.parseInt(clean(body[`year${suffix}`]), 10);
  const make = clean(body[`make${suffix}`], 80);
  const model = clean(body[`model${suffix}`], 100);
  if (!year || !make || !model) return null;

  const ownership = normalizeKey(body[`owned_or_leased${suffix}`] || body.owned_or_leased);
  const use = normalizeKey(body[`use${suffix}`] || body.use);
  const vehicle = {
    year,
    make,
    model,
    ownership: ownership === 'leased' ? 'Lease' : 'Own',
    primary_use: primaryUses[use] || undefined
  };

  return compact(vehicle);
}

function buildDriver(body, includeIdentity) {
  const gender = normalizeKey(body.gender);
  const driver = {
    birth_date: clean(body.birthdate, 10),
    relationship: 'Self',
    gender: gender === 'male' ? 'M' : gender === 'female' ? 'F' : undefined,
    marital_status: maritalStatuses[normalizeKey(body.marital_status)],
    license_status: normalizeKey(body.license_status) === 'yes' ? 'Active' : undefined,
    license_state: clean(body.state, 2).toUpperCase(),
    residence_type: normalizeKey(body.own_or_rent) === 'own' ? 'Own' :
      normalizeKey(body.own_or_rent) === 'rent' ? 'Rent' : 'Other',
    occupation: clean(body.occupation, 100),
    education: educationLevels[normalizeKey(body.highest_level)]
  };

  if (includeIdentity) {
    driver.first_name = clean(body.first_name, 80);
    driver.last_name = clean(body.last_name, 80);
  }

  return compact(driver);
}

function buildMeta(body, req) {
  const consentText = clean(body.consent_text, 4000);
  return compact({
    originally_created: clean(body.consent_timestamp, 40) || new Date().toISOString(),
    source_id: clean(process.env.JANGL_SOURCE_ID || 'teddydrive_auto_quote', 100),
    offer_id: randomUUID(),
    lead_id_code: clean(body.Jornaya_LeadID, 100),
    trusted_form_cert_url: clean(body.xxTrustedFormCertUrl, 500),
    tcpa_compliant: Boolean(consentText),
    tcpa_consent_text: consentText,
    user_agent: clean(req.headers['user-agent'], 500),
    landing_page_url: clean(body.page_url, 1000)
  });
}

function buildData(body, includeIdentity) {
  const vehicles = [buildVehicle(body)];
  if (normalizeKey(body.second_vehicle) === 'yes') vehicles.push(buildVehicle(body, '_2'));

  const data = {
    drivers: [buildDriver(body, includeIdentity)],
    vehicles: vehicles.filter(Boolean),
    requested_policy: {
      coverage_type: 'Standard'
    }
  };

  if (normalizeKey(body.has_coverage) === 'yes' && clean(body.former_insurer)) {
    data.current_policy = compact({
      insurance_company: clean(body.former_insurer, 120),
      insured_since: minimumInsuredSince(body.months_insured)
    });
  }

  return compact(data);
}

function compact(value) {
  if (Array.isArray(value)) return value.map(compact).filter(item => item !== undefined);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined && item !== '')
    .map(([key, item]) => [key, compact(item)]));
}

function buildPing(body, req) {
  return {
    meta: buildMeta(body, req),
    contact: {
      phone_last_four: clean(body.phone).replace(/\D/g, '').slice(-4),
      zip_code: clean(body.zip, 10),
      ip_address: requestIp(req)
    },
    data: buildData(body, false)
  };
}

function buildPost(body, req, authCode, ping) {
  return {
    auth_code: authCode,
    meta: ping.meta,
    contact: compact({
      first_name: clean(body.first_name, 80),
      last_name: clean(body.last_name, 80),
      email: clean(body.email, 254).toLowerCase(),
      phone: clean(body.phone).replace(/\D/g, ''),
      address: clean(body.address, 200),
      address2: clean(body.address2, 100),
      city: clean(body.city, 100),
      state: clean(body.state, 2).toUpperCase(),
      zip_code: clean(body.zip, 10),
      ip_address: requestIp(req)
    }),
    data: buildData(body, true)
  };
}

async function janglRequest(path, payload) {
  const token = clean(process.env.JANGL_API_TOKEN, 500);
  if (!token) {
    const error = new Error('JANGL_API_TOKEN is not configured');
    error.statusCode = 500;
    throw error;
  }

  const base = clean(process.env.JANGL_API_BASE_URL || DEFAULT_API_BASE, 500).replace(/\/$/, '');
  const response = await fetch(`${base}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12000)
  });

  let result;
  try { result = await response.json(); }
  catch { result = { status: 'denied', errors: { upstream: ['Invalid API response'] } }; }

  if (!response.ok && result.status !== 'denied') {
    const error = new Error('Quoting Fast request failed');
    error.statusCode = 502;
    throw error;
  }
  return result;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    requireFields(body, [
      'zip','year','make','model','birthdate',
      'first_name','last_name','email','phone','address','city','state',
      'consent_text','consent_timestamp'
    ]);

    let pingPayload = buildPing(body, req);
    let pingResult = await janglRequest('ping', pingPayload);
    if (pingResult.status !== 'success' || !pingResult.auth_code) {
      return res.status(422).json({
        success: false,
        message: 'No matching insurance options are available at this time.',
        status: 'denied'
      });
    }

    let postResult = await janglRequest('post', buildPost(body, req, pingResult.auth_code, pingPayload));
    if (postResult.status === 're-ping') {
      pingPayload = buildPing(body, req);
      pingResult = await janglRequest('ping', pingPayload);
      if (pingResult.status !== 'success' || !pingResult.auth_code) {
        return res.status(422).json({ success: false, message: 'The quote match expired. Please try again.', status: 'denied' });
      }
      postResult = await janglRequest('post', buildPost(body, req, pingResult.auth_code, pingPayload));
    }

    if (postResult.status !== 'success') {
      return res.status(422).json({ success: false, message: 'Your request could not be matched at this time.', status: postResult.status || 'denied' });
    }

    return res.status(200).json({
      success: true,
      confirmation_id: postResult.confirmation_id,
      price: postResult.price
    });
  } catch (error) {
    const status = Number(error.statusCode) || 500;
    if (status >= 500) console.error('Auto quote integration error:', error.message);
    return res.status(status).json({
      success: false,
      message: status >= 500 ? 'The quote service is temporarily unavailable.' : error.message
    });
  }
};

module.exports._test = { buildPing, buildPost, buildData, buildDriver, buildVehicle };

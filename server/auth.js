/**
 * Agent Flow – API-skydd.
 *
 * När APP_API_KEY (eller APP_PASSWORD) finns i miljön kräver alla /api-anrop
 * nyckeln i headern `x-api-key` eller `Authorization: Bearer <nyckel>`.
 * Undantag: /api/health, /api/auth/status och Googles OAuth-callback
 * (som skyddas av OAuth-state i stället).
 *
 * Utan nyckel kör appen öppet som förut – men UI:t varnar, och på en hostad
 * server (Render) måste nyckeln vara satt innan Google-kontot kan kopplas.
 */
const crypto = require('crypto');
const env = require('./env');

const KEY_ENV_NAMES = ['APP_API_KEY', 'AGENT_FLOW_API_KEY', 'APP_PASSWORD'];
const EXEMPT = ['/api/health', '/api/auth/status', '/api/google/callback'];
const MAX_FAILURES = 12;          // per IP ...
const FAILURE_WINDOW_MS = 60000;  // ... inom en minut
const failures = new Map();

function keys() {
  const raw = env.first(...KEY_ENV_NAMES);
  if (!raw) return [];
  return raw.split(',').map((k) => k.trim()).filter(Boolean);
}

function keySource() {
  for (const name of KEY_ENV_NAMES) {
    if (env.first(name)) return name;
  }
  return '';
}

/** True när ett API-skydd är aktiverat. */
function required() {
  if (env.flag('DISABLE_API_AUTH')) return false;
  return keys().length > 0;
}

/** True när driftaren uttryckligen accepterat ett öppet API. */
function overrideAllowed() {
  return env.flag('ALLOW_INSECURE_API') || env.flag('DISABLE_API_AUTH');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** True om den angivna nyckeln matchar någon av de konfigurerade nycklarna. */
function check(provided) {
  if (!provided) return false;
  const list = keys();
  if (!list.length) return false;
  return list.some((k) => safeEqual(k, provided));
}

function extract(req) {
  const header = req.headers['x-api-key'];
  if (header) return String(header).trim();
  const auth = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) return m[1].trim();
  return '';
}

function isExempt(pathname) {
  return EXEMPT.includes(pathname);
}

function blocked(ip) {
  const rec = failures.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.firstAt > FAILURE_WINDOW_MS) {
    failures.delete(ip);
    return false;
  }
  return rec.count >= MAX_FAILURES;
}

function recordFailure(ip) {
  const now = Date.now();
  const rec = failures.get(ip);
  if (!rec || now - rec.firstAt > FAILURE_WINDOW_MS) {
    failures.set(ip, { count: 1, firstAt: now });
  } else {
    rec.count += 1;
  }
  if (failures.size > 5000) failures.clear(); // skydd mot minnesläckage
}

function middleware() {
  return (req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    if (isExempt(req.path)) return next();
    if (!required()) {
      req.apiAuth = 'open';
      return next();
    }
    const ip = req.ip || req.socket.remoteAddress || 'okänd';
    if (blocked(ip)) {
      return res.status(429).json({ error: 'För många misslyckade försök. Vänta en minut och försök igen.' });
    }
    const provided = extract(req);
    if (provided && check(provided)) {
      req.apiAuth = 'key';
      return next();
    }
    if (provided) recordFailure(ip);

    // Google-inloggningen startas med ett vanligt klick (utan header) –
    // skicka tillbaka användaren till appen med ett begripligt fel.
    if (req.path === '/api/google/auth' && req.method === 'GET') {
      return res.redirect('/app#/integrationer?google_error=' + encodeURIComponent('Lås upp appen med din API-nyckel (APP_API_KEY) först – klicka sedan på "Logga in med Google".'));
    }
    return res.status(401).json({
      error: 'API:t är skyddat. Ange din åtkomstnyckel (APP_API_KEY) i appen.',
      code: 'unauthorized'
    });
  };
}

/** Publik status (inga hemligheter) – används av inlåsningsskärmen. */
function publicStatus(req) {
  const req_ok = (() => {
    if (!required()) return true;
    const provided = extract(req);
    return Boolean(provided && check(provided));
  })();
  return {
    required: required(),
    unlocked: req_ok,
    keyVar: keySource() || KEY_ENV_NAMES[0],
    overrideAllowed: overrideAllowed(),
    hosted: env.isHosted()
  };
}

function status() {
  return {
    required: required(),
    keySet: keys().length > 0,
    keyVar: keySource() || KEY_ENV_NAMES[0],
    disabledVar: env.flag('DISABLE_API_AUTH') ? 'DISABLE_API_AUTH' : '',
    overrideAllowed: overrideAllowed()
  };
}

module.exports = { required, overrideAllowed, check, middleware, publicStatus, status, isExempt, keySource, KEY_ENV_NAMES };

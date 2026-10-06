/**
 * Agent Flow – kryptering av hemligheter.
 *
 * Alla hemliga fält (Google-tokens, Shopify-token, AI-nycklar) krypteras med
 * AES-256-GCM innan de lämnar minnet – både till den externa databasen
 * (Supabase) och till den lokala cachefilen. Nyckeln läses från miljön:
 *
 *   SETTINGS_ENCRYPTION_KEY   (rekommenderad, sätts i Render → Environment)
 *
 * Format: enc:v1:<keyId>:<iv>:<tag>:<data>  (base64url)
 * keyId gör att appen kan upptäcka att fel nyckel används i stället för att
 * tyst skriva sönder sparade tokens.
 */
const crypto = require('crypto');
const env = require('./env');

const PREFIX = 'enc:v1:';
const KEY_ENV_NAMES = ['SETTINGS_ENCRYPTION_KEY', 'AGENT_FLOW_ENCRYPTION_KEY', 'ENCRYPTION_KEY'];
const SALT = 'agent-flow/secret-store/v1';

/** Standardfält som alltid krypteras, per dokument. `*` matchar alla nycklar. */
const SECRET_PATHS = {
  settings: [
    'shopify.token',
    'google.clientSecret',
    'google.refreshToken',
    'google.accessToken',
    'providers.*.apiKey'
  ]
};

let cache = { raw: '', key: null, id: '' };
let lastError = '';

function rawKey() {
  return env.first(...KEY_ENV_NAMES);
}

function enabled() {
  return Boolean(rawKey());
}

/** Namnet på den miljövariabel som används (för felmeddelanden/status). */
function keySource() {
  for (const name of KEY_ENV_NAMES) {
    const v = process.env[name];
    if (v && String(v).trim()) return name;
  }
  return '';
}

function ctx() {
  const raw = rawKey();
  if (!raw) return null;
  if (cache.raw !== raw) {
    cache = {
      raw,
      key: crypto.scryptSync(raw, SALT, 32),
      id: crypto.createHash('sha256').update(raw).digest('hex').slice(0, 8)
    };
  }
  return cache;
}

function b64(buf) {
  return Buffer.from(buf).toString('base64url');
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** Krypterar ett värde. Tomma värden och redan krypterade lämnas orörda. */
function encrypt(value) {
  const c = ctx();
  if (!c || !value || isEncrypted(value)) return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', c.key, iv);
  const data = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return PREFIX + [c.id, b64(iv), b64(cipher.getAuthTag()), b64(data)].join(':');
}

/** Dekrypterar ett värde. Okrypterade värden (äldre data) returneras som de är. */
function decrypt(value, label = 'hemligt värde') {
  if (!isEncrypted(value)) return value;
  const c = ctx();
  if (!c) {
    throw new Error(`Värdet är krypterat men ${KEY_ENV_NAMES[0]} saknas i miljön.`);
  }
  const parts = String(value).slice(PREFIX.length).split(':');
  if (parts.length !== 4) {
    throw new Error(`Kunde inte tolka det krypterade värdet (${label}).`);
  }
  const [keyId, iv, tag, data] = parts;
  if (keyId !== c.id) {
    throw new Error(
      `Krypteringsnyckeln i ${keySource() || KEY_ENV_NAMES[0]} stämmer inte med nyckeln som användes när ${label} sparades.`
    );
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', c.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error(`Kunde inte dekryptera ${label}: fel nyckel eller skadat värde.`);
  }
}

/** Sant om värdet är krypterat men inte kan läsas med nuvarande nyckel. */
function isBroken(value) {
  if (!isEncrypted(value)) return false;
  try {
    decrypt(value, 'värdet');
    return false;
  } catch {
    return true;
  }
}

// ---------- Punkt-sökvägar (med stöd för *) ----------

function targets(obj, path) {
  const parts = path.split('.');
  const found = [];
  const walk = (node, i) => {
    if (node === null || typeof node !== 'object') return;
    const key = parts[i];
    if (key === '*') {
      for (const k of Object.keys(node)) walk(node[k], i + 1);
      return;
    }
    if (i === parts.length - 1) {
      if (Object.prototype.hasOwnProperty.call(node, key)) found.push([node, key]);
      return;
    }
    walk(node[key], i + 1);
  };
  walk(obj, 0);
  return found;
}

function deepClone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/**
 * Kopia av dokumentet där alla hemliga fält är krypterade.
 * `paths` kommer från dokumentets registrering i store (annars SECRET_PATHS).
 */
function protectDoc(name, doc, paths) {
  const fields = paths || SECRET_PATHS[name] || [];
  if (!fields.length || !enabled()) return doc;
  const clone = deepClone(doc);
  for (const path of fields) {
    for (const [obj, key] of targets(clone, path)) {
      if (typeof obj[key] === 'string' && obj[key]) obj[key] = encrypt(obj[key]);
    }
  }
  return clone;
}

/**
 * Motsatsen till protectDoc. Returnerar { value, errors }.
 * Går ett fält inte att dekryptera behålls det krypterade värdet (så att en
 * sparad kopia inte förstörs) och felet rapporteras i stället.
 */
function unprotectDoc(name, doc, paths) {
  const fields = paths || SECRET_PATHS[name] || [];
  const clone = deepClone(doc);
  const errors = [];
  if (!fields.length) return { value: clone, errors };
  for (const path of fields) {
    for (const [obj, key] of targets(clone, path)) {
      const value = obj[key];
      if (!isEncrypted(value)) continue;
      try {
        obj[key] = decrypt(value, `${name}.${path}`);
      } catch (err) {
        errors.push(err.message);
        obj[key] = value; // behåll krypterad text – skrivs tillbaka oförändrad
      }
    }
  }
  return { value: clone, errors };
}

// ---------- Signering (t.ex. OAuth-state) ----------

/** HMAC-signatur av en sträng, eller '' om ingen nyckel finns. */
function sign(payload) {
  const c = ctx();
  if (!c) return '';
  return crypto.createHmac('sha256', c.key).update(String(payload)).digest('base64url');
}

/** Tidsäker kontroll av en signatur. */
function verify(payload, signature) {
  const expected = sign(payload);
  if (!expected || !signature) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function status() {
  return {
    enabled: enabled(),
    keyVar: keySource() || KEY_ENV_NAMES[0],
    keySet: enabled(),
    keyMissingVar: KEY_ENV_NAMES[0],
    lastError
  };
}

function setLastError(message) {
  lastError = message || '';
}

module.exports = {
  PREFIX,
  KEY_ENV_NAMES,
  SECRET_PATHS,
  enabled,
  keySource,
  encrypt,
  decrypt,
  isEncrypted,
  isBroken,
  protectDoc,
  unprotectDoc,
  sign,
  verify,
  status,
  setLastError
};

/**
 * Agent Flow – beständig lagring.
 *
 * Allt som måste överleva en omstart (Google-tokens, Shopify-nycklar,
 * botar, körloggar) sparas som JSON-dokument. Dokumenten skrivs till en
 * extern databas med gratisnivå (Supabase via PostgREST) när miljön är
 * konfigurerad – annars till en lokal fil (bra vid lokal körning).
 *
 *   SUPABASE_URL                t.ex. https://abcdefgh.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY   service_role-nyckeln (server-only, hemlig)
 *   SUPABASE_TABLE              tabellnamn, standard: agent_flow_store
 *
 * Skrivningen är write-through: cachen i minnet är sanningen, filen skrivs
 * alltid (snabb cache) och databasen uppdateras asynkront med omförsök.
 */
const fs = require('fs');
const path = require('path');
const env = require('./env');
const secure = require('./secure');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const TABLE = env.first('SUPABASE_TABLE') || 'agent_flow_store';
const REFRESH_MS = Number(env.first('STORE_REFRESH_MS')) || 120000;

const SQL = [
  '-- Kör en gång i Supabase → SQL Editor (gratisnivån räcker)',
  `create table if not exists public.${TABLE} (`,
  '  id text primary key,',
  "  payload jsonb not null default '{}'::jsonb,",
  '  updated_at timestamptz not null default now()',
  ');',
  `alter table public.${TABLE} enable row level security;`,
  '-- Inga policies: bara service_role-nyckeln (som appen använder) kommer åt raden.'
].join('\n');

const docs = new Map();      // namn -> värde (dekrypterat, i minnet)
const registry = new Map();  // namn -> { file, initial }
const meta = new Map();      // namn -> { updatedAt, loaded, source, lastError, lastSyncAt }
const timers = new Map();    // namn -> timeout för remote-skrivning
const dirty = new Set();
let refreshTimer = null;

function remoteConfig() {
  const url = env.first('SUPABASE_URL', 'SUPABASE_PROJECT_URL', 'SUPABASE_REST_URL').replace(/\/+$/, '');
  const key = env.first('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_KEY', 'SUPABASE_ANON_KEY', 'SUPABASE_SECRET_KEY');
  const forcedFile = env.first('STORE_BACKEND').toLowerCase() === 'file';
  return { url, key, table: TABLE, configured: Boolean(url && key) && !forcedFile, forcedFile };
}

function remoteEnabled() {
  return remoteConfig().configured;
}

function metaOf(name) {
  if (!meta.has(name)) {
    meta.set(name, { updatedAt: '', loaded: false, source: 'none', lastError: '', lastSyncAt: 0 });
  }
  return meta.get(name);
}

function initialValue(name) {
  const reg = registry.get(name);
  if (!reg) return null;
  const v = typeof reg.initial === 'function' ? reg.initial() : reg.initial;
  return JSON.parse(JSON.stringify(v ?? null));
}

/** Registrera ett dokument som ska kunna sparas/läsas beständigt. */
function register(name, { file, initial }) {
  registry.set(name, { file, initial });
  return name;
}

function localFile(name) {
  const reg = registry.get(name);
  if (!reg || !reg.file) return '';
  return path.isAbsolute(reg.file) ? reg.file : path.join(DATA_DIR, reg.file);
}

function readLocal(name) {
  const file = localFile(name);
  if (!file) return null;
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`[store] Kunde inte läsa ${file}:`, err.message);
    return null;
  }
}

function writeLocal(name, value) {
  const file = localFile(name);
  if (!file) return;
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const protectedValue = secure.protectDoc(name, value);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(protectedValue, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error(`[store] Kunde inte skriva ${file}:`, err.message);
  }
}

// ---------- Supabase (PostgREST) ----------

function headers(extra = {}) {
  const { key } = remoteConfig();
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

async function rest(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text);
      detail = parsed.message || parsed.hint || parsed.error || detail;
    } catch { /* råtext duger */ }
    const err = new Error(`Supabase ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function pullRemote(name) {
  const { url, table } = remoteConfig();
  const base = `${url}/rest/v1/${table}`;
  let rows;
  try {
    rows = await rest(`${base}?select=id,payload,updated_at&id=eq.${encodeURIComponent(name)}`, { headers: headers() });
  } catch (err) {
    if (err.status === 400) {
      // Tabellen saknar updated_at – kör utan den kolumnen.
      rows = await rest(`${base}?select=id,payload&id=eq.${encodeURIComponent(name)}`, { headers: headers() });
    } else {
      throw err;
    }
  }
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) return null;
  const { value, errors } = secure.unprotectDoc(name, row.payload);
  if (errors.length) {
    secure.setLastError(errors.join(' '));
    console.error(`[store] ${name}:`, errors.join(' '));
  }
  return { value, updatedAt: row.updated_at || '', errors };
}

async function pushRemote(name) {
  const { url, table } = remoteConfig();
  const value = docs.get(name);
  const body = [{ id: name, payload: secure.protectDoc(name, value), updated_at: new Date().toISOString() }];
  const rows = await rest(`${url}/rest/v1/${table}?on_conflict=id`, {
    method: 'POST',
    headers: headers({ Prefer: 'resolution=merge-duplicates,return=representation' }),
    body: JSON.stringify(body)
  });
  const row = Array.isArray(rows) ? rows[0] : rows;
  return { updatedAt: (row && row.updated_at) || new Date().toISOString() };
}

/** Skriv till databasen, och ta med allt som hunnit ändras under tiden. */
async function flush(name) {
  const m = metaOf(name);
  let last = null;
  do {
    dirty.delete(name);
    try {
      last = await pushRemote(name);
      m.lastError = '';
      m.lastSyncAt = Date.now();
      if (last.updatedAt) m.updatedAt = last.updatedAt;
    } catch (err) {
      m.lastError = err.message;
      console.error(`[store] Kunde inte spara ${name} i Supabase:`, err.message);
      // Försök igen om en stund – data finns kvar i minnet + lokala filen.
      if (!dirty.has(name)) {
        clearTimeout(timers.get(name));
        timers.set(name, setTimeout(() => scheduleRemote(name, 8000), 8000));
        break;
      }
    }
  } while (dirty.has(name));
  clearTimeout(timers.get(name));
  timers.delete(name);
}

function scheduleRemote(name, delay = 200) {
  if (!remoteEnabled()) return;
  if (timers.has(name)) return;
  const t = setTimeout(() => {
    timers.delete(name);
    flush(name).catch((err) => console.error('[store]', err.message));
  }, delay);
  if (t.unref) t.unref();
  timers.set(name, t);
}

// ---------- Publikt API ----------

/** Läser ett dokument (från minnet, lokala filen eller tomt initialvärde). */
function read(name) {
  if (docs.has(name)) return docs.get(name);
  const m = metaOf(name);
  const local = readLocal(name);
  let value = initialValue(name);
  if (local !== null && local !== undefined) {
    const { value: unprotected, errors } = secure.unprotectDoc(name, local);
    value = unprotected;
    m.source = 'file';
    if (errors.length) {
      m.lastError = errors.join(' ');
      secure.setLastError(m.lastError);
    }
  }
  m.loaded = true;
  docs.set(name, value);
  return value;
}

/** Sparar ett dokument: minnet, lokala filen och (om konfigurerat) databasen. */
function write(name, value) {
  docs.set(name, value);
  metaOf(name).loaded = true;
  writeLocal(name, value);
  if (remoteEnabled()) {
    dirty.add(name);
    scheduleRemote(name);
  }
  return value;
}

function hasPendingWrites() {
  return dirty.size > 0 || timers.size > 0;
}

/** Läser om ett dokument från databasen om någon annan skrivit dit nyare data. */
async function refresh(name) {
  if (!remoteEnabled() || dirty.has(name) || timers.has(name)) return false;
  try {
    const remote = await pullRemote(name);
    const m = metaOf(name);
    if (!remote) return false;
    const remoteTime = Date.parse(remote.updatedAt || 0) || 0;
    const localTime = Date.parse(m.updatedAt || 0) || 0;
    if (m.source === 'supabase' && remoteTime && remoteTime <= localTime) return false;
    docs.set(name, remote.value);
    m.source = 'supabase';
    m.updatedAt = remote.updatedAt || '';
    m.lastSyncAt = Date.now();
    m.lastError = remote.errors.length ? remote.errors.join(' ') : '';
    writeLocal(name, remote.value);
    return true;
  } catch (err) {
    metaOf(name).lastError = err.message;
    return false;
  }
}

/**
 * Startar lagringen: läser lokala filer, hämtar dokumenten från databasen
 * (eller seedar databasen första gången) och startar bakgrundsuppdatering.
 */
async function init() {
  let remoteError = '';
  for (const name of registry.keys()) {
    read(name);
    const m = metaOf(name);
    if (!remoteEnabled()) continue;
    try {
      const remote = await pullRemote(name);
      if (remote) {
        docs.set(name, remote.value);
        m.source = 'supabase';
        m.updatedAt = remote.updatedAt || '';
        m.lastError = remote.errors.length ? remote.errors.join(' ') : '';
        writeLocal(name, remote.value);
      } else {
        // Första körningen: seeda databasen med det vi har lokalt/i minnet.
        dirty.add(name);
        await flush(name);
        m.source = 'supabase';
      }
      m.lastSyncAt = Date.now();
    } catch (err) {
      remoteError = err.message;
      m.lastError = err.message;
      console.error(`[store] Kunde inte hämta ${name} från Supabase:`, err.message);
    }
  }
  if (remoteEnabled() && !refreshTimer) {
    refreshTimer = setInterval(() => {
      for (const name of registry.keys()) refresh(name).catch(() => {});
    }, Math.max(30000, REFRESH_MS));
    if (refreshTimer.unref) refreshTimer.unref();
  }
  return status(remoteError);
}

/** Väntar tills alla väntande skrivningar är klara (används vid avstängning/tester). */
async function flushAll() {
  await Promise.all([...registry.keys()].map((name) => (timers.has(name) || dirty.has(name) ? flush(name) : null)));
}

function status(remoteErrorOverride) {
  const cfg = remoteConfig();
  const documents = {};
  for (const name of registry.keys()) {
    const m = metaOf(name);
    documents[name] = { source: m.source, updatedAt: m.updatedAt, lastSyncAt: m.lastSyncAt, error: m.lastError };
  }
  const error = remoteErrorOverride || [...meta.values()].map((m) => m.lastError).find(Boolean) || '';
  return {
    mode: cfg.configured ? 'supabase' : 'file',
    remote: cfg.configured && !error,
    configured: cfg.configured,
    table: cfg.table,
    encrypted: secure.enabled(),
    urlMasked: cfg.url ? `${cfg.url.replace(/^(https:\/\/[^/]{0,6})/, '$1…')}` : '',
    error,
    pending: hasPendingWrites(),
    documents,
    sql: SQL,
    envVars: {
      url: 'SUPABASE_URL',
      key: 'SUPABASE_SERVICE_ROLE_KEY',
      table: 'SUPABASE_TABLE',
      encryption: secure.KEY_ENV_NAMES[0]
    }
  };
}

module.exports = {
  TABLE,
  SQL,
  register,
  init,
  read,
  write,
  refresh,
  flushAll,
  remoteEnabled,
  remoteConfig,
  status,
  hasPendingWrites
};

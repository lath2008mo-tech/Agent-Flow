/**
 * Agent Flow – inställningar
 *
 * Sparas beständigt via store.js: i Supabase (rekommenderat, gratisnivå) när
 * SUPABASE_URL + nyckel finns i miljön, annars i data/settings.json.
 * Hemliga fält (Google-tokens, Shopify-token, AI-nycklar) krypteras med
 * AES-256-GCM när SETTINGS_ENCRYPTION_KEY är satt. API-nycklar kan även läsas
 * från env-variabler (praktiskt på Render).
 */
const store = require('./store');
const setup = require('./setup');

const DEFAULTS = {
  shopify: {
    store: '',            // t.ex. "minbutik" eller "minbutik.myshopify.com"
    token: '',            // Admin API access token (shpat_...)
    apiVersion: '2026-04'
  },
  providers: {},          // id -> { apiKey, baseUrl }
  defaultProvider: 'openai',
  defaultModel: '',
  allowDestructive: false, // tillåt t.ex. radera produkter
  google: {               // "Logga in med Google" (OAuth)
    clientId: '',
    clientSecret: '',
    refreshToken: '',
    accessToken: '',
    expiresAt: 0,
    email: '',
    name: '',
    picture: '',
    scopes: []
  }
};

// Env-variabler som fyller på saknade nycklar (skrivs inte tillbaka till lagringen)
const ENV_KEYS = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  xai: 'XAI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  ollama: 'OLLAMA_API_KEY'
};

store.register('settings', { file: 'settings.json', initial: () => JSON.parse(JSON.stringify(DEFAULTS)) });

let cache = null;

function load() {
  if (cache) return cache;
  const stored = store.read('settings') || {};
  cache = {
    ...DEFAULTS,
    ...stored,
    shopify: { ...DEFAULTS.shopify, ...(stored.shopify || {}) },
    google: { ...DEFAULTS.google, ...(stored.google || {}) },
    providers: { ...(stored.providers || {}) }
  };

  // Env-överskrivningar (används bara om fältet är tomt)
  if (!cache.shopify.store && process.env.SHOPIFY_STORE) cache.shopify.store = process.env.SHOPIFY_STORE;
  if (!cache.shopify.token && process.env.SHOPIFY_TOKEN) cache.shopify.token = process.env.SHOPIFY_TOKEN;

  for (const [id, envName] of Object.entries(ENV_KEYS)) {
    const envVal = process.env[envName];
    if (envVal && !(cache.providers[id] && cache.providers[id].apiKey)) {
      cache.providers[id] = { ...(cache.providers[id] || {}), apiKey: envVal, fromEnv: true };
    }
  }
  return cache;
}

function save() {
  return store.write('settings', cache);
}

/** Slå ihop en uppdatering med befintliga inställningar. `null`-värden rensar. */
function update(patch) {
  const s = load();
  if (patch.shopify) {
    for (const [k, v] of Object.entries(patch.shopify)) {
      if (v === null) s.shopify[k] = DEFAULTS.shopify[k] ?? '';
      else if (typeof v === 'string') s.shopify[k] = v.trim();
    }
  }
  if (patch.providers && typeof patch.providers === 'object') {
    for (const [id, val] of Object.entries(patch.providers)) {
      if (!s.providers[id]) s.providers[id] = {};
      if (val === null) { delete s.providers[id]; continue; }
      if (Object.prototype.hasOwnProperty.call(val, 'apiKey')) {
        if (val.apiKey === null) { delete s.providers[id].apiKey; delete s.providers[id].fromEnv; }
        else if (val.apiKey !== '') {
          s.providers[id].apiKey = String(val.apiKey).trim();
          delete s.providers[id].fromEnv; // egen nyckel ersätter env-varianten
        }
      }
      if (Object.prototype.hasOwnProperty.call(val, 'baseUrl')) {
        if (val.baseUrl === null) delete s.providers[id].baseUrl;
        else s.providers[id].baseUrl = String(val.baseUrl).trim();
      }
    }
  }
  if (patch.google && typeof patch.google === 'object') {
    for (const k of ['clientId', 'clientSecret']) {
      if (!Object.prototype.hasOwnProperty.call(patch.google, k)) continue;
      const v = patch.google[k];
      if (v === null) s.google[k] = '';
      else if (typeof v === 'string' && v.trim()) s.google[k] = v.trim();
    }
  }
  if (typeof patch.allowDestructive === 'boolean') s.allowDestructive = patch.allowDestructive;
  if (typeof patch.defaultProvider === 'string' && patch.defaultProvider) s.defaultProvider = patch.defaultProvider;
  if (typeof patch.defaultModel === 'string') s.defaultModel = patch.defaultModel;
  if (patch.shopify && typeof patch.shopify.apiVersion === 'string' && patch.shopify.apiVersion) {
    s.shopify.apiVersion = patch.shopify.apiVersion.trim();
  }
  save();
  return s;
}

/** Uppdatera Google-tokens/profil (används av OAuth-flödet). */
function updateGoogle(patch) {
  const s = load();
  Object.assign(s.google, patch);
  save();
  return s;
}

function maskSecret(secret) {
  if (!secret) return '';
  const str = String(secret);
  if (str.length <= 8) return '••••••••';
  return str.slice(0, 3) + '•'.repeat(Math.min(12, str.length - 7)) + str.slice(-4);
}

/**
 * Inställningar säkra att skicka till frontend (nycklar maskeras) plus
 * driftstatus: var data sparas, om kryptering är på och vad som saknas
 * innan Google-kontot kan kopplas.
 */
function publicView() {
  const s = load();
  const providers = {};
  for (const [id, val] of Object.entries(s.providers)) {
    providers[id] = {
      hasKey: Boolean(val.apiKey),
      keyMasked: maskSecret(val.apiKey),
      baseUrl: val.baseUrl || '',
      fromEnv: Boolean(val.fromEnv)
    };
  }
  return {
    shopify: {
      store: s.shopify.store,
      hasToken: Boolean(s.shopify.token),
      tokenMasked: maskSecret(s.shopify.token),
      apiVersion: s.shopify.apiVersion
    },
    providers,
    defaultProvider: s.defaultProvider,
    defaultModel: s.defaultModel,
    allowDestructive: s.allowDestructive,
    google: {
      configured: Boolean((s.google.clientId || process.env.GOOGLE_CLIENT_ID) && (s.google.clientSecret || process.env.GOOGLE_CLIENT_SECRET)),
      connected: Boolean(s.google.refreshToken),
      email: s.google.email,
      name: s.google.name,
      picture: s.google.picture,
      clientIdMasked: maskSecret(s.google.clientId || process.env.GOOGLE_CLIENT_ID || ''),
      hasClientSecret: Boolean(s.google.clientSecret || process.env.GOOGLE_CLIENT_SECRET)
    },
    setup: setup.checklist(s)
  };
}

/** Initierar lagringen (lokala filer + extern databas) innan servern startar. */
async function init() {
  return store.init();
}

module.exports = { load, save, update, updateGoogle, publicView, maskSecret, init, DEFAULTS };

/**
 * Agent Flow – inställningar
 * Sparas lokalt i data/settings.json (skrivs aldrig till git).
 * API-nycklar kan även läsas från env-variabler (praktiskt på Render).
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULTS = {
  shopify: {
    store: '',            // t.ex. "minbutik" eller "minbutik.myshopify.com"
    token: '',            // Admin API access token (shpat_...)
    apiVersion: '2026-04'
  },
  providers: {},          // id -> { apiKey, baseUrl }
  defaultProvider: 'openai',
  defaultModel: '',
  allowDestructive: false // tillåt t.ex. radera produkter
};

// Env-variabler som fyller på saknade nycklar (skrivs inte tillbaka till filen)
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

let cache = null;

function load() {
  if (cache) return cache;
  let stored = {};
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      stored = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[settings] Kunde inte läsa settings.json:', err.message);
  }
  cache = {
    ...DEFAULTS,
    ...stored,
    shopify: { ...DEFAULTS.shopify, ...(stored.shopify || {}) },
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
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, SETTINGS_FILE);
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
        else if (val.apiKey !== '') s.providers[id].apiKey = String(val.apiKey).trim();
      }
      if (Object.prototype.hasOwnProperty.call(val, 'baseUrl')) {
        if (val.baseUrl === null) delete s.providers[id].baseUrl;
        else s.providers[id].baseUrl = String(val.baseUrl).trim();
      }
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

function maskSecret(secret) {
  if (!secret) return '';
  const str = String(secret);
  if (str.length <= 8) return '••••••••';
  return str.slice(0, 3) + '•'.repeat(Math.min(12, str.length - 7)) + str.slice(-4);
}

/** Inställningar säkra att skicka till frontend (nycklar maskeras). */
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
    allowDestructive: s.allowDestructive
  };
}

module.exports = { load, save, update, publicView, maskSecret };

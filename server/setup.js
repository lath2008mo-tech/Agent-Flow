/**
 * Agent Flow – checklista för drift.
 *
 * Svarar på frågan "är det säkert och beständigt nog att koppla ett
 * Google-konto nu?". På en hostad server (Render) krävs:
 *   1. API-skydd       – APP_API_KEY i miljön
 *   2. Extern lagring  – SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *   3. Kryptering      – SETTINGS_ENCRYPTION_KEY i miljön
 * Dessutom krävs alltid Google-klientens Client ID + Secret.
 *
 * Vid lokal körning är 1–3 rekommendationer (varning) i stället för krav.
 */
const env = require('./env');
const auth = require('./auth');
const secure = require('./secure');
const store = require('./store');

function googleConfigured(s) {
  const g = (s && s.google) || {};
  const id = g.clientId || process.env.GOOGLE_CLIENT_ID || '';
  const secret = g.clientSecret || process.env.GOOGLE_CLIENT_SECRET || '';
  return Boolean(id && secret);
}

/** Bygger checklistan. Returnerar aldrig hemligheter – bara status och råd. */
function checklist(s) {
  const hosted = env.isHosted();
  const storage = store.status();
  const authStatus = auth.status();
  const storageOk = store.remoteEnabled() && !storage.error;

  const checks = [
    {
      id: 'google',
      label: 'Google OAuth-uppgifter (Client ID + Secret)',
      ok: googleConfigured(s),
      level: 'required',
      hint: 'Skapa ett OAuth-klient-ID i Google Cloud Console och klistra in Client ID + Client Secret här ovanför (eller sätt GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET i miljön).'
    },
    {
      id: 'auth',
      label: `API-skydd (${auth.KEY_ENV_NAMES[0]})`,
      ok: authStatus.required,
      level: 'required-on-host',
      hint: `Sätt ${auth.KEY_ENV_NAMES[0]} till en lång slumpad sträng i Render → Environment och ange samma nyckel i appen. Utan den kan vem som helst nå API:t – och därmed din e-post och din butik.`
    },
    {
      id: 'storage',
      label: `Extern lagring (${storage.envVars.url} + nyckel)`,
      ok: storageOk,
      level: 'required-on-host',
      hint: 'Skapa ett gratis Supabase-projekt, kör SQL:en nedan och sätt SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY i Render → Environment. Utan extern lagring tappas Google-inloggningen varje gång gratisinstansen startar om.',
      error: storage.error || ''
    },
    {
      id: 'encryption',
      label: `Krypteringsnyckel (${secure.KEY_ENV_NAMES[0]})`,
      ok: secure.enabled(),
      level: 'required-on-host',
      hint: `Sätt ${secure.KEY_ENV_NAMES[0]} till en lång slumpad sträng (minst 32 tecken) i Render → Environment. Tokens krypteras med AES-256-GCM innan de lämnar servern. Ändra den aldrig efteråt – då kan sparade tokens inte läsas.`,
      error: secure.status().lastError || ''
    }
  ];

  const evaluated = checks.map((c) => {
    const blocking = (c.level === 'required' || (c.level === 'required-on-host' && hosted)) && !c.ok;
    return {
      ...c,
      status: c.ok ? 'ok' : (blocking ? 'fail' : 'warn'),
      blocking,
      hint: !c.ok && c.level === 'required-on-host' && !hosted
        ? `${c.hint} (Krävs när appen körs hos en host – inte vid lokal körning.)`
        : c.hint
    };
  });

  const blocking = evaluated.filter((c) => c.blocking);
  return {
    hosted,
    ok: blocking.length === 0,
    canConnectGoogle: blocking.length === 0,
    blocking: blocking.map((c) => c.id),
    checks: evaluated,
    storage,
    auth: authStatus,
    encryption: secure.status(),
    docsVar: SECURE_DOCS
  };
}

const SECURE_DOCS = 'README.md → "Beständig lagring (Supabase, gratis)"';

module.exports = { checklist, googleConfigured };

#!/usr/bin/env node
/**
 * Kontrollerar att den externa lagringen fungerar innan du kopplar Google.
 *
 *   node --env-file=.env scripts/check-storage.js
 *   SUPABASE_URL=... node scripts/check-storage.js      (alla variabler i miljön)
 *
 * Skriver bara till en tillfällig testrad (som städas bort) och visar aldrig
 * några nycklar. Avslutar med felkod 1 om något är fel.
 */
const secure = require('../server/secure');
const store = require('../server/store');
const auth = require('../server/auth');
const env = require('../server/env');

const results = [];
function add(ok, label, detail = '', level = 'error') {
  results.push({ ok, label, detail, level });
  const icon = ok ? '✓' : (level === 'warn' ? '!' : '✕');
  console.log(`${icon} ${label}${detail ? `\n    ${detail.split('\n').join('\n    ')}` : ''}`);
}

async function cleanupTestRow() {
  const { url, key, table } = store.remoteConfig();
  if (!url || !key) return;
  try {
    await fetch(`${url}/rest/v1/${table}?id=eq.${encodeURIComponent('_anslutningstest')}`, {
      method: 'DELETE',
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15000)
    });
  } catch { /* städning är inte kritiskt */ }
}

(async () => {
  console.log('Agent Flow – kontroll av extern lagring\n');

  const hosted = env.isHosted();
  console.log(`Miljö: ${hosted ? 'hostad (Render)' : 'lokal körning'}\n`);

  // 1. Miljövariabler
  const cfg = store.remoteConfig();
  add(Boolean(cfg.url), `SUPABASE_URL hittad${cfg.url ? ` (${cfg.url.replace(/^(https:\/\/[^/]{0,8})/, '$1…')})` : ''}`,
    cfg.url ? '' : 'Sätt den i Render → Environment (eller i din .env-fil).');
  add(Boolean(cfg.key), 'SUPABASE_SERVICE_ROLE_KEY hittad',
    cfg.key ? 'Nyckeln visas aldrig – bara att den finns.' : 'Hämta service_role-nyckeln i Supabase → Settings → API.');
  add(secure.enabled(), `Krypteringsnyckel (${secure.KEY_ENV_NAMES[0]}) hittad`,
    secure.enabled() ? '' : 'Skapa en slumpad sträng på minst 32 tecken och sätt den i miljön.', secure.enabled() ? 'error' : (hosted ? 'error' : 'warn'));
  add(auth.required(), `API-skydd (${auth.keySource() || 'APP_API_KEY'})`,
    auth.required() ? '' : 'Sätt APP_API_KEY – annars är API:t öppet för alla som hittar adressen.', auth.required() ? 'error' : (hosted ? 'error' : 'warn'));

  if (!secure.enabled()) {
    console.log('\nKryptering är av – fortsätter ändå, men tokens sparas i klartext.');
  }

  // 2. Krypteringens runtur
  if (secure.enabled()) {
    try {
      const value = secure.decrypt(secure.encrypt('testvärde-123'));
      add(value === 'testvärde-123', 'Kryptering fungerar (AES-256-GCM)', '', 'error');
    } catch (err) {
      add(false, 'Kryptering fungerar', err.message);
    }
  }

  if (!cfg.configured) {
    console.log('\nIngen extern databas är konfigurerad. Se README → "Beständig lagring".');
  } else {
    // 3. Anslutning + tabell + skriv/läs-runtur
    store.register('_anslutningstest', { file: '_anslutningstest.json', initial: {} });
    const status = await store.init();

    add(status.remote, `Anslutning till Supabase (tabell: ${status.table})`,
      status.remote ? '' : (status.error || 'Okänt fel.'));
    add(status.encrypted, 'Lagringen är krypterad', status.encrypted ? '' : 'Sätt SETTINGS_ENCRYPTION_KEY.');

    try {
      const stamp = new Date().toISOString();
      store.write('_anslutningstest', { stamp, hemlighet: 'bara-ett-test' });
      await store.flushAll();
      const statusAfter = store.status();
      if (statusAfter.error) throw new Error(statusAfter.error);
      add(true, 'Skrivning till databasen fungerar');
    } catch (err) {
      add(false, 'Skrivning till databasen fungerar', err.message);
    }

    await cleanupTestRow();
  }

  // 4. Sammanfattning
  const failed = results.filter((r) => !r.ok && r.level === 'error');
  const warned = results.filter((r) => !r.ok && r.level === 'warn');
  console.log('');
  if (!failed.length && !warned.length) {
    console.log('Allt klart ✓ – koppla Google under Integrationer i appen.');
  } else if (!failed.length) {
    console.log('Fungerar, men med varningar ovan (krävs inte vid lokal körning).');
  } else {
    console.log(`Åtgärda ${failed.length} punkt${failed.length === 1 ? '' : 'er'} ovan och kör igen.`);
  }
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error('\nOväntat fel:', err.message);
  process.exit(1);
});

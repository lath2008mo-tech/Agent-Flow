#!/usr/bin/env node
/**
 * Kontrollerar en deployad Agent Flow-instans via det publika /api/health.
 * Visar aldrig hemligheter – health-endpointen innehåller bara status.
 *
 *   node scripts/verify-deploy.js https://agent-flow-f2oo.onrender.com
 *   node scripts/verify-deploy.js https://... --api-key=XXX   (testar även API-skyddet)
 *
 * Kör kommandot en gång, starta om tjänsten i Render (Manual Deploy → Restart),
 * kör kommandot igen: då jämförs tidsstämpeln och du får svaret på om
 * Google-inloggningen överlevde omstarten.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_FILE = path.join(os.tmpdir(), 'agent-flow-deploy-check.json');

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : '';
}

const base = (process.argv[2] || '').replace(/\/+$/, '');
const apiKey = arg('api-key');

if (!base || !/^https?:\/\//.test(base)) {
  console.error('Användning: node scripts/verify-deploy.js https://din-app.onrender.com [--api-key=XXX]');
  process.exit(2);
}

const icon = (ok, warn) => (ok ? '✓' : (warn ? '!' : '✕'));

(async () => {
  console.log(`Kontrollerar ${base}\n`);

  let health;
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(120000) });
    health = await res.json();
  } catch (err) {
    console.error(`✕ Kunde inte nå appen: ${err.message}`);
    console.error('  (Gratisinstansen kan sova – öppna appen i webbläsaren först och försök igen.)');
    process.exit(1);
  }

  if (!health.setup) {
    console.log('! Appen svarar, men kör en äldre version utan driftstatus.');
    console.log('  → Deploya senaste commit i Render: Manual Deploy → Deploy latest commit.');
    console.log(`  (svar: ${JSON.stringify(health)})`);
    process.exit(1);
  }

  const s = health.setup;
  const problems = [];
  console.log(`App:        ${health.app} (svarade ${health.time})`);
  console.log(`Miljö:      ${s.hosted ? 'hostad – extern lagring krävs' : 'lokal körning'}`);
  console.log(`Lagring:    ${s.storage.mode === 'supabase' ? `Supabase (${s.envVars.storageUrl})` : 'lokal fil (tillfällig disk!)'}`);
  console.log(`Kryptering: ${s.storage.encrypted ? 'på (AES-256-GCM)' : 'AV'}`);
  console.log(`API-skydd:  ${s.authRequired ? `på (${s.envVars.auth})` : 'AV – vem som helst kan nå API:t'}`);
  console.log(`Google:     ${s.google.connected ? `kopplad${s.google.connectedAt ? ` sedan ${s.google.connectedAt}` : ''}` : 'inte kopplad'}${s.google.connected ? (s.google.tokenReadable ? ' (token läsbar ✓)' : ' (token går INTE att läsa!)') : ''}`);
  if (s.missing.length) console.log(`Saknas:     ${s.missing.join(', ')}`);
  if (s.storage.error) console.log(`Lagringsfel: ${s.storage.error}`);

  if (s.hosted && s.storage.mode !== 'supabase') problems.push('Extern lagring saknas (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).');
  if (s.hosted && !s.storage.encrypted) problems.push('Krypteringsnyckeln saknas (SETTINGS_ENCRYPTION_KEY).');
  if (s.hosted && !s.authRequired) problems.push('API-skyddet saknas (APP_API_KEY).');
  if (s.missing.includes('google')) problems.push('Google-uppgifterna saknas (Client ID + Client Secret under Integrationer).');
  if (s.google.connected && !s.google.tokenReadable) problems.push('Google-token kan inte dekrypteras – fel SETTINGS_ENCRYPTION_KEY?');

  if (apiKey) {
    console.log('');
    const noKey = await fetch(`${base}/api/settings`);
    console.log(`${icon(noKey.status === 401, false)} Utan nyckel: HTTP ${noKey.status}${noKey.status === 401 ? ' (skyddat, som det ska)' : ' – borde vara 401'}`);
    if (noKey.status !== 401 && s.authRequired) problems.push('API:t svarade utan nyckel trots att APP_API_KEY är satt.');

    const withKey = await fetch(`${base}/api/settings`, { headers: { 'x-api-key': apiKey } });
    console.log(`${icon(withKey.ok, false)} Med nyckel: HTTP ${withKey.status}${withKey.ok ? ' (nyckeln fungerar)' : ' – kontrollera APP_API_KEY'}`);
    if (!withKey.ok) problems.push('APP_API_KEY stämmer inte med serverns värde.');
  }

  // Jämför med föregående körning
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* första körningen */ }

  if (previous && previous.base === base) {
    console.log('\nJämfört med föregående körning:');
    if (previous.connectedAt && previous.connectedAt === s.google.connectedAt) {
      console.log(`✓ Google-inloggningen är kvar med SAMMA tidsstämpel (${s.google.connectedAt}) – den överlevde omstarten.`);
    } else if (previous.connected && !s.google.connected) {
      console.log('✕ Google-kopplingen är BORTA nu men fanns förut – lagringen överlevde inte. Kontrollera SUPABASE_URL och nyckeln.');
      problems.push('Google-inloggningen tappades.');
    } else if (previous.connectedAt && s.google.connectedAt && previous.connectedAt !== s.google.connectedAt) {
      console.log(`! Ny tidsstämpel (${previous.connectedAt} → ${s.google.connectedAt}): kopplingen gjordes om – kontrollera att databasen används.`);
      problems.push('Google-inloggningen gjordes om i stället för att återanvändas.');
    } else {
      console.log('(Google var inte kopplad vid föregående körning – koppla kontot och kör kommandot igen.)');
    }
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify({
    base,
    checkedAt: new Date().toISOString(),
    connected: s.google.connected,
    connectedAt: s.google.connectedAt,
    storageMode: s.storage.mode
  }, null, 2));

  console.log('');
  if (problems.length) {
    console.log('Att åtgärda:');
    for (const p of problems) console.log(` - ${p}`);
    console.log('\nGuide: README → "Beständig lagring + API-skydd" och "Kontrollera deployen".');
    process.exit(1);
  }
  console.log('Allt ser bra ut ✓');
  if (!previous || previous.base !== base) {
    console.log('Starta om tjänsten i Render (Manual Deploy → Restart) och kör kommandot igen – då kontrolleras att inloggningen överlevde.');
  }
})().catch((err) => {
  console.error('Fel:', err.message);
  process.exit(1);
});

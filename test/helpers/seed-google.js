/**
 * Seedar en Google-koppling i den konfigurerade lagringen (används av e2e-testet
 * för att simulera "användaren klickade Logga in med Google").
 */
// Skyddsnät: körs bara när testet uttryckligen ber om det (aldrig av en
// misstänkt testkörning som letar igenom katalogen).
if (process.env.AGENT_FLOW_SEED !== '1') {
  console.log('seed-google: hoppar över (sätt AGENT_FLOW_SEED=1)');
  process.exit(0);
}

const settings = require('../../server/settings');
const store = require('../../server/store');

(async () => {
  await settings.init();
  settings.updateGoogle({
    refreshToken: 'refresh-token-från-google',
    accessToken: 'access-token-1',
    expiresAt: Date.now() + 3600 * 1000,
    email: 'test@example.com',
    name: 'Test Testsson',
    connectedAt: '' // sätts automatiskt av updateGoogle
  });
  await store.flushAll();
  console.log(JSON.stringify({ connectedAt: settings.load().google.connectedAt }));
})();

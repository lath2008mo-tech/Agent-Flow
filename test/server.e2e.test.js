/**
 * End-to-end: startar den riktiga servern som en separat process (som Render
 * gör), kopplar Google via seed-skriptet, startar om med TOM lokal disk och
 * kontrollerar att inloggningen finns kvar.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { tempDataDir, startServer, runScript, randomPort, waitFor } = require('./helpers/env');
const { createFakeSupabase } = require('./helpers/fake-supabase');

test('serverprocess: API-skydd, Supabase-lagring och Google kvar efter omstart', { timeout: 90000 }, async () => {
  const fake = createFakeSupabase();
  const dbUrl = await fake.listen();
  const apiKey = 'e2e-api-nyckel';
  const env = {
    RENDER: 'true',
    SUPABASE_URL: dbUrl,
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    SETTINGS_ENCRYPTION_KEY: 'e2e-krypteringsnyckel-abcdefghijklmnop',
    APP_API_KEY: apiKey,
    GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'GOCSPX-hemlig'
  };
  const auth = { 'x-api-key': apiKey, 'Content-Type': 'application/json' };
  let server = null;
  try {
    // --- Start 1 (tom disk, tom databas) ---
    server = await startServer({ port: randomPort(), env: { ...env, DATA_DIR: tempDataDir('e2e-1') } }).waitUntilReady();

    const health = await (await fetch(`${server.base}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.setup.storage.mode, 'supabase');
    assert.equal(health.setup.storage.remote, true);
    assert.equal(health.setup.storage.encrypted, true);
    assert.equal(health.setup.authRequired, true);
    assert.deepEqual(health.setup.missing, []);
    assert.equal(health.setup.google.connected, false);

    // API:t är skyddat
    assert.equal((await fetch(`${server.base}/api/settings`)).status, 401);
    assert.equal((await fetch(`${server.base}/api/settings`, { headers: auth })).status, 200);

    // Spara Shopify-token via API:t – den ska hamna krypterad i databasen
    const put = await fetch(`${server.base}/api/settings`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ shopify: { store: 'minbutik', token: 'shpat_E2E_HEMLIG' } })
    });
    assert.equal(put.status, 200);
    // Skrivningen är asynkron (kort fördröjning) – vänta in den
    await waitFor(() => fake.raw().includes('enc:v1:'), { label: 'krypterad skrivning till databasen' });
    assert.doesNotMatch(fake.raw(), /shpat_E2E_HEMLIG/);

    // --- Simulerar att användaren loggar in med Google (samma nycklar i miljön) ---
    const seedOutput = await runScript(path.join(__dirname, 'helpers', 'seed-google.js'), {
      env: { ...env, DATA_DIR: tempDataDir('e2e-seed'), AGENT_FLOW_SEED: '1' }
    });
    const connectedAt = JSON.parse(seedOutput.trim()).connectedAt;
    assert.ok(connectedAt, 'connectedAt ska ha satts');

    // --- Start 2: OMSTART med tom lokal disk ---
    await server.stop();
    server = await startServer({ port: randomPort(), env: { ...env, DATA_DIR: tempDataDir('e2e-2') } }).waitUntilReady();

    const after = await (await fetch(`${server.base}/api/health`)).json();
    assert.equal(after.setup.google.connected, true, 'Google ska vara kopplat efter omstart');
    assert.equal(after.setup.google.tokenReadable, true, 'token ska gå att dekryptera efter omstart');
    assert.equal(after.setup.google.connectedAt, connectedAt,
      'samma tidsstämpel som före omstarten ⇒ inloggningen överlevde (ingen omloggning)');

    const settingsRes = await (await fetch(`${server.base}/api/settings`, { headers: auth })).json();
    assert.equal(settingsRes.shopify.store, 'minbutik', 'Shopify-kopplingen ska också överleva');
    assert.equal(settingsRes.google.connected, true);
    assert.equal(settingsRes.google.email, 'test@example.com');

    const statusRes = await (await fetch(`${server.base}/api/google/status`, { headers: auth })).json();
    assert.equal(statusRes.connected, true);
    assert.equal(statusRes.connectedAt, connectedAt);
    assert.equal(statusRes.canConnect, true);

    // --- Start 3: tredje omstarten, fortfarande samma tidsstämpel ---
    await server.stop();
    server = await startServer({ port: randomPort(), env: { ...env, DATA_DIR: tempDataDir('e2e-3') } }).waitUntilReady();
    const third = await (await fetch(`${server.base}/api/health`)).json();
    assert.equal(third.setup.google.connectedAt, connectedAt, 'inloggningen ska vara stabil över flera omstarter');
  } finally {
    if (server) await server.stop();
    await fake.close();
  }
});

test('serverprocess: lokal körning utan extern databas fungerar som förut', { timeout: 60000 }, async () => {
  let server = null;
  try {
    server = await startServer({ port: randomPort(), env: { DATA_DIR: tempDataDir('e2e-local'), RENDER: undefined } }).waitUntilReady();
    const health = await (await fetch(`${server.base}/api/health`)).json();
    assert.equal(health.setup.storage.mode, 'file');
    assert.equal(health.setup.authRequired, false);
    assert.equal(health.setup.hosted, false);
    // Öppet API lokalt, precis som tidigare
    const put = await fetch(`${server.base}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopify: { store: 'lokalbutik', token: 'shpat_lokal' } })
    });
    assert.equal(put.status, 200);
    const view = await (await fetch(`${server.base}/api/settings`)).json();
    assert.equal(view.shopify.store, 'lokalbutik');
    assert.equal(view.shopify.hasToken, true);
  } finally {
    if (server) await server.stop();
  }
});

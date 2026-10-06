/**
 * Google-kopplingen: OAuth-state, callback, tokens i extern databas och
 * att inloggningen överlever en omstart (kravet från Render Free).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshServer, withEnv, tempDataDir } = require('./helpers/env');
const { createFakeSupabase } = require('./helpers/fake-supabase');

const KEY = 'test-krypteringsnyckel-abcdefghijklmnopqrstuvwxyz';
const API_KEY = 'test-api-nyckel';
const DB_KEY = 'test-service-role-key';

const jsonResponse = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });

/**
 * Mockar Googles endpoints. Returnerar loggen över anropade URL:er.
 * Allt som inte är Google passerar vidare till riktig fetch – annars skulle
 * lagringens anrop till testdatabasen också kapas.
 */
function mockGoogle() {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const target = String(url);
    if (!target.includes('googleapis.com') && !target.includes('accounts.google.com')) {
      return realFetch(url, opts);
    }
    calls.push({ url: target, body: String(opts.body || '') });
    if (target.includes('oauth2.googleapis.com/token')) {
      if (String(opts.body || '').includes('grant_type=refresh_token')) {
        return jsonResponse({ access_token: 'access-från-refresh', expires_in: 3600 });
      }
      return jsonResponse({
        access_token: 'access-token-1',
        refresh_token: 'refresh-token-1',
        expires_in: 3600,
        scope: 'openid email https://www.googleapis.com/auth/gmail.modify'
      });
    }
    if (target.includes('userinfo')) {
      return jsonResponse({ email: 'test@example.com', name: 'Test Testsson', picture: 'https://example.com/p.png' });
    }
    return jsonResponse({});
  };
  return calls;
}

const req = (host = 'agent-flow-f2oo.onrender.com') => ({
  headers: { host, 'x-forwarded-proto': 'https' },
  protocol: 'http'
});

const hostedEnv = (fakeUrl, dataDir) => ({
  DATA_DIR: dataDir,
  RENDER: 'true',
  SUPABASE_URL: fakeUrl,
  SUPABASE_SERVICE_ROLE_KEY: DB_KEY,
  SETTINGS_ENCRYPTION_KEY: KEY,
  APP_API_KEY: API_KEY,
  GOOGLE_CLIENT_ID: undefined,
  GOOGLE_CLIENT_SECRET: undefined
});

test('Google kan inte kopplas på Render förrän API-skydd, lagring och kryptering är på plats', async () => {
  mockGoogle();
  await withEnv({
    DATA_DIR: tempDataDir('google-blocked'),
    RENDER: 'true',
    SUPABASE_URL: undefined,
    SUPABASE_SERVICE_ROLE_KEY: undefined,
    SETTINGS_ENCRYPTION_KEY: undefined,
    APP_API_KEY: undefined
  }, async () => {
    const { settings, google, setup } = freshServer();
    await settings.init();
    settings.update({ google: { clientId: 'id.apps.googleusercontent.com', clientSecret: 'secret' } });

    const chk = setup.checklist(settings.load());
    assert.equal(chk.canConnectGoogle, false);
    assert.deepEqual([...chk.blocking].sort(), ['auth', 'encryption', 'storage']);

    assert.throws(() => google.authUrl(req()), /Innan Google kan kopplas/);
    await assert.rejects(
      () => google.handleCallback({ ...req(), query: { code: 'x', state: 'a.b.c' } }),
      /Ogiltig eller utgången inloggningsstatus/
    );
  });
});

test('hela flödet: state → callback → tokens i databasen → kvar efter omstart', async () => {
  const fake = createFakeSupabase();
  const dbUrl = await fake.listen();
  const dataDir = tempDataDir('google-flow');
  const calls = mockGoogle();
  try {
    const connected = await withEnv(hostedEnv(dbUrl, dataDir), async () => {
      const { settings, google, setup, store } = freshServer();
      await settings.init();
      settings.update({ google: { clientId: 'id.apps.googleusercontent.com', clientSecret: 'GOCSPX-hemlig' } });
      assert.equal(setup.checklist(settings.load()).canConnectGoogle, true);

      const url = new URL(google.authUrl(req()));
      assert.equal(url.host, 'accounts.google.com');
      assert.equal(url.searchParams.get('redirect_uri'), 'https://agent-flow-f2oo.onrender.com/api/google/callback');
      assert.equal(url.searchParams.get('access_type'), 'offline');
      const state = url.searchParams.get('state');
      assert.equal(state.split('.').length, 3, 'state ska vara signerat (nonce.ts.signatur)');

      const profile = await google.handleCallback({ ...req(), query: { code: 'kod-123', state } });
      assert.equal(profile.email, 'test@example.com');
      assert.equal(profile.storage, 'supabase');

      const s = settings.load();
      assert.equal(google.isConnected(s), true);
      assert.ok(s.google.connectedAt, 'connectedAt ska sättas när inloggningen sparas');
      assert.equal(google.tokenHealth(s).readable, true);

      // Samma state får inte användas igen medan servern lever
      await assert.rejects(
        () => google.handleCallback({ ...req(), query: { code: 'kod-123', state } }),
        /Ogiltig eller utgången inloggningsstatus/
      );

      // Ingen klartext i databasen (vänta in den asynkrona skrivningen)
      await store.flushAll();
      const raw = fake.raw();
      assert.doesNotMatch(raw, /refresh-token-1/);
      assert.doesNotMatch(raw, /GOCSPX-hemlig/);
      assert.match(raw, /enc:v1:/);

      return { connectedAt: s.google.connectedAt };
    });

    // OMSTART med tom lokal disk – inloggningen ska finnas kvar, oförändrad
    await withEnv(hostedEnv(dbUrl, tempDataDir('google-flow-restart')), async () => {
      const { settings, google, store } = freshServer();
      await settings.init();
      const s = settings.load();
      assert.equal(google.isConnected(s), true, 'Google ska vara kopplat efter omstart');
      assert.equal(s.google.email, 'test@example.com');
      assert.equal(s.google.refreshToken, 'refresh-token-1', 'token ska dekrypteras korrekt');
      assert.equal(s.google.connectedAt, connected.connectedAt, 'samma tidsstämpel ⇒ samma inloggning, ingen omloggning');
      assert.equal(google.status().connected, true);
      assert.equal(google.status().tokenHealth.readable, true);

      // Den sparade token fungerar även efter omstart: access-token har gått ut → refresh
      s.google.expiresAt = 0;
      const me = await google.gapi('GET', 'https://www.googleapis.com/oauth2/v3/userinfo');
      assert.equal(me.email, 'test@example.com');
      assert.ok(calls.some((c) => c.body.includes('grant_type=refresh_token') && c.body.includes('refresh-token-1')),
        'en refresh mot Google ska ha gjorts med den sparade token');
      assert.equal(settings.load().google.accessToken, 'access-från-refresh', 'ny access-token ska sparas');
      await store.flushAll();
    });

    // Omstart igen – fortfarande samma koppling
    await withEnv(hostedEnv(dbUrl, tempDataDir('google-flow-restart2')), async () => {
      const { settings, store } = freshServer();
      await settings.init();
      assert.equal(settings.load().google.connectedAt, connected.connectedAt);
      assert.equal(settings.load().google.accessToken, 'access-från-refresh');
      await store.flushAll();
    });
  } finally {
    await fake.close();
  }
});

test('fel krypteringsnyckel: kopplingen visas som trasig, inte som utloggad och utan dataförlust', async () => {
  const fake = createFakeSupabase();
  const dbUrl = await fake.listen();
  try {
    await withEnv(hostedEnv(dbUrl, tempDataDir('google-badkey')), async () => {
      const { settings, store } = freshServer();
      await settings.init();
      settings.update({ google: { clientId: 'id', clientSecret: 'hemlig' } });
      settings.updateGoogle({ refreshToken: 'refresh-token-1', email: 'test@example.com' });
      await store.flushAll();
    });

    await withEnv({ ...hostedEnv(dbUrl, tempDataDir('google-badkey2')), SETTINGS_ENCRYPTION_KEY: 'fel-nyckel-1234567890-abcdefghijkl' }, async () => {
      const { settings, google } = freshServer();
      await settings.init();
      const s = settings.load();
      const health = google.tokenHealth(s);
      assert.equal(health.stored, true);
      assert.equal(health.readable, false);
      assert.match(health.error, /SETTINGS_ENCRYPTION_KEY/);
      assert.equal(google.isConnected(s), false, 'får inte låtsas vara ansluten');
      await assert.rejects(() => google.gapi('GET', 'https://example.com'), /kan inte läsas/);
      // Ingen dataförlust
      assert.match(fake.rows.get('settings').payload.google.refreshToken, /^enc:v1:/);
    });
  } finally {
    await fake.close();
  }
});

test('utloggning rensar tokens och tidsstämpeln', async () => {
  const fake = createFakeSupabase();
  const dbUrl = await fake.listen();
  try {
    await withEnv(hostedEnv(dbUrl, tempDataDir('google-disconnect')), async () => {
      const { settings, google, store } = freshServer();
      mockGoogle();
      await settings.init();
      settings.update({ google: { clientId: 'id', clientSecret: 'hemlig' } });
      settings.updateGoogle({ refreshToken: 'refresh-token-1', email: 'test@example.com' });
      assert.ok(settings.load().google.connectedAt);

      google.disconnect();
      const s = settings.load();
      assert.equal(s.google.refreshToken, '');
      assert.equal(s.google.connectedAt, '');
      assert.equal(google.isConnected(s), false);
      await store.flushAll();
    });
  } finally {
    await fake.close();
  }
});

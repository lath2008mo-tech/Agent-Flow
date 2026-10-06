/**
 * Checklistan (server/setup.js): blockerande krav på Render, varningar lokalt.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshServer, withEnv, tempDataDir } = require('./helpers/env');
const { createFakeSupabase } = require('./helpers/fake-supabase');

const googleCreds = { google: { clientId: 'id.apps.googleusercontent.com', clientSecret: 'hemlig' } };

test('lokal körning: avsaknad av Supabase/nycklar ger varningar, inte hinder', async () => {
  await withEnv({
    DATA_DIR: tempDataDir('setup-local'),
    RENDER: undefined,
    RENDER_SERVICE_ID: undefined,
    RENDER_EXTERNAL_URL: undefined,
    REQUIRE_DURABLE_STORAGE: undefined,
    SUPABASE_URL: undefined,
    SUPABASE_SERVICE_ROLE_KEY: undefined,
    SETTINGS_ENCRYPTION_KEY: undefined,
    APP_API_KEY: undefined
  }, async () => {
    const { settings, setup } = freshServer();
    await settings.init();
    settings.update(googleCreds);

    const chk = setup.checklist(settings.load());
    assert.equal(chk.hosted, false);
    assert.equal(chk.canConnectGoogle, true, 'lokal körning ska kunna koppla Google utan Supabase');
    assert.deepEqual(chk.blocking, []);
    assert.deepEqual(
      chk.checks.filter((c) => c.status === 'warn').map((c) => c.id).sort(),
      ['auth', 'encryption', 'storage']
    );
    assert.match(chk.checks.find((c) => c.id === 'storage').hint, /lokal körning/i);
  });
});

test('Render: allt saknas → alla tre kraven blockerar', async () => {
  await withEnv({
    DATA_DIR: tempDataDir('setup-hosted-empty'),
    RENDER: 'true',
    SUPABASE_URL: undefined,
    SUPABASE_SERVICE_ROLE_KEY: undefined,
    SETTINGS_ENCRYPTION_KEY: undefined,
    APP_API_KEY: undefined
  }, async () => {
    const { settings, setup } = freshServer();
    await settings.init();
    settings.update(googleCreds);

    const chk = setup.checklist(settings.load());
    assert.equal(chk.hosted, true);
    assert.equal(chk.ok, false);
    assert.equal(chk.canConnectGoogle, false);
    assert.deepEqual([...chk.blocking].sort(), ['auth', 'encryption', 'storage']);
  });
});

test('Render utan Google-uppgifter: google är alltid ett blockerande krav', async () => {
  const fake = createFakeSupabase();
  const dbUrl = await fake.listen();
  try {
    await withEnv({
      DATA_DIR: tempDataDir('setup-hosted-google-missing'),
      RENDER: 'true',
      SUPABASE_URL: dbUrl,
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
      SETTINGS_ENCRYPTION_KEY: 'nyckel-abcdefghijklmnopqrstuvwxyz',
      APP_API_KEY: 'api-nyckel'
    }, async () => {
      const { settings, setup } = freshServer();
      await settings.init();
      const chk = setup.checklist(settings.load());
      assert.deepEqual(chk.blocking, ['google']);
      assert.equal(chk.canConnectGoogle, false);
      assert.match(chk.checks.find((c) => c.id === 'google').hint, /Client ID/);
    });
  } finally {
    await fake.close();
  }
});

test('Render med allt på plats → allt klart', async () => {
  const fake = createFakeSupabase();
  const dbUrl = await fake.listen();
  try {
    await withEnv({
      DATA_DIR: tempDataDir('setup-hosted-ok'),
      RENDER: 'true',
      SUPABASE_URL: dbUrl,
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
      SETTINGS_ENCRYPTION_KEY: 'nyckel-abcdefghijklmnopqrstuvwxyz',
      APP_API_KEY: 'api-nyckel'
    }, async () => {
      const { settings, setup } = freshServer();
      await settings.init();
      settings.update(googleCreds);
      const chk = setup.checklist(settings.load());
      assert.equal(chk.ok, true);
      assert.equal(chk.canConnectGoogle, true);
      assert.deepEqual(chk.blocking, []);
      assert.ok(chk.checks.every((c) => c.status === 'ok'));
      assert.equal(chk.storage.mode, 'supabase');
      assert.equal(chk.storage.encrypted, true);
    });
  } finally {
    await fake.close();
  }
});

test('databasfel gör att lagringskravet blockerar med begripligt fel', async () => {
  const fake = createFakeSupabase({ apiKey: 'rätt-nyckel' });
  const dbUrl = await fake.listen();
  try {
    await withEnv({
      DATA_DIR: tempDataDir('setup-db-error'),
      RENDER: 'true',
      SUPABASE_URL: dbUrl,
      SUPABASE_SERVICE_ROLE_KEY: 'fel-nyckel',
      SETTINGS_ENCRYPTION_KEY: 'nyckel-abcdefghijklmnopqrstuvwxyz',
      APP_API_KEY: 'api-nyckel'
    }, async () => {
      const { settings, setup } = freshServer();
      await settings.init();
      settings.update(googleCreds);
      const chk = setup.checklist(settings.load());
      const storage = chk.checks.find((c) => c.id === 'storage');
      assert.equal(storage.status, 'fail');
      assert.match(storage.error, /Invalid API key/);
      assert.equal(chk.canConnectGoogle, false);
    });
  } finally {
    await fake.close();
  }
});

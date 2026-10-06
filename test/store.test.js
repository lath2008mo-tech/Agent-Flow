/**
 * Lagring (server/store.js): lokal fil, Supabase-läge, kryptering på disk,
 * överlevnad vid omstart och att databasfel inte tappar data.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { freshServer, withEnv, tempDataDir } = require('./helpers/env');
const { createFakeSupabase } = require('./helpers/fake-supabase');

const KEY = 'test-krypteringsnyckel-abcdefghijklmnopqrstuvwxyz';

test('lokal fil: sparar, läser och överlever en omstart', () => {
  const dataDir = tempDataDir('store-local');
  withEnv({ DATA_DIR: dataDir, SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined, SETTINGS_ENCRYPTION_KEY: KEY }, async () => {
    let { store } = freshServer();
    store.register('testdoc', { file: 'testdoc.json', initial: [] });
    await store.init();
    store.write('testdoc', { hej: 'värld', n: 1 });
    await store.flushAll();

    // Omstart: ren modulcache, samma katalog
    const second = freshServer();
    second.store.register('testdoc', { file: 'testdoc.json', initial: [] });
    const status = await second.store.init();
    assert.equal(status.mode, 'file');
    assert.equal(status.remote, false);
    assert.deepEqual(second.store.read('testdoc'), { hej: 'värld', n: 1 });
  });
});

test('Supabase-läge: skriver till databasen och läser tillbaka efter omstart', async () => {
  const fake = createFakeSupabase();
  const dbUrl = await fake.listen();
  const dataDir = tempDataDir('store-remote');
  try {
    await withEnv({
      DATA_DIR: dataDir,
      SUPABASE_URL: dbUrl,
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
      SETTINGS_ENCRYPTION_KEY: KEY
    }, async () => {
      let { store, secure } = freshServer();
      store.register('botar', { file: 'botar.json', initial: [] });
      const status = await store.init();
      assert.equal(status.mode, 'supabase');
      assert.equal(status.remote, true);
      assert.equal(status.encrypted, true);

      // Första initieringen ska seeda databasen
      assert.ok(fake.rows.has('botar'), 'dokumentet ska ha skapats i databasen');

      store.write('botar', [{ id: 'bot_1', name: 'Testbot', token: 'hemlig-bot-token' }]);
      await store.flushAll();
      const stored = fake.rows.get('botar').payload;
      assert.equal(stored[0].name, 'Testbot');
      assert.equal(stored[0].token, 'hemlig-bot-token', 'botar innehåller inga hemliga fält – sparas som de är');
      assert.equal(secure.isEncrypted(stored[0].token), false);

      // Omstart med TOM lokal disk (som en ny Render-instans)
      const freshDir = tempDataDir('store-remote-newdisk');
      const second = await withEnv({ DATA_DIR: freshDir }, async () => {
        const s = freshServer();
        s.store.register('botar', { file: 'botar.json', initial: [] });
        await s.store.init();
        return s;
      });
      assert.deepEqual(second.store.read('botar'), [{ id: 'bot_1', name: 'Testbot', token: 'hemlig-bot-token' }]);
    });
  } finally {
    await fake.close();
  }
});

test('hemliga fält hamnar aldrig i klartext i databasen', async () => {
  const fake = createFakeSupabase();
  const dbUrl = await fake.listen();
  try {
    await withEnv({
      DATA_DIR: tempDataDir('store-secrets'),
      SUPABASE_URL: dbUrl,
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
      SETTINGS_ENCRYPTION_KEY: KEY
    }, async () => {
      const { settings, store } = freshServer();
      await settings.init();
      settings.update({
        shopify: { store: 'minbutik', token: 'shpat_SUPERSECRET' },
        google: { clientId: 'id.apps.googleusercontent.com', clientSecret: 'GOCSPX-hemlig' },
        providers: { openai: { apiKey: 'sk-proj-hemlig' } }
      });
      settings.updateGoogle({ refreshToken: '1//refresh-hemlig' });
      await store.flushAll();

      const raw = fake.raw();
      assert.doesNotMatch(raw, /shpat_SUPERSECRET/);
      assert.doesNotMatch(raw, /GOCSPX-hemlig/);
      assert.doesNotMatch(raw, /sk-proj-hemlig/);
      assert.doesNotMatch(raw, /1\/\/refresh-hemlig/);
      assert.match(raw, /enc:v1:/);
      assert.equal(fake.rows.get('settings').payload.shopify.store, 'minbutik', 'butiksnamnet är inte hemligt');
    });
  } finally {
    await fake.close();
  }
});

test('databasfel tappar inte data – lokal fil behåller den och felet rapporteras', async () => {
  const fake = createFakeSupabase();
  const dbUrl = await fake.listen();
  const dataDir = tempDataDir('store-fail');
  try {
    await withEnv({
      DATA_DIR: dataDir,
      SUPABASE_URL: dbUrl,
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
      SETTINGS_ENCRYPTION_KEY: KEY
    }, async () => {
      const { store } = freshServer();
      store.register('viktigt', { file: 'viktigt.json', initial: {} });
      await store.init();
      fake.failNextPosts(1);

      store.write('viktigt', { svar: 42 });
      await store.flushAll();
      const status = store.status();
      assert.match(status.error, /simulerat databasfel/);
      assert.equal(status.remote, false, 'status ska visa att databasen inte är i synk');

      // Data finns kvar lokalt och skrivs till databasen igen när den fungerar
      const local = JSON.parse(fs.readFileSync(path.join(dataDir, 'viktigt.json'), 'utf8'));
      assert.equal(local.svar, 42);
      store.write('viktigt', { svar: 43 });
      await store.flushAll();
      assert.equal(fake.rows.get('viktigt').payload.svar, 43);
      assert.equal(store.status().error, '');
    });
  } finally {
    await fake.close();
  }
});

test('fel krypteringsnyckel: status flaggar felet men data finns kvar', async () => {
  const fake = createFakeSupabase();
  const dbUrl = await fake.listen();
  const env = {
    DATA_DIR: tempDataDir('store-badkey'),
    SUPABASE_URL: dbUrl,
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key'
  };
  try {
    await withEnv({ ...env, SETTINGS_ENCRYPTION_KEY: KEY }, async () => {
      const { store } = freshServer();
      store.register('hemlig', { file: 'hemlig.json', initial: {}, secrets: ['token'] });
      await store.init();
      store.write('hemlig', { token: 'topphemlig' });
      await store.flushAll();
    });

    await withEnv({ ...env, SETTINGS_ENCRYPTION_KEY: 'fel-nyckel-9876543210-abcdefghijkl' }, async () => {
      const { store } = freshServer();
      store.register('hemlig', { file: 'hemlig.json', initial: {}, secrets: ['token'] });
      const status = await store.init();
      assert.match(status.error, /stämmer inte med nyckeln/);
      assert.equal(status.remote, false);
      // Värdet är kvar (krypterat) – inte raderat
      assert.match(fake.rows.get('hemlig').payload.token, /^enc:v1:/);
    });
  } finally {
    await fake.close();
  }
});

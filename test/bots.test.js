/**
 * Botarna: skapas, uppdateras och överlever en omstart (sparas i samma
 * externa databas som Google-inloggningen).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshServer, withEnv, tempDataDir } = require('./helpers/env');
const { createFakeSupabase } = require('./helpers/fake-supabase');

const CRYPTO_KEY = 'test-krypteringsnyckel-abcdefghijklmnopqrstuvwxyz';
const BOTS_DOC = { file: 'bots.json', initial: [], secrets: [] };

test('botar sparas i databasen och finns kvar efter omstart', async () => {
  const fake = createFakeSupabase();
  const dbUrl = await fake.listen();
  const env = {
    RENDER: 'true',
    SUPABASE_URL: dbUrl,
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    SETTINGS_ENCRYPTION_KEY: CRYPTO_KEY,
    APP_API_KEY: 'api-nyckel'
  };
  try {
    // --- Första instansen: skapa och ändra en bot ---
    await withEnv({ ...env, DATA_DIR: tempDataDir('bots-first') }, async () => {
      const { settings, bots, store } = freshServer();
      await settings.init();
      const created = bots.create({
        name: 'Morgonrapport',
        emoji: '📊',
        instructions: 'Sammanfatta gårdagens försäljning och mejla mig.',
        schedule: { type: 'daily', time: '07:30' }
      });
      assert.match(created.id, /^bot_/);
      assert.equal(bots.list().length, 1);

      bots.update(created.id, {
        name: 'Kvällsrapport',
        enabled: false,
        schedule: { type: 'weekly', weekday: 5, time: '17:00' }
      });
      await store.flushAll();

      const stored = fake.rows.get('bots').payload;
      assert.equal(stored.length, 1);
      assert.equal(stored[0].name, 'Kvällsrapport');
      assert.equal(stored[0].enabled, false);
      assert.equal(stored[0].schedule.type, 'weekly');
      assert.equal(stored[0].schedule.time, '17:00');
      assert.ok('runs' in stored[0], 'körloggen ska följa med i lagringen');
      assert.ok('memory' in stored[0], 'botens minne ska följa med i lagringen');
    });

    // --- Omstart med tom disk: boten ska vara kvar ---
    await withEnv({ ...env, DATA_DIR: tempDataDir('bots-restart') }, async () => {
      const { settings, bots, store } = freshServer();
      await settings.init();
      const list = bots.list();
      assert.equal(list.length, 1, 'boten ska finnas kvar efter omstart');
      assert.equal(list[0].name, 'Kvällsrapport');
      assert.equal(list[0].enabled, false);
      assert.equal(list[0].schedule.type, 'weekly');
      assert.equal(list[0].schedule.weekday, 5);
      assert.match(list[0].instructions, /gårdagens försäljning/);

      // Radering sparas också
      assert.equal(bots.remove(list[0].id), true);
      assert.equal(bots.remove('bot_finns_inte'), false);
      await store.flushAll();
    });

    // --- Tredje instansen: tomt igen ---
    await withEnv({ ...env, DATA_DIR: tempDataDir('bots-restart2') }, async () => {
      const { store } = freshServer();
      store.register('bots', BOTS_DOC);
      await store.init();
      assert.deepEqual(store.read('bots'), []);
    });
  } finally {
    await fake.close();
  }
});

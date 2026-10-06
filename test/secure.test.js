/**
 * Kryptering (server/secure.js): AES-256-GCM, nyckelhantering, punkt-sökvägar
 * och att inget data förstörs när nyckeln inte stämmer.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshServer, withEnv } = require('./helpers/env');

const KEY = 'test-krypteringsnyckel-abcdefghijklmnopqrstuvwxyz';

test('krypterar och dekrypterar ett värde', () => {
  withEnv({ SETTINGS_ENCRYPTION_KEY: KEY }, () => {
    const { secure } = freshServer();
    const encrypted = secure.encrypt('hemlig-token-123');
    assert.match(encrypted, /^enc:v1:[0-9a-f]{8}:/);
    assert.notEqual(encrypted, 'hemlig-token-123');
    assert.equal(secure.decrypt(encrypted), 'hemlig-token-123');
    assert.equal(secure.isEncrypted(encrypted), true);
    assert.equal(secure.isBroken(encrypted), false);
  });
});

test('kryptering är avstängd utan nyckel och lämnar värden orörda', () => {
  withEnv({ SETTINGS_ENCRYPTION_KEY: undefined, AGENT_FLOW_ENCRYPTION_KEY: undefined, ENCRYPTION_KEY: undefined }, () => {
    const { secure } = freshServer();
    assert.equal(secure.enabled(), false);
    assert.equal(secure.encrypt('oförändrad'), 'oförändrad');
    const doc = secure.protectDoc('settings', { shopify: { token: 'shpat_123' } });
    assert.equal(doc.shopify.token, 'shpat_123');
  });
});

test('samma värde ger olika chiffertext (slumpad IV) och dubbelkrypteras inte', () => {
  withEnv({ SETTINGS_ENCRYPTION_KEY: KEY }, () => {
    const { secure } = freshServer();
    const a = secure.encrypt('samma-hemlighet');
    const b = secure.encrypt('samma-hemlighet');
    assert.notEqual(a, b);
    assert.equal(secure.decrypt(a), secure.decrypt(b));
    assert.equal(secure.encrypt(a), a, 'redan krypterat värde ska lämnas orört');
  });
});

test('fel nyckel kastar fel och rapporteras som trasigt (isBroken)', () => {
  const encrypted = withEnv({ SETTINGS_ENCRYPTION_KEY: KEY }, () => {
    const { secure } = freshServer();
    return secure.encrypt('refresh-token-abc');
  });

  withEnv({ SETTINGS_ENCRYPTION_KEY: 'en-helt-annan-nyckel-1234567890' }, () => {
    const { secure } = freshServer();
    assert.throws(() => secure.decrypt(encrypted), /stämmer inte med nyckeln/);
    assert.equal(secure.isBroken(encrypted), true);
    assert.equal(secure.decrypt('okrypterat-värde'), 'okrypterat-värde', 'okrypterad data ska passera');
  });
});

test('manipulerad chiffertext upptäcks (GCM-taggen)', () => {
  withEnv({ SETTINGS_ENCRYPTION_KEY: KEY }, () => {
    const { secure } = freshServer();
    const encrypted = secure.encrypt('hemlig');
    const tampered = encrypted.slice(0, -4) + 'AAAA';
    assert.throws(() => secure.decrypt(tampered), /Kunde inte dekryptera/);
    assert.equal(secure.isBroken(tampered), true);
  });
});

test('protectDoc/unprotectDoc krypterar rätt fält – även providers.*.apiKey', () => {
  withEnv({ SETTINGS_ENCRYPTION_KEY: KEY }, () => {
    const { secure } = freshServer();
    const doc = {
      shopify: { store: 'minbutik', token: 'shpat_hemlig' },
      providers: { openai: { apiKey: 'sk-hemlig' }, anthropic: { apiKey: 'ant-hemlig', baseUrl: 'https://x' } },
      google: { clientId: 'id.apps.googleusercontent.com', clientSecret: 'GOCSPX-hemlig', refreshToken: '1//hemlig', email: 'a@b.se' },
      allowDestructive: false
    };
    const protectedDoc = secure.protectDoc('settings', doc);
    assert.ok(secure.isEncrypted(protectedDoc.shopify.token));
    assert.ok(secure.isEncrypted(protectedDoc.providers.openai.apiKey));
    assert.ok(secure.isEncrypted(protectedDoc.providers.anthropic.apiKey));
    assert.ok(secure.isEncrypted(protectedDoc.google.clientSecret));
    assert.ok(secure.isEncrypted(protectedDoc.google.refreshToken));
    // Icke-hemliga fält är orörda
    assert.equal(protectedDoc.shopify.store, 'minbutik');
    assert.equal(protectedDoc.providers.anthropic.baseUrl, 'https://x');
    assert.equal(protectedDoc.google.email, 'a@b.se');
    assert.equal(protectedDoc.google.clientId, 'id.apps.googleusercontent.com');
    assert.equal(protectedDoc.allowDestructive, false);

    const { value, errors } = secure.unprotectDoc('settings', protectedDoc);
    assert.deepEqual(errors, []);
    assert.deepEqual(value, doc);
  });
});

test('unprotectDoc behåller krypterad data när nyckeln inte stämmer (raderar inget)', () => {
  const protectedDoc = withEnv({ SETTINGS_ENCRYPTION_KEY: KEY }, () => {
    const { secure } = freshServer();
    return secure.protectDoc('settings', { google: { refreshToken: '1//hemlig' }, shopify: { token: 'shpat_x' } });
  });

  withEnv({ SETTINGS_ENCRYPTION_KEY: 'fel-nyckel-1234567890-abcdefghijkl' }, () => {
    const { secure } = freshServer();
    const { value, errors } = secure.unprotectDoc('settings', protectedDoc);
    assert.equal(errors.length, 2);
    assert.equal(value.google.refreshToken, protectedDoc.google.refreshToken, 'krypterat värde ska behållas');
    const roundTrip = secure.protectDoc('settings', value);
    assert.equal(roundTrip.google.refreshToken, protectedDoc.google.refreshToken, 'skrivs tillbaka oförändrat');
  });
});

test('signerar och verifierar (används för OAuth-state)', () => {
  withEnv({ SETTINGS_ENCRYPTION_KEY: KEY }, () => {
    const { secure } = freshServer();
    const sig = secure.sign('nonce.123');
    assert.ok(sig.length > 20);
    assert.equal(secure.verify('nonce.123', sig), true);
    assert.equal(secure.verify('nonce.124', sig), false);
    assert.equal(secure.verify('nonce.123', 'fel'), false);
  });
});

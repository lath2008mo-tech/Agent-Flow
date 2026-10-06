/**
 * API-skyddet (server/auth.js): 401 utan nyckel, godkända nycklar, publika
 * undantag och skydd mot brute force. Testas genom en riktig Express-server.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { freshServer, withEnv, waitFor } = require('./helpers/env');

async function startApi(env) {
  const app = express();
  app.use(express.json());
  const { auth } = freshServer();
  app.use(auth.middleware());
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get('/api/auth/status', (req, res) => res.json(auth.publicStatus(req)));
  app.get('/api/settings', (req, res) => res.json({ secret: 'inställningar' }));
  app.post('/api/google/auth-url', (req, res) => res.json({ url: 'https://accounts.google.com/x' }));
  app.get('/api/google/auth', (req, res) => res.redirect('https://accounts.google.com/x'));
  app.get('/api/google/callback', (req, res) => res.json({ ok: true }));
  app.get('/app', (req, res) => res.send('app'));
  const server = app.listen(0, '127.0.0.1');
  await waitFor(() => server.listening, { label: 'servern startade' });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

test('utan APP_API_KEY är API:t öppet (lokal körning)', async () => {
  await withEnv({ APP_API_KEY: undefined, AGENT_FLOW_API_KEY: undefined, APP_PASSWORD: undefined }, async () => {
    const api = await startApi();
    try {
      assert.equal((await fetch(`${api.base}/api/settings`)).status, 200);
      const status = await (await fetch(`${api.base}/api/auth/status`)).json();
      assert.equal(status.required, false);
      assert.equal(status.unlocked, true);
    } finally {
      await api.close();
    }
  });
});

test('med APP_API_KEY krävs nyckeln – i x-api-key eller Authorization: Bearer', async () => {
  await withEnv({ APP_API_KEY: 'hemlig-nyckel-1', AGENT_FLOW_API_KEY: undefined, APP_PASSWORD: undefined }, async () => {
    const api = await startApi();
    try {
      // Publika endpoints
      assert.equal((await fetch(`${api.base}/api/health`)).status, 200);
      assert.equal((await fetch(`${api.base}/api/google/callback?code=x`)).status, 200, 'OAuth-callbacken måste vara publik');
      assert.equal((await fetch(`${api.base}/app`)).status, 200, 'frontend ska serveras');

      const unauth = await fetch(`${api.base}/api/settings`);
      assert.equal(unauth.status, 401);
      assert.match((await unauth.json()).error, /skyddat/);

      assert.equal((await fetch(`${api.base}/api/settings`, { headers: { 'x-api-key': 'hemlig-nyckel-1' } })).status, 200);
      assert.equal((await fetch(`${api.base}/api/settings`, { headers: { Authorization: 'Bearer hemlig-nyckel-1' } })).status, 200);
      assert.equal((await fetch(`${api.base}/api/settings`, { headers: { 'x-api-key': 'fel' } })).status, 401);

      // Status-endpointen berättar att nyckel krävs, utan att läcka den
      const status = await (await fetch(`${api.base}/api/auth/status`)).json();
      assert.equal(status.required, true);
      assert.equal(status.unlocked, false);
      assert.equal(status.keyVar, 'APP_API_KEY');
      assert.equal(JSON.stringify(status).includes('hemlig-nyckel-1'), false);
    } finally {
      await api.close();
    }
  });
});

test('flera nycklar separerade med komma fungerar (rotation)', async () => {
  await withEnv({ APP_API_KEY: 'gammal-nyckel, ny-nyckel', AGENT_FLOW_API_KEY: undefined, APP_PASSWORD: undefined }, async () => {
    const api = await startApi();
    try {
      assert.equal((await fetch(`${api.base}/api/settings`, { headers: { 'x-api-key': 'gammal-nyckel' } })).status, 200);
      assert.equal((await fetch(`${api.base}/api/settings`, { headers: { 'x-api-key': 'ny-nyckel' } })).status, 200);
      assert.equal((await fetch(`${api.base}/api/settings`, { headers: { 'x-api-key': 'ny-nyckel ' } })).status, 200);
    } finally {
      await api.close();
    }
  });
});

test('brute force bromsas efter 12 felaktiga försök', async () => {
  await withEnv({ APP_API_KEY: 'rätt-nyckel', AGENT_FLOW_API_KEY: undefined, APP_PASSWORD: undefined }, async () => {
    const api = await startApi();
    try {
      for (let i = 0; i < 12; i += 1) {
        const res = await fetch(`${api.base}/api/settings`, { headers: { 'x-api-key': 'fel-nyckel' } });
        assert.equal(res.status, 401);
      }
      const blocked = await fetch(`${api.base}/api/settings`, { headers: { 'x-api-key': 'fel-nyckel' } });
      assert.equal(blocked.status, 429);
      // Även rätt nyckel bromsas medan spärren är aktiv
      assert.equal((await fetch(`${api.base}/api/settings`, { headers: { 'x-api-key': 'rätt-nyckel' } })).status, 429);
    } finally {
      await api.close();
    }
  });
});

test('Google-inloggning via webbläsaren visar begripligt fel i stället för rå 401', async () => {
  await withEnv({ APP_API_KEY: 'nyckel', AGENT_FLOW_API_KEY: undefined, APP_PASSWORD: undefined }, async () => {
    const api = await startApi();
    try {
      const res = await fetch(`${api.base}/api/google/auth`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      const location = res.headers.get('location');
      assert.match(location, /^\/app#\/integrationer\?google_error=/);
      assert.match(decodeURIComponent(location), /APP_API_KEY/);
    } finally {
      await api.close();
    }
  });
});

test('DISABLE_API_AUTH kan stänga av skyddet medvetet', async () => {
  await withEnv({ APP_API_KEY: 'nyckel', DISABLE_API_AUTH: 'true' }, async () => {
    const api = await startApi();
    try {
      assert.equal((await fetch(`${api.base}/api/settings`)).status, 200);
    } finally {
      await api.close();
    }
  });
});

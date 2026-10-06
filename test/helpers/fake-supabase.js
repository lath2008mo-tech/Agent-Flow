/**
 * Fejkad Supabase/PostgREST för testerna.
 * Implementerar de anrop store.js gör: GET ?id=eq.<id>&select=... och
 * POST ?on_conflict=id med Prefer: resolution=merge-duplicates.
 */
const http = require('http');

function createFakeSupabase({ apiKey = 'test-service-role-key', requireUpdatedAt = true, port = 0 } = {}) {
  const rows = new Map();     // id -> { payload, updated_at }
  const requests = [];        // logg över anrop
  let failPosts = 0;          // antal kommande POST som ska ge 500

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };

    const auth = req.headers.apikey || String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (auth !== apiKey) return json(401, { message: 'Invalid API key' });

    if (!url.pathname.startsWith('/rest/v1/')) return json(404, { message: 'Not found' });

    if (req.method === 'GET') {
      const idFilter = url.searchParams.get('id');
      const wanted = idFilter && idFilter.startsWith('eq.') ? idFilter.slice(3) : null;
      const select = url.searchParams.get('select') || 'id,payload,updated_at';
      if (select.includes('updated_at') && !requireUpdatedAt) return json(400, { message: 'column does not exist' });
      const out = [...rows.entries()]
        .filter(([id]) => !wanted || id === wanted)
        .map(([id, row]) => {
          const item = {};
          if (select.includes('id')) item.id = id;
          if (select.includes('payload')) item.payload = row.payload;
          if (select.includes('updated_at') && row.updated_at) item.updated_at = row.updated_at;
          return item;
        });
      return json(200, out);
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (failPosts > 0) {
          failPosts -= 1;
          return json(500, { message: 'simulerat databasfel' });
        }
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = null; }
        const incoming = Array.isArray(parsed) ? parsed : [parsed];
        for (const row of incoming) {
          if (!row || !row.id) continue;
          rows.set(row.id, { payload: row.payload, updated_at: row.updated_at || new Date().toISOString() });
        }
        const wantReturn = String(req.headers.prefer || '').includes('return=representation');
        json(201, wantReturn ? incoming.map((r) => ({ id: r.id, updated_at: rows.get(r.id).updated_at })) : undefined);
      });
      return;
    }

    return json(405, { message: 'Method not allowed' });
  });

  return {
    rows,
    requests,
    failNextPosts(n = 1) { failPosts = n; },
    async listen() {
      await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
      this.url = `http://127.0.0.1:${server.address().port}`;
      return this.url;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
    /** Allt som sparats, rå JSON (för att kunna leta efter läckta hemligheter). */
    raw() { return JSON.stringify([...rows.entries()], null, 2); }
  };
}

module.exports = { createFakeSupabase };

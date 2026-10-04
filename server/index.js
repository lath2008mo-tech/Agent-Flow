/**
 * Agent Flow – server
 * Express-app som servar frontend + API: inställningar, Shopify-koppling,
 * AI-modeller och chatt med verktyg (tool-calling) över SSE.
 */
const express = require('express');
const path = require('path');
const settings = require('./settings');
const providers = require('./providers');
const shopify = require('./shopify');
const google = require('./google');
const bots = require('./bots');
const agent = require('./agent');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Appen ligger på /app, hemsidan på /
const sendApp = (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'app.html'));
app.get('/app', sendApp);
app.get('/app/*', sendApp);

const MAX_HISTORY = 30;

// ---------- Inställningar ----------

app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'Agent Flow', time: new Date().toISOString() });
});

app.get('/api/settings', (req, res) => {
  res.json(settings.publicView());
});

app.put('/api/settings', (req, res) => {
  try {
    settings.update(req.body || {});
    res.json(settings.publicView());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- AI-leverantörer & modeller ----------

app.get('/api/providers', (req, res) => {
  const s = settings.load();
  res.json({
    providers: providers.PROVIDERS.map((p) => ({
      id: p.id,
      name: p.name,
      emoji: p.emoji,
      hint: p.hint,
      keyUrl: p.keyUrl,
      hasKey: providers.hasKey(s, p.id),
      baseUrl: (s.providers[p.id] && s.providers[p.id].baseUrl) || p.baseUrl
    })),
    defaultProvider: s.defaultProvider,
    defaultModel: s.defaultModel
  });
});

app.get('/api/models', async (req, res) => {
  const s = settings.load();
  const providerId = req.query.provider;
  try {
    if (providerId) {
      const result = await providers.listModels(s, providerId);
      return res.json(result);
    }
    const results = await Promise.all(
      providers.PROVIDERS.map(async (p) => {
        const r = await providers.listModels(s, p.id);
        return {
          provider: p.id,
          name: p.name,
          emoji: p.emoji,
          hasKey: providers.hasKey(s, p.id),
          models: r.models,
          source: r.source,
          needsKey: r.needsKey || false
        };
      })
    );
    res.json({ providers: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/providers/test', async (req, res) => {
  const s = settings.load();
  const { providerId } = req.body || {};
  try {
    const result = await providers.listModels(s, providerId);
    if (result.needsKey) {
      return res.json({ ok: false, message: `Ingen nyckel tillagd för ${providers.byId[providerId]?.name || providerId} ännu.` });
    }
    res.json({ ok: true, message: `✓ ${providers.byId[providerId]?.name || providerId} fungerar – ${result.models.length} modeller hittade.`, models: result.models.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Shopify ----------

app.post('/api/shopify/test', async (req, res) => {
  const s = settings.load();
  try {
    const d = await shopify.shopifyRequest(s, 'GET', 'shop.json');
    const shop = d.shop || {};
    res.json({
      ok: true,
      message: `✓ Kopplad till ${shop.name} (${shop.myshopify_domain || shop.domain})`,
      shop: {
        name: shop.name,
        domain: shop.myshopify_domain || shop.domain,
        currency: shop.currency,
        money_format: shop.money_format,
        primary_locale: shop.primary_locale,
        plan_name: shop.plan_name,
        email: shop.email
      }
    });
  } catch (err) {
    res.status(err.status && err.status < 500 ? err.status : 500).json({ ok: false, error: err.message });
  }
});

app.get('/api/shopify/overview', async (req, res) => {
  const s = settings.load();
  if (!s.shopify.store || !s.shopify.token) {
    return res.json({ connected: false });
  }
  try {
    const [shopD, stats] = await Promise.all([
      shopify.shopifyRequest(s, 'GET', 'shop.json'),
      shopify.runTool('shop_stats', { days: 30 }, { settings: s })
    ]);
    res.json({ connected: true, shop: shopD.shop, stats });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

// ---------- Google ("Logga in med Google") ----------

app.get('/api/google/status', (req, res) => {
  res.json({ ...google.status(), redirectUri: google.redirectUri(req) });
});

app.get('/api/google/auth', (req, res) => {
  try {
    res.redirect(google.authUrl(req));
  } catch (err) {
    res.redirect(`/app#/integrationer?google_error=${encodeURIComponent(err.message)}`);
  }
});

app.get('/api/google/callback', async (req, res) => {
  try {
    const profile = await google.handleCallback(req);
    res.redirect(`/app#/integrationer?google=ok&email=${encodeURIComponent(profile.email || '')}`);
  } catch (err) {
    res.redirect(`/app#/integrationer?google_error=${encodeURIComponent(err.message)}`);
  }
});

app.post('/api/google/disconnect', (req, res) => {
  google.disconnect();
  res.json({ ok: true });
});

app.post('/api/google/test', async (req, res) => {
  try {
    const me = await google.gapi('GET', 'https://www.googleapis.com/oauth2/v3/userinfo');
    res.json({ ok: true, message: `✓ Inloggad som ${me.email}`, email: me.email });
  } catch (err) {
    res.status(err.status && err.status < 500 ? err.status : 500).json({ ok: false, error: err.message });
  }
});

// ---------- Botar ----------

app.get('/api/bots', (req, res) => {
  res.json({ bots: bots.list(), templates: bots.TEMPLATES });
});

app.post('/api/bots', (req, res) => {
  try {
    const b = bots.create(req.body || {});
    res.json({ ok: true, bot: b });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/bots/:id', (req, res) => {
  const b = bots.get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Boten finns inte.' });
  res.json({ bot: { ...b, nextRun: bots.nextRunAt(b) } });
});

app.put('/api/bots/:id', (req, res) => {
  const b = bots.update(req.params.id, req.body || {});
  if (!b) return res.status(404).json({ error: 'Boten finns inte.' });
  res.json({ ok: true, bot: b });
});

app.delete('/api/bots/:id', (req, res) => {
  res.json({ ok: bots.remove(req.params.id) });
});

app.post('/api/bots/:id/run', async (req, res) => {
  try {
    const run = await bots.run(req.params.id, { trigger: 'manuell', input: (req.body && req.body.input) || '' });
    res.json({ ok: run.status === 'ok', run });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

/** Låt AI:n skriva ett bot-förslag utifrån en fri beskrivning. */
app.post('/api/bots/draft', async (req, res) => {
  try {
    const s = settings.load();
    const { description, providerId, model } = req.body || {};
    if (!description) return res.status(400).json({ error: 'Beskriv vad boten ska göra.' });
    const prompt = [
      'Du designar en automatisk workflow-bot i Agent Flow. Boten har verktyg för Shopify, Gmail, Google Kalender, Drive, Sheets, Docs, Tasks, Kontakter, webbsök och fetch_url.',
      'Svara ENBART med JSON (ingen markdown) med fälten: name (kort), emoji (en), instructions (detaljerad steg-för-steg-instruktion i imperativ på användarens språk, nämn att boten ska använda sitt minne för att inte upprepa sig), schedule {type: manual|interval|daily|weekly, everyMinutes?, time? ("HH:MM"), weekday? (0-6, 1=måndag)}.',
      'Välj schema utifrån beskrivningen ("varje morgon" → daily 07:30, "varje timme" → interval 60, "varje måndag" → weekly 1 08:00, annars manual).',
      '',
      `Användarens beskrivning: ${description}`
    ].join('\n');
    const step = await providers.streamChatOnce({ settings: s, providerId, model, messages: [{ role: 'user', content: prompt }], tools: [] }, null);
    const txt = String(step.content || '').trim();
    const m = /\{[\s\S]*\}/.exec(txt);
    if (!m) throw new Error('AI:n gav inget giltigt förslag. Försök igen.');
    const draft = JSON.parse(m[0]);
    res.json({ ok: true, draft });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Chatt med AI + verktyg ----------

function handleSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  return {
    send(event, data) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      res.end();
    }
  };
}

app.post('/api/chat', async (req, res) => {
  const sse = handleSSE(res);
  const abort = new AbortController();
  let clientGone = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      abort.abort();
    }
  });

  try {
    const s = settings.load();
    const { providerId, model, messages } = req.body || {};

    if (!model || !Array.isArray(messages) || messages.length === 0) {
      sse.send('error', { message: 'Saknar modell eller meddelanden.' });
      return sse.close();
    }

    const history = messages
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-MAX_HISTORY)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 6000) }));

    sse.send('meta', { provider: providerId, model });

    const result = await agent.runAgent(
      { settings: s, providerId, model, messages: history, mode: 'chat', extraTools: bots.TOOLS, signal: abort.signal },
      {
        onDelta: (text) => sse.send('delta', { text }),
        onToolStart: (t) => sse.send('tool_start', t),
        onToolEnd: (t) => sse.send('tool_end', t)
      }
    );
    sse.send('done', { finishReason: result.finishReason, steps: result.steps });
    sse.close();
  } catch (err) {
    if (clientGone) return;
    try {
      sse.send('error', { message: err.message || 'Något gick fel.' });
      sse.close();
    } catch { /* redan stängd */ }
  }
});

// Fallback: hemsidan
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Agent Flow körs på http://0.0.0.0:${PORT}`);
  bots.startScheduler();
});

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

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const MAX_TOOL_STEPS = 8;
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

// ---------- Chatt med AI + verktyg ----------

function buildSystemPrompt(s) {
  const lines = [
    'Du är Agent Flow – en AI-assistent som hjälper användaren att sköta sin Shopify-butik.',
    'Du har verktyg för att läsa och ändra butiken: produkter, ordrar, kunder, kollektioner, lager, rabatter och statistik.',
    'Regler:',
    '- Använd verktygen för att hämta RIKTIGA data innan du svarar om butiken. Gissa aldrig siffror.',
    '- Svara på det språk användaren skriver på (svenska om de skriver svenska).',
    '- Var kort, tydlig och handlingsorienterad. Ge gärna konkreta nästa steg.',
    '- Vid ändringar: sammanfatta kort vad du gjorde. Vid destruktiva åtgärder (raderingar): var extra tydlig.',
    '- Om du är osäker på något viktigt, fråga användaren först.',
    '- Om Shopify-verktygen felar med att butiken inte är ansluten – be användaren koppla butiken under "Integrationer".'
  ];
  if (s.shopify.store) {
    lines.push(`Butik: ${shopify.normalizeStore(s.shopify.store)}`);
  } else {
    lines.push('OBS: Ingen Shopify-butik är ansluten ännu.');
  }
  return lines.join('\n');
}

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
  // Obs: res 'close' utan att writableEnded betyder att klienten kopplade ner
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

    // Bygg konversation: system + kort historik (endast text)
    const history = messages
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-MAX_HISTORY)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 6000) }));

    const convo = [{ role: 'system', content: buildSystemPrompt(s) }, ...history];
    sse.send('meta', { provider: providerId, model });

    const ctx = { settings: s };
    let steps = 0;

    while (steps < MAX_TOOL_STEPS) {
      steps++;
      const step = await providers.streamChatOnce(
        { settings: s, providerId, model, messages: convo, tools: shopify.TOOLS, signal: abort.signal },
        (text) => sse.send('delta', { text })
      );

      convo.push(step.assistantMessage);

      if (!step.toolCalls.length) {
        sse.send('done', { finishReason: step.finishReason || 'stop', steps });
        return sse.close();
      }

      for (const tc of step.toolCalls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }
        sse.send('tool_start', { id: tc.id, name: tc.function.name, args });
        const result = await shopify.runTool(tc.function.name, args, ctx);
        const resultStr = JSON.stringify(result);
        sse.send('tool_end', {
          id: tc.id,
          name: tc.function.name,
          ok: !(result && result.error),
          summary: resultStr.slice(0, 2000)
        });
        convo.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content: resultStr.slice(0, 8000)
        });
      }
    }

    sse.send('done', { finishReason: 'max_steps', steps });
    sse.close();
  } catch (err) {
    if (clientGone) return;
    try {
      sse.send('error', { message: err.message || 'Något gick fel.' });
      sse.close();
    } catch { /* redan stängd */ }
  }
});

// SPA-fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Agent Flow körs på http://0.0.0.0:${PORT}`);
});

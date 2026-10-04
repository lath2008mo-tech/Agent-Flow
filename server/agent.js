/**
 * Agent Flow – agentmotorn.
 * Samlar ALLA verktyg (Shopify, Google, webb, botar) och kör
 * "tänk → anropa verktyg → tänk igen"-loopen. Används både av chatten
 * (strömmande) och av workflow-botarna (i bakgrunden).
 */
const providers = require('./providers');
const shopify = require('./shopify');
const google = require('./google');

const MAX_TOOL_STEPS = 12;

// ---------- Allmänna verktyg (fungerar alltid) ----------

const GENERAL_TOOLS = [
  {
    name: 'get_current_time',
    description: 'Hämta aktuellt datum och tid (svensk tid) – använd innan du räknar på datum, bokar möten eller söker "idag/igår".',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const now = new Date();
      return {
        iso: now.toISOString(),
        stockholm: now.toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' }),
        weekday: now.toLocaleDateString('sv-SE', { weekday: 'long', timeZone: 'Europe/Stockholm' })
      };
    }
  },
  {
    name: 'fetch_url',
    description: 'Hämta innehållet på en webbsida eller ett öppet API (GET). Returnerar ren text/JSON. Använd för att läsa nyheter, priser, dokumentation m.m.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' }, max_chars: { type: 'integer', default: 8000 } },
      required: ['url']
    },
    async execute({ url, max_chars = 8000 }) {
      if (!/^https?:\/\//i.test(url)) return { error: 'Endast http(s)-adresser.' };
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AgentFlow/1.0)', Accept: 'text/html,application/json,text/plain,*/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(20000)
      });
      const ct = res.headers.get('content-type') || '';
      let text = await res.text();
      if (ct.includes('html')) {
        text = text
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/\s+/g, ' ')
          .trim();
      }
      return { status: res.status, content_type: ct, content: text.slice(0, Math.min(max_chars, 20000)) };
    }
  },
  {
    name: 'web_search',
    description: 'Sök på webben (DuckDuckGo). Returnerar titlar, länkar och korta utdrag. Följ upp med fetch_url för att läsa en sida.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    async execute({ query }) {
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AgentFlow/1.0)' },
        signal: AbortSignal.timeout(20000)
      });
      const html = await res.text();
      const results = [];
      const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
      let m;
      while ((m = re.exec(html)) && results.length < 8) {
        let href = m[1];
        const u = /[?&]uddg=([^&]+)/.exec(href);
        if (u) href = decodeURIComponent(u[1]);
        const strip = (x) => String(x || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').trim();
        results.push({ title: strip(m[2]), url: href, snippet: strip(m[3]) });
      }
      return { query, results };
    }
  }
];

// ---------- Verktygsregister ----------

function allTools(extra = []) {
  return [...GENERAL_TOOLS, ...shopify.TOOLS, ...google.TOOLS, ...extra];
}

async function runTool(name, args, ctx, extra = []) {
  const tool = allTools(extra).find((t) => t.name === name);
  if (!tool) return { error: `Okänt verktyg: ${name}` };
  try {
    return await tool.execute(args || {}, ctx);
  } catch (err) {
    return { error: err.message };
  }
}

// ---------- Systemprompt ----------

function buildSystemPrompt(s, { mode = 'chat', bot = null } = {}) {
  const lines = [
    mode === 'bot'
      ? `Du är "${bot.name}" – en automatisk workflow-bot i Agent Flow. Du körs utan att någon sitter och tittar, så slutför uppgiften helt på egen hand med dina verktyg och avsluta med en kort rapport om vad du gjorde.`
      : 'Du är Agent Flow – en AI-agent som gör det användaren ber om. Du är som en personlig assistent som kan allt: sköta Shopify-butiken, läsa och skicka mejl, boka möten, jobba i Sheets/Docs/Drive, söka på webben och bygga automatiska botar.',
    '',
    'Dina verktyg:',
    '- Shopify: produkter, ordrar, kunder, kollektioner, lager, rabatter, statistik.',
    '- Google (via användarens Google-inloggning): Gmail, Kalender, Drive, Sheets, Docs, Tasks, Kontakter.',
    '- Webb: web_search + fetch_url. Tid: get_current_time.',
    '- Botar: create_bot / list_bots / update_bot / run_bot – skapa automatiska arbetsflöden som körs på schema.',
    '',
    'Regler:',
    '- Använd verktygen för att hämta RIKTIG data innan du svarar. Gissa aldrig siffror, mejl eller datum.',
    '- Kedja flera verktyg själv tills uppgiften är klar – fråga inte om lov för varje litet steg.',
    '- Svara på användarens språk (svenska om de skriver svenska). Var kort, tydlig och handlingsorienterad.',
    '- Innan du skickar mejl/bjuder in andra personer i chatten: visa gärna ett utkast först om användaren inte uttryckligen sagt "skicka direkt". I bot-läge: skicka direkt enligt instruktionen.',
    '- När användaren beskriver något som ska ske regelbundet ("varje morgon", "när det kommer…", "varje måndag") – skapa en bot med create_bot.',
    '- Om ett verktyg svarar att Google/Shopify inte är kopplat: be användaren koppla under "Integrationer" (Google = ett klick på "Logga in med Google").'
  ];
  if (s.shopify.store) lines.push(`\nShopify-butik: ${shopify.normalizeStore(s.shopify.store)}`);
  else lines.push('\nOBS: Ingen Shopify-butik ansluten.');
  if (s.google && s.google.refreshToken) lines.push(`Google-konto: ${s.google.email || 'kopplat'}`);
  else lines.push('OBS: Inget Google-konto kopplat ännu (Logga in med Google under Integrationer).');
  lines.push(`Nu: ${new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' })} (Europe/Stockholm)`);
  if (mode === 'bot') {
    lines.push('', 'BOTENS INSTRUKTION:', bot.instructions);
    if (bot.memory) lines.push('', 'MINNE FRÅN TIDIGARE KÖRNINGAR (så du inte gör samma sak två gånger):', String(bot.memory).slice(0, 3000));
    lines.push('', 'Avsluta alltid svaret med en rad som börjar med "MINNE:" följt av det du behöver komma ihåg till nästa körning (t.ex. id:n på mejl du redan hanterat). Skriv "MINNE: -" om inget.');
  }
  return lines.join('\n');
}

// ---------- Agentloop ----------

/**
 * Kör agenten tills den är klar.
 * events: { onDelta(text), onToolStart({id,name,args}), onToolEnd({id,name,ok,summary}), onMeta }
 * Returnerar { text, steps, toolLog, finishReason }.
 */
async function runAgent({ settings: s, providerId, model, messages, mode = 'chat', bot = null, extraTools = [], signal }, events = {}) {
  const tools = allTools(extraTools);
  const convo = [{ role: 'system', content: buildSystemPrompt(s, { mode, bot }) }, ...messages];
  const ctx = { settings: s, providerId, model };
  const toolLog = [];
  let text = '';
  let steps = 0;

  while (steps < MAX_TOOL_STEPS) {
    steps++;
    const step = await providers.streamChatOnce(
      { settings: s, providerId, model, messages: convo, tools, signal },
      (t) => { text += t; if (events.onDelta) events.onDelta(t); }
    );
    convo.push(step.assistantMessage);

    if (!step.toolCalls.length) {
      return { text, steps, toolLog, finishReason: step.finishReason || 'stop' };
    }
    for (const tc of step.toolCalls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }
      if (events.onToolStart) events.onToolStart({ id: tc.id, name: tc.function.name, args });
      const result = await runTool(tc.function.name, args, ctx, extraTools);
      const resultStr = JSON.stringify(result);
      const ok = !(result && result.error);
      toolLog.push({ name: tc.function.name, args, ok, summary: resultStr.slice(0, 500) });
      if (events.onToolEnd) events.onToolEnd({ id: tc.id, name: tc.function.name, ok, summary: resultStr.slice(0, 2000) });
      convo.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: resultStr.slice(0, 8000) });
    }
  }
  return { text, steps, toolLog, finishReason: 'max_steps' };
}

module.exports = { runAgent, allTools, runTool, buildSystemPrompt, GENERAL_TOOLS, MAX_TOOL_STEPS };

/**
 * Agent Flow – AI-leverantörer ("alla AI på ett ställe").
 * Allt går via OpenAI-kompatibelt API: OpenAI, Anthropic, Google Gemini, Groq,
 * DeepSeek, xAI, Mistral, OpenRouter (300+ modeller) och Ollama (lokalt).
 */
const PROVIDERS = [
  {
    id: 'openai',
    name: 'OpenAI',
    emoji: '🟢',
    baseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    hint: 'GPT-5, GPT-4.1, o-serien',
    fallbackModels: ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini']
  },
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    emoji: '🟠',
    baseUrl: 'https://api.anthropic.com/v1',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    hint: 'Claude Opus, Sonnet, Haiku',
    fallbackModels: ['claude-opus-4-1', 'claude-sonnet-4-0', 'claude-3-7-sonnet-latest', 'claude-3-5-haiku-latest']
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    emoji: '🔵',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyUrl: 'https://aistudio.google.com/apikey',
    hint: 'Gemini 2.5 Pro & Flash',
    fallbackModels: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash']
  },
  {
    id: 'groq',
    name: 'Groq',
    emoji: '⚡',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com/keys',
    hint: 'Blixtsnabba öppna modeller',
    fallbackModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b']
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    emoji: '🐋',
    baseUrl: 'https://api.deepseek.com/v1',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    hint: 'DeepSeek Chat & Reasoner',
    fallbackModels: ['deepseek-chat', 'deepseek-reasoner']
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    emoji: '🖤',
    baseUrl: 'https://api.x.ai/v1',
    keyUrl: 'https://console.x.ai',
    hint: 'Grok 4 & Grok 3',
    fallbackModels: ['grok-4', 'grok-3', 'grok-3-mini']
  },
  {
    id: 'mistral',
    name: 'Mistral',
    emoji: '🟣',
    baseUrl: 'https://api.mistral.ai/v1',
    keyUrl: 'https://console.mistral.ai/api-keys',
    hint: 'Mistral Large, Medium, Small',
    fallbackModels: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest', 'open-mistral-nemo']
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    emoji: '🌐',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
    hint: 'ALLA modeller på ett ställe (300+)',
    fallbackModels: ['openai/gpt-4o', 'anthropic/claude-sonnet-4', 'google/gemini-2.5-pro', 'meta-llama/llama-3.3-70b-instruct', 'deepseek/deepseek-chat', 'x-ai/grok-3']
  },
  {
    id: 'ollama',
    name: 'Ollama (lokalt)',
    emoji: '🦙',
    baseUrl: 'http://localhost:11434/v1',
    keyUrl: 'https://ollama.com/download',
    hint: 'Kör modeller på din egen dator',
    fallbackModels: ['llama3.2', 'qwen2.5', 'mistral', 'gemma3']
  }
];

const byId = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));

function resolveProvider(settings, providerId) {
  const def = byId[providerId];
  if (!def) {
    const err = new Error(`Okänd AI-leverantör: ${providerId}`);
    err.status = 400;
    throw err;
  }
  const cfg = settings.providers[providerId] || {};
  return {
    ...def,
    apiKey: cfg.apiKey || '',
    baseUrl: (cfg.baseUrl || def.baseUrl).replace(/\/$/, '')
  };
}

function hasKey(settings, providerId) {
  return Boolean((settings.providers[providerId] || {}).apiKey);
}

/** Hämta modellista från leverantören (med fallback-lista). */
async function listModels(settings, providerId) {
  const p = resolveProvider(settings, providerId);
  if (!p.apiKey && providerId !== 'ollama') {
    return { provider: providerId, models: p.fallbackModels, source: 'fallback', needsKey: true };
  }
  const headers = { Authorization: `Bearer ${p.apiKey || 'ollama'}` };
  if (providerId === 'openrouter') {
    headers['HTTP-Referer'] = 'https://agentflow.app';
    headers['X-Title'] = 'Agent Flow';
  }
  try {
    const res = await fetch(`${p.baseUrl}/models`, { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const models = (data.data || [])
      .map((m) => m.id)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    return { provider: providerId, models: models.length ? models : p.fallbackModels, source: 'api' };
  } catch (err) {
    return { provider: providerId, models: p.fallbackModels, source: 'fallback', error: err.message };
  }
}

function providerError(provider, res, bodyText) {
  let detail = '';
  try {
    const j = JSON.parse(bodyText);
    detail = j.error?.message || j.message || bodyText;
  } catch {
    detail = bodyText;
  }
  detail = String(detail).slice(0, 400);
  let message;
  if (res.status === 401 || res.status === 403) {
    message = `Ogiltig eller saknad API-nyckel för ${provider.name}. Kontrollera nyckeln under "Integrationer".`;
  } else if (res.status === 404) {
    message = `Modellen hittades inte hos ${provider.name}. Välj en annan modell i listan.`;
  } else if (res.status === 429) {
    message = `${provider.name}: rate limit nådd – vänta en stund och försök igen.`;
  } else {
    message = `${provider.name} svarade med fel ${res.status}: ${detail}`;
  }
  const err = new Error(message);
  err.status = res.status;
  err.detail = detail;
  return err;
}

/**
 * Ett steg av chattet: anropa modellen, strömma text-deltas via onDelta.
 * Returnerar { content, toolCalls, finishReason }.
 */
async function streamChatOnce({ settings, providerId, model, messages, tools, signal }, onDelta) {
  const p = resolveProvider(settings, providerId);
  if (!p.apiKey && providerId !== 'ollama') {
    const err = new Error(`Ingen API-nyckel för ${p.name}. Gå till "Integrationer" och lägg till din nyckel.`);
    err.status = 400;
    throw err;
  }

  const url = `${p.baseUrl}/chat/completions`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${p.apiKey || 'ollama'}`
  };
  if (providerId === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  if (providerId === 'openrouter') {
    headers['HTTP-Referer'] = 'https://agentflow.app';
    headers['X-Title'] = 'Agent Flow';
  }

  const body = { model, messages, stream: true };
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }));
  }

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: signal || AbortSignal.timeout(180000)
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    const err = new Error(`Kunde inte ansluta till ${p.name} (${p.baseUrl}): ${e.message}. Kontrollera nyckeln och internetanslutningen.`);
    err.status = 502;
    throw err;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw providerError(p, res, text);
  }

  // --- Strömma SSE ---
  let content = '';
  const toolMap = new Map();
  let finishReason = null;

  const decoder = new TextDecoder();
  let buffer = '';
  const reader = res.body.getReader();

  const handleData = (payload) => {
    if (payload === '[DONE]') return;
    let j;
    try { j = JSON.parse(payload); } catch { return; }
    const choice = j.choices && j.choices[0];
    if (!choice) return;
    const delta = choice.delta || {};
    if (delta.content) {
      content += delta.content;
      if (onDelta) onDelta(delta.content);
    }
    // Anthropic-kompat-läget kan skicka tankeblock – hoppa över rena thinking-deltas
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index != null ? tc.index : 0;
        if (!toolMap.has(idx)) toolMap.set(idx, { id: '', name: '', arguments: '' });
        const acc = toolMap.get(idx);
        if (tc.id) acc.id = tc.id;
        if (tc.function && tc.function.name) acc.name += tc.function.name;
        if (tc.function && tc.function.arguments) acc.arguments += tc.function.arguments;
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue;
      if (trimmed.startsWith('data:')) handleData(trimmed.slice(5).trim());
    }
  }

  const toolCalls = [...toolMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v], i) => ({
      id: v.id || `call_${Date.now()}_${i}`,
      type: 'function',
      function: { name: v.name, arguments: v.arguments || '{}' }
    }))
    .filter((tc) => tc.function.name);

  return {
    content,
    toolCalls,
    finishReason,
    assistantMessage: {
      role: 'assistant',
      content: content || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {})
    }
  };
}

module.exports = { PROVIDERS, byId, resolveProvider, hasKey, listModels, streamChatOnce };

/**
 * Agent Flow – Workflow-botar.
 * En bot = en instruktion på vanlig svenska + ett schema. Boten kör agentmotorn
 * med alla verktyg (Shopify, Google, webb) och sparar en logg per körning.
 *
 * Scheman: manual | interval (var N:e minut) | daily (kl HH:MM) | weekly (veckodag + HH:MM)
 */
const crypto = require('crypto');
const settings = require('./settings');
const providers = require('./providers');
const store = require('./store');

const TZ = 'Europe/Stockholm';
const MAX_RUNS_KEPT = 30;

// Botarna sparas beständigt via store (Supabase eller lokal fil) så att de
// överlever att gratisinsatsen på Render startar om.
// Botarna innehåller inga hemligheter (instruktioner, schema och körloggar).
store.register('bots', { file: 'bots.json', initial: [], secrets: [] });

let bots = null;
const running = new Set();

// ---------- Lagring ----------

function load() {
  if (!bots) {
    const stored = store.read('bots');
    bots = Array.isArray(stored) ? stored : [];
  }
  return bots;
}

function save() {
  store.write('bots', load());
}

function list() {
  return load().map(publicBot);
}

function get(id) {
  return load().find((b) => b.id === id) || null;
}

function publicBot(b) {
  return { ...b, runs: (b.runs || []).slice(0, 10), running: running.has(b.id), nextRun: nextRunAt(b) };
}

function normalizeSchedule(sch = {}) {
  const type = ['manual', 'interval', 'daily', 'weekly'].includes(sch.type) ? sch.type : 'manual';
  const out = { type };
  if (type === 'interval') out.everyMinutes = Math.max(5, Math.min(7 * 24 * 60, parseInt(sch.everyMinutes, 10) || 60));
  if (type === 'daily' || type === 'weekly') out.time = /^\d{1,2}:\d{2}$/.test(sch.time || '') ? sch.time.padStart(5, '0') : '08:00';
  if (type === 'weekly') out.weekday = Math.max(0, Math.min(6, parseInt(sch.weekday, 10) || 1)); // 0=sön, 1=mån
  return out;
}

function create(data) {
  const s = settings.load();
  const b = {
    id: 'bot_' + crypto.randomBytes(6).toString('hex'),
    name: String(data.name || 'Ny bot').trim().slice(0, 80),
    emoji: String(data.emoji || '🤖').slice(0, 4),
    instructions: String(data.instructions || '').trim().slice(0, 8000),
    schedule: normalizeSchedule(data.schedule),
    providerId: data.providerId || s.defaultProvider,
    model: data.model || s.defaultModel || '',
    enabled: data.enabled !== false,
    createdAt: new Date().toISOString(),
    lastRunAt: null,
    memory: '',
    runs: []
  };
  load().unshift(b);
  save();
  return b;
}

function update(id, patch) {
  const b = get(id);
  if (!b) return null;
  if (typeof patch.name === 'string') b.name = patch.name.trim().slice(0, 80);
  if (typeof patch.emoji === 'string') b.emoji = patch.emoji.slice(0, 4);
  if (typeof patch.instructions === 'string') b.instructions = patch.instructions.trim().slice(0, 8000);
  if (patch.schedule) b.schedule = normalizeSchedule(patch.schedule);
  if (typeof patch.providerId === 'string') b.providerId = patch.providerId;
  if (typeof patch.model === 'string') b.model = patch.model;
  if (typeof patch.enabled === 'boolean') b.enabled = patch.enabled;
  if (patch.memory === null) b.memory = '';
  save();
  return b;
}

function remove(id) {
  const arr = load();
  const i = arr.findIndex((b) => b.id === id);
  if (i < 0) return false;
  arr.splice(i, 1);
  save();
  return true;
}

// ---------- Schemaläggning ----------

function stockholmParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const wd = { sön: 0, mån: 1, tis: 2, ons: 3, tor: 4, fre: 5, lör: 6 }[parts.weekday.replace('.', '')] ?? 1;
  return { hhmm: `${parts.hour}:${parts.minute}`, weekday: wd, dayKey: new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(date) };
}

function isDue(b, now = new Date()) {
  if (!b.enabled || running.has(b.id)) return false;
  const sch = b.schedule || { type: 'manual' };
  const last = b.lastRunAt ? new Date(b.lastRunAt) : null;
  if (sch.type === 'interval') {
    return !last || now - last >= sch.everyMinutes * 60000;
  }
  if (sch.type === 'daily' || sch.type === 'weekly') {
    const p = stockholmParts(now);
    if (p.hhmm < sch.time) return false;
    if (sch.type === 'weekly' && p.weekday !== sch.weekday) return false;
    // Redan körd idag?
    if (last && stockholmParts(last).dayKey === p.dayKey) return false;
    return true;
  }
  return false;
}

function nextRunAt(b) {
  const sch = b.schedule || {};
  if (!b.enabled) return null;
  if (sch.type === 'interval') {
    const base = b.lastRunAt ? new Date(b.lastRunAt).getTime() : Date.now();
    return new Date(Math.max(Date.now(), base + sch.everyMinutes * 60000)).toISOString();
  }
  if (sch.type === 'daily' || sch.type === 'weekly') return `${sch.type === 'weekly' ? ['sön', 'mån', 'tis', 'ons', 'tor', 'fre', 'lör'][sch.weekday] + ' ' : 'dagligen '}kl ${sch.time}`;
  return null;
}

async function tick() {
  for (const b of load()) {
    if (isDue(b)) {
      run(b.id, { trigger: 'schema' }).catch((e) => console.error('[bots] körning misslyckades:', e.message));
    }
  }
}

let timer = null;
function startScheduler() {
  if (timer) return;
  timer = setInterval(() => tick().catch(() => {}), 60 * 1000);
  setTimeout(() => tick().catch(() => {}), 5000);
  console.log('[bots] Schemaläggare startad (kollar varje minut).');
}

// ---------- Körning ----------

function usable(s, id) {
  return id === 'ollama' || providers.hasKey(s, id);
}

function pickModel(s, b) {
  // Botens modell → standardmodell → första leverantör med nyckel
  if (b.providerId && b.model && usable(s, b.providerId)) return { providerId: b.providerId, model: b.model };
  if (s.defaultProvider && s.defaultModel && usable(s, s.defaultProvider)) return { providerId: s.defaultProvider, model: s.defaultModel };
  const p = providers.PROVIDERS.find((x) => providers.hasKey(s, x.id));
  if (p) return { providerId: p.id, model: (b.providerId === p.id && b.model) || p.fallbackModels[0] };
  return null;
}

async function run(id, { trigger = 'manuell', input = '' } = {}) {
  const agent = require('./agent'); // lazy – undvik cirkulärt beroende
  const b = get(id);
  if (!b) throw new Error('Boten finns inte.');
  if (running.has(id)) throw new Error('Boten körs redan.');
  running.add(id);

  const s = settings.load();
  const started = new Date();
  const runRec = { id: 'run_' + crypto.randomBytes(4).toString('hex'), startedAt: started.toISOString(), trigger, status: 'running', tools: [], output: '', error: null };
  b.runs = [runRec, ...(b.runs || [])].slice(0, MAX_RUNS_KEPT);
  b.lastRunAt = started.toISOString();
  save();

  try {
    const pm = pickModel(s, b);
    if (!pm) throw new Error('Ingen AI-nyckel finns. Lägg till en under Integrationer.');
    runRec.model = `${pm.providerId}/${pm.model}`;

    const userMsg = input
      ? `Kör nu. Extra information från användaren: ${input}`
      : `Kör nu (utlöst: ${trigger}). Utför instruktionen och rapportera kort.`;

    const result = await agent.runAgent(
      { settings: s, providerId: pm.providerId, model: pm.model, messages: [{ role: 'user', content: userMsg }], mode: 'bot', bot: b },
      { onToolEnd: (t) => { runRec.tools.push({ name: t.name, ok: t.ok }); } }
    );

    let output = result.text || '(inget svar)';
    const mem = /MINNE:\s*([\s\S]*)$/i.exec(output);
    if (mem) {
      const m = mem[1].trim();
      if (m && m !== '-') b.memory = (m).slice(0, 3000);
      output = output.replace(/\n?MINNE:[\s\S]*$/i, '').trim();
    }
    runRec.status = 'ok';
    runRec.output = output.slice(0, 6000);
    runRec.steps = result.steps;
  } catch (err) {
    runRec.status = 'error';
    runRec.error = err.message;
  } finally {
    runRec.finishedAt = new Date().toISOString();
    runRec.durationMs = Date.now() - started.getTime();
    running.delete(id);
    save();
  }
  return runRec;
}

// ---------- Verktyg så AI:n kan bygga botar i chatten ----------

const SCHEDULE_SCHEMA = {
  type: 'object',
  description: 'När boten ska köras.',
  properties: {
    type: { type: 'string', enum: ['manual', 'interval', 'daily', 'weekly'] },
    everyMinutes: { type: 'integer', description: 'För interval: minuter mellan körningar (min 5)' },
    time: { type: 'string', description: 'För daily/weekly: HH:MM svensk tid' },
    weekday: { type: 'integer', description: 'För weekly: 0=söndag, 1=måndag … 6=lördag' }
  }
};

const TOOLS = [
  {
    name: 'create_bot',
    description: 'Skapa en automatisk workflow-bot som kör en instruktion på schema (eller manuellt). Använd när användaren vill att något ska ske regelbundet eller automatiskt. Skriv instruktionen detaljerat och i imperativ – boten kör utan tillsyn.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        emoji: { type: 'string', description: 'En emoji som ikon' },
        instructions: { type: 'string', description: 'Vad boten ska göra, steg för steg' },
        schedule: SCHEDULE_SCHEMA,
        run_now: { type: 'boolean', description: 'Kör en första gång direkt', default: false }
      },
      required: ['name', 'instructions', 'schedule']
    },
    async execute({ name, emoji, instructions, schedule, run_now = false }, ctx) {
      const b = create({ name, emoji, instructions, schedule, providerId: ctx.providerId, model: ctx.model });
      if (run_now) run(b.id, { trigger: 'skapad i chatten' }).catch(() => {});
      return { ok: true, bot: { id: b.id, name: b.name, schedule: b.schedule, nextRun: nextRunAt(b) }, note: 'Boten syns under "Botar" i menyn.' };
    }
  },
  {
    name: 'list_bots',
    description: 'Lista användarens botar med schema, status och senaste körning.',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return {
        bots: load().map((b) => ({
          id: b.id, name: b.name, emoji: b.emoji, enabled: b.enabled, schedule: b.schedule, nextRun: nextRunAt(b),
          lastRunAt: b.lastRunAt, lastStatus: b.runs && b.runs[0] ? b.runs[0].status : null,
          lastOutput: b.runs && b.runs[0] ? String(b.runs[0].output || b.runs[0].error || '').slice(0, 300) : null,
          instructions: b.instructions.slice(0, 300)
        }))
      };
    }
  },
  {
    name: 'update_bot',
    description: 'Ändra en bot: namn, instruktion, schema, pausa/aktivera eller ta bort.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        instructions: { type: 'string' },
        schedule: SCHEDULE_SCHEMA,
        enabled: { type: 'boolean' },
        delete: { type: 'boolean' }
      },
      required: ['id']
    },
    async execute({ id, delete: del = false, ...patch }) {
      if (del) return remove(id) ? { ok: true, deleted: id } : { error: 'Boten finns inte.' };
      const b = update(id, patch);
      return b ? { ok: true, bot: { id: b.id, name: b.name, enabled: b.enabled, schedule: b.schedule } } : { error: 'Boten finns inte.' };
    }
  },
  {
    name: 'run_bot',
    description: 'Kör en bot direkt nu och vänta på resultatet.',
    parameters: { type: 'object', properties: { id: { type: 'string' }, input: { type: 'string', description: 'Extra info till boten' } }, required: ['id'] },
    async execute({ id, input }) {
      const r = await run(id, { trigger: 'från chatten', input });
      return { ok: r.status === 'ok', status: r.status, output: r.output, error: r.error, tools_used: r.tools.map((t) => t.name) };
    }
  }
];

// Färdiga mallar
const TEMPLATES = [
  { emoji: '🌅', name: 'Morgonrapport', schedule: { type: 'daily', time: '07:30' }, instructions: 'Hämta butiksstatistik för igår (ordrar, intäkt, topprodukter) och mina kalenderhändelser för idag. Sammanfatta kort och mejla rapporten till mig själv (min egen Gmail-adress) med ämnet "Morgonrapport <datum>".' },
  { emoji: '📬', name: 'Inkorgsvakt', schedule: { type: 'interval', everyMinutes: 30 }, instructions: 'Sök olästa mejl från senaste timmen. För varje mejl som är en kundfråga: skriv ett vänligt svarsutkast (gmail_draft) på samma språk som kunden. Markera spam/nyhetsbrev som lästa. Rapportera vad du gjorde. Hantera inte mejl-id:n som finns i minnet.' },
  { emoji: '📦', name: 'Lagerlarm', schedule: { type: 'daily', time: '09:00' }, instructions: 'Lista alla produkter och hitta de med lagersaldo under 5. Skapa en uppgift i Google Tasks per produkt som behöver beställas (om den inte redan finns i minnet) och skicka en sammanfattning till min Gmail.' },
  { emoji: '📊', name: 'Veckorapport till Sheets', schedule: { type: 'weekly', weekday: 1, time: '08:00' }, instructions: 'Hämta butiksstatistik för de senaste 7 dagarna. Om det inte finns ett Sheet som heter "Agent Flow – Veckorapport" (sök på Drive), skapa det med rubrikraden: Vecka, Ordrar, Intäkt, Topprodukt. Lägg sedan till en rad för veckan som gick.' },
  { emoji: '🧾', name: 'Ordergranskare', schedule: { type: 'interval', everyMinutes: 60 }, instructions: 'Hämta ordrar från senaste timmen. Flagga obetalda ordrar, ordrar över 2000 kr och ordrar med ofullständig adress. Lägg taggen "granska" på dessa i Shopify och sammanfatta.' }
];

module.exports = { list, get, create, update, remove, run, startScheduler, TOOLS, TEMPLATES, nextRunAt };

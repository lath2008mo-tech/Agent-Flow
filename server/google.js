/**
 * Agent Flow – Google-koppling via "Logga in med Google" (OAuth 2.0).
 * En inloggning ger AI:n verktyg för Gmail, Kalender, Drive, Sheets, Docs,
 * Tasks och Kontakter – utan att användaren behöver hantera API-nycklar.
 *
 * Kräver (en gång, av den som driftar appen) ett OAuth-klient-ID från Google
 * Cloud Console. Sätts via GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET eller i UI:t.
 */
const crypto = require('crypto');
const settings = require('./settings');
const secure = require('./secure');
const setup = require('./setup');
const store = require('./store');

const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/contacts.readonly'
];

const SERVICES = [
  { id: 'gmail', name: 'Gmail', emoji: '✉️', desc: 'Läs, sök, skicka och svara på mejl' },
  { id: 'calendar', name: 'Google Kalender', emoji: '📅', desc: 'Se, skapa och flytta möten' },
  { id: 'drive', name: 'Google Drive', emoji: '📁', desc: 'Sök och läs filer' },
  { id: 'sheets', name: 'Google Sheets', emoji: '📊', desc: 'Läs och skriv kalkylblad' },
  { id: 'docs', name: 'Google Docs', emoji: '📝', desc: 'Skapa och läs dokument' },
  { id: 'tasks', name: 'Google Tasks', emoji: '✅', desc: 'Att-göra-listor' },
  { id: 'contacts', name: 'Kontakter', emoji: '👤', desc: 'Slå upp personer' }
];

const pendingStates = new Map(); // state -> createdAt (fallback utan krypteringsnyckel)
const usedStates = new Map();    // redan använda nonces (skydd mot återupprepning)

function clientConfig(s) {
  const g = s.google || {};
  return {
    clientId: g.clientId || process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: g.clientSecret || process.env.GOOGLE_CLIENT_SECRET || ''
  };
}

function isConfigured(s) {
  const c = clientConfig(s);
  return Boolean(c.clientId && c.clientSecret);
}

function isConnected(s) {
  const token = s.google && s.google.refreshToken;
  return Boolean(token) && !secure.isBroken(token);
}

/** Status för Google-kopplingen, t.ex. om tokens inte går att dekryptera. */
function tokenHealth(s) {
  const g = (s && s.google) || {};
  const broken = ['refreshToken', 'accessToken', 'clientSecret'].filter((k) => secure.isBroken(g[k]));
  return {
    stored: Boolean(g.refreshToken),
    readable: Boolean(g.refreshToken) && !broken.length,
    brokenFields: broken,
    error: broken.length
      ? `Sparade Google-uppgifter kan inte läsas med nuvarande ${secure.KEY_ENV_NAMES[0]}. Sätt tillbaka rätt nyckel i miljön eller koppla Google igen.`
      : ''
  };
}

/** Checklistan med allt som måste vara på plats innan Google kopplas. */
function requirements(s) {
  return setup.checklist(s || settings.load());
}

function redirectUri(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/api/google/callback`;
}

function authUrl(req) {
  const s = settings.load();
  const c = clientConfig(s);
  if (!c.clientId) {
    const err = new Error('Google-inloggning är inte konfigurerad ännu. Lägg in Client ID + Client Secret under Integrationer → Google.');
    err.status = 400;
    throw err;
  }
  // Allt måste vara på plats innan ett Google-konto kopplas: API-skydd,
  // beständig extern lagring och krypteringsnyckel (på hostad server).
  const chk = setup.checklist(s);
  const blocking = chk.checks.filter((x) => x.blocking);
  if (blocking.length) {
    const err = new Error(
      `Innan Google kan kopplas måste följande vara klart: ${blocking.map((b) => b.label).join(' + ')}. Se "Driftstatus" under Integrationer.`
    );
    err.status = 400;
    err.checks = blocking;
    throw err;
  }

  const state = createState();
  if (state.inMemory) pendingStates.set(state.value, Date.now());

  const params = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: state.value
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/**
 * OAuth-state. Med en krypteringsnyckel i miljön signeras staten (HMAC) och
 * klarar därför att gratisservern startar om mitt i inloggningen. Utan nyckel
 * används den gamla minnesbaserade varianten.
 */
function createState() {
  const nonce = crypto.randomBytes(16).toString('hex');
  const ts = Date.now();
  const payload = `${nonce}.${ts}`;
  const sig = secure.sign(payload);
  if (!sig) return { value: nonce, inMemory: true };
  return { value: `${payload}.${sig}`, inMemory: false };
}

function verifyState(state) {
  if (!state) return false;
  if (pendingStates.has(state)) {
    pendingStates.delete(state);
    return true;
  }
  if (!secure.enabled()) return false;
  const parts = String(state).split('.');
  if (parts.length !== 3) return false;
  const [nonce, ts, sig] = parts;
  if (!secure.verify(`${nonce}.${ts}`, sig)) return false;
  const age = Date.now() - Number(ts);
  if (!Number.isFinite(age) || age < 0 || age > 10 * 60 * 1000) return false;
  // Engångsbruk: samma state får bara användas en gång medan servern lever.
  if (usedStates.has(nonce)) return false;
  usedStates.set(nonce, Date.now());
  for (const [k, t] of usedStates) if (Date.now() - t > 10 * 60 * 1000) usedStates.delete(k);
  return true;
}

async function tokenRequest(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(20000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Google OAuth-fel: ${data.error_description || data.error || res.status}`);
    err.status = 400;
    throw err;
  }
  return data;
}

async function handleCallback(req) {
  const { code, state, error } = req.query;
  if (error) throw new Error(`Google nekade inloggningen: ${error}`);
  if (!verifyState(state)) throw new Error('Ogiltig eller utgången inloggningsstatus. Försök igen.');
  // Rensa gamla minnesbaserade states
  for (const [k, t] of pendingStates) if (Date.now() - t > 10 * 60 * 1000) pendingStates.delete(k);

  const s = settings.load();
  const chk = setup.checklist(s);
  if (!chk.canConnectGoogle) {
    const err = new Error(
      `Google nekades kopplas: ${chk.checks.filter((x) => x.blocking).map((b) => b.label).join(' + ')} saknas. Se "Driftstatus" under Integrationer.`
    );
    err.status = 400;
    throw err;
  }
  const c = clientConfig(s);
  const tok = await tokenRequest({
    code,
    client_id: c.clientId,
    client_secret: c.clientSecret,
    redirect_uri: redirectUri(req),
    grant_type: 'authorization_code'
  });

  // Hämta profil
  let profile = {};
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tok.access_token}` }
    });
    profile = await r.json();
  } catch { /* ok */ }

  settings.updateGoogle({
    refreshToken: tok.refresh_token || (s.google && s.google.refreshToken) || '',
    accessToken: tok.access_token,
    expiresAt: Date.now() + (tok.expires_in || 3600) * 1000 - 60000,
    scopes: (tok.scope || '').split(' '),
    email: profile.email || '',
    name: profile.name || '',
    picture: profile.picture || ''
  });

  // Skriv klart till databasen direkt (inte via den fördröjda kön) så att
  // inloggningen garanterat finns kvar även om instansen startar om direkt.
  try {
    await store.flush('settings');
  } catch (err) {
    console.error('[google] Kunde inte skriva inloggningen till databasen direkt:', err.message);
  }

  profile.storage = store.status().mode;
  return profile;
}

async function getAccessToken() {
  const s = settings.load();
  const g = s.google || {};
  if (!g.refreshToken) {
    const err = new Error('Google är inte kopplat. Be användaren klicka "Logga in med Google" under Integrationer.');
    err.status = 400;
    throw err;
  }
  if (secure.isBroken(g.refreshToken)) {
    const err = new Error(tokenHealth(s).error);
    err.status = 400;
    throw err;
  }
  if (g.accessToken && g.expiresAt && Date.now() < g.expiresAt) return g.accessToken;
  const c = clientConfig(s);
  const tok = await tokenRequest({
    refresh_token: g.refreshToken,
    client_id: c.clientId,
    client_secret: c.clientSecret,
    grant_type: 'refresh_token'
  });
  settings.updateGoogle({
    accessToken: tok.access_token,
    expiresAt: Date.now() + (tok.expires_in || 3600) * 1000 - 60000
  });
  return tok.access_token;
}

function disconnect() {
  const s = settings.load();
  const g = s.google || {};
  if (g.refreshToken) {
    fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(g.refreshToken)}`, { method: 'POST' }).catch(() => {});
  }
  settings.updateGoogle({ refreshToken: '', accessToken: '', expiresAt: 0, email: '', name: '', picture: '', scopes: [] });
}

async function gapi(method, url, body, { raw = false } = {}) {
  const token = await getAccessToken();
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body && !raw ? { 'Content-Type': 'application/json' } : {}),
      ...(raw ? { 'Content-Type': 'message/rfc822' } : {})
    },
    body: body ? (raw ? body : JSON.stringify(body)) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try { detail = JSON.parse(text).error?.message || detail; } catch { /* */ }
    const err = new Error(`Google-fel ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

// ---------- Hjälp ----------

function b64url(str) {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeB64url(str) {
  return Buffer.from(String(str || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}
function header(msg, name) {
  const h = (msg.payload && msg.payload.headers) || [];
  const f = h.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return f ? f.value : '';
}
function extractBody(payload) {
  if (!payload) return '';
  if (payload.body && payload.body.data && (payload.mimeType === 'text/plain' || !payload.parts)) {
    const txt = decodeB64url(payload.body.data);
    return payload.mimeType === 'text/html' ? txt.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') : txt;
  }
  if (payload.parts) {
    const plain = payload.parts.find((p) => p.mimeType === 'text/plain');
    if (plain && plain.body && plain.body.data) return decodeB64url(plain.body.data);
    for (const p of payload.parts) {
      const r = extractBody(p);
      if (r) return r;
    }
  }
  return '';
}
function encodeMimeWord(str) {
  return /^[\x20-\x7e]*$/.test(str) ? str : `=?UTF-8?B?${Buffer.from(str, 'utf8').toString('base64')}?=`;
}
function buildRfc822({ to, cc, bcc, subject, body, inReplyTo, references, from }) {
  const lines = [];
  if (from) lines.push(`From: ${from}`);
  lines.push(`To: ${to}`);
  if (cc) lines.push(`Cc: ${cc}`);
  if (bcc) lines.push(`Bcc: ${bcc}`);
  lines.push(`Subject: ${encodeMimeWord(subject || '')}`);
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('');
  lines.push(Buffer.from(body || '', 'utf8').toString('base64'));
  return lines.join('\r\n');
}

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL = 'https://www.googleapis.com/calendar/v3';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const DOCS = 'https://docs.googleapis.com/v1/documents';
const TASKS = 'https://tasks.googleapis.com/tasks/v1';
const PEOPLE = 'https://people.googleapis.com/v1';

// ---------- Verktyg ----------

const TOOLS = [
  // --- Gmail ---
  {
    name: 'gmail_search',
    service: 'gmail',
    description: 'Sök/lista mejl i Gmail. Använd Gmail-söksyntax, t.ex. "is:unread", "from:kund@x.se", "newer_than:1d", "subject:faktura".',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail-sökfråga (tomt = senaste i inkorgen)' },
        max_results: { type: 'integer', description: 'Max antal (1-25)', default: 10 }
      }
    },
    async execute({ query = '', max_results = 10 }) {
      const q = new URLSearchParams({ maxResults: String(Math.min(Math.max(max_results, 1), 25)) });
      if (query) q.set('q', query);
      const list = await gapi('GET', `${GMAIL}/messages?${q}`);
      const ids = (list.messages || []).slice(0, 25);
      const msgs = await Promise.all(ids.map((m) => gapi('GET', `${GMAIL}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`)));
      return {
        count: msgs.length,
        messages: msgs.map((m) => ({
          id: m.id,
          thread_id: m.threadId,
          from: header(m, 'From'),
          to: header(m, 'To'),
          subject: header(m, 'Subject'),
          date: header(m, 'Date'),
          snippet: m.snippet,
          unread: (m.labelIds || []).includes('UNREAD')
        }))
      };
    }
  },
  {
    name: 'gmail_read',
    service: 'gmail',
    description: 'Läs hela innehållet i ett mejl (via id från gmail_search).',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    async execute({ id }) {
      const m = await gapi('GET', `${GMAIL}/messages/${id}?format=full`);
      return {
        id: m.id,
        thread_id: m.threadId,
        from: header(m, 'From'),
        to: header(m, 'To'),
        cc: header(m, 'Cc'),
        subject: header(m, 'Subject'),
        date: header(m, 'Date'),
        message_id_header: header(m, 'Message-ID'),
        labels: m.labelIds,
        body: extractBody(m.payload).slice(0, 12000),
        attachments: (m.payload.parts || []).filter((p) => p.filename).map((p) => ({ filename: p.filename, mime: p.mimeType, size: p.body && p.body.size }))
      };
    }
  },
  {
    name: 'gmail_send',
    service: 'gmail',
    description: 'Skicka ett nytt mejl från användarens Gmail.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Mottagare (komma-separerat)' },
        subject: { type: 'string' },
        body: { type: 'string', description: 'Brödtext (ren text)' },
        cc: { type: 'string' },
        bcc: { type: 'string' }
      },
      required: ['to', 'subject', 'body']
    },
    async execute(args) {
      const raw = b64url(buildRfc822(args));
      const r = await gapi('POST', `${GMAIL}/messages/send`, { raw });
      return { ok: true, id: r.id, thread_id: r.threadId, to: args.to, subject: args.subject };
    }
  },
  {
    name: 'gmail_reply',
    service: 'gmail',
    description: 'Svara på ett befintligt mejl (behåller tråden).',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id på mejlet som ska besvaras' },
        body: { type: 'string' },
        reply_all: { type: 'boolean', default: false }
      },
      required: ['id', 'body']
    },
    async execute({ id, body, reply_all = false }) {
      const m = await gapi('GET', `${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Reply-To`);
      const to = header(m, 'Reply-To') || header(m, 'From');
      const subj = header(m, 'Subject');
      const mid = header(m, 'Message-ID');
      const refs = [header(m, 'References'), mid].filter(Boolean).join(' ');
      const raw = b64url(buildRfc822({
        to,
        cc: reply_all ? [header(m, 'To'), header(m, 'Cc')].filter(Boolean).join(', ') : '',
        subject: /^re:/i.test(subj) ? subj : `Re: ${subj}`,
        body,
        inReplyTo: mid,
        references: refs
      }));
      const r = await gapi('POST', `${GMAIL}/messages/send`, { raw, threadId: m.threadId });
      return { ok: true, id: r.id, thread_id: r.threadId, to };
    }
  },
  {
    name: 'gmail_draft',
    service: 'gmail',
    description: 'Skapa ett utkast i Gmail (skickas inte).',
    parameters: {
      type: 'object',
      properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } },
      required: ['to', 'subject', 'body']
    },
    async execute(args) {
      const raw = b64url(buildRfc822(args));
      const r = await gapi('POST', `${GMAIL}/drafts`, { message: { raw } });
      return { ok: true, draft_id: r.id };
    }
  },
  {
    name: 'gmail_modify',
    service: 'gmail',
    description: 'Markera mejl som läst/oläst, arkivera, stjärnmärk eller lägg till/ta bort etiketter.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        action: { type: 'string', enum: ['mark_read', 'mark_unread', 'archive', 'star', 'unstar', 'trash'] }
      },
      required: ['id', 'action']
    },
    async execute({ id, action }, ctx) {
      if (action === 'trash') {
        if (!ctx.settings.allowDestructive) return { error: 'Radering är avstängd. Slå på "Tillåt raderingar" under Integrationer → Säkerhet.' };
        await gapi('POST', `${GMAIL}/messages/${id}/trash`);
        return { ok: true, action };
      }
      const map = {
        mark_read: { removeLabelIds: ['UNREAD'] },
        mark_unread: { addLabelIds: ['UNREAD'] },
        archive: { removeLabelIds: ['INBOX'] },
        star: { addLabelIds: ['STARRED'] },
        unstar: { removeLabelIds: ['STARRED'] }
      };
      await gapi('POST', `${GMAIL}/messages/${id}/modify`, map[action]);
      return { ok: true, action };
    }
  },

  // --- Kalender ---
  {
    name: 'calendar_list_events',
    service: 'calendar',
    description: 'Lista händelser i Google Kalender inom ett tidsintervall.',
    parameters: {
      type: 'object',
      properties: {
        time_min: { type: 'string', description: 'ISO-datum/tid (standard: nu)' },
        time_max: { type: 'string', description: 'ISO-datum/tid (standard: +7 dagar)' },
        query: { type: 'string', description: 'Fritextsök' },
        max_results: { type: 'integer', default: 20 },
        calendar_id: { type: 'string', default: 'primary' }
      }
    },
    async execute({ time_min, time_max, query, max_results = 20, calendar_id = 'primary' }) {
      const now = new Date();
      const q = new URLSearchParams({
        timeMin: time_min ? new Date(time_min).toISOString() : now.toISOString(),
        timeMax: time_max ? new Date(time_max).toISOString() : new Date(now.getTime() + 7 * 864e5).toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: String(Math.min(max_results, 50))
      });
      if (query) q.set('q', query);
      const r = await gapi('GET', `${CAL}/calendars/${encodeURIComponent(calendar_id)}/events?${q}`);
      return {
        count: (r.items || []).length,
        events: (r.items || []).map((e) => ({
          id: e.id,
          title: e.summary,
          start: e.start && (e.start.dateTime || e.start.date),
          end: e.end && (e.end.dateTime || e.end.date),
          location: e.location,
          description: (e.description || '').slice(0, 300),
          attendees: (e.attendees || []).map((a) => a.email),
          link: e.htmlLink,
          meet: e.hangoutLink
        }))
      };
    }
  },
  {
    name: 'calendar_create_event',
    service: 'calendar',
    description: 'Skapa en händelse/möte i Google Kalender. Kan bjuda in deltagare och lägga till Google Meet.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        start: { type: 'string', description: 'ISO-tid, t.ex. 2026-10-05T14:00:00' },
        end: { type: 'string', description: 'ISO-tid (standard: start + 1h)' },
        all_day: { type: 'boolean', default: false },
        description: { type: 'string' },
        location: { type: 'string' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'E-postadresser' },
        add_meet: { type: 'boolean', default: false },
        timezone: { type: 'string', default: 'Europe/Stockholm' },
        calendar_id: { type: 'string', default: 'primary' }
      },
      required: ['title', 'start']
    },
    async execute({ title, start, end, all_day = false, description, location, attendees = [], add_meet = false, timezone = 'Europe/Stockholm', calendar_id = 'primary' }) {
      const body = { summary: title, description, location };
      if (all_day) {
        const d = start.slice(0, 10);
        const e = end ? end.slice(0, 10) : new Date(new Date(d).getTime() + 864e5).toISOString().slice(0, 10);
        body.start = { date: d };
        body.end = { date: e };
      } else {
        const st = new Date(start);
        const en = end ? new Date(end) : new Date(st.getTime() + 3600e3);
        body.start = { dateTime: st.toISOString(), timeZone: timezone };
        body.end = { dateTime: en.toISOString(), timeZone: timezone };
      }
      if (attendees.length) body.attendees = attendees.map((email) => ({ email }));
      if (add_meet) body.conferenceData = { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
      const q = new URLSearchParams({ sendUpdates: attendees.length ? 'all' : 'none' });
      if (add_meet) q.set('conferenceDataVersion', '1');
      const e = await gapi('POST', `${CAL}/calendars/${encodeURIComponent(calendar_id)}/events?${q}`, body);
      return { ok: true, id: e.id, title: e.summary, start: e.start, end: e.end, link: e.htmlLink, meet: e.hangoutLink };
    }
  },
  {
    name: 'calendar_update_event',
    service: 'calendar',
    description: 'Ändra eller ta bort en händelse (flytta tid, byt titel, osv).',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        start: { type: 'string' },
        end: { type: 'string' },
        description: { type: 'string' },
        location: { type: 'string' },
        delete: { type: 'boolean', default: false },
        calendar_id: { type: 'string', default: 'primary' }
      },
      required: ['id']
    },
    async execute({ id, title, start, end, description, location, delete: del = false, calendar_id = 'primary' }, ctx) {
      const base = `${CAL}/calendars/${encodeURIComponent(calendar_id)}/events/${encodeURIComponent(id)}`;
      if (del) {
        if (!ctx.settings.allowDestructive) return { error: 'Radering är avstängd. Slå på "Tillåt raderingar" under Integrationer → Säkerhet.' };
        await gapi('DELETE', base);
        return { ok: true, deleted: id };
      }
      const patch = {};
      if (title) patch.summary = title;
      if (description != null) patch.description = description;
      if (location != null) patch.location = location;
      if (start) patch.start = { dateTime: new Date(start).toISOString() };
      if (end) patch.end = { dateTime: new Date(end).toISOString() };
      const e = await gapi('PATCH', base, patch);
      return { ok: true, id: e.id, title: e.summary, start: e.start, end: e.end, link: e.htmlLink };
    }
  },

  // --- Drive ---
  {
    name: 'drive_search',
    service: 'drive',
    description: 'Sök filer i Google Drive (namn eller innehåll).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Sökord (eller tom för senaste filer)' },
        max_results: { type: 'integer', default: 15 }
      }
    },
    async execute({ query = '', max_results = 15 }) {
      const esc = query.replace(/'/g, "\\'");
      const q = new URLSearchParams({
        q: query ? `(name contains '${esc}' or fullText contains '${esc}') and trashed = false` : 'trashed = false',
        pageSize: String(Math.min(max_results, 50)),
        orderBy: 'modifiedTime desc',
        fields: 'files(id,name,mimeType,modifiedTime,size,webViewLink,owners(emailAddress))'
      });
      const r = await gapi('GET', `${DRIVE}/files?${q}`);
      return { count: (r.files || []).length, files: r.files };
    }
  },
  {
    name: 'drive_read_file',
    service: 'drive',
    description: 'Läs textinnehållet i en fil på Drive (Docs, Sheets, textfiler, PDF-text m.m.).',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    async execute({ id }) {
      const meta = await gapi('GET', `${DRIVE}/files/${id}?fields=id,name,mimeType,webViewLink`);
      const token = await getAccessToken();
      let url;
      const mt = meta.mimeType || '';
      if (mt === 'application/vnd.google-apps.document') url = `${DRIVE}/files/${id}/export?mimeType=text/plain`;
      else if (mt === 'application/vnd.google-apps.spreadsheet') url = `${DRIVE}/files/${id}/export?mimeType=text/csv`;
      else if (mt === 'application/vnd.google-apps.presentation') url = `${DRIVE}/files/${id}/export?mimeType=text/plain`;
      else url = `${DRIVE}/files/${id}?alt=media`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return { error: `Kunde inte läsa filen (${res.status}).`, file: meta };
      const buf = Buffer.from(await res.arrayBuffer());
      const isText = /text|json|csv|xml|javascript/.test(res.headers.get('content-type') || '') || mt.startsWith('application/vnd.google-apps');
      return { file: meta, content: isText ? buf.toString('utf8').slice(0, 15000) : `(binär fil, ${buf.length} byte)` };
    }
  },
  {
    name: 'drive_create_file',
    service: 'drive',
    description: 'Skapa en textfil (eller mapp) i Google Drive.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        content: { type: 'string', description: 'Textinnehåll (utelämna för mapp)' },
        folder: { type: 'boolean', default: false },
        parent_id: { type: 'string' }
      },
      required: ['name']
    },
    async execute({ name, content = '', folder = false, parent_id }) {
      const token = await getAccessToken();
      const meta = { name, ...(parent_id ? { parents: [parent_id] } : {}) };
      if (folder) {
        meta.mimeType = 'application/vnd.google-apps.folder';
        const r = await gapi('POST', `${DRIVE}/files?fields=id,name,webViewLink`, meta);
        return { ok: true, ...r };
      }
      const boundary = 'af' + crypto.randomBytes(8).toString('hex');
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
      const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
        body
      });
      const r = await res.json();
      if (!res.ok) return { error: r.error?.message || `Fel ${res.status}` };
      return { ok: true, ...r };
    }
  },

  // --- Sheets ---
  {
    name: 'sheets_read',
    service: 'sheets',
    description: 'Läs celler från ett Google Sheet.',
    parameters: {
      type: 'object',
      properties: {
        spreadsheet_id: { type: 'string', description: 'Id från URL:en (docs.google.com/spreadsheets/d/<ID>)' },
        range: { type: 'string', description: 'A1-notation, t.ex. "Blad1!A1:F50" (standard: första bladet)' }
      },
      required: ['spreadsheet_id']
    },
    async execute({ spreadsheet_id, range }) {
      if (!range) {
        const meta = await gapi('GET', `${SHEETS}/${spreadsheet_id}?fields=sheets.properties.title`);
        range = meta.sheets[0].properties.title;
      }
      const r = await gapi('GET', `${SHEETS}/${spreadsheet_id}/values/${encodeURIComponent(range)}`);
      const rows = r.values || [];
      return { range: r.range, rows: rows.slice(0, 500), total_rows: rows.length };
    }
  },
  {
    name: 'sheets_append',
    service: 'sheets',
    description: 'Lägg till rader längst ner i ett Google Sheet.',
    parameters: {
      type: 'object',
      properties: {
        spreadsheet_id: { type: 'string' },
        range: { type: 'string', description: 'Blad/område, t.ex. "Blad1" eller "Blad1!A:D"' },
        rows: { type: 'array', items: { type: 'array', items: { type: ['string', 'number', 'null'] } }, description: 'Lista av rader' }
      },
      required: ['spreadsheet_id', 'rows']
    },
    async execute({ spreadsheet_id, range = 'A1', rows }) {
      const r = await gapi('POST', `${SHEETS}/${spreadsheet_id}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, { values: rows });
      return { ok: true, updated_range: r.updates && r.updates.updatedRange, rows_added: r.updates && r.updates.updatedRows };
    }
  },
  {
    name: 'sheets_write',
    service: 'sheets',
    description: 'Skriv över celler i ett angivet område i ett Google Sheet.',
    parameters: {
      type: 'object',
      properties: {
        spreadsheet_id: { type: 'string' },
        range: { type: 'string', description: 'A1-notation, t.ex. "Blad1!B2"' },
        rows: { type: 'array', items: { type: 'array', items: { type: ['string', 'number', 'null'] } } }
      },
      required: ['spreadsheet_id', 'range', 'rows']
    },
    async execute({ spreadsheet_id, range, rows }) {
      const r = await gapi('PUT', `${SHEETS}/${spreadsheet_id}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, { values: rows });
      return { ok: true, updated_range: r.updatedRange, updated_cells: r.updatedCells };
    }
  },
  {
    name: 'sheets_create',
    service: 'sheets',
    description: 'Skapa ett nytt Google Sheet, valfritt med startdata.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        rows: { type: 'array', items: { type: 'array', items: { type: ['string', 'number', 'null'] } } }
      },
      required: ['title']
    },
    async execute({ title, rows }) {
      const r = await gapi('POST', SHEETS, { properties: { title } });
      if (rows && rows.length) {
        await gapi('PUT', `${SHEETS}/${r.spreadsheetId}/values/A1?valueInputOption=USER_ENTERED`, { values: rows });
      }
      return { ok: true, spreadsheet_id: r.spreadsheetId, url: r.spreadsheetUrl, title };
    }
  },

  // --- Docs ---
  {
    name: 'docs_create',
    service: 'docs',
    description: 'Skapa ett Google Docs-dokument med text.',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' }, content: { type: 'string' } },
      required: ['title']
    },
    async execute({ title, content = '' }) {
      const d = await gapi('POST', DOCS, { title });
      if (content) {
        await gapi('POST', `${DOCS}/${d.documentId}:batchUpdate`, { requests: [{ insertText: { location: { index: 1 }, text: content } }] });
      }
      return { ok: true, document_id: d.documentId, url: `https://docs.google.com/document/d/${d.documentId}/edit`, title };
    }
  },
  {
    name: 'docs_append',
    service: 'docs',
    description: 'Lägg till text i slutet av ett befintligt Google Docs-dokument.',
    parameters: {
      type: 'object',
      properties: { document_id: { type: 'string' }, content: { type: 'string' } },
      required: ['document_id', 'content']
    },
    async execute({ document_id, content }) {
      const d = await gapi('GET', `${DOCS}/${document_id}?fields=body.content.endIndex`);
      const end = d.body.content[d.body.content.length - 1].endIndex - 1;
      await gapi('POST', `${DOCS}/${document_id}:batchUpdate`, { requests: [{ insertText: { location: { index: Math.max(1, end) }, text: content } }] });
      return { ok: true, document_id };
    }
  },

  // --- Tasks ---
  {
    name: 'tasks_list',
    service: 'tasks',
    description: 'Lista att-göra-uppgifter i Google Tasks.',
    parameters: { type: 'object', properties: { show_completed: { type: 'boolean', default: false } } },
    async execute({ show_completed = false }) {
      const lists = await gapi('GET', `${TASKS}/users/@me/lists`);
      const out = [];
      for (const l of (lists.items || []).slice(0, 5)) {
        const t = await gapi('GET', `${TASKS}/lists/${l.id}/tasks?showCompleted=${show_completed}&maxResults=50`);
        out.push({ list_id: l.id, list: l.title, tasks: (t.items || []).map((x) => ({ id: x.id, title: x.title, due: x.due, status: x.status, notes: x.notes })) });
      }
      return { lists: out };
    }
  },
  {
    name: 'tasks_create',
    service: 'tasks',
    description: 'Skapa en uppgift i Google Tasks.',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' }, notes: { type: 'string' }, due: { type: 'string', description: 'ISO-datum' }, list_id: { type: 'string' } },
      required: ['title']
    },
    async execute({ title, notes, due, list_id }) {
      if (!list_id) {
        const lists = await gapi('GET', `${TASKS}/users/@me/lists`);
        list_id = lists.items[0].id;
      }
      const t = await gapi('POST', `${TASKS}/lists/${list_id}/tasks`, { title, notes, due: due ? new Date(due).toISOString() : undefined });
      return { ok: true, id: t.id, title: t.title, due: t.due };
    }
  },
  {
    name: 'tasks_complete',
    service: 'tasks',
    description: 'Markera en uppgift som klar.',
    parameters: { type: 'object', properties: { id: { type: 'string' }, list_id: { type: 'string' } }, required: ['id', 'list_id'] },
    async execute({ id, list_id }) {
      await gapi('PATCH', `${TASKS}/lists/${list_id}/tasks/${id}`, { status: 'completed' });
      return { ok: true, id };
    }
  },

  // --- Kontakter ---
  {
    name: 'contacts_search',
    service: 'contacts',
    description: 'Sök bland användarens Google-kontakter (namn, e-post, telefon).',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    async execute({ query }) {
      const q = new URLSearchParams({ query, readMask: 'names,emailAddresses,phoneNumbers,organizations', pageSize: '10' });
      const r = await gapi('GET', `${PEOPLE}/people:searchContacts?${q}`);
      return {
        results: (r.results || []).map(({ person }) => ({
          name: person.names && person.names[0] && person.names[0].displayName,
          emails: (person.emailAddresses || []).map((e) => e.value),
          phones: (person.phoneNumbers || []).map((p) => p.value),
          org: person.organizations && person.organizations[0] && person.organizations[0].name
        }))
      };
    }
  }
];

function status() {
  const s = settings.load();
  const g = s.google || {};
  const chk = setup.checklist(s);
  return {
    configured: isConfigured(s),
    connected: isConnected(s),
    email: g.email || '',
    name: g.name || '',
    picture: g.picture || '',
    services: SERVICES,
    clientIdMasked: settings.maskSecret(clientConfig(s).clientId),
    hasClientSecret: Boolean(clientConfig(s).clientSecret),
    connectedAt: g.connectedAt || '',
    // Driftläge: var sparas tokens, är de krypterade och får Google kopplas?
    canConnect: chk.canConnectGoogle,
    missing: chk.checks.filter((c) => !c.ok).map((c) => ({ id: c.id, label: c.label, hint: c.hint, status: c.status, blocking: c.blocking })),
    tokenHealth: tokenHealth(s),
    storage: { mode: chk.storage.mode, remote: chk.storage.remote, encrypted: chk.storage.encrypted, error: chk.storage.error },
    authRequired: chk.auth.required
  };
}

module.exports = {
  TOOLS,
  SERVICES,
  SCOPES,
  authUrl,
  handleCallback,
  disconnect,
  status,
  isConnected,
  isConfigured,
  redirectUri,
  gapi,
  requirements,
  tokenHealth,
  canConnect: (s) => setup.checklist(s || settings.load()).canConnectGoogle
};

/* ============ Agent Flow – frontend ============ */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const API_KEY_STORAGE = 'af_api_key';

const state = {
  settings: null,
  setup: null,
  providers: [],
  models: {},          // providerId -> [modeller]
  messages: [],        // chatt-historik {role, content}
  busy: false,
  providerId: localStorage.getItem('af_provider') || 'openai',
  model: localStorage.getItem('af_model') || ''
};

// ---------- API-nyckel (APP_API_KEY) ----------

function apiKey() {
  return localStorage.getItem(API_KEY_STORAGE) || '';
}

function setApiKey(key) {
  if (key) localStorage.setItem(API_KEY_STORAGE, key);
  else localStorage.removeItem(API_KEY_STORAGE);
}

function authHeaders(extra = {}) {
  const key = apiKey();
  return key ? { 'x-api-key': key, ...extra } : { ...extra };
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// ---------- Hjälp ----------

function toast(message, type = 'ok') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show ${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 4200);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Minimal markdown → HTML (kodblock, listor, fetstil, länkar). */
function renderMarkdown(text) {
  const esc = escapeHtml(text);
  const codeBlocks = [];
  let t = esc.replace(/```(?:[a-zA-Z0-9]*)\n?([\s\S]*?)```/g, (m, code) => {
    codeBlocks.push(`<pre><code>${code.trim()}</code></pre>`);
    return `\u0000CODE${codeBlocks.length - 1}\u0000`;
  });

  t = t
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Listor
  t = t.replace(/((?:^[\-\*] .+(?:\n|$))+)/gm, (m) => {
    const items = m.trim().split('\n').map((l) => `<li>${l.replace(/^[\-\*] /, '')}</li>`).join('');
    return `<ul>${items}</ul>`;
  });
  t = t.replace(/((?:^\d+\. .+(?:\n|$))+)/gm, (m) => {
    const items = m.trim().split('\n').map((l) => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('');
    return `<ol>${items}</ol>`;
  });

  t = t
    .split(/\n{2,}/)
    .map((para) => {
      const p = para.trim();
      if (!p) return '';
      if (/^<(ul|ol|h[23]|pre|blockquote)/.test(p) || /^\u0000CODE/.test(p)) return p;
      return `<p>${p.replace(/\n/g, '<br>')}</p>`;
    })
    .join('');

  t = t.replace(/\u0000CODE(\d+)\u0000/g, (m, i) => codeBlocks[+i]);
  return t;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    lockApp(data.error || 'API:t kräver en åtkomstnyckel.');
    throw new ApiError(data.error || 'API:t kräver en åtkomstnyckel (APP_API_KEY).', 401);
  }
  if (!res.ok && !data.ok) {
    throw new ApiError(data.error || data.message || `Fel ${res.status}`, res.status);
  }
  return data;
}

// ---------- Låsning (API-skydd) ----------

function lockApp(message = '') {
  const el = $('#lock-screen');
  if (!el) return;
  el.hidden = false;
  document.body.classList.add('locked');
  if (message) $('#lock-msg').textContent = message;
  const hint = $('#lock-hint');
  if (state.auth && state.auth.keyVar) {
    hint.innerHTML = `Nyckeln sätts som miljövariabeln <code>${escapeHtml(state.auth.keyVar)}</code> på servern (Render → Environment).`;
  }
  setTimeout(() => $('#lock-key').focus(), 50);
}

function unlockApp() {
  const el = $('#lock-screen');
  if (el) el.hidden = true;
  document.body.classList.remove('locked');
  $('#lock-msg').textContent = '';
}

/** Kontrollerar om API:t kräver nyckel och om den vi har fungerar. */
async function ensureUnlocked() {
  let status;
  try {
    status = await fetch('/api/auth/status', { headers: authHeaders() }).then((r) => r.json());
  } catch {
    return true; // servern svarar inte – låt resten av appen visa felet
  }
  state.auth = status;
  if (!status.required) {
    unlockApp();
    return true;
  }
  if (apiKey()) {
    try {
      await api('/api/setup');
      unlockApp();
      return true;
    } catch (err) {
      if (err.status !== 401) {
        unlockApp();
        return true; // nyckeln är rätt, något annat gick fel
      }
      setApiKey('');
    }
  }
  lockApp(apiKey() ? 'Nyckeln stämmer inte – försök igen.' : '');
  return false;
}

// ---------- Routing ----------

function navigate() {
  const route = (location.hash.replace('#/', '') || 'oversikt').split('?')[0];
  $$('.view').forEach((v) => v.classList.remove('active'));
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.route === route));
  const view = $(`#view-${route}`) || $('#view-oversikt');
  view.classList.add('active');

  if (route === 'oversikt') loadOverview();
  if (route === 'modeller') loadModels();
  if (route === 'integrationer') loadIntegrationer();
  if (route === 'botar') loadBots();
  if (route === 'assistent') {
    renderModelSelect();
    $('#chat-input').focus();
  }
}

window.addEventListener('hashchange', navigate);

// ---------- Översikt ----------

async function loadOverview() {
  // Shopify-status
  try {
    const ov = await api('/api/shopify/overview');
    const body = $('#shopify-status-body');
    if (ov.connected && ov.shop) {
      body.innerHTML = `
        <div><strong>${escapeHtml(ov.shop.name)}</strong></div>
        <div style="color:var(--text-faint);font-size:12px">${escapeHtml(ov.shop.myshopify_domain || ov.shop.domain || '')}</div>
        <div style="margin-top:8px"><span class="badge badge-green">✓ Ansluten</span> <span class="badge">${escapeHtml(ov.shop.currency || '')}</span></div>`;
      setSidebarStatus('ok', `Shopify: ${ov.shop.name}`);
    } else {
      body.innerHTML = `
        <div>Butiken är inte ansluten ännu.</div>
        <div style="margin-top:8px"><span class="badge badge-red">Ej ansluten</span></div>
        ${ov.error ? `<div style="margin-top:8px;color:var(--red);font-size:12px">${escapeHtml(ov.error)}</div>` : ''}`;
      setSidebarStatus('warn', 'Shopify ej ansluten');
    }
  } catch {
    $('#shopify-status-body').innerHTML = '<div>Kunde inte läsa status.</div>';
    setSidebarStatus('warn', 'Kunde inte läsa status');
  }

  // Google
  try {
    const g = await api('/api/google/status');
    $('#google-status-body').innerHTML = g.connected
      ? `<div><strong>${escapeHtml(g.name || g.email)}</strong></div>
         <div style="color:var(--text-faint);font-size:12px">${escapeHtml(g.email)}</div>
         <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px">${g.services.map((x) => `<span class="badge badge-green">${x.emoji} ${escapeHtml(x.name)}</span>`).join('')}</div>`
      : `<div>Logga in med Google så kan AI:n jobba i Gmail, Kalender, Drive, Sheets, Docs och Tasks.</div>
         <div style="margin-top:8px"><span class="badge badge-red">Ej kopplad</span></div>`;
  } catch { /* tyst */ }

  // AI-leverantörer
  try {
    const data = await api('/api/providers');
    state.providers = data.providers;
    const connected = data.providers.filter((p) => p.hasKey);
    $('#providers-status-body').innerHTML = connected.length
      ? `<div><strong>${connected.length}</strong> av ${data.providers.length} leverantörer anslutna</div>
         <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px">${connected.map((p) => `<span class="badge badge-purple">${p.emoji} ${escapeHtml(p.name)}</span>`).join('')}</div>`
      : `<div>Inga AI-nycklar tillagda ännu. Lägg till minst en nyckel för att komma igång.</div>`;
  } catch { /* tyst */ }

  // Statistik
  try {
    const ov = await api('/api/shopify/overview');
    const body = $('#stats-body');
    if (ov.connected && ov.stats && !ov.stats.error) {
      const st = ov.stats;
      body.innerHTML = `
        <div class="stat-grid">
          <div class="stat"><div class="stat-val">${st.orders_in_period ?? '–'}</div><div class="stat-lbl">Ordrar</div></div>
          <div class="stat"><div class="stat-val">${st.revenue_in_period != null ? Number(st.revenue_in_period).toLocaleString('sv-SE') : '–'}</div><div class="stat-lbl">Intäkt ${st.currency || ''}</div></div>
          <div class="stat"><div class="stat-val">${st.products ?? '–'}</div><div class="stat-lbl">Produkter</div></div>
          <div class="stat"><div class="stat-val">${st.customers ?? '–'}</div><div class="stat-lbl">Kunder</div></div>
        </div>
        ${st.top_products && st.top_products.length ? `<div style="margin-top:10px;font-size:12px">🏆 Topp: ${st.top_products.map((p) => escapeHtml(p.title)).join(', ')}</div>` : ''}`;
    } else {
      body.innerHTML = '<div>Anslut Shopify för att se statistik.</div>';
    }
  } catch {
    $('#stats-body').innerHTML = '<div>Kunde inte hämta statistik.</div>';
  }
}

function setSidebarStatus(kind, text) {
  const el = $('#sidebar-status');
  el.className = `status-pill ${kind}`;
  el.innerHTML = `<span class="dot"></span> ${escapeHtml(text)}`;
}

// ---------- Integrationer ----------

async function loadIntegrationer() {
  try {
    const s = await api('/api/settings');
    state.settings = s;

    // Shopify-formulär
    $('#shopify-store').value = s.shopify.store || '';
    $('#shopify-token').value = '';
    $('#shopify-token').placeholder = s.shopify.hasToken ? s.shopify.tokenMasked : 'shpat_...';
    $('#shopify-token-hint').textContent = s.shopify.hasToken
      ? `Nuvarande token: ${s.shopify.tokenMasked} – lämna tomt för att behålla.`
      : '';
    $('#shopify-badge').textContent = s.shopify.hasToken && s.shopify.store ? 'Ansluten' : 'Ej ansluten';
    $('#shopify-badge').className = `badge ${s.shopify.hasToken && s.shopify.store ? 'badge-green' : 'badge-red'}`;

    // Google
    loadGooglePanel();

    // Driftstatus (lagring, kryptering, API-skydd)
    loadSetupPanel();

    // Leverantörsformulär
    renderProviderForms();

    // Säkerhets-toggle
    $('#allow-destructive').checked = !!s.allowDestructive;
  } catch (err) {
    toast(err.message, 'err');
  }
}

function renderProviderForms() {
  const wrap = $('#provider-forms');
  const s = state.settings || { providers: {} };
  wrap.innerHTML = state.providers.map((p) => {
    const cfg = s.providers[p.id] || {};
    return `
      <div class="provider-card" data-provider="${p.id}">
        <div class="provider-card-head">
          <span class="provider-emoji">${p.emoji}</span>
          <div>
            <div class="provider-name">${escapeHtml(p.name)}</div>
            <div class="provider-hint">${escapeHtml(p.hint)}</div>
          </div>
          <span class="badge ${cfg.hasKey ? 'badge-green' : ''}" style="margin-left:auto">${cfg.hasKey ? '✓' : '–'}</span>
        </div>
        <input class="input provider-key" type="password" placeholder="${cfg.hasKey ? escapeHtml(cfg.keyMasked || '••••••••') : 'API-nyckel'}" autocomplete="off">
        <div class="row">
          <input class="input provider-base" type="text" placeholder="Base URL (valfritt)" value="${escapeHtml(cfg.baseUrl || '')}">
        </div>
        <div class="provider-actions">
          <button class="btn btn-primary btn-sm provider-save">Spara</button>
          <button class="btn btn-ghost btn-sm provider-test">Testa</button>
          ${cfg.hasKey ? '<button class="btn btn-danger-ghost btn-sm provider-clear">Ta bort</button>' : ''}
          <a class="provider-link" href="${p.keyUrl}" target="_blank" rel="noopener">Skaffa nyckel ↗</a>
        </div>
        <div class="provider-msg"></div>
      </div>`;
  }).join('');

  const connected = state.providers.filter((p) => (state.settings.providers[p.id] || {}).hasKey).length;
  $('#providers-badge').textContent = `${connected} / ${state.providers.length} anslutna`;
  $('#providers-badge').className = `badge ${connected ? 'badge-green' : ''}`;

  // Events
  $$('.provider-card', wrap).forEach((card) => {
    const id = card.dataset.provider;
    const msg = $('.provider-msg', card);
    const keyInput = $('.provider-key', card);
    const baseInput = $('.provider-base', card);

    $('.provider-save', card).addEventListener('click', async () => {
      try {
        const patch = { providers: { [id]: {} } };
        if (keyInput.value.trim()) patch.providers[id].apiKey = keyInput.value.trim();
        patch.providers[id].baseUrl = baseInput.value.trim() || null;
        state.settings = await api('/api/settings', { method: 'PUT', body: patch });
        msg.textContent = '✓ Sparat!';
        msg.className = 'provider-msg ok';
        toast(`Nyckel sparad för ${state.providers.find((p) => p.id === id)?.name || id}`);
        renderProviderForms();
        loadOverview();
      } catch (err) {
        msg.textContent = err.message;
        msg.className = 'provider-msg err';
      }
    });

    $('.provider-test', card).addEventListener('click', async () => {
      msg.textContent = 'Testar…';
      msg.className = 'provider-msg';
      try {
        // Spara först om ny nyckel fyllts i
        if (keyInput.value.trim()) {
          state.settings = await api('/api/settings', {
            method: 'PUT',
            body: { providers: { [id]: { apiKey: keyInput.value.trim() } } }
          });
          keyInput.value = '';
          keyInput.placeholder = state.settings.providers[id]?.keyMasked || 'API-nyckel';
        }
        const r = await api('/api/providers/test', { method: 'POST', body: { providerId: id } });
        msg.textContent = r.message || (r.ok ? '✓ Fungerar!' : 'Ingen nyckel.');
        msg.className = `provider-msg ${r.ok ? 'ok' : 'err'}`;
      } catch (err) {
        msg.textContent = err.message;
        msg.className = 'provider-msg err';
      }
    });

    const clearBtn = $('.provider-clear', card);
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        try {
          state.settings = await api('/api/settings', { method: 'PUT', body: { providers: { [id]: { apiKey: null } } } });
          toast('Nyckel borttagen');
          renderProviderForms();
        } catch (err) {
          msg.textContent = err.message;
          msg.className = 'provider-msg err';
        }
      });
    }
  });
}


// ---------- Google ----------

async function loadGooglePanel() {
  let g = null;
  try {
    g = await api('/api/google/status');
    state.google = g;
    $('#google-redirect-uri').textContent = g.redirectUri;
    $('#google-badge').textContent = g.connected ? `Kopplad: ${g.email}` : (g.configured ? 'Redo att logga in' : 'Ej konfigurerad');
    $('#google-badge').className = `badge ${g.connected ? 'badge-green' : ''}`;
    $('#google-connected').style.display = g.connected ? 'flex' : 'none';
    $('#google-login').style.display = g.connected ? 'none' : 'block';
    $('#google-setup').open = !g.configured && !g.canConnect;
    if (g.connected) {
      $('#google-name').textContent = g.name || g.email;
      $('#google-email').textContent = g.email;
      const av = $('#google-avatar');
      if (g.picture) { av.src = g.picture; av.style.display = 'block'; } else av.style.display = 'none';
    }
    const loginBtn = $('#google-login-btn');
    loginBtn.classList.toggle('disabled', !g.canConnect);
    loginBtn.title = g.canConnect ? '' : `Klar först: ${g.missing.filter((m) => m.blocking).map((m) => m.label).join(' + ')}`;
    $('#google-client-id').placeholder = g.clientIdMasked || 'xxxx.apps.googleusercontent.com';
    $('#google-secret-hint').textContent = g.hasClientSecret ? 'Secret är sparad – lämna tomt för att behålla.' : '';

    // Varför går det inte att logga in? Visa exakt vad som saknas.
    const blockers = $('#google-blockers');
    const toFix = g.missing.filter((m) => m.blocking);
    if (toFix.length) {
      blockers.hidden = false;
      blockers.innerHTML = `
        <div class="callout callout-warn">
          <strong>Klar innan Google kan kopplas:</strong>
          <ul>${toFix.map((m) => `<li><strong>${escapeHtml(m.label)}</strong><br><span class="muted">${escapeHtml(m.hint)}</span></li>`).join('')}</ul>
          <div class="muted">Se <a href="#/integrationer" data-goto="driftstatus">Driftstatus</a> nedanför – den visar exakt vad som saknas på servern.</div>
        </div>`;
    } else if (g.tokenHealth && g.tokenHealth.stored && !g.tokenHealth.readable) {
      blockers.hidden = false;
      blockers.innerHTML = `<div class="callout callout-err">${escapeHtml(g.tokenHealth.error)}</div>`;
    } else {
      blockers.hidden = true;
      blockers.innerHTML = '';
    }

    $('#google-services').innerHTML = g.services.map((x) => `
      <div class="google-service ${g.connected ? 'on' : ''}">
        <span class="google-service-emoji">${x.emoji}</span>
        <div><div class="google-service-name">${escapeHtml(x.name)}</div><div class="google-service-desc">${escapeHtml(x.desc)}</div></div>
        <span class="badge ${g.connected ? 'badge-green' : ''}" style="margin-left:auto">${g.connected ? '✓' : '–'}</span>
      </div>`).join('');
  } catch (err) {
    if (err.status !== 401) toast(err.message, 'err');
  }

  // Meddelande från OAuth-redirect (?google=ok / ?google_error=)
  const qs = location.hash.split('?')[1];
  if (qs) {
    const p = new URLSearchParams(qs);
    if (p.get('google') === 'ok') {
      const where = p.get('storage') === 'supabase' ? 'sparas nu i din externa databas (krypterat)' : 'sparas lokalt på servern';
      toast(`✓ Google kopplat: ${p.get('email') || ''} – inloggningen ${where}.`);
    }
    if (p.get('google_error')) toast(p.get('google_error'), 'err');
    history.replaceState(null, '', '#/integrationer');
  }
}

$('#google-login-btn').addEventListener('click', async (e) => {
  e.preventDefault();
  const g = state.google || {};
  if (!g.canConnect) {
    const toFix = (g.missing || []).filter((m) => m.blocking).map((m) => m.label);
    if (!g.configured) $('#google-setup').open = true;
    toast(toFix.length ? `Klar först: ${toFix.join(' + ')}` : 'Fyll först i Client ID och Client Secret (engångsinställning).', 'err');
    document.querySelector('#driftstatus-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  try {
    const r = await api('/api/google/auth-url', { method: 'POST' });
    if (r.url) location.href = r.url;
    else throw new Error('Kunde inte skapa inloggningslänken.');
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#google-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const result = $('#google-result');
  result.className = 'form-result';
  result.textContent = 'Sparar…';
  try {
    const patch = { google: {} };
    const id = $('#google-client-id').value.trim();
    const secret = $('#google-client-secret').value.trim();
    if (id) patch.google.clientId = id;
    if (secret) patch.google.clientSecret = secret;
    await api('/api/settings', { method: 'PUT', body: patch });
    $('#google-client-id').value = '';
    $('#google-client-secret').value = '';
    result.textContent = '✓ Sparat! Klicka nu på "Logga in med Google".';
    result.className = 'form-result ok';
    loadGooglePanel();
  } catch (err) {
    result.textContent = err.message;
    result.className = 'form-result err';
  }
});

$('#google-test').addEventListener('click', async () => {
  const result = $('#google-result');
  result.className = 'form-result';
  result.textContent = 'Testar…';
  try {
    const r = await api('/api/google/test', { method: 'POST' });
    result.textContent = r.message;
    result.className = 'form-result ok';
  } catch (err) {
    result.textContent = err.message;
    result.className = 'form-result err';
  }
});

$('#google-disconnect').addEventListener('click', async () => {
  if (!confirm('Logga ut från Google? AI:n tappar då åtkomst till Gmail, Kalender m.m.')) return;
  await api('/api/google/disconnect', { method: 'POST' });
  toast('Google frånkopplat');
  loadGooglePanel();
  loadOverview();
});

// ---------- Driftstatus (lagring, kryptering, API-skydd) ----------

const CHECK_ICON = { ok: '✓', warn: '!', fail: '✕' };

function renderSetupPanel(chk) {
  const panel = $('#driftstatus-panel');
  if (!panel) return;
  const storage = chk.storage || {};
  const where = storage.remote
    ? `Supabase (tabell <code>${escapeHtml(storage.table || 'agent_flow_store')}</code>)`
    : 'Lokal fil på serverns disk';
  panel.querySelector('#setup-badge').textContent = chk.ok ? 'Allt klart' : (chk.blocking.length ? 'Behöver åtgärdas' : 'Fungerar');
  panel.querySelector('#setup-badge').className = `badge ${chk.ok ? 'badge-green' : (chk.blocking.length ? 'badge-red' : '')}`;

  panel.querySelector('#setup-checks').innerHTML = chk.checks.map((c) => `
    <div class="setup-check ${c.status}">
      <span class="setup-icon">${CHECK_ICON[c.status] || '·'}</span>
      <div>
        <div class="setup-label">${escapeHtml(c.label)}</div>
        ${c.status === 'ok' ? '' : `<div class="setup-hint">${escapeHtml(c.hint)}</div>`}
        ${c.error ? `<div class="setup-hint err">${escapeHtml(c.error)}</div>` : ''}
      </div>
    </div>`).join('');

  panel.querySelector('#setup-storage').innerHTML = `
    <div><span class="muted">Lagring:</span> ${where}</div>
    <div><span class="muted">Kryptering:</span> ${storage.encrypted ? 'AES-256-GCM (på)' : 'av – sätt ' + escapeHtml(chk.encryption.keyVar)}</div>
    <div><span class="muted">API-skydd:</span> ${chk.auth.required ? 'på (' + escapeHtml(chk.auth.keyVar) + ')' : 'av – vem som helst kan nå API:t'}</div>
    <div><span class="muted">Server:</span> ${chk.hosted ? 'hostad (Renders disk är tillfällig – därför krävs extern lagring)' : 'lokal körning'}</div>`;

  panel.querySelector('#setup-sql').textContent = (storage.sql || '').trim();
  panel.querySelector('#setup-envvars').textContent = [
    `${chk.auth.keyVar}=<välj en lång slumpad sträng>`,
    `${storage.envVars ? storage.envVars.url : 'SUPABASE_URL'}=https://DITT-PROJEKT.supabase.co`,
    `${storage.envVars ? storage.envVars.key : 'SUPABASE_SERVICE_ROLE_KEY'}=<service_role-nyckeln från Supabase>`,
    `${chk.encryption.keyVar}=<minst 32 slumpade tecken>`
  ].join('\n');
  panel.querySelector('#setup-sql-hint').textContent = storage.remote
    ? 'Databasen är kopplad – SQL:en behövs bara om du skapar ett nytt projekt.'
    : 'Kör SQL:en en gång i Supabase → SQL Editor, sätt variablerna i Render → Environment och starta om tjänsten.';
}

async function loadSetupPanel() {
  try {
    const chk = await api('/api/setup');
    state.setup = chk;
    renderSetupPanel(chk);
    renderSetupBanner(chk);
  } catch (err) {
    if (err.status !== 401) toast(err.message, 'err');
  }
}

function renderSetupBanner(chk) {
  const el = $('#setup-banner');
  if (!el) return;
  const blocking = chk.checks.filter((c) => c.status === 'fail');
  const warns = chk.hosted ? chk.checks.filter((c) => c.status === 'warn') : [];
  const list = blocking.length ? blocking : warns;
  if (!list.length) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  el.className = `setup-banner ${blocking.length ? 'fail' : 'warn'}`;
  el.innerHTML = `
    <span class="setup-banner-icon">${blocking.length ? '⛔' : '⚠'}</span>
    <div>
      <strong>${blocking.length ? 'Innan Google kan kopplas saknas:' : 'Rekommenderas för drift:'}</strong>
      ${list.map((c) => escapeHtml(c.label)).join(' · ')}
      <div class="muted">${blocking.length
        ? 'Appen fungerar som vanligt, men Google-inloggningen skulle försvinna vid en omstart.'
        : 'Utan detta kan inloggningen tappas när gratisinstansen startar om.'}
      </div>
    </div>
    <a class="btn btn-ghost btn-sm" href="#/integrationer" id="setup-banner-link">Visa guide</a>`;
  $('#setup-banner-link').onclick = () => setTimeout(() => $('#driftstatus-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
}

$('#setup-copy-sql')?.addEventListener('click', async () => {
  const sql = $('#setup-sql').textContent;
  try {
    await navigator.clipboard.writeText(sql);
    toast('SQL:en kopierad – kör den i Supabase → SQL Editor.');
  } catch {
    toast('Kunde inte kopiera automatiskt – markera texten och kopiera manuellt.', 'err');
  }
});

// ---------- Botar ----------

const WEEKDAYS = ['söndag', 'måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag'];

function describeSchedule(sch) {
  if (!sch) return 'Manuellt';
  if (sch.type === 'interval') return sch.everyMinutes % 60 === 0 ? `Var ${sch.everyMinutes / 60}:e timme` : `Var ${sch.everyMinutes}:e minut`;
  if (sch.type === 'daily') return `Varje dag kl ${sch.time}`;
  if (sch.type === 'weekly') return `Varje ${WEEKDAYS[sch.weekday]} kl ${sch.time}`;
  return 'Manuellt';
}

function fmtTime(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  return d.toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' });
}

async function loadBots() {
  const list = $('#bots-list');
  try {
    const data = await api('/api/bots');
    state.bots = data.bots;
    renderBotTemplates(data.templates);
    if (!data.bots.length) {
      list.innerHTML = `<div class="panel bots-empty">
        <div style="font-size:34px">🤖</div>
        <h3>Inga botar ännu</h3>
        <p class="view-sub">Klicka <strong>+ Ny bot</strong>, välj en mall nedan – eller be AI-assistenten: <em>"Skapa en bot som…"</em></p>
      </div>`;
      return;
    }
    list.innerHTML = data.bots.map((b) => {
      const last = b.runs && b.runs[0];
      return `
      <div class="bot-card ${b.enabled ? '' : 'paused'}" data-id="${b.id}">
        <div class="bot-head">
          <span class="bot-emoji">${escapeHtml(b.emoji || '🤖')}</span>
          <div class="bot-title">
            <div class="bot-name">${escapeHtml(b.name)}</div>
            <div class="bot-meta">
              <span class="badge ${b.enabled ? 'badge-green' : ''}">${b.running ? '⟳ kör…' : (b.enabled ? '● aktiv' : '◌ pausad')}</span>
              <span class="badge badge-purple">⏱ ${escapeHtml(describeSchedule(b.schedule))}</span>
              <span class="bot-last">Senast: ${fmtTime(b.lastRunAt)}${last ? ` · ${last.status === 'ok' ? '✓' : last.status === 'error' ? '✗' : '…'}` : ''}</span>
            </div>
          </div>
          <div class="bot-actions">
            <button class="btn btn-primary btn-sm bot-run" ${b.running ? 'disabled' : ''}>▶ Kör nu</button>
            <button class="btn btn-ghost btn-sm bot-toggle">${b.enabled ? 'Pausa' : 'Aktivera'}</button>
            <button class="btn btn-ghost btn-sm bot-edit">Redigera</button>
            <button class="btn btn-danger-ghost btn-sm bot-delete">Ta bort</button>
          </div>
        </div>
        <div class="bot-instr">${escapeHtml(b.instructions).slice(0, 400)}${b.instructions.length > 400 ? '…' : ''}</div>
        ${last ? `
        <details class="bot-runs">
          <summary>Körlogg (${b.runs.length})</summary>
          ${b.runs.map((r) => `
            <div class="bot-run ${r.status}">
              <div class="bot-run-head">
                <span>${r.status === 'ok' ? '✓' : r.status === 'error' ? '✗' : '⟳'} ${fmtTime(r.startedAt)}</span>
                <span class="bot-run-meta">${escapeHtml(r.trigger || '')}${r.model ? ' · ' + escapeHtml(r.model) : ''}${r.durationMs ? ' · ' + Math.round(r.durationMs / 1000) + 's' : ''}${r.tools && r.tools.length ? ' · verktyg: ' + r.tools.map((t) => escapeHtml(t.name)).join(', ') : ''}</span>
              </div>
              <div class="bot-run-out">${r.error ? `<span style="color:var(--red)">${escapeHtml(r.error)}</span>` : renderMarkdown(r.output || '')}</div>
            </div>`).join('')}
        </details>` : ''}
      </div>`;
    }).join('');

    $$('.bot-card', list).forEach((card) => {
      const id = card.dataset.id;
      const bot = state.bots.find((b) => b.id === id);
      $('.bot-run', card).addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = '⟳ Kör…';
        toast(`${bot.name} kör – resultatet dyker upp i körloggen.`);
        try {
          const r = await api(`/api/bots/${id}/run`, { method: 'POST', body: {} });
          toast(r.ok ? `✓ ${bot.name} klar` : `✗ ${bot.name}: ${r.run?.error || 'fel'}`, r.ok ? 'ok' : 'err');
        } catch (err) {
          toast(err.message, 'err');
        }
        loadBots();
      });
      $('.bot-toggle', card).addEventListener('click', async () => {
        await api(`/api/bots/${id}`, { method: 'PUT', body: { enabled: !bot.enabled } });
        loadBots();
      });
      $('.bot-edit', card).addEventListener('click', () => openBotEditor(bot));
      $('.bot-delete', card).addEventListener('click', async () => {
        if (!confirm(`Ta bort boten "${bot.name}"?`)) return;
        await api(`/api/bots/${id}`, { method: 'DELETE' });
        toast('Bot borttagen');
        loadBots();
      });
    });
  } catch (err) {
    list.innerHTML = `<div class="skeleton">Kunde inte hämta botar: ${escapeHtml(err.message)}</div>`;
  }
}

function renderBotTemplates(templates) {
  const wrap = $('#bot-templates');
  wrap.innerHTML = (templates || []).map((t, i) => `
    <button class="flow" data-template="${i}">
      <span class="flow-icon">${t.emoji}</span>
      <span class="flow-title">${escapeHtml(t.name)}</span>
      <span class="flow-desc">${escapeHtml(describeSchedule(t.schedule))} · ${escapeHtml(t.instructions.slice(0, 70))}…</span>
    </button>`).join('');
  $$('[data-template]', wrap).forEach((btn) => {
    btn.addEventListener('click', () => openBotEditor({ ...templates[+btn.dataset.template], id: '' }));
  });
}

function syncScheduleFields() {
  const t = $('#bot-schedule-type').value;
  $('#bot-interval-row').style.display = t === 'interval' ? '' : 'none';
  $('#bot-time-row').style.display = t === 'daily' || t === 'weekly' ? '' : 'none';
  $('#bot-weekday-row').style.display = t === 'weekly' ? '' : 'none';
}
$('#bot-schedule-type').addEventListener('change', syncScheduleFields);

async function fillBotModelSelect(providerId, model) {
  await ensureModelsLoaded();
  const sel = $('#bot-model');
  const groups = Object.entries(state.models).filter(([, p]) => p.models.length && p.hasKey);
  const cur = providerId && model ? `${providerId}::${model}` : `${state.providerId}::${state.model}`;
  sel.innerHTML = '<option value="">Samma som chatten / standard</option>' + groups.map(([id, p]) => `
    <optgroup label="${p.emoji} ${escapeHtml(p.name)}">
      ${p.models.map((m) => `<option value="${id}::${m}" ${`${id}::${m}` === cur ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')}
    </optgroup>`).join('');
}

async function openBotEditor(bot = null) {
  const ed = $('#bot-editor');
  ed.style.display = 'block';
  $('#bot-editor-title').textContent = bot && bot.id ? `Redigera: ${bot.name}` : 'Ny bot';
  $('#bot-id').value = (bot && bot.id) || '';
  $('#bot-emoji').value = (bot && bot.emoji) || '🤖';
  $('#bot-name').value = (bot && bot.name) || '';
  $('#bot-instructions').value = (bot && bot.instructions) || '';
  const sch = (bot && bot.schedule) || { type: 'manual' };
  $('#bot-schedule-type').value = sch.type || 'manual';
  $('#bot-every').value = sch.everyMinutes || 60;
  $('#bot-time').value = sch.time || '08:00';
  $('#bot-weekday').value = sch.weekday != null ? sch.weekday : 1;
  $('#bot-describe-input').value = '';
  $('#bot-describe-msg').textContent = '';
  $('#bot-form-result').textContent = '';
  syncScheduleFields();
  await fillBotModelSelect(bot && bot.providerId, bot && bot.model);
  ed.scrollIntoView({ behavior: 'smooth', block: 'start' });
  (bot && bot.id ? $('#bot-instructions') : $('#bot-describe-input')).focus();
}

function readBotForm() {
  const type = $('#bot-schedule-type').value;
  const mv = $('#bot-model').value;
  const i = mv.indexOf('::');
  return {
    name: $('#bot-name').value.trim(),
    emoji: $('#bot-emoji').value.trim() || '🤖',
    instructions: $('#bot-instructions').value.trim(),
    schedule: {
      type,
      everyMinutes: +$('#bot-every').value || 60,
      time: $('#bot-time').value || '08:00',
      weekday: +$('#bot-weekday').value
    },
    providerId: i > 0 ? mv.slice(0, i) : state.providerId,
    model: i > 0 ? mv.slice(i + 2) : state.model
  };
}

async function saveBot(runAfter) {
  const result = $('#bot-form-result');
  const data = readBotForm();
  if (!data.name || !data.instructions) {
    result.textContent = 'Fyll i namn och instruktion.';
    result.className = 'form-result err';
    return;
  }
  result.textContent = 'Sparar…';
  result.className = 'form-result';
  try {
    const id = $('#bot-id').value;
    const r = id
      ? await api(`/api/bots/${id}`, { method: 'PUT', body: data })
      : await api('/api/bots', { method: 'POST', body: data });
    toast(`✓ Bot sparad: ${r.bot.name}`);
    $('#bot-editor').style.display = 'none';
    if (runAfter) {
      toast(`${r.bot.name} kör nu…`);
      api(`/api/bots/${r.bot.id}/run`, { method: 'POST', body: {} })
        .then((x) => { toast(x.ok ? `✓ ${r.bot.name} klar` : `✗ ${x.run?.error || 'fel'}`, x.ok ? 'ok' : 'err'); loadBots(); })
        .catch((e) => toast(e.message, 'err'));
    }
    loadBots();
  } catch (err) {
    result.textContent = err.message;
    result.className = 'form-result err';
  }
}

$('#new-bot-btn').addEventListener('click', () => openBotEditor());
$('#bot-editor-close').addEventListener('click', () => { $('#bot-editor').style.display = 'none'; });
$('#bot-form').addEventListener('submit', (e) => { e.preventDefault(); saveBot(false); });
$('#bot-save-run-btn').addEventListener('click', () => saveBot(true));

$('#bot-describe-btn').addEventListener('click', async () => {
  const desc = $('#bot-describe-input').value.trim();
  const msg = $('#bot-describe-msg');
  if (!desc) { msg.textContent = 'Skriv först vad boten ska göra.'; return; }
  await ensureModelsLoaded();
  if (!state.model) { msg.textContent = 'Lägg till en AI-nyckel under Integrationer först.'; return; }
  msg.textContent = '✦ AI:n skriver förslag…';
  const btn = $('#bot-describe-btn');
  btn.disabled = true;
  try {
    const r = await api('/api/bots/draft', { method: 'POST', body: { description: desc, providerId: state.providerId, model: state.model } });
    const d = r.draft || {};
    if (d.name) $('#bot-name').value = d.name;
    if (d.emoji) $('#bot-emoji').value = d.emoji;
    if (d.instructions) $('#bot-instructions').value = d.instructions;
    if (d.schedule && d.schedule.type) {
      $('#bot-schedule-type').value = d.schedule.type;
      if (d.schedule.everyMinutes) $('#bot-every').value = d.schedule.everyMinutes;
      if (d.schedule.time) $('#bot-time').value = String(d.schedule.time).padStart(5, '0');
      if (d.schedule.weekday != null) $('#bot-weekday').value = d.schedule.weekday;
      syncScheduleFields();
    }
    msg.textContent = '✓ Förslag ifyllt – justera och spara.';
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// Shopify-formulär
$('#shopify-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const store = $('#shopify-store').value.trim();
  const token = $('#shopify-token').value.trim();
  const result = $('#shopify-result');
  result.className = 'form-result';
  result.textContent = 'Sparar…';
  try {
    const patch = { shopify: { store } };
    if (token) patch.shopify.token = token;
    state.settings = await api('/api/settings', { method: 'PUT', body: patch });
    $('#shopify-token').value = '';
    result.textContent = '✓ Sparat!';
    result.className = 'form-result ok';
    toast('Shopify-koppling sparad');
    loadIntegrationer();
    loadOverview();
  } catch (err) {
    result.textContent = err.message;
    result.className = 'form-result err';
  }
});

$('#shopify-test').addEventListener('click', async () => {
  const result = $('#shopify-result');
  result.className = 'form-result';
  result.textContent = 'Testar anslutning…';
  try {
    // Spara det som står i formuläret först
    const store = $('#shopify-store').value.trim();
    const token = $('#shopify-token').value.trim();
    const patch = { shopify: { store } };
    if (token) patch.shopify.token = token;
    await api('/api/settings', { method: 'PUT', body: patch });
    $('#shopify-token').value = '';

    const r = await api('/api/shopify/test', { method: 'POST', body: {} });
    result.textContent = r.message || '✓ Fungerar!';
    result.className = 'form-result ok';
    toast(r.message || 'Anslutningen fungerar!');
    loadIntegrationer();
    loadOverview();
  } catch (err) {
    result.textContent = `✗ ${err.message}`;
    result.className = 'form-result err';
  }
});

$('#shopify-clear').addEventListener('click', async () => {
  try {
    await api('/api/settings', { method: 'PUT', body: { shopify: { store: null, token: null } } });
    toast('Shopify-bortkopplad');
    loadIntegrationer();
    loadOverview();
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#allow-destructive').addEventListener('change', async (e) => {
  try {
    state.settings = await api('/api/settings', {
      method: 'PUT',
      body: { allowDestructive: e.target.checked }
    });
    toast(e.target.checked ? '⚠ Raderingar tillåtna' : 'Raderingar avstängda');
  } catch (err) {
    toast(err.message, 'err');
  }
});

// ---------- Modeller ----------

async function loadModels() {
  const list = $('#models-list');
  list.innerHTML = '<div class="skeleton">Hämtar modeller…</div>';
  try {
    const data = await api('/api/models');
    const q = ($('#model-search').value || '').toLowerCase();
    list.innerHTML = data.providers.map((p) => {
      const models = p.models.filter((m) => !q || m.toLowerCase().includes(q));
      if (!models.length && q) return '';
      return `
        <div class="model-group">
          <div class="model-group-head">
            <span>${p.emoji}</span> ${escapeHtml(p.name)}
            ${p.hasKey ? '<span class="badge badge-green">Ansluten</span>' : '<span class="badge">Nyckel saknas</span>'}
            <span class="badge">${models.length} modeller${p.source === 'fallback' ? ' (standardlista)' : ''}</span>
          </div>
          <div class="model-chips">
            ${models.map((m) => `<span class="model-chip" data-provider="${p.provider}" data-model="${escapeHtml(m)}" title="Klicka för att välja i chatten">${escapeHtml(m)}</span>`).join('') || '<span class="skeleton">Inga modeller matchar sökningen.</span>'}
          </div>
        </div>`;
    }).join('') || '<div class="skeleton">Inga modeller matchar sökningen.</div>';

    $$('.model-chip', list).forEach((chip) => {
      chip.addEventListener('click', () => {
        state.providerId = chip.dataset.provider;
        state.model = chip.dataset.model;
        localStorage.setItem('af_provider', state.providerId);
        localStorage.setItem('af_model', state.model);
        renderModelSelect();
        toast(`Vald modell: ${state.model}`);
        location.hash = '#/assistent';
      });
    });
  } catch (err) {
    list.innerHTML = `<div class="skeleton">Kunde inte hämta modeller: ${escapeHtml(err.message)}</div>`;
  }
}

$('#model-search').addEventListener('input', () => loadModels());
$('#reload-models').addEventListener('click', () => loadModels());

// ---------- Modellväljare (chatt) ----------

async function ensureModelsLoaded() {
  if (Object.keys(state.models).length) return;
  try {
    const s = await api('/api/settings');
    state.settings = s;
    const data = await api('/api/models');
    for (const p of data.providers) {
      state.models[p.provider] = { name: p.name, emoji: p.emoji, hasKey: p.hasKey, models: p.models };
    }
  } catch { /* tyst */ }
}

async function renderModelSelect() {
  await ensureModelsLoaded();
  const sel = $('#model-select');
  const groups = Object.entries(state.models).filter(([, p]) => p.models.length);
  if (!groups.length) {
    sel.innerHTML = '<option value="">Inga modeller – lägg till nyckel under Integrationer</option>';
    return;
  }
  // Behåll val om möjligt
  if (!state.model || !groups.some(([id, p]) => id === state.providerId && p.models.includes(state.model))) {
    // Försök hitta default från inställningar
    const def = state.settings && state.settings.defaultModel;
    if (def) {
      for (const [id, p] of groups) {
        if (p.models.includes(def)) { state.providerId = id; state.model = def; break; }
      }
    }
    if (!state.model || !groups.some(([id, p]) => id === state.providerId && p.models.includes(state.model))) {
      // Välj första tillgängliga nyckel-leverantör
      const first = groups.find(([, p]) => p.hasKey) || groups[0];
      state.providerId = first[0];
      state.model = first[1].models[0];
    }
    localStorage.setItem('af_provider', state.providerId);
    localStorage.setItem('af_model', state.model);
  }

  sel.innerHTML = groups.map(([id, p]) => `
    <optgroup label="${p.emoji} ${escapeHtml(p.name)}${p.hasKey ? '' : ' (nyckel saknas)'}">
      ${p.models.map((m) => `<option value="${id}::${m}" ${id === state.providerId && m === state.model ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')}
    </optgroup>`).join('');
}

$('#model-select').addEventListener('change', (e) => {
  const v = e.target.value;
  const i = v.indexOf('::');
  const providerId = v.slice(0, i);
  const model = v.slice(i + 2);
  state.providerId = providerId;
  state.model = model;
  localStorage.setItem('af_provider', providerId);
  localStorage.setItem('af_model', model);
});

// ---------- Chatt ----------

function chatScroll() {
  const chat = $('#chat');
  chat.scrollTop = chat.scrollHeight;
}

function appendUserMessage(text) {
  const el = document.createElement('div');
  el.className = 'msg user';
  el.innerHTML = `
    <div class="msg-avatar">J</div>
    <div class="msg-bubble"><div class="msg-text">${renderMarkdown(text)}</div></div>`;
  $('#chat').appendChild(el);
  chatScroll();
}

function createAssistantMessage() {
  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.innerHTML = `
    <div class="msg-avatar">✦</div>
    <div class="msg-bubble">
      <div class="msg-tools"></div>
      <div class="msg-text"><div class="typing"><span></span><span></span><span></span></div></div>
    </div>`;
  $('#chat').appendChild(el);
  chatScroll();
  return el;
}

function addToolCard(container, name, args) {
  const details = document.createElement('details');
  details.className = 'tool-card';
  details.open = true;
  details.innerHTML = `
    <summary>
      <span class="tool-icon">⚙</span>
      <span class="tool-name">${escapeHtml(name)}</span>
      <span class="tool-status run">kör…</span>
    </summary>
    <div class="tool-detail">
      <div class="tool-args">Anropar: ${escapeHtml(JSON.stringify(args).slice(0, 400))}</div>
      <div class="tool-result"></div>
    </div>`;
  container.appendChild(details);
  chatScroll();
  return details;
}

function finalizeToolCard(card, ok, summary) {
  const status = $('.tool-status', card);
  status.textContent = ok ? '✓ klar' : '✗ fel';
  status.className = `tool-status ${ok ? 'ok' : 'err'}`;
  $('.tool-result', card).textContent = String(summary || '').slice(0, 1500);
  if (ok) card.open = false;
  chatScroll();
}

function setAssistantText(el, text) {
  const textEl = $('.msg-text', el);
  if (!text) {
    textEl.innerHTML = '<span style="color:var(--text-faint)">…</span>';
  } else {
    textEl.innerHTML = renderMarkdown(text);
  }
  chatScroll();
}

async function sendMessage(text) {
  if (state.busy || !text.trim()) return;
  const chat = $('#chat');
  $('#chat-empty')?.remove();

  state.messages.push({ role: 'user', content: text.trim() });
  appendUserMessage(text.trim());

  state.busy = true;
  $('#send-btn').disabled = true;
  $('#chat-input').value = '';
  autoGrow();

  const asst = createAssistantMessage();
  const toolsWrap = $('.msg-tools', asst);
  let accText = '';
  setAssistantText(asst, '');

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        providerId: state.providerId,
        model: state.model,
        messages: state.messages
      })
    });

    if (res.status === 401) {
      throw new ApiError('API:t kräver en åtkomstnyckel (APP_API_KEY).', 401);
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || data.error || `Fel ${res.status}`);
    }

    // SSE-parsning
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let pendingCards = {};

    const handleEvent = (event, data) => {
      switch (event) {
        case 'delta':
          accText += data.text;
          setAssistantText(asst, accText);
          break;
        case 'tool_start':
          pendingCards[data.id] = addToolCard(toolsWrap, data.name, data.args);
          break;
        case 'tool_end':
          if (pendingCards[data.id]) {
            finalizeToolCard(pendingCards[data.id], data.ok, data.summary);
          }
          break;
        case 'error':
          throw new Error(data.message);
        case 'done':
          break;
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop();
      for (const chunk of chunks) {
        let event = 'message';
        let data = '';
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (data) {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch { parsed = null; }
          if (parsed) handleEvent(event, parsed);
        }
      }
    }

    if (!accText) setAssistantText(asst, 'Inget svar från modellen. Försök igen eller byt modell.');
    state.messages.push({ role: 'assistant', content: accText || '(inget svar)' });
  } catch (err) {
    setAssistantText(asst, `⚠ ${err.message}`);
    toast(err.message, 'err');
    if (err.status === 401) lockApp(err.message);
  } finally {
    state.busy = false;
    $('#send-btn').disabled = false;
    chatScroll();
    $('#chat-input').focus();
  }
}

function autoGrow() {
  const ta = $('#chat-input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
}

$('#chat-input').addEventListener('input', autoGrow);
$('#chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage(e.target.value);
  }
});
$('#send-btn').addEventListener('click', () => sendMessage($('#chat-input').value));

$('#clear-chat').addEventListener('click', () => {
  state.messages = [];
  const chat = $('#chat');
  chat.innerHTML = `
    <div class="chat-empty" id="chat-empty">
      <div class="chat-empty-icon">✦</div>
      <h2>Chatten är rensad!</h2>
      <p>Vad vill du göra härnäst?</p>
      <div class="chat-suggestions">
        <button class="chip" data-prompt="Sammanfatta mina olästa mejl.">Sammanfatta olästa mejl</button>
        <button class="chip" data-prompt="Vad har jag i kalendern idag?">Dagens kalender</button>
        <button class="chip" data-prompt="Skapa en bot som varje måndag kl 08:00 lägger veckans försäljning i ett Google Sheet.">Skapa en veckorapport-bot</button>
      </div>
    </div>`;
  bindPromptButtons();
});

function bindPromptButtons() {
  $$('[data-prompt]').forEach((btn) => {
    btn.onclick = () => {
      const prompt = btn.dataset.prompt;
      if (location.hash.replace('#/', '') !== 'assistent') {
        location.hash = '#/assistent';
        setTimeout(() => sendMessage(prompt), 150);
      } else {
        sendMessage(prompt);
      }
    };
  });
}

// ---------- Init ----------

/** Startar appen efter att API-nyckeln (om någon krävs) fungerar. */
async function startApp() {
  unlockApp();
  bindPromptButtons();
  navigate();
  try {
    const data = await api('/api/providers');
    state.providers = data.providers;
    setSidebarStatus('warn', 'Kontrollerar kopplingar…');
  } catch (err) {
    if (err.status !== 401) setSidebarStatus('warn', 'Servern svarar inte');
  }
  loadOverview();
  loadSetupPanel();
}

$('#lock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = $('#lock-key').value.trim();
  if (!key) return;
  setApiKey(key);
  try {
    await api('/api/setup');
    $('#lock-key').value = '';
    toast('Upplåst ✓');
    startApp();
  } catch (err) {
    setApiKey('');
    $('#lock-msg').textContent = err.status === 401 ? 'Nyckeln stämmer inte. Kontrollera APP_API_KEY i Render → Environment.' : err.message;
  }
});

$('#lock-logout')?.addEventListener('click', () => {
  setApiKey('');
  lockApp('Nyckeln är borttagen från webbläsaren.');
});

// Länkar som ska scrolla till en panel i stället för att byta sida
document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-goto]');
  if (!link) return;
  const target = $(`#${link.dataset.goto}-panel`);
  if (target) setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
});

async function init() {
  const unlocked = await ensureUnlocked();
  if (!unlocked) return; // låsskärmen tar över
  startApp();
}

init();

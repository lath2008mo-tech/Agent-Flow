/**
 * Testhjälpare: temp-kataloger, "omstart" av servern (ren modulcache), miljö
 * och väntan på HTTP.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const SERVER_DIR = path.join(ROOT, 'server');

/** Skapar en tom temp-katalog (simulerar Renders tillfälliga disk). */
function tempDataDir(label = 'test') {
  const dir = path.join(os.tmpdir(), `agent-flow-${label}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Simulerar en omstart: rensar modulcachen och läser in servermodulerna på
 * nytt (samma process, men utan minnescache – precis som en ny instans).
 */
function freshServer() {
  for (const file of fs.readdirSync(SERVER_DIR)) {
    if (file.endsWith('.js')) delete require.cache[path.join(SERVER_DIR, file)];
  }
  const mod = (name) => require(path.join(SERVER_DIR, name));
  return {
    settings: mod('settings.js'),
    store: mod('store.js'),
    secure: mod('secure.js'),
    google: mod('google.js'),
    auth: mod('auth.js'),
    setup: mod('setup.js'),
    bots: mod('bots.js'),
    env: mod('env.js')
  };
}

/** Sätter miljövariabler och återställer dem efter testet. */
function withEnv(vars, fn) {
  const before = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  const restore = () => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const result = fn();
  if (result && typeof result.then === 'function') return result.finally(restore);
  restore();
  return result;
}

/** Väntar tills fn() returnerar något truthy eller tiden tar slut. */
async function waitFor(fn, { timeout = 8000, interval = 100, label = 'villkoret' } = {}) {
  const deadline = Date.now() + timeout;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Tidsgränsen nåddes i väntan på ${label}${lastErr ? ` (${lastErr.message})` : ''}`);
}

/** Startar en riktig serverprocess (node server/index.js) för e2e-tester. */
function startServer({ port, env }) {
  const child = spawn(process.execPath, [path.join(SERVER_DIR, 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  return {
    child,
    get output() { return output; },
    base: `http://127.0.0.1:${port}`,
    async waitUntilReady(timeout = 15000) {
      await waitFor(async () => {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        return res.ok;
      }, { timeout, label: 'servern startade' }).catch((err) => {
        throw new Error(`${err.message}\n--- serverutdata ---\n${output}`);
      });
      return this;
    },
    async stop(signal = 'SIGTERM') {
      if (child.exitCode !== null) return child.exitCode;
      const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
      child.kill(signal);
      const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 5000))]);
      if (code === null) child.kill('SIGKILL');
      return code;
    }
  };
}

/** Kör ett litet skript i en separat process (t.ex. för att seeda data). */
function runScript(file, { env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { cwd: ROOT, env: { ...process.env, ...env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`Skriptet misslyckades (${code}):\n${out}\n${err}`))));
  });
}

function randomPort() {
  return 39000 + Math.floor(Math.random() * 8000);
}

module.exports = { ROOT, SERVER_DIR, tempDataDir, freshServer, withEnv, waitFor, startServer, runScript, randomPort };

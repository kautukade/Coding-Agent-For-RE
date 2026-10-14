import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const stateRoot = path.join(localAppData, 'RE-Coding-Agent');
const configRoot = path.join(stateRoot, 'config');
const logRoot = path.join(stateRoot, 'logs');
const stateFile = path.join(stateRoot, 'state.json');
const settingsFile = path.join(configRoot, 'dashboard-settings.json');
const secretsFile = path.join(configRoot, 'provider-secrets.json');
const routerLog = path.join(logRoot, 'router.jsonl');
const routerScript = path.join(__dirname, 'router.mjs');
const routerPort = 17322;
const defaultPort = 17321;

const PROVIDERS = {
  nvidia: {
    id: 'nvidia-nim', name: 'NVIDIA NIM', env: 'NVIDIA_API_KEY',
    baseURL: 'https://integrate.api.nvidia.com/v1', model: 'nvidia/nemotron-3-super-120b-a12b',
    context: 131072, output: 16384,
  },
  openrouter: {
    id: 'openrouter', name: 'OpenRouter', env: 'OPENROUTER_API_KEY',
    baseURL: 'https://openrouter.ai/api/v1', model: 'openrouter/free',
    context: 200000, output: 16384,
  },
  huggingface: {
    id: 'huggingface', name: 'Hugging Face', env: 'HF_TOKEN',
    baseURL: 'https://router.huggingface.co/v1', model: 'openai/gpt-oss-120b:fastest',
    context: 131072, output: 16384,
  },
  custom: {
    id: 'custom-openai', name: 'Custom OpenAI-compatible', env: 'CUSTOM_API_KEY',
    baseURL: '', model: '', context: 131072, output: 16384,
  },
};

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}
function getState() { return readJson(stateFile, {}); }
function getSecrets() { return readJson(secretsFile, {}); }
function masked(secret) {
  if (!secret) return '';
  if (secret.length <= 8) return '••••••••';
  return `••••••••${secret.slice(-4)}`;
}
function defaultSettings() {
  return {
    routing: {
      mode: 'hybrid-auto',
      strategy: 'balanced',
      fallbackEnabled: true,
      cloudForTools: true,
      cloudForReverseEngineering: true,
      simplePromptChars: 5000,
      providerOrder: ['nvidia', 'openrouter', 'huggingface', 'custom'],
    },
    providers: Object.fromEntries(Object.entries(PROVIDERS).map(([key, p]) => [key, {
      enabled: false, model: p.model, baseURL: p.baseURL, context: p.context, output: p.output,
    }])),
  };
}
function getSettings() {
  const d = defaultSettings();
  const s = readJson(settingsFile, {});
  return {
    ...d, ...s,
    routing: { ...d.routing, ...(s.routing || {}) },
    providers: { ...d.providers, ...(s.providers || {}) },
  };
}
function openCodeConfigPath() {
  const st = getState();
  return st.openCodeConfig || path.join(configRoot, 'opencode.json');
}
function lockDownSecrets() {
  if (process.platform !== 'win32' || !fs.existsSync(secretsFile)) return;
  const username = process.env.USERNAME;
  if (!username) return;
  try {
    spawnSync('icacls.exe', [secretsFile, '/inheritance:r', '/grant:r', `${username}:(R,W)`], { windowsHide: true, stdio: 'ignore' });
  } catch { }
}
function applyOpenCodeConfig() {
  const configPath = openCodeConfigPath();
  ensureDir(path.dirname(configPath));
  const config = readJson(configPath, {});
  config.$schema ||= 'https://opencode.ai/config.json';
  config.provider ||= {};

  // Cloud keys stay in the router; OpenCode only talks to localhost.
  for (const p of Object.values(PROVIDERS)) delete config.provider[p.id];
  config.provider['hybrid-router'] = {
    npm: '@ai-sdk/openai-compatible',
    name: 'RE Hybrid Router',
    options: { baseURL: `http://127.0.0.1:${routerPort}/v1`, apiKey: 'local-router' },
    models: {
      're-auto': { name: 'RE Auto — Local + Cloud' },
      're-local': { name: 'RE Local Only' },
      're-cloud': { name: 'RE Cloud Only' },
    },
  };
  config.model = 'hybrid-router/re-auto';
  writeJson(configPath, config);
  return config;
}
function buildRuntimeEnv() {
  const st = getState();
  return {
    ...process.env,
    OPENCODE_CONFIG: openCodeConfigPath(),
    OLLAMA_HOST: st.ollamaHost || process.env.OLLAMA_HOST || '127.0.0.1:11434',
    GHIDRA_INSTALL_DIR: st.ghidraInstallDir || process.env.GHIDRA_INSTALL_DIR || '',
    JAVA_HOME: st.javaHome || process.env.JAVA_HOME || '',
    REA_ANALYSIS_PROVIDER: 'ghidra',
    REA_GHIDRA_STARTUP_TIMEOUT_MS: '180000',
    RE_ROUTER_PORT: String(routerPort),
  };
}
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}
function normalizeOllamaHost(raw) {
  return String(raw || '127.0.0.1:11434').replace(/^https?:\/\//, '').replace(/^0\.0\.0\.0:/, '127.0.0.1:').replace(/^localhost:/, '127.0.0.1:');
}
async function ollamaStatus(st) {
  const host = normalizeOllamaHost(st.ollamaHost || process.env.OLLAMA_HOST);
  try {
    const response = await fetchWithTimeout(`http://${host}/api/tags`, {}, 2500);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    return { ok: true, host, models: (body.models || []).map((m) => m.name) };
  } catch (error) { return { ok: false, host, error: error.message }; }
}
async function routerStatus() {
  try {
    const response = await fetchWithTimeout(`http://127.0.0.1:${routerPort}/health`, {}, 1800);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { ok: true, ...(await response.json()), url: `http://127.0.0.1:${routerPort}` };
  } catch (error) { return { ok: false, error: error.message, url: `http://127.0.0.1:${routerPort}` }; }
}
function commandVersion(command, args = ['--version']) {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, env: buildRuntimeEnv(), timeout: 5000 });
    const text = `${result.stdout || ''}${result.stderr || ''}`.trim();
    return { ok: result.status === 0, value: text.split(/\r?\n/)[0] || 'installed' };
  } catch (error) { return { ok: false, value: error.message }; }
}
function reaIntegrationStatus() {
  const config = readJson(openCodeConfigPath(), {});
  const mcp = config.mcp || {};
  const rea = mcp.rea || mcp.servers?.rea;
  return {
    integrated: Boolean(rea && rea.enabled !== false),
    enabled: rea?.enabled !== false,
    ghidraEnvironment: Boolean(rea?.environment?.GHIDRA_INSTALL_DIR || getState().ghidraInstallDir),
  };
}
function readActivity(limit = 80) {
  try {
    const lines = fs.readFileSync(routerLog, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    return lines.slice(-Math.max(1, Math.min(Number(limit) || 80, 300))).reverse().map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}
async function systemStatus() {
  const st = getState();
  const s = getSettings();
  const sec = getSecrets();
  const ollama = await ollamaStatus(st);
  const router = await routerStatus();
  const rea = reaIntegrationStatus();
  const ghidraPath = st.ghidraInstallDir || '';
  const ghidraOk = Boolean(ghidraPath && fs.existsSync(path.join(ghidraPath, 'support', 'analyzeHeadless.bat')));
  const activity = readActivity(1)[0] || null;
  return {
    installed: fs.existsSync(stateFile), workspace: st.workspace || '', context: st.context || null,
    currentModel: readJson(openCodeConfigPath(), {}).model || 'hybrid-router/re-auto',
    routing: s.routing, router, lastRoute: activity,
    ollama, opencode: commandVersion('opencode'), reaCli: commandVersion('rea'), rea,
    ghidra: { ok: ghidraOk, path: ghidraPath },
    providers: Object.fromEntries(Object.entries(PROVIDERS).map(([key, p]) => [key, {
      enabled: Boolean(s.providers?.[key]?.enabled), configured: Boolean(sec[p.env]),
      model: s.providers?.[key]?.model || p.model, maskedKey: masked(sec[p.env]),
    }])),
    paths: { stateRoot, openCodeConfig: openCodeConfigPath(), settingsFile, routerLog },
  };
}
async function validateProvider(providerKey, secretOverride, settingsOverride = {}) {
  const provider = PROVIDERS[providerKey];
  if (!provider) throw new Error('Unknown provider.');
  const sec = getSecrets();
  const key = secretOverride || sec[provider.env];
  if (!key) throw new Error(`${provider.name} API key is not configured.`);
  const s = { ...(getSettings().providers?.[providerKey] || {}), ...settingsOverride };
  const baseURL = String(s.baseURL || provider.baseURL).replace(/\/$/, '');
  if (!baseURL) throw new Error('Base URL is required.');
  let url = `${baseURL}/models`;
  if (providerKey === 'openrouter' && baseURL.includes('openrouter.ai')) url = `${baseURL}/key`;
  if (providerKey === 'huggingface' && baseURL.includes('huggingface.co')) url = 'https://huggingface.co/api/whoami-v2';
  const response = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } }, 12000);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Provider returned HTTP ${response.status}${body ? `: ${body.slice(0, 180)}` : ''}`);
  }
  return { ok: true, message: `${provider.name} API key verified.` };
}
async function discoverModels(providerKey, secretOverride, settingsOverride = {}) {
  const provider = PROVIDERS[providerKey];
  if (!provider) throw new Error('Unknown provider.');
  const sec = getSecrets();
  const key = secretOverride || sec[provider.env];
  if (!key) throw new Error(`${provider.name} API key is not configured.`);
  const s = { ...(getSettings().providers?.[providerKey] || {}), ...settingsOverride };
  const baseURL = String(s.baseURL || provider.baseURL).replace(/\/$/, '');
  if (!baseURL) throw new Error('Base URL is required.');
  const response = await fetchWithTimeout(`${baseURL}/models`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } }, 15000);
  if (!response.ok) throw new Error(`Models endpoint returned HTTP ${response.status}`);
  const body = await response.json();
  const raw = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  const models = raw.map((m) => typeof m === 'string' ? m : m?.id || m?.name).filter(Boolean).slice(0, 500);
  return { ok: true, models };
}
function sanitizeSettingsPayload(body) {
  const current = getSettings();
  const validModes = ['hybrid-auto', 'local-only', 'cloud-only', 'local-first', 'cloud-first'];
  const validStrategies = ['balanced', 'quality', 'speed', 'privacy'];
  const incomingRouting = body.routing || {};
  const order = Array.isArray(incomingRouting.providerOrder) ? incomingRouting.providerOrder.filter((k) => PROVIDERS[k]) : current.routing.providerOrder;
  const next = {
    ...current,
    routing: {
      ...current.routing,
      mode: validModes.includes(incomingRouting.mode) ? incomingRouting.mode : current.routing.mode,
      strategy: validStrategies.includes(incomingRouting.strategy) ? incomingRouting.strategy : current.routing.strategy,
      fallbackEnabled: incomingRouting.fallbackEnabled !== false,
      cloudForTools: incomingRouting.cloudForTools !== false,
      cloudForReverseEngineering: incomingRouting.cloudForReverseEngineering !== false,
      simplePromptChars: Math.max(500, Math.min(Number(incomingRouting.simplePromptChars || current.routing.simplePromptChars || 5000), 200000)),
      providerOrder: [...new Set([...order, ...Object.keys(PROVIDERS)])],
    },
    providers: { ...current.providers },
  };
  for (const [key, definition] of Object.entries(PROVIDERS)) {
    const incoming = body.providers?.[key] || {};
    const previous = current.providers?.[key] || {};
    next.providers[key] = {
      enabled: Boolean(incoming.enabled),
      model: String(incoming.model ?? previous.model ?? definition.model).trim(),
      baseURL: String(incoming.baseURL ?? previous.baseURL ?? definition.baseURL).trim(),
      context: Math.max(4096, Number(incoming.context || previous.context || definition.context)),
      output: Math.max(1024, Number(incoming.output || previous.output || definition.output)),
    };
  }
  return next;
}
function saveSettingsAndSecrets(body) {
  const s = sanitizeSettingsPayload(body);
  const sec = getSecrets();
  for (const [key, definition] of Object.entries(PROVIDERS)) {
    const incoming = body.providers?.[key] || {};
    if (incoming.clearKey === true) delete sec[definition.env];
    else if (typeof incoming.apiKey === 'string' && incoming.apiKey.trim()) sec[definition.env] = incoming.apiKey.trim();
  }
  writeJson(settingsFile, s);
  writeJson(secretsFile, sec);
  lockDownSecrets();
  const config = applyOpenCodeConfig();
  return { settings: s, configModel: config.model };
}
function launchDetached(file, args = [], options = {}) {
  const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false, env: buildRuntimeEnv(), ...options });
  child.unref();
}
function openBrowser(url) {
  if (process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
}
async function ensureRouterRunning() {
  const status = await routerStatus();
  if (status.ok) return true;
  if (!fs.existsSync(routerScript)) return false;
  launchDetached(process.execPath, [routerScript], { cwd: repoRoot, windowsHide: true });
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if ((await routerStatus()).ok) return true;
  }
  return false;
}
function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}
function html(res, content) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(content), 'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:;",
  });
  res.end(content);
}
async function readBody(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1024 * 1024) throw new Error('Request too large.');
  }
  return data ? JSON.parse(data) : {};
}

const indexPath = path.join(__dirname, 'index.html');
ensureDir(configRoot); ensureDir(logRoot); applyOpenCodeConfig();

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = requestUrl.pathname;
    if (req.method === 'GET' && pathname === '/') return html(res, fs.readFileSync(indexPath, 'utf8'));
    if (req.method === 'GET' && pathname === '/api/status') return json(res, 200, await systemStatus());
    if (req.method === 'GET' && pathname === '/api/activity') return json(res, 200, { events: readActivity(requestUrl.searchParams.get('limit') || 80) });
    if (req.method === 'GET' && pathname === '/api/settings') {
      const s = getSettings(); const sec = getSecrets();
      return json(res, 200, {
        ...s,
        providers: Object.fromEntries(Object.entries(PROVIDERS).map(([key, p]) => [key, {
          ...s.providers[key], configured: Boolean(sec[p.env]), maskedKey: masked(sec[p.env]), displayName: p.name, defaultModel: p.model,
        }])),
      });
    }
    if (req.method === 'POST' && pathname === '/api/settings') {
      const saved = saveSettingsAndSecrets(await readBody(req));
      await ensureRouterRunning();
      return json(res, 200, { ok: true, message: 'Hybrid configuration saved and applied.', defaultModel: saved.configModel });
    }
    if (req.method === 'POST' && pathname === '/api/test-provider') {
      const body = await readBody(req);
      return json(res, 200, await validateProvider(body.provider, body.apiKey, { baseURL: body.baseURL }));
    }
    if (req.method === 'POST' && pathname === '/api/discover-models') {
      const body = await readBody(req);
      return json(res, 200, await discoverModels(body.provider, body.apiKey, { baseURL: body.baseURL }));
    }
    if (req.method === 'POST' && pathname === '/api/launch-agent') {
      applyOpenCodeConfig(); await ensureRouterRunning();
      const launcher = path.join(repoRoot, 'START-RE-AGENT.bat');
      if (!fs.existsSync(launcher)) throw new Error('START-RE-AGENT.bat is missing.');
      launchDetached('cmd.exe', ['/c', launcher], { cwd: repoRoot });
      return json(res, 200, { ok: true, message: 'RE Coding Agent launched.' });
    }
    if (req.method === 'POST' && pathname === '/api/open-workspace') {
      const st = getState(); if (!st.workspace) throw new Error('Workspace is not configured.');
      ensureDir(st.workspace); launchDetached('explorer.exe', [st.workspace]); return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && pathname === '/api/rea-doctor') {
      const result = spawnSync('rea', ['doctor', '--client', 'opencode', '--skill'], { encoding: 'utf8', windowsHide: true, env: buildRuntimeEnv(), timeout: 120000 });
      const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
      return json(res, result.status === 0 ? 200 : 500, { ok: result.status === 0, output: output || `rea doctor exited with code ${result.status}` });
    }
    if (req.method === 'POST' && pathname === '/api/refresh-config') {
      const config = applyOpenCodeConfig(); await ensureRouterRunning();
      return json(res, 200, { ok: true, model: config.model });
    }
    if (req.method === 'POST' && pathname === '/api/start-router') return json(res, 200, { ok: await ensureRouterRunning() });
    return json(res, 404, { ok: false, error: 'Not found.' });
  } catch (error) { return json(res, 500, { ok: false, error: error?.message || String(error) }); }
});

const portArgIndex = process.argv.indexOf('--port');
const port = portArgIndex >= 0 ? Number(process.argv[portArgIndex + 1]) || defaultPort : defaultPort;
const url = `http://127.0.0.1:${port}`;
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') { openBrowser(url); process.exit(0); }
  console.error(error); process.exit(1);
});
server.listen(port, '127.0.0.1', async () => {
  await ensureRouterRunning();
  console.log(`RE Coding Agent Dashboard: ${url}`);
  console.log('Localhost only. Close this window to stop the dashboard server.');
  if (process.argv.includes('--open')) openBrowser(url);
});

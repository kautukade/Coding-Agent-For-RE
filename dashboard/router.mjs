import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';

const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const stateRoot = path.join(localAppData, 'RE-Coding-Agent');
const configRoot = path.join(stateRoot, 'config');
const logRoot = path.join(stateRoot, 'logs');
const stateFile = path.join(stateRoot, 'state.json');
const settingsFile = path.join(configRoot, 'dashboard-settings.json');
const secretsFile = path.join(configRoot, 'provider-secrets.json');
const routerLog = path.join(logRoot, 'router.jsonl');
const port = Number(process.env.RE_ROUTER_PORT || 17322);
const host = '127.0.0.1';

const PROVIDERS = {
  nvidia: {
    name: 'NVIDIA NIM', env: 'NVIDIA_API_KEY',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    model: 'nvidia/nemotron-3-super-120b-a12b',
  },
  openrouter: {
    name: 'OpenRouter', env: 'OPENROUTER_API_KEY',
    baseURL: 'https://openrouter.ai/api/v1', model: 'openrouter/free',
  },
  huggingface: {
    name: 'Hugging Face', env: 'HF_TOKEN',
    baseURL: 'https://router.huggingface.co/v1', model: 'openai/gpt-oss-120b:fastest',
  },
};

const circuits = new Map();

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
function state() { return readJson(stateFile, {}); }
function secrets() { return readJson(secretsFile, {}); }
function defaults() {
  return {
    routing: {
      mode: 'hybrid-auto',
      strategy: 'balanced',
      fallbackEnabled: true,
      cloudForTools: true,
      cloudForReverseEngineering: true,
      simplePromptChars: 5000,
      providerOrder: ['nvidia', 'openrouter', 'huggingface'],
    },
    providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, p]) => [k, {
      enabled: false, model: p.model, baseURL: p.baseURL,
    }])),
  };
}
function settings() {
  const d = defaults();
  const s = readJson(settingsFile, {});
  return {
    ...d, ...s,
    routing: { ...d.routing, ...(s.routing || {}) },
    providers: { ...d.providers, ...(s.providers || {}) },
  };
}
function clientOllamaHost() {
  const raw = state().ollamaHost || process.env.OLLAMA_HOST || '127.0.0.1:11434';
  return raw.replace(/^https?:\/\//, '').replace(/^0\.0\.0\.0:/, '127.0.0.1:').replace(/^localhost:/, '127.0.0.1:');
}
function openCodeConfigPath() {
  return state().openCodeConfig || path.join(configRoot, 'opencode.json');
}
function ensureOpenCodeConfig() {
  const file = openCodeConfigPath();
  ensureDir(path.dirname(file));
  const config = readJson(file, {});
  config.$schema ||= 'https://opencode.ai/config.json';
  config.provider ||= {};
  config.provider['hybrid-router'] = {
    npm: '@ai-sdk/openai-compatible',
    name: 'RE Hybrid Router',
    options: {
      baseURL: `http://${host}:${port}/v1`,
      apiKey: 'local-router',
    },
    models: {
      're-auto': { name: 'RE Auto — Local + Cloud' },
      're-local': { name: 'RE Local Only' },
      're-cloud': { name: 'RE Cloud Only' },
    },
  };
  config.model = 'hybrid-router/re-auto';
  writeJson(file, config);
  return file;
}

function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part?.type === 'text') return part.text || '';
    return '';
  }).join('\n');
}
function requestSignals(body) {
  const text = (body.messages || []).map((m) => flattenContent(m.content)).join('\n').toLowerCase();
  const chars = text.length;
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const re = /\b(reverse engineer|reverse-engineer|rea\b|ghidra|decompile|disassembl|binary|dll\b|exe\b|apk\b|firmware|xrefs?|pseudocode|mcp tool)/i.test(text);
  const complex = /\b(architect|debug|refactor|analy[sz]e|investigat|trace|multi[- ]?step|root cause|implement|security review|compare)/i.test(text);
  return { chars, hasTools, reverseEngineering: re, complex };
}
function cloudConfigured(key, s, sec) {
  const p = PROVIDERS[key];
  return Boolean(p && s.providers?.[key]?.enabled && sec[p.env]);
}
function circuitOpen(key) {
  const c = circuits.get(key);
  return Boolean(c && c.until > Date.now());
}
function markFailure(key) {
  const current = circuits.get(key) || { count: 0, until: 0 };
  current.count += 1;
  if (current.count >= 3) current.until = Date.now() + 60_000;
  circuits.set(key, current);
}
function markSuccess(key) { circuits.delete(key); }

function cloudOrder(s, sec) {
  const order = Array.isArray(s.routing?.providerOrder) ? s.routing.providerOrder : defaults().routing.providerOrder;
  return [...new Set([...order, ...Object.keys(PROVIDERS)])]
    .filter((k) => cloudConfigured(k, s, sec) && !circuitOpen(k));
}
function candidateOrder(body) {
  const s = settings();
  const sec = secrets();
  const sig = requestSignals(body);
  const clouds = cloudOrder(s, sec);
  const requested = String(body.model || 're-auto');
  let mode = s.routing.mode || 'hybrid-auto';
  if (requested.endsWith('re-local')) mode = 'local-only';
  if (requested.endsWith('re-cloud')) mode = 'cloud-only';

  if (mode === 'local-only') return { mode, sig, candidates: ['local'] };
  if (mode === 'cloud-only') return { mode, sig, candidates: clouds };

  let cloudFirst = false;
  const strategy = s.routing.strategy || 'balanced';
  if (mode === 'cloud-first') cloudFirst = true;
  else if (mode === 'local-first') cloudFirst = false;
  else if (strategy === 'quality') cloudFirst = Boolean(clouds.length);
  else if (strategy === 'privacy') cloudFirst = false;
  else if (strategy === 'speed') cloudFirst = Boolean(clouds.length);
  else {
    cloudFirst = Boolean(
      clouds.length && (
        (s.routing.cloudForTools !== false && sig.hasTools) ||
        (s.routing.cloudForReverseEngineering !== false && sig.reverseEngineering) ||
        sig.complex || sig.chars > Number(s.routing.simplePromptChars || 5000)
      )
    );
  }

  const ordered = cloudFirst ? [...clouds, 'local'] : ['local', ...clouds];
  return { mode, sig, candidates: s.routing.fallbackEnabled === false ? ordered.slice(0, 1) : ordered };
}
function providerSpec(key) {
  if (key === 'local') {
    const st = state();
    return {
      key, name: 'Local Ollama', model: st.ollamaModel || 'rea-qwen-coder',
      url: `http://${clientOllamaHost()}/v1/chat/completions`, headers: {},
    };
  }
  const p = PROVIDERS[key];
  const s = settings().providers?.[key] || {};
  const sec = secrets();
  const baseURL = String(s.baseURL || p.baseURL).replace(/\/$/, '');
  return {
    key, name: p.name, model: s.model || p.model,
    url: `${baseURL}/chat/completions`,
    headers: { Authorization: `Bearer ${sec[p.env] || ''}` },
  };
}
function logEvent(event) {
  try {
    ensureDir(logRoot);
    fs.appendFileSync(routerLog, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, 'utf8');
    const stat = fs.statSync(routerLog);
    if (stat.size > 5 * 1024 * 1024) {
      const lines = fs.readFileSync(routerLog, 'utf8').trim().split(/\r?\n/).slice(-1000);
      fs.writeFileSync(routerLog, `${lines.join('\n')}\n`, 'utf8');
    }
  } catch { }
}
function shouldFallback(status) {
  return status === 401 || status === 403 || status === 408 || status === 409 || status === 429 || status >= 500;
}
async function proxyChat(req, res, body) {
  const decision = candidateOrder(body);
  if (!decision.candidates.length) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'No usable model provider is configured for the selected routing mode.' } }));
  }

  let lastError = 'No provider succeeded.';
  for (let i = 0; i < decision.candidates.length; i++) {
    const key = decision.candidates[i];
    const spec = providerSpec(key);
    const started = Date.now();
    try {
      const payload = { ...body, model: spec.model };
      const upstream = await fetch(spec.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...spec.headers },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(180_000),
      });
      if (!upstream.ok) {
        const text = await upstream.text();
        lastError = `${spec.name} HTTP ${upstream.status}: ${text.slice(0, 300)}`;
        markFailure(key);
        logEvent({ type: 'route-failure', provider: key, model: spec.model, status: upstream.status, latencyMs: Date.now() - started, mode: decision.mode });
        if (i < decision.candidates.length - 1 && shouldFallback(upstream.status)) continue;
        res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
        return res.end(text || JSON.stringify({ error: { message: lastError } }));
      }

      markSuccess(key);
      logEvent({
        type: 'route-success', provider: key, providerName: spec.name, model: spec.model,
        latencyMs: Date.now() - started, mode: decision.mode,
        signals: decision.sig,
      });
      const contentType = upstream.headers.get('content-type') || 'application/json';
      res.writeHead(upstream.status, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        ...(contentType.includes('text/event-stream') ? { Connection: 'keep-alive' } : {}),
      });
      if (!upstream.body) return res.end();
      return Readable.fromWeb(upstream.body).pipe(res);
    } catch (error) {
      lastError = `${spec.name}: ${error.message}`;
      markFailure(key);
      logEvent({ type: 'route-failure', provider: key, model: spec.model, error: error.message, latencyMs: Date.now() - started, mode: decision.mode });
    }
  }

  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: lastError } }));
}
async function readBody(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 25 * 1024 * 1024) throw new Error('Request body is too large.');
  }
  return data ? JSON.parse(data) : {};
}
async function localHealth() {
  try {
    const r = await fetch(`http://${clientOllamaHost()}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

ensureDir(configRoot);
ensureDir(logRoot);
ensureOpenCodeConfig();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${host}:${port}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      const s = settings();
      const sec = secrets();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({
        ok: true,
        mode: s.routing.mode,
        strategy: s.routing.strategy,
        local: await localHealth(),
        clouds: Object.fromEntries(Object.keys(PROVIDERS).map((k) => [k, cloudConfigured(k, s, sec)])),
      }));
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [
        { id: 're-auto', object: 'model', owned_by: 're-hybrid-router' },
        { id: 're-local', object: 'model', owned_by: 're-hybrid-router' },
        { id: 're-cloud', object: 'model', owned_by: 're-hybrid-router' },
      ] }));
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      return proxyChat(req, res, await readBody(req));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Not found' } }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: error.message || String(error) } }));
  }
});

server.listen(port, host, () => {
  console.log(`RE Hybrid Router listening on http://${host}:${port}`);
  console.log(`OpenCode config: ${openCodeConfigPath()}`);
});

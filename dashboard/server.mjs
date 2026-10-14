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
const stateFile = path.join(stateRoot, 'state.json');
const settingsFile = path.join(configRoot, 'dashboard-settings.json');
const secretsFile = path.join(configRoot, 'provider-secrets.json');
const defaultPort = 17321;

const PROVIDERS = {
  nvidia: {
    id: 'nvidia-nim',
    name: 'NVIDIA NIM',
    env: 'NVIDIA_API_KEY',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    model: 'nvidia/nemotron-3-super-120b-a12b',
    context: 131072,
    output: 16384,
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    env: 'OPENROUTER_API_KEY',
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'openrouter/free',
    context: 200000,
    output: 16384,
  },
  huggingface: {
    id: 'huggingface',
    name: 'Hugging Face',
    env: 'HF_TOKEN',
    baseURL: 'https://router.huggingface.co/v1',
    model: 'openai/gpt-oss-120b:fastest',
    context: 131072,
    output: 16384,
  },
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function lockDownSecrets() {
  if (process.platform !== 'win32' || !fs.existsSync(secretsFile)) return;
  const username = process.env.USERNAME;
  if (!username) return;
  try {
    spawnSync('icacls.exe', [secretsFile, '/inheritance:r', '/grant:r', `${username}:(R,W)`], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch {
    // Best effort; the dashboard never serves secret values back to the browser.
  }
}

function getState() {
  return readJson(stateFile, {});
}

function defaultSettings() {
  return {
    defaultProvider: 'local',
    providers: Object.fromEntries(
      Object.entries(PROVIDERS).map(([key, p]) => [
        key,
        {
          enabled: false,
          model: p.model,
          baseURL: p.baseURL,
        },
      ]),
    ),
  };
}

function getSettings() {
  const defaults = defaultSettings();
  const saved = readJson(settingsFile, {});
  return {
    ...defaults,
    ...saved,
    providers: {
      ...defaults.providers,
      ...(saved.providers || {}),
    },
  };
}

function getSecrets() {
  return readJson(secretsFile, {});
}

function masked(secret) {
  if (!secret) return '';
  if (secret.length <= 8) return '••••••••';
  return `••••••••${secret.slice(-4)}`;
}

function openCodeConfigPath() {
  const state = getState();
  return state.openCodeConfig || path.join(configRoot, 'opencode.json');
}

function providerModelRef(providerKey, model) {
  if (providerKey === 'local') return 'ollama/rea-qwen-coder';
  const provider = PROVIDERS[providerKey];
  return provider ? `${provider.id}/${model}` : 'ollama/rea-qwen-coder';
}

function applyOpenCodeConfig() {
  const configPath = openCodeConfigPath();
  ensureDir(path.dirname(configPath));
  const config = readJson(configPath, {});
  const settings = getSettings();
  const secrets = getSecrets();

  config.$schema ||= 'https://opencode.ai/config.json';
  config.provider ||= {};

  for (const [key, definition] of Object.entries(PROVIDERS)) {
    const s = settings.providers?.[key] || {};
    const model = String(s.model || definition.model).trim();
    const baseURL = String(s.baseURL || definition.baseURL).trim().replace(/\/$/, '');

    if (!s.enabled) {
      delete config.provider[definition.id];
      continue;
    }

    config.provider[definition.id] = {
      npm: '@ai-sdk/openai-compatible',
      name: definition.name,
      options: {
        baseURL,
        apiKey: `{env:${definition.env}}`,
      },
      models: {
        [model]: {
          name: `${definition.name} — ${model}`,
          limit: {
            context: Number(s.context || definition.context),
            output: Number(s.output || definition.output),
          },
        },
      },
    };
  }

  const wanted = settings.defaultProvider || 'local';
  if (wanted === 'local') {
    config.model = 'ollama/rea-qwen-coder';
  } else {
    const p = PROVIDERS[wanted];
    const s = settings.providers?.[wanted];
    if (p && s?.enabled && secrets[p.env]) {
      config.model = providerModelRef(wanted, s.model || p.model);
    } else {
      config.model = 'ollama/rea-qwen-coder';
    }
  }

  writeJson(configPath, config);
  return config;
}

function buildRuntimeEnv() {
  const state = getState();
  const secrets = getSecrets();
  return {
    ...process.env,
    ...secrets,
    OPENCODE_CONFIG: openCodeConfigPath(),
    OLLAMA_HOST: state.ollamaHost || process.env.OLLAMA_HOST || '127.0.0.1:11434',
    GHIDRA_INSTALL_DIR: state.ghidraInstallDir || process.env.GHIDRA_INSTALL_DIR || '',
    JAVA_HOME: state.javaHome || process.env.JAVA_HOME || '',
    REA_ANALYSIS_PROVIDER: 'ghidra',
    REA_GHIDRA_STARTUP_TIMEOUT_MS: '180000',
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function ollamaStatus(state) {
  const rawHost = state.ollamaHost || process.env.OLLAMA_HOST || '127.0.0.1:11434';
  const host = rawHost.replace(/^https?:\/\//, '').replace(/^0\.0\.0\.0:/, '127.0.0.1:');
  try {
    const response = await fetchWithTimeout(`http://${host}/api/tags`, {}, 2500);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    return {
      ok: true,
      host,
      models: (body.models || []).map((m) => m.name),
    };
  } catch (error) {
    return { ok: false, host, error: error.message };
  }
}

function commandVersion(command, args = ['--version']) {
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      windowsHide: true,
      env: buildRuntimeEnv(),
      timeout: 5000,
    });
    const text = `${result.stdout || ''}${result.stderr || ''}`.trim();
    return { ok: result.status === 0, value: text.split(/\r?\n/)[0] || 'installed' };
  } catch (error) {
    return { ok: false, value: error.message };
  }
}

function reaIntegrationStatus() {
  const config = readJson(openCodeConfigPath(), {});
  const mcp = config.mcp || {};
  const rea = mcp.rea || mcp.servers?.rea;
  return {
    integrated: Boolean(rea && rea.enabled !== false),
    enabled: rea?.enabled !== false,
    ghidraEnvironment: Boolean(
      rea?.environment?.GHIDRA_INSTALL_DIR || getState().ghidraInstallDir,
    ),
  };
}

async function systemStatus() {
  const state = getState();
  const settings = getSettings();
  const secrets = getSecrets();
  const ollama = await ollamaStatus(state);
  const rea = reaIntegrationStatus();
  const ghidraPath = state.ghidraInstallDir || '';
  const ghidraOk = Boolean(
    ghidraPath && fs.existsSync(path.join(ghidraPath, 'support', 'analyzeHeadless.bat')),
  );

  return {
    installed: fs.existsSync(stateFile),
    workspace: state.workspace || '',
    context: state.context || null,
    currentModel: readJson(openCodeConfigPath(), {}).model || 'ollama/rea-qwen-coder',
    ollama,
    opencode: commandVersion('opencode'),
    reaCli: commandVersion('rea'),
    rea,
    ghidra: { ok: ghidraOk, path: ghidraPath },
    providers: Object.fromEntries(
      Object.entries(PROVIDERS).map(([key, p]) => [
        key,
        {
          enabled: Boolean(settings.providers?.[key]?.enabled),
          configured: Boolean(secrets[p.env]),
          model: settings.providers?.[key]?.model || p.model,
          maskedKey: masked(secrets[p.env]),
        },
      ]),
    ),
    defaultProvider: settings.defaultProvider || 'local',
    paths: {
      stateRoot,
      openCodeConfig: openCodeConfigPath(),
      settingsFile,
    },
  };
}

async function validateProvider(providerKey, secretOverride) {
  const provider = PROVIDERS[providerKey];
  if (!provider) throw new Error('Unknown provider.');
  const secrets = getSecrets();
  const key = secretOverride || secrets[provider.env];
  if (!key) throw new Error(`${provider.name} API key is not configured.`);

  let url;
  if (providerKey === 'openrouter') url = 'https://openrouter.ai/api/v1/key';
  else if (providerKey === 'huggingface') url = 'https://huggingface.co/api/whoami-v2';
  else url = `${provider.baseURL}/models`;

  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
      },
    },
    12000,
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Provider returned HTTP ${response.status}${body ? `: ${body.slice(0, 180)}` : ''}`);
  }
  return { ok: true, message: `${provider.name} API key verified.` };
}

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function html(res, content) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(content),
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:;",
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

function sanitizeSettingsPayload(body) {
  const current = getSettings();
  const next = {
    ...current,
    defaultProvider: ['local', ...Object.keys(PROVIDERS)].includes(body.defaultProvider)
      ? body.defaultProvider
      : current.defaultProvider,
    providers: { ...current.providers },
  };

  for (const [key, definition] of Object.entries(PROVIDERS)) {
    const incoming = body.providers?.[key] || {};
    const previous = current.providers?.[key] || {};
    next.providers[key] = {
      enabled: Boolean(incoming.enabled),
      model: String(incoming.model || previous.model || definition.model).trim(),
      baseURL: String(incoming.baseURL || previous.baseURL || definition.baseURL).trim(),
      context: Math.max(4096, Number(incoming.context || previous.context || definition.context)),
      output: Math.max(1024, Number(incoming.output || previous.output || definition.output)),
    };
  }
  return next;
}

function saveSettingsAndSecrets(body) {
  const settings = sanitizeSettingsPayload(body);
  const secrets = getSecrets();

  for (const [key, definition] of Object.entries(PROVIDERS)) {
    const incoming = body.providers?.[key] || {};
    if (incoming.clearKey === true) {
      delete secrets[definition.env];
    } else if (typeof incoming.apiKey === 'string' && incoming.apiKey.trim()) {
      secrets[definition.env] = incoming.apiKey.trim();
    }
  }

  writeJson(settingsFile, settings);
  writeJson(secretsFile, secrets);
  lockDownSecrets();
  const config = applyOpenCodeConfig();
  return { settings, configModel: config.model };
}

function launchDetached(file, args = [], options = {}) {
  const child = spawn(file, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: buildRuntimeEnv(),
    ...options,
  });
  child.unref();
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  }
}

const indexPath = path.join(__dirname, 'index.html');
ensureDir(configRoot);

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = requestUrl.pathname;

    if (req.method === 'GET' && pathname === '/') {
      return html(res, fs.readFileSync(indexPath, 'utf8'));
    }

    if (req.method === 'GET' && pathname === '/api/status') {
      return json(res, 200, await systemStatus());
    }

    if (req.method === 'GET' && pathname === '/api/settings') {
      const settings = getSettings();
      const secrets = getSecrets();
      return json(res, 200, {
        ...settings,
        providers: Object.fromEntries(
          Object.entries(PROVIDERS).map(([key, p]) => [
            key,
            {
              ...settings.providers[key],
              configured: Boolean(secrets[p.env]),
              maskedKey: masked(secrets[p.env]),
              displayName: p.name,
              defaultModel: p.model,
            },
          ]),
        ),
      });
    }

    if (req.method === 'POST' && pathname === '/api/settings') {
      const body = await readBody(req);
      const saved = saveSettingsAndSecrets(body);
      return json(res, 200, {
        ok: true,
        message: 'Configuration saved. New agent sessions use it automatically.',
        defaultModel: saved.configModel,
      });
    }

    if (req.method === 'POST' && pathname === '/api/test-provider') {
      const body = await readBody(req);
      const result = await validateProvider(body.provider, body.apiKey);
      return json(res, 200, result);
    }

    if (req.method === 'POST' && pathname === '/api/launch-agent') {
      applyOpenCodeConfig();
      const launcher = path.join(repoRoot, 'START-RE-AGENT.bat');
      if (!fs.existsSync(launcher)) throw new Error('START-RE-AGENT.bat is missing.');
      launchDetached('cmd.exe', ['/c', launcher], { cwd: repoRoot });
      return json(res, 200, { ok: true, message: 'RE Coding Agent launched.' });
    }

    if (req.method === 'POST' && pathname === '/api/open-workspace') {
      const state = getState();
      if (!state.workspace) throw new Error('Workspace is not configured.');
      ensureDir(state.workspace);
      launchDetached('explorer.exe', [state.workspace]);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/rea-doctor') {
      const result = spawnSync('rea', ['doctor', '--client', 'opencode', '--skill'], {
        encoding: 'utf8',
        windowsHide: true,
        env: buildRuntimeEnv(),
        timeout: 120000,
      });
      const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
      return json(res, result.status === 0 ? 200 : 500, {
        ok: result.status === 0,
        output: output || `rea doctor exited with code ${result.status}`,
      });
    }

    if (req.method === 'POST' && pathname === '/api/refresh-config') {
      const config = applyOpenCodeConfig();
      return json(res, 200, { ok: true, model: config.model });
    }

    return json(res, 404, { ok: false, error: 'Not found.' });
  } catch (error) {
    return json(res, 500, { ok: false, error: error?.message || String(error) });
  }
});

const portArgIndex = process.argv.indexOf('--port');
const port = portArgIndex >= 0 ? Number(process.argv[portArgIndex + 1]) || defaultPort : defaultPort;
const url = `http://127.0.0.1:${port}`;

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    openBrowser(url);
    process.exit(0);
  }
  console.error(error);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`RE Coding Agent Dashboard: ${url}`);
  console.log('Localhost only. Close this window to stop the dashboard server.');
  if (process.argv.includes('--open')) openBrowser(url);
});

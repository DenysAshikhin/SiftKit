import fs from 'node:fs';
import path from 'node:path';

import type { Exl3EngineConfig } from '../../src/config/types.js';
import { writeFakeExl3Venv } from './tabby-fake.js';

export interface ManagedEngineLauncherOptions {
  /** `GET /v1/model` answers "no model loaded" this many times before reporting the resident card. */
  initialUnloadedModelProbeCount?: number;
  tokenizeCharsPerToken?: number;
  startupLogLine?: string;
  engineLogLine?: string;
  deferredLogLine?: string;
  launchHangingProcess?: boolean;
  exitAfterLog?: boolean;
  exitCode?: number;
}

export interface ManagedEngineLauncherPaths {
  baseUrl: string;
  modelId: string;
  pythonPath: string;
  scriptPath: string;
  fakeServerPath: string;
  modelRoot: string;
  modelPath: string;
  engine: Exl3EngineConfig;
  /** `--require` preload that answers the EXL3 package probe for the hard-linked Node interpreter. */
  probeShimPath: string;
  pidFilePath: string;
  readyFilePath: string;
  modelProbeCountPath: string;
  deferredLogMarkerPath: string;
  invocationLogPath: string;
}

/**
 * Builds the `NODE_OPTIONS` value that makes the fake venv interpreter answer
 * `InterpreterExl3PackageLocator`'s `-c` probe. Every Node process launched with this
 * environment loads the shim, which is inert unless argv carries the probe script.
 */
export function buildProbeShimNodeOptions(probeShimPath: string, existing = process.env.NODE_OPTIONS): string {
  const requireFlag = `--require "${probeShimPath.replaceAll('\\', '/')}"`;
  return existing && existing.trim() ? `${existing} ${requireFlag}` : requireFlag;
}

/** Installs the probe shim into this process's `NODE_OPTIONS`; returns the restore function. */
export function installProbeShim(probeShimPath: string): () => void {
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = buildProbeShimNodeOptions(probeShimPath, previous);
  return () => {
    if (previous === undefined) {
      delete process.env.NODE_OPTIONS;
    } else {
      process.env.NODE_OPTIONS = previous;
    }
  };
}

/**
 * Fake managed TabbyAPI for end-to-end status-server tests. The engine's `PythonPath` is a
 * hard-linked Node binary inside a fake exllamav3 venv, so `ManagedTabbyRuntime` spawns
 * `<python> <entrypoint>` exactly as it does in production and the entrypoint is this server.
 * The model card comes from the `TABBY_MODEL_*` launch environment or the last `/v1/model/load`.
 */
export function writeManagedEngineLauncher(
  tempRoot: string,
  port: number,
  modelId = 'managed-test-model',
  options: ManagedEngineLauncherOptions = {},
): ManagedEngineLauncherPaths {
  const venv = writeFakeExl3Venv(tempRoot, true);
  const packageDirectory = path.join(tempRoot, 'venv', 'Lib', 'site-packages', 'exllamav3');
  const modelRoot = path.join(tempRoot, 'models');
  const modelPath = path.join(modelRoot, modelId);
  const scriptPath = path.join(tempRoot, 'fake-tabby.cjs');
  const probeShimPath = path.join(tempRoot, 'exl3-probe-shim.cjs');
  const pidFilePath = path.join(tempRoot, 'fake-tabby.pid');
  const readyFilePath = path.join(tempRoot, 'fake-tabby.ready');
  const modelProbeCountPath = path.join(tempRoot, 'fake-tabby-model-probes.txt');
  const deferredLogMarkerPath = path.join(tempRoot, 'fake-tabby.deferred-log');
  const invocationLogPath = path.join(tempRoot, 'fake-tabby.invocation.json');
  const initialUnloadedModelProbeCount = Number.isFinite(options.initialUnloadedModelProbeCount)
    ? Number(options.initialUnloadedModelProbeCount)
    : 0;
  const tokenizeCharsPerToken = Number.isFinite(options.tokenizeCharsPerToken)
    && Number(options.tokenizeCharsPerToken) > 0
    ? Number(options.tokenizeCharsPerToken)
    : 4;

  fs.mkdirSync(modelPath, { recursive: true });
  fs.writeFileSync(path.join(modelPath, 'config.json'), JSON.stringify({ architectures: ['FakeForCausalLM'] }), 'utf8');
  fs.writeFileSync(probeShimPath, `
if (/exllamav3/u.test(String(process.argv[1] || ''))) {
  process.stdout.write(JSON.stringify({ packageDirectory: ${JSON.stringify(packageDirectory)} }) + '\\n');
  process.exit(0);
}
`, 'utf8');
  fs.writeFileSync(scriptPath, `
const http = require('node:http');
const fs = require('node:fs');

const argv = process.argv.slice(2);
const port = ${JSON.stringify(port)};
const host = '127.0.0.1';
const pidFilePath = ${JSON.stringify(pidFilePath)};
const readyFilePath = ${JSON.stringify(readyFilePath)};
const modelProbeCountPath = ${JSON.stringify(modelProbeCountPath)};
const deferredLogMarkerPath = ${JSON.stringify(deferredLogMarkerPath)};
const invocationLogPath = ${JSON.stringify(invocationLogPath)};
const modelId = ${JSON.stringify(modelId)};
const startupLogLine = ${JSON.stringify(options.startupLogLine || '')};
const engineLogLine = ${JSON.stringify(options.engineLogLine || '')};
const deferredLogLine = ${JSON.stringify(options.deferredLogLine || '')};
const launchHangingProcess = ${JSON.stringify(Boolean(options.launchHangingProcess))};
const exitAfterLog = ${JSON.stringify(Boolean(options.exitAfterLog))};
const exitCode = ${JSON.stringify(Number.isFinite(options.exitCode) ? Math.trunc(Number(options.exitCode)) : 0)};
const tokenizeCharsPerToken = ${JSON.stringify(tokenizeCharsPerToken)};
let unloadedModelProbes = ${JSON.stringify(initialUnloadedModelProbeCount)};
let modelProbeCount = 0;

const launchEnvironment = Object.fromEntries(Object.entries(process.env).filter(
  ([key]) => key.startsWith('TABBY_') || key.startsWith('EXL3_'),
));
let card = launchEnvironment.TABBY_MODEL_MODEL_NAME ? {
  id: launchEnvironment.TABBY_MODEL_MODEL_NAME,
  parameters: {
    max_seq_len: Number(launchEnvironment.TABBY_MODEL_MAX_SEQ_LEN),
    cache_size: Number(launchEnvironment.TABBY_MODEL_CACHE_SIZE),
    chunk_size: Number(launchEnvironment.TABBY_MODEL_CHUNK_SIZE),
  },
} : null;

if (startupLogLine) process.stdout.write(startupLogLine + '\\n');
fs.writeFileSync(invocationLogPath, JSON.stringify({
  argv,
  cwd: process.cwd(),
  host,
  port,
  launchEnvironment,
  ServerConfigPathEnv: process.env.SIFTKIT_SERVER_CONFIG_PATH || '',
  ServerConfigUrlEnv: process.env.SIFTKIT_SERVER_CONFIG_URL || '',
  ServerStatusPathEnv: process.env.SIFTKIT_SERVER_STATUS_PATH || '',
  ServerStatusUrlEnv: process.env.SIFTKIT_SERVER_STATUS_URL || '',
  ServerHealthUrlEnv: process.env.SIFTKIT_SERVER_HEALTH_URL || '',
}, null, 2), 'utf8');
if (exitAfterLog) {
  if (engineLogLine) process.stdout.write(engineLogLine + '\\n');
  process.exit(exitCode);
}
if (launchHangingProcess) {
  fs.writeFileSync(pidFilePath, String(process.pid), 'utf8');
  const pidHistoryPath = process.env.SIFTKIT_FAKE_MANAGED_PID_HISTORY_PATH || '';
  if (pidHistoryPath) fs.appendFileSync(pidHistoryPath, String(process.pid) + '\\n', 'utf8');
  setInterval(() => {}, 1000);
  return;
}

function readJsonBody(request, callback) {
  let bodyText = '';
  request.on('data', (chunk) => { bodyText += chunk; });
  request.on('end', () => {
    let parsed = null;
    try { parsed = JSON.parse(bodyText || 'null'); } catch {}
    callback(parsed);
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
}

const server = http.createServer((request, response) => {
  const url = request.url || '';
  if (request.method === 'GET' && url === '/v1/models') {
    // TabbyAPI lists the models available under the model directory, loaded or not.
    sendJson(response, 200, { object: 'list', data: [{ id: modelId, object: 'model' }] });
    return;
  }
  if (request.method === 'GET' && url === '/v1/model') {
    modelProbeCount += 1;
    fs.writeFileSync(modelProbeCountPath, String(modelProbeCount), 'utf8');
    if (unloadedModelProbes > 0) unloadedModelProbes -= 1;
    else if (card) { sendJson(response, 200, card); return; }
    response.writeHead(503, { 'Content-Type': 'text/plain' });
    response.end('No models are currently loaded');
    return;
  }
  if (request.method === 'POST' && url === '/v1/model/load') {
    readJsonBody(request, (body) => {
      card = {
        id: String(body && body.model_name || modelId),
        parameters: {
          max_seq_len: Number(body && body.max_seq_len),
          cache_size: Number(body && body.cache_size),
          chunk_size: Number(body && body.chunk_size),
        },
      };
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('data: {"model_type":"model","module":1,"modules":1,"status":"finished"}\\n\\n');
    });
    return;
  }
  if (request.method === 'POST' && url === '/v1/model/unload') {
    card = null;
    sendJson(response, 200, { ok: true });
    return;
  }
  if (request.method === 'POST' && (url === '/v1/model/freeze' || url === '/v1/model/restore')) {
    sendJson(response, 200, { ok: true });
    return;
  }
  if (request.method === 'POST' && url === '/v1/token/encode') {
    readJsonBody(request, (body) => {
      const text = String(body && body.text || '');
      const count = text.trim() ? Math.max(1, Math.ceil(text.length / tokenizeCharsPerToken)) : 0;
      sendJson(response, 200, { tokens: Array.from({ length: count }, (_, index) => index + 1), length: count });
    });
    return;
  }
  if (request.method === 'POST' && url === '/v1/chat/completions') {
    readJsonBody(request, (forwardedRequest) => {
      sendJson(response, 200, {
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
        forwardedRequest,
      });
    });
    return;
  }
  if (request.method === 'GET' && url === '/health') {
    sendJson(response, 200, { ok: true });
    return;
  }
  sendJson(response, 404, { error: 'not found' });
});

server.listen(port, host, () => {
  fs.writeFileSync(pidFilePath, String(process.pid), 'utf8');
  fs.writeFileSync(readyFilePath, String(process.pid), 'utf8');
  if (engineLogLine) process.stdout.write(engineLogLine + '\\n');
  if (deferredLogLine) {
    const deadline = Date.now() + 10000;
    const timer = setInterval(() => {
      if (fs.existsSync(deferredLogMarkerPath)) {
        clearInterval(timer);
        process.stderr.write(deferredLogLine + '\\n');
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
      }
    }, 10);
  }
});

function shutdown() {
  try { fs.rmSync(readyFilePath, { force: true }); } catch {}
  try { fs.rmSync(pidFilePath, { force: true }); } catch {}
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
`, 'utf8');

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    modelId,
    pythonPath: venv.pythonPath,
    scriptPath,
    fakeServerPath: scriptPath,
    modelRoot,
    modelPath,
    engine: {
      Managed: true,
      WorkingDirectory: tempRoot,
      PythonPath: venv.pythonPath,
      Entrypoint: scriptPath,
      ModelRoot: modelRoot,
      AdminApiKey: '',
      ShutdownTimeoutMs: 5000,
    },
    probeShimPath,
    pidFilePath,
    readyFilePath,
    modelProbeCountPath,
    deferredLogMarkerPath,
    invocationLogPath,
  };
}

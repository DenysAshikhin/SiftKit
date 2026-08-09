import fs from 'node:fs';
import path from 'node:path';

export interface ManagedLlamaLauncherOptions {
  initial503LoadingModelCount?: number;
  tokenizeCharsPerToken?: number;
  startupLogLine?: string;
  llamaLogLine?: string;
  deferredLogLine?: string;
  preflightConfigGet?: boolean;
  emitManagedStartupFlag?: boolean;
  emitVerboseEnvFlags?: boolean;
  writeLaunchMarker?: boolean;
  launchHangingProcess?: boolean;
  exitAfterLog?: boolean;
  exitCode?: number;
}

export interface ManagedLlamaLauncherPaths {
  baseUrl: string;
  executablePath: string;
  fakeServerPath: string;
  modelPath: string;
  pidFilePath: string;
  readyFilePath: string;
  modelProbeCountPath: string;
  deferredLogMarkerPath: string;
  launchMarkerPath: string;
  invocationLogPath: string;
}

function escapeBatchValue(value: string): string {
  return value.replace(/"/gu, '""');
}

export function writeManagedLlamaLauncher(
  tempRoot: string,
  port: number,
  modelId = 'managed-test-model',
  options: ManagedLlamaLauncherOptions = {},
): ManagedLlamaLauncherPaths {
  const fakeServerPath = path.join(tempRoot, 'fake-llama-server.js');
  const executablePath = path.join(tempRoot, 'fake-llama-launcher.cmd');
  const modelPath = path.join(tempRoot, `${modelId}.gguf`);
  const pidFilePath = path.join(tempRoot, 'fake-llama.pid');
  const readyFilePath = path.join(tempRoot, 'fake-llama.ready');
  const modelProbeCountPath = path.join(tempRoot, 'fake-llama-model-probes.txt');
  const deferredLogMarkerPath = path.join(tempRoot, 'fake-llama.deferred-log');
  const launchMarkerPath = path.join(tempRoot, 'fake-llama.launch');
  const invocationLogPath = path.join(tempRoot, 'fake-llama.invocation.json');
  const initial503LoadingModelCount = Number.isFinite(options.initial503LoadingModelCount)
    ? Number(options.initial503LoadingModelCount)
    : 0;
  const tokenizeCharsPerToken = Number.isFinite(options.tokenizeCharsPerToken)
    && Number(options.tokenizeCharsPerToken) > 0
    ? Number(options.tokenizeCharsPerToken)
    : 4;

  fs.writeFileSync(modelPath, 'fake model', 'utf8');
  fs.writeFileSync(fakeServerPath, `
const http = require('node:http');
const fs = require('node:fs');

const argv = process.argv.slice(2);
const port = ${JSON.stringify(port)};
const host = '127.0.0.1';
const pidFilePath = process.env.SIFTKIT_FAKE_PID_FILE || ${JSON.stringify(pidFilePath)};
const readyFilePath = process.env.SIFTKIT_FAKE_READY_FILE || '';
const modelProbeCountPath = process.env.SIFTKIT_FAKE_MODEL_PROBE_COUNT_FILE || '';
const deferredLogMarkerPath = process.env.SIFTKIT_FAKE_DEFERRED_LOG_MARKER || '';
const modelId = process.env.SIFTKIT_FAKE_MODEL_ID || ${JSON.stringify(modelId)};
const llamaLogLine = ${JSON.stringify(options.llamaLogLine || '')};
const deferredLogLine = ${JSON.stringify(options.deferredLogLine || '')};
const invocationLogPath = process.env.SIFTKIT_FAKE_INVOCATION_LOG || '';
const startupLogLine = ${JSON.stringify(options.startupLogLine || '')};
const preflightConfigGet = ${JSON.stringify(Boolean(options.preflightConfigGet))};
const emitManagedStartupFlag = ${JSON.stringify(Boolean(options.emitManagedStartupFlag))};
const emitVerboseEnvFlags = ${JSON.stringify(Boolean(options.emitVerboseEnvFlags))};
const writeLaunchMarker = ${JSON.stringify(Boolean(options.writeLaunchMarker))};
const launchMarkerPath = process.env.SIFTKIT_FAKE_LAUNCH_MARKER || '';
const launchHangingProcess = ${JSON.stringify(Boolean(options.launchHangingProcess))};
const exitAfterLog = ${JSON.stringify(Boolean(options.exitAfterLog))};
const exitCode = ${JSON.stringify(Number.isFinite(options.exitCode) ? Math.trunc(Number(options.exitCode)) : 0)};
let loadingModelResponses = ${JSON.stringify(initial503LoadingModelCount)};
let modelProbeCount = 0;
const tokenizeCharsPerToken = ${JSON.stringify(tokenizeCharsPerToken)};

if (startupLogLine) process.stdout.write(startupLogLine + '\\n');
if (emitManagedStartupFlag) {
  process.stdout.write('managed_startup=' + String(process.env.SIFTKIT_MANAGED_LLAMA_STARTUP || '') + '\\n');
}
if (emitVerboseEnvFlags) {
  process.stdout.write('verbose_logging_env=' + String(process.env.SIFTKIT_LLAMA_VERBOSE_LOGGING || '') + '\\n');
  process.stdout.write('verbose_args_env=' + String(process.env.SIFTKIT_LLAMA_VERBOSE_ARGS_JSON || '') + '\\n');
}
if (writeLaunchMarker && launchMarkerPath) fs.writeFileSync(launchMarkerPath, '1', 'utf8');
if (invocationLogPath) {
  fs.writeFileSync(invocationLogPath, JSON.stringify({
    argv,
    host,
    port,
    verboseLoggingEnv: process.env.SIFTKIT_LLAMA_VERBOSE_LOGGING || '',
    ConfigPath: '',
    ConfigUrl: process.env.SIFTKIT_CONFIG_SERVICE_URL || '',
    StatusPath: '',
    StatusUrl: '',
    HealthUrl: process.env.SIFTKIT_HEALTH_URL || '',
    RuntimeRoot: '',
    ScriptPath: '',
    ServerConfigPathEnv: process.env.SIFTKIT_SERVER_CONFIG_PATH || '',
    ServerConfigUrlEnv: process.env.SIFTKIT_SERVER_CONFIG_URL || '',
    ServerStatusPathEnv: process.env.SIFTKIT_SERVER_STATUS_PATH || '',
    ServerStatusUrlEnv: process.env.SIFTKIT_SERVER_STATUS_URL || '',
    ServerHealthUrlEnv: process.env.SIFTKIT_SERVER_HEALTH_URL || '',
    ServerRuntimeRootEnv: process.env.SIFTKIT_SERVER_RUNTIME_ROOT || '',
  }, null, 2), 'utf8');
}
if (exitAfterLog) {
  if (llamaLogLine) process.stdout.write(String(llamaLogLine) + '\\n');
  process.exit(exitCode);
}
if (launchHangingProcess) {
  fs.writeFileSync(pidFilePath, String(process.pid), 'utf8');
  setInterval(() => {}, 1000);
  return;
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models') {
    modelProbeCount += 1;
    if (modelProbeCountPath) fs.writeFileSync(modelProbeCountPath, String(modelProbeCount), 'utf8');
    if (loadingModelResponses > 0) {
      loadingModelResponses -= 1;
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Loading model', type: 'unavailable_error', code: 503 } }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: modelId }] }));
    return;
  }

  if (request.method === 'POST' && request.url === '/tokenize') {
    let bodyText = '';
    request.on('data', (chunk) => { bodyText += chunk; });
    request.on('end', () => {
      let content = '';
      try { content = String((JSON.parse(bodyText || '{}') || {}).content || ''); } catch {}
      const count = content.trim() ? Math.max(1, Math.ceil(content.length / tokenizeCharsPerToken)) : 0;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ count }));
    });
    return;
  }

  if (request.method === 'POST' && request.url === '/v1/chat/completions') {
    let bodyText = '';
    request.on('data', (chunk) => { bodyText += chunk; });
    request.on('end', () => {
      let forwardedRequest = null;
      try { forwardedRequest = JSON.parse(bodyText || 'null'); } catch {}
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
        forwardedRequest,
      }));
    });
    return;
  }

  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  response.writeHead(404, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: 'not found' }));
});

async function start() {
  if (preflightConfigGet && process.env.SIFTKIT_CONFIG_SERVICE_URL) {
    await new Promise((resolve) => {
      const request = http.get(process.env.SIFTKIT_CONFIG_SERVICE_URL, (response) => {
        response.resume();
        resolve();
      });
      request.on('error', () => resolve());
      request.setTimeout(10000, () => { request.destroy(); resolve(); });
    });
  }
  server.listen(port, host, () => {
    fs.writeFileSync(pidFilePath, String(process.pid), 'utf8');
    if (readyFilePath) fs.writeFileSync(readyFilePath, String(process.pid), 'utf8');
    if (llamaLogLine) process.stdout.write(String(llamaLogLine) + '\\n');
    if (deferredLogLine && deferredLogMarkerPath) {
      const deadline = Date.now() + 10000;
      const timer = setInterval(() => {
        if (fs.existsSync(deferredLogMarkerPath)) {
          clearInterval(timer);
          process.stderr.write(String(deferredLogLine) + '\\n');
        } else if (Date.now() >= deadline) {
          clearInterval(timer);
        }
      }, 10);
    }
  });
}

start().catch((error) => {
  process.stderr.write(String(error && error.stack || error) + '\\n');
  process.exit(1);
});

function shutdown() {
  try { fs.rmSync(readyFilePath, { force: true }); } catch {}
  try { fs.rmSync(pidFilePath, { force: true }); } catch {}
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
`, 'utf8');

  fs.writeFileSync(executablePath, `
@echo off
set "NODE_PATH=${escapeBatchValue(process.execPath)}"
set "FAKE_SERVER=${escapeBatchValue(fakeServerPath)}"
set "SIFTKIT_FAKE_MODEL_ID=${escapeBatchValue(modelId)}"
set "SIFTKIT_FAKE_PID_FILE=${escapeBatchValue(pidFilePath)}"
set "SIFTKIT_FAKE_READY_FILE=${escapeBatchValue(readyFilePath)}"
set "SIFTKIT_FAKE_MODEL_PROBE_COUNT_FILE=${escapeBatchValue(modelProbeCountPath)}"
set "SIFTKIT_FAKE_DEFERRED_LOG_MARKER=${escapeBatchValue(deferredLogMarkerPath)}"
set "SIFTKIT_FAKE_LAUNCH_MARKER=${escapeBatchValue(launchMarkerPath)}"
set "SIFTKIT_FAKE_INVOCATION_LOG=${escapeBatchValue(invocationLogPath)}"
"%NODE_PATH%" "%FAKE_SERVER%" %*
`, 'utf8');

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    executablePath,
    fakeServerPath,
    modelPath,
    pidFilePath,
    readyFilePath,
    modelProbeCountPath,
    deferredLogMarkerPath,
    launchMarkerPath,
    invocationLogPath,
  };
}

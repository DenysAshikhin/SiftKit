const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const {
  loadConfig,
  saveConfig,
  getExecutionServerState,
  getChunkThresholdCharacters,
  getStatusServerUnavailableMessage,
} = require('../dist/config.js');
const { summarizeRequest, buildPrompt, UNSUPPORTED_INPUT_MESSAGE } = require('../dist/summary.js');
const { runCommand } = require('../dist/command.js');
const { runBenchmarkSuite } = require('../dist/benchmark.js');
const {
  readMatrixManifest,
  buildLaunchSignature,
  buildLauncherArgs,
  buildBenchmarkArgs,
} = require('../dist/benchmark-matrix.js');
const {
  listLlamaCppModels,
  generateLlamaCppResponse,
} = require('../dist/providers/llama-cpp.js');
const { withExecutionLock } = require('../dist/execution-lock.js');
const {
  buildIdleMetricsLogMessage,
  buildStatusRequestLogMessage,
  formatElapsed,
  getIdleSummarySnapshotsPath,
  startStatusServer,
} = require('../siftKitStatus/index.js');

const TEST_USE_EXISTING_SERVER = process.env.SIFTKIT_TEST_USE_EXISTING_SERVER === '1';
const EXISTING_SERVER_STATUS_URL = process.env.SIFTKIT_STATUS_BACKEND_URL;
const EXISTING_SERVER_CONFIG_URL = process.env.SIFTKIT_CONFIG_SERVICE_URL;

function deriveServiceUrl(configuredUrl, nextPath) {
  const target = new URL(configuredUrl);
  target.pathname = nextPath;
  target.search = '';
  target.hash = '';
  return target.toString();
}

function getDefaultConfig() {
  return {
    Version: '0.1.0',
    Backend: 'llama.cpp',
    Model: 'qwen3.5-9b-instruct-q4_k_m',
    PolicyMode: 'conservative',
    RawLogRetention: true,
    LlamaCpp: {
      BaseUrl: 'http://127.0.0.1:8080',
      NumCtx: 128000,
      ModelPath: null,
      Temperature: 0.2,
      TopP: 0.95,
      TopK: 20,
      MinP: 0.0,
      PresencePenalty: 0.0,
      RepetitionPenalty: 1.0,
      MaxTokens: 4096,
      GpuLayers: 999,
      Threads: -1,
      FlashAttention: true,
      ParallelSlots: 1,
      Reasoning: 'off',
    },
    Thresholds: {
      MinCharactersForSummary: 500,
      MinLinesForSummary: 16,
    },
    Interactive: {
      Enabled: true,
      WrappedCommands: ['git', 'less', 'vim', 'sqlite3'],
      IdleTimeoutMs: 900000,
      MaxTranscriptCharacters: 60000,
      TranscriptRetention: true,
    },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function setManagedLlamaBaseUrl(config, baseUrl) {
  config.LlamaCpp.BaseUrl = baseUrl;
  config.Runtime ??= {};
  config.Runtime.Model ??= config.Model;
  config.Runtime.LlamaCpp = {
    ...(config.Runtime.LlamaCpp || {}),
    BaseUrl: baseUrl,
  };
}

function mergeConfig(baseValue, patchValue) {
  if (Array.isArray(baseValue) && Array.isArray(patchValue)) {
    return patchValue.slice();
  }

  if (
    baseValue
    && patchValue
    && typeof baseValue === 'object'
    && typeof patchValue === 'object'
    && !Array.isArray(baseValue)
    && !Array.isArray(patchValue)
  ) {
    const merged = { ...baseValue };
    for (const [key, value] of Object.entries(patchValue)) {
      merged[key] = key in merged ? mergeConfig(merged[key], value) : value;
    }
    delete merged.Paths;
    delete merged.Effective;
    if (merged.Thresholds && typeof merged.Thresholds === 'object') {
      delete merged.Thresholds.MaxInputCharacters;
    }
    return merged;
  }

  return patchValue;
}

function extractPromptSection(promptText, header) {
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`${escaped}\\n([\\s\\S]*?)(?:\\n[A-Z][^\\n]*:\\n|$)`, 'u').exec(promptText);
  return match ? match[1].trim() : '';
}

function buildStructuredStubDecision(promptText) {
  const inputText = extractPromptSection(promptText, 'Input:');

  if (!inputText.trim() || /unsupported fixture marker/u.test(inputText)) {
    return {
      classification: 'unsupported_input',
      raw_review_required: false,
      output: UNSUPPORTED_INPUT_MESSAGE,
    };
  }

  if (/Unable to resolve external command/u.test(inputText)) {
    return {
      classification: 'command_failure',
      raw_review_required: true,
      output: 'The command failed before producing a usable result. The executable could not be resolved in the current environment.\nRaw review required.',
    };
  }

  return {
    classification: 'summary',
    raw_review_required: false,
    output: `summary:${String(promptText).slice(0, 24)}`,
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: options.method || 'GET',
        headers: options.body ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(options.body, 'utf8'),
        } : undefined,
      },
      (response) => {
        let responseText = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          responseText += chunk;
        });
        response.on('end', () => {
          if ((response.statusCode || 0) >= 400) {
            reject(new Error(`HTTP ${response.statusCode}: ${responseText}`));
            return;
          }

          resolve(responseText ? JSON.parse(responseText) : {});
        });
      }
    );

    request.on('error', reject);
    if (options.body) {
      request.write(options.body);
    }
    request.end();
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function removeDirectoryWithRetries(targetPath, attempts = 40, delayMs = 100) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code || '') : '';
      if (code !== 'EPERM' && code !== 'EBUSY') {
        throw error;
      }
      lastError = error;
      await sleep(delayMs);
    }
  }

  throw lastError;
}

function spawnProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({
        code,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

async function startStubStatusServer(options = {}) {
  const state = {
    config: mergeConfig(getDefaultConfig(), options.config || {}),
    statusPosts: [],
    chatRequests: [],
    tokenizeRequests: [],
    running: Boolean(options.running),
    executionLeaseToken: null,
    metrics: {
      inputCharactersTotal: 3461904,
      outputCharactersTotal: 0,
      inputTokensTotal: 1865267,
      outputTokensTotal: 0,
      thinkingTokensTotal: 0,
      requestDurationMsTotal: 0,
      completedRequestCount: 0,
      updatedAtUtc: null,
      ...(options.metrics || {}),
    },
  };

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ running: state.running, status: state.running ? 'true' : 'false', metrics: state.metrics }));
      return;
    }

    if (req.method === 'GET' && req.url === '/execution') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ busy: Boolean(state.executionLeaseToken) }));
      return;
    }

    if (req.method === 'GET' && req.url === '/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state.config));
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: [{ id: state.config.Model }],
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/tokenize') {
      const bodyText = await readBody(req);
      const parsed = bodyText ? JSON.parse(bodyText) : {};
      const content = String(parsed?.content || '');
      state.tokenizeRequests.push(parsed);
      if (!Number.isFinite(options.tokenizeCharsPerToken) || Number(options.tokenizeCharsPerToken) <= 0) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'tokenize unavailable' }));
        return;
      }
      const tokenCount = content.trim()
        ? Math.max(1, Math.ceil(content.length / Number(options.tokenizeCharsPerToken)))
        : 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        tokens: Array.from({ length: tokenCount }, (_, index) => index),
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const bodyText = await readBody(req);
      const parsed = bodyText ? JSON.parse(bodyText) : {};
      const promptText = parsed?.messages?.[0]?.content || '';
      state.chatRequests.push(parsed);
      if (Number.isFinite(options.rejectPromptCharsOver) && String(promptText).length > Number(options.rejectPromptCharsOver)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `prompt too large: ${String(promptText).length}` }));
        return;
      }
      const assistantContent = typeof options.assistantContent === 'string'
        ? options.assistantContent
        : (/"classification":"summary\|command_failure\|unsupported_input"/u.test(promptText)
          ? JSON.stringify(buildStructuredStubDecision(String(promptText)))
          : `summary:${String(promptText).slice(0, 24)}`);
      const usage = options.omitUsage ? null : {
        prompt_tokens: 123,
        completion_tokens: 45,
        total_tokens: 168,
        ...(options.reasoningTokens === undefined ? {} : {
          completion_tokens_details: {
            reasoning_tokens: options.reasoningTokens,
          },
        }),
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: assistantContent,
            },
          },
        ],
        ...(usage ? { usage } : {}),
      }));
      return;
    }

    if (req.method === 'PUT' && req.url === '/config') {
      const bodyText = await readBody(req);
      const parsed = bodyText ? JSON.parse(bodyText) : {};
      state.config = mergeConfig(getDefaultConfig(), parsed);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state.config));
      return;
    }

    if (req.method === 'POST' && req.url === '/status') {
      if (options.failStatusPosts) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'status unavailable' }));
        return;
      }

      const bodyText = await readBody(req);
      const parsed = bodyText ? JSON.parse(bodyText) : {};
      state.statusPosts.push(parsed);
      state.running = Boolean(parsed.running);
      if (!parsed.running) {
        state.metrics.inputCharactersTotal += Number.isFinite(parsed.promptCharacterCount) ? Number(parsed.promptCharacterCount) : 0;
        state.metrics.outputCharactersTotal += Number.isFinite(parsed.outputCharacterCount) ? Number(parsed.outputCharacterCount) : 0;
        state.metrics.inputTokensTotal += Number.isFinite(parsed.inputTokens) ? Number(parsed.inputTokens) : 0;
        state.metrics.outputTokensTotal += Number.isFinite(parsed.outputTokens) ? Number(parsed.outputTokens) : 0;
        state.metrics.thinkingTokensTotal += Number.isFinite(parsed.thinkingTokens) ? Number(parsed.thinkingTokens) : 0;
        state.metrics.requestDurationMsTotal += Number.isFinite(parsed.requestDurationMs) ? Number(parsed.requestDurationMs) : 0;
        state.metrics.completedRequestCount += 1;
        state.metrics.updatedAtUtc = new Date().toISOString();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, running: Boolean(parsed.running) }));
      return;
    }

    if (req.method === 'POST' && req.url === '/execution/acquire') {
      if (state.executionLeaseToken) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, acquired: false, busy: true }));
        return;
      }

      state.executionLeaseToken = `lease-${Date.now()}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, acquired: true, busy: true, token: state.executionLeaseToken }));
      return;
    }

    if (req.method === 'POST' && req.url === '/execution/heartbeat') {
      const bodyText = await readBody(req);
      const parsed = bodyText ? JSON.parse(bodyText) : {};
      const ok = typeof parsed.token === 'string' && parsed.token === state.executionLeaseToken;
      res.writeHead(ok ? 200 : 409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok, busy: ok }));
      return;
    }

    if (req.method === 'POST' && req.url === '/execution/release') {
      const bodyText = await readBody(req);
      const parsed = bodyText ? JSON.parse(bodyText) : {};
      const released = typeof parsed.token === 'string' && parsed.token === state.executionLeaseToken;
      if (released) {
        state.executionLeaseToken = null;
      }
      res.writeHead(released ? 200 : 409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: released, released, busy: Boolean(state.executionLeaseToken) }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  if (state.config.LlamaCpp && typeof state.config.LlamaCpp === 'object') {
    state.config.LlamaCpp.BaseUrl = `http://127.0.0.1:${port}`;
  }

  return {
    port,
    healthUrl: `http://127.0.0.1:${port}/health`,
    statusUrl: `http://127.0.0.1:${port}/status`,
    configUrl: `http://127.0.0.1:${port}/config`,
    state,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function withTempEnv(fn) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-node-test-'));
  const previous = {
    USERPROFILE: process.env.USERPROFILE,
    sift_kit_status: process.env.sift_kit_status,
    SIFTKIT_STATUS_PATH: process.env.SIFTKIT_STATUS_PATH,
    SIFTKIT_CONFIG_PATH: process.env.SIFTKIT_CONFIG_PATH,
    SIFTKIT_TEST_PROVIDER: process.env.SIFTKIT_TEST_PROVIDER,
    SIFTKIT_TEST_PROVIDER_BEHAVIOR: process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR,
    SIFTKIT_TEST_PROVIDER_LOG_PATH: process.env.SIFTKIT_TEST_PROVIDER_LOG_PATH,
    SIFTKIT_TEST_PROVIDER_SLEEP_MS: process.env.SIFTKIT_TEST_PROVIDER_SLEEP_MS,
    SIFTKIT_CONFIG_SERVICE_URL: process.env.SIFTKIT_CONFIG_SERVICE_URL,
    SIFTKIT_STATUS_BACKEND_URL: process.env.SIFTKIT_STATUS_BACKEND_URL,
    SIFTKIT_STATUS_PORT: process.env.SIFTKIT_STATUS_PORT,
    SIFTKIT_STATUS_HOST: process.env.SIFTKIT_STATUS_HOST,
    SIFTKIT_IDLE_SUMMARY_DB_PATH: process.env.SIFTKIT_IDLE_SUMMARY_DB_PATH,
  };

  process.env.USERPROFILE = tempRoot;
  delete process.env.sift_kit_status;
  delete process.env.SIFTKIT_STATUS_PATH;
  delete process.env.SIFTKIT_CONFIG_PATH;
  delete process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR;
  delete process.env.SIFTKIT_TEST_PROVIDER_LOG_PATH;
  delete process.env.SIFTKIT_TEST_PROVIDER_SLEEP_MS;
  delete process.env.SIFTKIT_CONFIG_SERVICE_URL;
  delete process.env.SIFTKIT_STATUS_BACKEND_URL;
  delete process.env.SIFTKIT_STATUS_PORT;
  delete process.env.SIFTKIT_STATUS_HOST;
  delete process.env.SIFTKIT_IDLE_SUMMARY_DB_PATH;
  process.env.SIFTKIT_TEST_PROVIDER = 'mock';

  const cleanup = async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(tempRoot);
  };

  return Promise.resolve()
    .then(() => fn(tempRoot))
    .finally(cleanup);
}

async function withStubServer(fn, options = {}) {
  const server = await startStubStatusServer(options);
  process.env.SIFTKIT_STATUS_BACKEND_URL = server.statusUrl;
  process.env.SIFTKIT_CONFIG_SERVICE_URL = server.configUrl;
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

async function withSummaryTestServer(fn, options = {}) {
  if (!TEST_USE_EXISTING_SERVER) {
    return withStubServer(fn, options);
  }

  assert.ok(EXISTING_SERVER_STATUS_URL, 'SIFTKIT_STATUS_BACKEND_URL is required when SIFTKIT_TEST_USE_EXISTING_SERVER=1.');
  assert.ok(EXISTING_SERVER_CONFIG_URL, 'SIFTKIT_CONFIG_SERVICE_URL is required when SIFTKIT_TEST_USE_EXISTING_SERVER=1.');
  await requestJson(deriveServiceUrl(EXISTING_SERVER_CONFIG_URL, '/health'));

  process.env.SIFTKIT_STATUS_BACKEND_URL = EXISTING_SERVER_STATUS_URL;
  process.env.SIFTKIT_CONFIG_SERVICE_URL = EXISTING_SERVER_CONFIG_URL;
  return fn({
    statusUrl: EXISTING_SERVER_STATUS_URL,
    configUrl: EXISTING_SERVER_CONFIG_URL,
    usingExistingServer: true,
  });
}

async function withRealStatusServer(fn, options = {}) {
  const previous = {
    SIFTKIT_STATUS_HOST: process.env.SIFTKIT_STATUS_HOST,
    SIFTKIT_STATUS_PORT: process.env.SIFTKIT_STATUS_PORT,
    sift_kit_status: process.env.sift_kit_status,
    SIFTKIT_STATUS_PATH: process.env.SIFTKIT_STATUS_PATH,
    SIFTKIT_CONFIG_PATH: process.env.SIFTKIT_CONFIG_PATH,
    SIFTKIT_IDLE_SUMMARY_DB_PATH: process.env.SIFTKIT_IDLE_SUMMARY_DB_PATH,
  };

  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';
  process.env.sift_kit_status = options.statusPath;
  process.env.SIFTKIT_STATUS_PATH = options.statusPath;
  process.env.SIFTKIT_CONFIG_PATH = options.configPath;
  if (options.idleSummaryDbPath) {
    process.env.SIFTKIT_IDLE_SUMMARY_DB_PATH = options.idleSummaryDbPath;
  } else {
    delete process.env.SIFTKIT_IDLE_SUMMARY_DB_PATH;
  }

  const server = startStatusServer({
    disableManagedLlamaStartup: Boolean(options.disableManagedLlamaStartup),
  });
  try {
    const address = await new Promise((resolve) => {
      if (server.listening) {
        resolve(server.address());
        return;
      }

      server.once('listening', () => resolve(server.address()));
    });
    const port = typeof address === 'object' && address ? address.port : 0;
    if (server.startupPromise) {
      await server.startupPromise;
    }

    return await fn({
      server,
      port,
      statusUrl: `http://127.0.0.1:${port}/status`,
      healthUrl: `http://127.0.0.1:${port}/health`,
      configUrl: `http://127.0.0.1:${port}/config`,
      statusPath: options.statusPath,
      configPath: options.configPath,
      idleSummaryDbPath: options.idleSummaryDbPath || getIdleSummarySnapshotsPath(),
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function startStatusServerProcess(options) {
  const childEnv = {
    ...process.env,
    SIFTKIT_STATUS_HOST: '127.0.0.1',
    SIFTKIT_STATUS_PORT: '0',
    sift_kit_status: options.statusPath,
    SIFTKIT_STATUS_PATH: options.statusPath,
    SIFTKIT_CONFIG_PATH: options.configPath,
    ...(options.idleSummaryDbPath ? { SIFTKIT_IDLE_SUMMARY_DB_PATH: options.idleSummaryDbPath } : {}),
    ...(options.idleSummaryDelayMs ? { SIFTKIT_IDLE_SUMMARY_DELAY_MS: String(options.idleSummaryDelayMs) } : {}),
  };
  const args = [path.join(process.cwd(), 'siftKitStatus', 'index.js')];
  if (options.disableManagedLlamaStartup) {
    args.push('--disable-managed-llama-startup');
  }
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdoutLines = [];
  const stderrLines = [];
  let stdoutBuffer = '';
  let startupResolved = false;
  let closeResolved = false;
  let resolveStartup;
  let rejectStartup;
  let resolveClose;
  const startup = new Promise((resolve, reject) => {
    resolveStartup = resolve;
    rejectStartup = reject;
  });
  const closePromise = new Promise((resolve) => {
    resolveClose = resolve;
  });

  function handleStdoutChunk(chunk) {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split(/\r?\n/u);
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      stdoutLines.push(line);
      if (!startupResolved) {
        try {
          const parsed = JSON.parse(line);
          if (parsed && parsed.ok === true && Number.isFinite(parsed.port)) {
            startupResolved = true;
            resolveStartup(parsed);
          }
        } catch {
          // Ignore non-JSON log lines before startup resolves.
        }
      }
    }
  }

  child.stdout.on('data', handleStdoutChunk);
  child.stderr.on('data', (chunk) => {
    stderrLines.push(chunk.toString());
  });
  child.on('error', (error) => {
    if (!startupResolved) {
      startupResolved = true;
      rejectStartup(error);
    }
  });
  child.on('close', (code, signal) => {
    if (!closeResolved) {
      closeResolved = true;
      resolveClose({ code, signal });
    }
    if (!startupResolved) {
      startupResolved = true;
      rejectStartup(new Error([
        `status server exited before startup (code=${code}, signal=${signal})`,
        `stdout:\n${stdoutLines.join('\n')}`,
        `stderr:\n${stderrLines.join('\n')}`,
      ].join('\n')));
    }
  });

  const startupInfo = await startup;

  return {
    port: startupInfo.port,
    statusUrl: `http://127.0.0.1:${startupInfo.port}/status`,
    configUrl: `http://127.0.0.1:${startupInfo.port}/config`,
    executionUrl: `http://127.0.0.1:${startupInfo.port}/execution`,
    stdoutLines,
    stderrLines,
    idleSummaryDbPath: options.idleSummaryDbPath || path.join(path.dirname(options.statusPath), 'idle-summary.sqlite'),
    async waitForStdoutMatch(pattern, timeoutMs = 2000) {
      const startedAt = Date.now();
      for (;;) {
        const matchedLine = stdoutLines.find((line) => pattern.test(line));
        if (matchedLine) {
          return matchedLine;
        }

        if ((Date.now() - startedAt) >= timeoutMs) {
          throw new Error(`Timed out waiting for stdout match ${String(pattern)}.\nstdout:\n${stdoutLines.join('\n')}\nstderr:\n${stderrLines.join('\n')}`);
        }

        await sleep(10);
      }
    },
    async waitForExit(timeoutMs = 5000) {
      return await Promise.race([
        closePromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for status server exit after ${timeoutMs} ms.`)), timeoutMs)),
      ]);
    },
    async close() {
      if (child.exitCode !== null || child.killed) {
        return;
      }

      child.kill('SIGINT');
      await new Promise((resolve) => child.once('close', resolve));
    },
  };
}

function stripAnsi(text) {
  return String(text).replace(/\u001b\[[0-9;]*m/gu, '');
}

function readIdleSummarySnapshots(dbPath) {
  const database = new Database(dbPath, { readonly: true });
  try {
    return database.prepare(`
      SELECT
        emitted_at_utc,
        completed_request_count,
        input_characters_total,
        output_characters_total,
        input_tokens_total,
        output_tokens_total,
        thinking_tokens_total,
        saved_tokens,
        saved_percent,
        compression_ratio,
        request_duration_ms_total,
        avg_request_ms,
        avg_tokens_per_second
      FROM idle_summary_snapshots
      ORDER BY id ASC
    `).all();
  } finally {
    database.close();
  }
}

function getIdleSummaryBlock(stdoutLines, requestsPattern) {
  const startIndex = stdoutLines.findIndex((line) => requestsPattern.test(stripAnsi(line)));
  assert.notEqual(startIndex, -1, `missing idle summary line matching ${String(requestsPattern)}\n${stdoutLines.join('\n')}`);
  return stdoutLines.slice(startIndex, startIndex + 5).map(stripAnsi);
}

async function getFreePort() {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function toSingleQuotedPowerShellLiteral(value) {
  return `'${String(value).replace(/'/gu, "''")}'`;
}

function writeManagedLlamaScripts(tempRoot, port, modelId = 'managed-test-model', options = {}) {
  const fakeServerPath = path.join(tempRoot, 'fake-llama-server.js');
  const startupScriptPath = path.join(tempRoot, 'start-llama.ps1');
  const shutdownScriptPath = path.join(tempRoot, 'stop-llama.ps1');
  const pidFilePath = path.join(tempRoot, 'fake-llama.pid');
  const readyFilePath = path.join(tempRoot, 'fake-llama.ready');

  fs.writeFileSync(fakeServerPath, `
const http = require('node:http');
const fs = require('node:fs');
const port = ${JSON.stringify(port)};
const modelId = ${JSON.stringify(modelId)};
const readyFilePath = ${JSON.stringify(readyFilePath)};

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: modelId }] }));
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(port, '127.0.0.1', () => {
  fs.writeFileSync(readyFilePath, String(process.pid), 'utf8');
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
`, 'utf8');

  fs.writeFileSync(startupScriptPath, `
param(
  [string]$ConfigPath,
  [string]$ConfigUrl,
  [string]$StatusPath,
  [string]$StatusUrl,
  [string]$HealthUrl,
  [string]$RuntimeRoot,
  [string]$ScriptPath
)

$pidFile = ${toSingleQuotedPowerShellLiteral(pidFilePath)}
$nodePath = ${toSingleQuotedPowerShellLiteral(process.execPath)}
$serverScript = ${toSingleQuotedPowerShellLiteral(fakeServerPath)}
$startupLogLine = ${toSingleQuotedPowerShellLiteral(options.startupLogLine || '')}
$llamaLogLine = ${toSingleQuotedPowerShellLiteral(options.llamaLogLine || '')}
$launchHangingProcess = ${options.launchHangingProcess ? '$true' : '$false'}
$preflightConfigGet = ${options.preflightConfigGet ? '$true' : '$false'}

if (Test-Path -LiteralPath $pidFile) {
  try {
    $existingPid = [int]((Get-Content -LiteralPath $pidFile -Raw).Trim())
    $existing = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
    if ($existing) {
      exit 0
    }
  }
  catch {
  }
}

if ($startupLogLine) {
  Write-Output $startupLogLine
}
if ($llamaLogLine -and $env:SIFTKIT_LLAMA_STDOUT_PATH) {
  Set-Content -LiteralPath $env:SIFTKIT_LLAMA_STDOUT_PATH -Value $llamaLogLine -Encoding utf8 -NoNewline
}
if ($preflightConfigGet -and $ConfigUrl) {
  try {
    Invoke-RestMethod -Uri $ConfigUrl -Method Get -TimeoutSec 10 | Out-Null
  }
  catch {
  }
}

$child = if ($launchHangingProcess) {
  Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 60') -PassThru -WindowStyle Hidden
} else {
  Start-Process -FilePath $nodePath -ArgumentList @($serverScript) -PassThru -WindowStyle Hidden
}
Set-Content -LiteralPath $pidFile -Value ([string]$child.Id) -Encoding utf8 -NoNewline
exit 0
`, 'utf8');

  fs.writeFileSync(shutdownScriptPath, `
param(
  [string]$ConfigPath,
  [string]$ConfigUrl,
  [string]$StatusPath,
  [string]$StatusUrl,
  [string]$HealthUrl,
  [string]$RuntimeRoot,
  [string]$ScriptPath
)

$pidFile = ${toSingleQuotedPowerShellLiteral(pidFilePath)}
if (Test-Path -LiteralPath $pidFile) {
  try {
    $pidValue = [int]((Get-Content -LiteralPath $pidFile -Raw).Trim())
    Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
  }
  catch {
  }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}
exit 0
`, 'utf8');

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    fakeServerPath,
    startupScriptPath,
    shutdownScriptPath,
    pidFilePath,
    readyFilePath,
  };
}

async function waitForAsyncExpectation(expectation, timeoutMs = 2000) {
  const startedAt = Date.now();
  let lastError = null;
  for (;;) {
    try {
      await expectation();
      return;
    } catch (error) {
      lastError = error;
    }

    if ((Date.now() - startedAt) >= timeoutMs) {
      throw lastError;
    }

    await sleep(25);
  }
}

function runPowerShellScript(scriptPath) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    encoding: 'utf8',
    windowsHide: true,
  });

  if ((result.status ?? 0) !== 0) {
    throw new Error(`PowerShell script failed (${scriptPath}) with exit code ${result.status ?? 'null'}: ${result.stderr || result.stdout}`);
  }
}

test('loadConfig uses the fixed bootstrap chars-per-token budget before observed telemetry exists', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });

      assert.equal(config.Effective.BudgetSource, 'ColdStartFixedCharsPerToken');
      assert.equal(config.Effective.InputCharactersPerContextToken, 2.5);
      assert.equal(config.Effective.ObservedTelemetrySeen, false);
      assert.equal(config.Effective.ObservedTelemetryUpdatedAtUtc, null);
      assert.equal(config.Effective.MaxInputCharacters, 320000);
      assert.equal(config.Effective.ChunkThresholdCharacters, 320000);
    }, {
      metrics: {
        inputCharactersTotal: 0,
        inputTokensTotal: 0,
        outputCharactersTotal: 0,
        outputTokensTotal: 0,
        thinkingTokensTotal: 0,
        completedRequestCount: 0,
        requestDurationMsTotal: 0,
      },
    });
  });
});

test('loadConfig immediately switches from bootstrap fallback to observed telemetry when totals appear', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const coldStartConfig = await loadConfig({ ensure: true });
      assert.equal(coldStartConfig.Effective.BudgetSource, 'ColdStartFixedCharsPerToken');
      assert.equal(coldStartConfig.Effective.InputCharactersPerContextToken, 2.5);
    }, {
      metrics: {
        inputCharactersTotal: 0,
        inputTokensTotal: 0,
        outputCharactersTotal: 0,
        outputTokensTotal: 0,
        thinkingTokensTotal: 0,
        completedRequestCount: 0,
        requestDurationMsTotal: 0,
      },
    });

    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });
      const expectedRatio = 3461904 / 1865267;

      assert.equal(config.Effective.BudgetSource, 'ObservedCharsPerToken');
      assert.ok(Math.abs(config.Effective.InputCharactersPerContextToken - expectedRatio) < 1e-12);
      assert.equal(config.Effective.ObservedTelemetrySeen, true);
      assert.equal(typeof config.Effective.ObservedTelemetryUpdatedAtUtc, 'string');
      assert.equal(config.Effective.MaxInputCharacters, 237565);
      assert.equal(config.Effective.ChunkThresholdCharacters, 237565);
    });
  });
});

test('loadConfig normalizes legacy defaults and derives effective budgets from the external server', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });
      const expectedRatio = 3461904 / 1865267;

      assert.equal(config.LlamaCpp.NumCtx, 128000);
      assert.equal(config.LlamaCpp.Threads, -1);
      assert.equal(config.Effective.BudgetSource, 'ObservedCharsPerToken');
      assert.ok(Math.abs(config.Effective.InputCharactersPerContextToken - expectedRatio) < 1e-12);
      assert.equal(config.Effective.MaxInputCharacters, 237565);
      assert.equal(config.Effective.ChunkThresholdCharacters, 237565);
      assert.equal(config.Thresholds.MaxInputCharacters, undefined);
    }, {
      config: {
        LlamaCpp: null,
        Ollama: {
          NumCtx: 16384,
          NumPredict: 2048,
        },
        Thresholds: {
          MaxInputCharacters: 32000,
          ChunkThresholdRatio: 0.75,
        },
      },
    });
  });
});

test('loadConfig removes legacy chunk threshold ratio from loaded and persisted config', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      await loadConfig({ ensure: true });
      const config = await loadConfig({ ensure: true });
      const persisted = await requestJson(server.configUrl);

      assert.ok(!Object.prototype.hasOwnProperty.call(config.Thresholds, 'ChunkThresholdRatio'));
      assert.ok(!Object.prototype.hasOwnProperty.call(config.Effective, 'ChunkThresholdRatio'));
      assert.ok(!Object.prototype.hasOwnProperty.call(persisted.Thresholds, 'ChunkThresholdRatio'));
    }, {
      config: {
        Thresholds: {
          ChunkThresholdRatio: 0.75,
        },
      },
      metrics: {
        inputCharactersTotal: 3461904,
        inputTokensTotal: 1865267,
      },
    });
  });
});

test('loadConfig fails closed when observed telemetry previously existed and status metrics later become unusable', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });
      assert.equal(config.Effective.BudgetSource, 'ObservedCharsPerToken');
    });

    await withStubServer(async () => {
      await assert.rejects(
        () => loadConfig({ ensure: true }),
        /previously recorded a valid observed chars-per-token budget.*no longer provides usable input character\/token totals/u
      );
    }, {
      metrics: {
        inputCharactersTotal: 0,
        inputTokensTotal: 0,
        outputCharactersTotal: 0,
        outputTokensTotal: 0,
        thinkingTokensTotal: 0,
        completedRequestCount: 0,
        requestDurationMsTotal: 0,
      },
    });
  });
});

test('loadConfig fails closed when observed telemetry previously existed and the status backend later becomes unavailable', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });
      assert.equal(config.Effective.BudgetSource, 'ObservedCharsPerToken');
    });

    await withStubServer(async (server) => {
      process.env.SIFTKIT_CONFIG_SERVICE_URL = server.configUrl;
      process.env.SIFTKIT_STATUS_BACKEND_URL = 'http://127.0.0.1:4779/status';
      await assert.rejects(
        () => loadConfig({ ensure: true }),
        /previously recorded a valid observed chars-per-token budget.*status server is unavailable/i
      );
    }, {
      metrics: {
        inputCharactersTotal: 0,
        inputTokensTotal: 0,
        outputCharactersTotal: 0,
        outputTokensTotal: 0,
        thinkingTokensTotal: 0,
        completedRequestCount: 0,
        requestDurationMsTotal: 0,
      },
    });
  });
});

test('loadConfig derives effective budgets from aggregate prompt character and token totals', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });
      const expectedRatio = 3461904 / 1865267;

      assert.equal(config.Effective.BudgetSource, 'ObservedCharsPerToken');
      assert.ok(Math.abs(config.Effective.InputCharactersPerContextToken - expectedRatio) < 1e-12);
      assert.equal(config.Effective.MaxInputCharacters, 237565);
      assert.equal(config.Effective.ChunkThresholdCharacters, 237565);
      assert.equal(getChunkThresholdCharacters(config), 237565);
    }, {
      metrics: {
        inputCharactersTotal: 3461904,
        inputTokensTotal: 1865267,
      },
    });
  });
});

test('saveConfig preserves explicit llama.cpp thread settings through the external server', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      config.LlamaCpp.Threads = 8;

      const saved = await saveConfig(config);
      const persisted = await requestJson(server.configUrl);

      assert.equal(saved.LlamaCpp.Threads, 8);
      assert.equal(persisted.LlamaCpp.Threads, 8);
    });
  });
});

test('summarizeRequest recursively merges oversized mock summaries when the external server is available', async () => {
  await withTempEnv(async (tempRoot) => {
    await withStubServer(async () => {
      process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR = 'recursive-merge';
      const logPath = path.join(tempRoot, 'provider-events.jsonl');
      process.env.SIFTKIT_TEST_PROVIDER_LOG_PATH = logPath;

      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const result = await summarizeRequest({
        question: 'summarize this',
        inputText: 'A'.repeat((threshold * 3) + 1),
        format: 'text',
        policyProfile: 'general',
        backend: 'mock',
        model: 'mock-model',
      });

      const events = fs.readFileSync(logPath, 'utf8')
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line));
      const leafCalls = events.filter((event) => event.phase === 'leaf').length;
      const mergeCalls = events.filter((event) => event.phase === 'merge').length;

      assert.equal(result.WasSummarized, true);
      assert.equal(result.Summary, 'merge summary');
      assert.equal(leafCalls, 4);
      assert.ok(mergeCalls > 1);
    });
  });
});

test('summarizeRequest splits using the observed aggregate chars-per-token average', async () => {
  await withTempEnv(async (tempRoot) => {
    await withStubServer(async () => {
      const logPath = path.join(tempRoot, 'provider-events-observed-threshold.jsonl');
      process.env.SIFTKIT_TEST_PROVIDER_LOG_PATH = logPath;

      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputLength = threshold + 1;
      const result = await summarizeRequest({
        question: 'summarize this',
        inputText: 'A'.repeat(inputLength),
        format: 'text',
        policyProfile: 'general',
        backend: 'mock',
        model: 'mock-model',
      });

      const events = fs.readFileSync(logPath, 'utf8')
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line));
      const leafCalls = events.filter((event) => event.phase === 'leaf').length;
      const mergeCalls = events.filter((event) => event.phase === 'merge').length;

      assert.equal(threshold, 237565);
      assert.equal(result.WasSummarized, true);
      assert.equal(result.Summary, 'mock summary');
      assert.equal(leafCalls, 2);
      assert.equal(mergeCalls, 1);
    }, {
      metrics: {
        inputCharactersTotal: 3461904,
        inputTokensTotal: 1865267,
      },
    });
  });
});

test('summarizeRequest fails closed when observed telemetry existed and the status snapshot later becomes unusable', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });
      assert.equal(config.Effective.BudgetSource, 'ObservedCharsPerToken');
    });

    await withStubServer(async () => {
      await assert.rejects(
        () => summarizeRequest({
          question: 'summarize this',
          inputText: 'A'.repeat(5000),
          format: 'text',
          policyProfile: 'general',
          backend: 'mock',
          model: 'mock-model',
        }),
        /previously recorded a valid observed chars-per-token budget.*no longer provides usable input character\/token totals/i
      );
    }, {
      metrics: {
        inputCharactersTotal: 0,
        inputTokensTotal: 0,
        outputCharactersTotal: 0,
        outputTokensTotal: 0,
        thinkingTokensTotal: 0,
        completedRequestCount: 0,
        requestDurationMsTotal: 0,
      },
    });
  });
});

test('concurrent oversized CLI summary requests are serialized until the first request fully completes', async () => {
  await withTempEnv(async (tempRoot) => {
    await withSummaryTestServer(async () => {
      process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR = 'recursive-merge';
      process.env.SIFTKIT_TEST_PROVIDER_SLEEP_MS = '100';
      const logPath = path.join(tempRoot, 'provider-events-concurrent.jsonl');
      process.env.SIFTKIT_TEST_PROVIDER_LOG_PATH = logPath;

      const firstInputPath = path.join(tempRoot, 'oversized-a.txt');
      const secondInputPath = path.join(tempRoot, 'oversized-b.txt');
      fs.writeFileSync(firstInputPath, 'A'.repeat(300_001), 'utf8');
      fs.writeFileSync(secondInputPath, 'B'.repeat(300_001), 'utf8');

      const cliPath = path.join(process.cwd(), 'bin', 'siftkit.js');
      const childEnv = {
        ...process.env,
        SIFTKIT_TEST_PROVIDER: 'mock',
        SIFTKIT_TEST_PROVIDER_BEHAVIOR: 'recursive-merge',
        SIFTKIT_TEST_PROVIDER_SLEEP_MS: '100',
        SIFTKIT_TEST_PROVIDER_LOG_PATH: logPath,
      };

      const [firstResult, secondResult] = await Promise.all([
        spawnProcess(process.execPath, [
          cliPath,
          'summary',
          '--question',
          'summarize oversized request A',
          '--file',
          firstInputPath,
          '--backend',
          'mock',
          '--model',
          'mock-model',
        ], {
          cwd: process.cwd(),
          env: childEnv,
        }),
        spawnProcess(process.execPath, [
          cliPath,
          'summary',
          '--question',
          'summarize oversized request B',
          '--file',
          secondInputPath,
          '--backend',
          'mock',
          '--model',
          'mock-model',
        ], {
          cwd: process.cwd(),
          env: childEnv,
        }),
      ]);

      const events = fs.readFileSync(logPath, 'utf8')
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line));
      const questions = events.map((event) => event.question);
      const firstQuestion = 'summarize oversized request A';
      const secondQuestion = 'summarize oversized request B';
      const referencesFirstRequest = (question) => String(question).includes(firstQuestion);
      const referencesSecondRequest = (question) => String(question).includes(secondQuestion);
      const firstSecondIndex = questions.indexOf(secondQuestion);

      assert.equal(firstResult.code, 0);
      assert.equal(secondResult.code, 0);
      assert.match(firstResult.stdout, /merge summary/u);
      assert.match(secondResult.stdout, /merge summary/u);
      assert.equal(firstResult.stderr, '');
      assert.equal(secondResult.stderr, '');
      assert.ok(firstSecondIndex > 0);
      assert.equal(questions.slice(0, firstSecondIndex).some(referencesSecondRequest), false);
      assert.equal(questions.slice(firstSecondIndex).some(referencesFirstRequest), false);
      assert.ok(questions.slice(0, firstSecondIndex).every(referencesFirstRequest));
      assert.ok(questions.slice(firstSecondIndex).every(referencesSecondRequest));
    }, {
      running: false,
    });
  });
});

test('runCommand saves a raw log and respects no-summarize mode when the external server is available', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const result = await runCommand({
        Command: 'node',
        ArgumentList: ['-e', "console.log('stdout line'); console.error('stderr line');"],
        Question: 'what failed?',
        Backend: 'mock',
        Model: 'mock-model',
        NoSummarize: true,
      });

      assert.equal(result.WasSummarized, false);
      assert.ok(result.RawLogPath);
      assert.equal(fs.existsSync(result.RawLogPath), true);
      const rawLog = fs.readFileSync(result.RawLogPath, 'utf8');
      assert.match(rawLog, /stdout line/u);
      assert.match(rawLog, /stderr line/u);
    });
  });
});

test('saveConfig fails closed with the canonical message when the external server is unreachable', async () => {
  await withTempEnv(async () => {
    process.env.SIFTKIT_STATUS_PORT = '4779';
    process.env.SIFTKIT_STATUS_BACKEND_URL = 'http://127.0.0.1:4779/status';
    process.env.SIFTKIT_CONFIG_SERVICE_URL = 'http://127.0.0.1:4779/config';

    const config = getDefaultConfig();
    await assert.rejects(
      () => saveConfig(config),
      new RegExp(getStatusServerUnavailableMessage().replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u')
    );
  });
});

test('status notification failures fail closed with the canonical message', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      await assert.rejects(
        () => summarizeRequest({
          question: 'summarize this',
          inputText: 'A'.repeat(5000),
          format: 'text',
          policyProfile: 'general',
          backend: 'mock',
          model: 'mock-model',
        }),
        new RegExp(getStatusServerUnavailableMessage().replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u')
      );
    }, {
      failStatusPosts: true,
    });
  });
});

test('withExecutionLock acquires and releases execution control through the server', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const result = await withExecutionLock(async () => 'ok');
      const state = await getExecutionServerState();

      assert.equal(result, 'ok');
      assert.equal(state.busy, false);
    });
  });
});

test('withExecutionLock waits for the server to release execution control before starting', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      server.state.executionLeaseToken = 'lease-busy';
      const startedAt = Date.now();
      setTimeout(() => {
        server.state.executionLeaseToken = null;
      }, 300);

      const result = await withExecutionLock(async () => Date.now() - startedAt);

      assert.equal(typeof result, 'number');
      assert.ok(result >= 250);
      assert.equal(server.state.executionLeaseToken, null);
    });
  });
});

test('real status server clears stale true status once during startup', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const config = getDefaultConfig();
    config.Backend = 'noop';
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(statusPath, 'true', 'utf8');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ statusPath: liveStatusPath }) => {
      assert.equal(fs.readFileSync(liveStatusPath, 'utf8').trim(), 'false');
      await sleep(250);
      assert.equal(fs.readFileSync(liveStatusPath, 'utf8').trim(), 'false');
    }, {
      statusPath,
      configPath,
    });
  });
});

test('real status server initializes a missing status file to false', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const config = getDefaultConfig();
    config.Backend = 'noop';
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ statusUrl, statusPath: liveStatusPath }) => {
      assert.equal(fs.readFileSync(liveStatusPath, 'utf8').trim(), 'false');
      const status = await requestJson(statusUrl);
      assert.equal(status.running, false);
      assert.equal(status.status, 'false');
    }, {
      statusPath,
      configPath,
    });
  });
});

test('real status server health reports disableManagedLlamaStartup mode when flagged', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const config = getDefaultConfig();
    config.Backend = 'noop';
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ healthUrl }) => {
      const health = await requestJson(healthUrl);
      assert.equal(health.ok, true);
      assert.equal(health.disableManagedLlamaStartup, true);
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });
  });
});

test('real status server with disableManagedLlamaStartup skips managed llama bootstrap during server startup', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaScripts(tempRoot, llamaPort);
    const config = getDefaultConfig();
    setManagedLlamaBaseUrl(config, managed.baseUrl);
    config.Server = {
      LlamaCpp: {
        StartupScript: managed.startupScriptPath,
        ShutdownScript: managed.shutdownScriptPath,
        StartupTimeoutMs: 5000,
        HealthcheckTimeoutMs: 200,
        HealthcheckIntervalMs: 50,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ statusUrl }) => {
      await sleep(250);
      assert.equal(fs.existsSync(managed.readyFilePath), false);
      const status = await requestJson(statusUrl);
      assert.equal(status.running, false);
      assert.equal(status.status, 'false');
      assert.equal(fs.readFileSync(statusPath, 'utf8').trim(), 'false');
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });
  });
});

test('real status server with disableManagedLlamaStartup does not trigger managed startup from GET /config', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaScripts(tempRoot, llamaPort);
    const config = getDefaultConfig();
    setManagedLlamaBaseUrl(config, managed.baseUrl);
    config.Server = {
      LlamaCpp: {
        StartupScript: managed.startupScriptPath,
        ShutdownScript: managed.shutdownScriptPath,
        StartupTimeoutMs: 5000,
        HealthcheckTimeoutMs: 200,
        HealthcheckIntervalMs: 50,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ configUrl }) => {
      const loadedConfig = await requestJson(configUrl);
      assert.equal(loadedConfig.Server.LlamaCpp.StartupScript, managed.startupScriptPath);
      await sleep(250);
      assert.equal(fs.existsSync(managed.readyFilePath), false);
    }, {
      statusPath,
      configPath,
      disableManagedLlamaStartup: true,
    });
  });
});

test('real status server with disableManagedLlamaStartup leaves an externally started llama running across boot and close', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaScripts(tempRoot, llamaPort);
    const config = getDefaultConfig();
    setManagedLlamaBaseUrl(config, managed.baseUrl);
    config.Server = {
      LlamaCpp: {
        StartupScript: managed.startupScriptPath,
        ShutdownScript: managed.shutdownScriptPath,
        StartupTimeoutMs: 5000,
        HealthcheckTimeoutMs: 200,
        HealthcheckIntervalMs: 50,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    const externalLlama = spawn(process.execPath, [managed.fakeServerPath], {
      stdio: 'ignore',
      windowsHide: true,
    });

    try {
      await waitForAsyncExpectation(async () => {
        const models = await requestJson(`${managed.baseUrl}/v1/models`);
        assert.equal(models.data[0].id, 'managed-test-model');
      }, 5000);

      await withRealStatusServer(async () => {
        await waitForAsyncExpectation(async () => {
          const models = await requestJson(`${managed.baseUrl}/v1/models`);
          assert.equal(models.data[0].id, 'managed-test-model');
        }, 1000);
      }, {
        statusPath,
        configPath,
        disableManagedLlamaStartup: true,
      });

      await waitForAsyncExpectation(async () => {
        const models = await requestJson(`${managed.baseUrl}/v1/models`);
        assert.equal(models.data[0].id, 'managed-test-model');
      }, 1000);
    } finally {
      externalLlama.kill('SIGTERM');
      await new Promise((resolve) => externalLlama.once('close', resolve));
    }
  });
});

test('real status server preserves foreign_lock while siftkit is idle', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const config = getDefaultConfig();
    config.Backend = 'noop';
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(statusPath, 'foreign_lock', 'utf8');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ statusUrl, statusPath: liveStatusPath }) => {
      assert.equal(fs.readFileSync(liveStatusPath, 'utf8').trim(), 'foreign_lock');
      await sleep(10_500);
      assert.equal(fs.readFileSync(liveStatusPath, 'utf8').trim(), 'foreign_lock');
      const status = await requestJson(statusUrl);
      assert.equal(status.running, false);
      assert.equal(status.status, 'foreign_lock');
    }, {
      statusPath,
      configPath,
    });
  });
});

test('real status server publishes lock_requested while waiting on a foreign_lock', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const config = getDefaultConfig();
    config.Backend = 'noop';
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(statusPath, 'foreign_lock', 'utf8');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ statusUrl }) => {
      const acquirePromise = requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: true, rawInputCharacterCount: 25 }),
      });

      await waitForAsyncExpectation(async () => {
        assert.equal(fs.readFileSync(statusPath, 'utf8').trim(), 'lock_requested');
        const waitingStatus = await requestJson(statusUrl);
        assert.equal(waitingStatus.running, false);
        assert.equal(waitingStatus.status, 'lock_requested');
      }, 2000);

      fs.writeFileSync(statusPath, 'false', 'utf8');

      const acquired = await acquirePromise;
      assert.equal(acquired.running, true);
      assert.equal(acquired.status, 'true');
      assert.equal(fs.readFileSync(statusPath, 'utf8').trim(), 'true');

      await requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: false, promptCharacterCount: 25, inputTokens: 5, outputCharacterCount: 4, outputTokens: 1, requestDurationMs: 10 }),
      });
    }, {
      statusPath,
      configPath,
    });
  });
});

test('real status server rejects shared-file statuses in POST /status payloads', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const config = getDefaultConfig();
    config.Backend = 'noop';
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ statusUrl }) => {
      await assert.rejects(() => requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({ status: 'foreign_lock' }),
      }), /Expected running=true\|false or status=true\|false\./u);
    }, {
      statusPath,
      configPath,
    });
  });
});

test('real status server preserves true status while an active request is tracked', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const config = getDefaultConfig();
    config.Backend = 'noop';
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ statusUrl, statusPath: liveStatusPath }) => {
      await requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: true }),
      });

      assert.equal(fs.readFileSync(liveStatusPath, 'utf8').trim(), 'true');
      await sleep(10_500);
      assert.equal(fs.readFileSync(liveStatusPath, 'utf8').trim(), 'true');
    }, {
      statusPath,
      configPath,
    });
  });
});

test('real status server persists aggregate metrics and exposes them from GET /status', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const metricsPath = path.join(tempRoot, 'metrics', 'compression.json');
    const config = getDefaultConfig();
    config.Backend = 'noop';
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ statusUrl }) => {
      await requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: true, rawInputCharacterCount: 400 }),
      });
      await requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: false, promptCharacterCount: 410, inputTokens: 100, outputCharacterCount: 120, outputTokens: 25, requestDurationMs: 800 }),
      });

      const status = await requestJson(statusUrl);
      assert.equal(status.metrics.inputCharactersTotal, 410);
      assert.equal(status.metrics.outputCharactersTotal, 120);
      assert.equal(status.metrics.inputTokensTotal, 100);
      assert.equal(status.metrics.outputTokensTotal, 25);
      assert.equal(status.metrics.thinkingTokensTotal, 0);
      assert.equal(status.metrics.requestDurationMsTotal, 800);
      assert.equal(status.metrics.completedRequestCount, 1);
      assert.equal(typeof status.metrics.updatedAtUtc, 'string');
      assert.equal(fs.existsSync(metricsPath), true);
    }, {
      statusPath,
      configPath,
    });

    await withRealStatusServer(async ({ statusUrl }) => {
      const status = await requestJson(statusUrl);
      assert.equal(status.metrics.inputCharactersTotal, 410);
      assert.equal(status.metrics.outputCharactersTotal, 120);
      assert.equal(status.metrics.inputTokensTotal, 100);
      assert.equal(status.metrics.outputTokensTotal, 25);
      assert.equal(status.metrics.thinkingTokensTotal, 0);
      assert.equal(status.metrics.requestDurationMsTotal, 800);
      assert.equal(status.metrics.completedRequestCount, 1);
    }, {
      statusPath,
      configPath,
    });
  });
});

test('real status server starts managed llama.cpp during server startup before serving requests', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaScripts(tempRoot, llamaPort);
    const config = getDefaultConfig();
    setManagedLlamaBaseUrl(config, managed.baseUrl);
    config.Server = {
      LlamaCpp: {
        StartupScript: managed.startupScriptPath,
        ShutdownScript: managed.shutdownScriptPath,
        StartupTimeoutMs: 5000,
        HealthcheckTimeoutMs: 200,
        HealthcheckIntervalMs: 50,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ port, statusUrl }) => {
      assert.equal(fs.readFileSync(statusPath, 'utf8').trim(), 'true');
      await waitForAsyncExpectation(async () => {
        const models = await requestJson(`${managed.baseUrl}/v1/models`);
        assert.equal(models.data[0].id, 'managed-test-model');
      }, 5000);
      await waitForAsyncExpectation(async () => {
        const status = await requestJson(statusUrl);
        assert.equal(status.running, true);
        assert.equal(status.status, 'true');
        assert.equal(fs.readFileSync(statusPath, 'utf8').trim(), 'true');
      }, 5000);
      const latestStartupDumpPath = path.join(tempRoot, 'logs', 'managed-llama', 'latest-startup.log');
      assert.equal(fs.existsSync(latestStartupDumpPath), true);
      const latestStartupDumpText = fs.readFileSync(latestStartupDumpPath, 'utf8');
      assert.match(latestStartupDumpText, /Result: ready/u);
      assert.match(latestStartupDumpText, /startup_script_stdout/u);

      const previousConfigUrl = process.env.SIFTKIT_CONFIG_SERVICE_URL;
      const previousStatusUrl = process.env.SIFTKIT_STATUS_BACKEND_URL;
      process.env.SIFTKIT_CONFIG_SERVICE_URL = `http://127.0.0.1:${port}/config`;
      process.env.SIFTKIT_STATUS_BACKEND_URL = statusUrl;

      try {
        const loadedConfig = await loadConfig({ ensure: true });
        assert.equal(loadedConfig.LlamaCpp.BaseUrl, managed.baseUrl);
        assert.equal(loadedConfig.Server.LlamaCpp.StartupScript, managed.startupScriptPath);
      } finally {
        if (previousConfigUrl === undefined) {
          delete process.env.SIFTKIT_CONFIG_SERVICE_URL;
        } else {
          process.env.SIFTKIT_CONFIG_SERVICE_URL = previousConfigUrl;
        }
        if (previousStatusUrl === undefined) {
          delete process.env.SIFTKIT_STATUS_BACKEND_URL;
        } else {
          process.env.SIFTKIT_STATUS_BACKEND_URL = previousStatusUrl;
        }
      }

      assert.equal(fs.existsSync(managed.readyFilePath), true);
    }, {
      statusPath,
      configPath,
    });

    await waitForAsyncExpectation(
      async () => assert.rejects(() => requestJson(`${managed.baseUrl}/v1/models`)),
      5000
    );
    await waitForAsyncExpectation(async () => {
      assert.equal(fs.existsSync(managed.pidFilePath), false);
    }, 5000);
    await sleep(250);
  });
});

test('real status server waits behind foreign_lock before starting managed llama.cpp', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaScripts(tempRoot, llamaPort);
    const config = getDefaultConfig();
    setManagedLlamaBaseUrl(config, managed.baseUrl);
    config.Server = {
      LlamaCpp: {
        StartupScript: managed.startupScriptPath,
        ShutdownScript: managed.shutdownScriptPath,
        StartupTimeoutMs: 5000,
        HealthcheckTimeoutMs: 200,
        HealthcheckIntervalMs: 50,
      },
    };
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(statusPath, 'foreign_lock', 'utf8');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ statusUrl }) => {
      await waitForAsyncExpectation(async () => {
        const status = await requestJson(statusUrl);
        assert.equal(status.running, false);
        assert.equal(status.status, 'lock_requested');
        assert.equal(fs.readFileSync(statusPath, 'utf8').trim(), 'lock_requested');
      }, 2000);
      assert.equal(fs.existsSync(managed.readyFilePath), false);

      fs.writeFileSync(statusPath, 'false', 'utf8');

      await waitForAsyncExpectation(async () => {
        assert.equal(fs.existsSync(managed.readyFilePath), true);
        const status = await requestJson(statusUrl);
        assert.equal(status.running, true);
        assert.equal(status.status, 'true');
      }, 5000);
    }, {
      statusPath,
      configPath,
    });
  });
});

test('real status server keeps published true status while managed llama stays ready', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaScripts(tempRoot, llamaPort);
    const config = getDefaultConfig();
    setManagedLlamaBaseUrl(config, managed.baseUrl);
    config.Server = {
      LlamaCpp: {
        StartupScript: managed.startupScriptPath,
        ShutdownScript: managed.shutdownScriptPath,
        StartupTimeoutMs: 5000,
        HealthcheckTimeoutMs: 200,
        HealthcheckIntervalMs: 50,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ statusUrl }) => {
      await waitForAsyncExpectation(async () => {
        const models = await requestJson(`${managed.baseUrl}/v1/models`);
        assert.equal(models.data[0].id, 'managed-test-model');
      }, 5000);

      assert.equal(fs.readFileSync(statusPath, 'utf8').trim(), 'true');
      await sleep(10_500);

      const status = await requestJson(statusUrl);
      assert.equal(status.running, true);
      assert.equal(status.status, 'true');
      assert.equal(fs.readFileSync(statusPath, 'utf8').trim(), 'true');
    }, {
      statusPath,
      configPath,
    });
  });
});

test('real status server keeps startup status true when the startup script calls config before launch', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaScripts(tempRoot, llamaPort, 'managed-test-model', {
      preflightConfigGet: true,
    });
    const config = getDefaultConfig();
    setManagedLlamaBaseUrl(config, managed.baseUrl);
    config.Server = {
      LlamaCpp: {
        StartupScript: managed.startupScriptPath,
        ShutdownScript: managed.shutdownScriptPath,
        StartupTimeoutMs: 5000,
        HealthcheckTimeoutMs: 200,
        HealthcheckIntervalMs: 50,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await withRealStatusServer(async ({ statusUrl }) => {
      assert.equal(fs.readFileSync(statusPath, 'utf8').trim(), 'true');
      await waitForAsyncExpectation(async () => {
        const models = await requestJson(`${managed.baseUrl}/v1/models`);
        assert.equal(models.data[0].id, 'managed-test-model');
      }, 5000);

      const status = await requestJson(statusUrl);
      assert.equal(status.running, true);
      assert.equal(status.status, 'true');
      assert.equal(fs.readFileSync(statusPath, 'utf8').trim(), 'true');
    }, {
      statusPath,
      configPath,
    });
  });
});

test('real status server fails closed during startup when managed llama logs contain warnings', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaScripts(tempRoot, llamaPort, 'managed-test-model', {
      llamaLogLine: 'warning: fake llama startup warning',
    });
    const config = getDefaultConfig();
    setManagedLlamaBaseUrl(config, managed.baseUrl);
    config.Server = {
      LlamaCpp: {
        StartupScript: managed.startupScriptPath,
        ShutdownScript: managed.shutdownScriptPath,
        StartupTimeoutMs: 5000,
        HealthcheckTimeoutMs: 200,
        HealthcheckIntervalMs: 50,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    await assert.rejects(
      () => startStatusServerProcess({
        statusPath,
        configPath,
      }),
      /startup logs contained warning\/error markers/i
    );

    const managedLogRoot = path.join(tempRoot, 'logs', 'managed-llama');
    const dumpFiles = fs.existsSync(managedLogRoot)
      ? fs.readdirSync(managedLogRoot, { recursive: true })
        .map((entry) => path.join(managedLogRoot, String(entry)))
        .filter((entryPath) => /startup-scan-failure\.log$/u.test(entryPath))
      : [];
    assert.ok(dumpFiles.length > 0);
    const dumpText = fs.readFileSync(dumpFiles[0], 'utf8');
    assert.match(dumpText, /warning: fake llama startup warning/u);
    const latestStartupDumpPath = path.join(tempRoot, 'logs', 'managed-llama', 'latest-startup.log');
    assert.equal(fs.existsSync(latestStartupDumpPath), true);
    assert.match(fs.readFileSync(latestStartupDumpPath, 'utf8'), /Result: failed/u);
  });
});

test('real status server aborts a broken managed llama startup during server startup within the capped timeout', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaScripts(tempRoot, llamaPort, 'managed-test-model', {
      launchHangingProcess: true,
    });
    const config = getDefaultConfig();
    setManagedLlamaBaseUrl(config, managed.baseUrl);
    config.Server = {
      LlamaCpp: {
        StartupScript: managed.startupScriptPath,
        ShutdownScript: managed.shutdownScriptPath,
        StartupTimeoutMs: 60_000,
        HealthcheckTimeoutMs: 200,
        HealthcheckIntervalMs: 50,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    const startedAt = Date.now();
    await assert.rejects(
      () => startStatusServerProcess({
        statusPath,
        configPath,
      }),
      /Timed out waiting for llama\.cpp server .* to become ready/i
    );
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 31_000);
    assert.equal(fs.existsSync(managed.pidFilePath), false);
    const latestStartupDumpPath = path.join(tempRoot, 'logs', 'managed-llama', 'latest-startup.log');
    assert.equal(fs.existsSync(latestStartupDumpPath), true);
    const latestStartupDumpText = fs.readFileSync(latestStartupDumpPath, 'utf8');
    assert.match(latestStartupDumpText, /Result: failed/u);
    assert.match(latestStartupDumpText, /Timed out waiting for llama\.cpp server/u);
  });
});

test('real status server clears a stale managed llama process during startup before serving requests', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaScripts(tempRoot, llamaPort);
    const config = getDefaultConfig();
    setManagedLlamaBaseUrl(config, managed.baseUrl);
    config.Server = {
      LlamaCpp: {
        StartupScript: managed.startupScriptPath,
        ShutdownScript: managed.shutdownScriptPath,
        StartupTimeoutMs: 5000,
        HealthcheckTimeoutMs: 200,
        HealthcheckIntervalMs: 50,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    runPowerShellScript(managed.startupScriptPath);
    await waitForAsyncExpectation(async () => {
      const models = await requestJson(`${managed.baseUrl}/v1/models`);
      assert.equal(models.data[0].id, 'managed-test-model');
    }, 5000);

    await withRealStatusServer(async ({ port }) => {
      await waitForAsyncExpectation(
        async () => assert.rejects(() => requestJson(`${managed.baseUrl}/v1/models`)),
        5000
      );

      const previousConfigUrl = process.env.SIFTKIT_CONFIG_SERVICE_URL;
      const previousStatusUrl = process.env.SIFTKIT_STATUS_BACKEND_URL;
      process.env.SIFTKIT_CONFIG_SERVICE_URL = `http://127.0.0.1:${port}/config`;
      process.env.SIFTKIT_STATUS_BACKEND_URL = `http://127.0.0.1:${port}/status`;
      try {
        const loadedConfig = await loadConfig({ ensure: true });
        assert.equal(loadedConfig.LlamaCpp.BaseUrl, managed.baseUrl);
        await waitForAsyncExpectation(async () => {
          const models = await requestJson(`${managed.baseUrl}/v1/models`);
          assert.equal(models.data[0].id, 'managed-test-model');
        }, 5000);
      } finally {
        if (previousConfigUrl === undefined) {
          delete process.env.SIFTKIT_CONFIG_SERVICE_URL;
        } else {
          process.env.SIFTKIT_CONFIG_SERVICE_URL = previousConfigUrl;
        }
        if (previousStatusUrl === undefined) {
          delete process.env.SIFTKIT_STATUS_BACKEND_URL;
        } else {
          process.env.SIFTKIT_STATUS_BACKEND_URL = previousStatusUrl;
        }
      }
    }, {
      statusPath,
      configPath,
    });
  });
});

test('real status server falls back to zeroed metrics when the metrics cache is invalid', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const metricsPath = path.join(tempRoot, 'metrics', 'compression.json');

    fs.mkdirSync(path.dirname(metricsPath), { recursive: true });
    fs.writeFileSync(metricsPath, '{invalid-json', 'utf8');

    await withRealStatusServer(async ({ statusUrl }) => {
      const status = await requestJson(statusUrl);
      assert.deepEqual(status.metrics, {
        inputCharactersTotal: 0,
        outputCharactersTotal: 0,
        inputTokensTotal: 0,
        outputTokensTotal: 0,
        thinkingTokensTotal: 0,
        requestDurationMsTotal: 0,
        completedRequestCount: 0,
        updatedAtUtc: null,
      });
    }, {
      statusPath,
      configPath,
    });
  });
});

test('CLI summary fails closed with the canonical message when the external server is unreachable', async () => {
  await withTempEnv(async () => {
    const port = '4778';
    const expectedMessage = `SiftKit status/config server is not reachable at http://127.0.0.1:${port}/health. Start the separate server process and stop issuing further siftkit commands until it is available.`;
    const result = spawnSync(
      process.execPath,
      [path.join(process.cwd(), 'bin', 'siftkit.js'), 'summary', '--question', 'summarize this', '--text', 'hello world'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          SIFTKIT_STATUS_BACKEND_URL: `http://127.0.0.1:${port}/status`,
          SIFTKIT_CONFIG_SERVICE_URL: `http://127.0.0.1:${port}/config`,
          SIFTKIT_STATUS_PORT: port,
        },
      }
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(expectedMessage.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  });
});

test('local-only find-files CLI works without the external server', async () => {
  await withTempEnv(async () => {
    const port = '4777';
    const result = spawnSync(
      process.execPath,
      [path.join(process.cwd(), 'bin', 'siftkit.js'), 'find-files', '--path', '.', 'package.json'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          SIFTKIT_STATUS_BACKEND_URL: `http://127.0.0.1:${port}/status`,
          SIFTKIT_CONFIG_SERVICE_URL: `http://127.0.0.1:${port}/config`,
          SIFTKIT_STATUS_PORT: port,
        },
      }
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /package\.json/u);
  });
});

test('llama.cpp provider lists models and parses chat completions from the stub server', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });
      const models = await listLlamaCppModels(config);
      const summary = await generateLlamaCppResponse({
        config,
        model: config.Model,
        prompt: 'test prompt body',
        timeoutSeconds: 5,
      });

      assert.deepEqual(models, [config.Model]);
      assert.match(summary.text, /^summary:/u);
      assert.deepEqual(summary.usage, {
        promptTokens: 123,
        completionTokens: 45,
        totalTokens: 168,
        thinkingTokens: null,
      });
    });
  });
});

test('llama.cpp provider returns null usage when the server omits token usage', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });
      const summary = await generateLlamaCppResponse({
        config,
        model: config.Model,
        prompt: 'test prompt body',
        timeoutSeconds: 5,
      });

      assert.equal(summary.usage, null);
      assert.match(summary.text, /^summary:/u);
    }, {
      omitUsage: true,
    });
  });
});

test('llama.cpp provider records thinking tokens separately from completion usage', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });
      const summary = await generateLlamaCppResponse({
        config,
        model: config.Model,
        prompt: 'test prompt body',
        timeoutSeconds: 5,
      });

      assert.deepEqual(summary.usage, {
        promptTokens: 123,
        completionTokens: 33,
        totalTokens: 168,
        thinkingTokens: 12,
      });
      assert.match(summary.text, /^summary:/u);
    }, {
      reasoningTokens: 12,
    });
  });
});

test('summary aggregation accumulates provider usage and duration in status metrics', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const baselineInputCharacters = server.state.metrics.inputCharactersTotal;
      const baselineOutputCharacters = server.state.metrics.outputCharactersTotal;
      const baselineInputTokens = server.state.metrics.inputTokensTotal;
      const baselineOutputTokens = server.state.metrics.outputTokensTotal;
      const baselineThinkingTokens = server.state.metrics.thinkingTokensTotal;
      const baselineCompletedRequestCount = server.state.metrics.completedRequestCount;
      const baselineRequestDurationMs = server.state.metrics.requestDurationMsTotal;
      const result = await summarizeRequest({
        question: 'summarize this',
        inputText: 'A'.repeat(5000),
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.WasSummarized, true);
      assert.ok(server.state.metrics.inputCharactersTotal > baselineInputCharacters);
      assert.ok(server.state.metrics.outputCharactersTotal > baselineOutputCharacters);
      assert.equal(server.state.metrics.inputTokensTotal - baselineInputTokens, 123);
      assert.equal(server.state.metrics.outputTokensTotal - baselineOutputTokens, 45);
      assert.equal(server.state.metrics.thinkingTokensTotal - baselineThinkingTokens, 0);
      assert.equal(server.state.metrics.completedRequestCount - baselineCompletedRequestCount, 1);
      assert.ok(server.state.metrics.requestDurationMsTotal >= baselineRequestDurationMs);
    }, {
      metrics: {
        inputCharactersTotal: 3_461_904,
        inputTokensTotal: 1_865_267,
        outputCharactersTotal: 0,
        outputTokensTotal: 0,
        thinkingTokensTotal: 0,
        completedRequestCount: 0,
        requestDurationMsTotal: 0,
      },
    });
  });
});

test('summary aggregation records duration without tokens when provider usage is absent', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const baselineInputCharacters = server.state.metrics.inputCharactersTotal;
      const baselineOutputCharacters = server.state.metrics.outputCharactersTotal;
      const baselineInputTokens = server.state.metrics.inputTokensTotal;
      const baselineOutputTokens = server.state.metrics.outputTokensTotal;
      const baselineThinkingTokens = server.state.metrics.thinkingTokensTotal;
      const baselineCompletedRequestCount = server.state.metrics.completedRequestCount;
      const baselineRequestDurationMs = server.state.metrics.requestDurationMsTotal;
      const result = await summarizeRequest({
        question: 'summarize this',
        inputText: 'A'.repeat(5000),
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.WasSummarized, true);
      assert.ok(server.state.metrics.inputCharactersTotal > baselineInputCharacters);
      assert.ok(server.state.metrics.outputCharactersTotal > baselineOutputCharacters);
      assert.equal(server.state.metrics.inputTokensTotal - baselineInputTokens, 0);
      assert.equal(server.state.metrics.outputTokensTotal - baselineOutputTokens, 0);
      assert.equal(server.state.metrics.thinkingTokensTotal - baselineThinkingTokens, 0);
      assert.equal(server.state.metrics.completedRequestCount - baselineCompletedRequestCount, 1);
      assert.ok(server.state.metrics.requestDurationMsTotal >= baselineRequestDurationMs);
    }, {
      omitUsage: true,
      metrics: {
        inputCharactersTotal: 3_461_904,
        inputTokensTotal: 1_865_267,
        outputCharactersTotal: 0,
        outputTokensTotal: 0,
        thinkingTokensTotal: 0,
        completedRequestCount: 0,
        requestDurationMsTotal: 0,
      },
    });
  });
});

test('summary aggregation records thinking tokens independently from output metrics', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const baselineInputTokens = server.state.metrics.inputTokensTotal;
      const baselineOutputTokens = server.state.metrics.outputTokensTotal;
      const baselineThinkingTokens = server.state.metrics.thinkingTokensTotal;
      const baselineCompletedRequestCount = server.state.metrics.completedRequestCount;
      const baselineRequestDurationMs = server.state.metrics.requestDurationMsTotal;
      const result = await summarizeRequest({
        question: 'summarize this',
        inputText: 'A'.repeat(5000),
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.WasSummarized, true);
      assert.equal(server.state.metrics.inputTokensTotal - baselineInputTokens, 123);
      assert.equal(server.state.metrics.outputTokensTotal - baselineOutputTokens, 33);
      assert.equal(server.state.metrics.thinkingTokensTotal - baselineThinkingTokens, 12);
      assert.equal(server.state.metrics.completedRequestCount - baselineCompletedRequestCount, 1);
      assert.ok(server.state.metrics.requestDurationMsTotal >= baselineRequestDurationMs);
    }, {
      reasoningTokens: 12,
      metrics: {
        inputCharactersTotal: 3_461_904,
        inputTokensTotal: 1_865_267,
        outputCharactersTotal: 0,
        outputTokensTotal: 0,
        thinkingTokensTotal: 0,
        completedRequestCount: 0,
        requestDurationMsTotal: 0,
      },
    });
  });
});

test('summary retries with smaller chunks when llama.cpp rejects an oversized prompt and tokenization is unavailable', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const result = await summarizeRequest({
        question: 'summarize this',
        inputText: 'A'.repeat(150000),
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.WasSummarized, true);
      assert.match(result.Summary, /^summary:/u);
      assert.ok(server.state.tokenizeRequests.length >= 1);
      assert.ok(server.state.chatRequests.length >= 3);
      const promptLengths = server.state.chatRequests.map((request) => String(request?.messages?.[0]?.content || '').length);
      assert.ok(promptLengths.some((length) => length > 80000));
      assert.ok(promptLengths.some((length) => length <= 80000));
    }, {
      rejectPromptCharsOver: 80000,
      metrics: {
        inputCharactersTotal: 3_461_904,
        inputTokensTotal: 1_865_267,
        outputCharactersTotal: 0,
        outputTokensTotal: 0,
        thinkingTokensTotal: 0,
        completedRequestCount: 0,
        requestDurationMsTotal: 0,
      },
    });
  });
});

test('summary resizes llama.cpp chunks before the first chat request when prompt tokenization exceeds context', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const result = await summarizeRequest({
        question: 'summarize this',
        inputText: 'A'.repeat(150000),
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.WasSummarized, true);
      assert.match(result.Summary, /^summary:/u);
      assert.ok(server.state.tokenizeRequests.length >= 3);
      assert.ok(server.state.chatRequests.length >= 3);
      const promptLengths = server.state.chatRequests.map((request) => String(request?.messages?.[0]?.content || '').length);
      assert.ok(promptLengths.every((length) => length < 128000));
      assert.ok(promptLengths.some((length) => length > 70000));
    }, {
      tokenizeCharsPerToken: 1,
      metrics: {
        inputCharactersTotal: 3_461_904,
        inputTokensTotal: 1_865_267,
        outputCharactersTotal: 0,
        outputTokensTotal: 0,
        thinkingTokensTotal: 0,
        completedRequestCount: 0,
        requestDurationMsTotal: 0,
      },
    });
  });
});

test('summarizeRequest recovers malformed structured llama.cpp JSON when the expected fields are present', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const result = await summarizeRequest({
        question: 'summarize this',
        inputText: 'A'.repeat(5000),
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.WasSummarized, true);
      assert.equal(result.Classification, 'summary');
      assert.equal(result.RawReviewRequired, true);
      assert.match(result.Summary, /contains "quotes" and a raw newline/u);
      assert.match(result.Summary, /Raw review required\./u);
    }, {
      assistantContent: '{"classification":"summary","raw_review_required":true,"output":"contains "quotes" and a raw newline\nRaw review required."}',
      metrics: {
        inputCharactersTotal: 3_461_904,
        inputTokensTotal: 1_865_267,
        outputCharactersTotal: 0,
        outputTokensTotal: 0,
        thinkingTokensTotal: 0,
        completedRequestCount: 0,
        requestDurationMsTotal: 0,
      },
    });
  });
});

test('summary flattens token-aware llama.cpp chunking across sibling boundaries', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const result = await summarizeRequest({
        question: 'summarize this',
        inputText: 'A'.repeat(threshold * 2),
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.WasSummarized, true);
      const chunkPaths = server.state.statusPosts
        .filter((post) => (
          post.running === true
          && post.phase === 'leaf'
          && post.rawInputCharacterCount === threshold * 2
          && typeof post.chunkPath === 'string'
        ))
        .map((post) => String(post.chunkPath));
      assert.ok(chunkPaths.length >= 3);
      assert.ok(chunkPaths.every((chunkPath) => !chunkPath.includes('->')));
    }, {
      tokenizeCharsPerToken: 1,
      metrics: {
        inputCharactersTotal: 3_461_904,
        inputTokensTotal: 1_865_267,
        outputCharactersTotal: 0,
        outputTokensTotal: 0,
        thinkingTokensTotal: 0,
        completedRequestCount: 0,
        requestDurationMsTotal: 0,
      },
    });
  });
});

test('idle metrics formatter emits ANSI colors when enabled on a TTY', () => {
  const message = buildIdleMetricsLogMessage({
    inputCharactersTotal: 200,
    outputCharactersTotal: 80,
    inputTokensTotal: 100,
    outputTokensTotal: 25,
    requestDurationMsTotal: 800,
    completedRequestCount: 1,
  }, {
    isTTY: true,
    env: {},
  });

  assert.match(message, /\u001b\[36minput\u001b\[0m/u);
  assert.match(message, /\u001b\[32moutput\u001b\[0m/u);
  assert.match(message, /\u001b\[33msaved\u001b\[0m/u);
  assert.match(message, /\u001b\[34mtiming\u001b\[0m/u);
});

test('idle metrics formatter disables ANSI colors when NO_COLOR is set', () => {
  const message = buildIdleMetricsLogMessage({
    inputCharactersTotal: 200,
    outputCharactersTotal: 80,
    inputTokensTotal: 100,
    outputTokensTotal: 25,
    requestDurationMsTotal: 800,
    completedRequestCount: 1,
  }, {
    isTTY: true,
    env: { NO_COLOR: '1' },
  });

  assert.doesNotMatch(message, /\u001b\[/u);
  assert.match(message, /  input:  chars=200 tokens=100/u);
});

test('idle metrics formatter disables ANSI colors when stdout is not a TTY', () => {
  const message = buildIdleMetricsLogMessage({
    inputCharactersTotal: 200,
    outputCharactersTotal: 80,
    inputTokensTotal: 100,
    outputTokensTotal: 25,
    requestDurationMsTotal: 800,
    completedRequestCount: 1,
  }, {
    isTTY: false,
    env: {},
  });

  assert.doesNotMatch(message, /\u001b\[/u);
  assert.match(message, /  timing: total=0s avg_request=0\.80s avg_tokens_per_s=31\.25/u);
});

test('idle metrics formatter groups large values and formats days in elapsed durations', () => {
  const message = buildIdleMetricsLogMessage({
    inputCharactersTotal: 1_868_795,
    outputCharactersTotal: 81_979,
    inputTokensTotal: 1_380_110,
    outputTokensTotal: 83_526,
    requestDurationMsTotal: 30 * 3_600_000 + 3 * 60_000 + 53_000,
    completedRequestCount: 279,
  }, {
    isTTY: false,
    env: {},
  });

  assert.equal(message, [
    'requests=279',
    '  input:  chars=1,868,795 tokens=1,380,110',
    '  output: chars=81,979 tokens=83,526',
    '  saved:  tokens=1,296,584 pct=93.95% ratio=16.52x',
    '  timing: total=1:06:03:53 avg_request=387.93s avg_tokens_per_s=0.77',
  ].join('\n'));
});

test('request status log groups large running counts and uses colon elapsed durations', () => {
  assert.equal(formatElapsed(999), '0s');
  assert.equal(formatElapsed(12_000), '12s');
  assert.equal(formatElapsed(187_000), '3:07');
  assert.equal(formatElapsed(7_449_000), '2:04:09');
  assert.equal(formatElapsed(97_200_000), '1:03:00:00');
  assert.equal(
    buildStatusRequestLogMessage({
      running: true,
      rawInputCharacterCount: 101_891,
      chunkInputCharacterCount: 101_891,
      promptCharacterCount: 102_584,
      budgetSource: 'ObservedCharsPerToken',
      inputCharactersPerContextToken: 1.856,
      chunkThresholdCharacters: 237_565,
    }),
    'request true raw_chars=101,891 prompt_chars=102,584 chars_per_token=1.856 chunk_threshold_chars=237,565',
  );
  assert.equal(
    buildStatusRequestLogMessage({
      running: true,
      rawInputCharacterCount: 37_947_467,
      chunkInputCharacterCount: 558_055,
      promptCharacterCount: 560_315,
      budgetSource: 'ObservedCharsPerToken',
      inputCharactersPerContextToken: 4.15,
      chunkThresholdCharacters: 763_603,
      chunkIndex: 1,
      chunkTotal: 2,
      chunkPath: '1/50 -> 1/2',
    }),
    'request true raw_chars=37,947,467 prompt_chars=560,315 chars_per_token=4.150 chunk_threshold_chars=763,603 chunk 1/50 -> 1/2',
  );
  assert.equal(
    buildStatusRequestLogMessage({ running: false, totalElapsedMs: 97_200_000 }),
    'request false total_elapsed=1:03:00:00',
  );
});

test('real status server accumulates provider payload totals across a chunked request while counting one completed request', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');

    await withRealStatusServer(async ({ statusUrl }) => {
      await requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: true, rawInputCharacterCount: 1000, chunkIndex: 1, chunkTotal: 2 }),
      });
      await requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: false, promptCharacterCount: 600, inputTokens: 10, outputCharacterCount: 120, outputTokens: 2, requestDurationMs: 100 }),
      });
      await requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: true, rawInputCharacterCount: 1000, chunkIndex: 2, chunkTotal: 2 }),
      });
      await requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: false, promptCharacterCount: 610, inputTokens: 11, outputCharacterCount: 130, outputTokens: 3, requestDurationMs: 110 }),
      });
      await requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: true, rawInputCharacterCount: 1000 }),
      });
      await requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: false, promptCharacterCount: 400, inputTokens: 5, outputCharacterCount: 60, outputTokens: 1, requestDurationMs: 50 }),
      });

      const status = await requestJson(statusUrl);
      assert.equal(status.metrics.inputCharactersTotal, 1610);
      assert.equal(status.metrics.outputCharactersTotal, 310);
      assert.equal(status.metrics.inputTokensTotal, 26);
      assert.equal(status.metrics.outputTokensTotal, 6);
      assert.equal(status.metrics.thinkingTokensTotal, 0);
      assert.equal(status.metrics.requestDurationMsTotal, 260);
      assert.equal(status.metrics.completedRequestCount, 1);
    }, {
      statusPath,
      configPath,
    });
  });
});

test('real status server prints one idle metrics line only after the full idle delay', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const idleSummaryDbPath = path.join(tempRoot, 'status', 'idle-summary.sqlite');
    const server = await startStatusServerProcess({
      statusPath,
      configPath,
      idleSummaryDbPath,
      idleSummaryDelayMs: 80,
    });

    try {
      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: true, rawInputCharacterCount: 200 }),
      });
      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: false, promptCharacterCount: 200, inputTokens: 100, outputCharacterCount: 80, outputTokens: 25, requestDurationMs: 800 }),
      });

      assert.equal(fs.readFileSync(statusPath, 'utf8').trim(), 'true');
      const pendingStatus = await requestJson(server.statusUrl);
      assert.equal(pendingStatus.running, true);
      assert.equal(pendingStatus.status, 'true');

      await sleep(30);
      assert.equal(server.stdoutLines.some((line) => /idle_metrics/u.test(line)), false);

      await server.waitForStdoutMatch(/requests=1/u, 1000);
      const block = getIdleSummaryBlock(server.stdoutLines, /requests=1/u);
      assert.match(block[0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} requests=1$/u);
      assert.equal(block[1], '  input:  chars=200 tokens=100');
      assert.equal(block[2], '  output: chars=80 tokens=25');
      assert.equal(block[3], '  saved:  tokens=75 pct=75.00% ratio=4.00x');
      assert.equal(block[4], '  timing: total=0s avg_request=0.80s avg_tokens_per_s=31.25');
      assert.equal(fs.readFileSync(statusPath, 'utf8').trim(), 'false');
      const finalStatus = await requestJson(server.statusUrl);
      assert.equal(finalStatus.running, false);
      assert.equal(finalStatus.status, 'false');

      assert.equal(fs.existsSync(idleSummaryDbPath), true);
      const rows = readIdleSummarySnapshots(idleSummaryDbPath);
      assert.equal(rows.length, 1);
      assert.match(rows[0].emitted_at_utc, /^\d{4}-\d{2}-\d{2}T/u);
      assert.deepEqual({ ...rows[0], emitted_at_utc: '<iso>' }, {
        emitted_at_utc: '<iso>',
        completed_request_count: 1,
        input_characters_total: 200,
        output_characters_total: 80,
        input_tokens_total: 100,
        output_tokens_total: 25,
        thinking_tokens_total: 0,
        saved_tokens: 75,
        saved_percent: 0.75,
        compression_ratio: 4,
        request_duration_ms_total: 800,
        avg_request_ms: 800,
        avg_tokens_per_second: 31.25,
      });
    } finally {
      await server.close();
    }
  });
});

test('real status server shuts down managed llama.cpp after the idle summary block is emitted', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const idleSummaryDbPath = path.join(tempRoot, 'status', 'idle-summary.sqlite');
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaScripts(tempRoot, llamaPort);
    const config = getDefaultConfig();
    setManagedLlamaBaseUrl(config, managed.baseUrl);
    config.Server = {
      LlamaCpp: {
        StartupScript: managed.startupScriptPath,
        ShutdownScript: managed.shutdownScriptPath,
        StartupTimeoutMs: 5000,
        HealthcheckTimeoutMs: 200,
        HealthcheckIntervalMs: 50,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    const server = await startStatusServerProcess({
      statusPath,
      configPath,
      idleSummaryDbPath,
      idleSummaryDelayMs: 80,
    });

    try {
      await requestJson(server.configUrl);
      await waitForAsyncExpectation(async () => {
        const models = await requestJson(`${managed.baseUrl}/v1/models`);
        assert.equal(models.data[0].id, 'managed-test-model');
      }, 5000);

      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: true, rawInputCharacterCount: 50 }),
      });
      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: false, promptCharacterCount: 50, inputTokens: 10, outputCharacterCount: 5, outputTokens: 1, requestDurationMs: 20 }),
      });

      await server.waitForStdoutMatch(/requests=1/u, 1000);
      await waitForAsyncExpectation(
        async () => assert.rejects(() => requestJson(`${managed.baseUrl}/v1/models`)),
        5000
      );
      await waitForAsyncExpectation(async () => {
        assert.equal(fs.readFileSync(statusPath, 'utf8').trim(), 'false');
      }, 5000);
    } finally {
      await server.close();
    }
  });
});

test('real status server close() stops managed llama.cpp', async () => {
  await withTempEnv(async (tempRoot) => {
    const previous = {
      SIFTKIT_STATUS_HOST: process.env.SIFTKIT_STATUS_HOST,
      SIFTKIT_STATUS_PORT: process.env.SIFTKIT_STATUS_PORT,
      sift_kit_status: process.env.sift_kit_status,
      SIFTKIT_STATUS_PATH: process.env.SIFTKIT_STATUS_PATH,
      SIFTKIT_CONFIG_PATH: process.env.SIFTKIT_CONFIG_PATH,
      SIFTKIT_CONFIG_SERVICE_URL: process.env.SIFTKIT_CONFIG_SERVICE_URL,
      SIFTKIT_STATUS_BACKEND_URL: process.env.SIFTKIT_STATUS_BACKEND_URL,
    };
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaScripts(tempRoot, llamaPort);
    const config = getDefaultConfig();
    setManagedLlamaBaseUrl(config, managed.baseUrl);
    config.Server = {
      LlamaCpp: {
        StartupScript: managed.startupScriptPath,
        ShutdownScript: managed.shutdownScriptPath,
        StartupTimeoutMs: 5000,
        HealthcheckTimeoutMs: 200,
        HealthcheckIntervalMs: 50,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
    process.env.SIFTKIT_STATUS_PORT = '0';
    process.env.sift_kit_status = statusPath;
    process.env.SIFTKIT_STATUS_PATH = statusPath;
    process.env.SIFTKIT_CONFIG_PATH = configPath;

    const server = startStatusServer();
    try {
      const address = await new Promise((resolve) => {
        if (server.listening) {
          resolve(server.address());
          return;
        }

        server.once('listening', () => resolve(server.address()));
      });
      const port = typeof address === 'object' && address ? address.port : 0;
      if (server.startupPromise) {
        await server.startupPromise;
      }
      process.env.SIFTKIT_CONFIG_SERVICE_URL = `http://127.0.0.1:${port}/config`;
      process.env.SIFTKIT_STATUS_BACKEND_URL = `http://127.0.0.1:${port}/status`;

      const loadedConfig = await loadConfig({ ensure: true });
      assert.equal(loadedConfig.LlamaCpp.BaseUrl, managed.baseUrl);
      await waitForAsyncExpectation(async () => {
        const models = await requestJson(`${managed.baseUrl}/v1/models`);
        assert.equal(models.data[0].id, 'managed-test-model');
      }, 5000);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }

    await waitForAsyncExpectation(
      async () => assert.rejects(() => requestJson(`${managed.baseUrl}/v1/models`)),
      5000
    );
    await waitForAsyncExpectation(async () => {
      assert.equal(fs.existsSync(managed.pidFilePath), false);
    }, 5000);
  });
});

test('real status server falls back to request-start prompt chars and elapsed time when completion payload is minimal', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');

    await withRealStatusServer(async ({ statusUrl }) => {
      await requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: true, rawInputCharacterCount: 300, promptCharacterCount: 420 }),
      });
      await sleep(20);
      await requestJson(statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: false }),
      });

      const status = await requestJson(statusUrl);
      assert.equal(status.metrics.inputCharactersTotal, 420);
      assert.equal(status.metrics.outputCharactersTotal, 0);
      assert.equal(status.metrics.inputTokensTotal, 0);
      assert.equal(status.metrics.outputTokensTotal, 0);
      assert.equal(status.metrics.thinkingTokensTotal, 0);
      assert.equal(status.metrics.completedRequestCount, 1);
      assert.ok(status.metrics.requestDurationMsTotal >= 20);
    }, {
      statusPath,
      configPath,
    });
  });
});

test('real status server restarts the idle countdown when a new request begins before the prior delay expires', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const idleSummaryDbPath = path.join(tempRoot, 'status', 'idle-summary.sqlite');
    const server = await startStatusServerProcess({
      statusPath,
      configPath,
      idleSummaryDbPath,
      idleSummaryDelayMs: 80,
    });

    try {
      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: true, rawInputCharacterCount: 100 }),
      });
      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: false, promptCharacterCount: 100, inputTokens: 10, outputCharacterCount: 40, outputTokens: 5, requestDurationMs: 50 }),
      });

      await sleep(40);
      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: true, rawInputCharacterCount: 50 }),
      });
      await sleep(60);
      assert.equal(server.stdoutLines.some((line) => /idle_metrics/u.test(line)), false);

      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: false, promptCharacterCount: 50, inputTokens: 0, outputCharacterCount: 0, outputTokens: 0, requestDurationMs: 25 }),
      });

      await server.waitForStdoutMatch(/requests=2/u, 1000);
      const block = getIdleSummaryBlock(server.stdoutLines, /requests=2/u);
      assert.equal(block[1], '  input:  chars=150 tokens=10');
      assert.equal(block[2], '  output: chars=40 tokens=5');
      assert.equal(block[3], '  saved:  tokens=5 pct=50.00% ratio=2.00x');
      assert.equal(block[4], '  timing: total=0s avg_request=0.04s avg_tokens_per_s=66.67');
      assert.equal(readIdleSummarySnapshots(idleSummaryDbPath).length, 1);
    } finally {
      await server.close();
    }
  });
});

test('real status server does not count idle delay while an execution lease remains active', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const idleSummaryDbPath = path.join(tempRoot, 'status', 'idle-summary.sqlite');
    const server = await startStatusServerProcess({
      statusPath,
      configPath,
      idleSummaryDbPath,
      idleSummaryDelayMs: 80,
    });

    try {
      const lease = await requestJson(`${server.executionUrl}/acquire`, {
        method: 'POST',
        body: JSON.stringify({ pid: process.pid }),
      });
      assert.equal(lease.acquired, true);

      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: true, rawInputCharacterCount: 10 }),
      });
      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: false, promptCharacterCount: 10, inputTokens: 0, outputCharacterCount: 0, outputTokens: 0, requestDurationMs: 10 }),
      });

      await sleep(120);
      assert.equal(server.stdoutLines.some((line) => /idle_metrics/u.test(line)), false);

      await requestJson(`${server.executionUrl}/release`, {
        method: 'POST',
        body: JSON.stringify({ token: lease.token }),
      });

      await server.waitForStdoutMatch(/requests=1/u, 1000);
      const block = getIdleSummaryBlock(server.stdoutLines, /requests=1/u);
      assert.equal(block[1], '  input:  chars=10 tokens=0');
      assert.equal(block[2], '  output: chars=0 tokens=0');
      assert.equal(block[3], '  saved:  tokens=0 pct=n/a ratio=n/a');
      assert.equal(block[4], '  timing: total=0s avg_request=0.01s avg_tokens_per_s=n/a');
      assert.equal(readIdleSummarySnapshots(idleSummaryDbPath).length, 1);
    } finally {
      await server.close();
    }
  });
});

test('real status server appends one sqlite snapshot for each emitted idle summary', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const idleSummaryDbPath = path.join(tempRoot, 'status', 'idle-summary.sqlite');
    const server = await startStatusServerProcess({
      statusPath,
      configPath,
      idleSummaryDbPath,
      idleSummaryDelayMs: 60,
    });

    try {
      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: true, rawInputCharacterCount: 200 }),
      });
      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: false, promptCharacterCount: 200, inputTokens: 100, outputCharacterCount: 80, outputTokens: 25, requestDurationMs: 800 }),
      });
      await server.waitForStdoutMatch(/requests=1/u, 1000);

      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: true, rawInputCharacterCount: 50 }),
      });
      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: false, promptCharacterCount: 50, inputTokens: 20, outputCharacterCount: 30, outputTokens: 10, thinkingTokens: 7, requestDurationMs: 200 }),
      });
      await server.waitForStdoutMatch(/requests=2/u, 1000);

      const rows = readIdleSummarySnapshots(idleSummaryDbPath);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].completed_request_count, 1);
      assert.equal(rows[1].completed_request_count, 2);
      assert.equal(rows[1].input_characters_total, 250);
      assert.equal(rows[1].input_tokens_total, 120);
      assert.equal(rows[1].output_tokens_total, 35);
      assert.equal(rows[1].thinking_tokens_total, 7);
      assert.equal(rows[1].saved_tokens, 85);
      assert.equal(rows[1].request_duration_ms_total, 1000);
      assert.equal(rows[1].avg_request_ms, 500);
      assert.equal(rows[1].avg_tokens_per_second, 35);
    } finally {
      await server.close();
    }
  });
});

test('real status server keeps emitting idle summaries when sqlite persistence fails', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const idleSummaryDbPath = path.join(tempRoot, 'status');
    const server = await startStatusServerProcess({
      statusPath,
      configPath,
      idleSummaryDbPath,
      idleSummaryDelayMs: 80,
    });

    try {
      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: true, rawInputCharacterCount: 200 }),
      });
      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: false, promptCharacterCount: 200, inputTokens: 100, outputCharacterCount: 80, outputTokens: 25, requestDurationMs: 800 }),
      });

      await server.waitForStdoutMatch(/requests=1/u, 1000);
      assert.equal(server.stderrLines.some((line) => /Failed to persist idle summary snapshot/u.test(line)), true);
    } finally {
      await server.close();
    }
  });
});

test('benchmark runner writes prompt, output, classification metadata, per-case duration, and total duration', async () => {
  await withTempEnv(async (tempRoot) => {
    await withStubServer(async () => {
      const fixtureRoot = path.join(tempRoot, 'bench-fixtures');
      const outputPath = path.join(tempRoot, 'bench-output.json');
      fs.mkdirSync(fixtureRoot, { recursive: true });
      fs.writeFileSync(path.join(fixtureRoot, 'case1.txt'), 'A'.repeat(600), 'utf8');
      fs.writeFileSync(path.join(fixtureRoot, 'case2.txt'), 'short text that should stay raw', 'utf8');
      fs.writeFileSync(path.join(fixtureRoot, 'fixtures.json'), JSON.stringify([
        {
          Name: 'summarized-case',
          File: 'case1.txt',
          Question: 'summarize this',
          Format: 'text',
          PolicyProfile: 'general',
          SourceCommand: 'Get-Content case1.txt | siftkit "summarize this"',
        },
        {
          Name: 'raw-case',
          File: 'case2.txt',
          Question: 'summarize this',
          Format: 'text',
          PolicyProfile: 'general',
        },
      ], null, 2), 'utf8');

      const result = await runBenchmarkSuite({
        fixtureRoot,
        outputPath,
        backend: 'mock',
        model: 'mock-model',
      });
      const artifact = JSON.parse(fs.readFileSync(outputPath, 'utf8'));

      assert.equal(result.OutputPath, outputPath);
      assert.equal(result.PromptPrefix, null);
      assert.equal(fs.existsSync(outputPath), true);
      assert.equal(typeof artifact.TotalDurationMs, 'number');
      assert.ok(artifact.TotalDurationMs >= 0);
      assert.equal(Array.isArray(artifact.Results), true);
      assert.equal(artifact.Results.length, 2);
      assert.equal(typeof artifact.Results[0].DurationMs, 'number');
      assert.ok(artifact.Results[0].DurationMs >= 0);
      assert.equal(artifact.Results[0].Prompt, 'Get-Content case1.txt | siftkit "summarize this"');
      assert.match(artifact.Results[0].Output, /mock summary/u);
      assert.equal(artifact.Results[0].PolicyDecision, 'model-summary');
      assert.equal(artifact.Results[0].Classification, 'summary');
      assert.equal(artifact.Results[0].ModelCallSucceeded, true);
      assert.equal(artifact.Results[0].Error, null);
      assert.equal(artifact.Results[0].Name, undefined);
      assert.equal(artifact.Results[0].SourcePath, undefined);
      assert.match(artifact.Results[1].Prompt, /You are SiftKit/u);
      assert.match(artifact.Results[1].Output, /mock summary/u);
      assert.equal(artifact.Results[1].PolicyDecision, 'model-summary');
      assert.equal(artifact.Results[1].Classification, 'summary');
    });
  });
});

test('benchmark matrix respects per-run launcher overrides and script-owned reasoning', async () => {
  await withTempEnv(async (tempRoot) => {
    const fixtureRoot = path.join(tempRoot, 'bench-fixtures');
    const resultsRoot = path.join(tempRoot, 'bench-results');
    const scriptsRoot = path.join(tempRoot, 'scripts');
    const model9bPath = path.join(scriptsRoot, 'Qwen3.5-9B-Q8_0.gguf');
    const model35bPath = path.join(scriptsRoot, 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf');
    const start9bPath = path.join(scriptsRoot, 'Start-Qwen35-9B-Q8-200k.ps1');
    const start35bPath = path.join(scriptsRoot, 'Start-Qwen35-35B-4bit-150k.ps1');
    const promptPrefixPath = path.join(tempRoot, 'anchor_prompt_prefix.txt');
    const manifestPath = path.join(tempRoot, 'matrix.json');

    fs.mkdirSync(fixtureRoot, { recursive: true });
    fs.mkdirSync(scriptsRoot, { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, 'fixtures.json'), '[]', 'utf8');
    fs.writeFileSync(model9bPath, '', 'utf8');
    fs.writeFileSync(model35bPath, '', 'utf8');
    fs.writeFileSync(start9bPath, '', 'utf8');
    fs.writeFileSync(start35bPath, '', 'utf8');
    fs.writeFileSync(promptPrefixPath, 'Anchor prefix', 'utf8');
    fs.writeFileSync(manifestPath, JSON.stringify({
      fixtureRoot,
      configUrl: 'http://127.0.0.1:4765/config',
      promptPrefixFile: promptPrefixPath,
      startScript: start9bPath,
      resultsRoot,
      baseline: {
        modelId: 'Qwen3.5-9B-Q8_0.gguf',
        modelPath: 'Qwen3.5-9B-Q8_0.gguf',
        contextSize: 200000,
        maxTokens: 15000,
        reasoning: 'off',
        passReasoningArg: false,
      },
      runs: [
        {
          index: 1,
          id: '9b-script-owned',
          label: '9b script-owned',
          enabled: true,
          modelId: 'Qwen3.5-9B-Q8_0.gguf',
          modelPath: 'Qwen3.5-9B-Q8_0.gguf',
          reasoning: 'off',
          sampling: {
            temperature: 0.7,
            topP: 0.8,
            topK: 20,
            minP: 0,
            presencePenalty: 1.5,
            repetitionPenalty: 1,
          },
        },
        {
          index: 2,
          id: '35b-script-owned',
          label: '35b script-owned',
          enabled: true,
          modelId: 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf',
          modelPath: 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf',
          startScript: start35bPath,
          contextSize: 150000,
          maxTokens: 9000,
          reasoning: 'on',
          passReasoningArg: false,
          sampling: {
            temperature: 0.7,
            topP: 0.95,
            topK: 20,
            minP: 0,
            presencePenalty: 1.5,
            repetitionPenalty: 1.06,
          },
        },
      ],
    }, null, 2), 'utf8');

    const manifest = readMatrixManifest({
      manifestPath,
      runIds: [],
      promptPrefixFile: null,
      validateOnly: false,
    });
    const [run9b, run35b] = manifest.selectedRuns;

    assert.equal(manifest.baseline.passReasoningArg, false);
    assert.equal(run9b.contextSize, 200000);
    assert.equal(run9b.maxTokens, 15000);
    assert.equal(run35b.contextSize, 150000);
    assert.equal(run35b.maxTokens, 9000);

    const launcherArgs = buildLauncherArgs(manifest, run35b);
    assert.equal(launcherArgs.includes('-Reasoning'), false);
    assert.deepEqual(launcherArgs.slice(-6), [
      '-ConfigUrl', manifest.configUrl,
      '-ModelPath', run35b.modelPath,
      '-ContextSize', '150000',
      '-MaxTokens', '9000',
    ].slice(-6));

    const benchmarkArgs = buildBenchmarkArgs(manifest, run35b, path.join(tempRoot, 'out.json'), promptPrefixPath);
    assert.equal(benchmarkArgs.includes('--prompt-prefix-file'), true);
    assert.equal(benchmarkArgs.includes('--max-tokens'), true);
    assert.equal(benchmarkArgs[benchmarkArgs.indexOf('--max-tokens') + 1], '9000');
  });
});

test('benchmark matrix launch signature changes for script and context changes but ignores metadata-only reasoning when script-owned', async () => {
  await withTempEnv(async (tempRoot) => {
    const fixtureRoot = path.join(tempRoot, 'bench-fixtures');
    const resultsRoot = path.join(tempRoot, 'bench-results');
    const scriptsRoot = path.join(tempRoot, 'scripts');
    const start9bPath = path.join(scriptsRoot, 'Start-Qwen35-9B-Q8-200k.ps1');
    const start35bPath = path.join(scriptsRoot, 'Start-Qwen35-35B-4bit-150k.ps1');
    const manifestPath = path.join(tempRoot, 'matrix.json');

    fs.mkdirSync(fixtureRoot, { recursive: true });
    fs.mkdirSync(scriptsRoot, { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, 'fixtures.json'), '[]', 'utf8');
    fs.writeFileSync(path.join(scriptsRoot, 'Qwen3.5-9B-Q8_0.gguf'), '', 'utf8');
    fs.writeFileSync(start9bPath, '', 'utf8');
    fs.writeFileSync(start35bPath, '', 'utf8');
    fs.writeFileSync(manifestPath, JSON.stringify({
      fixtureRoot,
      configUrl: 'http://127.0.0.1:4765/config',
      startScript: start9bPath,
      resultsRoot,
      baseline: {
        modelId: 'Qwen3.5-9B-Q8_0.gguf',
        modelPath: 'Qwen3.5-9B-Q8_0.gguf',
        contextSize: 200000,
        maxTokens: 15000,
        reasoning: 'off',
        passReasoningArg: false,
      },
      runs: [
        {
          index: 1,
          id: 'same-script',
          label: 'same-script',
          enabled: true,
          modelId: 'Qwen3.5-9B-Q8_0.gguf',
          modelPath: 'Qwen3.5-9B-Q8_0.gguf',
          reasoning: 'off',
          sampling: {
            temperature: 0.7,
            topP: 0.8,
            topK: 20,
            minP: 0,
            presencePenalty: 1.5,
            repetitionPenalty: 1,
          },
        },
      ],
    }, null, 2), 'utf8');

    const manifest = readMatrixManifest({
      manifestPath,
      runIds: [],
      promptPrefixFile: null,
      validateOnly: false,
    });
    const run = manifest.selectedRuns[0];
    const sameScriptDifferentReasoning = { ...run, reasoning: 'on' };
    const differentScript = { ...run, startScript: start35bPath };
    const differentContext = { ...run, contextSize: 150000 };

    assert.equal(buildLaunchSignature(run), buildLaunchSignature(sameScriptDifferentReasoning));
    assert.notEqual(buildLaunchSignature(run), buildLaunchSignature(differentScript));
    assert.notEqual(buildLaunchSignature(run), buildLaunchSignature(differentContext));
  });
});

test('benchmark matrix passes reasoning by default when the launcher supports it', async () => {
  await withTempEnv(async (tempRoot) => {
    const fixtureRoot = path.join(tempRoot, 'bench-fixtures');
    const resultsRoot = path.join(tempRoot, 'bench-results');
    const scriptsRoot = path.join(tempRoot, 'scripts');
    const startPath = path.join(scriptsRoot, 'Start-Qwen.ps1');
    const manifestPath = path.join(tempRoot, 'matrix.json');

    fs.mkdirSync(fixtureRoot, { recursive: true });
    fs.mkdirSync(scriptsRoot, { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, 'fixtures.json'), '[]', 'utf8');
    fs.writeFileSync(path.join(scriptsRoot, 'model.gguf'), '', 'utf8');
    fs.writeFileSync(startPath, '', 'utf8');
    fs.writeFileSync(manifestPath, JSON.stringify({
      fixtureRoot,
      configUrl: 'http://127.0.0.1:4765/config',
      startScript: startPath,
      resultsRoot,
      baseline: {
        modelId: 'model.gguf',
        modelPath: 'model.gguf',
        contextSize: 200000,
        maxTokens: 15000,
        reasoning: 'off',
      },
      runs: [
        {
          index: 1,
          id: 'thinking',
          label: 'thinking',
          enabled: true,
          modelId: 'model.gguf',
          modelPath: 'model.gguf',
          reasoning: 'on',
          sampling: {
            temperature: 0.7,
            topP: 0.8,
            topK: 20,
            minP: 0,
            presencePenalty: 1.5,
            repetitionPenalty: 1,
          },
        },
      ],
    }, null, 2), 'utf8');

    const manifest = readMatrixManifest({
      manifestPath,
      runIds: [],
      promptPrefixFile: null,
      validateOnly: false,
    });
    const launcherArgs = buildLauncherArgs(manifest, manifest.selectedRuns[0]);

    assert.deepEqual(launcherArgs.slice(-2), ['-Reasoning', 'on']);
  });
});

test('buildPrompt prepends promptPrefix when provided', () => {
  const prompt = buildPrompt({
    question: 'summarize this',
    inputText: 'hello world',
    format: 'text',
    policyProfile: 'general',
    rawReviewRequired: false,
    promptPrefix: 'Always answer in terse benchmark mode.',
  });

  assert.match(prompt, /^Always answer in terse benchmark mode\./u);
  assert.match(prompt, /You are SiftKit/u);
});

test('benchmark runner records a custom prompt prefix from file', async () => {
  await withTempEnv(async (tempRoot) => {
    await withStubServer(async () => {
      const fixtureRoot = path.join(tempRoot, 'bench-fixtures');
      const outputPath = path.join(tempRoot, 'bench-output.json');
      const promptPrefixPath = path.join(tempRoot, 'prompt-prefix.txt');
      fs.mkdirSync(fixtureRoot, { recursive: true });
      fs.writeFileSync(path.join(fixtureRoot, 'case1.txt'), 'A'.repeat(600), 'utf8');
      fs.writeFileSync(path.join(fixtureRoot, 'fixtures.json'), JSON.stringify([
        {
          Name: 'summarized-case',
          File: 'case1.txt',
          Question: 'summarize this',
          Format: 'text',
          PolicyProfile: 'general',
        },
      ], null, 2), 'utf8');
      fs.writeFileSync(promptPrefixPath, 'Always answer in terse benchmark mode.', 'utf8');

      const result = await runBenchmarkSuite({
        fixtureRoot,
        outputPath,
        backend: 'mock',
        model: 'mock-model',
        promptPrefixFile: promptPrefixPath,
      });

      assert.equal(result.PromptPrefix, 'Always answer in terse benchmark mode.');
    });
  });
});

test('benchmark error-log fixtures now reach the model-first summary path', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const fixtureRoot = path.join(process.cwd(), 'eval', 'fixtures', 'ai_core_60_tests', 'raw');
      const cases = [
        {
          file: '17_autorun_error_log.txt',
          question: 'Summarize whether this log contains script errors, crashes, or actionable failures. Quote exact error types, file paths, and line numbers if present.',
          pattern: /run is not clean|script errors/i,
        },
        {
          file: '18_autorun_output_log.txt',
          question: 'Summarize what happened during this run, including startup markers, warnings, and any pass/fail indicators.',
          pattern: /failed autonomous-mode validation|stay threshold/i,
        },
        {
          file: '19_script_error_and_crash_marker_scan.txt',
          question: 'Summarize any crash, popup, assertion, or script-error markers found in these logs, grouped by file.',
          pattern: /run is not clean|script errors/i,
        },
        {
          file: '20_specific_historical_failure_log.txt',
          question: 'Summarize the failure in this log. Identify the exact script error, whether the run still reached its completion marker, and any likely implication for shutdown integrity.',
          pattern: /passed numerically but is still not clean|shutdown integrity/i,
        },
        {
          file: '30_explicit_test_result_markers.txt',
          question: 'Summarize any explicit pass/fail test result markers in these logs. Name the files and whether they show passing or failing suites.',
          pattern: /pass markers alone do not prove|numeric pass markers/i,
        },
        {
          file: '50_main_game_smoke_stderr_log.txt',
          question: 'Summarize the main failure in this stderr log and whether it indicates startup/runtime failure or shutdown-only noise.',
          pattern: /failing during script compilation|parse errors/i,
        },
      ];

      for (const fixture of cases) {
        const inputText = fs.readFileSync(path.join(fixtureRoot, fixture.file), 'utf8');
        const result = await summarizeRequest({
          question: fixture.question,
          inputText,
          format: 'text',
          policyProfile: 'general',
          backend: 'mock',
          model: 'mock-model',
          sourceKind: 'standalone',
        });

        assert.equal(result.ModelCallSucceeded, true, fixture.file);
        assert.equal(result.PolicyDecision, 'model-summary', fixture.file);
        assert.equal(result.Classification, 'summary', fixture.file);
        assert.equal(result.RawReviewRequired, true, fixture.file);
        assert.equal(result.WasSummarized, true, fixture.file);
        assert.match(result.Summary, fixture.pattern, fixture.file);
      }
    });
  });
});

test('pass markers with zero failed still use the model summary path', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const result = await summarizeRequest({
        question: 'Summarize any explicit pass/fail test result markers in these logs.',
        inputText: [
          '.godot_logs\\baseline.log:11:TESTS: 2 passed, 0 failed, 0 skipped',
          '.godot_logs\\baseline.log:12:INTEGRATION TESTS: 224 passed, 0 failed, 0 skipped',
          '.godot_logs\\baseline.log:13:TEST HARNESS: TESTS: 2 passed, 0 failed, 0 skipped',
        ].join('\n'),
        format: 'text',
        policyProfile: 'general',
        backend: 'mock',
        model: 'mock-model',
      });

      assert.equal(result.WasSummarized, true);
      assert.equal(result.Classification, 'summary');
      assert.equal(result.PolicyDecision, 'model-summary');
      assert.match(result.Summary, /pass markers alone do not prove|numeric pass markers/i);
    });
  });
});

test('runCommand classifies missing executables as command failures with raw review required', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const result = await runCommand({
        Command: 'definitely-not-a-real-command-siftkit',
        ArgumentList: [],
        Question: 'Summarize the main result and any actionable failures.',
        Backend: 'mock',
        Model: 'mock-model',
      });

      assert.equal(result.WasSummarized, true);
      assert.equal(result.PolicyDecision, 'model-command-failure');
      assert.equal(result.Classification, 'command_failure');
      assert.equal(result.RawReviewRequired, true);
      assert.equal(result.ModelCallSucceeded, true);
      assert.match(result.Summary, /command failed before producing a usable result/i);
    });
  });
});

test('unsupported input returns the exact terminal message', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const result = await summarizeRequest({
        question: 'Summarize this unsupported input.',
        inputText: 'unsupported fixture marker',
        format: 'text',
        policyProfile: 'general',
        backend: 'mock',
        model: 'mock-model',
      });

      assert.equal(result.WasSummarized, false);
      assert.equal(result.PolicyDecision, 'model-unsupported-input');
      assert.equal(result.Classification, 'unsupported_input');
      assert.equal(result.RawReviewRequired, false);
      assert.equal(result.Summary, UNSUPPORTED_INPUT_MESSAGE);
    });
  });
});

test('provider failures hard fail instead of falling back to a deterministic raw excerpt', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR = 'throw';
      await assert.rejects(
        () => summarizeRequest({
          question: 'Summarize this provider failure.',
          inputText: 'A'.repeat(5000),
          format: 'text',
          policyProfile: 'general',
          backend: 'mock',
          model: 'mock-model',
        }),
        /mock provider failure/u
      );
    });
  });
});

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
const { summarizeRequest } = require('../dist/summary.js');
const { runCommand } = require('../dist/command.js');
const { runBenchmarkSuite } = require('../dist/benchmark.js');
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
      ChunkThresholdRatio: 0.92,
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
    running: Boolean(options.running),
    executionLeaseToken: null,
    metrics: {
      inputCharactersTotal: 0,
      outputCharactersTotal: 0,
      inputTokensTotal: 0,
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

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const bodyText = await readBody(req);
      const parsed = bodyText ? JSON.parse(bodyText) : {};
      const promptText = parsed?.messages?.[0]?.content || '';
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
              content: `summary:${String(promptText).slice(0, 24)}`,
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

  const cleanup = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
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

    return await fn({
      server,
      port,
      statusUrl: `http://127.0.0.1:${port}/status`,
      healthUrl: `http://127.0.0.1:${port}/health`,
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
  const child = spawn(process.execPath, [path.join(process.cwd(), 'siftKitStatus', 'index.js')], {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdoutLines = [];
  const stderrLines = [];
  let stdoutBuffer = '';
  let startupResolved = false;
  let resolveStartup;
  let rejectStartup;
  const startup = new Promise((resolve, reject) => {
    resolveStartup = resolve;
    rejectStartup = reject;
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
    if (!startupResolved) {
      startupResolved = true;
      rejectStartup(new Error(`status server exited before startup (code=${code}, signal=${signal})`));
    }
  });

  const startupInfo = await startup;

  return {
    port: startupInfo.port,
    statusUrl: `http://127.0.0.1:${startupInfo.port}/status`,
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
    async close() {
      if (child.exitCode !== null || child.killed) {
        return;
      }

      child.kill('SIGTERM');
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

test('loadConfig normalizes legacy defaults and derives effective budgets from the external server', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });
      assert.equal(config.LlamaCpp.NumCtx, 128000);
      assert.equal(config.LlamaCpp.Threads, -1);
      assert.equal(config.Effective.BudgetSource, 'FixedCharsPerToken');
      assert.equal(config.Effective.InputCharactersPerContextToken, 2.5);
      assert.equal(config.Effective.MaxInputCharacters, 320000);
      assert.equal(config.Effective.ChunkThresholdCharacters, 294400);
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

test('loadConfig derives effective budgets from aggregate prompt character and token totals', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });
      const expectedRatio = 3461904 / 1865267;

      assert.equal(config.Effective.BudgetSource, 'ObservedCharsPerToken');
      assert.ok(Math.abs(config.Effective.InputCharactersPerContextToken - expectedRatio) < 1e-12);
      assert.equal(config.Effective.MaxInputCharacters, 237565);
      assert.equal(config.Effective.ChunkThresholdCharacters, 218559);
      assert.equal(getChunkThresholdCharacters(config), 218559);
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

      assert.equal(threshold, 218559);
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

test('real status server clears stale true status after the idle watchdog interval', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(statusPath, 'true', 'utf8');

    await withRealStatusServer(async ({ statusPath: liveStatusPath }) => {
      assert.equal(fs.readFileSync(liveStatusPath, 'utf8').trim(), 'true');
      await sleep(10_500);
      assert.equal(fs.readFileSync(liveStatusPath, 'utf8').trim(), 'false');
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
      const result = await summarizeRequest({
        question: 'summarize this',
        inputText: 'A'.repeat(5000),
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.WasSummarized, true);
      assert.ok(server.state.metrics.inputCharactersTotal > 0);
      assert.ok(server.state.metrics.outputCharactersTotal > 0);
      assert.equal(server.state.metrics.inputTokensTotal, 123);
      assert.equal(server.state.metrics.outputTokensTotal, 45);
      assert.equal(server.state.metrics.thinkingTokensTotal, 0);
      assert.equal(server.state.metrics.completedRequestCount, 1);
      assert.ok(server.state.metrics.requestDurationMsTotal >= 0);
    });
  });
});

test('summary aggregation records duration without tokens when provider usage is absent', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const result = await summarizeRequest({
        question: 'summarize this',
        inputText: 'A'.repeat(5000),
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.WasSummarized, true);
      assert.ok(server.state.metrics.inputCharactersTotal > 0);
      assert.ok(server.state.metrics.outputCharactersTotal > 0);
      assert.equal(server.state.metrics.inputTokensTotal, 0);
      assert.equal(server.state.metrics.outputTokensTotal, 0);
      assert.equal(server.state.metrics.thinkingTokensTotal, 0);
      assert.equal(server.state.metrics.completedRequestCount, 1);
      assert.ok(server.state.metrics.requestDurationMsTotal >= 0);
    }, {
      omitUsage: true,
    });
  });
});

test('summary aggregation records thinking tokens independently from output metrics', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const result = await summarizeRequest({
        question: 'summarize this',
        inputText: 'A'.repeat(5000),
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.WasSummarized, true);
      assert.equal(server.state.metrics.inputTokensTotal, 123);
      assert.equal(server.state.metrics.outputTokensTotal, 33);
      assert.equal(server.state.metrics.thinkingTokensTotal, 12);
      assert.equal(server.state.metrics.completedRequestCount, 1);
      assert.ok(server.state.metrics.requestDurationMsTotal >= 0);
    }, {
      reasoningTokens: 12,
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
  assert.match(message, /  timing: total=0s avg_request=800\.00ms avg_tokens_per_s=31\.25/u);
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
    '  timing: total=1d 06h 03m 53s avg_request=387,931.90ms avg_tokens_per_s=0.77',
  ].join('\n'));
});

test('request status log uses suffixed elapsed durations with day support', () => {
  assert.equal(formatElapsed(999), '0s');
  assert.equal(formatElapsed(12_000), '12s');
  assert.equal(formatElapsed(187_000), '3m 07s');
  assert.equal(formatElapsed(7_449_000), '2h 04m 09s');
  assert.equal(formatElapsed(97_200_000), '1d 03h 00m 00s');
  assert.equal(
    buildStatusRequestLogMessage({ running: false, totalElapsedMs: 97_200_000 }),
    'request false total_elapsed=1d 03h 00m 00s',
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

      await sleep(30);
      assert.equal(server.stdoutLines.some((line) => /idle_metrics/u.test(line)), false);

      await server.waitForStdoutMatch(/requests=1/u, 1000);
      const block = getIdleSummaryBlock(server.stdoutLines, /requests=1/u);
      assert.match(block[0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} requests=1$/u);
      assert.equal(block[1], '  input:  chars=200 tokens=100');
      assert.equal(block[2], '  output: chars=80 tokens=25');
      assert.equal(block[3], '  saved:  tokens=75 pct=75.00% ratio=4.00x');
      assert.equal(block[4], '  timing: total=0s avg_request=800.00ms avg_tokens_per_s=31.25');

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
      assert.equal(block[4], '  timing: total=0s avg_request=37.50ms avg_tokens_per_s=66.67');
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
      assert.equal(block[4], '  timing: total=0s avg_request=10.00ms avg_tokens_per_s=n/a');
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

test('benchmark runner writes command prompt, output, per-case duration, and total duration', async () => {
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
      assert.equal(fs.existsSync(outputPath), true);
      assert.equal(typeof artifact.TotalDurationMs, 'number');
      assert.ok(artifact.TotalDurationMs >= 0);
      assert.equal(Array.isArray(artifact.Results), true);
      assert.equal(artifact.Results.length, 2);
      assert.equal(typeof artifact.Results[0].DurationMs, 'number');
      assert.ok(artifact.Results[0].DurationMs >= 0);
      assert.equal(artifact.Results[0].Prompt, 'Get-Content case1.txt | siftkit "summarize this"');
      assert.match(artifact.Results[0].Output, /mock summary/u);
      assert.equal(artifact.Results[0].Name, undefined);
      assert.equal(artifact.Results[0].SourcePath, undefined);
      assert.equal(artifact.Results[1].Prompt, 'summarize this');
      assert.match(artifact.Results[1].Output, /short text that should stay raw/u);
    });
  });
});

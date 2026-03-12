const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  loadConfig,
  saveConfig,
  getChunkThresholdCharacters,
  getStatusServerUnavailableMessage,
} = require('../dist/src/config.js');
const { summarizeRequest } = require('../dist/src/summary.js');
const { runCommand } = require('../dist/src/command.js');
const { getOllamaLoadedModels } = require('../dist/src/providers/ollama.js');

function getDefaultConfig() {
  return {
    Version: '0.1.0',
    Backend: 'ollama',
    Model: 'qwen3.5:9b-q4_K_M',
    PolicyMode: 'conservative',
    RawLogRetention: true,
    Ollama: {
      BaseUrl: 'http://127.0.0.1:11434',
      ExecutablePath: 'mock.exe',
      NumCtx: 128000,
      Temperature: 0.2,
      TopP: 0.95,
      TopK: 20,
      MinP: 0.0,
      PresencePenalty: 0.0,
      RepetitionPenalty: 1.0,
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

async function startStubStatusServer(options = {}) {
  const state = {
    config: mergeConfig(getDefaultConfig(), options.config || {}),
    statusPosts: [],
  };

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'GET' && req.url === '/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state.config));
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, running: Boolean(parsed.running) }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

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
    SIFTKIT_TEST_PROVIDER: process.env.SIFTKIT_TEST_PROVIDER,
    SIFTKIT_TEST_PROVIDER_BEHAVIOR: process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR,
    SIFTKIT_TEST_PROVIDER_LOG_PATH: process.env.SIFTKIT_TEST_PROVIDER_LOG_PATH,
    SIFTKIT_TEST_PROVIDER_SLEEP_MS: process.env.SIFTKIT_TEST_PROVIDER_SLEEP_MS,
    SIFTKIT_CONFIG_SERVICE_URL: process.env.SIFTKIT_CONFIG_SERVICE_URL,
    SIFTKIT_STATUS_BACKEND_URL: process.env.SIFTKIT_STATUS_BACKEND_URL,
    SIFTKIT_STATUS_PORT: process.env.SIFTKIT_STATUS_PORT,
    SIFTKIT_STATUS_HOST: process.env.SIFTKIT_STATUS_HOST,
    SIFTKIT_TEST_OLLAMA_PS_OUTPUT: process.env.SIFTKIT_TEST_OLLAMA_PS_OUTPUT,
  };

  process.env.USERPROFILE = tempRoot;
  delete process.env.sift_kit_status;
  delete process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR;
  delete process.env.SIFTKIT_TEST_PROVIDER_LOG_PATH;
  delete process.env.SIFTKIT_TEST_PROVIDER_SLEEP_MS;
  delete process.env.SIFTKIT_CONFIG_SERVICE_URL;
  delete process.env.SIFTKIT_STATUS_BACKEND_URL;
  delete process.env.SIFTKIT_STATUS_PORT;
  delete process.env.SIFTKIT_STATUS_HOST;
  delete process.env.SIFTKIT_TEST_OLLAMA_PS_OUTPUT;
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

test('loadConfig normalizes legacy defaults and derives effective budgets from the external server', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });
      assert.equal(config.Ollama.NumCtx, 128000);
      assert.equal(config.Effective.MaxInputCharacters, 320000);
      assert.equal(config.Effective.ChunkThresholdCharacters, 294400);
      assert.equal(config.Thresholds.MaxInputCharacters, undefined);
    }, {
      config: {
        Ollama: {
          NumCtx: 16384,
        },
        Thresholds: {
          MaxInputCharacters: 32000,
          ChunkThresholdRatio: 0.75,
        },
      },
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

test('getOllamaLoadedModels parses Windows-style table output', async () => {
  await withTempEnv(async () => {
    process.env.SIFTKIT_TEST_OLLAMA_PS_OUTPUT = [
      'NAME                ID              SIZE      PROCESSOR    CONTEXT    UNTIL',
      'qwen3.5:9b-q4_K_M   abc123          5.5 GB    100% GPU     128000     4 minutes from now',
      'qwen3.5:2b          def456          1.7 GB    100% GPU     32768      2 minutes from now',
    ].join('\n');

    const loadedModels = getOllamaLoadedModels('ignored.exe');
    assert.equal(loadedModels.length, 2);
    assert.equal(loadedModels[0].Name, 'qwen3.5:9b-q4_K_M');
    assert.equal(loadedModels[0].Context, 128000);
    assert.equal(loadedModels[1].Name, 'qwen3.5:2b');
    assert.equal(loadedModels[1].Context, 32768);
  });
});

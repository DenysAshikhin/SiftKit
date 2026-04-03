const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');

function makeCaptureStream() {
  let text = '';
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        text += String(chunk);
        callback();
      },
    }),
    read() {
      return text;
    },
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      text += chunk;
    });
    req.on('end', () => resolve(text));
  });
}

function getDefaultConfig() {
  return {
    Version: '0.1.0',
    Backend: 'llama.cpp',
    Model: 'mock-model',
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
    Runtime: {
      Model: 'mock-model',
      LlamaCpp: {
        BaseUrl: null,
        NumCtx: 128000,
      },
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

function mergeConfig(base, overrides) {
  const merged = JSON.parse(JSON.stringify(base));
  for (const [key, value] of Object.entries(overrides)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && merged[key] && typeof merged[key] === 'object') {
      merged[key] = mergeConfig(merged[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

async function startMiniStubServer(options = {}) {
  const config = mergeConfig(getDefaultConfig(), options.config || {});
  const state = {
    config,
    chatRequests: [],
    statusPosts: [],
    running: false,
    executionLeaseToken: null,
    metrics: {
      inputCharactersTotal: 3461904,
      inputTokensTotal: 1865267,
      outputCharactersTotal: 0,
      outputTokensTotal: 0,
      thinkingTokensTotal: 0,
      requestDurationMsTotal: 0,
      completedRequestCount: 0,
      updatedAtUtc: null,
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
    if (req.method === 'POST' && req.url === '/execution/acquire') {
      const token = `tok-${Date.now()}`;
      state.executionLeaseToken = token;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ acquired: true, token }));
      return;
    }
    if (req.method === 'POST' && req.url === '/execution/heartbeat') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === 'POST' && req.url === '/execution/release') {
      state.executionLeaseToken = null;
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
      const savedBaseUrl = state.config.Runtime?.LlamaCpp?.BaseUrl || state.config.LlamaCpp?.BaseUrl;
      state.config = mergeConfig(getDefaultConfig(), parsed);
      // Preserve the stub server BaseUrl after config normalization round-trips
      if (savedBaseUrl) {
        state.config.Runtime = state.config.Runtime || {};
        state.config.Runtime.LlamaCpp = state.config.Runtime.LlamaCpp || {};
        state.config.Runtime.LlamaCpp.BaseUrl = savedBaseUrl;
        state.config.LlamaCpp = state.config.LlamaCpp || {};
        state.config.LlamaCpp.BaseUrl = savedBaseUrl;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state.config));
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: state.config.Runtime?.Model || state.config.Model || 'mock-model' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/tokenize') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'tokenize unavailable' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const bodyText = await readBody(req);
      const parsed = bodyText ? JSON.parse(bodyText) : {};
      state.chatRequests.push(parsed);
      const assistantContent = typeof options.assistantContent === 'function'
        ? options.assistantContent(parsed)
        : (typeof options.assistantContent === 'string'
          ? options.assistantContent
          : JSON.stringify({
            classification: 'summary',
            raw_review_required: false,
            output: 'mock summary output',
          }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: assistantContent, reasoning_content: '' } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 0 } },
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/status') {
      const bodyText = await readBody(req);
      state.statusPosts.push(bodyText ? JSON.parse(bodyText) : {});
      state.running = state.statusPosts[state.statusPosts.length - 1]?.running ?? false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    server,
    state,
    baseUrl,
    statusUrl: `${baseUrl}/status`,
    configUrl: `${baseUrl}/config`,
    close() {
      return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

function withEnvBackup(envKeys) {
  const backup = {};
  for (const key of envKeys) {
    backup[key] = process.env[key];
  }
  return {
    backup,
    restore() {
      for (const [key, value] of Object.entries(backup)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    },
  };
}

async function withTestEnvAndServer(fn, serverOptions = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-test-'));
  const env = withEnvBackup([
    'sift_kit_status', 'SIFTKIT_STATUS_PATH', 'SIFTKIT_CONFIG_PATH',
    'SIFTKIT_STATUS_HOST', 'SIFTKIT_STATUS_PORT', 'SIFTKIT_STATUS_BACKEND_URL',
    'SIFTKIT_CONFIG_SERVICE_URL', 'USERPROFILE', 'SIFTKIT_TEST_PROVIDER',
    'SIFTKIT_IDLE_SUMMARY_DB_PATH',
  ]);

  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  process.env.USERPROFILE = tempRoot;
  process.env.sift_kit_status = statusPath;
  process.env.SIFTKIT_STATUS_PATH = statusPath;
  process.env.SIFTKIT_CONFIG_PATH = configPath;
  process.env.SIFTKIT_IDLE_SUMMARY_DB_PATH = path.join(tempRoot, '.siftkit', 'status', 'idle-summary.sqlite');
  process.env.SIFTKIT_TEST_PROVIDER = 'mock';

  const stub = await startMiniStubServer(serverOptions);
  process.env.SIFTKIT_STATUS_BACKEND_URL = stub.statusUrl;
  process.env.SIFTKIT_CONFIG_SERVICE_URL = stub.configUrl;

  // Point Runtime.LlamaCpp.BaseUrl at our stub server (must be set before any loadConfig call)
  stub.state.config.Runtime = stub.state.config.Runtime || {};
  stub.state.config.Runtime.LlamaCpp = stub.state.config.Runtime.LlamaCpp || {};
  stub.state.config.Runtime.LlamaCpp.BaseUrl = stub.baseUrl;
  stub.state.config.Runtime.Model = stub.state.config.Runtime.Model || 'mock-model';
  stub.state.config.Runtime.LlamaCpp.NumCtx = stub.state.config.Runtime.LlamaCpp.NumCtx || 128000;
  // Also set in top-level LlamaCpp for compatibility
  stub.state.config.LlamaCpp = stub.state.config.LlamaCpp || {};
  stub.state.config.LlamaCpp.BaseUrl = stub.baseUrl;
  stub.state.config.LlamaCpp.NumCtx = 128000;

  try {
    await fn({ tempRoot, stub });
  } finally {
    await stub.close();
    env.restore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

module.exports = {
  makeCaptureStream,
  readBody,
  getDefaultConfig,
  mergeConfig,
  startMiniStubServer,
  withEnvBackup,
  withTestEnvAndServer,
};

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { closeRuntimeDatabase } from '../dist/state/runtime-db.js';

export type Dict = Record<string, unknown>;

export type CaptureStream = {
  stream: Writable;
  read: () => string;
};

export function makeCaptureStream(): CaptureStream {
  let text = '';
  return {
    stream: new Writable({
      write(chunk: unknown, _encoding: unknown, callback: () => void) {
        text += String(chunk);
        callback();
      },
    }),
    read() {
      return text;
    },
  };
}

export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      text += chunk;
    });
    req.on('end', () => resolve(text));
  });
}

export type TestConfig = Dict & {
  Version: string;
  Backend: string;
  Model: string;
  PolicyMode: string;
  RawLogRetention: boolean;
  LlamaCpp: Dict;
  Runtime: Dict;
  Thresholds: Dict;
  Interactive: Dict;
};

export function getDefaultConfig(): TestConfig {
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

export function mergeConfig<T extends Dict>(base: T, overrides: Dict): T {
  const merged = JSON.parse(JSON.stringify(base)) as T;
  for (const [key, value] of Object.entries(overrides)) {
    const existing = (merged as Dict)[key];
    if (
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && existing
      && typeof existing === 'object'
    ) {
      (merged as Dict)[key] = mergeConfig(existing as Dict, value as Dict);
    } else {
      (merged as Dict)[key] = value;
    }
  }
  return merged;
}

export type StubServerMetrics = {
  inputCharactersTotal: number;
  inputTokensTotal: number;
  outputCharactersTotal: number;
  outputTokensTotal: number;
  thinkingTokensTotal: number;
  requestDurationMsTotal: number;
  completedRequestCount: number;
  updatedAtUtc: string | null;
};

export type StubServerState = {
  config: TestConfig;
  chatRequests: Dict[];
  statusPosts: Dict[];
  running: boolean;
  executionLeaseToken: string | null;
  metrics: StubServerMetrics;
};

export type StubServerOptions = {
  config?: Dict;
  assistantContent?: string | ((parsed: Dict) => string);
};

export type StubServer = {
  server: http.Server;
  state: StubServerState;
  baseUrl: string;
  statusUrl: string;
  configUrl: string;
  close: () => Promise<void>;
};

export async function startMiniStubServer(options: StubServerOptions = {}): Promise<StubServer> {
  const config = mergeConfig(getDefaultConfig(), { Backend: 'mock', ...(options.config || {}) });
  const state: StubServerState = {
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
      const parsed = (bodyText ? JSON.parse(bodyText) : {}) as Dict;
      const runtime = state.config.Runtime as Dict | undefined;
      const runtimeLlamaCpp = runtime ? (runtime.LlamaCpp as Dict | undefined) : undefined;
      const topLlamaCpp = state.config.LlamaCpp as Dict | undefined;
      const savedBaseUrl = (runtimeLlamaCpp && typeof runtimeLlamaCpp.BaseUrl === 'string' ? runtimeLlamaCpp.BaseUrl : undefined)
        || (topLlamaCpp && typeof topLlamaCpp.BaseUrl === 'string' ? topLlamaCpp.BaseUrl : undefined);
      state.config = mergeConfig(getDefaultConfig(), parsed);
      if (savedBaseUrl) {
        state.config.Runtime = (state.config.Runtime as Dict) || {};
        (state.config.Runtime as Dict).LlamaCpp = ((state.config.Runtime as Dict).LlamaCpp as Dict) || {};
        ((state.config.Runtime as Dict).LlamaCpp as Dict).BaseUrl = savedBaseUrl;
        state.config.LlamaCpp = (state.config.LlamaCpp as Dict) || {};
        (state.config.LlamaCpp as Dict).BaseUrl = savedBaseUrl;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state.config));
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      const runtime = state.config.Runtime as Dict | undefined;
      const modelId = (runtime && typeof runtime.Model === 'string' ? runtime.Model : undefined)
        || state.config.Model
        || 'mock-model';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: modelId }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/tokenize') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'tokenize unavailable' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const bodyText = await readBody(req);
      const parsed = (bodyText ? JSON.parse(bodyText) : {}) as Dict;
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
      const parsed = (bodyText ? JSON.parse(bodyText) : {}) as Dict;
      state.statusPosts.push(parsed);
      const lastPost = state.statusPosts[state.statusPosts.length - 1];
      state.running = (lastPost && typeof lastPost.running === 'boolean') ? lastPost.running : false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    server,
    state,
    baseUrl,
    statusUrl: `${baseUrl}/status`,
    configUrl: `${baseUrl}/config`,
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
        server.closeAllConnections();
      });
    },
  };
}

export type EnvBackup = {
  backup: Record<string, string | undefined>;
  restore: () => void;
};

export function withEnvBackup(envKeys: string[]): EnvBackup {
  const backup: Record<string, string | undefined> = {};
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

export type TestEnvContext = {
  tempRoot: string;
  stub: StubServer;
};

export async function withTestEnvAndServer(
  fn: (context: TestEnvContext) => Promise<void> | void,
  serverOptions: StubServerOptions = {},
): Promise<void> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-test-'));
  const previousCwd = process.cwd();
  const env = withEnvBackup([
    'sift_kit_status', 'SIFTKIT_STATUS_PATH', 'SIFTKIT_CONFIG_PATH',
    'SIFTKIT_STATUS_HOST', 'SIFTKIT_STATUS_PORT', 'SIFTKIT_STATUS_BACKEND_URL',
    'SIFTKIT_CONFIG_SERVICE_URL', 'USERPROFILE', 'SIFTKIT_TEST_PROVIDER',
    'SIFTKIT_IDLE_SUMMARY_DB_PATH', 'SIFTKIT_LOCK_TIMEOUT_MS',
  ]);

  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  process.env.USERPROFILE = tempRoot;
  process.env.sift_kit_status = statusPath;
  process.env.SIFTKIT_STATUS_PATH = statusPath;
  process.env.SIFTKIT_CONFIG_PATH = configPath;
  process.env.SIFTKIT_IDLE_SUMMARY_DB_PATH = path.join(tempRoot, '.siftkit', 'status', 'idle-summary.sqlite');
  process.env.SIFTKIT_LOCK_TIMEOUT_MS = '1000';
  process.env.SIFTKIT_TEST_PROVIDER = 'mock';
  fs.writeFileSync(
    path.join(tempRoot, 'package.json'),
    JSON.stringify({ name: 'siftkit', version: '0.1.0' }, null, 2),
    'utf8',
  );
  process.chdir(tempRoot);

  const stub = await startMiniStubServer(serverOptions);
  process.env.SIFTKIT_STATUS_BACKEND_URL = stub.statusUrl;
  process.env.SIFTKIT_CONFIG_SERVICE_URL = stub.configUrl;

  const runtime = (stub.state.config.Runtime as Dict) || {};
  stub.state.config.Runtime = runtime;
  const runtimeLlamaCpp = (runtime.LlamaCpp as Dict) || {};
  runtime.LlamaCpp = runtimeLlamaCpp;
  runtimeLlamaCpp.BaseUrl = stub.baseUrl;
  runtime.Model = runtime.Model || 'mock-model';
  runtimeLlamaCpp.NumCtx = runtimeLlamaCpp.NumCtx || 128000;
  const topLlamaCpp = (stub.state.config.LlamaCpp as Dict) || {};
  stub.state.config.LlamaCpp = topLlamaCpp;
  topLlamaCpp.BaseUrl = stub.baseUrl;
  topLlamaCpp.NumCtx = 128000;
  const server = (stub.state.config.Server as Dict) || {};
  stub.state.config.Server = server;
  const serverLlamaCpp = (server.LlamaCpp as Dict) || {};
  server.LlamaCpp = serverLlamaCpp;
  const stubPort = Number(new URL(stub.baseUrl).port);
  serverLlamaCpp.BaseUrl = stub.baseUrl;
  serverLlamaCpp.Port = stubPort;
  serverLlamaCpp.NumCtx = 128000;
  serverLlamaCpp.ActivePresetId = 'default';
  serverLlamaCpp.Presets = [{
    id: 'default',
    label: 'Default',
    BaseUrl: stub.baseUrl,
    Port: stubPort,
    NumCtx: 128000,
  }];

  try {
    await fn({ tempRoot, stub });
  } finally {
    process.chdir(previousCwd);
    await stub.close();
    closeRuntimeDatabase();
    env.restore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

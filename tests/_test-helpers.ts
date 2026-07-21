import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { z } from '../src/lib/zod.js';
import { getPresetsForSurface, normalizePresets } from '../src/presets.js';
import { closeRuntimeDatabase } from '../src/state/runtime-db.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { isJsonObject, type JsonObject } from '../src/lib/json-types.js';
import type { RepoSearchExecutionResult } from '../src/repo-search/types.js';
import { asObject, getAddressInfo } from './helpers/dashboard-http.js';

export type Dict = JsonObject;

const EMPTY_READ_OVERLAP = {
  byFile: [],
  totalLinesRead: 0,
  totalUniqueLinesRead: 0,
  totalOverlapLines: 0,
  overlapRatePct: 0,
};

// A complete, schema-valid Scorecard for repo-search mocks. The status-server
// api-client now strictly parses /repo-search responses, so mocks must return
// every required field rather than a partial object.
export function buildMockScorecard(finalOutput: string): RepoSearchExecutionResult['scorecard'] {
  return {
    runId: 'mock-run',
    model: 'mock-model',
    tasks: [{
      id: 'repo-search',
      question: 'mock question',
      reason: 'completed',
      turnsUsed: 1,
      safetyRejects: 0,
      invalidResponses: 0,
      commandFailures: 0,
      commands: [],
      turnThinking: {},
      finalOutput,
      passed: true,
      missingSignals: [],
      promptTokens: 0,
      outputTokens: 0,
      toolTokens: 0,
      thinkingTokens: 0,
      outputTokensEstimatedCount: 0,
      thinkingTokensEstimatedCount: 0,
      promptCacheTokens: 0,
      promptEvalTokens: 0,
      promptEvalDurationMs: 0,
      generationDurationMs: 0,
      toolStats: {},
      readOverlapSummary: EMPTY_READ_OVERLAP,
    }],
    totals: { tasks: 1, passed: 1, failed: 0, commandsExecuted: 0, safetyRejects: 0, invalidResponses: 0 },
    toolStats: {},
    readOverlapSummary: EMPTY_READ_OVERLAP,
    verdict: 'pass',
    failureReasons: [],
  };
}

export type CaptureStream = {
  stream: Writable;
  read: () => string;
};

export function makeCaptureStream(): CaptureStream {
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
  PolicyMode: string;
  RawLogRetention: boolean;
  Inference: Dict;
  Runtime: Dict;
  Server: Dict;
  Thresholds: Dict;
  Interactive: Dict;
};

export function getDefaultConfig(): TestConfig {
  return {
    Version: '0.1.0',
    PolicyMode: 'conservative',
    RawLogRetention: true,
    Inference: {
      Thinking: { Enabled: false, Preserve: false },
    },
    Runtime: {
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
    },
    Server: {
      ModelPresets: {
        ActivePresetId: 'default',
        Presets: [{
          id: 'default',
          label: 'Default',
          Backend: 'llama',
          Model: 'mock-model',
          BaseUrl: 'http://127.0.0.1:8080',
          NumCtx: 128000,
        }],
      },
      Engines: {
        Exl3: {
          Managed: true,
          WorkingDirectory: 'C:\\TabbyAPI',
          PythonPath: 'C:\\TabbyAPI\\python.exe',
          Entrypoint: 'main.py',
          ModelRoot: 'D:\\models\\elx3',
          AdminApiKey: '',
          ShutdownTimeoutMs: 30_000,
        },
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
  const merged: Dict = structuredClone(base);
  for (const [key, value] of Object.entries(overrides)) {
    const existing = merged[key];
    merged[key] = isJsonObject(value) && isJsonObject(existing) ? mergeConfig(existing, value) : value;
  }
  return z.custom<T>((value) => typeof value === 'object' && value !== null).parse(merged);
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
  metrics: StubServerMetrics;
};

export type StubServerOptions = {
  config?: Dict;
  assistantContent?: string | ((parsed: Dict) => string);
  tokenizeTokenCount?: number | ((content: string, parsed: Dict) => number | null);
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
    if (req.method === 'GET' && req.url === '/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state.config));
      return;
    }
    if (req.method === 'GET' && req.url === '/preset/list') {
      const presets = getPresetsForSurface(normalizePresets(state.config.Presets), 'cli');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        presets: presets.map((preset) => ({
          id: preset.id,
          presetKind: preset.presetKind,
          operationMode: preset.operationMode,
          deletable: preset.deletable,
          label: preset.label,
        })),
      }));
      return;
    }
    if (req.method === 'PUT' && req.url === '/config') {
      const bodyText = await readBody(req);
      const parsed = asObject(bodyText ? parseJsonValueText(bodyText) : {});
      const runtimeLlamaCpp = asObject(state.config.Runtime.LlamaCpp);
      const savedBaseUrl = typeof runtimeLlamaCpp.BaseUrl === 'string'
        ? runtimeLlamaCpp.BaseUrl : undefined;
      state.config = mergeConfig(getDefaultConfig(), parsed);
      if (savedBaseUrl) {
        asObject(asObject(state.config.Runtime).LlamaCpp).BaseUrl = savedBaseUrl;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state.config));
      return;
    }
    if (req.method === 'POST' && req.url === '/summary') {
      const bodyText = await readBody(req);
      const parsed = asObject(bodyText ? parseJsonValueText(bodyText) : {});
      state.chatRequests.push(parsed);
      const assistantContent = typeof options.assistantContent === 'function'
        ? options.assistantContent(parsed)
        : (typeof options.assistantContent === 'string'
          ? options.assistantContent
          : 'mock summary output');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        RequestId: 'stub-summary-request',
        WasSummarized: true,
        PolicyDecision: 'summary',
        Backend: 'mock',
        Model: 'mock-model',
        Summary: assistantContent,
        Classification: 'summary',
        RawReviewRequired: false,
        ModelCallSucceeded: true,
        ProviderError: null,
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/command-output/analyze') {
      const bodyText = await readBody(req);
      const parsed = asObject(bodyText ? parseJsonValueText(bodyText) : {});
      state.chatRequests.push(parsed);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ExitCode: Number(parsed.exitCode || 0),
        RawLogPath: 'db://command-output/raw',
        ReducedLogPath: null,
        WasSummarized: false,
        PolicyDecision: 'no-summarize',
        Classification: 'no-summarize',
        RawReviewRequired: false,
        ModelCallSucceeded: false,
        ProviderError: null,
        Summary: 'mock command output analysis',
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/repo-search') {
      const bodyText = await readBody(req);
      const parsed = asObject(bodyText ? parseJsonValueText(bodyText) : {});
      state.chatRequests.push(parsed);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        requestId: 'stub-repo-search',
        transcriptPath: 'db://repo-search/transcript',
        artifactPath: 'db://repo-search/artifact',
        scorecard: buildMockScorecard('stub repo-search output'),
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/preset/run') {
      const bodyText = await readBody(req);
      const parsed = asObject(bodyText ? parseJsonValueText(bodyText) : {});
      state.chatRequests.push(parsed);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ outputText: 'mock preset output' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/eval/run') {
      const bodyText = await readBody(req);
      const parsed = asObject(bodyText ? parseJsonValueText(bodyText) : {});
      state.chatRequests.push(parsed);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        Backend: 'mock',
        Model: 'mock-model',
        ResultPath: 'db://eval/result',
        Results: [],
      }));
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      const modelPresets = asObject(asObject(state.config.Server).ModelPresets);
      const presets = Array.isArray(modelPresets.Presets) ? modelPresets.Presets : [];
      const activePreset = asObject(presets.find((entry) => (
        asObject(entry).id === modelPresets.ActivePresetId
      )) ?? presets[0]);
      const modelId = typeof activePreset.Model === 'string' ? activePreset.Model : 'mock-model';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: modelId }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/tokenize') {
      const bodyText = await readBody(req);
      const parsed = asObject(bodyText ? parseJsonValueText(bodyText) : {});
      const content = typeof parsed.content === 'string' ? parsed.content : '';
      if (typeof options.tokenizeTokenCount === 'function') {
        const tokenCount = options.tokenizeTokenCount(content, parsed);
        if (Number.isFinite(tokenCount) && Number(tokenCount) >= 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ count: Math.trunc(Number(tokenCount)) }));
          return;
        }
      } else if (Number.isFinite(options.tokenizeTokenCount) && Number(options.tokenizeTokenCount) >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ count: Math.trunc(Number(options.tokenizeTokenCount)) }));
        return;
      }
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'tokenize unavailable' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const bodyText = await readBody(req);
      const parsed = asObject(bodyText ? parseJsonValueText(bodyText) : {});
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
      const parsed = asObject(bodyText ? parseJsonValueText(bodyText) : {});
      state.statusPosts.push(parsed);
      const lastPost = state.statusPosts[state.statusPosts.length - 1];
      state.running = (lastPost && typeof lastPost.running === 'boolean') ? lastPost.running : false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === 'POST' && req.url === '/status/complete') {
      await readBody(req);
      state.running = false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === 'POST' && req.url === '/status/terminal-metadata') {
      const bodyText = await readBody(req);
      const parsed = asObject(bodyText ? parseJsonValueText(bodyText) : {});
      state.statusPosts.push(parsed);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = getAddressInfo(server);
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

  const runtime = asObject(stub.state.config.Runtime);
  stub.state.config.Runtime = runtime;
  const runtimeLlamaCpp = asObject(runtime.LlamaCpp);
  runtime.LlamaCpp = runtimeLlamaCpp;
  runtimeLlamaCpp.BaseUrl = stub.baseUrl;
  runtimeLlamaCpp.NumCtx = runtimeLlamaCpp.NumCtx || 128000;
  const server = asObject(stub.state.config.Server);
  stub.state.config.Server = server;
  const modelPresets = asObject(server.ModelPresets);
  server.ModelPresets = modelPresets;
  const stubPort = Number(new URL(stub.baseUrl).port);
  modelPresets.ActivePresetId = 'default';
  modelPresets.Presets = [{
    id: 'default',
    label: 'Default',
    Backend: 'llama',
    Model: 'mock-model',
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

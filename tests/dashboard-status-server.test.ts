import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';

import { z } from '../src/lib/zod.js';
import {
  ChatStreamTextDeltaSchema,
  type ChatStreamTextDelta,
} from '@siftkit/contracts';
import { parseJsonValueText } from '../src/lib/json.js';
import type { OptionalJsonValue } from '../src/lib/json-types.js';
import { startStatusServer } from '../src/status-server/index.js';
import { writeConfig, getDefaultConfig } from '../src/status-server/config-store.js';
import { getConfigPath, SIFT_DEFAULT_LLAMA_BASE_URL } from '../src/config/index.js';
import { readChatSessions, saveChatSession } from '../src/state/chat-sessions.js';
import { writeRuntimeLaunchSnapshot } from '../src/status-server/runtime-launch-snapshot.js';
import {
  LIVE_TEXT_FLUSH_MAX_LATENCY_MS,
  LIVE_TEXT_FLUSH_MAX_PENDING_CHARS,
} from '../src/status-server/live-text-delta.js';
import {
  asArray,
  asObject,
  asObjectArray,
  fireAndAbortJsonRequest,
  getAddressInfo,
  requestJson,
  requestSse,
  type Dict,
  type SseEvent,
  type SseResponse,
} from './helpers/dashboard-http.js';
import { createManagedTempDir, removeDirectoryWithRetries } from './helpers/temp-dirs.js';
import { buildWebSearchConfig, mockModelPreset, usableWebSearchConfig } from './helpers/mock-config.js';
import { DashboardModelQueueHarness } from './helpers/dashboard-model-queue-harness.js';
import { DashboardRunSeeder } from './helpers/dashboard-run-seed.js';
import {
  configureDashboardTestEnv,
  enterDashboardTestRepo,
  restoreDashboardTestRepo,
} from './helpers/dashboard-test-repo.js';
import { buildRepoSearchChatSteps } from '../dashboard/src/lib/chat-steps.js';
import type { RunEvent } from '../dashboard/src/types.js';
import { rasterBuffer, toDataUrl } from './helpers/image-fixtures.js';
import { readImageDimensions } from '../src/llm-protocol/image-admission.js';

const PNG = toDataUrl('image/png', rasterBuffer('png', 1, 1));

function toRunEvents(value: OptionalJsonValue): RunEvent[] {
  return asObjectArray(value).map((event) => ({
    kind: String(event.kind ?? ''),
    at: typeof event.at === 'string' ? event.at : null,
    payload: event.payload ?? null,
  }));
}

function parseTextDeltaEvent(event: SseEvent): ChatStreamTextDelta {
  assert.deepEqual(Object.keys(event.payload ?? {}).sort(), ['offset', 'text', 'turn']);
  const result = ChatStreamTextDeltaSchema.safeParse(event.payload);
  if (!result.success) {
    throw new Error(`Invalid ${event.event} delta: ${JSON.stringify(result.error.issues)}`);
  }
  assert.equal(result.data.text.length <= LIVE_TEXT_FLUSH_MAX_PENDING_CHARS, true);
  return result.data;
}

function assembleTextDeltas(deltas: readonly ChatStreamTextDelta[]): string {
  let text = '';
  for (const delta of deltas) {
    if (delta.offset === 0) {
      text = delta.text;
      continue;
    }
    assert.equal(delta.offset, text.length);
    text += delta.text;
  }
  return text;
}

// F14 (test-pyramid rebalance): the pure normalizeWebSearchConfig decisions previously
// co-located here were relocated to the config-normalization seam. Every remaining case is
// intentionally retained as E2E integration coverage: each drives a live status server over
// real HTTP and exercises route↔store↔queue↔chat wiring (endpoint payload contracts, model
// request queue serialization/FIFO/drop-on-disconnect, chat persistence + tool-evidence replay,
// repo-search auto-append previews, llama-cpp reachability probing, start-script packaging) that
// the coverage-attribution harness proved is not redundant with any sibling case (residual > 0
// for all 25 — `candidates (residual <= 0): 0`). The unit-level decisions underneath are covered
// directly in the config-store, model-request-queue, status-server-chat, route-request-normalizers,
// chat-route-file-listing, and web-search-quota seams; deleting any case here would drop unique
// integration branches, so they stay.
test('GET /dashboard/web-search-quota returns a quotas array', async () => {
  const tempRoot = createManagedTempDir('siftkit-dashboard-quota-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const config = getDefaultConfig();
  config.WebSearch = buildWebSearchConfig();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  writeConfig(getConfigPath(), config);
  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const response = await requestJson(`${baseUrl}/dashboard/web-search-quota`);
    assert.equal(response.statusCode, 200);
    const body = asObject(response.body);
    assert.ok(Array.isArray(body.quotas));
    assert.deepEqual(body.quotas, []);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    restoreDashboardTestRepo(previousCwd);
    await removeDirectoryWithRetries(tempRoot);
  }
});

const requireFromHere = createRequire(path.join(process.cwd(), '.test-build', 'tests', 'dashboard-status-server.test.js'));
const SIFTKIT_REPO_ROOT = process.cwd();
type RuntimeHelpers = {
  writeManagedLlamaLauncher: (tempRoot: string, port: number, modelId?: string) => {
    baseUrl: string;
    executablePath: string;
    modelPath: string;
    readyFilePath: string;
  };
  acquireChildPortLease: (name: string) => Promise<{
    port: number;
    [Symbol.asyncDispose](): Promise<void>;
  }>;
  getDefaultConfig: () => Dict;
  setManagedLlamaBaseUrl: (config: Dict, baseUrl: string) => void;
  waitForAsyncExpectation: (expectation: () => Promise<void>, timeoutMs?: number) => Promise<void>;
  startStatusServerProcess: (options: {
    statusPath: string;
    configPath: string;
    idleSummaryDbPath?: string;
    idleSummaryDelayMs?: number;
    disableManagedLlamaStartup?: boolean;
  }) => Promise<{
    statusUrl: string;
    close: () => Promise<void>;
  }>;
};
const runtimeHelpers =z.custom<RuntimeHelpers>((value) => typeof value === 'object' && value !== null).parse(requireFromHere('./_runtime-helpers.js'));

type HostConfigServer = {
  baseUrl: string;
  requestUrls: string[];
  close: () => Promise<void>;
};

function d(value: OptionalJsonValue): Dict {
  return asObject(value);
}

const DASHBOARD_CHAT_STREAM_TIMEOUT_MS = 20_000;

async function startHostConfigServer(hostConfigBody: Dict): Promise<HostConfigServer> {
  const requestUrls: string[] = [];
  const server = http.createServer((request, response) => {
    requestUrls.push(request.url || '');
    if ((request.url || '').startsWith('/config')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(hostConfigBody));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = getAddressInfo(server);
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requestUrls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('config llama cpp test endpoint reports reachable external server', async () => {
  const tempRoot = createManagedTempDir('siftkit-llama-test-route-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const runtimeRoot = path.join(tempRoot, '.siftkit');
  const statusPath = path.join(runtimeRoot, 'status', 'inference.txt');
  const configPath = path.join(runtimeRoot, 'config.json');
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(statusPath, 'false', 'utf8');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  await using remotePortLease = await runtimeHelpers.acquireChildPortLease('dashboard-status-server-remote');
  const remotePort = remotePortLease.port;
  const remoteServer = http.createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'remote-model' }] }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    remoteServer.listen(remotePort, '127.0.0.1', (error?: Error) => (error ? reject(error) : resolve()));
  });
  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await requestJson(`${baseUrl}/config/llama-cpp/test`, {
      method: 'POST',
      body: JSON.stringify({ BaseUrl: `http://127.0.0.1:${remotePort}`, HealthcheckTimeoutMs: 1000 }),
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.statusCode, 200);
    assert.equal(response.body.baseUrl, `http://127.0.0.1:${remotePort}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      remoteServer.close((error) => (error ? reject(error) : resolve()));
    });
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    restoreDashboardTestRepo(previousCwd);
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('config llama cpp test endpoint reports unreachable external server', async () => {
  const tempRoot = createManagedTempDir('siftkit-llama-test-route-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const runtimeRoot = path.join(tempRoot, '.siftkit');
  const statusPath = path.join(runtimeRoot, 'status', 'inference.txt');
  const configPath = path.join(runtimeRoot, 'config.json');
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(statusPath, 'false', 'utf8');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  await using unusedPortLease = await runtimeHelpers.acquireChildPortLease('dashboard-status-server-unreachable');
  const unusedPort = unusedPortLease.port;
  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await requestJson(`${baseUrl}/config/llama-cpp/test`, {
      method: 'POST',
      body: JSON.stringify({ BaseUrl: `http://127.0.0.1:${unusedPort}`, HealthcheckTimeoutMs: 100 }),
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.statusCode, 0);
    assert.match(String(response.body.error), /connect|ECONNREFUSED|timed out/i);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    restoreDashboardTestRepo(previousCwd);
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('chat session creation uses pass-through host context window', async () => {
  const tempRoot = createManagedTempDir('siftkit-chat-host-context-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const runtimeRoot = path.join(tempRoot, '.siftkit');
  const statusPath = path.join(runtimeRoot, 'status', 'inference.txt');
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(statusPath, 'false', 'utf8');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const hostConfig = getDefaultConfig();
  const hostPreset = hostConfig.Server.ModelPresets.Presets[0];
  if (!hostPreset) {
    throw new Error('Default model preset is missing.');
  }
  hostConfig.Runtime.LlamaCpp.NumCtx = 75_008;
  hostConfig.Runtime.LlamaCpp.Reasoning = 'off';
  hostPreset.NumCtx = 75_008;
  hostPreset.Reasoning = 'off';
  hostPreset.Model = 'host-loaded-model.gguf';
  hostPreset.Backend = 'llama';
  const host = await startHostConfigServer(hostConfig);
  const config = getDefaultConfig();
  const serverConfig = d(config.Server);
  const llamaServerConfig = d(serverConfig.ModelPresets);
  const presets = asObjectArray(llamaServerConfig.Presets);
  const activePreset = d(presets[0]);
  activePreset.ExternalServerEnabled = true;
  activePreset.BaseUrl = host.baseUrl;
  activePreset.NumCtx = 150_000;
  activePreset.Model = 'local-stale-model.gguf';
  activePreset.Reasoning = 'on';
  writeConfig(configPath, config);

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const createSession = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Pass-through session' }),
    });

    assert.equal(createSession.statusCode, 200);
    const session = d(createSession.body.session);
    const contextUsage = d(createSession.body.contextUsage);
    assert.equal(session.model, 'host-loaded-model.gguf');
    assert.equal(session.contextWindowTokens, 75_008);
    assert.equal(session.thinkingEnabled, false);
    assert.equal(contextUsage.contextWindowTokens, 75_008);
    assert.equal(contextUsage.warnThresholdTokens, 7_501);
    assert.equal(host.requestUrls.some((url) => url.includes('skip_ready=1')), true);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await host.close();
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    restoreDashboardTestRepo(previousCwd);
    await removeDirectoryWithRetries(tempRoot);
  }
});

class ChatInferenceMetadataFixture {
  private readonly tempRoot = createManagedTempDir('siftkit-chat-exl3-context-');
  private readonly previousCwd = enterDashboardTestRepo(this.tempRoot);
  private readonly runtimeRoot = path.join(this.tempRoot, '.siftkit');
  private readonly statusPath = path.join(this.runtimeRoot, 'status', 'inference.txt');
  private readonly configPath = getConfigPath();
  private readonly envBackup: ReturnType<typeof configureDashboardTestEnv>;
  private server: ReturnType<typeof startStatusServer> | null = null;
  private baseUrl = '';
  readonly activePresetId: string;

  constructor() {
    fs.mkdirSync(path.dirname(this.statusPath), { recursive: true });
    fs.writeFileSync(this.statusPath, 'false', 'utf8');
    this.envBackup = configureDashboardTestEnv(this.tempRoot, this.statusPath, this.configPath);
    const config = getDefaultConfig();
    const activePreset = d(asObjectArray(d(d(config.Server).ModelPresets).Presets)[0]);
    activePreset.Backend = 'exl3';
    activePreset.Model = 'active-model';
    activePreset.NumCtx = 150_000;
    activePreset.Reasoning = 'off';
    this.activePresetId = String(activePreset.id);
    const runtimeLlama = d(d(config.Runtime).LlamaCpp);
    runtimeLlama.NumCtx = 30_000;
    runtimeLlama.Reasoning = 'on';
    writeConfig(this.configPath, config);
  }

  seedActiveSession(): void {
    saveChatSession(this.runtimeRoot, {
      id: 'stale-active', title: 'Stale active session', modelPresetId: this.activePresetId,
      modelPreset: mockModelPreset({ id: this.activePresetId, Model: 'stale-model', NumCtx: 30_000 }), thinkingEnabled: true,
      presetId: 'chat', mode: 'chat',
      createdAtUtc: '2026-07-21T00:00:00.000Z',
      updatedAtUtc: '2026-07-21T00:00:00.000Z', messages: [],
    });
  }

  seedHistoricalSession(): void {
    saveChatSession(this.runtimeRoot, {
      id: 'historical', title: 'Historical session', modelPresetId: 'historical-preset',
      modelPreset: mockModelPreset({ id: 'historical-preset', Model: 'historical-model', NumCtx: 30_000 }), thinkingEnabled: true,
      presetId: 'chat', mode: 'chat',
      createdAtUtc: '2026-07-20T00:00:00.000Z',
      updatedAtUtc: '2026-07-20T00:00:00.000Z', messages: [],
    });
  }

  async start(): Promise<void> {
    this.server = startStatusServer({ disableManagedLlamaStartup: true });
    await this.server.startupPromise;
    const address = getAddressInfo(this.server);
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  request(pathname: string, options?: Parameters<typeof requestJson>[1]): ReturnType<typeof requestJson> {
    return requestJson(`${this.baseUrl}${pathname}`, options);
  }

  persistedActiveContextWindow(): number | undefined {
    return readChatSessions(this.runtimeRoot).find((session) => session.id === 'stale-active')?.modelPreset.NumCtx;
  }

  async close(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server?.close((error) => (error ? reject(error) : resolve()));
      });
    }
    for (const [key, value] of Object.entries(this.envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    restoreDashboardTestRepo(this.previousCwd);
    await removeDirectoryWithRetries(this.tempRoot);
  }
}

test('EXL3 chat creation uses server-owned inference metadata', async () => {
  const fixture = new ChatInferenceMetadataFixture();
  try {
    await fixture.start();
    const response = await fixture.request('/dashboard/chat/sessions', {
      method: 'POST', body: JSON.stringify({ title: 'EXL3 session', model: 'client-override' }),
    });
    assert.equal(response.statusCode, 200);
    const session = d(response.body.session);
    assert.equal(session.model, 'active-model');
    assert.equal(session.contextWindowTokens, 150_000);
    assert.equal(session.thinkingEnabled, false);
    assert.equal(d(response.body.contextUsage).contextWindowTokens, 150_000);
  } finally {
    await fixture.close();
  }
});

test('active model preset sessions expose current model and context', async () => {
  const fixture = new ChatInferenceMetadataFixture();
  try {
    fixture.seedActiveSession();
    await fixture.start();
    const response = await fixture.request('/dashboard/chat/sessions/stale-active');
    const session = d(response.body.session);
    assert.equal(session.model, 'active-model');
    assert.equal(session.contextWindowTokens, 150_000);
    assert.equal(d(response.body.contextUsage).contextWindowTokens, 150_000);
  } finally {
    await fixture.close();
  }
});

test('inactive model preset sessions preserve inference snapshots', async () => {
  const fixture = new ChatInferenceMetadataFixture();
  try {
    fixture.seedHistoricalSession();
    await fixture.start();
    const response = await fixture.request('/dashboard/chat/sessions/historical');
    const session = d(response.body.session);
    assert.equal(session.model, 'historical-model');
    assert.equal(session.contextWindowTokens, 30_000);
    assert.equal(d(response.body.contextUsage).contextWindowTokens, 30_000);
  } finally {
    await fixture.close();
  }
});

test('reading an active model preset session does not rewrite snapshots', async () => {
  const fixture = new ChatInferenceMetadataFixture();
  try {
    fixture.seedActiveSession();
    await fixture.start();
    const response = await fixture.request('/dashboard/chat/sessions/stale-active');
    assert.equal(response.statusCode, 200);
    assert.equal(fixture.persistedActiveContextWindow(), 30_000);
  } finally {
    await fixture.close();
  }
});

test('dashboard endpoints expose runs, details, metrics, and chat sessions', async () => {
  const tempRoot = createManagedTempDir('siftkit-dashboard-status-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const runtimeRoot = path.join(tempRoot, '.siftkit');
  const statusPath = path.join(runtimeRoot, 'status', 'inference.txt');
  const configPath = path.join(runtimeRoot, 'config.json');
  const runtimeDbPath = path.join(runtimeRoot, 'runtime.sqlite');

  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const seeder = new DashboardRunSeeder(runtimeDbPath);
    try {
      // Same order the runner defers them in: planner_debug then summary_request.
      seeder.artifact('planner_debug', 'req-summary', {
        final: {
          finalOutput: 'Build was successful.',
          classification: 'summary',
          rawReviewRequired: false,
          providerError: null,
        },
      });
      seeder.summaryRun({
        requestId: 'req-summary',
        question: 'Summarize build output',
        createdAtUtc: '2026-04-01T10:00:00.000Z',
        payload: {
          summary: 'Build was successful.',
          inputTokens: 123,
          outputTokens: 45,
          thinkingTokens: 9,
          promptCacheTokens: 80,
          promptEvalTokens: 40,
          speculativeAcceptedTokens: 18,
          speculativeGeneratedTokens: 24,
          requestDurationMs: 3000,
        },
      });
      seeder.artifact('planner_failed', 'req-failed', {
        requestId: 'req-failed',
        question: 'Analyze flaky test failure',
        error: 'timeout',
        createdAtUtc: '2026-04-01T10:05:00.000Z',
        inputTokens: 50,
        outputTokens: 0,
        thinkingTokens: 0,
        promptCacheTokens: 0,
        promptEvalTokens: 20,
        requestDurationMs: 1000,
      });
      seeder.artifact('request_abandoned', 'req-abandoned', {
        requestId: 'req-abandoned',
        terminalState: 'failed',
        reason: 'Abandoned because a new request started before terminal status.',
        createdAtUtc: '2026-04-01T10:10:00.000Z',
        promptCharacterCount: 1200,
        outputTokensTotal: 12,
      });
      seeder.repoSearchRun({
        requestId: 'req-repo',
        prompt: 'find failing test',
        repoRoot: tempRoot,
        createdAtUtc: '2026-04-01T10:15:00.000Z',
        transcriptText: [
          JSON.stringify({ at: '2026-04-01T10:15:01.000Z', kind: 'turn_new_messages', turn: 1, messages: [{ role: 'user', content: 'find failing test' }], promptTokenCount: 10 }),
          JSON.stringify({ at: '2026-04-01T10:15:02.000Z', kind: 'turn_model_response', text: '{"action":"finish"}', thinkingText: 'reasoning' }),
          JSON.stringify({ at: '2026-04-01T10:15:03.000Z', kind: 'run_done', scorecard: { verdict: 'fail' } }),
        ].join('\n') + '\n',
        requestDurationMs: 2000,
      });
    } finally {
      seeder.close();
    }

    const health = await requestJson(`${baseUrl}/status`);
    assert.equal(health.statusCode, 200);

    const runsResponse = await requestJson(`${baseUrl}/dashboard/runs`);
    assert.equal(runsResponse.statusCode, 200);
    const runs = asObjectArray(runsResponse.body.runs);
    assert.equal(Array.isArray(runs), true);
    assert.ok(runs.length >= 4);
    const runKinds = new Set(runs.map((run) => String(run.kind)));
    assert.equal(runKinds.has('summary_request'), true);
    assert.equal(runKinds.has('failed_request'), true);
    assert.equal(runKinds.has('request_abandoned'), true);
    assert.equal(runKinds.has('repo_search'), true);
    const repoRun = runs.find((run) => run.id === 'req-repo');
    assert.equal(Number(repoRun?.durationMs), 2000);

    const detailResponse = await requestJson(`${baseUrl}/dashboard/runs/req-repo`);
    assert.equal(detailResponse.statusCode, 200);
    assert.equal(asObject(detailResponse.body.run).id, 'req-repo');
    const events = asObjectArray(detailResponse.body.events);
    assert.equal(Array.isArray(events), true);
    assert.equal(events.some((event) => event.kind === 'turn_model_response'), true);

    const metricsResponse = await requestJson(`${baseUrl}/dashboard/metrics/timeseries`);
    assert.equal(metricsResponse.statusCode, 200);
    const days = asObjectArray(metricsResponse.body.days);
    const taskDays = asObjectArray(metricsResponse.body.taskDays);
    const toolStats = asObject(metricsResponse.body.toolStats);
    assert.equal(Array.isArray(days), true);
    assert.equal(Array.isArray(taskDays), true);
    assert.equal(Boolean(toolStats && typeof toolStats === 'object'), true);
    assert.equal(days.length > 0, true);
    assert.equal(Number(days[0].runs) >= 1, true);
    assert.equal(Number.isFinite(Number(days[0].promptCacheTokens)), true);
    assert.equal(Number.isFinite(Number(days[0].promptEvalTokens)), true);
    assert.equal(Number.isFinite(Number(days[0].cacheHitRate)), true);
    assert.equal(Number.isFinite(Number(days[0].speculativeAcceptedTokens)), true);
    assert.equal(Number.isFinite(Number(days[0].speculativeGeneratedTokens)), true);
    assert.equal(Number.isFinite(Number(days[0].acceptanceRate)), true);
    assert.equal(days[0].promptCacheTokens, 80);
    assert.equal(days[0].promptEvalTokens, 60);
    assert.equal(Math.round(Number(days[0].cacheHitRate) * 1000) / 1000, 0.571);
    assert.equal(days[0].speculativeAcceptedTokens, 0);
    assert.equal(days[0].speculativeGeneratedTokens, 0);
    assert.equal(Math.round(Number(days[0].acceptanceRate) * 1000) / 1000, 0);

    const idleSummaryResponse = await requestJson(`${baseUrl}/dashboard/metrics/idle-summary`);
    assert.equal(idleSummaryResponse.statusCode, 200);
    assert.equal(Array.isArray(idleSummaryResponse.body.snapshots), true);
    assert.equal(Object.prototype.hasOwnProperty.call(idleSummaryResponse.body, 'latest'), true);
    const latest = idleSummaryResponse.body.latest;
    const idleSummarySample: Dict = (latest !== null && typeof latest === 'object' && !Array.isArray(latest))
      ? latest
      : asObjectArray(idleSummaryResponse.body.snapshots)[0] || {};
    if (Object.keys(idleSummarySample).length > 0) {
      assert.equal(Object.prototype.hasOwnProperty.call(idleSummarySample, 'inputOutputRatio'), true);
    }

    const createSession = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Session A',
        model: 'Qwen3.5-9B-Q8_0.gguf',
        contextWindowTokens: 10000,
      }),
    });
    assert.equal(createSession.statusCode, 200);
    const session = d(createSession.body.session);
    assert.equal(typeof session.id, 'string');
    assert.equal(session.contextWindowTokens, 128000);
    assert.equal(session.mode, 'chat');
    assert.equal(session.planRepoRoot, process.cwd());
    const sessionId = String(session.id);

    const appendMessage = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content: 'a'.repeat(26000),
        assistantContent: 'stored assistant response',
      }),
    });
    assert.equal(appendMessage.statusCode, 200);
    const appendSession = d(appendMessage.body.session);
    assert.equal(Array.isArray(appendSession.messages), true);
    assert.equal(asObjectArray(appendSession.messages).length, 2);
    const contextUsage = d(appendMessage.body.contextUsage);
    assert.equal(contextUsage.warnThresholdTokens, 12800);
    assert.equal(contextUsage.shouldCondense, false);

    const updateSession = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}`, {
      method: 'PUT',
      body: JSON.stringify({
        presetId: 'plan',
        planRepoRoot: tempRoot,
      }),
    });
    assert.equal(updateSession.statusCode, 200);
    const updatedSession = d(updateSession.body.session);
    assert.equal(updatedSession.mode, 'plan');
    assert.equal(updatedSession.planRepoRoot, tempRoot);

    const planMessage = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/plan`, {
      method: 'POST',
      timeoutMs: 3000,
      body: JSON.stringify({
        content: 'Add a mode toggle to the dashboard chat panel.',
        repoRoot: tempRoot,
        maxTurns: 2,
        availableModels: ['Qwen3.5-35B-A3B-UD-Q4_K_L.gguf'],
        mockResponses: [
          { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"dashboard","path":"."} }] },
          { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"/dashboard/chat/sessions","path":"siftKitStatus/index.js"} }] },
          { content: "Plan: update dashboard/src/App.tsx and siftKitStatus/index.js; include a risks section for endpoint lock contention and stale repo-root paths." },
        ],
        mockCommandResults: {
          "git operation=\"grep\" path=\".\" pattern=\"dashboard\"": { exitCode: 0, stdout: 'dashboard/src/App.tsx:1:import { useEffect }', stderr: '' },
          "git operation=\"grep\" path=\"siftKitStatus/index.js\" pattern=\"/dashboard/chat/sessions\"": { exitCode: 0, stdout: 'siftKitStatus/index.js:3068:    if (req.method === \'POST\' && pathname === \'/dashboard/chat/sessions\') {', stderr: '' },
        },
      }),
    });
    assert.equal(planMessage.statusCode, 200);
    const planSession = d(planMessage.body.session);
    assert.equal(planSession.presetId, 'plan');
    assert.equal(planSession.mode, 'plan');
    const planMessages = asObjectArray(planSession.messages);
    assert.equal(planMessages.length >= 4, true);
    assert.equal(planMessages.some((message) =>
      message.kind === 'assistant_tool_call'
      && String(message.toolCallOutput || '').includes('/dashboard/chat/sessions')
    ), true);
    const planUsage = d(planMessage.body.contextUsage);
    const latestMessage = planMessages[planMessages.length - 1];
    assert.equal(latestMessage.role, 'assistant');
    assert.equal(Number(latestMessage.associatedToolTokens || 0) > 0, true);
    assert.equal(Number(planUsage.toolUsedTokens), Number(latestMessage.associatedToolTokens || 0));
    assert.equal(Number(planUsage.totalUsedTokens), Number(planUsage.chatUsedTokens) + Number(planUsage.toolUsedTokens));
    const repoSearch = d(planMessage.body.repoSearch);
    const repoScorecard = d(repoSearch.scorecard);
    const repoTotals = d(repoScorecard.totals);
    // Assistant messages carry no input component (inputTokensEstimate is 0 by
    // design), while run prompt totals are counted locally from the preflight
    // prompt, so they are nonzero even on mock-driven runs.
    assert.equal(Number(latestMessage.inputTokensEstimate || 0), 0);
    assert.equal(Number(repoTotals.promptTokens || 0) > 0, true);
    assert.equal(latestMessage.sourceRunId, String(repoSearch.requestId));
    assert.equal(Number(latestMessage.outputTokensEstimate || 0), Number(repoTotals.outputTokens || 0));
    assert.equal(Number(latestMessage.thinkingTokens || 0), Number(repoTotals.thinkingTokens || 0));
    const latestContent = String(latestMessage.content);
    assert.match(latestContent, /^# Implementation Plan/mu);
    assert.match(latestContent, /Critical Review/mu);
    assert.match(latestContent, /## Artifacts/mu);
    const plannerCommands = Array.from(
      latestContent.matchAll(/^- Command: `([^`]+)`$/gmu),
      (match) => match[1],
    );
    const newestCommandIndex = plannerCommands.findIndex((command) => command.includes('/dashboard/chat/sessions'));
    const oldestCommandIndex = plannerCommands.findIndex((command) => command.includes('dashboard'));
    assert.equal(newestCommandIndex >= 0, true);
    assert.equal(oldestCommandIndex >= 0, true);
    assert.equal(fs.existsSync(String(repoSearch.artifactPath)), false);
    const repoRunDetailResponse = await requestJson(`${baseUrl}/dashboard/runs/${String(repoSearch.requestId)}`);
    assert.equal(repoRunDetailResponse.statusCode, 200);
    const repoRunEvents = asObjectArray(repoRunDetailResponse.body.events);
    const repoSearchEvent = repoRunEvents.find((event) => event.kind === 'repo_search') || null;
    assert.equal(Boolean(repoSearchEvent), true);
    const plannerArtifact = d(repoSearchEvent?.payload);
    assert.equal(plannerArtifact.requestMaxTokens, null);
    assert.match(String(plannerArtifact.prompt), /Start with a short "Summary of Request and Approach"/u);
    assert.match(String(plannerArtifact.prompt), /Open Questions \(if any\)/u);
    assert.match(String(plannerArtifact.prompt), /misalignment between the request and existing repository behavior/u);

    const clearToolContextResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/tool-context/clear`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(clearToolContextResponse.statusCode, 404);

    const condenseResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/condense`, {
      method: 'POST',
      body: JSON.stringify({ mockResponses: [{ content: 'CONDENSED: the session discussed a stored assistant response.' }] }),
    });
    assert.equal(condenseResponse.statusCode, 200);
    const condensedSession = d(condenseResponse.body.session);
    const condensedMessages = asObjectArray(condensedSession.messages);
    const summaryRow = condensedMessages.find((message) => message.kind === 'compaction_summary');
    assert.ok(summaryRow);
    assert.match(String(summaryRow.content), /stored assistant response/u);
    assert.equal(summaryRow.compressedIntoSummary !== true, true);
    const summaryIndex = condensedMessages.indexOf(summaryRow);
    assert.equal(summaryIndex, condensedMessages.length - 1);
    assert.equal(
      condensedMessages.slice(0, summaryIndex).every((message) => message.compressedIntoSummary === true),
      true,
    );

    const sessionsResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions`);
    assert.equal(sessionsResponse.statusCode, 200);
    assert.equal(asObjectArray(sessionsResponse.body.sessions).length, 1);

    const sessionDetail = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}`);
    assert.equal(sessionDetail.statusCode, 200);
    assert.equal((d(sessionDetail.body.session)).id, sessionId);

    const deleteSession = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}`, {
      method: 'DELETE',
    });
    assert.equal(deleteSession.statusCode, 200);
    assert.equal(deleteSession.body.deleted, true);

    const sessionsAfterDelete = await requestJson(`${baseUrl}/dashboard/chat/sessions`);
    assert.equal(sessionsAfterDelete.statusCode, 200);
    assert.equal(asObjectArray(sessionsAfterDelete.body.sessions).length, 0);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('dashboard chat message route uses the runtime BaseUrl for exact llama tokens', async () => {
  const tempRoot = createManagedTempDir('siftkit-dashboard-chat-tokenize-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = getConfigPath();
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const tokenizedContents: string[] = [];
  const tokenizerServer = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/tokenize') {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const bodyText = await new Promise<string>((resolve) => {
      let data = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { data += chunk; });
      request.on('end', () => resolve(data));
    });
    const parsed = asObject(parseJsonValueText(bodyText));
    const content = String(parsed.content || '');
    tokenizedContents.push(content);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ count: content === 'exact route user prompt' ? 23 : Math.max(1, Math.ceil(content.length / 4)) }));
  });
  await new Promise<void>((resolve) => tokenizerServer.listen(0, '127.0.0.1', resolve));
  const tokenizerAddress = getAddressInfo(tokenizerServer);
  const tokenizerBaseUrl = `http://127.0.0.1:${tokenizerAddress.port}`;
  const config = getDefaultConfig();
  const serverLlama = config.Server.ModelPresets;
  serverLlama.Presets = [{
    ...serverLlama.Presets[0],
    id: 'default',
    label: 'Default',
    ExternalServerEnabled: false,
    BaseUrl: SIFT_DEFAULT_LLAMA_BASE_URL,
  }];
  serverLlama.ActivePresetId = 'default';
  writeConfig(configPath, config);
  writeRuntimeLaunchSnapshot(configPath, {
    Model: serverLlama.Presets[0]?.Model ?? null,
    LlamaCpp: {
      BaseUrl: tokenizerBaseUrl,
      NumCtx: serverLlama.Presets[0]?.NumCtx,
      Reasoning: serverLlama.Presets[0]?.Reasoning,
    },
  });
  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const createSession = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Tokenized chat session',
        model: 'Qwen3.5-9B-Q8_0.gguf',
      }),
    });
    assert.equal(createSession.statusCode, 200);
    const sessionId = String(d(createSession.body.session).id);

    const appendMessage = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      timeoutMs: 3000,
      body: JSON.stringify({
        content: 'exact route user prompt',
        assistantContent: 'stored assistant response',
      }),
    });
    assert.equal(appendMessage.statusCode, 200);
    const messages = asObjectArray(d(appendMessage.body.session).messages);
    const userMessage = messages.find((message) => message.kind === 'user_text');
    assert.ok(userMessage);
    assert.equal(userMessage.inputTokensEstimate, 23);
    assert.equal(userMessage.inputTokensEstimated, false);
    assert.equal(tokenizedContents.includes('exact route user prompt'), true);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      tokenizerServer.close((error) => (error ? reject(error) : resolve()));
    });
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('dashboard metrics expose line-read stats and prompt-baseline recommendations', async () => {
  const tempRoot = createManagedTempDir('siftkit-dashboard-line-read-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const runtimeRoot = path.join(tempRoot, '.siftkit');
  const statusPath = path.join(runtimeRoot, 'status', 'inference.txt');
  const configPath = path.join(runtimeRoot, 'config.json');
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(statusPath, 'false', 'utf8');
  fs.writeFileSync(configPath, JSON.stringify({
    Summary: {
      PreferredBackend: 'llama.cpp',
    },
    LlamaCpp: {
      BaseUrl: 'http://127.0.0.1:8080',
      Model: 'mock-model.gguf',
      NumCtx: 32000,
      PromptTokenReserve: 4000,
    },
    Server: {
      ModelPresets: {
        ActivePresetId: 'default',
        Presets: [{
          id: 'default',
          label: 'Default',
          Backend: 'llama',
          Model: 'mock-model.gguf',
          BaseUrl: 'http://127.0.0.1:8080',
          NumCtx: 32000,
        }],
      },
    },
  }, null, 2));

  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);

  const server = startStatusServer({ disableManagedLlamaStartup: true, terminalMetadataIdleDelayMs: 0 });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await requestJson(`${baseUrl}/status/terminal-metadata`, {
      method: 'POST',
      body: JSON.stringify({
        running: false,
        requestId: 'line-read-dashboard',
        taskKind: 'repo-search',
        terminalState: 'completed',
        promptCharacterCount: 120,
        inputTokens: 30,
        outputCharacterCount: 80,
        outputTokens: 12,
        toolTokens: 9,
        requestDurationMs: 90,
        toolStats: {
          'get-content': {
            calls: 1,
            outputCharsTotal: 400,
            outputTokensTotal: 200,
            outputTokensEstimatedCount: 0,
            lineReadCalls: 1,
            lineReadLinesTotal: 80,
            lineReadTokensTotal: 200,
            semanticRepeatRejects: 2,
            stagnationWarnings: 1,
            forcedFinishFromStagnation: 1,
            promptInsertedTokens: 120,
            rawToolResultTokens: 220,
            newEvidenceCalls: 1,
            noNewEvidenceCalls: 2,
          },
        },
      }),
    });

    let metricsBody: Dict = {};
    await runtimeHelpers.waitForAsyncExpectation(async () => {
      const metricsResponse = await requestJson(`${baseUrl}/dashboard/metrics/timeseries`);
      assert.equal(metricsResponse.statusCode, 200);
      metricsBody = d(metricsResponse.body);
      const repoSearchToolStats = d(d(metricsBody.toolStats)['repo-search']);
      const getContentStats = d(repoSearchToolStats['get-content']);
      assert.equal(getContentStats.lineReadCalls, 1);
    }, 1000);
    const repoSearchToolStats = d(d(metricsBody.toolStats)['repo-search']);
    const getContentStats = d(repoSearchToolStats['get-content']);
    assert.equal(getContentStats.lineReadCalls, 1);
    assert.equal(getContentStats.lineReadLinesTotal, 80);
    assert.equal(getContentStats.lineReadTokensTotal, 200);
    assert.equal(Number.isFinite(Number(getContentStats.lineReadRecommendedLines)), true);
    assert.equal(Number.isFinite(Number(getContentStats.lineReadAllowanceTokens)), true);
    assert.equal(Number(getContentStats.lineReadRecommendedLines) > 0, true);
    assert.equal(Number(getContentStats.lineReadAllowanceTokens) > 0, true);
    assert.equal(getContentStats.semanticRepeatRejects, 2);
    assert.equal(getContentStats.stagnationWarnings, 1);
    assert.equal(getContentStats.forcedFinishFromStagnation, 1);
    assert.equal(getContentStats.promptInsertedTokens, 120);
    assert.equal(getContentStats.rawToolResultTokens, 220);
    assert.equal(getContentStats.newEvidenceCalls, 1);
    assert.equal(getContentStats.noNewEvidenceCalls, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('web_search tool calls increment web search usage', async () => {
  const tempRoot = createManagedTempDir('siftkit-dashboard-web-search-usage-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(statusPath, 'false', 'utf8');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);

  const server = startStatusServer({ disableManagedLlamaStartup: true, terminalMetadataIdleDelayMs: 0 });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await requestJson(`${baseUrl}/status/terminal-metadata`, {
      method: 'POST',
      body: JSON.stringify({
        running: false,
        requestId: 'req-websearch-1',
        taskKind: 'chat',
        terminalState: 'completed',
        requestDurationMs: 50,
        toolStats: { web_search: { calls: 3 } },
      }),
    });

    let usage: Dict = {};
    await runtimeHelpers.waitForAsyncExpectation(async () => {
      const metricsResponse = await requestJson(`${baseUrl}/dashboard/metrics/timeseries`);
      assert.equal(metricsResponse.statusCode, 200);
      usage = d(d(metricsResponse.body).webSearchUsage);
      assert.equal(usage.allTimeCount, 3);
    }, 1000);
    assert.equal(usage.allTimeCount, 3);
    assert.equal(usage.currentMonthCount, 3);
    assert.match(String(usage.currentMonth), /^\d{4}-\d{2}$/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    restoreDashboardTestRepo(previousCwd);
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('plan/repo-search stream events include backend promptTokenCount', async () => {
  const tempRoot = createManagedTempDir('siftkit-dashboard-stream-tokens-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const streamConfig = getDefaultConfig();
  const planPreset = streamConfig.Presets.find((preset) => preset.id === 'plan');
  const repoSearchPreset = streamConfig.Presets.find((preset) => preset.id === 'repo-search');
  if (!planPreset || !repoSearchPreset) {
    throw new Error('Default plan and repo-search presets are required.');
  }
  planPreset.autoloadFiles = ['missing-plan-context.md'];
  repoSearchPreset.autoloadFiles = ['missing-repo-context.md'];
  writeConfig(getConfigPath(), streamConfig);

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const createSession = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Stream Session',
        model: 'Qwen3.5-9B-Q8_0.gguf',
      }),
    });
    const sessionId = String(d(createSession.body.session).id);
    const createJsonSession = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'JSON Plan Session',
        model: 'Qwen3.5-9B-Q8_0.gguf',
      }),
    });
    const jsonSessionId = String(d(createJsonSession.body.session).id);
    const planRequestBody = {
      content: 'Add API tests',
      repoRoot: tempRoot,
      maxTurns: 2,
      availableModels: ['Qwen3.5-35B-A3B-UD-Q4_K_L.gguf'],
      mockResponses: [
        {
          thinking: 'inspect test coverage',
          toolCalls: [{ name: 'git', arguments: { operation: 'grep', pattern: 'test', path: '.' } }],
        },
        { thinking: 'prepare implementation plan', content: 'done' },
      ],
      mockCommandResults: {
        "git operation=\"grep\" path=\".\" pattern=\"test\"": { exitCode: 0, stdout: 'tests/example.test.ts:1:test()', stderr: '' },
      },
    };
    const jsonPlan = await requestJson(`${baseUrl}/dashboard/chat/sessions/${jsonSessionId}/plan`, {
      method: 'POST',
      timeoutMs: 3000,
      body: JSON.stringify(planRequestBody),
    });
    assert.equal(jsonPlan.statusCode, 200);

    const planSse = await requestSse(`${baseUrl}/dashboard/chat/sessions/${sessionId}/plan/stream`, {
      method: 'POST',
      timeoutMs: 3000,
      body: JSON.stringify(planRequestBody),
    });
    assert.equal(planSse.statusCode, 200);
    assert.deepEqual(
      planSse.events
        .map((event) => event.event)
        .filter((event) => ['warning', 'thinking', 'tool_start', 'tool_result', 'done'].includes(event)),
      ['warning', 'thinking', 'tool_start', 'tool_result', 'thinking', 'done'],
    );
    const planThinkingEvents = planSse.events.filter((event) => event.event === 'thinking');
    assert.equal(planThinkingEvents.length, 2);
    for (const event of planThinkingEvents) {
      parseTextDeltaEvent(event);
    }
    assert.match(
      String(planSse.events.find((event) => event.event === 'warning')?.payload?.warning || ''),
      /missing-plan-context\.md/u,
    );
    const planToolStart = planSse.events.find((event) => event.event === 'tool_start');
    const planToolResult = planSse.events.find((event) => event.event === 'tool_result');
    assert.equal(Number.isFinite(Number(planToolStart?.payload?.promptTokenCount)), true);
    assert.equal(Number.isFinite(Number(planToolResult?.payload?.promptTokenCount)), true);
    assert.equal(planToolStart?.payload?.command, "git operation=\"grep\" path=\".\" pattern=\"test\"");
    assert.equal(planToolResult?.payload?.command, "git operation=\"grep\" path=\".\" pattern=\"test\"");
    assert.equal(/--no-ignore|--ignore-case|--glob/u.test(String(planToolStart?.payload?.command || '')), false);
    assert.equal(/--no-ignore|--ignore-case|--glob/u.test(String(planToolResult?.payload?.command || '')), false);
    assert.equal(typeof planToolStart?.payload?.toolCallId, 'string');
    assert.equal(String(planToolStart?.payload?.toolCallId || '').length > 0, true);
    assert.equal(planToolStart?.payload?.toolCallId, planToolResult?.payload?.toolCallId);
    assert.equal(
      planSse.events.some((event) => event.event === 'answer' && /Planning step/u.test(String(event.payload?.answer || ''))),
      false,
      JSON.stringify(planSse.events),
    );
    const planDoneSession = asObject(d(planSse.events.find((event) => event.event === 'done')?.payload).session);
    assert.equal(planDoneSession.presetId, 'plan');
    assert.equal(planDoneSession.mode, 'plan');
    const planDoneMessages = asObjectArray(planDoneSession.messages);
    const jsonPlanMessages = asObjectArray(d(jsonPlan.body.session).messages);
    assert.deepEqual(
      planDoneMessages.map((message) => ({
        kind: message.kind,
        content: String(message.content || '').split('\n\n## Artifacts')[0],
        toolCallCommand: message.toolCallCommand,
        toolCallOutput: message.toolCallOutput,
      })),
      jsonPlanMessages.map((message) => ({
        kind: message.kind,
        content: String(message.content || '').split('\n\n## Artifacts')[0],
        toolCallCommand: message.toolCallCommand,
        toolCallOutput: message.toolCallOutput,
      })),
    );
    assert.deepEqual(
      Object.keys(d(d(planSse.events.find((event) => event.event === 'done')?.payload).repoSearch)).sort(),
      Object.keys(d(jsonPlan.body.repoSearch)).sort(),
    );
    const persistedPlan = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}`);
    assert.deepEqual(planDoneSession, d(persistedPlan.body.session));
    const latestPlanMessage = planDoneMessages[planDoneMessages.length - 1];
    assert.equal(typeof latestPlanMessage.requestStartedAtUtc, 'string');
    assert.equal(typeof latestPlanMessage.thinkingStartedAtUtc, 'string');
    assert.equal(typeof latestPlanMessage.thinkingEndedAtUtc, 'string');
    assert.equal(typeof latestPlanMessage.answerStartedAtUtc, 'string');
    assert.equal(typeof latestPlanMessage.answerEndedAtUtc, 'string');

    const repoSse = await requestSse(`${baseUrl}/dashboard/chat/sessions/${sessionId}/repo-search/stream`, {
      method: 'POST',
      timeoutMs: 3000,
      body: JSON.stringify({
        content: 'Find tests',
        repoRoot: tempRoot,
        maxTurns: 2,
        availableModels: ['Qwen3.5-35B-A3B-UD-Q4_K_L.gguf'],
        mockResponses: [
          {
            thinking: 'inspect repository tests',
            toolCalls: [{ name: 'git', arguments: { operation: 'grep', pattern: 'test', path: '.' } }],
          },
          { thinking: 'report repository evidence', content: 'done' },
        ],
        mockCommandResults: {
          "git operation=\"grep\" path=\".\" pattern=\"test\"": { exitCode: 0, stdout: 'tests/example.test.ts:1:test()', stderr: '' },
        },
      }),
    });
    assert.equal(repoSse.statusCode, 200);
    assert.deepEqual(
      repoSse.events
        .map((event) => event.event)
        .filter((event) => ['warning', 'thinking', 'answer', 'tool_start', 'tool_result', 'done'].includes(event)),
      ['warning', 'thinking', 'tool_start', 'tool_result', 'thinking', 'done'],
    );
    const repoThinkingEvents = repoSse.events.filter((event) => event.event === 'thinking');
    assert.equal(repoThinkingEvents.length, 2);
    assert.equal(repoSse.events.some((event) => event.event === 'answer'), false);
    for (const event of repoThinkingEvents) {
      parseTextDeltaEvent(event);
    }
    assert.match(
      String(repoSse.events.find((event) => event.event === 'warning')?.payload?.warning || ''),
      /missing-repo-context\.md/u,
    );
    const repoToolStart = repoSse.events.find((event) => event.event === 'tool_start');
    const repoToolResult = repoSse.events.find((event) => event.event === 'tool_result');
    assert.equal(Number.isFinite(Number(repoToolStart?.payload?.promptTokenCount)), true);
    assert.equal(Number.isFinite(Number(repoToolResult?.payload?.promptTokenCount)), true);
    assert.equal(repoToolStart?.payload?.command, "git operation=\"grep\" path=\".\" pattern=\"test\"");
    assert.equal(/--no-ignore|--ignore-case|--glob/u.test(String(repoToolStart?.payload?.command || '')), false);
    assert.equal(typeof repoToolStart?.payload?.toolCallId, 'string');
    assert.equal(String(repoToolStart?.payload?.toolCallId || '').length > 0, true);
    assert.equal(repoToolStart?.payload?.toolCallId, repoToolResult?.payload?.toolCallId);

    assert.deepEqual(
      Object.keys(planToolStart?.payload ?? {}).sort(),
      Object.keys(repoToolStart?.payload ?? {}).sort(),
      'plan and repo-search tool_start payloads must share identical key shape',
    );
    assert.deepEqual(
      Object.keys(planToolResult?.payload ?? {}).sort(),
      Object.keys(repoToolResult?.payload ?? {}).sort(),
      'plan and repo-search tool_result payloads must share identical key shape',
    );
    const repoDoneSession = asObject(d(repoSse.events.find((event) => event.event === 'done')?.payload).session);
    assert.equal(repoDoneSession.presetId, 'repo-search');
    assert.equal(repoDoneSession.mode, 'repo-search');
    const persistedRepoSearch = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}`);
    assert.deepEqual(repoDoneSession, d(persistedRepoSearch.body.session));
    const repoDoneMessages = asObjectArray(repoDoneSession.messages);
    const latestRepoMessage = repoDoneMessages[repoDoneMessages.length - 1];
    assert.equal(typeof latestRepoMessage.requestStartedAtUtc, 'string');
    assert.equal(typeof latestRepoMessage.thinkingStartedAtUtc, 'string');
    assert.equal(typeof latestRepoMessage.thinkingEndedAtUtc, 'string');
    assert.equal(typeof latestRepoMessage.answerStartedAtUtc, 'string');
    assert.equal(typeof latestRepoMessage.answerEndedAtUtc, 'string');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('plan and repo-search endpoints forward and persist attached images', async () => {
  const tempRoot = createManagedTempDir('siftkit-dashboard-route-images-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const config = getDefaultConfig();
  const modelPreset = config.Server.ModelPresets.Presets[0];
  if (!modelPreset) {
    throw new Error('Default model preset is required.');
  }
  modelPreset.Backend = 'exl3';
  modelPreset.VisionEnabled = true;
  writeConfig(getConfigPath(), config);

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const imageRequestBody = {
    content: 'Describe this image in the repository context',
    repoRoot: tempRoot,
    images: [PNG],
    maxTurns: 1,
    mockResponses: [{ content: "done" }],
  };

  try {
    const planSessionResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Image Plan Session', model: 'Qwen3.5-9B-Q8_0.gguf' }),
    });
    const planSessionId = String(d(planSessionResponse.body.session).id);
    const planResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions/${planSessionId}/plan`, {
      method: 'POST',
      timeoutMs: 3000,
      body: JSON.stringify(imageRequestBody),
    });
    assert.equal(planResponse.statusCode, 200);
    const planSession = d(planResponse.body.session);
    assert.deepEqual(asObjectArray(planSession.messages).find((message) => message.kind === 'user_text')?.images, [PNG]);
    const reloadedPlan = await requestJson(`${baseUrl}/dashboard/chat/sessions/${planSessionId}`);
    assert.deepEqual(
      asObjectArray(d(reloadedPlan.body.session).messages).find((message) => message.kind === 'user_text')?.images,
      [PNG],
    );

    const repoSessionResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Image Repo Session', model: 'Qwen3.5-9B-Q8_0.gguf' }),
    });
    const repoSessionId = String(d(repoSessionResponse.body.session).id);
    const repoResponse = await requestSse(`${baseUrl}/dashboard/chat/sessions/${repoSessionId}/repo-search/stream`, {
      method: 'POST',
      timeoutMs: 3000,
      body: JSON.stringify(imageRequestBody),
    });
    assert.equal(repoResponse.statusCode, 200);
    const repoDoneSession = d(repoResponse.events.find((event) => event.event === 'done')?.payload).session;
    assert.deepEqual(asObjectArray(d(repoDoneSession).messages).find((message) => message.kind === 'user_text')?.images, [PNG]);
    const reloadedRepo = await requestJson(`${baseUrl}/dashboard/chat/sessions/${repoSessionId}`);
    assert.deepEqual(
      asObjectArray(d(reloadedRepo.body.session).messages).find((message) => message.kind === 'user_text')?.images,
      [PNG],
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('chat message JSON and SSE endpoints admit images using the selected session preset', async () => {
  const tempRoot = createManagedTempDir('siftkit-dashboard-message-image-admission-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const capturedBodies: string[] = [];
  const llamaServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'image-chat-model' }] }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.statusCode = 404;
      res.end();
      return;
    }
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { raw += chunk; });
    req.on('end', () => {
      capturedBodies.push(raw);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write("data: {\"choices\":[{\"delta\":{\"content\":\"ack\"}}]}\n\n");
      res.write("data: {\"choices\":[{\"delta\":{}}],\"usage\":{\"prompt_tokens\":20,\"completion_tokens\":4}}\n\n");
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    llamaServer.listen(0, '127.0.0.1', (error?: Error) => (error ? reject(error) : resolve()));
  });
  const llamaAddress = getAddressInfo(llamaServer);
  const oversizedImage = toDataUrl('image/png', rasterBuffer('png', 2000, 1000));
  const secondOversizedImage = toDataUrl('image/png', rasterBuffer('png', 1800, 1000));
  const sessionCap = 500_000;
  const baseConfig = getDefaultConfig();
  const snapshotPreset = baseConfig.Server.ModelPresets.Presets[0];
  if (!snapshotPreset) {
    throw new Error('Default model preset is required.');
  }
  snapshotPreset.Backend = 'exl3';
  snapshotPreset.ExternalServerEnabled = true;
  snapshotPreset.BaseUrl = `http://127.0.0.1:${llamaAddress.port}`;
  snapshotPreset.Model = 'image-chat-model';
  snapshotPreset.VisionEnabled = true;
  snapshotPreset.VisionImageRetention = -1;
  snapshotPreset.VisionMaxImagePixels = sessionCap;
  baseConfig.Server.Engines.Exl3.Managed = false;
  writeConfig(getConfigPath(), baseConfig);

  const server = startStatusServer({ disableManagedLlamaStartup: true, terminalMetadataIdleDelayMs: 0 });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  function extractLastUserImage(rawBody: string): string {
    const body = d(parseJsonValueText(rawBody));
    const messages = asObjectArray(body.messages);
    const userMessage = [...messages].reverse().find((message) => (
      message.role === 'user' && asObjectArray(message.content).some((part) => part.type === 'image_url')
    ));
    assert.ok(userMessage);
    const parts = asObjectArray(userMessage.content);
    const imagePart = parts.find((part) => part.type === 'image_url');
    assert.ok(imagePart, rawBody);
    const imageUrl = asObject(imagePart.image_url).url;
    if (typeof imageUrl !== 'string') {
      throw new Error('Expected a string image URL in the model request.');
    }
    return imageUrl;
  }

  function assertAdmittedImage(admittedUrl: string): void {
    assert.notEqual(admittedUrl, oversizedImage);
    const separator = admittedUrl.indexOf(';base64,');
    const mime = admittedUrl.slice('data:'.length, separator);
    const dimensions = readImageDimensions(
      Buffer.from(admittedUrl.slice(separator + ';base64,'.length), 'base64'),
      mime,
    );
    assert.ok(dimensions.width * dimensions.height <= sessionCap);
    assert.ok(dimensions.width * dimensions.height > 100_000);
  }

  try {
    const created = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Selected image preset', model: 'image-chat-model' }),
    });
    const sessionId = String(d(created.body.session).id);

    // Move the active model slot to a stricter cap after creation. The session snapshot remains
    // authoritative, proving these routes do not admit against the base active preset.
    const currentConfigResponse = await requestJson(`${baseUrl}/config?skip_ready=1`);
    const updatedConfig = d(structuredClone(currentConfigResponse.body));
    const modelPresets = d(d(updatedConfig.Server).ModelPresets);
    const basePreset = asObjectArray(modelPresets.Presets)[0];
    assert.ok(basePreset);
    modelPresets.Presets = [
      basePreset,
      {
        ...basePreset,
        id: 'live',
        label: 'Live',
        VisionMaxImagePixels: 100_000,
        VisionImageRetention: 0,
      },
    ];
    modelPresets.ActivePresetId = 'live';
    const updateResponse = await requestJson(`${baseUrl}/config?skip_ready=1`, {
      method: 'PUT',
      body: JSON.stringify(updatedConfig),
    });
    assert.equal(updateResponse.statusCode, 200);

    const jsonResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      timeoutMs: 5_000,
      body: JSON.stringify({ content: 'Describe this screenshot.', images: [oversizedImage] }),
    });
    assert.equal(jsonResponse.statusCode, 200, JSON.stringify(jsonResponse.body));
    const jsonAdmittedImage = extractLastUserImage(capturedBodies[capturedBodies.length - 1] ?? '');
    assertAdmittedImage(jsonAdmittedImage);
    const jsonSession = d(jsonResponse.body.session);
    const jsonUserMessage = asObjectArray(jsonSession.messages).find((message) => message.kind === 'user_text');
    assert.deepEqual(jsonUserMessage?.images, [jsonAdmittedImage]);
    const reloadedJson = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}`);
    const reloadedJsonUserMessage = asObjectArray(d(reloadedJson.body.session).messages)
      .find((message) => message.kind === 'user_text');
    assert.deepEqual(reloadedJsonUserMessage?.images, [jsonAdmittedImage]);

    const streamResponse = await requestSse(`${baseUrl}/dashboard/chat/sessions/${sessionId}/messages/stream`, {
      method: 'POST',
      timeoutMs: 5_000,
      body: JSON.stringify({ content: 'Describe it again.', images: [secondOversizedImage] }),
    });
    assert.equal(streamResponse.statusCode, 200, JSON.stringify(streamResponse.events));
    assert.equal(streamResponse.events.some((event) => event.event === 'error'), false, JSON.stringify(streamResponse.events));
    const streamProviderBody = capturedBodies[capturedBodies.length - 1] ?? '';
    assert.ok(streamProviderBody.includes(jsonAdmittedImage), streamProviderBody);
    const streamAdmittedImage = extractLastUserImage(streamProviderBody);
    assert.notEqual(streamAdmittedImage, jsonAdmittedImage);
    assertAdmittedImage(streamAdmittedImage);
    const doneSession = d(d(streamResponse.events.find((event) => event.event === 'done')?.payload).session);
    const streamUserMessages = asObjectArray(doneSession.messages).filter((message) => message.kind === 'user_text');
    assert.deepEqual(streamUserMessages[streamUserMessages.length - 1]?.images, [streamAdmittedImage]);
    const reloadedStream = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}`);
    const reloadedStreamMessages = asObjectArray(d(reloadedStream.body.session).messages)
      .filter((message) => message.kind === 'user_text');
    assert.deepEqual(reloadedStreamMessages[reloadedStreamMessages.length - 1]?.images, [streamAdmittedImage]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      llamaServer.close((error?: Error) => (error ? reject(error) : resolve()));
    });
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('plan JSON and repo-search SSE admit images using session-snapshotted caps', async () => {
  const tempRoot = createManagedTempDir('siftkit-dashboard-operation-image-admission-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const capturedBodies: string[] = [];
  const llamaServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'operation-image-model' }] }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.statusCode = 404;
      res.end();
      return;
    }
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { raw += chunk; });
    req.on('end', () => {
      capturedBodies.push(raw);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write("data: {\"choices\":[{\"delta\":{\"content\":\"ack\"}}]}\n\n");
      res.write("data: {\"choices\":[{\"delta\":{}}],\"usage\":{\"prompt_tokens\":20,\"completion_tokens\":4}}\n\n");
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    llamaServer.listen(0, '127.0.0.1', (error?: Error) => (error ? reject(error) : resolve()));
  });
  const llamaAddress = getAddressInfo(llamaServer);
  const oversizedImage = toDataUrl('image/png', rasterBuffer('png', 2000, 1000));
  const sessionCap = 500_000;
  const laterActiveCap = 100_000;
  const baseConfig = getDefaultConfig();
  const snapshotPreset = baseConfig.Server.ModelPresets.Presets[0];
  if (!snapshotPreset) {
    throw new Error('Default model preset is required.');
  }
  snapshotPreset.Backend = 'exl3';
  snapshotPreset.ExternalServerEnabled = true;
  snapshotPreset.BaseUrl = `http://127.0.0.1:${llamaAddress.port}`;
  snapshotPreset.Model = 'operation-image-model';
  snapshotPreset.VisionEnabled = true;
  snapshotPreset.VisionImageRetention = -1;
  snapshotPreset.VisionMaxImagePixels = sessionCap;
  baseConfig.Server.Engines.Exl3.Managed = false;
  writeConfig(getConfigPath(), baseConfig);

  const server = startStatusServer({ disableManagedLlamaStartup: true, terminalMetadataIdleDelayMs: 0 });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  function extractLastUserImage(rawBody: string): string {
    const body = d(parseJsonValueText(rawBody));
    const messages = asObjectArray(body.messages);
    const userMessage = [...messages].reverse().find((message) => (
      message.role === 'user' && asObjectArray(message.content).some((part) => part.type === 'image_url')
    ));
    assert.ok(userMessage);
    const imagePart = asObjectArray(userMessage.content).find((part) => part.type === 'image_url');
    assert.ok(imagePart, rawBody);
    const imageUrl = asObject(imagePart.image_url).url;
    if (typeof imageUrl !== 'string') {
      throw new Error('Expected a string image URL in the model request.');
    }
    return imageUrl;
  }

  function assertAdmittedImage(admittedUrl: string): void {
    assert.notEqual(admittedUrl, oversizedImage);
    const separator = admittedUrl.indexOf(';base64,');
    const mime = admittedUrl.slice('data:'.length, separator);
    const dimensions = readImageDimensions(
      Buffer.from(admittedUrl.slice(separator + ';base64,'.length), 'base64'),
      mime,
    );
    assert.ok(dimensions.width * dimensions.height <= sessionCap);
    assert.ok(dimensions.width * dimensions.height > laterActiveCap);
  }

  function assertPersistedImage(session: Dict, expectedImage: string): void {
    assert.deepEqual(
      asObjectArray(session.messages).find((message) => message.kind === 'user_text')?.images,
      [expectedImage],
    );
  }

  try {
    const planSessionResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Snapshot Plan Session', model: 'operation-image-model' }),
    });
    const planSessionId = String(d(planSessionResponse.body.session).id);
    const repoSessionResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Snapshot Repo Session', model: 'operation-image-model' }),
    });
    const repoSessionId = String(d(repoSessionResponse.body.session).id);

    const currentConfigResponse = await requestJson(`${baseUrl}/config?skip_ready=1`);
    const updatedConfig = d(structuredClone(currentConfigResponse.body));
    const modelPresets = d(d(updatedConfig.Server).ModelPresets);
    const activeSnapshotPreset = asObjectArray(modelPresets.Presets)[0];
    assert.ok(activeSnapshotPreset);
    modelPresets.Presets = [
      activeSnapshotPreset,
      {
        ...activeSnapshotPreset,
        id: 'live-strict',
        label: 'Live Strict',
        VisionMaxImagePixels: laterActiveCap,
      },
    ];
    modelPresets.ActivePresetId = 'live-strict';
    const updateResponse = await requestJson(`${baseUrl}/config?skip_ready=1`, {
      method: 'PUT',
      body: JSON.stringify(updatedConfig),
    });
    assert.equal(updateResponse.statusCode, 200);

    const requestBody = {
      content: 'Describe this image in the repository context',
      repoRoot: tempRoot,
      images: [oversizedImage],
      maxTurns: 1,
    };
    const planResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions/${planSessionId}/plan`, {
      method: 'POST',
      timeoutMs: 5_000,
      body: JSON.stringify(requestBody),
    });
    assert.equal(planResponse.statusCode, 200, JSON.stringify(planResponse.body));
    const planProviderBody = capturedBodies[capturedBodies.length - 1] ?? '';
    assert.equal(planProviderBody.includes(oversizedImage), false);
    const planAdmittedImage = extractLastUserImage(planProviderBody);
    assertAdmittedImage(planAdmittedImage);
    assertPersistedImage(d(planResponse.body.session), planAdmittedImage);
    const reloadedPlan = await requestJson(`${baseUrl}/dashboard/chat/sessions/${planSessionId}`);
    assertPersistedImage(d(reloadedPlan.body.session), planAdmittedImage);

    const repoResponse = await requestSse(`${baseUrl}/dashboard/chat/sessions/${repoSessionId}/repo-search/stream`, {
      method: 'POST',
      timeoutMs: 5_000,
      body: JSON.stringify(requestBody),
    });
    assert.equal(repoResponse.statusCode, 200, JSON.stringify(repoResponse.events));
    assert.equal(repoResponse.events.some((event) => event.event === 'error'), false, JSON.stringify(repoResponse.events));
    const repoProviderBody = capturedBodies[capturedBodies.length - 1] ?? '';
    assert.equal(repoProviderBody.includes(oversizedImage), false);
    const repoAdmittedImage = extractLastUserImage(repoProviderBody);
    assertAdmittedImage(repoAdmittedImage);
    const repoDoneSession = d(d(repoResponse.events.find((event) => event.event === 'done')?.payload).session);
    assertPersistedImage(repoDoneSession, repoAdmittedImage);
    const reloadedRepo = await requestJson(`${baseUrl}/dashboard/chat/sessions/${repoSessionId}`);
    assertPersistedImage(d(reloadedRepo.body.session), repoAdmittedImage);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      llamaServer.close((error?: Error) => (error ? reject(error) : resolve()));
    });
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('repo-search endpoint rejects images when the active preset lacks vision', async () => {
  const tempRoot = createManagedTempDir('siftkit-dashboard-route-vision-off-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const config = getDefaultConfig();
  const modelPreset = config.Server.ModelPresets.Presets[0];
  if (!modelPreset) {
    throw new Error('Default model preset is required.');
  }
  modelPreset.Backend = 'exl3';
  modelPreset.VisionEnabled = false;
  writeConfig(getConfigPath(), config);

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const sessionResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Vision-disabled repo-search session' }),
    });
    const sessionId = String(d(sessionResponse.body.session).id);
    const response = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/repo-search`, {
      method: 'POST',
      body: JSON.stringify({
        content: 'where is the login screen',
        repoRoot: tempRoot,
        images: [PNG],
        mockResponses: [{ content: 'done' }],
      }),
    });
    assert.equal(response.statusCode, 500);
    assert.match(String(response.body.error), /Vision is not enabled for this preset/u);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('plan stream endpoint rejects images when image retention is zero', async () => {
  const tempRoot = createManagedTempDir('siftkit-dashboard-route-retention-zero-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const config = getDefaultConfig();
  const modelPreset = config.Server.ModelPresets.Presets[0];
  if (!modelPreset) {
    throw new Error('Default model preset is required.');
  }
  modelPreset.Backend = 'exl3';
  modelPreset.VisionEnabled = true;
  modelPreset.VisionImageRetention = 0;
  writeConfig(getConfigPath(), config);

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const sessionResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Retention-zero plan session' }),
    });
    const sessionId = String(d(sessionResponse.body.session).id);
    const response = await requestSse(`${baseUrl}/dashboard/chat/sessions/${sessionId}/plan/stream`, {
      method: 'POST',
      body: JSON.stringify({
        content: 'plan it',
        repoRoot: tempRoot,
        images: [PNG],
        mockResponses: [{ content: 'done' }],
      }),
    });
    const errorEvent = response.events.find((event) => event.event === 'error');
    assert.ok(errorEvent);
    assert.match(
      String(errorEvent.payload?.error),
      /Image input is disabled for this preset \(VisionImageRetention = 0\)/u,
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('chat session web search defaults on and update persists webSearchEnabled', async () => {
  const tempRoot = createManagedTempDir('siftkit-dashboard-web-search-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const created = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Web default on' }),
    });
    assert.equal(created.statusCode, 200);
    const session = d(created.body.session);
    assert.equal(session.webSearchEnabled, true);

    const sessionId = String(session.id);
    const updated = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}`, {
      method: 'PUT',
      body: JSON.stringify({ webSearchEnabled: true }),
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(d(updated.body.session).webSearchEnabled, true);

    const reloaded = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}`);
    assert.equal(d(reloaded.body.session).webSearchEnabled, true);

    const disabled = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}`, {
      method: 'PUT',
      body: JSON.stringify({ webSearchEnabled: false }),
    });
    assert.equal(disabled.statusCode, 200);
    assert.equal(d(disabled.body.session).webSearchEnabled, false);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('chat delta SSE bounds payloads, preserves ordering, and flushes its latency tail', async () => {
  const tempRoot = createManagedTempDir('siftkit-dashboard-chat-delta-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const thinkingText = 't'.repeat(LIVE_TEXT_FLUSH_MAX_PENDING_CHARS * 2 + 17);
  const answerText = 'bounded answer';
  let thinkingSentAtMs = 0;
  const llamaServer = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'chat-delta-model.gguf' }] }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.statusCode = 404;
      response.end();
      return;
    }
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      thinkingSentAtMs = Date.now();
      response.write(`data: ${JSON.stringify({
        choices: [{ delta: { reasoning_content: thinkingText } }],
      })}\n\n`);
      setTimeout(() => {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answerText } }] })}\n\n`);
        response.write(`data: ${JSON.stringify({
          choices: [{ delta: {} }],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 10,
            completion_tokens_details: { reasoning_tokens: 6 },
          },
        })}\n\n`);
        response.end('data: [DONE]\n\n');
      }, LIVE_TEXT_FLUSH_MAX_LATENCY_MS * 2);
    });
  });
  await new Promise<void>((resolve, reject) => {
    llamaServer.listen(0, '127.0.0.1', (error?: Error) => (error ? reject(error) : resolve()));
  });
  const llamaAddress = getAddressInfo(llamaServer);
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const config = getDefaultConfig();
  const modelPreset = config.Server.ModelPresets.Presets[0];
  if (!modelPreset) {
    throw new Error('Default model preset is required.');
  }
  modelPreset.Model = 'chat-delta-model.gguf';
  modelPreset.BaseUrl = `http://127.0.0.1:${llamaAddress.port}`;
  modelPreset.NumCtx = 85_000;
  writeConfig(getConfigPath(), config);

  const server = startStatusServer({ disableManagedLlamaStartup: true, terminalMetadataIdleDelayMs: 0 });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const created = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Delta contract', model: 'chat-delta-model.gguf' }),
    });
    const sessionId = String(d(created.body.session).id);
    const sse = await requestSse(`${baseUrl}/dashboard/chat/sessions/${sessionId}/messages/stream`, {
      method: 'POST',
      timeoutMs: 5_000,
      body: JSON.stringify({
        content: 'Stream a bounded response.',
        webSearchOverride: 'off',
        availableModels: ['chat-delta-model.gguf'],
        model: 'chat-delta-model.gguf',
      }),
    });

    assert.equal(sse.statusCode, 200);
    assert.equal(sse.events.some((event) => event.event === 'error'), false, JSON.stringify(sse.events));
    const thinkingEvents = sse.events.filter((event) => event.event === 'thinking');
    const narrationEvents = sse.events.filter((event) => event.event === 'narration');
    const answerEvents = sse.events.filter((event) => event.event === 'answer');
    assert.equal(thinkingEvents.length, 3, JSON.stringify(sse.events));
    assert.equal(narrationEvents.length, 1, JSON.stringify(sse.events));
    assert.equal(answerEvents.length, 1, JSON.stringify(sse.events));
    const thinkingDeltas = thinkingEvents.map(parseTextDeltaEvent);
    const narrationDeltas = narrationEvents.map(parseTextDeltaEvent);
    const answerDeltas = answerEvents.map(parseTextDeltaEvent);
    assert.deepEqual(thinkingDeltas.map((delta) => delta.text.length), [1024, 1024, 17]);
    assert.deepEqual(thinkingDeltas.map((delta) => delta.offset), [0, 1024, 2048]);
    assert.equal(assembleTextDeltas(thinkingDeltas), thinkingText);
    assert.equal(assembleTextDeltas(narrationDeltas), answerText);
    assert.equal(assembleTextDeltas(answerDeltas), answerText);

    const latencyTail = thinkingEvents[2];
    if (!latencyTail) {
      throw new Error('Latency tail event was not received.');
    }
    assert.equal(
      latencyTail.receivedAtMs - thinkingSentAtMs >= LIVE_TEXT_FLUSH_MAX_LATENCY_MS - 25,
      true,
    );
    const firstAnswerIndex = sse.events.findIndex((event) => event.event === 'answer');
    const firstNarrationIndex = sse.events.findIndex((event) => event.event === 'narration');
    const doneIndex = sse.events.findIndex((event) => event.event === 'done');
    assert.equal(firstNarrationIndex < firstAnswerIndex, true);
    assert.equal(firstAnswerIndex > sse.events.lastIndexOf(latencyTail), true);
    assert.equal(doneIndex > firstAnswerIndex, true);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      llamaServer.close((error) => (error ? reject(error) : resolve()));
    });
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('no-web direct chat persists a single answer with scorecard output tokens', async () => {
  const tempRoot = createManagedTempDir('siftkit-dashboard-chat-noweb-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const created = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({ title: 'No-web chat' }),
    });
    const sessionId = String(d(created.body.session).id);

    const errorLines: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args) => {
      errorLines.push(args.map((arg) => String(arg)).join(' '));
      originalConsoleError(...args);
    };
    let sse: SseResponse;
    try {
      sse = await requestSse(`${baseUrl}/dashboard/chat/sessions/${sessionId}/messages/stream`, {
        method: 'POST',
        timeoutMs: 5000,
        body: JSON.stringify({
          content: 'What is 2+2?',
          webSearchOverride: 'off',
          availableModels: ['mock'],
          model: 'mock',
          mockResponses: [{ content: "4" }],
        }),
      });
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(sse.statusCode, 200);
    assert.equal(errorLines.some((line) => line.includes('127.0.0.1:8097')), false);
    assert.equal(sse.events.some((event) => event.event === 'error'), false, JSON.stringify(sse.events));
    assert.equal(sse.events.some((event) => event.event === 'answer'), true, JSON.stringify(sse.events));
    const doneSession = asObject(d(sse.events.find((event) => event.event === 'done')?.payload).session);
    const messages = asObjectArray(doneSession.messages);
    const answer = asObject(messages.find((message) => message.kind === 'assistant_answer'));
    assert.equal(answer.content, '4');
    assert.equal(Number(answer.outputTokensEstimate) >= 1, true);
    // No reasoning was emitted, so thinkingTokens must be 0 (not a lumped completion count).
    assert.equal(Number(answer.thinkingTokens), 0);
    assert.equal(messages.some((message) => message.kind === 'assistant_tool_call'), false);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('web-on direct chat streams tool events, persists tool step + answer, splits tokens', async () => {
  const tempRoot = createManagedTempDir('siftkit-dashboard-web-stream-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const config = getDefaultConfig();
  config.WebSearch = usableWebSearchConfig();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  writeConfig(getConfigPath(), config);

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const created = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Web stream' }),
    });
    const sessionId = String(d(created.body.session).id);

    const sse = await requestSse(`${baseUrl}/dashboard/chat/sessions/${sessionId}/messages/stream`, {
      method: 'POST',
      timeoutMs: DASHBOARD_CHAT_STREAM_TIMEOUT_MS,
      body: JSON.stringify({
        content: 'Current GE price of an iron bar?',
        webSearchOverride: 'on',
        availableModels: ['mock'],
        model: 'mock',
        mockResponses: [
          { content: "About 999 gp per bar without checking." },
          { toolCalls: [{ name: "web_search", arguments: {"query":"iron bar GE price"} }] },
          { toolCalls: [{ name: "web_fetch", arguments: {"url":"https://prices.runescape.wiki/iron-bar"} }] },
          { content: "About 150 gp per bar." },
        ],
        mockCommandResults: {
          'web_search query="iron bar GE price"': {
            exitCode: 0,
            stdout: [
              '1. GE',
              'URL: https://prices.runescape.wiki/iron-bar',
              'Snippet: iron bar ~150 gp',
              'Source: tavily',
            ].join('\n'),
          },
          'web_fetch url="https://prices.runescape.wiki/iron-bar"': {
            exitCode: 0,
            stdout: 'Fetched source: iron bar current price is about 150 gp per bar.',
          },
        },
      }),
    });

    assert.equal(sse.statusCode, 200);
    assert.equal(sse.events.some((event) => event.event === 'error'), false, JSON.stringify(sse.events));
    const sseKinds = sse.events.map((event) => event.event);
    assert.equal(sseKinds.includes('tool_start'), true, JSON.stringify(sse.events));
    assert.equal(sseKinds.includes('tool_result'), true, JSON.stringify(sse.events));
    assert.equal(sseKinds.includes('answer'), true, JSON.stringify(sse.events));
    const doneSession = asObject(d(sse.events.find((event) => event.event === 'done')?.payload).session);
    const messages = asObjectArray(doneSession.messages);
    assert.equal(messages.some((message) => message.kind === 'assistant_tool_call'), true, 'persisted a tool-call step');
    const answer = asObject(messages.find((message) => message.kind === 'assistant_answer'));
    assert.equal(answer.content, 'About 150 gp per bar.');
    assert.doesNotMatch(String(answer.content), /999/);
    assert.equal(answer.groundingStatus, 'fetched');
    assert.equal(Number(answer.outputTokensEstimate) >= 1, true); // answer bubble carries only its own output
    const toolStep = asObject(messages.find((message) => message.kind === 'assistant_tool_call'));
    assert.equal(Number(toolStep.outputTokensEstimate) >= 1, true, 'tool output tokens live on the tool step');
    const sourceRunIds = messages
      .filter((message) => message.role === 'assistant')
      .map((message) => String(message.sourceRunId || '').trim());
    assert.ok(sourceRunIds.length >= 2);
    assert.ok(sourceRunIds.every((runId) => runId.length > 0));
    assert.equal(new Set(sourceRunIds).size, 1);

    const repeated = await requestSse(`${baseUrl}/dashboard/chat/sessions/${sessionId}/messages/stream`, {
      method: 'POST',
      timeoutMs: DASHBOARD_CHAT_STREAM_TIMEOUT_MS,
      body: JSON.stringify({
        content: 'Check that price again.',
        webSearchOverride: 'on',
        availableModels: ['mock'],
        model: 'mock',
        mockResponses: [
          { toolCalls: [{ name: "web_search", arguments: {"query":"iron bar GE price"} }] },
          { toolCalls: [{ name: "web_fetch", arguments: {"url":"https://prices.runescape.wiki/iron-bar"} }] },
          { toolCalls: [{ name: "web_search", arguments: {"query":"iron bar live price"} }] },
          { toolCalls: [{ name: "web_fetch", arguments: {"url":"https://prices.runescape.wiki/iron-bar-live"} }] },
          { content: "About 151 gp per bar." },
        ],
        mockCommandResults: {
          'web_search query="iron bar live price"': {
            exitCode: 0,
            stdout: [
              '1. GE live',
              'URL: https://prices.runescape.wiki/iron-bar-live',
              'Snippet: iron bar ~151 gp',
              'Source: tavily',
            ].join('\n'),
          },
          'web_fetch url="https://prices.runescape.wiki/iron-bar-live"': {
            exitCode: 0,
            stdout: 'Fetched source: iron bar current price is about 151 gp per bar.',
          },
        },
      }),
    });

    assert.equal(repeated.statusCode, 200);
    assert.equal(repeated.events.some((event) => event.event === 'error'), false, JSON.stringify(repeated.events));
    const repeatedSession = asObject(d(repeated.events.find((event) => event.event === 'done')?.payload).session);
    const repeatedMessages = asObjectArray(repeatedSession.messages);
    const duplicateSearchStep = repeatedMessages.find((message) =>
      message.kind === 'assistant_tool_call'
      && String(message.toolCallCommand || '') === 'web_search query="iron bar GE price"'
      && /already searched/u.test(String(message.toolCallOutput || ''))
    );
    assert.ok(duplicateSearchStep, JSON.stringify(repeatedMessages));
    const duplicateFetchStep = repeatedMessages.find((message) =>
      message.kind === 'assistant_tool_call'
      && String(message.toolCallCommand || '') === 'web_fetch url="https://prices.runescape.wiki/iron-bar"'
      && /already fetched/u.test(String(message.toolCallOutput || ''))
    );
    assert.ok(duplicateFetchStep, JSON.stringify(repeatedMessages));
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('web-on direct chat can answer later turn from retained successful fetch evidence', async () => {
  const tempRoot = createManagedTempDir('siftkit-dashboard-web-replay-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);

  const config = getDefaultConfig();
  config.WebSearch = usableWebSearchConfig();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  writeConfig(getConfigPath(), config);

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const created = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Web replay' }),
    });
    const sessionId = String(d(created.body.session).id);

    const first = await requestSse(`${baseUrl}/dashboard/chat/sessions/${sessionId}/messages/stream`, {
      method: 'POST',
      timeoutMs: DASHBOARD_CHAT_STREAM_TIMEOUT_MS,
      body: JSON.stringify({
        content: 'What does the iron bar page say?',
        webSearchOverride: 'on',
        availableModels: ['mock'],
        model: 'mock',
        mockResponses: [
          { toolCalls: [{ name: "web_search", arguments: {"query":"OSRS iron bar"} }] },
          { toolCalls: [{ name: "web_fetch", arguments: {"url":"https://oldschool.runescape.wiki/w/Iron_bar"} }] },
          { content: "Iron bars are used in Smithing and quests." },
        ],
        mockCommandResults: {
          'web_search query="OSRS iron bar"': {
            exitCode: 0,
            stdout: '1. Iron bar\nURL: https://oldschool.runescape.wiki/w/Iron_bar\nSnippet: Iron bars are used in Smithing and quests.\nSource: tavily',
          },
          'web_fetch url="https://oldschool.runescape.wiki/w/Iron_bar"': {
            exitCode: 0,
            stdout: 'Fetched page text: Iron bars are used in Smithing and quests.',
          },
        },
      }),
    });

    assert.equal(first.statusCode, 200);
    assert.equal(first.events.some((event) => event.event === 'error'), false, JSON.stringify(first.events));
    const firstSession = asObject(d(first.events.find((event) => event.event === 'done')?.payload).session);
    const firstMessages = asObjectArray(firstSession.messages);
    const fetchStep = firstMessages.find((message) =>
      message.kind === 'assistant_tool_call'
      && String(message.toolCallCommand || '') === 'web_fetch url="https://oldschool.runescape.wiki/w/Iron_bar"'
    );
    assert.ok(fetchStep, JSON.stringify(firstMessages));
    assert.match(String(fetchStep.toolCallOutput || ''), /Iron bars are used in Smithing and quests/u);
    assert.equal(fetchStep.toolCallExitCode, 0);

    const second = await requestSse(`${baseUrl}/dashboard/chat/sessions/${sessionId}/messages/stream`, {
      method: 'POST',
      timeoutMs: DASHBOARD_CHAT_STREAM_TIMEOUT_MS,
      body: JSON.stringify({
        content: 'Repeat the exact fetched evidence from the page.',
        webSearchOverride: 'on',
        availableModels: ['mock'],
        model: 'mock',
        mockResponses: [
          { content: "The fetched page text said: Iron bars are used in Smithing and quests." },
        ],
      }),
    });

    assert.equal(second.statusCode, 200);
    assert.equal(second.events.some((event) => event.event === 'error'), false, JSON.stringify(second.events));
    assert.equal(second.events.some((event) => event.event === 'tool_start'), false, JSON.stringify(second.events));
    const secondSession = asObject(d(second.events.find((event) => event.event === 'done')?.payload).session);
    const secondMessages = asObjectArray(secondSession.messages);
    const answers = asObjectArray(secondMessages.filter((message) => message.kind === 'assistant_answer'));
    const answer = answers.at(-1);
    assert.match(String(answer?.content || ''), /Iron bars are used in Smithing and quests/u);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('deleting retained web tool step allows the same web call in a later chat turn', async () => {
  const tempRoot = createManagedTempDir('siftkit-dashboard-web-delete-dedupe-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const config = getDefaultConfig();
  config.WebSearch = usableWebSearchConfig();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  writeConfig(getConfigPath(), config);

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const created = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Web delete dedupe' }),
    });
    const sessionId = String(d(created.body.session).id);

    const first = await requestSse(`${baseUrl}/dashboard/chat/sessions/${sessionId}/messages/stream`, {
      method: 'POST',
      timeoutMs: DASHBOARD_CHAT_STREAM_TIMEOUT_MS,
      body: JSON.stringify({
        content: 'Current GE price of an iron bar?',
        webSearchOverride: 'on',
        availableModels: ['mock'],
        model: 'mock',
        mockResponses: [
          { toolCalls: [{ name: "web_search", arguments: {"query":"iron bar GE price"} }] },
          { toolCalls: [{ name: "web_fetch", arguments: {"url":"https://prices.runescape.wiki/iron-bar"} }] },
          { content: "About 150 gp per bar." },
        ],
        mockCommandResults: {
          'web_search query="iron bar GE price"': {
            exitCode: 0,
            stdout: '1. GE\nURL: https://prices.runescape.wiki/iron-bar\nSnippet: iron bar price\nSource: tavily',
          },
          'web_fetch url="https://prices.runescape.wiki/iron-bar"': {
            exitCode: 0,
            stdout: 'Fetched source: iron bar current price is about 150 gp per bar.',
          },
        },
      }),
    });
    assert.equal(first.statusCode, 200);
    const firstSession = asObject(d(first.events.find((event) => event.event === 'done')?.payload).session);
    const searchStep = (asObjectArray(firstSession.messages)).find((message) =>
      message.kind === 'assistant_tool_call'
      && String(message.toolCallCommand || '') === 'web_search query="iron bar GE price"'
    );
    assert.equal(typeof searchStep?.id, 'string');

    const deleteResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/messages/${searchStep?.id}`, {
      method: 'DELETE',
      timeoutMs: 3000,
    });
    assert.equal(deleteResponse.statusCode, 200);

    const second = await requestSse(`${baseUrl}/dashboard/chat/sessions/${sessionId}/messages/stream`, {
      method: 'POST',
      timeoutMs: DASHBOARD_CHAT_STREAM_TIMEOUT_MS,
      body: JSON.stringify({
        content: 'Check that price again.',
        webSearchOverride: 'on',
        availableModels: ['mock'],
        model: 'mock',
        mockResponses: [
          { toolCalls: [{ name: "web_search", arguments: {"query":"iron bar GE price"} }] },
          { toolCalls: [{ name: "web_fetch", arguments: {"url":"https://prices.runescape.wiki/iron-bar-live"} }] },
          { content: "About 151 gp per bar." },
        ],
        mockCommandResults: {
          'web_fetch url="https://prices.runescape.wiki/iron-bar-live"': {
            exitCode: 0,
            stdout: 'Fetched source: iron bar current price is about 151 gp per bar.',
          },
        },
      }),
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.events.some((event) => event.event === 'error'), false, JSON.stringify(second.events));
    const secondSession = asObject(d(second.events.find((event) => event.event === 'done')?.payload).session);
    const secondMessages = asObjectArray(secondSession.messages);
    assert.equal(secondMessages.some((message) => /already searched/u.test(String(message.toolCallOutput || ''))), false);
    const repeatedSearchStep = secondMessages.find((message) =>
      message.kind === 'assistant_tool_call'
      && String(message.toolCallCommand || '') === 'web_search query="iron bar GE price"'
    );
    assert.equal(Number(repeatedSearchStep?.toolCallExitCode), 0);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('package start script launches the dedicated dual-server start runner', () => {
  const packageJsonPath = path.resolve(SIFTKIT_REPO_ROOT, 'package.json');
  const packageJson = asObject(parseJsonValueText(fs.readFileSync(packageJsonPath, 'utf8')));
  const scripts = asObject(packageJson.scripts);
  assert.equal(typeof scripts.start, 'string');
  assert.match(String(scripts.start || ''), /scripts[\\/]+start-dev\.(ts|js)/u);
});

test('repo-search and dashboard chat messages serialize by waiting', async () => {
  const tempRoot = createManagedTempDir('siftkit-dashboard-lock-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const createSession = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Locked session',
        model: 'Qwen3.5-9B-Q8_0.gguf',
        contextWindowTokens: 10000,
      }),
    });
    const sessionId = String(d(createSession.body.session).id);

    const delayedRepoSearch = requestSse(`${baseUrl}/repo-search`, {
      method: 'POST',
      timeoutMs: 6000,
      body: JSON.stringify({
        prompt: 'find x',
        repoRoot: process.cwd(),
        model: 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf',
        maxTurns: 1,
        simulateWorkMs: 80,
        availableModels: ['Qwen3.5-35B-A3B-UD-Q4_K_L.gguf'],
        mockResponses: [
          { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"x","path":"src"} }] },
          { content: "done" },
        ],
        mockCommandResults: {
          "git operation=\"grep\" path=\"src\" pattern=\"x\"": { exitCode: 0, stdout: 'src/example.ts:1:x', stderr: '', delayMs: 160 },
        },
      }),
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    const blockedChatStart = Date.now();
    const blockedChat = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      timeoutMs: 3000,
      body: JSON.stringify({
        content: 'should wait while repo-search is running',
        assistantContent: 'stored assistant response',
      }),
    });
    const blockedChatElapsedMs = Date.now() - blockedChatStart;
    assert.equal(blockedChat.statusCode, 200);
    assert.equal(blockedChatElapsedMs >= 50, true);

    await delayedRepoSearch;
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('same session rejects a second request instead of entering the model FIFO', async () => {
  const tempRoot = createManagedTempDir('siftkit-dashboard-fifo-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const createSession = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'FIFO session',
        model: 'Qwen3.5-9B-Q8_0.gguf',
      }),
    });
    const sessionId = String(d(createSession.body.session).id);
    const delayedRepoSearch = requestSse(`${baseUrl}/repo-search`, {
      method: 'POST',
      timeoutMs: 6000,
      body: JSON.stringify({
        prompt: 'hold lock',
        repoRoot: process.cwd(),
        model: 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf',
        maxTurns: 1,
        simulateWorkMs: 80,
        availableModels: ['Qwen3.5-35B-A3B-UD-Q4_K_L.gguf'],
        mockResponses: [
          { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"x","path":"src"} }] },
          { content: "done" },
        ],
        mockCommandResults: {
          "git operation=\"grep\" path=\"src\" pattern=\"x\"": { exitCode: 0, stdout: 'src/example.ts:1:x', stderr: '', delayMs: 160 },
        },
      }),
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    const queuedB = requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      timeoutMs: 3000,
      body: JSON.stringify({
        content: 'fifo-b',
        assistantContent: 'assistant-b',
      }),
    });
    let firstSessionRequestQueued = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await requestJson(`${baseUrl}/status`);
      const queuedRequests = asObjectArray(d(status.body.modelRequests).queuedRequests);
      for (const queuedRequest of queuedRequests) {
        if (queuedRequest.kind === 'dashboard_chat') {
          firstSessionRequestQueued = true;
          break;
        }
      }
      if (firstSessionRequestQueued) break;
      await delay(10);
    }
    assert.equal(firstSessionRequestQueued, true);
    const queuedC = requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      timeoutMs: 3000,
      body: JSON.stringify({
        content: 'fifo-c',
        assistantContent: 'assistant-c',
      }),
    });

    const [repoResult, bResult, cResult] = await Promise.all([delayedRepoSearch, queuedB, queuedC]);
    assert.equal(repoResult.statusCode, 200);
    assert.equal(bResult.statusCode, 200);
    assert.equal(cResult.statusCode, 409);
    assert.equal(cResult.body.sessionId, sessionId);
    assert.equal(cResult.body.operationKind, 'message');

    const sessionResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}`);
    const messages = asArray(d(d(sessionResponse.body).session).messages);
    const userContents = messages
      .map((entry) => d(entry))
      .filter((entry) => entry.role === 'user')
      .map((entry) => String(entry.content || ''));
    assert.deepEqual(userContents.slice(-1), ['fifo-b']);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('same session conflicts cover message plan and repo-search JSON and SSE routes', async () => {
  const harness = new DashboardModelQueueHarness('siftkit-dashboard-session-conflicts-', { parallelSlots: 1 });
  await harness.start();
  try {
    const messageSessionId = await harness.createChatSession('Message owner', 'Qwen3.5-9B-Q8_0.gguf');
    const planSessionId = await harness.createChatSession('Plan owner', 'Qwen3.5-9B-Q8_0.gguf');
    const repoSearchSessionId = await harness.createChatSession('Repo owner', 'Qwen3.5-9B-Q8_0.gguf');
    const baseUrl = harness.getBaseUrl();
    const lockHolder = harness.holdModelLock('hold session-conflict matrix', 600);
    await harness.waitForActiveRequests('repo_search');

    const activeMessage = fireAndAbortJsonRequest(
      `${baseUrl}/dashboard/chat/sessions/${messageSessionId}/messages`,
      JSON.stringify({ content: 'active message', assistantContent: 'done' }),
      500,
    );
    const activePlan = fireAndAbortJsonRequest(
      `${baseUrl}/dashboard/chat/sessions/${planSessionId}/plan`,
      JSON.stringify({ content: 'active plan', repoRoot: process.cwd() }),
      500,
    );
    const activeRepoSearch = fireAndAbortJsonRequest(
      `${baseUrl}/dashboard/chat/sessions/${repoSearchSessionId}/repo-search`,
      JSON.stringify({ content: 'active repo search', repoRoot: process.cwd() }),
      500,
    );
    await harness.waitForQueuedRequest('dashboard_chat');
    await harness.waitForQueuedRequest('dashboard_plan');
    await harness.waitForQueuedRequest('dashboard_repo_search');

    const activeSessions = [
      { sessionId: messageSessionId, operationKind: 'message' },
      { sessionId: planSessionId, operationKind: 'plan' },
      { sessionId: repoSearchSessionId, operationKind: 'repo-search' },
    ] as const;
    const conflictRoutes = [
      { suffix: 'messages', body: { content: 'conflict', assistantContent: 'blocked' } },
      { suffix: 'messages/stream', body: { content: 'conflict' } },
      { suffix: 'plan', body: { content: 'conflict', repoRoot: process.cwd() } },
      { suffix: 'plan/stream', body: { content: 'conflict', repoRoot: process.cwd() } },
      { suffix: 'repo-search', body: { content: 'conflict', repoRoot: process.cwd() } },
      { suffix: 'repo-search/stream', body: { content: 'conflict', repoRoot: process.cwd() } },
    ] as const;

    for (const activeSession of activeSessions) {
      for (const conflictRoute of conflictRoutes) {
        const response = await requestJson(
          `${baseUrl}/dashboard/chat/sessions/${activeSession.sessionId}/${conflictRoute.suffix}`,
          { method: 'POST', body: JSON.stringify(conflictRoute.body) },
        );
        assert.equal(response.statusCode, 409);
        assert.equal(response.body.sessionId, activeSession.sessionId);
        assert.equal(response.body.operationKind, activeSession.operationKind);
      }
    }

    await Promise.all([lockHolder, activeMessage, activePlan, activeRepoSearch]);
  } finally {
    await harness.close();
  }
});

test('queued model request is dropped when client disconnects before lock grant', async () => {
  const tempRoot = createManagedTempDir('siftkit-dashboard-queue-disconnect-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const createSession = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Disconnect queue session',
        model: 'Qwen3.5-9B-Q8_0.gguf',
      }),
    });
    const sessionId = String(d(createSession.body.session).id);

    const delayedRepoSearch = requestSse(`${baseUrl}/repo-search`, {
      method: 'POST',
      timeoutMs: 3000,
      body: JSON.stringify({
        prompt: 'hold lock for disconnect test',
        repoRoot: process.cwd(),
        model: 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf',
        maxTurns: 1,
        simulateWorkMs: 80,
        availableModels: ['Qwen3.5-35B-A3B-UD-Q4_K_L.gguf'],
        mockResponses: [
          { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"x","path":"src"} }] },
          { content: "done" },
        ],
        mockCommandResults: {
          "git operation=\"grep\" path=\"src\" pattern=\"x\"": { exitCode: 0, stdout: 'src/example.ts:1:x', stderr: '', delayMs: 160 },
        },
      }),
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    await fireAndAbortJsonRequest(
      `${baseUrl}/dashboard/chat/sessions/${sessionId}/messages`,
      JSON.stringify({
        content: 'dropped-request',
        assistantContent: 'should-not-be-saved',
      }),
      25,
    );

    const survivorResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      timeoutMs: 3000,
      body: JSON.stringify({
        content: 'survivor-request',
        assistantContent: 'saved',
      }),
    });
    assert.equal(survivorResponse.statusCode, 200);
    await delayedRepoSearch;

    const sessionResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}`);
    const messages = asArray(d(d(sessionResponse.body).session).messages);
    const userContents = messages
      .map((entry) => d(entry))
      .filter((entry) => entry.role === 'user')
      .map((entry) => String(entry.content || ''));
    assert.equal(userContents.includes('dropped-request'), false);
    assert.equal(userContents.includes('survivor-request'), true);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('queued JSON Plan returns 404 when its session disappears before lock grant', async () => {
  const harness = new DashboardModelQueueHarness('siftkit-dashboard-plan-session-race-', { parallelSlots: 1 });
  try {
    await harness.start();
    const baseUrl = harness.getBaseUrl();
    const sessionId = await harness.createChatSession(
      'Queued Plan session',
      'Qwen3.5-9B-Q8_0.gguf',
    );
    const delayedRepoSearch = harness.holdModelLock(
      'hold lock while queued Plan loses its session',
      250,
    );
    await harness.waitForActiveRequests('repo_search');

    const queuedPlan = requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/plan`, {
      method: 'POST',
      timeoutMs: 6_000,
      body: JSON.stringify({
        content: 'plan after queued session deletion',
        repoRoot: process.cwd(),
        maxTurns: 1,
        availableModels: ['Qwen3.5-9B-Q8_0.gguf'],
        mockResponses: [{ content: "must not run" }],
        mockCommandResults: {},
      }),
    });
    await harness.waitForQueuedRequest('dashboard_plan');

    const deleteResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}`, {
      method: 'DELETE',
    });
    assert.equal(deleteResponse.statusCode, 200);

    const [holderResponse, planResponse] = await Promise.all([delayedRepoSearch, queuedPlan]);
    assert.equal(holderResponse.statusCode, 200);
    assert.equal(planResponse.statusCode, 404);
    assert.equal(planResponse.body.error, 'Session not found.');

    const deletedSessionResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}`);
    assert.equal(deletedSessionResponse.statusCode, 404);
  } finally {
    await harness.close();
  }
});

test('queued Repo Search disconnect leaves the chat session unchanged', async () => {
  const harness = new DashboardModelQueueHarness('siftkit-dashboard-repo-search-disconnect-', { parallelSlots: 1 });
  try {
    await harness.start();
    const baseUrl = harness.getBaseUrl();
    const sessionId = await harness.createChatSession(
      'Queued Repo Search session',
      'Qwen3.5-9B-Q8_0.gguf',
    );
    const createdSessionResponse = await requestJson(
      `${baseUrl}/dashboard/chat/sessions/${sessionId}`,
    );
    assert.equal(createdSessionResponse.statusCode, 200);
    const createdSession = d(createdSessionResponse.body.session);
    const delayedRepoSearch = harness.holdModelLock(
      'hold lock while queued Repo Search disconnects',
      600,
    );
    await harness.waitForActiveRequests('repo_search');

    const disconnectedRepoSearch = fireAndAbortJsonRequest(
      `${baseUrl}/dashboard/chat/sessions/${sessionId}/repo-search/stream`,
      JSON.stringify({
        content: 'must not persist after disconnect',
        repoRoot: process.cwd(),
        maxTurns: 1,
        availableModels: ['Qwen3.5-9B-Q8_0.gguf'],
        mockResponses: [{ content: "must not run" }],
        mockCommandResults: {},
      }),
      250,
    );
    await harness.waitForQueuedRequest('dashboard_repo_search_stream');
    await disconnectedRepoSearch;

    const holderResponse = await delayedRepoSearch;
    assert.equal(holderResponse.statusCode, 200);
    await harness.waitForModelQueueIdle();

    const sessionResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}`);
    assert.equal(sessionResponse.statusCode, 200);
    const persistedSession = d(sessionResponse.body.session);
    assert.equal(persistedSession.presetId, createdSession.presetId);
    assert.equal(persistedSession.mode, createdSession.mode);
    assert.deepEqual(asArray(persistedSession.messages), asArray(createdSession.messages));
  } finally {
    await harness.close();
  }
});

test('invalid model request is rejected without waiting for active model work', async () => {
  const tempRoot = createManagedTempDir('siftkit-dashboard-validate-first-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const createSession = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Validate-first session',
        model: 'Qwen3.5-9B-Q8_0.gguf',
      }),
    });
    const sessionId = String(d(createSession.body.session).id);

    const delayedRepoSearch = requestSse(`${baseUrl}/repo-search`, {
      method: 'POST',
      timeoutMs: 3000,
      body: JSON.stringify({
        prompt: 'hold lock for validation test',
        repoRoot: process.cwd(),
        model: 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf',
        maxTurns: 1,
        simulateWorkMs: 80,
        availableModels: ['Qwen3.5-35B-A3B-UD-Q4_K_L.gguf'],
        mockResponses: [
          { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"x","path":"src"} }] },
          { content: "done" },
        ],
        mockCommandResults: {
          "git operation=\"grep\" path=\"src\" pattern=\"x\"": { exitCode: 0, stdout: 'src/example.ts:1:x', stderr: '', delayMs: 160 },
        },
      }),
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    const startedAt = Date.now();
    const invalidResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      timeoutMs: 3000,
      body: JSON.stringify({}),
    });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(invalidResponse.statusCode, 400);
    assert.equal(elapsedMs < 250, true);
    await delayedRepoSearch;
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('plan endpoint rejects missing or invalid repo root', async () => {
  const tempRoot = createManagedTempDir('siftkit-dashboard-plan-root-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const createSession = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Plan Session',
        model: 'Qwen3.5-9B-Q8_0.gguf',
      }),
    });
    const sessionId = String(d(createSession.body.session).id);
    const missingRootResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/plan`, {
      method: 'POST',
      body: JSON.stringify({
        content: 'create plan',
        repoRoot: path.join(tempRoot, 'missing'),
      }),
    });
    assert.equal(missingRootResponse.statusCode, 400);
    assert.match(String(missingRootResponse.body.error || ''), /Expected existing repoRoot directory/u);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('chat session create and update reject unknown preset ids without persisting them', async () => {
  const tempRoot = createManagedTempDir('siftkit-dashboard-strict-preset-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const runtimeRoot = path.join(tempRoot, '.siftkit');
  const statusPath = path.join(runtimeRoot, 'status', 'inference.txt');
  const configPath = path.join(runtimeRoot, 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const unknownCreate = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Unknown preset',
        presetId: 'missing-preset',
      }),
    });
    assert.equal(unknownCreate.statusCode >= 400, true);
    assert.equal(
      readChatSessions(runtimeRoot).some((session) => session.presetId === 'missing-preset'),
      false,
    );

    const createSession = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Valid preset' }),
    });
    assert.equal(createSession.statusCode, 200);
    const sessionId = String(d(createSession.body.session).id);

    const unknownUpdate = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}`, {
      method: 'PUT',
      body: JSON.stringify({ presetId: 'missing-preset' }),
    });
    assert.equal(unknownUpdate.statusCode >= 400, true);
    const persisted = readChatSessions(runtimeRoot).find((session) => session.id === sessionId);
    assert.ok(persisted);
    assert.notEqual(persisted.presetId, 'missing-preset');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('chat completion replays prior tool evidence without hidden system context', async () => {
  const tempRoot = createManagedTempDir('siftkit-dashboard-toolctx-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  let capturedChatRawBody = '';
  const llamaServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'Qwen3.5-9B-Q8_0.gguf' }] }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.statusCode = 404;
      res.end();
      return;
    }
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
    });
    req.on('end', () => {
      capturedChatRawBody = raw;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream');
      res.write("data: {\"choices\":[{\"delta\":{\"content\":\"ack\"}}]}\n\n");
      res.write("data: {\"choices\":[{\"delta\":{}}],\"usage\":{\"prompt_tokens\":20,\"completion_tokens\":4,\"completion_tokens_details\":{\"reasoning_tokens\":0}}}\n\n");
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    llamaServer.listen(0, '127.0.0.1', (error?: Error) => (error ? reject(error) : resolve()));
  });
  const llamaAddress = getAddressInfo(llamaServer);

  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const chatConfig = getDefaultConfig();
  const chatPreset = chatConfig.Server.ModelPresets.Presets;
  chatPreset[0].Model = 'Qwen3.5-9B-Q8_0.gguf';
  chatPreset[0].BaseUrl = `http://127.0.0.1:${llamaAddress.port}`;
  chatPreset[0].NumCtx = 85000;
  chatConfig.Presets = chatConfig.Presets.map((preset) => ({
    ...preset,
    promptPrefix: 'UNIQUE_PRESET_PREFIX',
  }));
  writeConfig(getConfigPath(), chatConfig);

  const server = startStatusServer({ disableManagedLlamaStartup: true, terminalMetadataIdleDelayMs: 0 });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const createSession = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Tool Context Session',
        model: 'Qwen3.5-9B-Q8_0.gguf',
      }),
    });
    const sessionId = String(d(createSession.body.session).id);
    const planMessage = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/plan`, {
      method: 'POST',
      timeoutMs: 3000,
      body: JSON.stringify({
        content: 'audit release gaps',
        repoRoot: tempRoot,
        maxTurns: 1,
        availableModels: ['Qwen3.5-35B-A3B-UD-Q4_K_L.gguf'],
        mockResponses: [
          { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"name","path":"package.json"} }] },
          { content: "done" },
        ],
        mockCommandResults: {
          "git operation=\"grep\" path=\"package.json\" pattern=\"name\"": { exitCode: 0, stdout: 'package.json:2:  "name": "siftkit"', stderr: '' },
        },
      }),
    });
    assert.equal(planMessage.statusCode, 200);
    const planSession = d(planMessage.body.session);
    const planToolMessage = (asObjectArray(planSession.messages)).find((message) => message.kind === 'assistant_tool_call');
    assert.match(String(planToolMessage?.toolCallCommand || ''), /git operation="grep" path="package\.json" pattern="name"/u);
    assert.match(String(planToolMessage?.toolCallOutput || ''), /"name": "siftkit"/u);
    const persistedPlanSession = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}`);
    const persistedToolMessage = (asObjectArray(d(persistedPlanSession.body.session).messages)).find((message) => message.kind === 'assistant_tool_call');
    assert.match(String(persistedToolMessage?.toolCallCommand || ''), /git operation="grep" path="package\.json" pattern="name"/u);
    assert.match(String(persistedToolMessage?.toolCallOutput || ''), /"name": "siftkit"/u);

    const chatReply = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      timeoutMs: 3000,
      body: JSON.stringify({
        content: 'use prior evidence and summarize next steps',
      }),
    });
    assert.equal(chatReply.statusCode, 200);
    const chatSession = d(chatReply.body.session);
    assert.equal(chatSession.presetId, 'chat');
    assert.equal(chatSession.mode, 'chat');
    const sourceRunIds = (asObjectArray(chatSession.messages))
      .filter((message) => message.role === 'assistant' && message.content === 'ack')
      .map((message) => String(message.sourceRunId || '').trim());
    assert.equal(sourceRunIds.length, 1);
    assert.ok(sourceRunIds.every((runId) => runId.length > 0));
    assert.equal(new Set(sourceRunIds).size, 1);
    // sourceRunId is what message deletion uses to purge the matching run-log command,
    // so it has to be the engine run id the run rows are keyed by, not a route-local id.
    const chatRunId = sourceRunIds[0] || '';
    await runtimeHelpers.waitForAsyncExpectation(async () => {
      const chatRunDetail = await requestJson(`${baseUrl}/dashboard/runs/${encodeURIComponent(chatRunId)}`);
      assert.equal(chatRunDetail.statusCode, 200, `chat sourceRunId ${chatRunId} resolves to no run`);
    }, 5000);
    // Poll on the `chat` bucket, not just the global totals: the earlier plan request already
    // pushed the global counters past these thresholds, so waiting on the global pair can return
    // before the chat request's own tokens have been recorded and leave the per-task assertions
    // racing it. A returned poll is the assertion — repeating it afterwards proves nothing.
    await runtimeHelpers.waitForAsyncExpectation(async () => {
      const statusAfterChat = await requestJson(`${baseUrl}/status`);
      const statusMetrics = d(statusAfterChat.body.metrics);
      assert.equal(Number(statusMetrics.inputTokensTotal) >= 20, true);
      assert.equal(Number(statusMetrics.outputTokensTotal) >= 1, true);
      assert.equal(Number(d(d(statusMetrics.taskTotals).chat).inputTokensTotal) >= 20, true);
      assert.equal(Number(d(d(statusMetrics.taskTotals).chat).outputTokensTotal) >= 1, true);
    }, 5000);
    assert.notEqual(capturedChatRawBody, '');
    const captured = asObject(parseJsonValueText(capturedChatRawBody));
    assert.equal(Array.isArray(captured.messages), true);
    const systemMessages = asObjectArray(captured.messages).filter((message) => message && message.role === 'system');
    const systemText = systemMessages.map((message) => String(message.content || '')).join('\n');
    assert.equal(systemText.match(/UNIQUE_PRESET_PREFIX/gu)?.length, 1);
    assert.equal(systemMessages.some((message) => String(message.content || '').includes('Internal tool-call context from prior session steps.')), false);
    assert.equal(asObjectArray(captured.messages).some((message) =>
      message.role === 'assistant'
      && Array.isArray(message.tool_calls)
      && String(asObject(asObject(asArray(message.tool_calls)[0]).function).arguments || '').includes('"operation":"grep"')
    ), true);
    assert.equal(asObjectArray(captured.messages).some((message) =>
      message.role === 'tool'
      && String(message.content || '').includes('"name": "siftkit"')
    ), true);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      llamaServer.close((error) => (error ? reject(error) : resolve()));
    });
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('non-streaming chat message runs against the session model preset snapshot', async () => {
  const tempRoot = createManagedTempDir('siftkit-dashboard-snapshot-cfg-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  let capturedChatRawBody = '';
  const llamaServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'snapshot-model.gguf' }, { id: 'live-model.gguf' }] }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.statusCode = 404;
      res.end();
      return;
    }
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
    });
    req.on('end', () => {
      capturedChatRawBody = raw;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream');
      res.write("data: {\"choices\":[{\"delta\":{\"content\":\"ack\"}}]}\n\n");
      res.write("data: {\"choices\":[{\"delta\":{}}],\"usage\":{\"prompt_tokens\":20,\"completion_tokens\":4,\"completion_tokens_details\":{\"reasoning_tokens\":0}}}\n\n");
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    llamaServer.listen(0, '127.0.0.1', (error?: Error) => (error ? reject(error) : resolve()));
  });
  const llamaAddress = getAddressInfo(llamaServer);

  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const snapshotConfig = getDefaultConfig();
  const snapshotPreset = snapshotConfig.Server.ModelPresets.Presets[0];
  snapshotPreset.Model = 'snapshot-model.gguf';
  snapshotPreset.BaseUrl = `http://127.0.0.1:${llamaAddress.port}`;
  snapshotPreset.NumCtx = 85000;
  snapshotPreset.Temperature = 0.31;
  writeConfig(getConfigPath(), snapshotConfig);

  const server = startStatusServer({ disableManagedLlamaStartup: true, terminalMetadataIdleDelayMs: 0 });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const createSession = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Snapshot Session' }),
    });
    assert.equal(createSession.statusCode, 200);
    const sessionId = String(d(createSession.body.session).id);

    // Swap the live active preset after the session snapshotted preset 'default':
    // the turn below must still run with the snapshot's model and samplers.
    const currentConfig = await requestJson(`${baseUrl}/config?skip_ready=1`);
    assert.equal(currentConfig.statusCode, 200);
    const updated = d(structuredClone(currentConfig.body));
    const modelPresets = d(d(updated.Server).ModelPresets);
    const basePreset = d(asObjectArray(modelPresets.Presets)[0]);
    modelPresets.Presets = [
      basePreset,
      { ...basePreset, id: 'live', label: 'Live', Model: 'live-model.gguf', Temperature: 0.94, Port: Number(basePreset.Port) + 1 },
    ];
    modelPresets.ActivePresetId = 'live';
    const putResponse = await requestJson(`${baseUrl}/config?skip_ready=1`, {
      method: 'PUT',
      body: JSON.stringify(updated),
    });
    assert.equal(putResponse.statusCode, 200);

    const chatReply = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      timeoutMs: 5000,
      body: JSON.stringify({ content: 'which preset drives this turn?' }),
    });
    assert.equal(chatReply.statusCode, 200);
    assert.notEqual(capturedChatRawBody, '');
    const captured = asObject(parseJsonValueText(capturedChatRawBody));
    assert.equal(captured.model, 'snapshot-model.gguf');
    assert.equal(captured.temperature, 0.31);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      llamaServer.close((error) => (error ? reject(error) : resolve()));
    });
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('deleting a tool bubble removes chat context and rewrites run detail', async () => {
  const tempRoot = createManagedTempDir('siftkit-dashboard-delete-bubble-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  let capturedChatRawBody = '';
  const llamaServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'Qwen3.5-9B-Q8_0.gguf' }] }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.statusCode = 404;
      res.end();
      return;
    }
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
    });
    req.on('end', () => {
      capturedChatRawBody = raw;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write("data: {\"choices\":[{\"delta\":{\"content\":\"ack\"}}]}\n\n");
      res.write("data: {\"choices\":[{\"delta\":{}}],\"usage\":{\"prompt_tokens\":30,\"completion_tokens\":4}}\n\n");
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    llamaServer.listen(0, '127.0.0.1', (error?: Error) => (error ? reject(error) : resolve()));
  });
  const llamaAddress = getAddressInfo(llamaServer);

  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const chatConfig = getDefaultConfig();
  const chatPreset = chatConfig.Server.ModelPresets.Presets;
  chatPreset[0].Model = 'Qwen3.5-9B-Q8_0.gguf';
  chatPreset[0].BaseUrl = `http://127.0.0.1:${llamaAddress.port}`;
  chatPreset[0].NumCtx = 85000;
  writeConfig(getConfigPath(), chatConfig);

  const server = startStatusServer({ disableManagedLlamaStartup: true, terminalMetadataIdleDelayMs: 0 });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const createSession = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Delete Bubble Session',
        model: 'Qwen3.5-9B-Q8_0.gguf',
      }),
    });
    const sessionId = String(d(createSession.body.session).id);

    const repoMessage = await requestSse(`${baseUrl}/dashboard/chat/sessions/${sessionId}/repo-search/stream`, {
      method: 'POST',
      timeoutMs: 3000,
      body: JSON.stringify({
        content: 'Find package name',
        repoRoot: tempRoot,
        maxTurns: 1,
        availableModels: ['Qwen3.5-35B-A3B-UD-Q4_K_L.gguf'],
        mockResponses: [
          { toolCalls: [{ name: "git", arguments: {"operation":"grep","pattern":"name","path":"package.json"} }] },
          { content: "done" },
        ],
        mockCommandResults: {
          "git operation=\"grep\" path=\"package.json\" pattern=\"name\"": { exitCode: 0, stdout: 'package.json:2:  "name": "siftkit"', stderr: '' },
        },
      }),
    });
    assert.equal(repoMessage.statusCode, 200);
    const repoDonePayload = d(repoMessage.events.find((event) => event.event === 'done')?.payload);
    const repoSession = d(repoDonePayload.session);
    const toolMessage = (asObjectArray(repoSession.messages)).find((message) => message.kind === 'assistant_tool_call');
    assert.equal(typeof toolMessage?.id, 'string');
    assert.match(String(toolMessage?.toolCallCommand || ''), /^git operation="grep" path="package\.json" pattern="name"/u);
    assert.equal(String(toolMessage?.toolCallOutput || '').includes('"name": "siftkit"'), true);
    const runId = String(toolMessage?.sourceRunId || '');
    const storedCommandText = String(toolMessage?.toolCallCommand || '');

    const detailBefore = await requestJson(`${baseUrl}/dashboard/runs/${encodeURIComponent(runId)}`);
    assert.equal(detailBefore.statusCode, 200);
    assert.equal(
      buildRepoSearchChatSteps(toRunEvents(d(detailBefore.body).events)).some((step) => step.command === storedCommandText),
      true,
    );

    const deleteResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/messages/${toolMessage?.id}`, {
      method: 'DELETE',
      timeoutMs: 3000,
    });
    assert.equal(deleteResponse.statusCode, 200);
    const deletedSession = d(deleteResponse.body.session);
    assert.equal((asObjectArray(deletedSession.messages)).some((message) => message.id === toolMessage?.id), false);

    const detailAfter = await requestJson(`${baseUrl}/dashboard/runs/${encodeURIComponent(runId)}`);
    assert.equal(detailAfter.statusCode, 200);
    assert.equal(
      buildRepoSearchChatSteps(toRunEvents(d(detailAfter.body).events)).some((step) => step.command === storedCommandText),
      false,
    );

    const chatReply = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      timeoutMs: 3000,
      body: JSON.stringify({
        content: 'use prior evidence',
      }),
    });
    assert.equal(chatReply.statusCode, 200);
    assert.notEqual(capturedChatRawBody, '');
    const captured = asObject(parseJsonValueText(capturedChatRawBody));
    assert.equal(Array.isArray(captured.messages), true);
    const capturedText = (asObjectArray(captured.messages)).map((message) => String(message.content || '')).join('\n');
    assert.equal(capturedText.includes("git operation=\"grep\" path=\"package.json\" pattern=\"name\""), false);
    assert.equal(capturedText.includes('"name": "siftkit"'), false);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      llamaServer.close((error) => (error ? reject(error) : resolve()));
    });
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});

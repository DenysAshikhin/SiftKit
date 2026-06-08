import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';

import { startStatusServer } from '../dist/status-server/index.js';
import { writeConfig, getDefaultConfig } from '../dist/status-server/config-store.js';
import { getConfigPath } from '../dist/config/index.js';
import { closeRuntimeDatabase } from '../dist/state/runtime-db.js';
import {
  fireAndAbortJsonRequest,
  removeDirectoryWithRetries,
  requestJson,
  requestSse,
  type Dict,
  type JsonResponse,
  type RequestOptions,
  type SseEvent,
  type SseResponse,
  writeJson,
} from './helpers/dashboard-http.ts';
import { buildRepoSearchChatSteps } from '../dashboard/src/lib/chat-steps.ts';
import { normalizeWebSearchConfig } from '../src/status-server/config-store.js';

test('normalizeWebSearchConfig produces Brave defaults and clamps ResultCount to 20', () => {
  const normalized = normalizeWebSearchConfig({ ResultCount: 999, BraveApiKey: '  abc  ', SearxngBaseUrl: 'http://x' });
  assert.equal(normalized.Provider, 'brave');
  assert.equal(normalized.ResultCount, 20);
  assert.equal(normalized.BraveApiKey, 'abc');
  assert.equal('SearxngBaseUrl' in normalized, false);
});

test('normalizeWebSearchConfig defaults an empty Brave key', () => {
  const normalized = normalizeWebSearchConfig({});
  assert.equal(normalized.BraveApiKey, '');
  assert.equal(normalized.EnabledDefault, true);
});

const requireFromHere = createRequire(__filename);
const Database = requireFromHere('better-sqlite3') as new (path: string, options?: { readonly?: boolean }) => {
  prepare: (sql: string) => { all: (...args: unknown[]) => Dict[]; get: (...args: unknown[]) => Dict };
  close: () => void;
};
const runtimeHelpers = requireFromHere('./_runtime-helpers.js') as {
  writeManagedLlamaScripts: (tempRoot: string, port: number, modelId?: string) => {
    baseUrl: string;
    startupScriptPath: string;
    shutdownScriptPath: string;
    readyFilePath: string;
  };
  writeManagedLlamaLauncher: (tempRoot: string, port: number, modelId?: string) => {
    baseUrl: string;
    executablePath: string;
    modelPath: string;
    readyFilePath: string;
  };
  getFreePort: () => Promise<number>;
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

type HostConfigServer = {
  baseUrl: string;
  requestUrls: string[];
  close: () => Promise<void>;
};

function d(value: unknown): Dict {
  return (value || {}) as Dict;
}

const DASHBOARD_CHAT_STREAM_TIMEOUT_MS = 20_000;

function readRunLogRowCount(dbPath: string): number {
  const database = new Database(dbPath, { readonly: true });
  try {
    const row = database.prepare('SELECT COUNT(*) AS count FROM run_logs').get() as Dict;
    return Number(row.count || 0);
  } finally {
    database.close();
  }
}

function configureDashboardTestEnv(
  tempRoot: string,
  statusPath: string,
  configPath: string,
): Record<string, string | undefined> {
  const envBackup: Record<string, string | undefined> = {
    sift_kit_status: process.env.sift_kit_status,
    SIFTKIT_STATUS_PATH: process.env.SIFTKIT_STATUS_PATH,
    SIFTKIT_CONFIG_PATH: process.env.SIFTKIT_CONFIG_PATH,
    SIFTKIT_METRICS_PATH: process.env.SIFTKIT_METRICS_PATH,
    SIFTKIT_IDLE_SUMMARY_DB_PATH: process.env.SIFTKIT_IDLE_SUMMARY_DB_PATH,
    SIFTKIT_STATUS_HOST: process.env.SIFTKIT_STATUS_HOST,
    SIFTKIT_STATUS_PORT: process.env.SIFTKIT_STATUS_PORT,
    SIFTKIT_TERMINAL_METADATA_IDLE_DELAY_MS: process.env.SIFTKIT_TERMINAL_METADATA_IDLE_DELAY_MS,
  };
  process.env.sift_kit_status = statusPath;
  process.env.SIFTKIT_STATUS_PATH = statusPath;
  process.env.SIFTKIT_CONFIG_PATH = configPath;
  process.env.SIFTKIT_METRICS_PATH = path.join(tempRoot, '.siftkit', 'status', 'compression-metrics.json');
  process.env.SIFTKIT_IDLE_SUMMARY_DB_PATH = path.join(tempRoot, '.siftkit', 'status', 'idle-summary.sqlite');
  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';
  process.env.SIFTKIT_TERMINAL_METADATA_IDLE_DELAY_MS = '0';
  return envBackup;
}

function enterDashboardTestRepo(tempRoot: string): string {
  const previousCwd = process.cwd();
  fs.writeFileSync(
    path.join(tempRoot, 'package.json'),
    JSON.stringify({ name: 'siftkit', version: '0.1.0' }, null, 2),
    'utf8',
  );
  process.chdir(tempRoot);
  return previousCwd;
}

function restoreDashboardTestRepo(previousCwd: string): void {
  process.chdir(previousCwd);
  closeRuntimeDatabase();
}

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
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requestUrls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('config llama cpp test endpoint reports reachable external server', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-llama-test-route-'));
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const runtimeRoot = path.join(tempRoot, '.siftkit');
  const statusPath = path.join(runtimeRoot, 'status', 'inference.txt');
  const configPath = path.join(runtimeRoot, 'config.json');
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(statusPath, 'false', 'utf8');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const remotePort = await runtimeHelpers.getFreePort();
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
  const address = server.address() as AddressInfo;
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-llama-test-route-'));
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const runtimeRoot = path.join(tempRoot, '.siftkit');
  const statusPath = path.join(runtimeRoot, 'status', 'inference.txt');
  const configPath = path.join(runtimeRoot, 'config.json');
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(statusPath, 'false', 'utf8');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const unusedPort = await runtimeHelpers.getFreePort();
  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = server.address() as AddressInfo;
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-chat-host-context-'));
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const runtimeRoot = path.join(tempRoot, '.siftkit');
  const statusPath = path.join(runtimeRoot, 'status', 'inference.txt');
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(statusPath, 'false', 'utf8');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const host = await startHostConfigServer({
    Runtime: {
      Model: 'host-loaded-model.gguf',
      LlamaCpp: { NumCtx: 75_008, Reasoning: 'off' },
    },
  });
  const config = getDefaultConfig();
  const serverConfig = d(config.Server);
  const llamaServerConfig = d(serverConfig.LlamaCpp);
  const presets = llamaServerConfig.Presets as Dict[];
  const activePreset = d(presets[0]);
  activePreset.ExternalServerEnabled = true;
  activePreset.BaseUrl = host.baseUrl;
  activePreset.NumCtx = 150_000;
  activePreset.Model = 'local-stale-model.gguf';
  activePreset.Reasoning = 'on';
  writeConfig(configPath, config);

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = server.address() as AddressInfo;
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

test('dashboard endpoints expose runs, details, metrics, and chat sessions', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-dashboard-status-'));
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const runtimeRoot = path.join(tempRoot, '.siftkit');
  const statusPath = path.join(runtimeRoot, 'status', 'inference.txt');
  const configPath = path.join(runtimeRoot, 'config.json');
  const logsRoot = path.join(runtimeRoot, 'logs');
  const requestsRoot = path.join(logsRoot, 'requests');
  const failedRoot = path.join(logsRoot, 'failed');
  const abandonedRoot = path.join(logsRoot, 'abandoned');
  const repoSearchFailedRoot = path.join(logsRoot, 'repo_search', 'failed');
  const repoSearchPassRoot = path.join(logsRoot, 'repo_search', 'succesful');
  fs.mkdirSync(repoSearchPassRoot, { recursive: true });

  writeJson(path.join(requestsRoot, 'request_req-summary.json'), {
    requestId: 'req-summary',
    question: 'Summarize build output',
    backend: 'llama.cpp',
    model: 'Qwen3.5-9B-Q8_0.gguf',
    summary: 'Build was successful.',
    createdAtUtc: '2026-04-01T10:00:00.000Z',
    inputTokens: 123,
    outputTokens: 45,
    thinkingTokens: 9,
    promptCacheTokens: 80,
    promptEvalTokens: 40,
    speculativeAcceptedTokens: 18,
    speculativeGeneratedTokens: 24,
    requestDurationMs: 3000,
  });
  writeJson(path.join(logsRoot, 'planner_debug_req-summary.json'), {
    final: {
      finalOutput: 'Build was successful.',
      classification: 'summary',
      rawReviewRequired: false,
      providerError: null,
    },
  });
  writeJson(path.join(failedRoot, 'request_failed_req-failed.json'), {
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
  writeJson(path.join(abandonedRoot, 'request_abandoned_req-abandoned.json'), {
    requestId: 'req-abandoned',
    terminalState: 'failed',
    reason: 'Abandoned because a new request started before terminal status.',
    createdAtUtc: '2026-04-01T10:10:00.000Z',
    promptCharacterCount: 1200,
    outputTokensTotal: 12,
  });
  writeJson(path.join(repoSearchFailedRoot, 'request_req-repo.json'), {
    requestId: 'req-repo',
    prompt: 'find failing test',
    repoRoot: tempRoot,
    verdict: 'fail',
    totals: { commandsExecuted: 1 },
    createdAtUtc: '2026-04-01T10:15:00.000Z',
  });
  fs.writeFileSync(
    path.join(repoSearchFailedRoot, 'request_req-repo.jsonl'),
    [
      JSON.stringify({ at: '2026-04-01T10:15:01.000Z', kind: 'turn_new_messages', turn: 1, messages: [{ role: 'user', content: 'find failing test' }], promptTokenCount: 10 }),
      JSON.stringify({ at: '2026-04-01T10:15:02.000Z', kind: 'turn_model_response', text: '{"action":"finish"}', thinkingText: 'reasoning' }),
      JSON.stringify({ at: '2026-04-01T10:15:03.000Z', kind: 'run_done', scorecard: { verdict: 'fail' } }),
    ].join('\n') + '\n',
    'utf8',
  );

  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const health = await requestJson(`${baseUrl}/status`);
    assert.equal(health.statusCode, 200);

    const runsResponse = await requestJson(`${baseUrl}/dashboard/runs`);
    assert.equal(runsResponse.statusCode, 200);
    const runs = runsResponse.body.runs as Dict[];
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
    assert.equal((detailResponse.body.run as Dict).id, 'req-repo');
    const events = detailResponse.body.events as Dict[];
    assert.equal(Array.isArray(events), true);
    assert.equal(events.some((event) => event.kind === 'turn_model_response'), true);

    const metricsResponse = await requestJson(`${baseUrl}/dashboard/metrics/timeseries`);
    assert.equal(metricsResponse.statusCode, 200);
    const days = metricsResponse.body.days as Dict[];
    const taskDays = metricsResponse.body.taskDays as Dict[];
    const toolStats = metricsResponse.body.toolStats as Dict;
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
    const idleSummarySample = idleSummaryResponse.body.latest || idleSummaryResponse.body.snapshots[0] || {};
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
    assert.equal(session.contextWindowTokens, 150000);
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
    assert.equal((appendSession.messages as Dict[]).length, 2);
    const contextUsage = d(appendMessage.body.contextUsage);
    assert.equal(contextUsage.warnThresholdTokens, 15000);
    assert.equal(contextUsage.shouldCondense, false);

    const updateSession = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}`, {
      method: 'PUT',
      body: JSON.stringify({
        mode: 'plan',
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
          "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"dashboard\\\" .\"}",
          "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"/dashboard/chat/sessions\\\" siftKitStatus/index.js\"}",
          '{"action":"finish","output":"Plan: update dashboard/src/App.tsx and siftKitStatus/index.js; include a risks section for endpoint lock contention and stale repo-root paths."}',
        ],
        mockCommandResults: {
          'rg -n "dashboard" .': { exitCode: 0, stdout: 'dashboard/src/App.tsx:1:import { useEffect }', stderr: '' },
          'rg -n "/dashboard/chat/sessions" siftKitStatus/index.js': { exitCode: 0, stdout: 'siftKitStatus/index.js:3068:    if (req.method === \'POST\' && pathname === \'/dashboard/chat/sessions\') {', stderr: '' },
        },
      }),
    });
    assert.equal(planMessage.statusCode, 200);
    const planSession = d(planMessage.body.session);
    const planMessages = planSession.messages as Dict[];
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
    assert.equal(
      Number(latestMessage.inputTokensEstimate || 0),
      Number(repoTotals.promptTokens || 0),
    );
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
    const repoRunEvents = repoRunDetailResponse.body.events as Dict[];
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
      body: JSON.stringify({}),
    });
    assert.equal(condenseResponse.statusCode, 200);
    const condensedSession = d(condenseResponse.body.session);
    assert.equal(typeof condensedSession.condensedSummary, 'string');
    assert.match(String(condensedSession.condensedSummary), /stored assistant response/u);

    const sessionsResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions`);
    assert.equal(sessionsResponse.statusCode, 200);
    assert.equal((sessionsResponse.body.sessions as Dict[]).length, 1);

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
    assert.equal((sessionsAfterDelete.body.sessions as Dict[]).length, 0);
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
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('dashboard metrics expose line-read stats and prompt-baseline recommendations', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-dashboard-line-read-'));
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
      LlamaCpp: {
        BaseUrl: 'http://127.0.0.1:8080',
        NumCtx: 32000,
      },
    },
  }, null, 2));

  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);

  const server = startStatusServer({ disableManagedLlamaStartup: true, terminalMetadataIdleDelayMs: 0 });
  await server.startupPromise;
  const address = server.address() as AddressInfo;
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
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('web_search tool calls increment web search usage', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-dashboard-web-search-usage-'));
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(statusPath, 'false', 'utf8');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);

  const server = startStatusServer({ disableManagedLlamaStartup: true, terminalMetadataIdleDelayMs: 0 });
  await server.startupPromise;
  const address = server.address() as AddressInfo;
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-dashboard-stream-tokens-'));
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = server.address() as AddressInfo;
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

    const planSse = await requestSse(`${baseUrl}/dashboard/chat/sessions/${sessionId}/plan/stream`, {
      method: 'POST',
      timeoutMs: 3000,
      body: JSON.stringify({
        content: 'Add API tests',
        repoRoot: tempRoot,
        maxTurns: 1,
        availableModels: ['Qwen3.5-35B-A3B-UD-Q4_K_L.gguf'],
        mockResponses: [
          "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"test\\\" .\"}",
          '{"action":"finish","output":"done"}',
        ],
        mockCommandResults: {
          'rg -n "test" .': { exitCode: 0, stdout: 'tests/example.test.ts:1:test()', stderr: '' },
        },
      }),
    });
    assert.equal(planSse.statusCode, 200);
    const planToolStart = planSse.events.find((event) => event.event === 'tool_start');
    const planToolResult = planSse.events.find((event) => event.event === 'tool_result');
    assert.equal(Number.isFinite(Number(planToolStart?.payload?.promptTokenCount)), true);
    assert.equal(Number.isFinite(Number(planToolResult?.payload?.promptTokenCount)), true);
    assert.equal(planToolStart?.payload?.command, 'rg -n "test" .');
    assert.equal(planToolResult?.payload?.command, 'rg -n "test" .');
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
    const planDoneSession = d(planSse.events.find((event) => event.event === 'done')?.payload).session as Dict;
    const planDoneMessages = (planDoneSession.messages || []) as Dict[];
    const latestPlanMessage = planDoneMessages[planDoneMessages.length - 1];
    assert.equal(typeof latestPlanMessage.requestStartedAtUtc, 'string');
    assert.equal(typeof latestPlanMessage.answerStartedAtUtc, 'string');
    assert.equal(typeof latestPlanMessage.answerEndedAtUtc, 'string');

    const repoSse = await requestSse(`${baseUrl}/dashboard/chat/sessions/${sessionId}/repo-search/stream`, {
      method: 'POST',
      timeoutMs: 3000,
      body: JSON.stringify({
        content: 'Find tests',
        repoRoot: tempRoot,
        maxTurns: 1,
        availableModels: ['Qwen3.5-35B-A3B-UD-Q4_K_L.gguf'],
        mockResponses: [
          "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"test\\\" .\"}",
          '{"action":"finish","output":"done"}',
        ],
        mockCommandResults: {
          'rg -n "test" .': { exitCode: 0, stdout: 'tests/example.test.ts:1:test()', stderr: '' },
        },
      }),
    });
    assert.equal(repoSse.statusCode, 200);
    const repoToolStart = repoSse.events.find((event) => event.event === 'tool_start');
    const repoToolResult = repoSse.events.find((event) => event.event === 'tool_result');
    assert.equal(Number.isFinite(Number(repoToolStart?.payload?.promptTokenCount)), true);
    assert.equal(Number.isFinite(Number(repoToolResult?.payload?.promptTokenCount)), true);
    assert.equal(repoToolStart?.payload?.command, 'rg -n "test" .');
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
    const repoDoneSession = d(repoSse.events.find((event) => event.event === 'done')?.payload).session as Dict;
    const repoDoneMessages = (repoDoneSession.messages || []) as Dict[];
    const latestRepoMessage = repoDoneMessages[repoDoneMessages.length - 1];
    assert.equal(typeof latestRepoMessage.requestStartedAtUtc, 'string');
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

test('chat session web search defaults on and update persists webSearchEnabled', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-dashboard-web-search-'));
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = server.address() as AddressInfo;
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

test('no-web direct chat persists a single answer with scorecard output tokens', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-dashboard-chat-noweb-'));
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const created = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({ title: 'No-web chat' }),
    });
    const sessionId = String(d(created.body.session).id);

    const sse = await requestSse(`${baseUrl}/dashboard/chat/sessions/${sessionId}/messages/stream`, {
      method: 'POST',
      timeoutMs: 5000,
      body: JSON.stringify({
        content: 'What is 2+2?',
        webSearchOverride: 'off',
        availableModels: ['mock'],
        model: 'mock',
        mockResponses: ['{"action":"finish","output":"4"}'],
      }),
    });

    assert.equal(sse.statusCode, 200);
    assert.equal(sse.events.some((event) => event.event === 'error'), false, JSON.stringify(sse.events));
    assert.equal(sse.events.some((event) => event.event === 'answer'), true, JSON.stringify(sse.events));
    const doneSession = d(sse.events.find((event) => event.event === 'done')?.payload).session as Dict;
    const messages = (doneSession.messages || []) as Dict[];
    const answer = messages.find((message) => message.kind === 'assistant_answer') as Dict;
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-dashboard-web-stream-'));
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = server.address() as AddressInfo;
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
          '{"action":"finish","output":"About 999 gp per bar without checking."}',
          '{"action":"web_search","query":"iron bar GE price"}',
          '{"action":"web_fetch","url":"https://prices.runescape.wiki/iron-bar"}',
          '{"action":"finish","output":"About 150 gp per bar."}',
        ],
        mockCommandResults: {
          'web_search query="iron bar GE price"': {
            exitCode: 0,
            stdout: [
              '1. GE',
              'URL: https://prices.runescape.wiki/iron-bar',
              'Snippet: iron bar ~150 gp',
              'Source: searxng',
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
    const doneSession = d(sse.events.find((event) => event.event === 'done')?.payload).session as Dict;
    const messages = (doneSession.messages || []) as Dict[];
    assert.equal(messages.some((message) => message.kind === 'assistant_tool_call'), true, 'persisted a tool-call step');
    const answer = messages.find((message) => message.kind === 'assistant_answer') as Dict;
    assert.equal(answer.content, 'About 150 gp per bar.');
    assert.doesNotMatch(String(answer.content), /999/);
    assert.equal(answer.groundingStatus, 'fetched');
    assert.equal(Number(answer.outputTokensEstimate) >= 1, true); // answer bubble carries only its own output
    const toolStep = messages.find((message) => message.kind === 'assistant_tool_call') as Dict;
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
          '{"action":"web_search","query":"iron bar GE price"}',
          '{"action":"web_fetch","url":"https://prices.runescape.wiki/iron-bar"}',
          '{"action":"web_search","query":"iron bar live price"}',
          '{"action":"web_fetch","url":"https://prices.runescape.wiki/iron-bar-live"}',
          '{"action":"finish","output":"About 151 gp per bar."}',
        ],
        mockCommandResults: {
          'web_search query="iron bar live price"': {
            exitCode: 0,
            stdout: [
              '1. GE live',
              'URL: https://prices.runescape.wiki/iron-bar-live',
              'Snippet: iron bar ~151 gp',
              'Source: searxng',
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
    const repeatedSession = d(repeated.events.find((event) => event.event === 'done')?.payload).session as Dict;
    const repeatedMessages = (repeatedSession.messages || []) as Dict[];
    const duplicateSearchStep = repeatedMessages.find((message) =>
      message.kind === 'assistant_tool_call'
      && String(message.toolCallCommand || '') === 'web_search query="iron bar GE price"'
      && /already searched/u.test(String(message.toolCallOutput || ''))
    ) as Dict | undefined;
    assert.ok(duplicateSearchStep, JSON.stringify(repeatedMessages));
    const duplicateFetchStep = repeatedMessages.find((message) =>
      message.kind === 'assistant_tool_call'
      && String(message.toolCallCommand || '') === 'web_fetch url="https://prices.runescape.wiki/iron-bar"'
      && /already fetched/u.test(String(message.toolCallOutput || ''))
    ) as Dict | undefined;
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-dashboard-web-replay-'));
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);

  const searxng = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ title: 'Iron bar', url: 'https://oldschool.runescape.wiki/w/Iron_bar', content: 'Iron bars are used in Smithing and quests.' }] }));
  });
  await new Promise<void>((resolve) => searxng.listen(0, '127.0.0.1', () => resolve()));
  const searxngPort = (searxng.address() as AddressInfo).port;

  const config = getDefaultConfig();
  config.WebSearch = {
    EnabledDefault: true,
    Provider: 'searxng',
    SearxngBaseUrl: `http://127.0.0.1:${searxngPort}`,
    ResultCount: 5,
    FetchMaxPages: 3,
    TimeoutMs: 15000,
    FetchMaxCharacters: 12000,
  };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  writeConfig(configPath, config);

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = server.address() as AddressInfo;
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
          '{"action":"web_search","query":"OSRS iron bar"}',
          '{"action":"web_fetch","url":"https://oldschool.runescape.wiki/w/Iron_bar"}',
          '{"action":"finish","output":"Iron bars are used in Smithing and quests."}',
        ],
        mockCommandResults: {
          'web_fetch url="https://oldschool.runescape.wiki/w/Iron_bar"': {
            exitCode: 0,
            stdout: 'Fetched page text: Iron bars are used in Smithing and quests.',
          },
        },
      }),
    });

    assert.equal(first.statusCode, 200);
    assert.equal(first.events.some((event) => event.event === 'error'), false, JSON.stringify(first.events));
    const firstSession = d(first.events.find((event) => event.event === 'done')?.payload).session as Dict;
    const firstMessages = (firstSession.messages || []) as Dict[];
    const fetchStep = firstMessages.find((message) =>
      message.kind === 'assistant_tool_call'
      && String(message.toolCallCommand || '') === 'web_fetch url="https://oldschool.runescape.wiki/w/Iron_bar"'
    ) as Dict | undefined;
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
          '{"action":"finish","output":"The fetched page text said: Iron bars are used in Smithing and quests."}',
        ],
      }),
    });

    assert.equal(second.statusCode, 200);
    assert.equal(second.events.some((event) => event.event === 'error'), false, JSON.stringify(second.events));
    assert.equal(second.events.some((event) => event.event === 'tool_start'), false, JSON.stringify(second.events));
    const secondSession = d(second.events.find((event) => event.event === 'done')?.payload).session as Dict;
    const secondMessages = (secondSession.messages || []) as Dict[];
    const answers = secondMessages.filter((message) => message.kind === 'assistant_answer') as Dict[];
    const answer = answers.at(-1);
    assert.match(String(answer?.content || ''), /Iron bars are used in Smithing and quests/u);
  } finally {
    await new Promise<void>((resolve) => searxng.close(() => resolve()));
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-dashboard-web-delete-dedupe-'));
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const searxng = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ title: 'GE', url: 'https://prices.runescape.wiki/iron-bar', content: 'iron bar price' }] }));
  });
  await new Promise<void>((resolve) => searxng.listen(0, '127.0.0.1', () => resolve()));
  const searxngPort = (searxng.address() as AddressInfo).port;

  const config = getDefaultConfig();
  config.WebSearch = {
    EnabledDefault: true,
    Provider: 'searxng',
    SearxngBaseUrl: `http://127.0.0.1:${searxngPort}`,
    ResultCount: 5,
    FetchMaxPages: 3,
    TimeoutMs: 15000,
    FetchMaxCharacters: 12000,
  };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  writeConfig(configPath, config);

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = server.address() as AddressInfo;
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
          '{"action":"web_search","query":"iron bar GE price"}',
          '{"action":"web_fetch","url":"https://prices.runescape.wiki/iron-bar"}',
          '{"action":"finish","output":"About 150 gp per bar."}',
        ],
        mockCommandResults: {
          'web_fetch url="https://prices.runescape.wiki/iron-bar"': {
            exitCode: 0,
            stdout: 'Fetched source: iron bar current price is about 150 gp per bar.',
          },
        },
      }),
    });
    assert.equal(first.statusCode, 200);
    const firstSession = d(first.events.find((event) => event.event === 'done')?.payload).session as Dict;
    const searchStep = ((firstSession.messages || []) as Dict[]).find((message) =>
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
          '{"action":"web_search","query":"iron bar GE price"}',
          '{"action":"web_fetch","url":"https://prices.runescape.wiki/iron-bar-live"}',
          '{"action":"finish","output":"About 151 gp per bar."}',
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
    const secondSession = d(second.events.find((event) => event.event === 'done')?.payload).session as Dict;
    const secondMessages = (secondSession.messages || []) as Dict[];
    assert.equal(secondMessages.some((message) => /already searched/u.test(String(message.toolCallOutput || ''))), false);
    const repeatedSearchStep = secondMessages.find((message) =>
      message.kind === 'assistant_tool_call'
      && String(message.toolCallCommand || '') === 'web_search query="iron bar GE price"'
    ) as Dict | undefined;
    assert.equal(Number(repeatedSearchStep?.toolCallExitCode), 0);
  } finally {
    await new Promise<void>((resolve) => searxng.close(() => resolve()));
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

test('repo-search auto-append preview reports agents.md and file listing token counts', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-dashboard-auto-append-preview-'));
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  fs.writeFileSync(path.join(tempRoot, 'agents.md'), 'Use repo evidence.', 'utf8');
  fs.writeFileSync(path.join(tempRoot, 'src.ts'), 'export const value = 1;\n', 'utf8');

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const createSession = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Preview Session',
        model: 'Qwen3.5-9B-Q8_0.gguf',
        presetId: 'repo-search',
      }),
    });
    const sessionId = String(d(createSession.body.session).id);

    const preview = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/repo-search/append-preview`, {
      method: 'POST',
      body: JSON.stringify({ repoRoot: tempRoot }),
    });

    assert.equal(preview.statusCode, 200);
    const body = d(preview.body);
    const agentsMd = d(body.agentsMd);
    const repoFileListing = d(body.repoFileListing);
    assert.equal(agentsMd.enabledDefault, true);
    assert.equal(agentsMd.available, true);
    assert.equal(Number(agentsMd.tokenCount) > 0, true);
    assert.equal(['estimate', 'llama.cpp'].includes(String(agentsMd.tokenSource)), true);
    assert.equal(repoFileListing.enabledDefault, true);
    assert.equal(repoFileListing.available, true);
    assert.equal(Number(repoFileListing.tokenCount) > 0, true);
    assert.equal(['estimate', 'llama.cpp'].includes(String(repoFileListing.tokenSource)), true);
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

test('repo-search auto-append preview reports disabled defaults and missing agents.md', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-dashboard-auto-append-preview-disabled-'));
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  fs.writeFileSync(path.join(tempRoot, 'src.ts'), 'export const value = 1;\n', 'utf8');
  writeConfig(getConfigPath(), {
    ...getDefaultConfig(),
    IncludeAgentsMd: false,
    IncludeRepoFileListing: false,
  });

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const createSession = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Preview Session',
        model: 'Qwen3.5-9B-Q8_0.gguf',
        presetId: 'repo-search',
      }),
    });
    const sessionId = String(d(createSession.body.session).id);

    const preview = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/repo-search/append-preview`, {
      method: 'POST',
      body: JSON.stringify({ repoRoot: tempRoot }),
    });

    assert.equal(preview.statusCode, 200);
    const body = d(preview.body);
    const agentsMd = d(body.agentsMd);
    const repoFileListing = d(body.repoFileListing);
    assert.equal(agentsMd.enabledDefault, false);
    assert.equal(agentsMd.available, false);
    assert.equal(agentsMd.tokenCount, 0);
    assert.equal(repoFileListing.enabledDefault, false);
    assert.equal(repoFileListing.available, true);
    assert.equal(Number(repoFileListing.tokenCount) > 0, true);
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

test('repo-search auto-append preview prefers llama tokenizer when available', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-dashboard-auto-append-preview-tokenize-'));
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  fs.writeFileSync(path.join(tempRoot, 'agents.md'), 'Use repo evidence.', 'utf8');
  fs.writeFileSync(path.join(tempRoot, 'src.ts'), 'export const value = 1;\n', 'utf8');

  const tokenizerServer = http.createServer((request, response) => {
    if ((request.url || '').startsWith('/tokenize')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ count: 7 }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{}');
  });
  await new Promise<void>((resolve) => tokenizerServer.listen(0, '127.0.0.1', resolve));
  const tokenizerAddress = tokenizerServer.address() as AddressInfo;
  const tokenizerBaseUrl = `http://127.0.0.1:${tokenizerAddress.port}`;
  const config = getDefaultConfig() as Dict;
  const serverConfig = d(config.Server);
  const serverLlama = d(serverConfig.LlamaCpp);
  serverLlama.Presets = [{
    ...d((serverLlama.Presets as Dict[] | undefined)?.[0]),
    id: 'default',
    label: 'Default',
    ExternalServerEnabled: true,
    BaseUrl: tokenizerBaseUrl,
  }];
  serverLlama.ActivePresetId = 'default';
  serverConfig.LlamaCpp = serverLlama;
  config.Server = serverConfig;
  writeConfig(getConfigPath(), config);

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const createSession = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Preview Session',
        model: 'Qwen3.5-9B-Q8_0.gguf',
        presetId: 'repo-search',
      }),
    });
    const sessionId = String(d(createSession.body.session).id);

    const preview = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/repo-search/append-preview`, {
      method: 'POST',
      body: JSON.stringify({ repoRoot: tempRoot }),
    });

    assert.equal(preview.statusCode, 200);
    const agentsMd = d(d(preview.body).agentsMd);
    const repoFileListing = d(d(preview.body).repoFileListing);
    assert.equal(agentsMd.tokenSource, 'llama.cpp');
    assert.equal(agentsMd.tokenCount, 7);
    assert.equal(repoFileListing.tokenSource, 'llama.cpp');
    assert.equal(repoFileListing.tokenCount, 7);
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

test('package start script launches the dedicated dual-server start runner', () => {
  const packageJsonPath = path.resolve(__dirname, '..', 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { scripts?: { start?: string } };
  assert.equal(typeof packageJson.scripts?.start, 'string');
  assert.match(String(packageJson.scripts?.start || ''), /scripts[\\/]+start-dev\.(ts|js)/u);
});

test('repo-search and dashboard chat messages serialize by waiting', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-dashboard-lock-'));
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = server.address() as AddressInfo;
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

    const delayedRepoSearch = requestJson(`${baseUrl}/repo-search`, {
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
          "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"x\\\" src\"}",
          '{"action":"finish","output":"done"}',
        ],
        mockCommandResults: {
          'rg -n "x" src': { exitCode: 0, stdout: 'src/example.ts:1:x', stderr: '', delayMs: 160 },
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

test('model routes execute in FIFO order across mixed request kinds', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-dashboard-fifo-'));
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = server.address() as AddressInfo;
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
    const completionOrder: string[] = [];

    const delayedRepoSearch = requestJson(`${baseUrl}/repo-search`, {
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
          "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"x\\\" src\"}",
          '{"action":"finish","output":"done"}',
        ],
        mockCommandResults: {
          'rg -n "x" src': { exitCode: 0, stdout: 'src/example.ts:1:x', stderr: '', delayMs: 160 },
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
    }).then((response) => {
      completionOrder.push('b');
      return response;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    const queuedC = requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      timeoutMs: 3000,
      body: JSON.stringify({
        content: 'fifo-c',
        assistantContent: 'assistant-c',
      }),
    }).then((response) => {
      completionOrder.push('c');
      return response;
    });

    const [repoResult, bResult, cResult] = await Promise.all([delayedRepoSearch, queuedB, queuedC]);
    assert.equal(repoResult.statusCode, 200);
    assert.equal(bResult.statusCode, 200);
    assert.equal(cResult.statusCode, 200);
    assert.deepEqual(completionOrder, ['b', 'c']);

    const sessionResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}`);
    const messages = Array.isArray(d(d(sessionResponse.body).session).messages)
      ? d(d(sessionResponse.body).session).messages as unknown[]
      : [];
    const userContents = messages
      .map((entry) => d(entry))
      .filter((entry) => entry.role === 'user')
      .map((entry) => String(entry.content || ''));
    assert.deepEqual(userContents.slice(-2), ['fifo-b', 'fifo-c']);
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

test('queued model request is dropped when client disconnects before lock grant', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-dashboard-queue-disconnect-'));
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = server.address() as AddressInfo;
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

    const delayedRepoSearch = requestJson(`${baseUrl}/repo-search`, {
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
          "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"x\\\" src\"}",
          '{"action":"finish","output":"done"}',
        ],
        mockCommandResults: {
          'rg -n "x" src': { exitCode: 0, stdout: 'src/example.ts:1:x', stderr: '', delayMs: 160 },
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
    const messages = Array.isArray(d(d(sessionResponse.body).session).messages)
      ? d(d(sessionResponse.body).session).messages as unknown[]
      : [];
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

test('invalid model request is rejected without waiting for active model work', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-dashboard-validate-first-'));
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = server.address() as AddressInfo;
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

    const delayedRepoSearch = requestJson(`${baseUrl}/repo-search`, {
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
          "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"x\\\" src\"}",
          '{"action":"finish","output":"done"}',
        ],
        mockCommandResults: {
          'rg -n "x" src': { exitCode: 0, stdout: 'src/example.ts:1:x', stderr: '', delayMs: 160 },
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-dashboard-plan-root-'));
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = server.address() as AddressInfo;
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

test('chat completion replays prior tool evidence without hidden system context', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-dashboard-toolctx-'));
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  let capturedChatRequest: Dict | null = null;
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
      capturedChatRequest = JSON.parse(raw) as Dict;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"{\\"action\\":\\"finish\\",\\"output\\":\\"ack\\"}"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":20,"completion_tokens":4,"completion_tokens_details":{"reasoning_tokens":0}}}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    llamaServer.listen(0, '127.0.0.1', (error?: Error) => (error ? reject(error) : resolve()));
  });
  const llamaAddress = llamaServer.address() as AddressInfo;

  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const chatConfig = getDefaultConfig() as Dict;
  const chatPreset = ((chatConfig.Server as Dict).LlamaCpp as Dict).Presets as Dict[];
  chatPreset[0].Model = 'Qwen3.5-9B-Q8_0.gguf';
  chatPreset[0].BaseUrl = `http://127.0.0.1:${llamaAddress.port}`;
  chatPreset[0].NumCtx = 85000;
  writeConfig(getConfigPath(), chatConfig);

  const server = startStatusServer({ disableManagedLlamaStartup: true, terminalMetadataIdleDelayMs: 0 });
  await server.startupPromise;
  const address = server.address() as AddressInfo;
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
          "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"name\\\" package.json\"}",
          '{"action":"finish","output":"done"}',
        ],
        mockCommandResults: {
          'rg -n "name" package.json': { exitCode: 0, stdout: 'package.json:2:  "name": "siftkit"', stderr: '' },
        },
      }),
    });
    assert.equal(planMessage.statusCode, 200);
    const planSession = d(planMessage.body.session);
    const planToolMessage = ((planSession.messages || []) as Dict[]).find((message) => message.kind === 'assistant_tool_call');
    assert.match(String(planToolMessage?.toolCallCommand || ''), /rg -n "name" package\.json/u);
    assert.match(String(planToolMessage?.toolCallOutput || ''), /"name": "siftkit"/u);
    const persistedPlanSession = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}`);
    const persistedToolMessage = ((d(persistedPlanSession.body.session).messages || []) as Dict[]).find((message) => message.kind === 'assistant_tool_call');
    assert.match(String(persistedToolMessage?.toolCallCommand || ''), /rg -n "name" package\.json/u);
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
    const sourceRunIds = ((chatSession.messages || []) as Dict[])
      .filter((message) => message.role === 'assistant' && message.content === 'ack')
      .map((message) => String(message.sourceRunId || '').trim());
    assert.equal(sourceRunIds.length, 1);
    assert.ok(sourceRunIds.every((runId) => runId.length > 0));
    assert.equal(new Set(sourceRunIds).size, 1);
    let statusMetrics: Dict = {};
    await runtimeHelpers.waitForAsyncExpectation(async () => {
      const statusAfterChat = await requestJson(`${baseUrl}/status`);
      statusMetrics = d(statusAfterChat.body.metrics);
      assert.equal(Number(statusMetrics.inputTokensTotal) >= 20, true);
      assert.equal(Number(statusMetrics.outputTokensTotal) >= 4, true);
    }, 5000);
    assert.equal(Number(statusMetrics.inputTokensTotal) >= 20, true);
    assert.equal(Number(statusMetrics.outputTokensTotal) >= 4, true);
    assert.equal(Number(d(statusMetrics.taskTotals).chat.inputTokensTotal) >= 20, true);
    assert.equal(Number(d(statusMetrics.taskTotals).chat.outputTokensTotal) >= 4, true);
    assert.equal(capturedChatRequest !== null, true);
    const captured = capturedChatRequest as Dict | null;
    assert.equal(Array.isArray(captured?.messages), true);
    const systemMessages = (captured?.messages as Dict[]).filter((message) => message && message.role === 'system');
    assert.equal(systemMessages.some((message) => String(message.content || '').includes('Internal tool-call context from prior session steps.')), false);
    assert.equal((captured?.messages as Dict[]).some((message) =>
      message.role === 'assistant'
      && Array.isArray(message.tool_calls)
      && String(message.tool_calls[0]?.function?.arguments || '').includes('rg -n \\"name\\" package.json')
    ), true);
    assert.equal((captured?.messages as Dict[]).some((message) =>
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

test('deleting a tool bubble removes chat context and rewrites run detail', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-dashboard-delete-bubble-'));
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  let capturedChatRequest: Dict | null = null;
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
      capturedChatRequest = JSON.parse(raw) as Dict;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"{\\"action\\":\\"finish\\",\\"output\\":\\"ack\\"}"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":30,"completion_tokens":4}}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    llamaServer.listen(0, '127.0.0.1', (error?: Error) => (error ? reject(error) : resolve()));
  });
  const llamaAddress = llamaServer.address() as AddressInfo;

  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const chatConfig = getDefaultConfig() as Dict;
  const chatPreset = ((chatConfig.Server as Dict).LlamaCpp as Dict).Presets as Dict[];
  chatPreset[0].Model = 'Qwen3.5-9B-Q8_0.gguf';
  chatPreset[0].BaseUrl = `http://127.0.0.1:${llamaAddress.port}`;
  chatPreset[0].NumCtx = 85000;
  writeConfig(getConfigPath(), chatConfig);

  const server = startStatusServer({ disableManagedLlamaStartup: true, terminalMetadataIdleDelayMs: 0 });
  await server.startupPromise;
  const address = server.address() as AddressInfo;
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
          "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"name\\\" package.json\"}",
          '{"action":"finish","output":"done"}',
        ],
        mockCommandResults: {
          'rg -n "name" package.json': { exitCode: 0, stdout: 'package.json:2:  "name": "siftkit"', stderr: '' },
        },
      }),
    });
    assert.equal(repoMessage.statusCode, 200);
    const repoDonePayload = d(repoMessage.events.find((event) => event.event === 'done')?.payload);
    const repoSession = d(repoDonePayload.session);
    const toolMessage = ((repoSession.messages || []) as Dict[]).find((message) => message.kind === 'assistant_tool_call');
    assert.equal(typeof toolMessage?.id, 'string');
    assert.match(String(toolMessage?.toolCallCommand || ''), /^rg -n "name" package\.json/u);
    assert.equal(String(toolMessage?.toolCallOutput || '').includes('"name": "siftkit"'), true);
    const runId = String(toolMessage?.sourceRunId || '');
    const storedCommandText = String(toolMessage?.toolCallCommand || '');

    const detailBefore = await requestJson(`${baseUrl}/dashboard/runs/${encodeURIComponent(runId)}`);
    assert.equal(detailBefore.statusCode, 200);
    assert.equal(
      buildRepoSearchChatSteps((d(detailBefore.body).events || []) as never).some((step) => step.command === storedCommandText),
      true,
    );

    const deleteResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/messages/${toolMessage?.id}`, {
      method: 'DELETE',
      timeoutMs: 3000,
    });
    assert.equal(deleteResponse.statusCode, 200);
    const deletedSession = d(deleteResponse.body.session);
    assert.equal(((deletedSession.messages || []) as Dict[]).some((message) => message.id === toolMessage?.id), false);

    const detailAfter = await requestJson(`${baseUrl}/dashboard/runs/${encodeURIComponent(runId)}`);
    assert.equal(detailAfter.statusCode, 200);
    assert.equal(
      buildRepoSearchChatSteps((d(detailAfter.body).events || []) as never).some((step) => step.command === storedCommandText),
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
    const captured = capturedChatRequest as Dict | null;
    assert.equal(Array.isArray(captured?.messages), true);
    const capturedText = ((captured?.messages || []) as Dict[]).map((message) => String(message.content || '')).join('\n');
    assert.equal(capturedText.includes('rg -n "name" package.json'), false);
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



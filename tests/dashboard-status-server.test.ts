import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';

import { startStatusServer } from '../dist/status-server/index.js';
import { writeConfig } from '../dist/status-server/config-store.js';
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


function d(value: unknown): Dict {
  return (value || {}) as Dict;
}

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
  };
  process.env.sift_kit_status = statusPath;
  process.env.SIFTKIT_STATUS_PATH = statusPath;
  process.env.SIFTKIT_CONFIG_PATH = configPath;
  process.env.SIFTKIT_METRICS_PATH = path.join(tempRoot, '.siftkit', 'status', 'compression-metrics.json');
  process.env.SIFTKIT_IDLE_SUMMARY_DB_PATH = path.join(tempRoot, '.siftkit', 'status', 'idle-summary.sqlite');
  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';
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
          '{"action":"tool","tool_name":"repo_rg","args":{"command":"rg -n \\"dashboard\\" ."}}',
          '{"action":"tool","tool_name":"repo_rg","args":{"command":"rg -n \\"/dashboard/chat/sessions\\" siftKitStatus/index.js"}}',
          '{"action":"finish","output":"Plan: update dashboard/src/App.tsx and siftKitStatus/index.js; include a risks section for endpoint lock contention and stale repo-root paths.","confidence":0.92}',
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
    assert.equal(Array.isArray(planSession.hiddenToolContexts), true);
    assert.equal((planSession.hiddenToolContexts as Dict[]).length >= 1, true);
    const planUsage = d(planMessage.body.contextUsage);
    assert.equal(Number(planUsage.totalUsedTokens) > Number(planUsage.chatUsedTokens), true);
    const latestMessage = planMessages[planMessages.length - 1];
    assert.equal(latestMessage.role, 'assistant');
    assert.equal(Number(latestMessage.associatedToolTokens || 0) > 0, true);
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
    assert.equal(clearToolContextResponse.statusCode, 200);
    const clearedSession = d(clearToolContextResponse.body.session);
    assert.equal(Array.isArray(clearedSession.hiddenToolContexts), true);
    assert.equal((clearedSession.hiddenToolContexts as Dict[]).length, 0);
    const clearedUsage = d(clearToolContextResponse.body.contextUsage);
    assert.equal(clearedUsage.toolUsedTokens, 0);
    assert.equal(clearedUsage.totalUsedTokens, clearedUsage.chatUsedTokens);

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

  const server = startStatusServer({ disableManagedLlamaStartup: true });
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

    const metricsResponse = await requestJson(`${baseUrl}/dashboard/metrics/timeseries`);
    assert.equal(metricsResponse.statusCode, 200);
    const repoSearchToolStats = d(metricsResponse.body.toolStats)['repo-search'] as Dict;
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
          '{"action":"tool","tool_name":"repo_rg","args":{"command":"rg -n \\"test\\" ."}}',
          '{"action":"finish","output":"done","confidence":0.9}',
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
    assert.equal(/--no-ignore|--ignore-case|--glob/u.test(String(planToolStart?.payload?.command || '')), false);
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
          '{"action":"tool","tool_name":"repo_rg","args":{"command":"rg -n \\"test\\" ."}}',
          '{"action":"finish","output":"done","confidence":0.9}',
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
          '{"action":"tool","tool_name":"repo_rg","args":{"command":"rg -n \\"x\\" src"}}',
          '{"action":"finish","output":"done","confidence":0.9}',
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
          '{"action":"tool","tool_name":"repo_rg","args":{"command":"rg -n \\"x\\" src"}}',
          '{"action":"finish","output":"done","confidence":0.9}',
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
          '{"action":"tool","tool_name":"repo_rg","args":{"command":"rg -n \\"x\\" src"}}',
          '{"action":"finish","output":"done","confidence":0.9}',
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
          '{"action":"tool","tool_name":"repo_rg","args":{"command":"rg -n \\"x\\" src"}}',
          '{"action":"finish","output":"done","confidence":0.9}',
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

test('chat completion receives hidden tool context while keeping it out of visible chat history', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-dashboard-toolctx-'));
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  let capturedChatRequest: Dict | null = null;
  const llamaServer = http.createServer((req, res) => {
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
      const responseBody = {
        choices: [
          {
            message: {
              content: 'ack',
              reasoning_content: '',
            },
          },
        ],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 4,
          completion_tokens_details: {
            reasoning_tokens: 0,
          },
        },
      };
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(responseBody));
    });
  });
  await new Promise<void>((resolve, reject) => {
    llamaServer.listen(0, '127.0.0.1', (error?: Error) => (error ? reject(error) : resolve()));
  });
  const llamaAddress = llamaServer.address() as AddressInfo;
  writeJson(configPath, {
    Runtime: {
      Model: 'Qwen3.5-9B-Q8_0.gguf',
      LlamaCpp: {
        BaseUrl: `http://127.0.0.1:${llamaAddress.port}`,
        NumCtx: 85000,
      },
    },
    Server: {
      LlamaCpp: {
        BaseUrl: `http://127.0.0.1:${llamaAddress.port}`,
        NumCtx: 85000,
      },
    },
  });

  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);

  const server = startStatusServer({ disableManagedLlamaStartup: true });
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
          '{"action":"tool","tool_name":"repo_rg","args":{"command":"rg -n \\"name\\" package.json"}}',
          '{"action":"finish","output":"done","confidence":0.9}',
        ],
        mockCommandResults: {
          'rg -n "name" package.json': { exitCode: 0, stdout: 'package.json:2:  "name": "siftkit"', stderr: '' },
        },
      }),
    });
    assert.equal(planMessage.statusCode, 200);
    const planSession = d(planMessage.body.session);
    assert.equal((planSession.hiddenToolContexts as Dict[]).length >= 1, true);

    const chatReply = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      timeoutMs: 3000,
      body: JSON.stringify({
        content: 'use prior evidence and summarize next steps',
      }),
    });
    assert.equal(chatReply.statusCode, 200);
    const statusAfterChat = await requestJson(`${baseUrl}/status`);
    const statusMetrics = d(statusAfterChat.body.metrics);
    assert.equal(Number(statusMetrics.inputTokensTotal) >= 20, true);
    assert.equal(Number(statusMetrics.outputTokensTotal) >= 4, true);
    assert.equal(Number(d(statusMetrics.taskTotals).chat.inputTokensTotal) >= 20, true);
    assert.equal(Number(d(statusMetrics.taskTotals).chat.outputTokensTotal) >= 4, true);
    assert.equal(capturedChatRequest !== null, true);
    const captured = capturedChatRequest as Dict | null;
    assert.equal(Array.isArray(captured?.messages), true);
    const systemMessages = (captured?.messages as Dict[]).filter((message) => message && message.role === 'system');
    const hiddenToolSystemMessage = systemMessages.find((message) => String(message.content || '').includes('Internal tool-call context from prior session steps.'));
    assert.equal(Boolean(hiddenToolSystemMessage), true);
    assert.match(String(hiddenToolSystemMessage?.content || ''), /Command: rg -n "name" package\.json/u);
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



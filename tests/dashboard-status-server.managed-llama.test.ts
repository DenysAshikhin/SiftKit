import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { spawnSync } from 'node:child_process';
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
    startupTimeoutMs?: number;
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

function stopFakeManagedLlama(readyFilePath: string): void {
  if (!fs.existsSync(readyFilePath)) {
    return;
  }
  const pid = Number.parseInt(fs.readFileSync(readyFilePath, 'utf8').trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
}


test('dashboard plan wakes managed llama after idle shutdown', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-dashboard-idle-wakeup-'));
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const runtimeDbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
  const llamaPort = await runtimeHelpers.getFreePort();
  const managed = runtimeHelpers.writeManagedLlamaLauncher(tempRoot, llamaPort);
  const config = runtimeHelpers.getDefaultConfig();
  config.Backend = 'llama.cpp';
  config.Model = 'managed-test-model';
  runtimeHelpers.setManagedLlamaBaseUrl(config, managed.baseUrl);
  config.Server = {
    LlamaCpp: {
      ExecutablePath: managed.executablePath,
      BaseUrl: managed.baseUrl,
      BindHost: '127.0.0.1',
      Port: llamaPort,
      ModelPath: managed.modelPath,
      NumCtx: 32000,
      GpuLayers: 999,
      Threads: 2,
      FlashAttention: true,
      ParallelSlots: 1,
      BatchSize: 512,
      UBatchSize: 512,
      CacheRam: 8192,
      KvCacheQuantization: 'q8_0',
      MaxTokens: 15000,
      Temperature: 0.6,
      TopP: 0.95,
      TopK: 20,
      MinP: 0,
      PresencePenalty: 0,
      RepetitionPenalty: 1,
      Reasoning: 'on',
      ReasoningBudget: 10000,
      ReasoningBudgetMessage: 'Thinking budget exhausted. You have to provide the answer now.',
      StartupTimeoutMs: 1000,
      HealthcheckTimeoutMs: 100,
      HealthcheckIntervalMs: 10,
      VerboseLogging: false,
    },
  };
  writeConfig(runtimeDbPath, config);

  const server = await runtimeHelpers.startStatusServerProcess({
    statusPath,
    configPath,
    idleSummaryDelayMs: 80,
    terminalMetadataIdleDelayMs: 0,
    startupTimeoutMs: 3000,
  });
  const baseUrl = new URL(server.statusUrl).origin;

  try {
    await runtimeHelpers.waitForAsyncExpectation(async () => {
      const modelsResponse = await requestJson(`${managed.baseUrl}/v1/models`);
      assert.equal(modelsResponse.statusCode, 200);
    }, 1000);
    assert.equal(fs.existsSync(managed.readyFilePath), true);

    const createSession = await requestJson(`${baseUrl}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Wakeup session',
        model: 'managed-test-model',
      }),
    });
    assert.equal(createSession.statusCode, 200);
    const sessionId = String(d(createSession.body.session).id);

    await requestJson(`${baseUrl}/status`, {
      method: 'POST',
      body: JSON.stringify({
        running: true,
        requestId: 'dashboard-idle-wakeup-primer',
        rawInputCharacterCount: 10,
        promptCharacterCount: 10,
      }),
    });
    await requestJson(`${baseUrl}/status/terminal-metadata`, {
      method: 'POST',
      body: JSON.stringify({
        running: false,
        requestId: 'dashboard-idle-wakeup-primer',
        taskKind: 'plan',
        terminalState: 'completed',
        promptCharacterCount: 10,
        inputTokens: 1,
        outputCharacterCount: 1,
        outputTokens: 1,
        requestDurationMs: 10,
      }),
    });
    await requestJson(`${baseUrl}/status/complete`, {
      method: 'POST',
      body: JSON.stringify({
        requestId: 'dashboard-idle-wakeup-primer',
        taskKind: 'plan',
        terminalState: 'completed',
      }),
    });

    await runtimeHelpers.waitForAsyncExpectation(async () => {
      const statusResponse = await requestJson(server.statusUrl);
      assert.equal(statusResponse.statusCode, 200);
      assert.equal(statusResponse.body.status, 'false');
    }, 1000);
    await runtimeHelpers.waitForAsyncExpectation(async () => {
      await assert.rejects(() => requestJson(`${managed.baseUrl}/v1/models`, { timeoutMs: 200 }));
    }, 5000);

    const planResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/plan`, {
      method: 'POST',
      timeoutMs: 3000,
      body: JSON.stringify({
        content: 'Find wake-up wiring',
        repoRoot: tempRoot,
        maxTurns: 2,
        model: 'managed-test-model',
        mockResponses: [
          '{"action":"tool","tool_name":"repo_rg","args":{"command":"rg -n \\"ensureManagedLlamaReady\\" src/status-server"}}',
          '{"action":"finish","output":"done","confidence":0.9}',
        ],
        mockCommandResults: {
          'rg -n "ensureManagedLlamaReady" src/status-server': { exitCode: 0, stdout: 'src/status-server/managed-llama.ts:1:ensureManagedLlamaReady', stderr: '' },
        },
      }),
    });
    assert.equal(planResponse.statusCode, 200);

    await runtimeHelpers.waitForAsyncExpectation(async () => {
      const modelsResponse = await requestJson(`${managed.baseUrl}/v1/models`);
      assert.equal(modelsResponse.statusCode, 200);
    }, 1000);
  } finally {
    await server.close();
    stopFakeManagedLlama(managed.readyFilePath);
    restoreDashboardTestRepo(previousCwd);
    try {
      await removeDirectoryWithRetries(tempRoot);
    } catch {
      // Best-effort temp cleanup on Windows.
    }
  }
});

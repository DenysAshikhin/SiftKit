import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, Module } from 'node:module';
import Database from 'better-sqlite3';

import { startStatusServer, buildRepoSearchProgressLogBody } from '../src/status-server/index.js';
import { closeRuntimeDatabase } from '../src/state/runtime-db.js';
import { getConfigPath } from '../src/config/index.js';
import { getDefaultConfig, writeConfig } from '../src/status-server/config-store.js';
import {
  writeManagedLlamaScripts,
  getFreePort,
  waitForAsyncExpectation,
  startStatusServerProcess,
} from './_runtime-helpers.js';
import { requestJson, asObject, asObjectArray, getAddressInfo } from './helpers/dashboard-http.js';
import { captureStdoutLines } from './helpers/stdout-capture.js';
import { JsonRecordReader } from '../src/lib/json-record-reader.js';
import { parseJsonValueText } from '../src/lib/json.js';

const requireFromHere = createRequire(__filename);

function writeManagedLlamaReadinessTestConfig(managed: {
  baseUrl: string;
  modelPath: string;
  startupScriptPath: string;
}, startupTimeoutMs: number): void {
  const config = getDefaultConfig();
  const server = config.Server;
  server.ModelPresets.Presets = [{
    ...server.ModelPresets.Presets[0],
    id: 'default',
    label: 'Managed Test',
    Model: 'managed-test-model',
    ExternalServerEnabled: false,
    BaseUrl: managed.baseUrl,
    ExecutablePath: managed.startupScriptPath,
    ModelPath: managed.modelPath,
    StartupTimeoutMs: startupTimeoutMs,
    HealthcheckTimeoutMs: 20,
    HealthcheckIntervalMs: 20,
  }];
  server.ModelPresets.ActivePresetId = 'default';
  writeConfig(getConfigPath(), config);
}

async function stopManagedTestProcess(pidFilePath: string): Promise<void> {
  try {
    const pid = Number(fs.readFileSync(pidFilePath, 'utf8').trim());
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid);
      } catch {
        // Already exited.
      }
    }
  } catch {
    return;
  }
  const deadline = Date.now() + 2000;
  while (fs.existsSync(pidFilePath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    fs.rmSync(pidFilePath, { force: true });
  } catch {
    // Best effort.
  }
}


test('status server stays responsive while repo-search is running', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-repo-search-status-'));
  const previousCwd = process.cwd();
  fs.writeFileSync(
    path.join(tempRoot, 'package.json'),
    JSON.stringify({ name: 'siftkit', version: '0.1.0' }, null, 2),
    'utf8',
  );
  process.chdir(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup: Record<string, string | undefined> = {
    sift_kit_status: process.env.sift_kit_status,
    SIFTKIT_STATUS_PATH: process.env.SIFTKIT_STATUS_PATH,
    SIFTKIT_CONFIG_PATH: process.env.SIFTKIT_CONFIG_PATH,
    SIFTKIT_STATUS_HOST: process.env.SIFTKIT_STATUS_HOST,
    SIFTKIT_STATUS_PORT: process.env.SIFTKIT_STATUS_PORT,
  };
  process.env.sift_kit_status = statusPath;
  process.env.SIFTKIT_STATUS_PATH = statusPath;
  process.env.SIFTKIT_CONFIG_PATH = configPath;
  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';

  const server = startStatusServer({ disableManagedLlamaStartup: true, terminalMetadataIdleDelayMs: 50 });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const baselineStatus = await requestJson(`${baseUrl}/status`);
    const baselineMetrics = asObject(baselineStatus.body.metrics);
    const baselineCompleted = Number(baselineMetrics.completedRequestCount || 0);
    const baselineInputChars = Number(baselineMetrics.inputCharactersTotal || 0);
    const baselineDurationMs = Number(baselineMetrics.requestDurationMsTotal || 0);

    const delayedRequest = requestJson(`${baseUrl}/repo-search`, {
      method: 'POST',
      timeoutMs: 15000,
      body: JSON.stringify({
        prompt: 'find x',
        repoRoot: process.cwd(),
        model: 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf',
        maxTurns: 2,
        availableModels: ['Qwen3.5-35B-A3B-UD-Q4_K_L.gguf'],
        mockResponses: [
          "{\"action\":\"git\",\"command\":\"git grep -n \\\"x\\\" src\"}",
          '{"action":"finish","output":"done"}',
        ],
        mockCommandResults: {
          'git grep -n "x" src': { exitCode: 0, stdout: 'src/example.ts:1:x', stderr: '', delayMs: 2000 },
        },
      }),
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const healthStart = Date.now();
    const healthResponse = await requestJson(`${baseUrl}/health`);
    const healthLatencyMs = Date.now() - healthStart;

    assert.equal(healthResponse.statusCode, 200);
    assert.equal(healthResponse.body.ok, true);
    assert.ok(healthLatencyMs < 800, `expected fast /health while repo-search runs, got ${healthLatencyMs}ms`);

    const searchResponse = await delayedRequest;
    assert.ok(searchResponse.statusCode >= 200 && searchResponse.statusCode < 600);
    assert.equal(typeof searchResponse.body, 'object');

    await waitForAsyncExpectation(async () => {
      const finalStatus = await requestJson(`${baseUrl}/status`);
      const finalMetrics = asObject(finalStatus.body.metrics);
      if (searchResponse.statusCode >= 200 && searchResponse.statusCode < 300) {
        assert.ok(Number(finalMetrics.completedRequestCount || 0) >= baselineCompleted + 1);
      } else {
        assert.ok(Number(finalMetrics.completedRequestCount || 0) >= baselineCompleted);
      }
      assert.ok(Number(finalMetrics.outputTokensTotal || 0) > 0);
      assert.ok(Number(finalMetrics.toolTokensTotal || 0) > 0);
      const taskTotals = asObject(finalMetrics.taskTotals);
      const repoTaskTotals = asObject(taskTotals['repo-search']);
      assert.ok(Number(repoTaskTotals.outputTokensTotal || 0) > 0);
      assert.ok(Number(repoTaskTotals.toolTokensTotal || 0) > 0);
      const toolStats = asObject(finalMetrics.toolStats);
      const repoToolStats = asObject(toolStats['repo-search']);
      assert.ok(Number(asObject(repoToolStats.git).calls || 0) >= 1);
      assert.ok(Number(finalMetrics.inputCharactersTotal || 0) >= baselineInputChars + 'find x'.length);
      assert.ok(Number(finalMetrics.requestDurationMsTotal || 0) > baselineDurationMs);
    }, 5000);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    process.chdir(previousCwd);
    closeRuntimeDatabase();
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('repo-search abandons stale running status after acquiring the model lock', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-repo-search-stale-status-'));
  const previousCwd = process.cwd();
  fs.writeFileSync(
    path.join(tempRoot, 'package.json'),
    JSON.stringify({ name: 'siftkit', version: '0.1.0' }, null, 2),
    'utf8',
  );
  process.chdir(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup: Record<string, string | undefined> = {
    sift_kit_status: process.env.sift_kit_status,
    SIFTKIT_STATUS_PATH: process.env.SIFTKIT_STATUS_PATH,
    SIFTKIT_CONFIG_PATH: process.env.SIFTKIT_CONFIG_PATH,
    SIFTKIT_STATUS_HOST: process.env.SIFTKIT_STATUS_HOST,
    SIFTKIT_STATUS_PORT: process.env.SIFTKIT_STATUS_PORT,
  };
  process.env.sift_kit_status = statusPath;
  process.env.SIFTKIT_STATUS_PATH = statusPath;
  process.env.SIFTKIT_CONFIG_PATH = configPath;
  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';

  const server = startStatusServer({ disableManagedLlamaStartup: true, terminalMetadataIdleDelayMs: 50 });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await requestJson(`${baseUrl}/status`, {
      method: 'POST',
      body: JSON.stringify({
        running: true,
        requestId: 'stale-running-request',
        taskKind: 'summary',
        rawInputCharacterCount: 100,
      }),
    });

    const startedAt = Date.now();
    const searchResponse = await requestJson(`${baseUrl}/repo-search`, {
      method: 'POST',
      timeoutMs: 5000,
      body: JSON.stringify({
        prompt: 'find x',
        repoRoot: process.cwd(),
        model: 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf',
        maxTurns: 1,
        availableModels: ['Qwen3.5-35B-A3B-UD-Q4_K_L.gguf'],
        mockResponses: [
          '{"action":"finish","output":"done"}',
        ],
        mockCommandResults: {},
      }),
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(searchResponse.statusCode, 200);
    assert.ok(elapsedMs < 800, `expected stale status to be abandoned without busy retries, got ${elapsedMs}ms`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    process.chdir(previousCwd);
    closeRuntimeDatabase();
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('repo-search registers before queue wait, exposes queue diagnostics, and fails queued timeouts loudly', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-repo-search-queue-timeout-'));
  const previousCwd = process.cwd();
  fs.writeFileSync(
    path.join(tempRoot, 'package.json'),
    JSON.stringify({ name: 'siftkit', version: '0.1.0' }, null, 2),
    'utf8',
  );
  process.chdir(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup: Record<string, string | undefined> = {
    sift_kit_status: process.env.sift_kit_status,
    SIFTKIT_STATUS_PATH: process.env.SIFTKIT_STATUS_PATH,
    SIFTKIT_CONFIG_PATH: process.env.SIFTKIT_CONFIG_PATH,
    SIFTKIT_STATUS_HOST: process.env.SIFTKIT_STATUS_HOST,
    SIFTKIT_STATUS_PORT: process.env.SIFTKIT_STATUS_PORT,
    SIFTKIT_MODEL_REQUEST_QUEUE_TIMEOUT_MS: process.env.SIFTKIT_MODEL_REQUEST_QUEUE_TIMEOUT_MS,
  };
  process.env.sift_kit_status = statusPath;
  process.env.SIFTKIT_STATUS_PATH = statusPath;
  process.env.SIFTKIT_CONFIG_PATH = configPath;
  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';
  process.env.SIFTKIT_MODEL_REQUEST_QUEUE_TIMEOUT_MS = '120';

  const server = startStatusServer({ disableManagedLlamaStartup: true, terminalMetadataIdleDelayMs: 50 });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const dbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');

  try {
    const lines = await captureStdoutLines(async () => {
      const activeRequest = requestJson(`${baseUrl}/repo-search`, {
        method: 'POST',
        timeoutMs: 5000,
        body: JSON.stringify({
          prompt: 'hold model queue',
          repoRoot: process.cwd(),
          model: 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf',
          maxTurns: 2,
          availableModels: ['Qwen3.5-35B-A3B-UD-Q4_K_L.gguf'],
          mockResponses: [
            "{\"action\":\"git\",\"command\":\"git grep -n \\\"x\\\" src\"}",
            '{"action":"finish","output":"done"}',
          ],
          mockCommandResults: {
            'git grep -n "x" src': { exitCode: 0, stdout: 'src/example.ts:1:x', stderr: '', delayMs: 300 },
          },
        }),
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      const queuedRequest = requestJson(`${baseUrl}/repo-search`, {
        method: 'POST',
        timeoutMs: 5000,
        body: JSON.stringify({
          prompt: 'queued behind active',
          repoRoot: process.cwd(),
          model: 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf',
          maxTurns: 1,
          availableModels: ['Qwen3.5-35B-A3B-UD-Q4_K_L.gguf'],
          mockResponses: ['{"action":"finish","output":"queued"}'],
          mockCommandResults: {},
        }),
      });

      await waitForAsyncExpectation(async () => {
        const statusResponse = await requestJson(`${baseUrl}/status`);
        const modelRequests = asObject(statusResponse.body.modelRequests);
        assert.equal(modelRequests.active, true);
        assert.equal(modelRequests.queueLength, 1);
        const queuedRequests = asObjectArray(modelRequests.queuedRequests);
        assert.equal(queuedRequests[0]?.kind, 'repo_search');

        const database = new Database(dbPath, { readonly: true });
        try {
          const row = JsonRecordReader.asObject(database.prepare(`
            SELECT terminal_state, title
            FROM run_logs
            WHERE title = ?
          `).get('queued behind active'));
          assert.equal(row?.terminal_state, 'unknown');
        } finally {
          database.close();
        }
      }, 1000);

      const queuedResponse = await queuedRequest;
      assert.equal(queuedResponse.statusCode, 503);
      assert.match(String(queuedResponse.body.error || ''), /Timed out waiting for model request queue/u);

      const activeResponse = await activeRequest;
      assert.equal(activeResponse.statusCode, 200);
    });

    assert.ok(lines.some((line) => /st [\w-]{8} {2}dropped {2}reason=model_queue_timeout task=repo_search/u.test(line)), lines.join('\n'));

    const database = new Database(dbPath, { readonly: true });
    try {
      const failedRow = JsonRecordReader.asObject(database.prepare(`
        SELECT terminal_state, failed_request_json
        FROM run_logs
        WHERE title = ?
      `).get('queued behind active'));
      assert.equal(failedRow?.terminal_state, 'failed');
      assert.match(String(failedRow?.failed_request_json || ''), /Timed out waiting for model request queue/u);
    } finally {
      database.close();
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    process.chdir(previousCwd);
    closeRuntimeDatabase();
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('managed llama readiness wait is serialized by the model request queue', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-readiness-outside-queue-'));
  const previousCwd = process.cwd();
  fs.writeFileSync(
    path.join(tempRoot, 'package.json'),
    JSON.stringify({ name: 'siftkit', version: '0.1.0' }, null, 2),
    'utf8',
  );
  process.chdir(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup: Record<string, string | undefined> = {
    sift_kit_status: process.env.sift_kit_status,
    SIFTKIT_STATUS_PATH: process.env.SIFTKIT_STATUS_PATH,
    SIFTKIT_CONFIG_PATH: process.env.SIFTKIT_CONFIG_PATH,
    SIFTKIT_STATUS_HOST: process.env.SIFTKIT_STATUS_HOST,
    SIFTKIT_STATUS_PORT: process.env.SIFTKIT_STATUS_PORT,
  };
  process.env.sift_kit_status = statusPath;
  process.env.SIFTKIT_STATUS_PATH = statusPath;
  process.env.SIFTKIT_CONFIG_PATH = configPath;
  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';

  const llamaPort = await getFreePort();
  const managed = writeManagedLlamaScripts(tempRoot, llamaPort, 'managed-test-model', {
    launchHangingProcess: true,
  });
  writeManagedLlamaReadinessTestConfig(managed, 250);

  const server = startStatusServer();
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const backendStatus = await requestJson(`${baseUrl}/runtime/inference`, { timeoutMs: 1000 });
    assert.equal(backendStatus.body.processState, 'failed');
    const firstRequest = requestJson(`${baseUrl}/repo-search`, {
      method: 'POST',
      timeoutMs: 15000,
      body: JSON.stringify({
        prompt: 'hold readiness',
        repoRoot: process.cwd(),
        model: 'managed-test-model',
        maxTurns: 1,
      }),
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const secondStartedAt = Date.now();
    const secondResponse = await requestJson(`${baseUrl}/summary`, {
      method: 'POST',
      timeoutMs: 15000,
      body: JSON.stringify({
        question: 'summarize',
        inputText: 'short text',
        backend: 'llama.cpp',
        model: 'managed-test-model',
      }),
    });
    const secondElapsedMs = Date.now() - secondStartedAt;
    const firstResponse = await firstRequest;

    assert.equal(firstResponse.statusCode, 503);
    assert.equal(secondResponse.statusCode, 503);
    assert.ok(secondElapsedMs >= 200, `second request bypassed model queue in ${secondElapsedMs}ms`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    process.chdir(previousCwd);
    closeRuntimeDatabase();
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await stopManagedTestProcess(managed.pidFilePath);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('health reports unavailable while managed llama bootstrap is still starting', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-health-bootstrap-'));
  const previousCwd = process.cwd();
  fs.writeFileSync(
    path.join(tempRoot, 'package.json'),
    JSON.stringify({ name: 'siftkit', version: '0.1.0' }, null, 2),
    'utf8',
  );
  process.chdir(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup: Record<string, string | undefined> = {
    sift_kit_status: process.env.sift_kit_status,
    SIFTKIT_STATUS_PATH: process.env.SIFTKIT_STATUS_PATH,
    SIFTKIT_CONFIG_PATH: process.env.SIFTKIT_CONFIG_PATH,
    SIFTKIT_STATUS_HOST: process.env.SIFTKIT_STATUS_HOST,
    SIFTKIT_STATUS_PORT: process.env.SIFTKIT_STATUS_PORT,
  };
  process.env.sift_kit_status = statusPath;
  process.env.SIFTKIT_STATUS_PATH = statusPath;
  process.env.SIFTKIT_CONFIG_PATH = configPath;
  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';

  const llamaPort = await getFreePort();
  const managed = writeManagedLlamaScripts(tempRoot, llamaPort, 'managed-test-model', {
    launchHangingProcess: true,
  });
  writeManagedLlamaReadinessTestConfig(managed, 900);

  const server = startStatusServer();
  await waitForAsyncExpectation(async () => {
    assert.notEqual(server.address(), null);
  }, 1000);
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const bootstrapHealth = await requestJson(`${baseUrl}/health`, { timeoutMs: 1000 });
    assert.equal(bootstrapHealth.statusCode, 503);
    assert.equal(bootstrapHealth.body.ok, false);
    assert.equal(bootstrapHealth.body.startupPending, true);

    await server.startupPromise;
    const readyHealth = await requestJson(`${baseUrl}/health`, { timeoutMs: 1000 });
    assert.equal(readyHealth.statusCode, 200);
    assert.equal(readyHealth.body.ok, true);
    assert.equal(readyHealth.body.startupPending, false);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    process.chdir(previousCwd);
    closeRuntimeDatabase();
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await stopManagedTestProcess(managed.pidFilePath);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('status completion flushing does not block health responses', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-status-flush-health-'));
  const previousCwd = process.cwd();
  fs.writeFileSync(
    path.join(tempRoot, 'package.json'),
    JSON.stringify({ name: 'siftkit', version: '0.1.0' }, null, 2),
    'utf8',
  );
  process.chdir(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup: Record<string, string | undefined> = {
    sift_kit_status: process.env.sift_kit_status,
    SIFTKIT_STATUS_PATH: process.env.SIFTKIT_STATUS_PATH,
    SIFTKIT_CONFIG_PATH: process.env.SIFTKIT_CONFIG_PATH,
    SIFTKIT_STATUS_HOST: process.env.SIFTKIT_STATUS_HOST,
    SIFTKIT_STATUS_PORT: process.env.SIFTKIT_STATUS_PORT,
  };
  process.env.sift_kit_status = statusPath;
  process.env.SIFTKIT_STATUS_PATH = statusPath;
  process.env.SIFTKIT_CONFIG_PATH = configPath;
  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';

  const requestId = 'flush-block-test';
  const delayedArtifactPath = path.join(tempRoot, '.siftkit', 'logs', 'requests', `request_${requestId}.json`);
  fs.mkdirSync(path.dirname(delayedArtifactPath), { recursive: true });
  fs.writeFileSync(
    delayedArtifactPath,
    `${JSON.stringify({ title: 'flush blocking simulation', prompt: 'x'.repeat(1024) })}\n`,
    'utf8',
  );

  // Minimal mutable view of the shared CJS fs module so readFileSync can be
  // monkeypatched with a single-signature wrapper (the full overloaded type
  // cannot accept a plain arrow without a cast).
  type ReadFileSyncArg = string | Buffer | URL | number;
  type ReadFileSyncOptions = BufferEncoding | { encoding?: BufferEncoding | null; flag?: string } | null;
  type MutableFsModule = {
    readFileSync: (filePath: ReadFileSyncArg, options?: ReadFileSyncOptions) => string | Buffer;
  };
  const sharedNodeFs: MutableFsModule = requireFromHere('node:fs');
  const originalReadFileSync = sharedNodeFs.readFileSync;
  sharedNodeFs.readFileSync = (filePath, options) => {
    const target = typeof filePath === 'string' ? filePath : '';
    if (target && path.resolve(target).toLowerCase() === path.resolve(delayedArtifactPath).toLowerCase()) {
      const start = Date.now();
      while (Date.now() - start < 350) {
        // Intentional busy wait to simulate a heavy synchronous artifact read.
      }
    }
    return originalReadFileSync(filePath, options);
  };

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const statusStartMs = Date.now();
    const statusPromise = requestJson(`${baseUrl}/status/terminal-metadata`, {
      method: 'POST',
      timeoutMs: 5000,
      body: JSON.stringify({
        running: false,
        requestId,
        taskKind: 'summary',
        terminalState: 'completed',
        promptCharacterCount: 1,
        inputTokens: 1,
        outputCharacterCount: 1,
        outputTokens: 1,
        requestDurationMs: 1,
      }),
    }).then((response) => ({
      response,
      resolvedAtMs: Date.now(),
    }));

    await new Promise((resolve) => setTimeout(resolve, 10));
    const healthStartMs = Date.now();
    const healthResponse = await requestJson(`${baseUrl}/health`, { timeoutMs: 5000 });
    const healthLatencyMs = Date.now() - healthStartMs;

    const statusResult = await statusPromise;
    const statusResponse = statusResult.response;
    const statusLatencyMs = statusResult.resolvedAtMs - statusStartMs;

    assert.equal(statusResponse.statusCode, 200);
    assert.equal(healthResponse.statusCode, 200);
    assert.ok(statusLatencyMs >= 0);
    assert.ok(healthLatencyMs < 250, `expected fast /health during flush, got ${healthLatencyMs}ms`);
  } finally {
    sharedNodeFs.readFileSync = originalReadFileSync;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    process.chdir(previousCwd);
    closeRuntimeDatabase();
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('repo-search endpoint logs one model-requested command line per tool call', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-repo-search-command-log-'));
  const previousCwd = process.cwd();
  fs.writeFileSync(
    path.join(tempRoot, 'package.json'),
    JSON.stringify({ name: 'siftkit', version: '0.1.0' }, null, 2),
    'utf8',
  );
  process.chdir(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup: Record<string, string | undefined> = {
    sift_kit_status: process.env.sift_kit_status,
    SIFTKIT_STATUS_PATH: process.env.SIFTKIT_STATUS_PATH,
    SIFTKIT_CONFIG_PATH: process.env.SIFTKIT_CONFIG_PATH,
    SIFTKIT_STATUS_HOST: process.env.SIFTKIT_STATUS_HOST,
    SIFTKIT_STATUS_PORT: process.env.SIFTKIT_STATUS_PORT,
  };
  process.env.sift_kit_status = statusPath;
  process.env.SIFTKIT_STATUS_PATH = statusPath;
  process.env.SIFTKIT_CONFIG_PATH = configPath;
  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';

  const server = startStatusServer({ disableManagedLlamaStartup: true, terminalMetadataIdleDelayMs: 50 });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const lines = await captureStdoutLines(async () => {
      const response = await requestJson(`${baseUrl}/repo-search`, {
        method: 'POST',
        timeoutMs: 15000,
        body: JSON.stringify({
          prompt: 'find planner',
          repoRoot: process.cwd(),
          model: 'mock-model',
          maxTurns: 2,
          availableModels: ['mock-model'],
          mockResponses: [
            "{\"action\":\"git\",\"command\":\"git grep -n \\\"planner\\\" src\"}",
            '{"action":"finish","output":"done"}',
          ],
          mockCommandResults: {
            'git grep -n "planner" src': { exitCode: 0, stdout: 'src/example.ts:1:planner', stderr: '' },
          },
        }),
      });
      assert.equal(response.statusCode, 200);
    });

    const commandLines = lines.filter((line) => /rs [\w-]{8} {2}command {2}t\d+\//u.test(line));
    assert.equal(commandLines.length, 1, lines.join('\n'));
    assert.match(commandLines[0], /git grep -n "planner" src$/u);
    assert.equal(/--no-ignore|--ignore-case|--glob/u.test(commandLines[0]), false, commandLines[0]);
    assert.equal(lines.some((line) => / llm_start/u.test(line)), false, lines.join('\n'));
    assert.equal(lines.some((line) => / llm_end/u.test(line)), false, lines.join('\n'));
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    process.chdir(previousCwd);
    closeRuntimeDatabase();
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildRepoSearchProgressLogBody formats command and llm progress bodies', () => {
  assert.deepEqual(
    buildRepoSearchProgressLogBody({
      kind: 'command',
      turn: 2,
      maxTurns: 9,
      promptTokenCount: 1234,
      elapsedMs: 2500,
      command: 'git grep -n "planner" src',
    }),
    { event: 'command', fields: 't2/9  prompt=1,234tok  elapsed=2s  git grep -n "planner" src', severity: 'normal' },
  );
  assert.deepEqual(
    buildRepoSearchProgressLogBody({
      kind: 'command',
      turn: 1,
      maxTurns: 2,
      promptTokenCount: 88,
      elapsedMs: 0,
      command: 'git grep -n "dashboard" .',
    }),
    { event: 'command', fields: 't1/2  prompt=88tok  elapsed=0s  git grep -n "dashboard" .', severity: 'normal' },
  );
  assert.deepEqual(
    buildRepoSearchProgressLogBody({
      kind: 'llm_start',
      turn: 18,
      maxTurns: 45,
      promptTokenCount: 312345,
      elapsedMs: 4200,
    }),
    { event: 'llm_start', fields: 't18/45  prompt=312,345tok  elapsed=4s', severity: 'normal' },
  );
  assert.deepEqual(
    buildRepoSearchProgressLogBody({
      kind: 'llm_end',
      turn: 18,
      maxTurns: 45,
      promptTokenCount: 312345,
      elapsedMs: 7800,
    }),
    { event: 'llm_end', fields: 't18/45  prompt=312,345tok  elapsed=7s', severity: 'normal' },
  );
  assert.equal(buildRepoSearchProgressLogBody({ kind: 'command', turn: 1, maxTurns: 2 }), null);
});

test('repo-search transcript artifact keeps routine normalized flags out of tool replay', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-repo-search-effective-transcript-'));
  const previousCwd = process.cwd();
  fs.writeFileSync(
    path.join(tempRoot, 'package.json'),
    JSON.stringify({ name: 'siftkit', version: '0.1.0' }, null, 2),
    'utf8',
  );
  fs.mkdirSync(path.join(tempRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, 'src', 'index.ts'), 'export const needle = true;\n', 'utf8');
  process.chdir(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const runtimeDbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
  const envBackup: Record<string, string | undefined> = {
    sift_kit_status: process.env.sift_kit_status,
    SIFTKIT_STATUS_PATH: process.env.SIFTKIT_STATUS_PATH,
    SIFTKIT_CONFIG_PATH: process.env.SIFTKIT_CONFIG_PATH,
    SIFTKIT_STATUS_HOST: process.env.SIFTKIT_STATUS_HOST,
    SIFTKIT_STATUS_PORT: process.env.SIFTKIT_STATUS_PORT,
  };
  process.env.sift_kit_status = statusPath;
  process.env.SIFTKIT_STATUS_PATH = statusPath;
  process.env.SIFTKIT_CONFIG_PATH = configPath;
  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await requestJson(`${baseUrl}/repo-search`, {
      method: 'POST',
      timeoutMs: 15000,
      body: JSON.stringify({
        prompt: 'find needle',
        repoRoot: process.cwd(),
        model: 'mock-model',
        maxTurns: 2,
        availableModels: ['mock-model'],
        mockResponses: [
          '{"action":"git","command":"git grep -n \\"needle\\" src"}',
          '{"action":"finish","output":"done"}',
        ],
        mockCommandResults: {
          'git grep -n "needle" src': { exitCode: 0, stdout: 'src/index.ts:1:needle', stderr: '' },
        },
      }),
    });

    assert.equal(response.statusCode, 200);
    const database = new Database(runtimeDbPath, { readonly: true });
    try {
      const transcriptArtifact = JsonRecordReader.asObject(database.prepare(
        "SELECT content_text FROM runtime_artifacts WHERE artifact_kind = 'repo_search_transcript' ORDER BY created_at_utc DESC LIMIT 1"
      ).get());
      const transcriptText = String(transcriptArtifact?.content_text || '');
      const transcriptEvents = transcriptText
        .trim()
        .split(/\r?\n/u)
        .filter((line) => line.length > 0)
        .map((line) => asObject(parseJsonValueText(line)));
      const turnMessagesEvent = transcriptEvents.find((event) => (
        event.kind === 'turn_new_messages' && event.turn === 2
      ));
      const messages = asObjectArray(turnMessagesEvent?.messages);
      const assistantMessage = messages.find((message) => (
        message.role === 'assistant' && Array.isArray(message.tool_calls)
      ));
      const toolCalls = asObjectArray(assistantMessage?.tool_calls);
      const firstCallFunction = asObject(toolCalls[0]?.function);
      const firstCallArgs = asObject(parseJsonValueText(String(firstCallFunction.arguments || '{}')));
      assert.equal(String(firstCallFunction.name || ''), 'git');
      assert.equal(String(firstCallArgs.command || ''), 'git grep -n "needle" src');
      assert.doesNotMatch(String(firstCallArgs.command || ''), /--no-ignore|--ignore-case|--glob/u);
    } finally {
      database.close();
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    process.chdir(previousCwd);
    closeRuntimeDatabase();
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('repo-search transcript artifact replays the fitted read range using per-tool context limits', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-repo-search-bounded-transcript-'));
  const previousCwd = process.cwd();
  fs.writeFileSync(
    path.join(tempRoot, 'package.json'),
    JSON.stringify({ name: 'siftkit', version: '0.1.0' }, null, 2),
    'utf8',
  );
  fs.mkdirSync(path.join(tempRoot, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(tempRoot, 'src', 'big.ts'),
    Array.from({ length: 900 }, (_, index) => `export const line${index + 1} = '${'x'.repeat(240)}';`).join('\n'),
    'utf8',
  );
  process.chdir(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const runtimeDbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
  const envBackup: Record<string, string | undefined> = {
    sift_kit_status: process.env.sift_kit_status,
    SIFTKIT_STATUS_PATH: process.env.SIFTKIT_STATUS_PATH,
    SIFTKIT_CONFIG_PATH: process.env.SIFTKIT_CONFIG_PATH,
    SIFTKIT_STATUS_HOST: process.env.SIFTKIT_STATUS_HOST,
    SIFTKIT_STATUS_PORT: process.env.SIFTKIT_STATUS_PORT,
  };
  process.env.sift_kit_status = statusPath;
  process.env.SIFTKIT_STATUS_PATH = statusPath;
  process.env.SIFTKIT_CONFIG_PATH = configPath;
  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await requestJson(`${baseUrl}/repo-search`, {
      method: 'POST',
      timeoutMs: 15000,
      body: JSON.stringify({
        prompt: 'read bounded evidence',
        repoRoot: process.cwd(),
        model: 'mock-model',
        maxTurns: 4,
        availableModels: ['mock-model'],
        mockResponses: [
          '{"action":"git","command":"git status --short"}',
          '{"action":"read","path":"src/big.ts","offset":300,"limit":601}',
          '{"action":"finish","output":"done"}',
        ],
        mockCommandResults: {
          'git status --short': { exitCode: 0, stdout: 'slow evidence', stderr: '', delayMs: 40 },
        },
      }),
    });

    assert.equal(response.statusCode, 200);
    const database = new Database(runtimeDbPath, { readonly: true });
    try {
      const transcriptArtifact = JsonRecordReader.asObject(database.prepare(
        "SELECT content_text FROM runtime_artifacts WHERE artifact_kind = 'repo_search_transcript' ORDER BY created_at_utc DESC LIMIT 1"
      ).get());
      const transcriptText = String(transcriptArtifact?.content_text || '');
      const transcriptEvents = transcriptText
        .trim()
        .split(/\r?\n/u)
        .filter((line) => line.length > 0)
        .map((line) => asObject(parseJsonValueText(line)));
      const turnMessagesEvent = transcriptEvents.find((event) => (
        event.kind === 'turn_new_messages' && event.turn === 3
      ));
      const messages = asObjectArray(turnMessagesEvent?.messages);
      const assistantMessage = messages.find((message) => (
        message.role === 'assistant' && Array.isArray(message.tool_calls)
      ));
      const toolMessage = messages.find((message) => message.role === 'tool');
      const toolCalls = asObjectArray(assistantMessage?.tool_calls);
      const firstCallFunction = asObject(toolCalls[0]?.function);
      const firstCallArgs = asObject(parseJsonValueText(String(firstCallFunction.arguments || '{}')));
      assert.equal(String(firstCallFunction.name || ''), 'read');
      assert.equal(firstCallArgs.path, 'src/big.ts');
      assert.equal(firstCallArgs.offset, 300);
      assert.equal(typeof firstCallArgs.limit, 'number');
      assert.equal(Number(firstCallArgs.limit) < 601, true);
      assert.match(String(toolMessage?.content || ''), /\d+ lines truncated due to per-tool context limit\./u);
    } finally {
      database.close();
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    process.chdir(previousCwd);
    closeRuntimeDatabase();
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('repo-search endpoint reloads executor module per request', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-repo-search-reload-'));
  const previousCwd = process.cwd();
  fs.writeFileSync(
    path.join(tempRoot, 'package.json'),
    JSON.stringify({ name: 'siftkit', version: '0.1.0' }, null, 2),
    'utf8',
  );
  process.chdir(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup: Record<string, string | undefined> = {
    sift_kit_status: process.env.sift_kit_status,
    SIFTKIT_STATUS_PATH: process.env.SIFTKIT_STATUS_PATH,
    SIFTKIT_CONFIG_PATH: process.env.SIFTKIT_CONFIG_PATH,
    SIFTKIT_STATUS_HOST: process.env.SIFTKIT_STATUS_HOST,
    SIFTKIT_STATUS_PORT: process.env.SIFTKIT_STATUS_PORT,
  };
  process.env.sift_kit_status = statusPath;
  process.env.SIFTKIT_STATUS_PATH = statusPath;
  process.env.SIFTKIT_CONFIG_PATH = configPath;
  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const repoSearchModulePath = requireFromHere.resolve('../dist/repo-search/index.js');
  const priorCacheEntry = requireFromHere.cache[repoSearchModulePath];

  try {
    const mockModule = new Module(repoSearchModulePath);
    mockModule.filename = repoSearchModulePath;
    mockModule.loaded = true;
    mockModule.exports = {
      executeRepoSearchRequest: async () => ({
        requestId: 'cache-hit',
        transcriptPath: '',
        artifactPath: '',
        scorecard: {
          runId: 'cache-hit',
          model: 'cache-hit',
          tasks: [{
            id: 'repo-search',
            question: 'cache-hit',
            reason: 'finish',
            turnsUsed: 0,
            safetyRejects: 0,
            invalidResponses: 0,
            commandFailures: 0,
            commands: [],
            finalOutput: 'CACHE_HIT_OUTPUT',
            passed: true,
            missingSignals: [],
          }],
          totals: {
            tasks: 1,
            passed: 1,
            failed: 0,
            commandsExecuted: 0,
            safetyRejects: 0,
            invalidResponses: 0,
            commandFailures: 0,
          },
          verdict: 'pass',
          failureReasons: [],
        },
      }),
    };
    requireFromHere.cache[repoSearchModulePath] = mockModule;

    const response = await requestJson(`${baseUrl}/repo-search`, {
      method: 'POST',
      timeoutMs: 15000,
      body: JSON.stringify({
        prompt: 'find x',
        repoRoot: process.cwd(),
        model: 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf',
        maxTurns: 1,
        availableModels: ['Qwen3.5-35B-A3B-UD-Q4_K_L.gguf'],
        mockResponses: [
          "{\"action\":\"git\",\"command\":\"git grep -n \\\"x\\\" src\"}",
          'Terminal synthesis answer: src/example.ts:1.',
        ],
        mockCommandResults: {
          'git grep -n "x" src': { exitCode: 0, stdout: 'src/example.ts:1:x', stderr: '' },
        },
      }),
    });

    assert.equal(response.statusCode, 200);
    const scorecard = asObject(response.body.scorecard);
    const finalOutput = String(asObject(asObjectArray(scorecard.tasks)[0]).finalOutput || '');
    assert.notEqual(finalOutput, 'CACHE_HIT_OUTPUT');
  } finally {
    if (priorCacheEntry) {
      requireFromHere.cache[repoSearchModulePath] = priorCacheEntry;
    } else {
      delete requireFromHere.cache[repoSearchModulePath];
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    process.chdir(previousCwd);
    closeRuntimeDatabase();
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('repo-search endpoint rejects duplicated final output before sending success response', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-repo-search-response-sanity-'));
  const previousCwd = process.cwd();
  fs.writeFileSync(
    path.join(tempRoot, 'package.json'),
    JSON.stringify({ name: 'siftkit', version: '0.1.0' }, null, 2),
    'utf8',
  );
  process.chdir(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup: Record<string, string | undefined> = {
    sift_kit_status: process.env.sift_kit_status,
    SIFTKIT_STATUS_PATH: process.env.SIFTKIT_STATUS_PATH,
    SIFTKIT_CONFIG_PATH: process.env.SIFTKIT_CONFIG_PATH,
    SIFTKIT_STATUS_HOST: process.env.SIFTKIT_STATUS_HOST,
    SIFTKIT_STATUS_PORT: process.env.SIFTKIT_STATUS_PORT,
  };
  process.env.sift_kit_status = statusPath;
  process.env.SIFTKIT_STATUS_PATH = statusPath;
  process.env.SIFTKIT_CONFIG_PATH = configPath;
  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';

  const duplicatedFinalOutput = [
    'src/alpha.ts:1 covers the first anchor.',
    'src/beta.ts:2 covers the second anchor.',
    'src/gamma.ts:3 covers the third anchor.',
    '',
    'Conclusion: enough evidence was found.',
    'src/alpha.ts:1 covers the first anchor.',
    'src/beta.ts:2 covers the second anchor.',
    'src/gamma.ts:3 covers the third anchor.',
    '',
    'Conclusion: enough evidence was found.',
  ].join('\n');
  const commands = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map((term) => `git grep -n "${term}" src`);
  const mockCommandResults = Object.fromEntries(commands.map((command, index) => [
    command,
    { exitCode: 0, stdout: `src/${index}.ts:1:${command}`, stderr: '' },
  ]));

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await requestJson(`${baseUrl}/repo-search`, {
      method: 'POST',
      timeoutMs: 15000,
      body: JSON.stringify({
        prompt: 'find duplicated response',
        repoRoot: process.cwd(),
        model: 'mock-model',
        maxTurns: 8,
        availableModels: ['mock-model'],
        mockResponses: [
          ...commands.map((command) => JSON.stringify({
            action: 'git',
            command,
          })),
          JSON.stringify({ action: 'finish', output: duplicatedFinalOutput }),
        ],
        mockCommandResults,
      }),
    });

    assert.equal(response.statusCode, 500);
    assert.match(String(response.body.error || ''), /Repo-search response sanity check failed/u);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    process.chdir(previousCwd);
    closeRuntimeDatabase();
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

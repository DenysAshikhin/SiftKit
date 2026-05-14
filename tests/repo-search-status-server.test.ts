import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';

import { startStatusServer, buildRepoSearchProgressLogMessage } from '../dist/status-server/index.js';
import { closeRuntimeDatabase } from '../dist/state/runtime-db.js';

const requireFromHere = createRequire(__filename);
const Database = requireFromHere('better-sqlite3') as new (path: string, options?: { readonly?: boolean }) => {
  prepare: (sql: string) => { get: (...args: unknown[]) => Record<string, unknown> | undefined };
  close: () => void;
};
const runtimeHelpers = requireFromHere('./_runtime-helpers.js') as {
  writeManagedLlamaScripts: (tempRoot: string, port: number, modelId?: string, options?: {
    launchHangingProcess?: boolean;
  }) => {
    baseUrl: string;
    modelPath: string;
    startupScriptPath: string;
    shutdownScriptPath: string;
    readyFilePath: string;
  };
  getFreePort: () => Promise<number>;
  waitForAsyncExpectation: (expectation: () => Promise<void>, timeoutMs?: number) => Promise<void>;
  startStatusServerProcess: (options: {
    statusPath: string;
    configPath: string;
    idleSummaryDbPath?: string;
    idleSummaryDelayMs?: number;
    terminalMetadataIdleDelayMs?: number;
    disableManagedLlamaStartup?: boolean;
  }) => Promise<{
    statusUrl: string;
    close: () => Promise<void>;
  }>;
};

type JsonResponse = { statusCode: number; body: Record<string, unknown> };
type RequestOptions = { method?: string; body?: string; timeoutMs?: number };

async function captureStdoutLines(fn: () => Promise<void>): Promise<string[]> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const lines: string[] = [];
  let buffer = '';
  process.stdout.write = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    buffer += text;
    const parts = buffer.split(/\r?\n/u);
    buffer = parts.pop() || '';
    for (const line of parts) {
      if (line.trim()) lines.push(line);
    }
    return originalWrite(chunk, encodingOrCallback as BufferEncoding, callback);
  };
  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  if (buffer.trim()) lines.push(buffer.trim());
  return lines;
}

function requestJson(url: string, options: RequestOptions = {}): Promise<JsonResponse> {
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
        response.on('data', (chunk: string) => {
          responseText += chunk;
        });
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode || 0,
            body: responseText ? JSON.parse(responseText) as Record<string, unknown> : {},
          });
        });
      },
    );
    request.on('error', reject);
    request.setTimeout(Number(options.timeoutMs || 4000), () => {
      request.destroy(new Error('request timeout'));
    });
    if (options.body) {
      request.write(options.body);
    }
    request.end();
  });
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
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const baselineStatus = await requestJson(`${baseUrl}/status`);
    const baselineMetrics = (baselineStatus.body?.metrics as Record<string, unknown>) || {};
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
          "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"x\\\" src\"}",
          '{"action":"finish","output":"done","confidence":0.9}',
        ],
        mockCommandResults: {
          'rg -n "x" src': { exitCode: 0, stdout: 'src/example.ts:1:x', stderr: '', delayMs: 2000 },
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

    await runtimeHelpers.waitForAsyncExpectation(async () => {
      const finalStatus = await requestJson(`${baseUrl}/status`);
      const finalMetrics = (finalStatus.body?.metrics as Record<string, unknown>) || {};
      if (searchResponse.statusCode >= 200 && searchResponse.statusCode < 300) {
        assert.ok(Number(finalMetrics.completedRequestCount || 0) >= baselineCompleted + 1);
      } else {
        assert.ok(Number(finalMetrics.completedRequestCount || 0) >= baselineCompleted);
      }
      assert.ok(Number(finalMetrics.outputTokensTotal || 0) > 0);
      assert.ok(Number(finalMetrics.toolTokensTotal || 0) > 0);
      const taskTotals = (finalMetrics.taskTotals as Record<string, unknown>) || {};
      const repoTaskTotals = ((taskTotals['repo-search'] as Record<string, unknown>) || {});
      assert.ok(Number(repoTaskTotals.outputTokensTotal || 0) > 0);
      assert.ok(Number(repoTaskTotals.toolTokensTotal || 0) > 0);
      const toolStats = ((finalMetrics.toolStats as Record<string, unknown>) || {});
      const repoToolStats = ((toolStats['repo-search'] as Record<string, unknown>) || {});
      assert.ok(Number((((repoToolStats.rg || {}) as Record<string, unknown>).calls) || 0) >= 1);
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
  const address = server.address() as AddressInfo;
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
          '{"action":"finish","output":"done","confidence":0.9}',
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

  const llamaPort = await runtimeHelpers.getFreePort();
  const managed = runtimeHelpers.writeManagedLlamaScripts(tempRoot, llamaPort, 'managed-test-model', {
    launchHangingProcess: true,
  });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    Backend: 'llama.cpp',
    Model: 'managed-test-model',
    Runtime: {
      Model: 'managed-test-model',
      LlamaCpp: {
        BaseUrl: managed.baseUrl,
        NumCtx: 32000,
        ModelPath: managed.modelPath,
      },
    },
    Server: {
      LlamaCpp: {
        BaseUrl: managed.baseUrl,
        ExecutablePath: managed.startupScriptPath,
        ModelPath: managed.modelPath,
        StartupTimeoutMs: 250,
        HealthcheckTimeoutMs: 20,
        HealthcheckIntervalMs: 20,
      },
    },
  }, null, 2)}\n`, 'utf8');

  const server = startStatusServer();
  await server.startupPromise;
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const firstRequest = requestJson(`${baseUrl}/repo-search`, {
      method: 'POST',
      timeoutMs: 2500,
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
      timeoutMs: 2500,
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

  const llamaPort = await runtimeHelpers.getFreePort();
  const managed = runtimeHelpers.writeManagedLlamaScripts(tempRoot, llamaPort, 'managed-test-model', {
    launchHangingProcess: true,
  });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    Backend: 'llama.cpp',
    Model: 'managed-test-model',
    Runtime: {
      Model: 'managed-test-model',
      LlamaCpp: {
        BaseUrl: managed.baseUrl,
        NumCtx: 32000,
        ModelPath: managed.modelPath,
      },
    },
    Server: {
      LlamaCpp: {
        BaseUrl: managed.baseUrl,
        ExecutablePath: managed.startupScriptPath,
        ModelPath: managed.modelPath,
        StartupTimeoutMs: 900,
        HealthcheckTimeoutMs: 20,
        HealthcheckIntervalMs: 20,
      },
    },
  }, null, 2)}\n`, 'utf8');

  const server = startStatusServer();
  await runtimeHelpers.waitForAsyncExpectation(async () => {
    assert.notEqual(server.address(), null);
  }, 1000);
  const address = server.address() as AddressInfo;
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

  const sharedNodeFs = requireFromHere('node:fs') as {
    readFileSync: (...args: unknown[]) => unknown;
  };
  const originalReadFileSync = sharedNodeFs.readFileSync;
  sharedNodeFs.readFileSync = (...args: unknown[]) => {
    const target = typeof args[0] === 'string' ? args[0] : '';
    if (target && path.resolve(target).toLowerCase() === path.resolve(delayedArtifactPath).toLowerCase()) {
      const start = Date.now();
      while (Date.now() - start < 350) {
        // Intentional busy wait to simulate a heavy synchronous artifact read.
      }
    }
    return originalReadFileSync(...args);
  };

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = server.address() as AddressInfo;
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
  const address = server.address() as AddressInfo;
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
            "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"planner\\\" src\"}",
            '{"action":"finish","output":"done","confidence":0.9}',
          ],
          mockCommandResults: {
            'rg -n "planner" src': { exitCode: 0, stdout: 'src/example.ts:1:planner', stderr: '' },
          },
        }),
      });
      assert.equal(response.statusCode, 200);
    });

    const commandLines = lines.filter((line) => /repo_search command turn=/u.test(line));
    assert.equal(commandLines.length, 1, lines.join('\n'));
    assert.match(commandLines[0], /command=rg -n "planner" src$/u);
    assert.equal(/--no-ignore|--ignore-case|--glob/u.test(commandLines[0]), false, commandLines[0]);
    assert.equal(lines.some((line) => /repo_search llm_start/u.test(line)), false, lines.join('\n'));
    assert.equal(lines.some((line) => /repo_search llm_end/u.test(line)), false, lines.join('\n'));
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

test('buildRepoSearchProgressLogMessage formats planner and repo-search command progress lines', () => {
  const msg1 = buildRepoSearchProgressLogMessage({
    turn: 2,
    maxTurns: 9,
    promptTokenCount: 1234,
    elapsedMs: 2500,
    command: 'rg -n "planner" src',
  }, 'repo_search');
  assert.ok(msg1);
  assert.match(msg1, /^repo_search command turn=2\/9 prompt_tokens=1,234 elapsed=2s command=rg -n "planner" src$/u);
  const msg2 = buildRepoSearchProgressLogMessage({
    turn: 1,
    maxTurns: 2,
    promptTokenCount: 88,
    elapsedMs: 0,
    command: 'rg -n "dashboard" .',
  }, 'planner');
  assert.ok(msg2);
  assert.match(msg2, /^planner command turn=1\/2 prompt_tokens=88 elapsed=0s command=rg -n "dashboard" \.$/u);
  const msg3 = buildRepoSearchProgressLogMessage({
    kind: 'llm_start',
    turn: 18,
    maxTurns: 45,
    promptTokenCount: 312345,
    elapsedMs: 4200,
  }, 'repo_search');
  assert.ok(msg3);
  assert.match(msg3, /^repo_search llm_start turn=18\/45 prompt_tokens=312,345 elapsed=4s$/u);
  const msg4 = buildRepoSearchProgressLogMessage({
    kind: 'llm_end',
    turn: 18,
    maxTurns: 45,
    promptTokenCount: 312345,
    elapsedMs: 7800,
  }, 'repo_search');
  assert.ok(msg4);
  assert.match(msg4, /^repo_search llm_end turn=18\/45 prompt_tokens=312,345 elapsed=7s$/u);
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
  const address = server.address() as AddressInfo;
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
          '{"action":"repo_rg","command":"rg -n \\"needle\\" src"}',
          '{"action":"finish","output":"done","confidence":0.9}',
        ],
        mockCommandResults: {
          'rg -n "needle" src': { exitCode: 0, stdout: 'src/index.ts:1:needle', stderr: '' },
        },
      }),
    });

    assert.equal(response.statusCode, 200);
    const database = new Database(runtimeDbPath, { readonly: true });
    try {
      const transcriptArtifact = database.prepare(
        "SELECT content_text FROM runtime_artifacts WHERE artifact_kind = 'repo_search_transcript' ORDER BY created_at_utc DESC LIMIT 1"
      ).get();
      const transcriptText = String(transcriptArtifact?.content_text || '');
      const transcriptEvents = transcriptText
        .trim()
        .split(/\r?\n/u)
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const turnMessagesEvent = transcriptEvents.find((event) => (
        event.kind === 'turn_new_messages' && event.turn === 2
      ));
      const messages = Array.isArray(turnMessagesEvent?.messages)
        ? turnMessagesEvent.messages as Record<string, unknown>[]
        : [];
      const assistantMessage = messages.find((message) => (
        message.role === 'assistant' && Array.isArray(message.tool_calls)
      ));
      const toolCalls = Array.isArray(assistantMessage?.tool_calls)
        ? assistantMessage.tool_calls as Record<string, unknown>[]
        : [];
      const firstCallFunction = (toolCalls[0]?.function || {}) as Record<string, unknown>;
      const firstCallArgs = JSON.parse(String(firstCallFunction.arguments || '{}')) as { command?: string };
      assert.equal(String(firstCallFunction.name || ''), 'repo_rg');
      assert.equal(String(firstCallArgs.command || ''), 'rg -n "needle" src');
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

test('repo-search transcript artifact replays fitted repo_read_file range using per-tool context limits', async () => {
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
  const address = server.address() as AddressInfo;
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
          '{"action":"repo_git","command":"git status --short"}',
          '{"action":"repo_read_file","path":"src/big.ts","startLine":300,"endLine":900}',
          '{"action":"finish","output":"done","confidence":0.9}',
        ],
        mockCommandResults: {
          'git status --short': { exitCode: 0, stdout: 'slow evidence', stderr: '', delayMs: 40 },
        },
      }),
    });

    assert.equal(response.statusCode, 200);
    const database = new Database(runtimeDbPath, { readonly: true });
    try {
      const transcriptArtifact = database.prepare(
        "SELECT content_text FROM runtime_artifacts WHERE artifact_kind = 'repo_search_transcript' ORDER BY created_at_utc DESC LIMIT 1"
      ).get();
      const transcriptText = String(transcriptArtifact?.content_text || '');
      const transcriptEvents = transcriptText
        .trim()
        .split(/\r?\n/u)
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const turnMessagesEvent = transcriptEvents.find((event) => (
        event.kind === 'turn_new_messages' && event.turn === 3
      ));
      const messages = Array.isArray(turnMessagesEvent?.messages)
        ? turnMessagesEvent.messages as Record<string, unknown>[]
        : [];
      const assistantMessage = messages.find((message) => (
        message.role === 'assistant' && Array.isArray(message.tool_calls)
      ));
      const toolMessage = messages.find((message) => message.role === 'tool');
      const toolCalls = Array.isArray(assistantMessage?.tool_calls)
        ? assistantMessage.tool_calls as Record<string, unknown>[]
        : [];
      const firstCallFunction = (toolCalls[0]?.function || {}) as Record<string, unknown>;
      const firstCallArgs = JSON.parse(String(firstCallFunction.arguments || '{}')) as {
        path?: string;
        startLine?: number;
        endLine?: number;
      };
      assert.equal(String(firstCallFunction.name || ''), 'repo_read_file');
      assert.equal(firstCallArgs.path, 'src/big.ts');
      assert.equal(firstCallArgs.startLine, 300);
      assert.equal(typeof firstCallArgs.endLine, 'number');
      assert.equal(Number(firstCallArgs.endLine) < 900, true);
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
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const repoSearchModulePath = requireFromHere.resolve('../dist/repo-search/index.js');
  const priorCacheEntry = requireFromHere.cache[repoSearchModulePath];

  try {
    requireFromHere.cache[repoSearchModulePath] = {
      id: repoSearchModulePath,
      filename: repoSearchModulePath,
      loaded: true,
      exports: {
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
      },
    } as unknown as NodeJS.Require['cache'][string];

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
          "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"x\\\" src\"}",
          'Terminal synthesis answer: src/example.ts:1.',
        ],
        mockCommandResults: {
          'rg -n "x" src': { exitCode: 0, stdout: 'src/example.ts:1:x', stderr: '' },
        },
      }),
    });

    assert.equal(response.statusCode, 200);
    const scorecard = response.body?.scorecard as { tasks?: Array<{ finalOutput?: string }> } | undefined;
    const finalOutput = String(scorecard?.tasks?.[0]?.finalOutput || '');
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
  const commands = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map((term) => `rg -n "${term}" src`);
  const mockCommandResults = Object.fromEntries(commands.map((command, index) => [
    command,
    { exitCode: 0, stdout: `src/${index}.ts:1:${command}`, stderr: '' },
  ]));

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = server.address() as AddressInfo;
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
            action: 'repo_rg',
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

test('repo-search wakes managed llama when the managed process is offline', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-repo-search-idle-wakeup-'));
  const previousCwd = process.cwd();
  fs.writeFileSync(
    path.join(tempRoot, 'package.json'),
    JSON.stringify({ name: 'siftkit', version: '0.1.0' }, null, 2),
    'utf8',
  );
  process.chdir(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const llamaPort = await runtimeHelpers.getFreePort();
  const managed = runtimeHelpers.writeManagedLlamaScripts(tempRoot, llamaPort);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    Backend: 'llama.cpp',
    Model: 'managed-test-model',
    LlamaCpp: {
      BaseUrl: managed.baseUrl,
      NumCtx: 32000,
    },
    Runtime: {
      Model: 'managed-test-model',
      LlamaCpp: {
        BaseUrl: managed.baseUrl,
        ModelPath: managed.modelPath,
      },
    },
    Server: {
      LlamaCpp: {
        BaseUrl: managed.baseUrl,
        ExecutablePath: managed.startupScriptPath,
        ModelPath: managed.modelPath,
        StartupTimeoutMs: 5000,
        HealthcheckTimeoutMs: 100,
        HealthcheckIntervalMs: 10,
      },
    },
  }, null, 2)}\n`, 'utf8');

  const server = await runtimeHelpers.startStatusServerProcess({
    statusPath,
    configPath,
    idleSummaryDelayMs: 80,
    terminalMetadataIdleDelayMs: 50,
  });
  const baseUrl = new URL(server.statusUrl).origin;

  try {
    await runtimeHelpers.waitForAsyncExpectation(async () => {
      const modelsResponse = await requestJson(`${managed.baseUrl}/v1/models`);
      assert.equal(modelsResponse.statusCode, 200);
    }, 5000);
    assert.equal(fs.existsSync(managed.readyFilePath), true);

    await requestJson(`${baseUrl}/status`, {
      method: 'POST',
      body: JSON.stringify({
        running: true,
        requestId: 'idle-wakeup-primer',
        rawInputCharacterCount: 10,
        promptCharacterCount: 10,
      }),
    });
    await requestJson(`${baseUrl}/status/terminal-metadata`, {
      method: 'POST',
      body: JSON.stringify({
        running: false,
        requestId: 'idle-wakeup-primer',
        taskKind: 'repo-search',
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
        requestId: 'idle-wakeup-primer',
        taskKind: 'repo-search',
        terminalState: 'completed',
      }),
    });

    await runtimeHelpers.waitForAsyncExpectation(async () => {
      const statusResponse = await requestJson(server.statusUrl);
      assert.equal(statusResponse.statusCode, 200);
      assert.equal(statusResponse.body.status, 'false');
    }, 5000);
    await runtimeHelpers.waitForAsyncExpectation(async () => {
      await assert.rejects(() => requestJson(`${managed.baseUrl}/v1/models`));
    }, 5000);

    const repoSearchResponse = await requestJson(`${baseUrl}/repo-search`, {
      method: 'POST',
      timeoutMs: 15000,
      body: JSON.stringify({
        prompt: 'find wakeup path',
        repoRoot: process.cwd(),
        model: 'managed-test-model',
        maxTurns: 2,
        mockResponses: [
          "{\"action\":\"repo_rg\",\"command\":\"rg -n \\\"request\\\" src/status-server/routes/core.ts\"}",
          '{"action":"finish","output":"done","confidence":0.9}',
        ],
        mockCommandResults: {
          'rg -n "request" src/status-server/routes/core.ts': { exitCode: 0, stdout: 'src/status-server/routes/core.ts:1:request', stderr: '' },
        },
      }),
    });
    assert.equal(repoSearchResponse.statusCode, 200);

    await runtimeHelpers.waitForAsyncExpectation(async () => {
      const modelsResponse = await requestJson(`${managed.baseUrl}/v1/models`);
      assert.equal(modelsResponse.statusCode, 200);
    }, 5000);
  } finally {
    await server.close();
    process.chdir(previousCwd);
    closeRuntimeDatabase();
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // Best-effort temp cleanup on Windows.
    }
  }
});

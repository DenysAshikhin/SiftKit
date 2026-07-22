import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { summarizeRequest } from '../src/summary.js';
import { getDefaultConfig, buildRuntimeLaunchSnapshot } from '../src/status-server/config-store.js';
import { startStatusServer } from '../src/status-server/index.js';
import { InferenceRunFlushQueue } from '../src/status-server/inference-run-flush-queue.js';
import { closeRuntimeDatabase, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { JsonRecordReader } from '../src/lib/json-record-reader.js';
import { requestJson, asObject, getAddressInfo } from './helpers/dashboard-http.js';
import { requestSse } from './helpers/sse-http.js';
import { captureStdoutLines } from './helpers/stdout-capture.js';


test('summary endpoint defaults model request timeout to 240 seconds', () => {
  const routeText = fs.readFileSync(path.join(process.cwd(), 'dist', 'status-server', 'routes', 'core.js'), 'utf8');

  assert.match(routeText, /const DEFAULT_STATUS_MODEL_REQUEST_TIMEOUT_SECONDS = 240;/u);
});

test('summary endpoint forwards promptPrefix and llamaCppOverrides to the summary engine', () => {
  const routeText = fs.readFileSync(path.join(process.cwd(), 'dist', 'status-server', 'routes', 'core.js'), 'utf8');
  assert.match(routeText, /promptPrefix:\s*summaryRequest\.promptPrefix/u);
  assert.match(routeText, /llamaCppOverrides:\s*summaryRequest\.llamaCppOverrides/u);
});

test('summary endpoint waits behind the model request queue', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-summary-status-'));
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
    const repoSearch = requestSse(`${baseUrl}/repo-search`, {
      timeoutMs: 15000,
      body: {
        prompt: 'find x',
        repoRoot: process.cwd(),
        simulateWorkMs: 250,
        model: 'mock-model',
        maxTurns: 1,
        availableModels: ['mock-model'],
        mockResponses: [
          '{"action":"finish","output":"done"}',
        ],
      },
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const summaryStartedAt = Date.now();
    const summary = await requestSse(`${baseUrl}/summary`, {
      timeoutMs: 15000,
      body: {
        question: 'summarize this',
        inputText: 'Build output: warning appeared.'.repeat(50),
        format: 'text',
        policyProfile: 'general',
        backend: 'mock',
        model: 'mock-model',
      },
    });
    const summaryElapsedMs = Date.now() - summaryStartedAt;
    const search = await repoSearch;

    assert.ok(search.result);
    assert.ok(summary.result);
    assert.equal(typeof summary.result.Summary, 'string');
    assert.ok(summaryElapsedMs >= 180, `summary did not wait for model queue, elapsed=${summaryElapsedMs}`);
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

test('summary endpoint processes terminal status before granting next queued summary', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-summary-terminal-before-release-'));
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
      const first = requestSse(`${baseUrl}/summary`, {
        timeoutMs: 15000,
        body: {
          question: 'summarize this',
          inputText: 'First queued summary input.'.repeat(50),
          format: 'text',
          policyProfile: 'general',
          backend: 'mock',
          model: 'mock-model',
        },
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      const second = requestSse(`${baseUrl}/summary`, {
        timeoutMs: 15000,
        body: {
          question: 'summarize this',
          inputText: 'Second queued summary input.'.repeat(50),
          format: 'text',
          policyProfile: 'general',
          backend: 'mock',
          model: 'mock-model',
        },
      });
      const [firstResponse, secondResponse] = await Promise.all([first, second]);
      assert.ok(firstResponse.result);
      assert.ok(secondResponse.result);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
    });

    assert.equal(lines.some((line) => /stale_status_abandoned/u.test(line)), false, lines.join('\n'));
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

test('terminal metadata route enqueues immediately and drains after idle delay', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-terminal-metadata-queue-'));
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

  const server = startStatusServer({ disableManagedLlamaStartup: true, terminalMetadataIdleDelayMs: 80 });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const lines = await captureStdoutLines(async () => {
      await requestJson(`${baseUrl}/status`, {
        method: 'POST',
        body: JSON.stringify({
          running: true,
          taskKind: 'summary',
          requestId: 'queued-metadata-summary',
          statusPath,
          rawInputCharacterCount: 100,
          promptCharacterCount: 200,
          promptTokenCount: 50,
        }),
      });
      const startedAt = Date.now();
      const metadataResponse = await requestJson(`${baseUrl}/status/terminal-metadata`, {
        method: 'POST',
        body: JSON.stringify({
          running: false,
          taskKind: 'summary',
          requestId: 'queued-metadata-summary',
          statusPath,
          terminalState: 'completed',
          deferredMetadata: {
            outputTokens: 7,
          },
        }),
      });
      const responseElapsedMs = Date.now() - startedAt;
      assert.equal(metadataResponse.statusCode, 200);
      assert.equal(metadataResponse.body.queued, true);
      assert.ok(responseElapsedMs < 50, `terminal metadata post waited ${responseElapsedMs}ms`);
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    });

    assert.equal(lines.some((line) => /st queued-m {2}drain_wait {2}state=completed wait_ms=\d+ active=false q=1 model_q=0/u.test(line)), true, lines.join('\n'));
    const waitIndex = lines.findIndex((line) => /st queued-m {2}drain_wait/u.test(line));
    const processIndex = lines.findIndex((line) => /st queued-m {2}terminal_metadata_process_done/u.test(line));
    assert.ok(waitIndex >= 0 && processIndex > waitIndex, lines.join('\n'));
    assert.equal(lines.some((line) => /st [\w-]{8} {2}done {2}task=summary total_elapsed=0s output_tokens=7/u.test(line)), true, lines.join('\n'));
    assert.equal(lines.some((line) => /st queued-m {2}terminal_metadata_process_done {2}state=completed duration_ms=\d+/u.test(line)), true, lines.join('\n'));
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

test('terminal metadata waits for managed llama flush queue to drain first', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-terminal-metadata-after-llama-flush-'));
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

  const originalIsIdle = InferenceRunFlushQueue.prototype.isIdle;
  let llamaFlushIdle = false;
  InferenceRunFlushQueue.prototype.isIdle = function isIdleForTest(): boolean {
    return llamaFlushIdle && originalIsIdle.call(this);
  };
  const server = startStatusServer({ disableManagedLlamaStartup: true, terminalMetadataIdleDelayMs: 0 });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const lines = await captureStdoutLines(async () => {
      await requestJson(`${baseUrl}/status`, {
        method: 'POST',
        body: JSON.stringify({
          running: true,
          taskKind: 'summary',
          requestId: 'metadata-after-llama-flush',
          statusPath,
          rawInputCharacterCount: 100,
          promptCharacterCount: 200,
          promptTokenCount: 50,
        }),
      });
      await requestJson(`${baseUrl}/status/terminal-metadata`, {
        method: 'POST',
        body: JSON.stringify({
          running: false,
          taskKind: 'summary',
          requestId: 'metadata-after-llama-flush',
          statusPath,
          terminalState: 'completed',
          deferredMetadata: {
            outputTokens: 9,
          },
        }),
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      const waitingStatus = await requestJson(`${baseUrl}/status`);
      assert.equal(waitingStatus.body.status, 'true');
      llamaFlushIdle = true;
      await new Promise<void>((resolve) => setTimeout(resolve, 1100));
    });

    const waitIndex = lines.findIndex((line) => /st metadata {2}drain_wait/u.test(line));
    const processIndex = lines.findIndex((line) => /st metadata {2}terminal_metadata_process_done/u.test(line));
    assert.ok(waitIndex >= 0 && processIndex > waitIndex, lines.join('\n'));
    assert.equal(lines.some((line) => /st [\w-]{8} {2}done {2}task=summary total_elapsed=0s output_tokens=9/u.test(line)), true, lines.join('\n'));
  } finally {
    InferenceRunFlushQueue.prototype.isIdle = originalIsIdle;
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

test('split terminal routes clear active request before next running post', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-status-terminal-order-'));
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
      const firstRunning = await requestJson(`${baseUrl}/status`, {
        method: 'POST',
        body: JSON.stringify({
          running: true,
          taskKind: 'summary',
          requestId: 'first-summary',
          statusPath,
          rawInputCharacterCount: 100,
          promptCharacterCount: 200,
          promptTokenCount: 50,
        }),
      });
      const firstTerminalMetadata = requestJson(`${baseUrl}/status/terminal-metadata`, {
        method: 'POST',
        body: JSON.stringify({
          running: false,
          taskKind: 'summary',
          requestId: 'first-summary',
          statusPath,
          terminalState: 'completed',
          deferredMetadata: {
            outputTokens: 10,
          },
        }),
      });
      const firstComplete = requestJson(`${baseUrl}/status/complete`, {
        method: 'POST',
        body: JSON.stringify({
          requestId: 'first-summary',
          statusPath,
          taskKind: 'summary',
          terminalState: 'completed',
        }),
      });
      const [firstTerminalMetadataResponse, firstCompleteResponse] = await Promise.all([
        firstTerminalMetadata,
        firstComplete,
      ]);
      const lateFirstRunning = await requestJson(`${baseUrl}/status`, {
        method: 'POST',
        body: JSON.stringify({
          running: true,
          taskKind: 'summary',
          requestId: 'first-summary',
          statusPath,
          rawInputCharacterCount: 100,
          promptCharacterCount: 200,
          promptTokenCount: 50,
        }),
      });
      const repeatedLateFirstRunning = await requestJson(`${baseUrl}/status`, {
        method: 'POST',
        body: JSON.stringify({
          running: true,
          taskKind: 'summary',
          requestId: 'first-summary',
          statusPath,
          rawInputCharacterCount: 100,
          promptCharacterCount: 200,
          promptTokenCount: 50,
        }),
      });
      const secondRunning = await requestJson(`${baseUrl}/status`, {
        method: 'POST',
        body: JSON.stringify({
          running: true,
          taskKind: 'summary',
          requestId: 'second-summary',
          statusPath,
          rawInputCharacterCount: 10,
          promptCharacterCount: 20,
          promptTokenCount: 5,
        }),
      });
      assert.equal(firstRunning.statusCode, 200);
      assert.equal(firstTerminalMetadataResponse.statusCode, 200);
      assert.equal(firstCompleteResponse.statusCode, 200);
      assert.equal(lateFirstRunning.statusCode, 200);
      assert.equal(repeatedLateFirstRunning.statusCode, 200);
      assert.equal(secondRunning.statusCode, 200);
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
    });

    assert.equal(lines.some((line) => /stale_status_abandoned/u.test(line)), false, lines.join('\n'));
    assert.equal(lines.some((line) => /st first-su {2}complete_done {2}state=completed duration_ms=\d+/u.test(line)), true, lines.join('\n'));
    assert.equal(lines.some((line) => /st first-su {2}terminal_metadata_process_done {2}state=completed duration_ms=\d+/u.test(line)), true, lines.join('\n'));
    assert.equal(lines.some((line) => /st [\w-]{8} {2}done {2}task=summary total_elapsed=0s output_tokens=10/u.test(line)), true, lines.join('\n'));
    assert.equal(lines.filter((line) => /st first-su {2}late_running_ignored/u.test(line)).length, 2, lines.join('\n'));
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

test('legacy terminal status posts to /status are rejected', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-status-no-legacy-terminal-'));
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

  try {
    const response = await requestJson(`${baseUrl}/status`, {
      method: 'POST',
      body: JSON.stringify({
        running: false,
        taskKind: 'summary',
        requestId: 'legacy-terminal',
        statusPath,
        terminalState: 'completed',
      }),
    });

    assert.equal(response.statusCode, 400);
    assert.match(String(response.body.error || ''), /Terminal status must use/u);
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

test('summary endpoint returns, logs, and persists diagnostics for 500 responses', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-summary-error-'));
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
    SIFTKIT_TEST_PROVIDER_BEHAVIOR: process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR,
  };
  process.env.sift_kit_status = statusPath;
  process.env.SIFTKIT_STATUS_PATH = statusPath;
  process.env.SIFTKIT_CONFIG_PATH = configPath;
  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';
  process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR = 'throw';

  let stderrText = '';
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (
    chunk: string | Uint8Array,
    _encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    _callback?: (error?: Error | null) => void,
  ): boolean => {
    stderrText += String(chunk);
    return true;
  };

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const summary = await requestSse(`${baseUrl}/summary`, {
      timeoutMs: 15000,
      body: {
        question: 'summarize this',
        inputText: 'Build output: warning appeared.'.repeat(50),
        format: 'text',
        policyProfile: 'general',
        backend: 'mock',
        model: 'mock-model',
      },
    });

    assert.equal(summary.statusCode, 200);
    assert.equal(summary.errorMessage, 'mock provider failure');
    assert.equal(typeof summary.error?.diagnosticId, 'string');
    assert.match(stderrText, /\[siftKitStatus\] request_error/u);
    assert.match(stderrText, /route=\/summary/u);
    assert.match(stderrText, /error_name=Error/u);
    assert.match(stderrText, /mock provider failure/u);

    const database = getRuntimeDatabase();
    const row = JsonRecordReader.asObject(database.prepare(`
      SELECT id, route, method, status_code, error_name, error_message, error_stack, diagnostic_json
      FROM runtime_error_events
      WHERE id = ?
    `).get(String(summary.error?.diagnosticId)));
    assert.equal(row?.route, '/summary');
    assert.equal(row?.method, 'POST');
    assert.equal(row?.status_code, 500);
    assert.equal(row?.error_name, 'Error');
    assert.equal(row?.error_message, 'mock provider failure');
    assert.equal(typeof row?.error_stack, 'string');
    assert.match(String(row?.diagnostic_json), /mock provider failure/u);
  } finally {
    process.stderr.write = originalStderrWrite;
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

test('command-output endpoint analyzes captured command output on the server', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-command-output-route-'));
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

  try {
    const response = await requestSse(`${baseUrl}/command-output/analyze`, {
      body: {
        outputKind: 'command',
        exitCode: 0,
        combinedText: 'Build completed. All tests passed.',
        question: 'Did it pass?',
        noSummarize: true,
      },
    });

    assert.ok(response.result);
    assert.equal(response.result.ExitCode, 0);
    assert.equal(response.result.WasSummarized, false);
    assert.equal(typeof response.result.RawLogPath, 'string');
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

test('summarizeRequest uses explicit config without requiring config service', async () => {
  const envBackup: Record<string, string | undefined> = {
    SIFTKIT_STATUS_BACKEND_URL: process.env.SIFTKIT_STATUS_BACKEND_URL,
    SIFTKIT_CONFIG_SERVICE_URL: process.env.SIFTKIT_CONFIG_SERVICE_URL,
  };
  process.env.SIFTKIT_STATUS_BACKEND_URL = 'http://127.0.0.1:1/status';
  process.env.SIFTKIT_CONFIG_SERVICE_URL = 'http://127.0.0.1:1/config';

  try {
    const config = getDefaultConfig();
    const runtimeSnapshot = buildRuntimeLaunchSnapshot(config);
    config.Runtime.LlamaCpp = runtimeSnapshot.LlamaCpp;
    config.Server.ModelPresets.Presets[0].Model = 'mock-model';
    const result = await summarizeRequest({
      question: 'summarize this',
      inputText: 'Build output: warning appeared.'.repeat(50),
      format: 'text',
      policyProfile: 'general',
      backend: 'mock',
      model: 'mock-model',
      statusBackendUrl: 'http://127.0.0.1:1/status',
      config,
    });

    assert.equal(result.ModelCallSucceeded, true);
    assert.equal(result.Backend, 'mock');
  } finally {
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

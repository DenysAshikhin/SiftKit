import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import type { SiftConfig } from '../dist/config/index.js';
import { summarizeRequest } from '../dist/summary.js';
import { getDefaultConfig } from '../dist/status-server/config-store.js';
import { startStatusServer } from '../dist/status-server/index.js';
import { ManagedLlamaFlushQueue } from '../dist/status-server/managed-llama-flush-queue.js';
import { closeRuntimeDatabase, getRuntimeDatabase } from '../dist/state/runtime-db.js';

type JsonResponse = { statusCode: number; body: Record<string, unknown> };

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

function requestJson(url: string, options: { method?: string; body?: string; timeoutMs?: number } = {}): Promise<JsonResponse> {
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

test('summary endpoint defaults model request timeout to 240 seconds', () => {
  const routeText = fs.readFileSync(path.join(process.cwd(), 'dist', 'status-server', 'routes', 'core.js'), 'utf8');

  assert.match(routeText, /const DEFAULT_STATUS_MODEL_REQUEST_TIMEOUT_SECONDS = 240;/u);
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
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const repoSearch = requestJson(`${baseUrl}/repo-search`, {
      method: 'POST',
      timeoutMs: 15000,
      body: JSON.stringify({
        prompt: 'find x',
        repoRoot: process.cwd(),
        simulateWorkMs: 250,
        model: 'mock-model',
        maxTurns: 1,
        availableModels: ['mock-model'],
        mockResponses: [
          '{"action":"finish","output":"done","confidence":0.9}',
        ],
      }),
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const summaryStartedAt = Date.now();
    const summary = await requestJson(`${baseUrl}/summary`, {
      method: 'POST',
      timeoutMs: 15000,
      body: JSON.stringify({
        question: 'summarize this',
        inputText: 'Build output: warning appeared.'.repeat(50),
        format: 'text',
        policyProfile: 'general',
        backend: 'mock',
        model: 'mock-model',
      }),
    });
    const summaryElapsedMs = Date.now() - summaryStartedAt;
    const search = await repoSearch;

    assert.equal(search.statusCode, 200);
    assert.equal(summary.statusCode, 200);
    assert.equal(typeof summary.body.Summary, 'string');
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
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const lines = await captureStdoutLines(async () => {
      const first = requestJson(`${baseUrl}/summary`, {
        method: 'POST',
        timeoutMs: 15000,
        body: JSON.stringify({
          question: 'summarize this',
          inputText: 'First queued summary input.'.repeat(50),
          format: 'text',
          policyProfile: 'general',
          backend: 'mock',
          model: 'mock-model',
        }),
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      const second = requestJson(`${baseUrl}/summary`, {
        method: 'POST',
        timeoutMs: 15000,
        body: JSON.stringify({
          question: 'summarize this',
          inputText: 'Second queued summary input.'.repeat(50),
          format: 'text',
          policyProfile: 'general',
          backend: 'mock',
          model: 'mock-model',
        }),
      });
      const [firstResponse, secondResponse] = await Promise.all([first, second]);
      assert.equal(firstResponse.statusCode, 200);
      assert.equal(secondResponse.statusCode, 200);
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
  const address = server.address() as AddressInfo;
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

    assert.equal(lines.some((line) => /status terminal_metadata_enqueued request_id=queued-metadata-summary state=completed queue_length=1/u.test(line)), true, lines.join('\n'));
    assert.equal(lines.some((line) => /status terminal_metadata_drain_wait request_id=queued-metadata-summary state=completed wait_ms=\d+ active=false queue_length=1/u.test(line)), true, lines.join('\n'));
    assert.equal(lines.some((line) => /status terminal_metadata_process_start request_id=queued-metadata-summary state=completed/u.test(line)), true, lines.join('\n'));
    const waitIndex = lines.findIndex((line) => /status terminal_metadata_drain_wait request_id=queued-metadata-summary/u.test(line));
    const processIndex = lines.findIndex((line) => /status terminal_metadata_process_start request_id=queued-metadata-summary/u.test(line));
    assert.ok(waitIndex >= 0 && processIndex > waitIndex, lines.join('\n'));
    assert.equal(lines.some((line) => /request false task=summary total_elapsed=0s output_tokens=7/u.test(line)), true, lines.join('\n'));
    assert.equal(lines.some((line) => /status terminal_metadata_process_done request_id=queued-metadata-summary state=completed duration_ms=\d+/u.test(line)), true, lines.join('\n'));
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

  const originalIsIdle = ManagedLlamaFlushQueue.prototype.isIdle;
  let llamaFlushIdle = false;
  ManagedLlamaFlushQueue.prototype.isIdle = function isIdleForTest(): boolean {
    return llamaFlushIdle && originalIsIdle.call(this);
  };
  const server = startStatusServer({ disableManagedLlamaStartup: true, terminalMetadataIdleDelayMs: 0 });
  await server.startupPromise;
  const address = server.address() as AddressInfo;
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

    const waitIndex = lines.findIndex((line) => /status terminal_metadata_drain_wait request_id=metadata-after-llama-flush/u.test(line));
    const processIndex = lines.findIndex((line) => /status terminal_metadata_process_start request_id=metadata-after-llama-flush/u.test(line));
    assert.ok(waitIndex >= 0 && processIndex > waitIndex, lines.join('\n'));
    assert.equal(lines.some((line) => /request false task=summary total_elapsed=0s output_tokens=9/u.test(line)), true, lines.join('\n'));
  } finally {
    ManagedLlamaFlushQueue.prototype.isIdle = originalIsIdle;
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
  const address = server.address() as AddressInfo;
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
      assert.equal(secondRunning.statusCode, 200);
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
    });

    assert.equal(lines.some((line) => /stale_status_abandoned/u.test(line)), false, lines.join('\n'));
    assert.equal(lines.some((line) => /status complete_start request_id=first-summary state=completed/u.test(line)), true, lines.join('\n'));
    assert.equal(lines.some((line) => /status complete_done request_id=first-summary state=completed duration_ms=\d+/u.test(line)), true, lines.join('\n'));
    assert.equal(lines.some((line) => /status terminal_metadata_enqueued request_id=first-summary state=completed queue_length=1/u.test(line)), true, lines.join('\n'));
    assert.equal(lines.some((line) => /status terminal_metadata_process_start request_id=first-summary state=completed/u.test(line)), true, lines.join('\n'));
    assert.equal(lines.some((line) => /status terminal_metadata_process_done request_id=first-summary state=completed duration_ms=\d+/u.test(line)), true, lines.join('\n'));
    assert.equal(lines.some((line) => /request false task=summary total_elapsed=0s output_tokens=10/u.test(line)), true, lines.join('\n'));
    assert.equal(lines.some((line) => /late_running_ignored request_id=first-summary/u.test(line)), true, lines.join('\n'));
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
  const address = server.address() as AddressInfo;
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
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrText += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const summary = await requestJson(`${baseUrl}/summary`, {
      method: 'POST',
      timeoutMs: 15000,
      body: JSON.stringify({
        question: 'summarize this',
        inputText: 'Build output: warning appeared.'.repeat(50),
        format: 'text',
        policyProfile: 'general',
        backend: 'mock',
        model: 'mock-model',
      }),
    });

    assert.equal(summary.statusCode, 500);
    assert.equal(summary.body.errorName, 'Error');
    assert.equal(typeof summary.body.diagnosticId, 'string');
    const diagnostic = summary.body.diagnostic as Record<string, unknown>;
    assert.equal(diagnostic.name, 'Error');
    assert.equal(diagnostic.message, 'mock provider failure');
    assert.equal(typeof diagnostic.stack, 'string');
    assert.match(stderrText, /\[siftKitStatus\] request_error/u);
    assert.match(stderrText, /route=\/summary/u);
    assert.match(stderrText, /error_name=Error/u);
    assert.match(stderrText, /mock provider failure/u);

    const database = getRuntimeDatabase();
    const row = database.prepare(`
      SELECT id, route, method, status_code, error_name, error_message, error_stack, diagnostic_json
      FROM runtime_error_events
      WHERE id = ?
    `).get(String(summary.body.diagnosticId)) as Record<string, unknown> | undefined;
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

test('summarizeRequest uses explicit config without requiring config service', async () => {
  const envBackup: Record<string, string | undefined> = {
    SIFTKIT_STATUS_BACKEND_URL: process.env.SIFTKIT_STATUS_BACKEND_URL,
    SIFTKIT_CONFIG_SERVICE_URL: process.env.SIFTKIT_CONFIG_SERVICE_URL,
  };
  process.env.SIFTKIT_STATUS_BACKEND_URL = 'http://127.0.0.1:1/status';
  process.env.SIFTKIT_CONFIG_SERVICE_URL = 'http://127.0.0.1:1/config';

  try {
    const config = getDefaultConfig() as SiftConfig;
    config.Backend = 'mock';
    config.Runtime.Model = 'mock-model';
    const result = await summarizeRequest({
      question: 'summarize this',
      inputText: 'Build output: warning appeared.'.repeat(50),
      format: 'text',
      policyProfile: 'general',
      backend: 'mock',
      model: 'mock-model',
      statusBackendUrl: 'http://127.0.0.1:1/status',
      skipExecutionLock: true,
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

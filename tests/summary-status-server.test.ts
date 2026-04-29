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
import { closeRuntimeDatabase, getRuntimeDatabase } from '../dist/state/runtime-db.js';

type JsonResponse = { statusCode: number; body: Record<string, unknown> };

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

  const server = startStatusServer({ disableManagedLlamaStartup: true });
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

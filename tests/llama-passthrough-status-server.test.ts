import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';

import { startStatusServer } from '../dist/status-server/index.js';
import { closeRuntimeDatabase } from '../dist/state/runtime-db.js';

const requireFromHere = createRequire(__filename);
const runtimeHelpers = requireFromHere('./_runtime-helpers.js') as {
  writeManagedLlamaScripts: (tempRoot: string, port: number, modelId?: string) => {
    baseUrl: string;
    modelPath: string;
    startupScriptPath: string;
    shutdownScriptPath: string;
  };
  getFreePort: () => Promise<number>;
};

type JsonResponse = { statusCode: number; body: Record<string, unknown> };

function requestJson(url: string, timeoutMs = 5000): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
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
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('request timeout'));
    });
    request.end();
  });
}

test('llama passthrough wakes managed llama when the managed process is offline', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-llama-passthrough-'));
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
  const managed = runtimeHelpers.writeManagedLlamaScripts(tempRoot, llamaPort, 'managed-passthrough-model');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    Backend: 'llama.cpp',
    Model: 'managed-passthrough-model',
    Runtime: {
      Model: 'managed-passthrough-model',
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
        StartupTimeoutMs: 10000,
        HealthcheckTimeoutMs: 50,
        HealthcheckIntervalMs: 25,
      },
    },
  }, null, 2)}\n`, 'utf8');

  const server = startStatusServer();
  await server.startupPromise;
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await server.shutdownManagedLlamaForServerExit?.();

    const response = await requestJson(`${baseUrl}/v1/models`);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { data: [{ id: 'managed-passthrough-model' }] });
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

test('llama passthrough waits through 503 Loading model responses without timing out', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-llama-passthrough-503-'));
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
    SIFTKIT_LLAMA_STARTUP_GRACE_DELAY_MS: process.env.SIFTKIT_LLAMA_STARTUP_GRACE_DELAY_MS,
  };
  process.env.sift_kit_status = statusPath;
  process.env.SIFTKIT_STATUS_PATH = statusPath;
  process.env.SIFTKIT_CONFIG_PATH = configPath;
  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';
  process.env.SIFTKIT_LLAMA_STARTUP_GRACE_DELAY_MS = '0';

  const llamaPort = await runtimeHelpers.getFreePort();
  // The fake llama responds with the canonical "Loading model" 503 body for
  // the first 20 healthchecks, then 200. With StartupTimeoutMs=1500 and
  // HealthcheckIntervalMs=50 + HealthcheckTimeoutMs=100, the 20 503 polls
  // alone would take ~3000 ms — far longer than the unextended 1500 ms
  // deadline. The test only passes if the deadline-extension on each
  // 503-loading-model response keeps the spawn alive long enough for the
  // model to finish loading.
  const managed = runtimeHelpers.writeManagedLlamaScripts(tempRoot, llamaPort, 'managed-passthrough-503-model', {
    initial503LoadingModelCount: 20,
  });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    Backend: 'llama.cpp',
    Model: 'managed-passthrough-503-model',
    Runtime: {
      Model: 'managed-passthrough-503-model',
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
        StartupTimeoutMs: 1500,
        HealthcheckTimeoutMs: 100,
        HealthcheckIntervalMs: 50,
      },
    },
  }, null, 2)}\n`, 'utf8');

  const server = startStatusServer();
  await server.startupPromise;
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await requestJson(`${baseUrl}/v1/models`, 30_000);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { data: [{ id: 'managed-passthrough-503-model' }] });
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

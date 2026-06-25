import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { getFreePort, writeManagedLlamaScripts } from './_runtime-helpers.js';

import { startStatusServer } from '../src/status-server/index.js';
import { closeRuntimeDatabase } from '../src/state/runtime-db.js';
import { getDefaultConfig, writeConfig } from '../src/status-server/config-store.js';
import { getConfigPath } from '../src/config/index.js';
import { parseJsonValueText } from '../src/lib/json.js';
import type { JsonValue } from '../src/lib/json-types.js';
import { asObject, getAddressInfo, type JsonResponse } from './helpers/dashboard-http.js';

function writeManagedConfig(
  model: string,
  managed: { baseUrl: string; modelPath: string; startupScriptPath: string },
  timeouts: { StartupTimeoutMs: number; HealthcheckTimeoutMs: number; HealthcheckIntervalMs: number },
): void {
  const config = getDefaultConfig();
  const preset = config.Server.LlamaCpp.Presets[0];
  preset.Model = model;
  preset.BaseUrl = managed.baseUrl;
  preset.NumCtx = 32000;
  preset.ModelPath = managed.modelPath;
  preset.ExecutablePath = managed.startupScriptPath;
  preset.StartupTimeoutMs = timeouts.StartupTimeoutMs;
  preset.HealthcheckTimeoutMs = timeouts.HealthcheckTimeoutMs;
  preset.HealthcheckIntervalMs = timeouts.HealthcheckIntervalMs;
  writeConfig(getConfigPath(), config);
}


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
            body: responseText ? asObject(parseJsonValueText(responseText)) : {},
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

function requestJsonPost(url: string, body: JsonValue, timeoutMs = 5000): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = JSON.stringify(body);
    const request = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
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
            body: responseText ? asObject(parseJsonValueText(responseText)) : {},
          });
        });
      },
    );
    request.on('error', reject);
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('request timeout'));
    });
    request.write(payload);
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

  const llamaPort = await getFreePort();
  const managed = writeManagedLlamaScripts(tempRoot, llamaPort, 'managed-passthrough-model');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  writeManagedConfig('managed-passthrough-model', managed, {
    StartupTimeoutMs: 10000,
    // Healthcheck timeout must stay well above realistic localhost round-trip
    // latency under full-suite CPU contention; a sub-100ms timeout made every
    // probe to the freshly-spawned fake llama time out, mis-reading it as
    // offline until the 10s startup deadline expired (503). This test exercises
    // wake-on-demand, not tight healthcheck timing.
    HealthcheckTimeoutMs: 2000,
    HealthcheckIntervalMs: 100,
  });

  const server = startStatusServer();
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await server.shutdownManagedLlamaForServerExit?.();

    const response = await requestJson(`${baseUrl}/v1/models`, 30_000);

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

  const llamaPort = await getFreePort();
  // The fake llama responds with the canonical "Loading model" 503 body for
  // the first 20 healthchecks, then 200. With StartupTimeoutMs=1500 and
  // HealthcheckIntervalMs=50 + HealthcheckTimeoutMs=100, the 20 503 polls
  // alone would take ~3000 ms — far longer than the unextended 1500 ms
  // deadline. The test only passes if the deadline-extension on each
  // 503-loading-model response keeps the spawn alive long enough for the
  // model to finish loading.
  const managed = writeManagedLlamaScripts(tempRoot, llamaPort, 'managed-passthrough-503-model', {
    initial503LoadingModelCount: 20,
  });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  writeManagedConfig('managed-passthrough-503-model', managed, {
    StartupTimeoutMs: 1500,
    HealthcheckTimeoutMs: 100,
    HealthcheckIntervalMs: 50,
  });

  const server = startStatusServer();
  await server.startupPromise;
  const address = getAddressInfo(server);
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

test('llama passthrough proxies POST /tokenize to managed llama', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-llama-passthrough-tokenize-'));
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
  // The fake llama tokenizes at 4 characters per token.
  const managed = writeManagedLlamaScripts(tempRoot, llamaPort, 'managed-tokenize-model', {
    tokenizeCharsPerToken: 4,
  });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  writeManagedConfig('managed-tokenize-model', managed, {
    StartupTimeoutMs: 10000,
    // Healthcheck timeout must stay well above realistic localhost round-trip
    // latency under full-suite CPU contention; a sub-100ms timeout made every
    // probe to the freshly-spawned fake llama time out, mis-reading it as
    // offline until the 10s startup deadline expired (503). This test exercises
    // wake-on-demand, not tight healthcheck timing.
    HealthcheckTimeoutMs: 2000,
    HealthcheckIntervalMs: 100,
  });

  const server = startStatusServer();
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // 16 characters at 4 chars/token => 4 tokens.
    const response = await requestJsonPost(`${baseUrl}/tokenize`, { content: 'abcdefghijklmnop' });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.count, 4);
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

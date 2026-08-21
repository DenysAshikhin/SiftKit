import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { z } from 'zod';
import { acquireChildPortLease, writeManagedLlamaLauncher } from './_runtime-helpers.js';
import { OutputCapture } from './helpers/stdout-capture.js';

import { startStatusServer } from '../src/status-server/index.js';
import { closeRuntimeDatabase } from '../src/state/runtime-db.js';
import { getDefaultConfig, writeConfig } from '../src/status-server/config-store.js';
import { getConfigPath, type ModelRuntimePreset } from '../src/config/index.js';
import { parseJsonValueText } from '../src/lib/json.js';
import type { JsonObject, JsonValue } from '../src/lib/json-types.js';
import { asObject, getAddressInfo, type JsonResponse } from './helpers/dashboard-http.js';
import { createManagedTempDir, removeDirectoryWithRetries } from './helpers/temp-dirs.js';
import { testHttpAgent } from './helpers/http-agent.js';

function writeManagedConfig(
  model: string,
  managed: { baseUrl: string; modelPath: string; executablePath: string },
  timeouts: { StartupTimeoutMs: number; HealthcheckTimeoutMs: number; HealthcheckIntervalMs: number },
  presetOverrides: Partial<ModelRuntimePreset> = {},
): void {
  const config = getDefaultConfig();
  const preset = config.Server.ModelPresets.Presets[0];
  preset.Model = model;
  preset.BaseUrl = managed.baseUrl;
  preset.NumCtx = 32000;
  preset.ModelPath = managed.modelPath;
  preset.ExecutablePath = managed.executablePath;
  preset.StartupTimeoutMs = timeouts.StartupTimeoutMs;
  preset.HealthcheckTimeoutMs = timeouts.HealthcheckTimeoutMs;
  preset.HealthcheckIntervalMs = timeouts.HealthcheckIntervalMs;
  config.Server.ModelPresets.Presets[0] = { ...preset, ...presetOverrides };
  writeConfig(getConfigPath(), config);
}

const ModelProbeCountSchema = z.coerce.number().int().nonnegative();


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
        agent: testHttpAgent,
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
        agent: testHttpAgent,
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
  const tempRoot = createManagedTempDir('siftkit-inference-passthrough-');
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

  await using llamaPortLease = await acquireChildPortLease('inference-passthrough-status-server');
  const llamaPort = llamaPortLease.port;
  const managed = writeManagedLlamaLauncher(tempRoot, llamaPort, 'managed-passthrough-model');
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

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    assert.equal(fs.existsSync(managed.readyFilePath), false);

    const response = await requestJson(`${baseUrl}/v1/models`, 30_000);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { data: [{ id: 'managed-passthrough-model', object: 'model' }] });
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
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('llama passthrough waits through 503 Loading model responses without timing out', async () => {
  const tempRoot = createManagedTempDir('siftkit-inference-passthrough-503-');
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

  await using llamaPortLease = await acquireChildPortLease('inference-passthrough-status-server');
  const llamaPort = llamaPortLease.port;
  // Two canonical "Loading model" responses prove that startup retries 503s
  // before accepting the first successful model probe.
  const managed = writeManagedLlamaLauncher(tempRoot, llamaPort, 'managed-passthrough-503-model', {
    initial503LoadingModelCount: 2,
  });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  writeManagedConfig('managed-passthrough-503-model', managed, {
    StartupTimeoutMs: 5000,
    HealthcheckTimeoutMs: 100,
    HealthcheckIntervalMs: 10,
  });

  const server = startStatusServer();
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await requestJson(`${baseUrl}/v1/models`, 30_000);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { data: [{ id: 'managed-passthrough-503-model', object: 'model' }] });
    const modelProbeCount = ModelProbeCountSchema.parse(fs.readFileSync(managed.modelProbeCountPath, 'utf8').trim());
    assert.ok(modelProbeCount >= 3, `expected two loading probes before success, got ${modelProbeCount}`);
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
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('chat passthrough logs every forwarded /v1/chat/completions request', async () => {
  const tempRoot = createManagedTempDir('siftkit-inference-passthrough-chat-log-');
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

  await using llamaPortLease = await acquireChildPortLease('inference-passthrough-status-server');
  const llamaPort = llamaPortLease.port;
  const managed = writeManagedLlamaLauncher(tempRoot, llamaPort, 'managed-chat-log-model');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  writeManagedConfig('managed-chat-log-model', managed, {
    StartupTimeoutMs: 10000,
    HealthcheckTimeoutMs: 2000,
    HealthcheckIntervalMs: 100,
  });

  const server = startStatusServer();
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const capture = OutputCapture.start(process.stdout);
    try {
      const response = await requestJsonPost(`${baseUrl}/v1/chat/completions`, {
        messages: [
          { role: 'system', content: 'You are terse.' },
          { role: 'user', content: 'hello' },
        ],
      }, 30_000);
      assert.equal(response.statusCode, 200);
    } finally {
      capture.restore();
    }
    const lines = capture.lines;

    const forwardLine = lines.find((line) => /proxy -{8} {2}forward/u.test(line));
    assert.ok(forwardLine, `expected a forward log line, got:\n${lines.join('\n')}`);
    assert.match(forwardLine, /path=\/v1\/chat\/completions/u);
    assert.match(forwardLine, /messages=2/u);
    assert.match(forwardLine, /body_chars=\d+/u);
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
    await removeDirectoryWithRetries(tempRoot);
  }
});

async function withPassthroughChatServer(
  presetOverrides: Partial<ModelRuntimePreset>,
  run: (postChat: (body: JsonValue) => Promise<JsonResponse>) => Promise<void>,
): Promise<void> {
  const tempRoot = createManagedTempDir('siftkit-inference-passthrough-samplers-');
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

  await using llamaPortLease = await acquireChildPortLease('inference-passthrough-status-server');
  const llamaPort = llamaPortLease.port;
  const managed = writeManagedLlamaLauncher(tempRoot, llamaPort, 'managed-sampler-model');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  writeManagedConfig('managed-sampler-model', managed, {
    StartupTimeoutMs: 10000,
    HealthcheckTimeoutMs: 2000,
    HealthcheckIntervalMs: 100,
  }, presetOverrides);

  const server = startStatusServer();
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run((body) => requestJsonPost(`${baseUrl}/v1/chat/completions`, body, 30_000));
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
    await removeDirectoryWithRetries(tempRoot);
  }
}

function readForwardedRequest(response: JsonResponse): JsonObject {
  assert.equal(response.statusCode, 200);
  return asObject(response.body.forwardedRequest);
}

test('chat passthrough forces preset samplers and lets callers only lower max_tokens', async () => {
  await withPassthroughChatServer({
    Temperature: 0.6,
    TopP: 0.8,
    TopK: 17,
    MinP: 0.03,
    PresencePenalty: 0.9,
    RepetitionPenalty: 1.15,
    MaxTokens: 15_000,
    Reasoning: 'off',
  }, async (postChat) => {
    const overreaching = readForwardedRequest(await postChat({
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 1.9,
      top_p: 0.1,
      top_k: 99,
      min_p: 0.5,
      presence_penalty: 0,
      repeat_penalty: 2,
      max_tokens: 99_999,
      chat_template_kwargs: { enable_thinking: true },
    }));
    assert.equal(overreaching.temperature, 0.6);
    assert.equal(overreaching.top_p, 0.8);
    assert.equal(overreaching.top_k, 17);
    assert.equal(overreaching.min_p, 0.03);
    assert.equal(overreaching.presence_penalty, 0.9);
    assert.equal(overreaching.repeat_penalty, 1.15);
    assert.equal(overreaching.model, 'managed-sampler-model');
    // min(caller 99999, preset 15000)
    assert.equal(overreaching.max_tokens, 15_000);
    // The preset has reasoning off, so the caller cannot turn thinking on.
    assert.deepEqual(overreaching.chat_template_kwargs, { enable_thinking: false });

    const modest = readForwardedRequest(await postChat({
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 128,
    }));
    assert.equal(modest.max_tokens, 128);

    const unspecified = readForwardedRequest(await postChat({
      messages: [{ role: 'user', content: 'hi' }],
    }));
    assert.equal(unspecified.max_tokens, 15_000);
  });
});

test('chat passthrough forwards the preset thinking kwargs when reasoning is on', async () => {
  await withPassthroughChatServer({
    Reasoning: 'on',
    ReasoningContent: true,
    PreserveThinking: true,
  }, async (postChat) => {
    const forwarded = readForwardedRequest(await postChat({
      messages: [{ role: 'user', content: 'hi' }],
      chat_template_kwargs: { enable_thinking: false },
    }));
    assert.deepEqual(forwarded.chat_template_kwargs, {
      enable_thinking: true,
      reasoning_content: true,
      preserve_thinking: true,
      reasoning_effort: 'xhigh',
    });
  });
});

test('chat passthrough replaces a caller reasoning effort with the preset one', async () => {
  await withPassthroughChatServer({
    Reasoning: 'on',
    ReasoningEffort: 'medium',
  }, async (postChat) => {
    const forwarded = readForwardedRequest(await postChat({
      messages: [{ role: 'user', content: 'hi' }],
      // The preset owns thinking policy, so a caller cannot pick its own depth.
      chat_template_kwargs: { reasoning_effort: 'low' },
    }));
    assert.deepEqual(forwarded.chat_template_kwargs, {
      enable_thinking: true,
      reasoning_effort: 'medium',
    });
  });
});

test('llama passthrough proxies POST /tokenize to managed llama', async () => {
  const tempRoot = createManagedTempDir('siftkit-inference-passthrough-tokenize-');
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

  await using llamaPortLease = await acquireChildPortLease('inference-passthrough-status-server');
  const llamaPort = llamaPortLease.port;
  // The fake llama tokenizes at 4 characters per token.
  const managed = writeManagedLlamaLauncher(tempRoot, llamaPort, 'managed-tokenize-model', {
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
    await removeDirectoryWithRetries(tempRoot);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { acquireChildPortLease, writeManagedEngineHost } from './_runtime-helpers.js';
import type { ManagedEngineHostFixture } from './helpers/managed-engine-fixtures.js';
import type { FakeTabbyOptions } from './helpers/in-process-tabby.js';
import { FixedGpuMemoryProbe } from './helpers/fixed-gpu-memory-probe.js';
import { OutputCapture } from './helpers/stdout-capture.js';

import { startStatusServer } from '../src/status-server/index.js';
import { closeAllRuntimeDatabases } from '../src/state/runtime-db.js';
import { getDefaultConfig, writeConfig } from '../src/status-server/config-store.js';
import { getConfigPath, type ModelRuntimePreset } from '../src/config/index.js';
import { parseJsonValueText } from '../src/lib/json.js';
import type { JsonObject, JsonValue } from '../src/lib/json-types.js';
import { asObject, getAddressInfo, requestRawText, type JsonResponse, type RawTextResponse } from './helpers/dashboard-http.js';
import { createManagedTempDir, removeDirectoryWithRetries } from './helpers/temp-dirs.js';
import { testHttpAgent } from './helpers/http-agent.js';
import { buildTabbyUsage } from './helpers/streaming-client.js';

// Healthcheck timeout must stay well above realistic localhost round-trip latency under
// full-suite CPU contention; a sub-100ms timeout made every probe to the freshly-spawned
// fake engine time out, mis-reading it as offline until the startup deadline expired (503).
// These tests exercise wake-on-demand and request translation, not tight healthcheck timing.
const PASSTHROUGH_TIMEOUTS = {
  StartupTimeoutMs: 10_000,
  HealthcheckTimeoutMs: 2_000,
  HealthcheckIntervalMs: 100,
} as const;

function writeManagedConfig(
  managed: ManagedEngineHostFixture,
  presetOverrides: Partial<ModelRuntimePreset>,
): void {
  const config = getDefaultConfig();
  const preset = config.Server.ModelPresets.Presets[0];
  config.Server.ModelPresets.Presets[0] = {
    ...preset,
    Backend: 'exl3',
    Model: managed.modelId,
    BaseUrl: managed.baseUrl,
    NumCtx: 32000,
    ModelPath: managed.modelPath,
    ...PASSTHROUGH_TIMEOUTS,
    ...presetOverrides,
  };
  config.Server.Engines.Exl3 = managed.engine;
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

interface PassthroughServerOptions {
  tempPrefix: string;
  modelId: string;
  engine?: Omit<FakeTabbyOptions, 'port' | 'modelId'>;
  presetOverrides?: Partial<ModelRuntimePreset>;
  disableManagedEngineStartup?: boolean;
}

interface PassthroughServer {
  baseUrl: string;
  managed: ManagedEngineHostFixture;
}

async function withPassthroughServer(
  options: PassthroughServerOptions,
  run: (server: PassthroughServer) => Promise<void>,
): Promise<void> {
  const tempRoot = createManagedTempDir(options.tempPrefix);
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

  await using enginePortLease = await acquireChildPortLease('inference-passthrough-status-server');
  const managed = writeManagedEngineHost(tempRoot, enginePortLease.port, options.modelId, options.engine);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  writeManagedConfig(managed, options.presetOverrides ?? {});

  const server = startStatusServer({
    disableManagedEngineStartup: Boolean(options.disableManagedEngineStartup),
    managedEngineHost: managed.host,
    gpuMemoryProbe: new FixedGpuMemoryProbe(null),
  });
  await server.startupPromise;
  const address = getAddressInfo(server);

  try {
    await run({ baseUrl: `http://127.0.0.1:${address.port}`, managed });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await managed.launcher.stopAll();
    process.chdir(previousCwd);
    closeAllRuntimeDatabases();
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

test('models passthrough reports the configured model without waking the managed engine', async () => {
  await withPassthroughServer({
    tempPrefix: 'siftkit-inference-passthrough-',
    modelId: 'managed-passthrough-model',
    disableManagedEngineStartup: true,
  }, async ({ baseUrl, managed }) => {
    assert.equal(managed.launcher.serving, false);

    const response = await requestJson(`${baseUrl}/v1/models`, 30_000);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { data: [{ id: 'managed-passthrough-model', object: 'model' }] });
    assert.equal(managed.launcher.serving, false);
  });
});

test('managed engine startup waits through unloaded model probes without timing out', async () => {
  // Two "no model loaded" answers prove that startup keeps polling the model card
  // before accepting the first resident probe.
  await withPassthroughServer({
    tempPrefix: 'siftkit-inference-passthrough-503-',
    modelId: 'managed-passthrough-503-model',
    engine: { initialUnloadedModelProbeCount: 2 },
  }, async ({ baseUrl, managed }) => {
    const response = await requestJson(`${baseUrl}/v1/models`, 30_000);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { data: [{ id: 'managed-passthrough-503-model', object: 'model' }] });
    const modelProbeCount = managed.launcher.modelProbeCount;
    assert.ok(modelProbeCount >= 3, `expected two unloaded probes before success, got ${modelProbeCount}`);
  });
});

test('chat passthrough logs every forwarded /v1/chat/completions request', async () => {
  await withPassthroughServer({
    tempPrefix: 'siftkit-inference-passthrough-chat-log-',
    modelId: 'managed-chat-log-model',
  }, async ({ baseUrl }) => {
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

    const forwardLine = lines.find((line) => /proxy [0-9a-f]{8} {2}forward/u.test(line));
    assert.ok(forwardLine, `expected a forward log line, got:\n${lines.join('\n')}`);
    assert.match(forwardLine, /path=\/v1\/chat\/completions/u);
    assert.match(forwardLine, /messages=2/u);
    assert.match(forwardLine, /body_chars=\d+/u);
  });
});

async function withPassthroughChatServer(
  presetOverrides: Partial<ModelRuntimePreset>,
  run: (postChat: (body: JsonValue) => Promise<JsonResponse>) => Promise<void>,
): Promise<void> {
  await withPassthroughServer({
    tempPrefix: 'siftkit-inference-passthrough-samplers-',
    modelId: 'managed-sampler-model',
    presetOverrides,
  }, async ({ baseUrl }) => {
    await run((body) => requestJsonPost(`${baseUrl}/v1/chat/completions`, body, 30_000));
  });
}

function readForwardedRequest(response: JsonResponse): JsonObject {
  assert.equal(response.statusCode, 200);
  return asObject(response.body.forwardedRequest);
}

test('chat passthrough forces preset samplers and caps max_tokens from NumCtx', async () => {
  await withPassthroughChatServer({
    Temperature: 0.6,
    TopP: 0.8,
    TopK: 17,
    MinP: 0.03,
    PresencePenalty: 0.9,
    RepetitionPenalty: 1.15,
    NumCtx: 155_000,
    Reasoning: 'off',
  }, async (postChat) => {
    const overreaching = readForwardedRequest(await postChat({
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 1.9,
      top_p: 0.1,
      top_k: 99,
      min_p: 0.5,
      presence_penalty: 0,
      repetition_penalty: 2,
      max_tokens: 99_999,
      chat_template_kwargs: { enable_thinking: true },
    }));
    assert.equal(overreaching.temperature, 0.6);
    assert.equal(overreaching.top_p, 0.8);
    assert.equal(overreaching.top_k, 17);
    assert.equal(overreaching.min_p, 0.03);
    assert.equal(overreaching.presence_penalty, 0.9);
    assert.equal(overreaching.repetition_penalty, 1.15);
    assert.equal(overreaching.model, 'managed-sampler-model');
    assert.equal(overreaching.max_tokens, 99_999);
    // The preset has reasoning off, so the caller cannot turn thinking on.
    assert.deepEqual(overreaching.chat_template_kwargs, { enable_thinking: false });

    const modest = readForwardedRequest(await postChat({
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 128,
    }));
    assert.equal(modest.max_tokens, 128);

    // No caller cap: the prompt budget minus the (estimated) prompt itself, so the
    // request can never claim generation room the prompt already occupies.
    const unspecified = readForwardedRequest(await postChat({
      messages: [{ role: 'user', content: 'hi' }],
    }));
    const unspecifiedMaxTokens = Number(unspecified.max_tokens);
    assert.ok(unspecifiedMaxTokens < 155_000, `max_tokens=${unspecifiedMaxTokens}`);
    assert.ok(unspecifiedMaxTokens > 154_000, `max_tokens=${unspecifiedMaxTokens}`);

    const excessive = readForwardedRequest(
      await postChat({
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 200_000,
      }),
    );
    assert.equal(excessive.max_tokens, unspecifiedMaxTokens);
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

test('tokenize passthrough exposes only the EXL3 token endpoint', async () => {
  // The fake engine tokenizes at 4 characters per token.
  await withPassthroughServer({
    tempPrefix: 'siftkit-inference-passthrough-tokenize-',
    modelId: 'managed-tokenize-model',
    engine: { tokenizeCharsPerToken: 4 },
  }, async ({ baseUrl }) => {
    // 16 characters at 4 chars/token => 4 tokens.
    const response = await requestJsonPost(`${baseUrl}/v1/token/encode`, { text: 'abcdefghijklmnop' });
    const removedRoute = await requestJsonPost(`${baseUrl}/tokenize`, { content: 'abcdefghijklmnop' });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.length, 4);
    assert.equal(removedRoute.statusCode, 404);
  });
});

/** Tabby-consistent counts and timings whose reported decode rate (30) drifts from 754 / 35.07. */
const DRIFTING_USAGE = {
  ...buildTabbyUsage({ promptTokens: 3365, completionTokens: 754, promptTime: 3.88, completionTime: 35.07 }),
  completion_tokens_per_sec: 30,
};

function throughputLines(lines: readonly string[]): string[] {
  return lines.filter((line) => /throughput_/u.test(line));
}

async function withPassthroughAudit(
  tempPrefix: string,
  run: (postRaw: (body: JsonValue, abort?: boolean) => Promise<RawTextResponse>, lines: () => string[]) => Promise<void>,
): Promise<void> {
  await withPassthroughServer({ tempPrefix, modelId: 'managed-audit-model' }, async ({ baseUrl }) => {
    const capture = OutputCapture.start(process.stdout);
    try {
      await run(
        (body, abort) => requestRawText(`${baseUrl}/v1/chat/completions`, body, { abortAfterFirstChunk: abort }),
        () => throughputLines(capture.lines),
      );
    } finally {
      capture.restore();
    }
  });
}

test('streaming passthrough audits a drifting usage frame while proxying bytes unchanged', async () => {
  await withPassthroughAudit('siftkit-passthrough-audit-stream-', async (postRaw, lines) => {
    const response = await postRaw({
      messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true },
      fake_engine: { usage: DRIFTING_USAGE },
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.contentType, /text\/event-stream/u);
    assert.match(response.text, /"completion_tokens_per_sec":30/u);
    assert.match(response.text, /data: \[DONE\]/u);
    const audit = lines();
    assert.equal(audit.length, 1, audit.join('\n'));
    assert.match(audit[0], /throughput_mismatch/u);
    assert.match(audit[0], /operation=passthrough/u);
    assert.match(audit[0], /stage=chat_completions/u);
    assert.match(audit[0], /scope=request/u);
    assert.match(audit[0], /metric=decode/u);
    assert.match(audit[0], /generated_tokens=754/u);
    assert.match(audit[0], /preset=/u);
  });
});

test('passthrough stays silent for consistent usage and for a stream that never opted into usage', async () => {
  await withPassthroughAudit('siftkit-passthrough-audit-quiet-', async (postRaw, lines) => {
    const consistent = await postRaw({ messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true } });
    assert.equal(consistent.statusCode, 200);
    const noUsage = await postRaw({ messages: [{ role: 'user', content: 'hi' }], stream: true, fake_engine: { usage: null } });
    assert.equal(noUsage.statusCode, 200);
    assert.doesNotMatch(noUsage.text, /usage/u);
    assert.deepEqual(lines(), []);
  });
});

test('passthrough reports a stream that opted into usage but received none as unverifiable', async () => {
  await withPassthroughAudit('siftkit-passthrough-audit-missing-', async (postRaw, lines) => {
    await postRaw({
      messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true }, fake_engine: { usage: null },
    });
    const audit = lines();
    assert.equal(audit.length, 2, audit.join('\n'));
    assert.match(audit[0], /throughput_unverifiable/u);
    assert.match(audit[0], /operation=passthrough/u);
    assert.match(audit[0], /metric=pp/u);
    assert.match(audit[1], /metric=decode/u);
  });
});

test('non-streaming passthrough parses the JSON response once and audits both metrics', async () => {
  await withPassthroughAudit('siftkit-passthrough-audit-json-', async (postRaw, lines) => {
    const response = await postRaw({
      messages: [{ role: 'user', content: 'hi' }],
      fake_engine: { usage: { ...DRIFTING_USAGE, prompt_tokens_per_sec: 700 } },
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.contentType, /application\/json/u);
    assert.equal(asObject(parseJsonValueText(response.text)).usage !== undefined, true);
    const audit = lines();
    assert.equal(audit.length, 2, audit.join('\n'));
    assert.match(audit[0], /throughput_mismatch/u);
    assert.match(audit[0], /metric=pp/u);
    assert.match(audit[1], /metric=decode/u);
  });
});

test('passthrough abandons observation of an oversized frame without throwing', async () => {
  await withPassthroughAudit('siftkit-passthrough-audit-oversize-', async (postRaw, lines) => {
    const response = await postRaw({
      messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true },
      fake_engine: { usage: DRIFTING_USAGE, padding_chars: 300 * 1024 },
    });
    assert.equal(response.statusCode, 200);
    assert.ok(response.text.length > 300 * 1024);
    assert.match(response.text, /data: \[DONE\]/u);
    assert.deepEqual(lines(), []);
  });
});

test('a client abort mid-stream produces no audit and leaves the passthrough usable', async () => {
  await withPassthroughAudit('siftkit-passthrough-audit-abort-', async (postRaw, lines) => {
    const aborted = await postRaw({
      messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true },
      fake_engine: { usage: DRIFTING_USAGE, finish_delay_ms: 1500 },
    }, true);
    assert.equal(aborted.statusCode, 200);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assert.deepEqual(lines(), []);
    const next = await postRaw({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(next.statusCode, 200);
    assert.deepEqual(lines(), []);
  });
});

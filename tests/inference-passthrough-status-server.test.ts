import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { acquireChildPortLease, writeManagedEngineHost } from './_runtime-helpers.ts';
import type { ManagedEngineHostFixture } from './helpers/managed-engine-fixtures.ts';
import {
  countFakeTokens,
  renderFakeChatTemplate,
  type FakeChatMessage,
  type FakeTabbyLauncher,
  type FakeTabbyOptions,
} from './helpers/in-process-tabby.ts';
import { SIFT_IMAGE_TOKEN_ESTIMATE } from '../src/config/constants.ts';
import { FixedGpuMemoryProbe } from './helpers/fixed-gpu-memory-probe.ts';
import { OutputCapture } from './helpers/stdout-capture.ts';

import { startStatusServer } from '../src/status-server/index.ts';
import { closeAllRuntimeDatabases } from '../src/state/runtime-db.ts';
import { getDefaultConfig, writeConfig } from '../src/status-server/config-store.ts';
import { getConfigPath, type ModelRuntimePreset } from '../src/config/index.ts';
import { parseJsonValueText } from '../src/lib/json.ts';
import type { JsonObject, JsonValue } from '../src/lib/json-types.ts';
import { asObject, getAddressInfo, requestRawText, type JsonResponse, type RawTextResponse } from './helpers/dashboard-http.ts';
import { createManagedTempDir, removeDirectoryWithRetries } from './helpers/temp-dirs.ts';
import { testHttpAgent } from './helpers/http-agent.ts';
import { buildTabbyUsage } from './helpers/streaming-client.ts';
import { tabbyTokenEncodeResponse } from './helpers/tabby-token-encode.ts';
import { PASSTHROUGH_MESSAGE_DRIFT_TOKENS } from '../src/status-server/passthrough-chat-prompt.ts';

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

function requestJsonPost(
  url: string,
  body: JsonValue,
  timeoutMs = 5000,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
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
          ...headers,
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

const ENV_KEYS = [
  'sift_kit_status',
  'SIFTKIT_STATUS_PATH',
  'SIFTKIT_CONFIG_PATH',
  'SIFTKIT_STATUS_HOST',
  'SIFTKIT_STATUS_PORT',
] as const;

/** A status server in its own temp workspace, proxying to a fake managed engine; disposal restores the process. */
class PassthroughServer implements AsyncDisposable {
  readonly baseUrl: string;
  readonly managed: ManagedEngineHostFixture;
  private readonly server: http.Server;
  private readonly portLease: AsyncDisposable;
  private readonly tempRoot: string;
  private readonly previousCwd: string;
  private readonly envBackup: Map<string, string | undefined>;

  private constructor(fields: {
    server: http.Server;
    managed: ManagedEngineHostFixture;
    portLease: AsyncDisposable;
    tempRoot: string;
    previousCwd: string;
    envBackup: Map<string, string | undefined>;
  }) {
    this.server = fields.server;
    this.managed = fields.managed;
    this.portLease = fields.portLease;
    this.tempRoot = fields.tempRoot;
    this.previousCwd = fields.previousCwd;
    this.envBackup = fields.envBackup;
    this.baseUrl = `http://127.0.0.1:${getAddressInfo(fields.server).port}`;
  }

  static async start(options: PassthroughServerOptions): Promise<PassthroughServer> {
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
    const envBackup = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.sift_kit_status = statusPath;
    process.env.SIFTKIT_STATUS_PATH = statusPath;
    process.env.SIFTKIT_CONFIG_PATH = configPath;
    process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
    process.env.SIFTKIT_STATUS_PORT = '0';

    const portLease = await acquireChildPortLease('inference-passthrough-status-server');
    const managed = writeManagedEngineHost(tempRoot, portLease.port, options.modelId, options.engine);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    writeManagedConfig(managed, options.presetOverrides ?? {});

    const server = startStatusServer({
      disableManagedEngineStartup: Boolean(options.disableManagedEngineStartup),
      managedEngineHost: managed.host,
      gpuMemoryProbe: new FixedGpuMemoryProbe(null),
    });
    await server.startupPromise;
    return new PassthroughServer({ server, managed, portLease, tempRoot, previousCwd, envBackup });
  }

  get launcher(): FakeTabbyLauncher {
    return this.managed.launcher;
  }

  postChat(body: JsonValue, headers: Record<string, string> = {}): Promise<JsonResponse> {
    return requestJsonPost(`${this.baseUrl}/v1/chat/completions`, body, 30_000, headers);
  }

  /** The body the fake engine received for a chat that must succeed. */
  async forwardedChat(body: JsonValue, headers: Record<string, string> = {}): Promise<JsonObject> {
    const response = await this.postChat(body, headers);
    assert.equal(response.statusCode, 200, JSON.stringify(response.body));
    return asObject(response.body.forwardedRequest);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
    await this.managed.launcher.stopAll();
    process.chdir(this.previousCwd);
    closeAllRuntimeDatabases();
    for (const [key, value] of this.envBackup) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(this.tempRoot);
    await this.portLease[Symbol.asyncDispose]();
  }
}

test('models passthrough reports the configured model without waking the managed engine', async () => {
  await using server = await PassthroughServer.start({
    tempPrefix: 'siftkit-inference-passthrough-',
    modelId: 'managed-passthrough-model',
    disableManagedEngineStartup: true,
  });
  assert.equal(server.launcher.serving, false);

  const response = await requestJson(`${server.baseUrl}/v1/models`, 30_000);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { data: [{ id: 'managed-passthrough-model', object: 'model' }] });
  assert.equal(server.launcher.serving, false);
});

test('managed engine startup waits through unloaded model probes without timing out', async () => {
  // Two "no model loaded" answers prove that startup keeps polling the model card
  // before accepting the first resident probe.
  await using server = await PassthroughServer.start({
    tempPrefix: 'siftkit-inference-passthrough-503-',
    modelId: 'managed-passthrough-503-model',
    engine: { initialUnloadedModelProbeCount: 2 },
  });

  const response = await requestJson(`${server.baseUrl}/v1/models`, 30_000);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { data: [{ id: 'managed-passthrough-503-model', object: 'model' }] });
  const modelProbeCount = server.launcher.modelProbeCount;
  assert.ok(modelProbeCount >= 3, `expected two unloaded probes before success, got ${modelProbeCount}`);
});

test('chat passthrough logs every forwarded /v1/chat/completions request', async () => {
  await using server = await PassthroughServer.start({
    tempPrefix: 'siftkit-inference-passthrough-chat-log-',
    modelId: 'managed-chat-log-model',
  });
  using capture = OutputCapture.start(process.stdout);

  const response = await server.postChat({
    messages: [
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'hello' },
    ],
  });

  assert.equal(response.statusCode, 200);
  const forwardLine = capture.lines.find((line) => /proxy [0-9a-f]{8} {2}forward/u.test(line));
  assert.ok(forwardLine, `expected a forward log line, got:\n${capture.lines.join('\n')}`);
  assert.match(forwardLine, /path=\/v1\/chat\/completions/u);
  assert.match(forwardLine, /messages=2/u);
  assert.match(forwardLine, /body_chars=\d+/u);
});

function startSamplerServer(presetOverrides: Partial<ModelRuntimePreset>): Promise<PassthroughServer> {
  return PassthroughServer.start({
    tempPrefix: 'siftkit-inference-passthrough-samplers-',
    modelId: 'managed-sampler-model',
    presetOverrides,
  });
}

test('chat passthrough forces preset samplers and caps max_tokens from NumCtx', async () => {
  await using server = await startSamplerServer({
    Temperature: 0.6,
    TopP: 0.8,
    TopK: 17,
    MinP: 0.03,
    PresencePenalty: 0.9,
    RepetitionPenalty: 1.15,
    NumCtx: 155_000,
    Reasoning: 'off',
  });
  const overreaching = await server.forwardedChat({
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 1.9,
    top_p: 0.1,
    top_k: 99,
    min_p: 0.5,
    presence_penalty: 0,
    repetition_penalty: 2,
    max_tokens: 99_999,
    chat_template_kwargs: { enable_thinking: true },
  });
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

  const modest = await server.forwardedChat({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 128 });
  assert.equal(modest.max_tokens, 128);

  // No caller cap: the window minus the engine-counted prompt itself, so the
  // request can never claim generation room the prompt already occupies.
  const unspecified = await server.forwardedChat({ messages: [{ role: 'user', content: 'hi' }] });
  const unspecifiedMaxTokens = Number(unspecified.max_tokens);
  assert.ok(unspecifiedMaxTokens < 155_000, `max_tokens=${unspecifiedMaxTokens}`);
  assert.ok(unspecifiedMaxTokens > 154_000, `max_tokens=${unspecifiedMaxTokens}`);

  const excessive = await server.forwardedChat({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 200_000 });
  assert.equal(excessive.max_tokens, unspecifiedMaxTokens);
});

test('chat passthrough forwards the preset thinking kwargs when reasoning is on', async () => {
  await using server = await startSamplerServer({ Reasoning: 'on', ReasoningContent: true, PreserveThinking: true });

  const forwarded = await server.forwardedChat({
    messages: [{ role: 'user', content: 'hi' }],
    chat_template_kwargs: { enable_thinking: false },
  });

  assert.deepEqual(forwarded.chat_template_kwargs, {
    enable_thinking: true,
    preserve_thinking: true,
    reasoning_effort: 'xhigh',
  });
});

test('chat passthrough replaces a caller reasoning effort with the preset one', async () => {
  await using server = await startSamplerServer({ Reasoning: 'on', ReasoningEffort: 'medium' });

  const forwarded = await server.forwardedChat({
    messages: [{ role: 'user', content: 'hi' }],
    // The preset owns thinking policy, so a caller cannot pick its own depth.
    chat_template_kwargs: { reasoning_effort: 'low' },
  });

  assert.deepEqual(forwarded.chat_template_kwargs, { enable_thinking: true, reasoning_effort: 'medium' });
});

test('chat passthrough rejects a malformed body with a readable 400 before waking the engine', async () => {
  await using server = await PassthroughServer.start({
    tempPrefix: 'siftkit-inference-passthrough-malformed-',
    modelId: 'managed-malformed-model',
    disableManagedEngineStartup: true,
  });

  const notArray = await server.postChat({ messages: 'hello' });
  const noRole = await server.postChat({ messages: [{ content: 'hello' }] });

  assert.equal(notArray.statusCode, 400);
  assert.match(String(notArray.body.error), /messages/u);
  assert.equal(noRole.statusCode, 400);
  assert.match(String(noRole.body.error), /role/u);
  assert.equal(server.launcher.serving, false);
});

test('tokenize passthrough exposes only the EXL3 token endpoint', async () => {
  // The fake engine tokenizes at 4 characters per token.
  await using server = await PassthroughServer.start({
    tempPrefix: 'siftkit-inference-passthrough-tokenize-',
    modelId: 'managed-tokenize-model',
    engine: { tokenizeCharsPerToken: 4 },
  });

  // 16 characters at 4 chars/token => 4 tokens.
  const response = await requestJsonPost(`${server.baseUrl}/v1/token/encode`, { text: 'abcdefghijklmnop' });
  const removedRoute = await requestJsonPost(`${server.baseUrl}/tokenize`, { content: 'abcdefghijklmnop' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, tabbyTokenEncodeResponse(4));
  assert.equal(removedRoute.statusCode, 404);
});

// The counting engine tokenizes at 8 chars/token, far sparser than SiftKit's 2.5 chars/token
// estimate, so an estimate-priced prompt would be rejected long before the engine's count fills
// the 32k window.
const COUNT_CHARS_PER_TOKEN = 8;
const COUNT_NUM_CTX = 32_000;

function startCountingServer(engine: Omit<FakeTabbyOptions, 'port' | 'modelId'> = {}): Promise<PassthroughServer> {
  return PassthroughServer.start({
    tempPrefix: 'siftkit-inference-passthrough-count-',
    modelId: 'managed-count-model',
    engine: { tokenizeCharsPerToken: COUNT_CHARS_PER_TOKEN, ...engine },
    presetOverrides: { NumCtx: COUNT_NUM_CTX, Reasoning: 'off' },
  });
}

function exactTokens(messages: readonly FakeChatMessage[], tools?: JsonValue): number {
  return countFakeTokens(renderFakeChatTemplate(messages, tools), COUNT_CHARS_PER_TOKEN);
}

function encodeText(launcher: FakeTabbyLauncher, index: number): string {
  const text = launcher.encodeRequests[index]?.body.text;
  if (typeof text !== 'string') assert.fail(`encode request ${index} was not plain text`);
  return text;
}

/** A user message the fake template renders to exactly `tokens` tokens. */
function userMessageOfTokens(tokens: number): { role: string; content: string } {
  return { role: 'user', content: 'h'.repeat(tokens * COUNT_CHARS_PER_TOKEN - '<|user|>'.length) };
}

test('chat passthrough sizes max_tokens from the engine tokenizer, not the character estimate', async () => {
  await using server = await startCountingServer();
  const messages = [{ role: 'user', content: 'x'.repeat(120_000) }];

  const forwarded = await server.forwardedChat({ messages });

  assert.equal(forwarded.max_tokens, COUNT_NUM_CTX - exactTokens(messages));
  assert.deepEqual(
    server.launcher.encodeRequests.map((request) => request.body.chat_template_kwargs),
    [{ enable_thinking: false }],
  );
});

test('chat passthrough tokenizes only the appended messages and reserves their drift', async () => {
  await using server = await startCountingServer();
  const first = [{ role: 'system', content: 'You are terse.' }, { role: 'user', content: 'h'.repeat(80_000) }];
  const firstMaxTokens = Number((await server.forwardedChat({ messages: first })).max_tokens);
  const second = [...first, { role: 'assistant', content: 'done' }, { role: 'user', content: 'next step please' }];

  const secondMaxTokens = Number((await server.forwardedChat({ messages: second })).max_tokens);

  assert.equal(server.launcher.encodeRequests.length, 2);
  const tail = encodeText(server.launcher, 1);
  assert.ok(!tail.includes('hhhh') && tail.includes('next step please'), tail);
  assert.equal(
    secondMaxTokens,
    firstMaxTokens - countFakeTokens(tail, COUNT_CHARS_PER_TOKEN) - 2 * PASSTHROUGH_MESSAGE_DRIFT_TOKENS,
  );

  // An identical retry reuses the stored count without tokenizing again.
  assert.equal(Number((await server.forwardedChat({ messages: second })).max_tokens), secondMaxTokens);
  assert.equal(server.launcher.encodeRequests.length, 2);
});

test('an agent-loop tail counts tool calls and only the reasoning the template keeps', async () => {
  await using server = await startCountingServer();
  const question = [{ role: 'user', content: 'q'.repeat(4_000) }];
  await server.forwardedChat({ messages: question });
  const toolTurn: JsonObject[] = [
    ...question,
    {
      role: 'assistant',
      content: null,
      reasoning_content: 'plan the read',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'file body' },
  ];
  await server.forwardedChat({ messages: toolTurn });
  const nextQuestion: JsonObject[] = [
    ...toolTurn,
    { role: 'assistant', content: 'answered', reasoning_content: 'dropped once a user follows' },
    { role: 'user', content: 'next question' },
  ];

  await server.forwardedChat({ messages: nextQuestion });

  const toolTail = encodeText(server.launcher, 1);
  assert.ok(toolTail.includes('plan the read'), toolTail);
  assert.ok(toolTail.includes('read_file{"path":"a.ts"}'), toolTail);
  assert.ok(toolTail.includes('file body'), toolTail);
  const questionTail = encodeText(server.launcher, 2);
  assert.ok(questionTail.includes('answered') && questionTail.includes('next question'), questionTail);
  assert.ok(!questionTail.includes('dropped once a user follows'), questionTail);
});

test('chat passthrough recounts the whole prompt when earlier history changes', async () => {
  await using server = await startCountingServer();
  await server.forwardedChat({ messages: [{ role: 'user', content: 'a'.repeat(40_000) }] });
  const rewritten = [{ role: 'user', content: 'b'.repeat(40_000) }, { role: 'assistant', content: 'ok' }];

  const forwarded = await server.forwardedChat({ messages: rewritten });

  assert.deepEqual(server.launcher.encodeRequests[1]?.body.text, rewritten);
  assert.equal(forwarded.max_tokens, COUNT_NUM_CTX - exactTokens(rewritten));
});

test('chat passthrough recounts the whole prompt when its tools change', async () => {
  await using server = await startCountingServer();
  const readTool = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }];
  const writeTool = [{ type: 'function', function: { name: 'write_file', parameters: { type: 'object' } } }];
  const first = [{ role: 'user', content: 'a'.repeat(4_000) }];
  await server.forwardedChat({ messages: first, tools: readTool });
  const second = [...first, { role: 'assistant', content: 'ok' }];

  const forwarded = await server.forwardedChat({ messages: second, tools: writeTool });

  assert.deepEqual(server.launcher.encodeRequests[1]?.body.text, second);
  assert.equal(forwarded.max_tokens, COUNT_NUM_CTX - exactTokens(second, writeTool));
});

test('chat passthrough treats null tools as no tools', async () => {
  await using server = await startCountingServer();

  await server.forwardedChat({ messages: [{ role: 'user', content: 'hi' }], tools: null });

  assert.deepEqual(server.launcher.encodeRequests[0]?.body.chat_template_kwargs, { enable_thinking: false });
});

test('chat passthrough recounts exactly when a reused count could reach the window by its drift', async () => {
  await using server = await startCountingServer();
  // The appended tail leaves the reused count within one message of drift of the window.
  const first = [userMessageOfTokens(COUNT_NUM_CTX - PASSTHROUGH_MESSAGE_DRIFT_TOKENS)];
  await server.forwardedChat({ messages: first });
  const second = [...first, { role: 'assistant', content: 'a'.repeat(8) }];

  const forwarded = await server.forwardedChat({ messages: second });

  // Encodes: the first full count, the appended tail, then one exact full recount.
  assert.equal(server.launcher.encodeRequests.length, 3);
  assert.deepEqual(server.launcher.encodeRequests[2]?.body.text, second);
  assert.equal(forwarded.max_tokens, COUNT_NUM_CTX - exactTokens(second));
});

test('chat passthrough rejects a prompt the engine counts past the context window', async () => {
  await using server = await startCountingServer();

  const response = await server.postChat({ messages: [{ role: 'user', content: 'x'.repeat(260_000) }] });

  assert.equal(response.statusCode, 502);
  assert.match(String(response.body.error), /fills the 32000-token context window/u);
});

test('chat passthrough fails the request when the engine cannot tokenize it', async () => {
  await using server = await startCountingServer({ rejectTokenize: true });

  const response = await server.postChat({ messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(response.statusCode, 502);
  assert.match(String(response.body.error), /tokeniz/iu);
});

test('chat passthrough answers 503, not an upstream failure, while the model is manually unloaded', async () => {
  await using server = await startCountingServer();
  await server.forwardedChat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal((await requestJsonPost(`${server.baseUrl}/runtime/model/unload`, {}, 30_000)).statusCode, 200);

  const response = await server.postChat({ messages: [{ role: 'user', content: 'hi again' }] });

  assert.equal(response.statusCode, 503);
  assert.match(String(response.body.error), /unloaded manually/u);
});

test('chat passthrough counts with the caller authorization', async () => {
  await using server = await startCountingServer();
  const first = [{ role: 'user', content: 'hi' }];
  const headers = { authorization: 'Bearer caller-key' };

  await server.forwardedChat({ messages: first }, headers);
  await server.forwardedChat({ messages: [...first, { role: 'assistant', content: 'ok' }] }, headers);

  assert.deepEqual(
    server.launcher.encodeRequests.map((request) => request.authorization),
    ['Bearer caller-key', 'Bearer caller-key'],
  );
});

test('chat passthrough counts images with the flat allowance and tools through the template', async () => {
  await using server = await startCountingServer();
  const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }];

  const forwarded = await server.forwardedChat({
    tools,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'describe this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    }],
  });

  const textOnly = [{ role: 'user', content: [{ type: 'text', text: 'describe this' }] }];
  assert.deepEqual(server.launcher.encodeRequests[0]?.body.text, textOnly);
  assert.deepEqual(server.launcher.encodeRequests[0]?.body.chat_template_kwargs, { enable_thinking: false, tools });
  assert.equal(forwarded.max_tokens, COUNT_NUM_CTX - exactTokens(textOnly, tools) - SIFT_IMAGE_TOKEN_ESTIMATE);
});

/** Tabby-consistent counts and timings whose reported decode rate (30) drifts from 754 / 35.07. */
const DRIFTING_USAGE = {
  ...buildTabbyUsage({ promptTokens: 3365, completionTokens: 754, promptTime: 3.88, completionTime: 35.07 }),
  completion_tokens_per_sec: 30,
};

function startAuditServer(tempPrefix: string): Promise<PassthroughServer> {
  return PassthroughServer.start({ tempPrefix, modelId: 'managed-audit-model' });
}

function postRaw(server: PassthroughServer, body: JsonValue, abort = false): Promise<RawTextResponse> {
  return requestRawText(`${server.baseUrl}/v1/chat/completions`, body, { abortAfterFirstChunk: abort });
}

function throughputLines(capture: OutputCapture): string[] {
  return capture.lines.filter((line) => /throughput_/u.test(line));
}

test('streaming passthrough audits a drifting usage frame while proxying bytes unchanged', async () => {
  await using server = await startAuditServer('siftkit-passthrough-audit-stream-');
  using capture = OutputCapture.start(process.stdout);

  const response = await postRaw(server, {
    messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true },
    fake_engine: { usage: DRIFTING_USAGE },
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.contentType, /text\/event-stream/u);
  assert.match(response.text, /"completion_tokens_per_sec":30/u);
  assert.match(response.text, /data: \[DONE\]/u);
  const audit = throughputLines(capture);
  assert.equal(audit.length, 1, audit.join('\n'));
  assert.match(audit[0], /throughput_mismatch/u);
  assert.match(audit[0], /operation=passthrough/u);
  assert.match(audit[0], /stage=chat_completions/u);
  assert.match(audit[0], /scope=request/u);
  assert.match(audit[0], /metric=decode/u);
  assert.match(audit[0], /generated_tokens=754/u);
  assert.match(audit[0], /preset=/u);
});

test('passthrough stays silent for consistent usage and for a stream that never opted into usage', async () => {
  await using server = await startAuditServer('siftkit-passthrough-audit-quiet-');
  using capture = OutputCapture.start(process.stdout);

  const consistent = await postRaw(server, {
    messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true },
  });
  const noUsage = await postRaw(server, {
    messages: [{ role: 'user', content: 'hi' }], stream: true, fake_engine: { usage: null },
  });

  assert.equal(consistent.statusCode, 200);
  assert.equal(noUsage.statusCode, 200);
  assert.doesNotMatch(noUsage.text, /usage/u);
  assert.deepEqual(throughputLines(capture), []);
});

test('passthrough reports a stream that opted into usage but received none as unverifiable', async () => {
  await using server = await startAuditServer('siftkit-passthrough-audit-missing-');
  using capture = OutputCapture.start(process.stdout);

  await postRaw(server, {
    messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true }, fake_engine: { usage: null },
  });

  const audit = throughputLines(capture);
  assert.equal(audit.length, 2, audit.join('\n'));
  assert.match(audit[0], /throughput_unverifiable/u);
  assert.match(audit[0], /operation=passthrough/u);
  assert.match(audit[0], /metric=pp/u);
  assert.match(audit[1], /metric=decode/u);
});

test('non-streaming passthrough parses the JSON response once and audits both metrics', async () => {
  await using server = await startAuditServer('siftkit-passthrough-audit-json-');
  using capture = OutputCapture.start(process.stdout);

  const response = await postRaw(server, {
    messages: [{ role: 'user', content: 'hi' }],
    fake_engine: { usage: { ...DRIFTING_USAGE, prompt_tokens_per_sec: 700 } },
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.contentType, /application\/json/u);
  assert.equal(asObject(parseJsonValueText(response.text)).usage !== undefined, true);
  const audit = throughputLines(capture);
  assert.equal(audit.length, 2, audit.join('\n'));
  assert.match(audit[0], /throughput_mismatch/u);
  assert.match(audit[0], /metric=pp/u);
  assert.match(audit[1], /metric=decode/u);
});

test('passthrough abandons observation of an oversized frame without throwing', async () => {
  await using server = await startAuditServer('siftkit-passthrough-audit-oversize-');
  using capture = OutputCapture.start(process.stdout);

  const response = await postRaw(server, {
    messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true },
    fake_engine: { usage: DRIFTING_USAGE, padding_chars: 300 * 1024 },
  });

  assert.equal(response.statusCode, 200);
  assert.ok(response.text.length > 300 * 1024);
  assert.match(response.text, /data: \[DONE\]/u);
  assert.deepEqual(throughputLines(capture), []);
});

test('a client abort mid-stream produces no audit and leaves the passthrough usable', async () => {
  await using server = await startAuditServer('siftkit-passthrough-audit-abort-');
  using capture = OutputCapture.start(process.stdout);

  const aborted = await postRaw(server, {
    messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true },
    fake_engine: { usage: DRIFTING_USAGE, finish_delay_ms: 1500 },
  }, true);
  assert.equal(aborted.statusCode, 200);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.deepEqual(throughputLines(capture), []);

  const next = await postRaw(server, { messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(next.statusCode, 200);
  assert.deepEqual(throughputLines(capture), []);
});

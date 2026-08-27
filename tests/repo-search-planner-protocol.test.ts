import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { ModelJson } from '../src/lib/model-json.js';
import { JsonObjectSchema, type JsonObject } from '../src/lib/json-types.js';
import type { ModelRuntimePreset, SiftConfig } from '../src/config/types.js';
import { asObject, asObjectArray, getAddressInfo } from './helpers/dashboard-http.js';
import { sendChatCompletionSse } from './helpers/streaming-client.js';
import { mockSiftConfig } from './helpers/mock-config.js';
import { getSupportedImageExtensions } from '../src/llm-protocol/image-attachments.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { toProtocolTools } from '../src/providers/llama-cpp.js';
import {
  captureExecutingPlannerRequest,
  getRepoSearchToolNames,
  requestApprovalVerdict,
  requestContextCompactionSummary,
  requestRepoSearchPlannerProtocolAction,
  resolveRepoSearchPlannerToolDefinitions,
  serializeProtocolMessages,
  TOOL_DEFINITIONS,
  type ChatMessage,
  type PlannerActionResponse,
  type PlannerDerivedRequestOptions,
  type PlannerThinkingFlags,
} from '../src/repo-search/planner-protocol.js';
import type { JsonLogger } from '../src/repo-search/types.js';

const TEXT_ONLY_READ_DESCRIPTION = 'Read the contents of a repository file. Lines are returned numbered. Use offset/limit for large files; when you need the full file, continue with offset until complete. Lines already returned in this task are skipped automatically, and a read whose whole range was already returned is rejected. Editing or writing a file clears that history, so you can read it again to see your change.';
const PLANNER_REQUEST_DEFAULTS = {
  stage: 'planner_action',
  thinkingEnabled: false,
  reasoningContentEnabled: false,
  preserveThinking: false,
  tools: toProtocolTools(TOOL_DEFINITIONS),
  responseSchema: null,
} as const;

function readDescription(
  definitions: ReturnType<typeof resolveRepoSearchPlannerToolDefinitions>,
): string {
  const read = definitions.find((definition) => definition.function.name === 'read');
  assert.ok(read, 'read tool definition is present');
  return read.function.description ?? '';
}

type PresetOverrides = Partial<ModelRuntimePreset>;

function buildTestConfig(preset: PresetOverrides = {}): SiftConfig {
  return mockSiftConfig({
    Server: { ModelPresets: { ActivePresetId: 'default', Presets: [{ id: 'default', ...preset, IdleAction: 'unload' }] } },
  });
}

async function captureChatRequestBody(
  run: (baseUrl: string) => Promise<PlannerActionResponse>,
  responseContent = '{"action":"finish","output":"done"}',
): Promise<JsonObject> {
  let capturedBody: JsonObject | null = null;
  await withServer(
    (req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        capturedBody = JsonObjectSchema.parse(parseJsonValueText(body || '{}'));
        sendChatCompletionSse(res, { choices: [{ message: { content: responseContent } }] });
      });
    },
    async (baseUrl) => {
      await run(baseUrl);
    },
  );
  return asObject(capturedBody);
}

async function withServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', (error?: Error) => (error ? reject(error) : resolve()));
  });
  try {
    const address = getAddressInfo(server);
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test('resolveRepoSearchPlannerToolDefinitions only emits web tool schemas when explicitly allowed', () => {
  const withoutWeb = resolveRepoSearchPlannerToolDefinitions(['grep']);
  assert.equal(
    withoutWeb.some((tool) => tool.function.name === 'web_search'),
    false,
  );
  assert.equal(
    withoutWeb.some((tool) => tool.function.name === 'web_fetch'),
    false,
  );

  const withWeb = resolveRepoSearchPlannerToolDefinitions(['grep', 'web_search', 'web_fetch']);
  assert.equal(
    withWeb.some((tool) => tool.function.name === 'web_search'),
    true,
  );
  assert.equal(
    withWeb.some((tool) => tool.function.name === 'web_fetch'),
    true,
  );
  const webSearch = withWeb.find((tool) => tool.function.name === 'web_search');
  assert.deepEqual(webSearch?.function?.parameters?.required, ['query']);
});

test('the text-only read description is byte-identical to the historical string', () => {
  assert.equal(
    readDescription(resolveRepoSearchPlannerToolDefinitions(undefined, false)),
    TEXT_ONLY_READ_DESCRIPTION,
  );
});

test('TOOL_DEFINITIONS keeps the text-only read description', () => {
  assert.equal(readDescription(TOOL_DEFINITIONS), TEXT_ONLY_READ_DESCRIPTION);
});

test('the vision read description names every supported extension from the MIME map', () => {
  const description = readDescription(resolveRepoSearchPlannerToolDefinitions(undefined, true));
  assert.ok(description.startsWith(TEXT_ONLY_READ_DESCRIPTION));
  for (const extension of getSupportedImageExtensions()) {
    assert.ok(description.includes(extension), `names ${extension}`);
  }
  assert.ok(description.includes('offset` and `limit` do not apply to images'));
});

test('run output-mode guidance is readable ASCII text', () => {
  const run = resolveRepoSearchPlannerToolDefinitions(['run'])
    .find((tool) => tool.function.name === 'run');
  const description = asObject(asObject(run?.function.parameters.properties).outputMode).description;

  if (typeof description !== 'string') throw new Error('run outputMode description must be a string');
  assert.match(description, /commands - use it for those/u);
  assert.doesNotMatch(description, /[^\x00-\x7F]/u);
});

test('repo-search tool registry exposes the pi tool surface and withholds the mutating tools', () => {
  const toolNames = getRepoSearchToolNames().sort();
  assert.deepEqual(toolNames, ['find', 'git', 'grep', 'ls', 'read', 'web_fetch', 'web_search']);
  for (const withheld of ['write', 'edit', 'run']) {
    assert.equal(toolNames.includes(withheld), false);
  }

  const definitions = resolveRepoSearchPlannerToolDefinitions();
  const read = definitions.find((tool) => tool.function.name === 'read');
  assert.deepEqual(read?.function.parameters.required, ['path']);
  const readProperties = asObject(read?.function.parameters.properties);
  assert.equal(asObject(readProperties.offset).type, 'integer');
  assert.equal(asObject(readProperties.limit).type, 'integer');

  const grep = definitions.find((tool) => tool.function.name === 'grep');
  assert.deepEqual(grep?.function.parameters.required, ['pattern']);
  const grepProperties = asObject(grep?.function.parameters.properties);
  assert.equal(asObject(grepProperties.glob).type, 'string');
  assert.equal(asObject(grepProperties.literal).type, 'boolean');

  const find = definitions.find((tool) => tool.function.name === 'find');
  assert.deepEqual(find?.function.parameters.required, ['pattern']);

  const ls = definitions.find((tool) => tool.function.name === 'ls');
  // Every ls argument is optional, so the generated schema omits `required` entirely.
  assert.equal(ls?.function.parameters.required, undefined);
  assert.equal(asObject(asObject(ls?.function.parameters.properties).path).type, 'string');

  const git = definitions.find((tool) => tool.function.name === 'git');
  const gitParameters = git?.function?.parameters;
  assert.ok(gitParameters);
  assert.equal(JSON.stringify(gitParameters).includes('command'), false);
  assert.equal(JSON.stringify(gitParameters).includes('operation'), true);
  assert.equal(JSON.stringify(gitParameters).includes('ls_files'), true);
});

test('requestRepoSearchPlannerProtocolAction preserves a native batch from multi-tool responses', async () => {
  await withServer(
    (req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.statusCode = 404;
        res.end();
        return;
      }
      sendChatCompletionSse(res, {
          choices: [
            {
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: {
                      name: 'grep',
                      arguments: '{"pattern":"plan"}',
                    },
                  },
                  {
                    id: 'call_2',
                    type: 'function',
                    function: {
                      name: 'grep',
                      arguments: '{"pattern":"repo-search"}',
                    },
                  },
                ],
              },
            },
          ],
        });
    },
    async (baseUrl) => {
      const result = await requestRepoSearchPlannerProtocolAction({
        ...PLANNER_REQUEST_DEFAULTS,
        config: buildTestConfig(),
        baseUrl,
        model: 'mock-model',
        messages: [{ role: 'user', content: 'find plan and repo-search' }],
        timeoutMs: 5000,
        maxTokens: 512,
      });

      assert.equal(result.mockExhausted, false);
      assert.deepEqual(result.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        toolName: toolCall.function.name,
        args: ModelJson.parseToolArguments(toolCall.function.arguments),
      })), [
        { id: 'call_1', toolName: 'grep', args: { pattern: 'plan' } },
        { id: 'call_2', toolName: 'grep', args: { pattern: 'repo-search' } },
      ]);
    },
  );
});

test('requestRepoSearchPlannerProtocolAction preserves a native batch from streaming multi-tool responses', async () => {
  await withServer(
    (req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"grep","arguments":"{\\"pattern\\":\\"plan\\"}"}},{"index":1,"function":{"name":"grep","arguments":"{\\"pattern\\":\\"repo-search\\"}"}}]}}]}\n\n',
      );
      res.write('data: [DONE]\n\n');
      res.end();
    },
    async (baseUrl) => {
      const result = await requestRepoSearchPlannerProtocolAction({
        ...PLANNER_REQUEST_DEFAULTS,
        config: buildTestConfig(),
        baseUrl,
        model: 'mock-model',
        messages: [{ role: 'user', content: 'find plan and repo-search' }],
        timeoutMs: 5000,
        maxTokens: 512,
      });

      assert.deepEqual(result.toolCalls.map((toolCall) => ({
        toolName: toolCall.function.name,
        args: ModelJson.parseToolArguments(toolCall.function.arguments),
      })), [
        { toolName: 'grep', args: { pattern: 'plan' } },
        { toolName: 'grep', args: { pattern: 'repo-search' } },
      ]);
    },
  );
});

test('requestRepoSearchPlannerProtocolAction stops streamed content when recent tokens repeat in long output', async () => {
  const repeatedTail = '</arg_value>'.repeat(64);
  const longPrefix = Array.from({ length: 101 }, (_, index) => `anchor-${index}`).join(' ');
  const events: JsonObject[] = [];

  await withServer(
    (req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${longPrefix} ${repeatedTail}` } }] })}\n\n`);
    },
    async (baseUrl) => {
      const result = await requestRepoSearchPlannerProtocolAction({
        ...PLANNER_REQUEST_DEFAULTS,
        config: buildTestConfig(),
        baseUrl,
        model: 'mock-model',
        messages: [{ role: 'user', content: 'find planner' }],
        timeoutMs: 2000,
        maxTokens: 512,
        logger: {
          path: 'memory',
          write(event) {
            events.push(JsonObjectSchema.parse(parseJsonValueText(JSON.stringify(event))));
          },
        },
      });

      const doneEvent = events.find((event) => event.kind === 'provider_request_done');
      assert.match(String(doneEvent?.earlyTerminationReason || ''), /recent planner content tokens repeated/u);
      assert.match(result.text, /SiftKit stopped the planner stream early/u);
      assert.doesNotMatch(result.text, new RegExp(repeatedTail, 'u'));
    },
  );
});

test('requestRepoSearchPlannerProtocolAction does not stop streamed content for a short repeated suffix', async () => {
  const repeatedTail = '</arg_value>'.repeat(10);
  const longPrefix = Array.from({ length: 101 }, (_, index) => `anchor-${index}`).join(' ');
  const streamedText = `${longPrefix} ${repeatedTail}`;
  const events: JsonObject[] = [];

  await withServer(
    (req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: streamedText } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    },
    async (baseUrl) => {
      const result = await requestRepoSearchPlannerProtocolAction({
        ...PLANNER_REQUEST_DEFAULTS,
        config: buildTestConfig(),
        baseUrl,
        model: 'mock-model',
        messages: [{ role: 'user', content: 'find planner' }],
        timeoutMs: 2000,
        maxTokens: 512,
        logger: {
          path: 'memory',
          write(event) {
            events.push(JsonObjectSchema.parse(parseJsonValueText(JSON.stringify(event))));
          },
        },
      });

      const doneEvent = events.find((event) => event.kind === 'provider_request_done');
      assert.equal(Object.prototype.hasOwnProperty.call(doneEvent || {}, 'earlyTerminationReason'), false);
      assert.equal(result.text, streamedText);
    },
  );
});

test('requestRepoSearchPlannerProtocolAction uses llama timings from the final streaming chunk when usage is absent', async () => {
  await withServer(
    (req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      setTimeout(() => {
        res.write('data: {"choices":[{"delta":{"content":"{\\"action\\":\\"finish\\",\\"output\\":\\"done\\"}"}}]}\n\n');
        setTimeout(() => {
          res.write(
            'data: {"choices":[{"delta":{}}],"timings":{"cache_n":20,"prompt_n":10,"prompt_ms":30.5,"prompt_per_second":327.86,"predicted_n":4,"predicted_ms":18.75,"predicted_per_second":213.33},"__verbose":{"tokens_predicted":4,"timings":{"cache_n":20,"prompt_n":10,"prompt_ms":30.5,"prompt_per_second":327.86,"predicted_n":4,"predicted_ms":18.75,"predicted_per_second":213.33}}}\n\n',
          );
          res.write('data: [DONE]\n\n');
          res.end();
        }, 20);
      }, 20);
    },
    async (baseUrl) => {
      const result = await requestRepoSearchPlannerProtocolAction({
        ...PLANNER_REQUEST_DEFAULTS,
        config: buildTestConfig(),
        baseUrl,
        model: 'mock-model',
        messages: [{ role: 'user', content: 'finish' }],
        timeoutMs: 5000,
        maxTokens: 512,
      });

      assert.equal(result.promptEvalTokens, 10);
      assert.equal(result.promptEvalDurationMs, 30.5);
      assert.equal(result.generationDurationMs, 18.75);
    },
  );
});

test('requestRepoSearchPlannerProtocolAction aborts an in-flight streaming request', async () => {
  await withServer(
    (req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('data: {"choices":[{"delta":{"content":"{\\"action\\":\\"finish"}}]}\n\n');
    },
    async (baseUrl) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('Repo search prompt exceeded 20 ms. Please try again.')), 20);
      try {
        await assert.rejects(
          () =>
            requestRepoSearchPlannerProtocolAction({
              ...PLANNER_REQUEST_DEFAULTS,
              config: buildTestConfig(),
              baseUrl,
              model: 'mock-model',
              messages: [{ role: 'user', content: 'finish slowly' }],
              timeoutMs: 5000,
              maxTokens: 512,
              abortSignal: controller.signal,
            }),
          /Repo search prompt exceeded 20 ms\. Please try again\./u,
        );
      } finally {
        clearTimeout(timer);
      }
    },
  );
});

test('requestRepoSearchPlannerProtocolAction sends native tools without response format or grammar', async () => {
  let capturedBody: JsonObject | null = null;
  await withServer(
    (req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.statusCode = 404;
        res.end();
        return;
      }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        capturedBody = JsonObjectSchema.parse(parseJsonValueText(body || '{}'));
        sendChatCompletionSse(res, {
            choices: [{ message: { content: '{"action":"finish","output":"done"}' } }],
          });
      });
    },
    async (baseUrl) => {
      await requestRepoSearchPlannerProtocolAction({
        ...PLANNER_REQUEST_DEFAULTS,
        config: buildTestConfig(),
        baseUrl,
        model: 'mock-model',
        messages: [{ role: 'user', content: 'find plan and repo-search' }],
        timeoutMs: 5000,
        maxTokens: 512,
      });

      const captured = asObject(capturedBody);
      assert.equal('response_format' in captured, false);
      assert.match(JSON.stringify(captured.tools), /"name":"git"/u);
      assert.equal(captured.parallel_tool_calls, true);
      assert.equal('grammar' in captured, false);
    },
  );
});

test('requestRepoSearchPlannerProtocolAction forwards native EXL3 tools without planner structured output', async () => {
  let capturedBody: JsonObject | null = null;
  await withServer(
    (req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        capturedBody = JsonObjectSchema.parse(parseJsonValueText(body || '{}'));
        sendChatCompletionSse(res, {
            choices: [{ message: { content: '{"action":"finish","output":"done"}' } }],
          });
      });
    },
    async (baseUrl) => {
      await requestRepoSearchPlannerProtocolAction({
        ...PLANNER_REQUEST_DEFAULTS,
        config: buildTestConfig({ Backend: 'exl3' }),
        baseUrl,
        model: 'mock-model',
        messages: [{ role: 'user', content: 'find plan and repo-search' }],
        timeoutMs: 5000,
        maxTokens: 512,
      });

      const captured = asObject(capturedBody);
      assert.equal('response_format' in captured, false);
      assert.match(JSON.stringify(captured.tools), /"name":"git"/u);
      assert.equal('cache_prompt' in captured, false);
      assert.equal('id_slot' in captured, false);
    },
  );
});

test('requestRepoSearchPlannerProtocolAction sends and returns provided native tool definitions', async () => {
  let capturedBody: JsonObject | null = null;
  let plannerResponse: PlannerActionResponse | null = null;
  await withServer(
    (req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.statusCode = 404;
        res.end();
        return;
      }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        capturedBody = JsonObjectSchema.parse(parseJsonValueText(body || '{}'));
        sendChatCompletionSse(res, {
          choices: [{ message: { content: '<tool_call><function=search_symbol><parameter=symbol>buildPlanner</parameter></function></tool_call>' } }],
        });
      });
    },
    async (baseUrl) => {
      plannerResponse = await requestRepoSearchPlannerProtocolAction({
        ...PLANNER_REQUEST_DEFAULTS,
        config: buildTestConfig(),
        baseUrl,
        model: 'mock-model',
        messages: [{ role: 'user', content: 'find symbol' }],
        timeoutMs: 5000,
        maxTokens: 512,
        tools: toProtocolTools([
          {
            kind: 'tool',
            type: 'function',
            argumentSchema: JsonObjectSchema,
            exampleArgs: { symbol: 'buildPlanner' },
            function: {
              name: 'search_symbol',
              description: 'search symbols',
              parameters: {
                type: 'object',
                properties: { symbol: { type: 'string' } },
                required: ['symbol'],
              },
            },
          },
        ]),
      });

      const captured = asObject(capturedBody);
      const toolsText = JSON.stringify(captured.tools || {});
      assert.match(toolsText, /search_symbol/u);
      assert.doesNotMatch(toolsText, /run_repo_cmd/u);
      assert.match(toolsText, /"parameters":\{"type":"object"/u);
      assert.equal('response_format' in captured, false);
      assert.equal(plannerResponse.toolCalls[0]?.id, 'call_search_symbol_0');
      assert.equal(plannerResponse.toolCalls[0]?.function.name, 'search_symbol');
    },
  );
});

test('requestRepoSearchPlannerProtocolAction sends the active preset sampler values, not hardcoded planner values', async () => {
  const config = buildTestConfig({
    Temperature: 0.42,
    TopP: 0.9,
    TopK: 33,
    MinP: 0.05,
    PresencePenalty: 0.7,
    RepetitionPenalty: 1.1,
    MaxTokens: 4000,
  });

  const captured = await captureChatRequestBody((baseUrl) => requestRepoSearchPlannerProtocolAction({
    ...PLANNER_REQUEST_DEFAULTS,
    config,
    baseUrl,
    model: 'test-model',
    messages: [{ role: 'user', content: 'hi' }],
    timeoutMs: 5000,
    maxTokens: 2048,
    thinkingEnabled: false,
    reasoningContentEnabled: false,
    preserveThinking: false,
  }));

  assert.equal(captured.temperature, 0.42);
  assert.equal(captured.top_p, 0.9);
  assert.equal(captured.top_k, 33);
  assert.equal(captured.min_p, 0.05);
  assert.equal(captured.presence_penalty, 0.7);
  assert.equal(captured.max_tokens, 2048);
});

test('derived planner requests reject every cache-contract divergence before logging or HTTP', async () => {
  let requestCount = 0;
  const loggerEvents: JsonObject[] = [];
  await withServer(
    (_req, res) => {
      requestCount += 1;
      sendChatCompletionSse(res, { choices: [{ message: { content: 'unexpected' } }] });
    },
    async (baseUrl) => {
      const flags: PlannerThinkingFlags = {
        thinkingEnabled: true,
        reasoningContentEnabled: true,
        preserveThinking: true,
      };
      const tools = toProtocolTools(resolveRepoSearchPlannerToolDefinitions(['read']));
      const history: ChatMessage[] = [{ role: 'user', content: 'same request' }];
      const messages = serializeProtocolMessages(history, true);
      const cachePrefix = captureExecutingPlannerRequest(messages, flags, tools, 2);
      const logger: JsonLogger = {
            path: 'test',
            write(event) {
              loggerEvents.push(JsonObjectSchema.parse(parseJsonValueText(JSON.stringify(event))));
            },
      };
      const common = {
        config: buildTestConfig(),
        baseUrl,
        model: 'test-model',
        timeoutMs: 5_000,
        maxTokens: 128,
        stage: 'approval_verdict',
        toolChoice: 'none',
        responseSchema: null,
        cachePrefix,
        logger,
      } as const;
      const cases: Array<{ options: PlannerDerivedRequestOptions; error: RegExp }> = [
        {
          options: { ...common, messages: [{ role: 'user', content: 'different' }], slotId: 2, ...flags, tools },
          error: /approval_verdict prompt-cache contract violated: message 0 diverged/u,
        },
        {
          options: { ...common, messages, slotId: 2, ...flags, tools: [] },
          error: /approval_verdict prompt-cache contract violated: tools diverged/u,
        },
        {
          options: { ...common, messages, slotId: 2, ...flags, thinkingEnabled: false, tools },
          error: /approval_verdict prompt-cache contract violated: thinkingEnabled diverged/u,
        },
        {
          options: { ...common, messages, slotId: 2, ...flags, reasoningContentEnabled: false, tools },
          error: /approval_verdict prompt-cache contract violated: reasoningContentEnabled diverged/u,
        },
        {
          options: { ...common, messages, slotId: 2, ...flags, preserveThinking: false, tools },
          error: /approval_verdict prompt-cache contract violated: preserveThinking diverged/u,
        },
        {
          options: { ...common, messages, slotId: 1, ...flags, tools },
          error: /approval_verdict prompt-cache contract violated: slot expected 2, received 1/u,
        },
      ];

      for (const current of cases) {
        await assert.rejects(
          requestRepoSearchPlannerProtocolAction(current.options),
          current.error,
        );
      }
    },
  );

  assert.equal(requestCount, 0);
  assert.equal(loggerEvents.some((event) => event.kind === 'provider_request_start'), false);
});

test('requestApprovalVerdict clamps the verdict maxTokens to the preset MaxTokens', async () => {
  const config = buildTestConfig({ MaxTokens: 300 });

  const captured = await captureChatRequestBody((baseUrl) => requestApprovalVerdict({
    config,
    baseUrl,
    model: 'test-model',
    transcriptMessages: [],
    pendingMessages: [],
    question: 'ok?',
    executing: captureExecutingPlannerRequest([], {
      thinkingEnabled: false,
      reasoningContentEnabled: false,
      preserveThinking: false,
    }, toProtocolTools(resolveRepoSearchPlannerToolDefinitions(['run'])), 2),
    timeoutMs: 5000,
  }), '{"verdict":"approve","reason":"ok"}');

  assert.equal(captured.max_tokens, 300);
});

test('context compaction branches from an actual preceding planner request', async () => {
  const capturedBodies: JsonObject[] = [];
  await withServer(
    (req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.statusCode = 404;
        res.end();
        return;
      }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        capturedBodies.push(JsonObjectSchema.parse(parseJsonValueText(body || '{}')));
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify({
          choices: [{ delta: { content: capturedBodies.length === 1 ? 'planner response' : 'SUMMARY TEXT' } }],
        })}\n\n`);
        res.write(
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],'
          + '"usage":{"prompt_tokens":338,"prompt_tokens_details":{"cached_tokens":321}},'
          + '"timings":{"cache_n":321,"prompt_n":17}}\n\n',
        );
        res.write('data: [DONE]\n\n');
        res.end();
      });
    },
    async (baseUrl) => {
      const plannerHistory: ChatMessage[] = [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'old question' },
        { role: 'assistant', content: 'old answer', reasoning_content: 'old reasoning' },
      ];
      const branchHistory = plannerHistory.slice(0, 2);
      const instruction = 'summarize now';
      const tools = toProtocolTools(resolveRepoSearchPlannerToolDefinitions(['read']));
      const flags: PlannerThinkingFlags = {
        thinkingEnabled: false,
        reasoningContentEnabled: true,
        preserveThinking: false,
      };
      const serializedPlanner = serializeProtocolMessages(plannerHistory, true);
      await requestRepoSearchPlannerProtocolAction({
        config: buildTestConfig({ Backend: 'llama' }),
        baseUrl,
        model: 'mock-model',
        messages: serializedPlanner,
        slotId: 2,
        timeoutMs: 5000,
        maxTokens: 512,
        ...flags,
        stage: 'planner_action',
        responseSchema: null,
        tools,
      });
      const executing = captureExecutingPlannerRequest(serializedPlanner, flags, tools, 2);
      const response = await requestContextCompactionSummary({
        config: buildTestConfig({ Backend: 'llama' }),
        baseUrl,
        model: 'mock-model',
        messages: branchHistory,
        instruction,
        cacheOrigin: { kind: 'planner', executing },
        timeoutMs: 5000,
        maxTokens: 512,
      });

      assert.equal(capturedBodies.length, 2);
      const plannerBody = asObject(capturedBodies[0]);
      const body = asObject(capturedBodies[1]);
      const plannerMessages = asObjectArray(plannerBody.messages);
      const requestMessages = asObjectArray(body.messages);
      assert.deepEqual(requestMessages.slice(0, branchHistory.length), plannerMessages.slice(0, branchHistory.length));
      assert.deepEqual(requestMessages.at(-1), { role: 'user', content: instruction });
      assert.equal(body.cache_prompt, true);
      assert.equal(body.id_slot, 2);
      assert.deepEqual(body.tools, tools);
      assert.equal(body.tool_choice, 'none');
      assert.equal(body.response_format, undefined);
      assert.equal(response.promptCacheTokens, 321);
      assert.equal(response.promptEvalTokens, 17);
    },
  );
});

test('context compaction rejects a branch that diverges from its executing planner request before HTTP', async () => {
  let requestCount = 0;
  await withServer(
    (_req, res) => {
      requestCount += 1;
      sendChatCompletionSse(res, { choices: [{ message: { content: 'unexpected' } }] });
    },
    async (baseUrl) => {
      const flags: PlannerThinkingFlags = {
        thinkingEnabled: false,
        reasoningContentEnabled: false,
        preserveThinking: false,
      };
      const tools = toProtocolTools(resolveRepoSearchPlannerToolDefinitions(['read']));
      const executingMessages = serializeProtocolMessages([{ role: 'system', content: 'original' }], false);
      const executing = captureExecutingPlannerRequest(executingMessages, flags, tools, 2);

      await assert.rejects(
        requestContextCompactionSummary({
          config: buildTestConfig(),
          baseUrl,
          model: 'mock-model',
          messages: [{ role: 'system', content: 'different' }],
          instruction: 'summarize now',
          cacheOrigin: { kind: 'planner', executing },
          timeoutMs: 5000,
          maxTokens: 512,
        }),
        /context_compaction prompt-cache branch violated: message 0 diverged/u,
      );
    },
  );
  assert.equal(requestCount, 0);
});

test('first compaction request explicitly starts a new cache epoch', async () => {
  const flags: PlannerThinkingFlags = {
    thinkingEnabled: false,
    reasoningContentEnabled: false,
    preserveThinking: false,
  };
  const tools = toProtocolTools(resolveRepoSearchPlannerToolDefinitions(['read']));
  const captured = await captureChatRequestBody((baseUrl) => requestContextCompactionSummary({
    config: buildTestConfig(),
    baseUrl,
    model: 'mock-model',
    messages: [{ role: 'system', content: 'system' }],
    instruction: 'summarize now',
    cacheOrigin: { kind: 'new_epoch', flags, tools, slotId: 2 },
    timeoutMs: 5000,
    maxTokens: 512,
  }), 'SUMMARY TEXT');

  assert.equal(captured.id_slot, 2);
  assert.deepEqual(captured.tools, tools);
  assert.equal(captured.tool_choice, 'none');
  assert.equal(captured.cache_prompt, true);
});

test('requestRepoSearchPlannerProtocolAction hard-fails on json_schema rejection without fallback retry', async () => {
  let requestCount = 0;
  await withServer(
    (req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.statusCode = 404;
        res.end();
        return;
      }
      requestCount += 1;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { message: 'response_format json_schema unsupported' },
        }),
      );
    },
    async (baseUrl) => {
      await assert.rejects(
        () =>
          requestRepoSearchPlannerProtocolAction({
            ...PLANNER_REQUEST_DEFAULTS,
            config: buildTestConfig(),
            baseUrl,
            model: 'mock-model',
            messages: [{ role: 'user', content: 'find plan and repo-search' }],
            timeoutMs: 5000,
            maxTokens: 512,
          }),
        /HTTP 400/u,
      );
      assert.equal(requestCount, 1);
    },
  );
});

import {
  isRepoSearchNativeToolName,
  sanitizeNonInteractiveAllowedTools,
} from '../src/repo-search/planner-protocol.js';
import { INTERACTIVE_REPO_TOOL_NAMES } from '../src/planner-protocol/repo-search.js';

test('interactive tool names extend the exposed surface with write, edit, run', () => {
  assert.deepEqual(
    [...INTERACTIVE_REPO_TOOL_NAMES],
    ['read', 'grep', 'find', 'ls', 'git', 'web_search', 'web_fetch', 'write', 'edit', 'run'],
  );
});

test('native tool name check covers the full registry', () => {
  assert.equal(isRepoSearchNativeToolName('write'), true);
  assert.equal(isRepoSearchNativeToolName('edit'), true);
  assert.equal(isRepoSearchNativeToolName('run'), true);
  assert.equal(isRepoSearchNativeToolName('git'), true);
  assert.equal(isRepoSearchNativeToolName('nonsense'), false);
});

test('resolver returns definitions for interactive names', () => {
  const names = resolveRepoSearchPlannerToolDefinitions([...INTERACTIVE_REPO_TOOL_NAMES])
    .map((definition) => definition.function.name);
  assert.ok(names.includes('write') && names.includes('edit') && names.includes('run'));
});

test('sanitizer strips mutating tools from non-interactive allowed lists', () => {
  assert.deepEqual(sanitizeNonInteractiveAllowedTools(['read', 'write', 'run', 'git']), ['read', 'git']);
  assert.equal(sanitizeNonInteractiveAllowedTools(undefined), undefined);
});

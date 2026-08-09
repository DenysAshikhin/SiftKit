import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { ModelJson } from '../src/lib/model-json.js';
import type { JsonObject } from '../src/lib/json-types.js';
import type { ModelRuntimePreset, SiftConfig } from '../src/config/types.js';
import { asObject, getAddressInfo } from './helpers/dashboard-http.js';
import { mockSiftConfig } from './helpers/mock-config.js';
import { getSupportedImageExtensions } from '../src/llm-protocol/image-attachments.js';
import {
  captureExecutingPlannerRequest,
  getRepoSearchToolNames,
  getRepoSearchToolNamesForParsing,
  requestApprovalVerdict,
  requestRepoSearchPlannerProtocolAction,
  resolveRepoSearchPlannerToolDefinitions,
  TOOL_DEFINITIONS,
  type PlannerActionResponse,
} from '../src/repo-search/planner-protocol.js';

const TEXT_ONLY_READ_DESCRIPTION = 'Read the contents of a repository file. Lines are returned numbered. Use offset/limit for large files; when you need the full file, continue with offset until complete. Lines already returned in this task are skipped automatically, and a read whose whole range was already returned is rejected. Editing or writing a file clears that history, so you can read it again to see your change.';

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
    Server: { ModelPresets: { ActivePresetId: 'default', Presets: [{ id: 'default', ...preset }] } },
  });
}

function parseRepoSearchPlannerAction(text: string, allowedToolNames: readonly string[]) {
  return ModelJson.parseRepoSearchPlannerAction(text, {
    toolDefinitions: resolveRepoSearchPlannerToolDefinitions(allowedToolNames),
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
        capturedBody = JSON.parse(body || '{}');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: responseContent } }] }));
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

test('ModelJson parses repo-search tool batches', () => {
  const action = parseRepoSearchPlannerAction(
    JSON.stringify({
      action: 'tool_batch',
      calls: [
        { action: 'grep', pattern: 'plan' },
        { action: 'grep', pattern: 'repo-search' },
      ],
    }),
    getRepoSearchToolNamesForParsing(),
  );

  assert.deepEqual(action, {
    action: 'tool_batch',
    tool_calls: [
      { tool_name: 'grep', args: { pattern: 'plan' } },
      { tool_name: 'grep', args: { pattern: 'repo-search' } },
    ],
  });
});

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
  const description = run?.function.parameters?.properties?.outputMode?.description;

  assert.equal(typeof description, 'string');
  assert.match(description ?? '', /commands - use it for those/u);
  assert.doesNotMatch(description ?? '', /[^\x00-\x7F]/u);
});

test('getRepoSearchToolNamesForParsing excludes web tools so forged web actions are rejected by default', () => {
  const names = getRepoSearchToolNamesForParsing();
  assert.equal(names.includes('web_search'), false);
  assert.equal(names.includes('web_fetch'), false);
});

test('ModelJson rejects web tools unless allowed and normalizes their args when allowed', () => {
  assert.throws(() => parseRepoSearchPlannerAction('{"action":"web_search","query":"x"}', ['grep']), /unknown|invalid/i);

  assert.deepEqual(parseRepoSearchPlannerAction('{"action":"web_search","query":"x"}', ['web_search']), {
    action: 'tool',
    tool_name: 'web_search',
    args: { query: 'x' },
  });
  assert.deepEqual(parseRepoSearchPlannerAction('{"action":"web_search","query":"x","timeFilter":"week"}', ['web_search']), {
    action: 'tool',
    tool_name: 'web_search',
    args: { query: 'x', timeFilter: 'week' },
  });
  assert.deepEqual(parseRepoSearchPlannerAction('{"action":"web_fetch","url":"https://example.com"}', ['web_fetch']), {
    action: 'tool',
    tool_name: 'web_fetch',
    args: { url: 'https://example.com' },
  });
});

test('repo-search tool registry exposes the pi tool surface and withholds the mutating tools', () => {
  const toolNames = getRepoSearchToolNames().sort();
  assert.deepEqual(toolNames, ['find', 'git', 'grep', 'ls', 'read', 'web_fetch', 'web_search']);
  for (const withheld of ['write', 'edit', 'run']) {
    assert.equal(toolNames.includes(withheld), false);
  }

  const definitions = resolveRepoSearchPlannerToolDefinitions();
  const read = definitions.find((tool) => tool.function.name === 'read');
  assert.deepEqual(read?.function?.parameters?.required, ['path']);
  assert.equal(read?.function?.parameters?.properties?.offset?.type, 'integer');
  assert.equal(read?.function?.parameters?.properties?.limit?.type, 'integer');

  const grep = definitions.find((tool) => tool.function.name === 'grep');
  assert.deepEqual(grep?.function?.parameters?.required, ['pattern']);
  assert.equal(grep?.function?.parameters?.properties?.glob?.type, 'string');
  assert.equal(grep?.function?.parameters?.properties?.literal?.type, 'boolean');

  const find = definitions.find((tool) => tool.function.name === 'find');
  assert.deepEqual(find?.function?.parameters?.required, ['pattern']);

  const ls = definitions.find((tool) => tool.function.name === 'ls');
  assert.deepEqual(ls?.function?.parameters?.required, []);
  assert.equal(ls?.function?.parameters?.properties?.path?.type, 'string');

  const git = definitions.find((tool) => tool.function.name === 'git');
  assert.deepEqual(git?.function?.parameters?.required, ['command']);
});

test('requestRepoSearchPlannerProtocolAction reconstructs a tool batch from non-streaming multi-tool responses', async () => {
  await withServer(
    (req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
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
        }),
      );
    },
    async (baseUrl) => {
      const result = await requestRepoSearchPlannerProtocolAction({
        config: buildTestConfig(),
        baseUrl,
        model: 'mock-model',
        messages: [{ role: 'user', content: 'find plan and repo-search' }],
        timeoutMs: 5000,
        maxTokens: 512,
      });

      assert.equal(result.mockExhausted, false);
      assert.deepEqual(parseRepoSearchPlannerAction(result.text, getRepoSearchToolNamesForParsing()), {
        action: 'tool_batch',
        tool_calls: [
          { tool_name: 'grep', args: { pattern: 'plan' } },
          { tool_name: 'grep', args: { pattern: 'repo-search' } },
        ],
      });
    },
  );
});

test('requestRepoSearchPlannerProtocolAction reconstructs a tool batch from streaming multi-tool responses', async () => {
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
        config: buildTestConfig(),
        baseUrl,
        model: 'mock-model',
        messages: [{ role: 'user', content: 'find plan and repo-search' }],
        timeoutMs: 5000,
        maxTokens: 512,
        stream: true,
      });

      assert.deepEqual(parseRepoSearchPlannerAction(result.text, getRepoSearchToolNamesForParsing()), {
        action: 'tool_batch',
        tool_calls: [
          { tool_name: 'grep', args: { pattern: 'plan' } },
          { tool_name: 'grep', args: { pattern: 'repo-search' } },
        ],
      });
    },
  );
});

test('requestRepoSearchPlannerProtocolAction stops streamed reasoning after a complete planner action', async () => {
  const actionText = '{"action":"tool_batch","calls":[{"action":"grep","pattern":"planner"}]}';
  let writeCount = 0;

  await withServer(
    (req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.statusCode = 404;
        res.end();
        return;
      }
      req.resume();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: actionText } }] })}\n\n`);
      writeCount += 1;
      const interval = setInterval(() => {
        writeCount += 1;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '}' } }] })}\n\n`);
      }, 25);
      res.on('close', () => clearInterval(interval));
    },
    async (baseUrl) => {
      const result = await requestRepoSearchPlannerProtocolAction({
        config: buildTestConfig(),
        baseUrl,
        model: 'mock-model',
        messages: [{ role: 'user', content: 'find planner' }],
        timeoutMs: 2000,
        maxTokens: 512,
        stream: true,
      });

      assert.equal(result.text, actionText);
      assert.equal(result.thinkingText, '');
      assert.equal(writeCount, 1);
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
        config: buildTestConfig(),
        baseUrl,
        model: 'mock-model',
        messages: [{ role: 'user', content: 'find planner' }],
        timeoutMs: 2000,
        maxTokens: 512,
        stream: true,
        logger: {
          path: 'memory',
          write(event) {
            events.push(JSON.parse(JSON.stringify(event)));
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
        config: buildTestConfig(),
        baseUrl,
        model: 'mock-model',
        messages: [{ role: 'user', content: 'find planner' }],
        timeoutMs: 2000,
        maxTokens: 512,
        stream: true,
        logger: {
          path: 'memory',
          write(event) {
            events.push(JSON.parse(JSON.stringify(event)));
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
        config: buildTestConfig(),
        baseUrl,
        model: 'mock-model',
        messages: [{ role: 'user', content: 'finish' }],
        timeoutMs: 5000,
        maxTokens: 512,
        stream: true,
      });

      assert.equal(result.promptEvalTokens, 10);
      assert.equal(result.completionTokens, 4);
      assert.equal(result.usageThinkingTokens, null);
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
              config: buildTestConfig(),
              baseUrl,
              model: 'mock-model',
              messages: [{ role: 'user', content: 'finish slowly' }],
              timeoutMs: 5000,
              maxTokens: 512,
              stream: true,
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

test('requestRepoSearchPlannerProtocolAction sends json_schema response_format without native tools or grammar', async () => {
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
        capturedBody = JSON.parse(body || '{}');
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            choices: [{ message: { content: '{"action":"finish","output":"done"}' } }],
          }),
        );
      });
    },
    async (baseUrl) => {
      await requestRepoSearchPlannerProtocolAction({
        config: buildTestConfig(),
        baseUrl,
        model: 'mock-model',
        messages: [{ role: 'user', content: 'find plan and repo-search' }],
        timeoutMs: 5000,
        maxTokens: 512,
      });

      const captured = asObject(capturedBody);
      assert.equal(asObject(captured.response_format).type, 'json_schema');
      assert.equal('tools' in captured, false);
      assert.equal('parallel_tool_calls' in captured, false);
      assert.equal('grammar' in captured, false);
    },
  );
});

test('requestRepoSearchPlannerProtocolAction forwards native EXL3 structured output', async () => {
  let capturedBody: JsonObject | null = null;
  await withServer(
    (req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        capturedBody = JSON.parse(body || '{}');
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            choices: [{ message: { content: '{"action":"finish","output":"done"}' } }],
          }),
        );
      });
    },
    async (baseUrl) => {
      await requestRepoSearchPlannerProtocolAction({
        config: buildTestConfig({ Backend: 'exl3' }),
        baseUrl,
        model: 'mock-model',
        messages: [{ role: 'user', content: 'find plan and repo-search' }],
        timeoutMs: 5000,
        maxTokens: 512,
      });

      const captured = asObject(capturedBody);
      assert.equal(asObject(captured.response_format).type, 'json_schema');
      assert.equal('tools' in captured, false);
      assert.equal('cache_prompt' in captured, false);
      assert.equal('id_slot' in captured, false);
    },
  );
});

test('requestRepoSearchPlannerProtocolAction assembles planner schema dynamically from provided tool definitions', async () => {
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
        capturedBody = JSON.parse(body || '{}');
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            choices: [{ message: { content: '{"action":"finish","output":"done"}' } }],
          }),
        );
      });
    },
    async (baseUrl) => {
      await requestRepoSearchPlannerProtocolAction({
        config: buildTestConfig(),
        baseUrl,
        model: 'mock-model',
        messages: [{ role: 'user', content: 'find symbol' }],
        timeoutMs: 5000,
        maxTokens: 512,
        toolDefinitions: [
          {
            type: 'function',
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
        ],
      });

      const captured = asObject(capturedBody);
      const schemaText = JSON.stringify(captured.response_format || {});
      assert.match(schemaText, /search_symbol/u);
      assert.doesNotMatch(schemaText, /run_repo_cmd/u);
      assert.doesNotMatch(schemaText, /tool_name/u);
      assert.equal('tools' in captured, false);
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


test('requestApprovalVerdict clamps the verdict maxTokens to the preset MaxTokens', async () => {
  const config = buildTestConfig({ MaxTokens: 300 });

  const captured = await captureChatRequestBody((baseUrl) => requestApprovalVerdict({
    config,
    baseUrl,
    model: 'test-model',
    transcriptMessages: [],
    question: 'ok?',
    executing: captureExecutingPlannerRequest([], {
      thinkingEnabled: false,
      reasoningContentEnabled: false,
      preserveThinking: false,
    }),
    timeoutMs: 5000,
  }), '{"verdict":"approve","reason":"ok"}');

  assert.equal(captured.max_tokens, 300);
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
  INTERACTIVE_REPO_TOOL_NAMES,
  isRepoSearchNativeToolName,
  normalizeRepoSearchCommandForToolName,
  sanitizeNonInteractiveAllowedTools,
} from '../src/repo-search/planner-protocol.js';

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
  assert.equal(isRepoSearchNativeToolName('git'), false); // still the command tool
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

test('normalizeRepoSearchCommandForToolName prepends the constant git token when it is missing', () => {
  assert.equal(normalizeRepoSearchCommandForToolName('git', 'status'), 'git status');
  assert.equal(normalizeRepoSearchCommandForToolName('git', '  log --oneline  '), 'git log --oneline');
});

test('normalizeRepoSearchCommandForToolName leaves an already-prefixed command untouched', () => {
  assert.equal(normalizeRepoSearchCommandForToolName('git', 'git status --short'), 'git status --short');
  assert.equal(normalizeRepoSearchCommandForToolName('git', 'GIT status'), 'GIT status');
});

test('normalizeRepoSearchCommandForToolName leaves non-command tools and blank commands alone', () => {
  assert.equal(normalizeRepoSearchCommandForToolName('grep', 'status'), 'status');
  assert.equal(normalizeRepoSearchCommandForToolName('git', '   '), '');
});

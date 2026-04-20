// @ts-nocheck — Split from runtime.test.js. Full TS typing deferred.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadConfig,
  saveConfig,
  getChunkThresholdCharacters,
  getConfiguredLlamaNumCtx,
  getEffectiveInputCharactersPerContextToken,
} = require('../dist/config/index.js');
const {
  summarizeRequest,
  buildPlannerToolDefinitions,
} = require('../dist/summary.js');
const { generateLlamaCppResponse } = require('../dist/providers/llama-cpp.js');
const { executePlannerTool } = require('../dist/summary/planner/tools.js');

const {
  getChatRequestText,
  buildOversizedTransitionsInput,
  withTempEnv,
  withStubServer,
} = require('./_runtime-helpers.js');

test('json_filter auto-selects sole top-level array when collectionPath is omitted', () => {
  const inputText = JSON.stringify({
    count: 2,
    rows: [
      { request_id: 'req-1', failed_request_json: '{"error":"first"}' },
      { request_id: 'req-2', failed_request_json: '{"error":"second"}' },
    ],
  });

  const result = executePlannerTool(inputText, {
    action: 'tool',
    tool_name: 'json_filter',
    args: {
      filters: [{ path: 'failed_request_json', op: 'exists' }],
      select: ['request_id', 'failed_request_json'],
      limit: 10,
    },
  });

  assert.equal(result.collectionPath, 'rows');
  assert.equal(result.matchedCount, 2);
  assert.match(result.text, /"request_id":"req-1"/u);
});

test('json_filter picks the best matching top-level array when collectionPath is omitted', () => {
  const inputText = JSON.stringify({
    widgetRoots: [
      { id: 10747904, groupId: 164, childIndex: 0, text: '', isHidden: false },
      { id: 10747905, groupId: 12, childIndex: 1, text: 'quantity-1', isHidden: false },
    ],
    textSearchResults: [
      { line: 10, text: 'bank quantity button', context: 'widget text' },
    ],
  });

  const result = executePlannerTool(inputText, {
    action: 'tool',
    tool_name: 'json_filter',
    args: {
      filters: [{ path: 'groupId', op: 'eq', value: 12 }],
      select: ['id', 'groupId', 'childIndex', 'text'],
      limit: 10,
    },
  });

  assert.equal(result.collectionPath, 'widgetRoots');
  assert.equal(result.matchedCount, 1);
  assert.match(result.text, /"groupId":12/u);
});

test('json_filter unwraps exact nested value scalar wrappers', () => {
  const inputText = JSON.stringify({
    widgetRoots: [
      { id: 10747904, groupId: 164, childIndex: 0, text: '', isHidden: false },
      { id: 10747905, groupId: 12, childIndex: 1, text: 'quantity-1', isHidden: false },
    ],
  });

  const result = executePlannerTool(inputText, {
    action: 'tool',
    tool_name: 'json_filter',
    args: {
      filters: [{ path: 'groupId', op: 'eq', value: { value: 12 } }],
      select: ['id', 'groupId', 'childIndex', 'text'],
      limit: 10,
    },
  });

  assert.equal(result.collectionPath, 'widgetRoots');
  assert.equal(result.matchedCount, 1);
  assert.match(result.text, /"groupId":12/u);
});

test('find_text counts all hits even when maxHits truncates rendered blocks', () => {
  const inputText = [
    'Lumbridge Castle Staircase',
    'Varrock West Bank',
    'Lumbridge Castle Courtyard Gate',
    'Lumbridge Castle Basement Ladder',
  ].join('\n');

  const result = executePlannerTool(inputText, {
    action: 'tool',
    tool_name: 'find_text',
    args: {
      query: 'Lumbridge Castle',
      mode: 'literal',
      maxHits: 2,
      contextLines: 0,
    },
  });

  assert.equal(result.hitCount, 3);
  assert.equal(result.returnedHits, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.text.split('\n\n').length, 2);
  assert.match(result.text, /Lumbridge Castle Staircase/u);
  assert.match(result.text, /Lumbridge Castle Courtyard Gate/u);
  assert.doesNotMatch(result.text, /Lumbridge Castle Basement Ladder/u);
});

test('json_get resolves nested paths from embedded json fallback sections', () => {
  const inputText = [
    'runner_state_history excerpt follows',
    JSON.stringify({
      states: [
        {
          scenario_id: 'lumbridge-route',
          state_json: {
            steps: [
              { id: 'step-1', status: 'pending' },
              { id: 'step-2', status: 'complete' },
            ],
          },
        },
      ],
    }),
  ].join('\n');

  const result = executePlannerTool(inputText, {
    action: 'tool',
    tool_name: 'json_get',
    args: {
      path: 'states.0.state_json.steps.1.status',
    },
  });

  assert.equal(result.path, 'states.0.state_json.steps.1.status');
  assert.equal(result.found, true);
  assert.equal(result.usedFallback, true);
  assert.equal(result.text, '"complete"');
});

test('json_get reports missing paths explicitly', () => {
  const inputText = JSON.stringify({
    states: [{ id: 'state-1' }],
  });

  const result = executePlannerTool(inputText, {
    action: 'tool',
    tool_name: 'json_get',
    args: {
      path: 'states.1.id',
    },
  });

  assert.equal(result.path, 'states.1.id');
  assert.equal(result.found, false);
  assert.match(result.text, /path not found/u);
});

test('llama.cpp provider reconstructs planner tool actions from empty-content tool_calls responses', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });

      const summary = await generateLlamaCppResponse({
        config,
        model: config.Model,
        prompt: 'test prompt body',
        timeoutSeconds: 5,
        structuredOutput: {
          kind: 'siftkit-planner-action-json',
          tools: buildPlannerToolDefinitions(),
        },
      });

      assert.equal(summary.text, '{"action":"tool","tool_name":"json_filter","args":{"filters":[{"path":"from.worldX","op":"gte","value":3200}]}}');
    }, {
      chatResponse() {
        return {
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: {
                      name: 'json_filter',
                      arguments: '{"filters":[{"path":"from.worldX","op":"gte","value":3200}]}',
                    },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 123,
            completion_tokens: 45,
            total_tokens: 168,
          },
        };
      },
    });
  });
});

test('llama.cpp provider reconstructs planner tool batches from empty-content tool_calls responses', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });

      const summary = await generateLlamaCppResponse({
        config,
        model: config.Model,
        prompt: 'test prompt body',
        timeoutSeconds: 5,
        structuredOutput: {
          kind: 'siftkit-planner-action-json',
          tools: buildPlannerToolDefinitions(),
        },
      });

      assert.equal(
        summary.text,
        '{"action":"tool_batch","tool_calls":[{"tool_name":"find_text","args":{"query":"Lumbridge","mode":"literal"}},{"tool_name":"read_lines","args":{"startLine":10,"endLine":20}}]}',
      );
    }, {
      chatResponse() {
        return {
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: {
                      name: 'find_text',
                      arguments: '{"query":"Lumbridge","mode":"literal"}',
                    },
                  },
                  {
                    id: 'call_2',
                    type: 'function',
                    function: {
                      name: 'read_lines',
                      arguments: '{"startLine":10,"endLine":20}',
                    },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 123,
            completion_tokens: 45,
            total_tokens: 168,
          },
        };
      },
    });
  });
});

test('planner mode executes multi-tool batches sequentially before finishing', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputText = buildOversizedTransitionsInput(threshold + 1000);

      const result = await summarizeRequest({
        question: 'Summarize the Lumbridge transitions.',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.Classification, 'summary');
      assert.equal(result.Summary, 'final planner answer');
      assert.equal(server.state.chatRequests.length, 2);
      assert.equal(
        server.state.chatRequests[1].messages.filter((message) => message.role === 'tool').length,
        2,
      );
    }, {
      chatResponse(promptText, parsed, requestIndex) {
        if (requestIndex === 1) {
          return {
            id: 'chatcmpl-test',
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: {
                        name: 'find_text',
                        arguments: '{"query":"Lumbridge","mode":"literal","maxHits":2}',
                      },
                    },
                    {
                      id: 'call_2',
                      type: 'function',
                      function: {
                        name: 'read_lines',
                        arguments: '{"startLine":1,"endLine":20}',
                      },
                    },
                  ],
                },
              },
            ],
            usage: {
              prompt_tokens: 17,
              completion_tokens: 15,
              total_tokens: 32,
            },
          };
        }

        return {
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  action: 'finish',
                  classification: 'summary',
                  raw_review_required: false,
                  output: 'final planner answer',
                }),
              },
            },
          ],
          usage: {
            prompt_tokens: 19,
            completion_tokens: 21,
            total_tokens: 40,
          },
        };
      },
    });
  });
});

test('planner token accounting treats tool-step completion tokens as thinking and finish-step tokens as output', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputText = buildOversizedTransitionsInput(threshold + 1000);
      const baselineInputTokens = server.state.metrics.inputTokensTotal;
      const baselineOutputTokens = server.state.metrics.outputTokensTotal;
      const baselineToolTokens = Number(server.state.metrics.toolTokensTotal || 0);
      const baselineThinkingTokens = server.state.metrics.thinkingTokensTotal;

      const result = await summarizeRequest({
        question: 'Find all transitions in the Lumbridge Castle area.',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.Classification, 'summary');
      assert.equal(result.Summary, 'final planner answer');
      assert.equal(server.state.chatRequests.length, 2);
      assert.equal(server.state.metrics.inputTokensTotal - baselineInputTokens, 36);
      assert.equal(server.state.metrics.outputTokensTotal - baselineOutputTokens, 21);
      assert.equal(Number(server.state.metrics.toolTokensTotal || 0) - baselineToolTokens, 15);
      assert.equal(server.state.metrics.thinkingTokensTotal - baselineThinkingTokens, 0);
    }, {
      chatResponse(promptText, parsed, requestIndex) {
        if (requestIndex === 1) {
          return {
            id: 'chatcmpl-test',
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: JSON.stringify({
                    action: 'tool',
                    tool_name: 'json_filter',
                    args: {
                      filters: [
                        { path: 'from.worldX', op: 'gte', value: 3200 },
                        { path: 'from.worldX', op: 'lte', value: 3215 },
                      ],
                      select: ['id', 'label'],
                      limit: 20,
                    },
                  }),
                },
              },
            ],
            usage: {
              prompt_tokens: 17,
              completion_tokens: 15,
              total_tokens: 32,
            },
          };
        }

        return {
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  action: 'finish',
                  classification: 'summary',
                  raw_review_required: false,
                  output: 'final planner answer',
                }),
              },
            },
          ],
          usage: {
            prompt_tokens: 19,
            completion_tokens: 21,
            total_tokens: 40,
          },
        };
      },
      metrics: {
        inputCharactersTotal: 3_461_904,
        inputTokensTotal: 1_865_267,
        outputCharactersTotal: 0,
        outputTokensTotal: 0,
        thinkingTokensTotal: 0,
        completedRequestCount: 0,
        requestDurationMsTotal: 0,
      },
    });
  });
});

test('summary below planner threshold respects runtime reasoning for one-shot requests', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const plannerThreshold = Math.floor(
        getConfiguredLlamaNumCtx(config) * getEffectiveInputCharactersPerContextToken(config) * 0.75,
      );
      const inputText = 'A'.repeat(Math.max(plannerThreshold - 10, 1));

      config.Runtime ??= {};
      config.Runtime.LlamaCpp ??= {};
      config.Runtime.LlamaCpp.Reasoning = 'on';
      config.Server ??= {};
      config.Server.LlamaCpp ??= {};
      config.Server.LlamaCpp.Reasoning = 'on';
      if (Array.isArray(config.Server.LlamaCpp.Presets) && config.Server.LlamaCpp.Presets[0]) {
        config.Server.LlamaCpp.Presets[0].Reasoning = 'on';
      }
      await saveConfig(config);

      const result = await summarizeRequest({
        question: 'summarize this',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.WasSummarized, true);
      assert.equal(server.state.chatRequests.length, 1);
      assert.deepEqual(server.state.chatRequests[0].chat_template_kwargs, {
        enable_thinking: true,
      });
      assert.equal('reasoning_budget' in server.state.chatRequests[0].extra_body, false);
      const firstResponseFormatText = JSON.stringify(server.state.chatRequests[0]?.response_format || {});
      assert.equal(server.state.chatRequests[0]?.response_format?.type, 'json_schema');
      assert.match(firstResponseFormatText, /classification/u);
      assert.doesNotMatch(firstResponseFormatText, /tool_name/u);
    });
  });
});

test('summary above planner threshold respects runtime reasoning for planner requests', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const plannerThreshold = Math.floor(
        getConfiguredLlamaNumCtx(config) * getEffectiveInputCharactersPerContextToken(config) * 0.75,
      );
      const inputText = buildOversizedTransitionsInput(plannerThreshold + 100);

      config.Runtime ??= {};
      config.Runtime.LlamaCpp ??= {};
      config.Runtime.LlamaCpp.Reasoning = 'on';
      config.Server ??= {};
      config.Server.LlamaCpp ??= {};
      config.Server.LlamaCpp.Reasoning = 'on';
      if (Array.isArray(config.Server.LlamaCpp.Presets) && config.Server.LlamaCpp.Presets[0]) {
        config.Server.LlamaCpp.Presets[0].Reasoning = 'on';
      }
      await saveConfig(config);

      const result = await summarizeRequest({
        question: 'Summarize the visible transition evidence conservatively.',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.WasSummarized, true);
      assert.equal(server.state.chatRequests.length >= 1, true);
      assert.deepEqual(server.state.chatRequests[0].chat_template_kwargs, {
        enable_thinking: true,
      });
      assert.equal('reasoning_budget' in server.state.chatRequests[0].extra_body, false);
      const firstResponseFormatText = JSON.stringify(server.state.chatRequests[0]?.response_format || {});
      assert.match(firstResponseFormatText, /tool_name/u);
    }, {
      assistantContent(promptText, parsed) {
        if (JSON.stringify(parsed?.response_format || {}).includes('tool_name')) {
          return JSON.stringify({
            action: 'finish',
            classification: 'summary',
            raw_review_required: false,
            output: 'planner finish',
          });
        }

        return '{"classification":"summary","raw_review_required":false,"output":"ok"}';
      },
    });
  });
});

test('buildPlannerToolDefinitions returns qwen-friendly function schemas', () => {
  const toolDefinitions = buildPlannerToolDefinitions();
  assert.equal(Array.isArray(toolDefinitions), true);
  assert.equal(toolDefinitions.length, 4);

  const toolNames = toolDefinitions.map((entry) => entry?.function?.name).sort();
  assert.deepEqual(toolNames, ['find_text', 'json_filter', 'json_get', 'read_lines']);

  for (const entry of toolDefinitions) {
    assert.equal(entry.type, 'function');
    assert.equal(typeof entry.function?.name, 'string');
    assert.equal(typeof entry.function?.description, 'string');
    assert.equal(entry.function.description.length > 0, true);
    assert.equal(entry.function?.parameters?.type, 'object');
    assert.equal(typeof entry.function?.parameters?.properties, 'object');
    assert.equal(Array.isArray(entry.function?.parameters?.required), true);
  }

  const findText = toolDefinitions.find((entry) => entry.function.name === 'find_text');
  assert.deepEqual(findText.function.parameters.required, ['query', 'mode']);
  assert.deepEqual(findText.function.parameters.properties.mode.enum, ['literal', 'regex']);
  assert.match(findText.function.description, /valid javascript regex/i);
  assert.match(findText.function.description, /do not escape ordinary quotes/i);
  assert.match(findText.function.description, /example:/i);
  assert.match(findText.function.description, /\"query\":\"Lumbridge\"/i);

  const readLines = toolDefinitions.find((entry) => entry.function.name === 'read_lines');
  assert.deepEqual(readLines.function.parameters.required, ['startLine', 'endLine']);
  assert.match(readLines.function.description, /example:/i);
  assert.match(readLines.function.description, /\"startLine\":1340/i);

  const jsonFilter = toolDefinitions.find((entry) => entry.function.name === 'json_filter');
  assert.deepEqual(jsonFilter.function.parameters.required, ['filters']);
  assert.equal(jsonFilter.function.parameters.properties.filters.type, 'array');
  assert.match(jsonFilter.function.description, /use separate filters/i);
  assert.match(jsonFilter.function.description, /scalar value/i);
  assert.match(jsonFilter.function.description, /example:/i);
  assert.match(jsonFilter.function.description, /\"path\":\"from\.worldX\"/i);
  assert.match(jsonFilter.function.description, /\"value\":3200/i);
  assert.match(jsonFilter.function.description, /collectionPath/i);
  assert.match(jsonFilter.function.description, /root object/i);
  assert.match(jsonFilter.function.description, /"collectionPath":"states"/i);
  assert.match(jsonFilter.function.description, /"path":"timestamp"/i);
  assert.match(jsonFilter.function.description, /"value":"2026-03-30T18:40:00Z"/i);
  assert.match(jsonFilter.function.description, /do not use/i);
  assert.match(jsonFilter.function.description, /\"value\":\{\"gte\":3200,\"lte\":3215\}/i);

  const jsonGet = toolDefinitions.find((entry) => entry.function.name === 'json_get');
  assert.deepEqual(jsonGet.function.parameters.required, ['path']);
  assert.equal(jsonGet.function.parameters.properties.path.type, 'string');
  assert.match(jsonGet.function.description, /dot-path/i);
  assert.match(jsonGet.function.description, /example:/i);
  assert.match(jsonGet.function.description, /"path":"states\.0\.state_json"/i);
});

test('oversized transition extraction uses planner action grammar before returning a tool-assisted summary', async () => {
  await withTempEnv(async () => {
    const expectedOutput = [
      '9001 | Lumbridge Castle Staircase | stairs | from (3205,3214,0) -> to (3205,3214,1) | bidirectional=true',
      '9002 | Lumbridge Castle Courtyard Gate | gate | from (3212,3221,0) -> to (3213,3221,0) | bidirectional=false',
    ].join('\n');

    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputText = buildOversizedTransitionsInput(threshold + 1000);

      const result = await summarizeRequest({
        question: 'Find all transitions in the Lumbridge Castle area (worldX 3200-3215, worldY 3210-3225). List their id, label, type, from coordinates (worldX, worldY, plane), to coordinates (worldX, worldY, plane), and bidirectional flag.',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.Classification, 'summary');
      assert.equal(result.RawReviewRequired, false);
      assert.equal(result.Summary, expectedOutput);
      assert.equal(server.state.chatRequests.length, 2);

      const firstRequest = server.state.chatRequests[0];
      const firstPrompt = getChatRequestText(firstRequest);
      assert.match(JSON.stringify(firstRequest?.response_format || {}), /action/u);
      assert.match(firstPrompt, /Planner mode:/u);
      assert.match(firstPrompt, /Tools:/u);
      assert.match(firstPrompt, /find_text/u);
      assert.match(firstPrompt, /read_lines/u);
      assert.match(firstPrompt, /json_filter/u);
      assert.match(firstPrompt, /Use separate filters for gte\/lte bounds/u);
      assert.match(firstPrompt, /Do not use "value":\{"gte":3200,"lte":3215\}/u);
      assert.match(firstPrompt, /Never emit JSON schema fragments like \{"type":"integer"\}/u);
      assert.match(firstPrompt, /Regex patterns must be valid JavaScript regex/u);
      assert.match(firstPrompt, /After `find_text` identifies a useful anchor, default to one larger contiguous `read_lines` window/u);
      assert.match(firstPrompt, /avoid many tiny adjacent slices unless verifying one exact line or symbol/u);
      assert.match(firstPrompt, /If you already used `read_lines` once, do another `find_text` search before requesting a second nearby `read_lines` slice/u);
      assert.match(firstPrompt, /Example tool calls:/u);
      assert.match(firstPrompt, /"tool_name":"find_text"/u);
      assert.match(firstPrompt, /"tool_name":"read_lines"/u);
      assert.match(firstPrompt, /"tool_name":"json_filter"/u);
      assert.match(firstPrompt, /Bad read_lines progression example:/u);
      assert.match(firstPrompt, /"startLine":1340,"endLine":1379/u);
      assert.match(firstPrompt, /"startLine":1380,"endLine":1419/u);
      assert.equal(/parameters=/u.test(firstPrompt), false);
    }, {
      assistantContent(promptText, parsed, requestIndex) {
        if (requestIndex === 1) {
          return JSON.stringify({
            action: 'tool',
            tool_name: 'json_filter',
            args: {
              filters: [
                { path: 'from.worldX', op: 'gte', value: 3200 },
                { path: 'from.worldX', op: 'lte', value: 3215 },
                { path: 'from.worldY', op: 'gte', value: 3210 },
                { path: 'from.worldY', op: 'lte', value: 3225 },
              ],
              select: ['id', 'label', 'type', 'from', 'to', 'bidirectional'],
              limit: 20,
            },
          });
        }

        if (requestIndex === 2) {
          return JSON.stringify({
            action: 'finish',
            classification: 'summary',
            raw_review_required: false,
            output: expectedOutput,
          });
        }

        throw new Error(`unexpected planner request ${requestIndex}: ${String(promptText).slice(0, 120)}`);
      },
    });
  });
});

test('planner accepts inputs larger than the former four-chunk cap when it can answer via tools', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputText = buildOversizedTransitionsInput((threshold * 5) + 1000);

      const result = await summarizeRequest({
        question: 'Find all transitions in the Lumbridge Castle area (worldX 3200-3215, worldY 3210-3225).',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.Classification, 'summary');
      assert.equal(result.Summary, 'oversized planner success');
      assert.equal(server.state.chatRequests.length, 1);
      assert.equal(
        server.state.chatRequests.some((request) => /<<<BEGIN_LITERAL_INPUT_SLICE>>>/u.test(getChatRequestText(request))),
        false,
      );
    }, {
      assistantContent() {
        return JSON.stringify({
          action: 'finish',
          classification: 'summary',
          raw_review_required: false,
          output: 'oversized planner success',
        });
      },
    });
  });
});

test('planner handles oversized monolithic JSON instead of forcing chunk fallback', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputText = JSON.stringify({
        blob: 'X'.repeat(threshold + 1000),
      });

      const result = await summarizeRequest({
        question: 'Summarize this oversized JSON payload.',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.Classification, 'summary');
      assert.equal(result.Summary, 'planner handled monolithic json');
      assert.equal(server.state.chatRequests.length, 1);
      assert.match(getChatRequestText(server.state.chatRequests[0]), /Planner mode:/u);
    }, {
      assistantContent() {
        return JSON.stringify({
          action: 'finish',
          classification: 'summary',
          raw_review_required: false,
          output: 'planner handled monolithic json',
        });
      },
    });
  });
});

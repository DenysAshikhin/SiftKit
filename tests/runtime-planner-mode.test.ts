// @ts-nocheck — Split from runtime.test.js. Full TS typing deferred.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const { loadConfig, saveConfig, getConfigPath, getExecutionServerState, getChunkThresholdCharacters, getConfiguredLlamaNumCtx, getEffectiveInputCharactersPerContextToken, initializeRuntime, getStatusServerUnavailableMessage, SIFT_BROKEN_DEFAULT_LLAMA_STARTUP_SCRIPT, SIFT_DEFAULT_LLAMA_STARTUP_SCRIPT, SIFT_FORMER_DEFAULT_LLAMA_STARTUP_SCRIPT, SIFT_PREVIOUS_DEFAULT_LLAMA_STARTUP_SCRIPT } = require('../dist/config/index.js');
const { summarizeRequest, buildPrompt, getSummaryDecision, planTokenAwareLlamaCppChunks, getPlannerPromptBudget, buildPlannerToolDefinitions, UNSUPPORTED_INPUT_MESSAGE } = require('../dist/summary.js');
const { runCommand } = require('../dist/command.js');
const { runBenchmarkSuite } = require('../dist/benchmark/index.js');
const { readMatrixManifest, buildLaunchSignature, buildLauncherArgs, buildBenchmarkArgs, pruneOldLauncherLogs, runMatrix, runMatrixWithInterrupt } = require('../dist/benchmark-matrix/index.js');
const { countLlamaCppTokens, listLlamaCppModels, generateLlamaCppResponse } = require('../dist/providers/llama-cpp.js');
const { withExecutionLock } = require('../dist/execution-lock.js');
const { buildIdleMetricsLogMessage, buildStatusRequestLogMessage, formatElapsed, getIdleSummarySnapshotsPath, startStatusServer } = require('../dist/status-server/index.js');
const { runDebugRequest } = require('../dist/scripts/run-benchmark-fixture-debug.js');
const { runFixture60MalformedJsonRepro } = require('../dist/scripts/repro-fixture60-malformed-json.js');

const {
  TEST_USE_EXISTING_SERVER,
  EXISTING_SERVER_STATUS_URL,
  EXISTING_SERVER_CONFIG_URL,
  RUN_LIVE_LLAMA_TOKENIZE_TESTS,
  LIVE_LLAMA_BASE_URL,
  LIVE_CONFIG_SERVICE_URL,
  FAST_LEASE_STALE_MS,
  FAST_LEASE_WAIT_MS,
  deriveServiceUrl,
  getDefaultConfig,
  clone,
  getChatRequestText,
  setManagedLlamaBaseUrl,
  mergeConfig,
  extractPromptSection,
  buildOversizedTransitionsInput,
  buildOversizedRunnerStateHistoryInput,
  getRuntimeRootFromStatusPath,
  getPlannerLogsPath,
  getFailedLogsPath,
  getRequestLogsPath,
  buildStructuredStubDecision,
  resolveAssistantContent,
  readBody,
  resolveArtifactLogPathFromStatusPost,
  requestJson,
  sleep,
  removeDirectoryWithRetries,
  spawnProcess,
  waitForTextMatch,
  startStubStatusServer,
  withTempEnv,
  withStubServer,
  withSummaryTestServer,
  withRealStatusServer,
  startStatusServerProcess,
  stripAnsi,
  captureStdout,
  readIdleSummarySnapshots,
  getIdleSummaryBlock,
  getFreePort,
  toSingleQuotedPowerShellLiteral,
  writeManagedLlamaScripts,
  waitForAsyncExpectation,
  runPowerShellScript,
} = require('./_runtime-helpers.js');

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

test('summary below planner threshold runs one-shot with forced non-thinking', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const plannerThreshold = Math.floor(
        getConfiguredLlamaNumCtx(config) * getEffectiveInputCharactersPerContextToken(config) * 0.75
      );
      const inputText = 'A'.repeat(Math.max(plannerThreshold - 10, 1));

      config.Runtime ??= {};
      config.Runtime.LlamaCpp ??= {};
      config.Runtime.LlamaCpp.Reasoning = 'on';
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
        enable_thinking: false,
      });
      assert.equal(server.state.chatRequests[0].extra_body.reasoning_budget, 0);
      assert.match(String(server.state.chatRequests[0]?.extra_body?.grammar || ''), /classification/u);
      assert.doesNotMatch(String(server.state.chatRequests[0]?.extra_body?.grammar || ''), /tool_name/u);
    });
  });
});

test('summary above planner threshold uses planner flow without forced non-thinking override', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const plannerThreshold = Math.floor(
        getConfiguredLlamaNumCtx(config) * getEffectiveInputCharactersPerContextToken(config) * 0.75
      );
      const inputText = buildOversizedTransitionsInput(plannerThreshold + 100);

      config.Runtime ??= {};
      config.Runtime.LlamaCpp ??= {};
      config.Runtime.LlamaCpp.Reasoning = 'on';
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
        enable_thinking: false,
      });
      assert.deepEqual(server.state.chatRequests[0].extra_body.reasoning_budget, 0);
      assert.match(String(server.state.chatRequests[0]?.extra_body?.grammar || ''), /tool_name/u);
    }, {
      assistantContent(promptText, parsed) {
        if (String(parsed?.extra_body?.grammar || '').includes('tool_name')) {
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
  assert.equal(toolDefinitions.length, 3);

  const toolNames = toolDefinitions.map((entry) => entry?.function?.name).sort();
  assert.deepEqual(toolNames, ['find_text', 'json_filter', 'read_lines']);

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
      assert.match(String(firstRequest?.extra_body?.grammar || ''), /action/u);
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

test('planner writes a debug dump with input, thinking, tool calls, tool output, and final output', async () => {
  await withTempEnv(async () => {
    const plannerLogsPath = getPlannerLogsPath();
    fs.mkdirSync(plannerLogsPath, { recursive: true });
    const before = new Set(fs.readdirSync(plannerLogsPath).filter((entry) => /^planner_debug_.*\.json$/u.test(entry)));

    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputText = buildOversizedTransitionsInput(threshold + 1000);

      const result = await summarizeRequest({
        question: 'Find all transitions in the Lumbridge Castle area.',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
        debugCommand: 'cat transitions.json | siftkit "Find all transitions in the Lumbridge Castle area."',
      });

      assert.equal(result.Classification, 'summary');
    }, {
      assistantReasoningContent(promptText, parsed, requestIndex) {
        return requestIndex === 1
          ? 'I should use json_filter to isolate Lumbridge Castle transitions.'
          : 'I have enough evidence to answer now.';
      },
      assistantContent(promptText, parsed, requestIndex) {
        if (requestIndex === 1) {
          return JSON.stringify({
            action: 'tool',
            tool_name: 'json_filter',
            args: {
              filters: [
                { path: 'from.worldX', op: 'gte', value: 3200 },
                { path: 'from.worldX', op: 'lte', value: 3215 },
              ],
              select: ['id', 'label', 'from', 'to', 'bidirectional'],
              limit: 20,
            },
          });
        }

        return JSON.stringify({
          action: 'finish',
          classification: 'summary',
          raw_review_required: false,
          output: 'debug dump summary',
        });
      },
    });

    const after = fs.readdirSync(plannerLogsPath).filter((entry) => /^planner_debug_.*\.json$/u.test(entry));
    const added = after.filter((entry) => !before.has(entry));
    assert.equal(added.length, 1);

    const debugDump = JSON.parse(fs.readFileSync(path.join(plannerLogsPath, added[0]), 'utf8'));
    assert.equal(debugDump.command, 'cat transitions.json | siftkit "Find all transitions in the Lumbridge Castle area."');
    assert.equal(typeof debugDump.inputText, 'string');
    assert.match(debugDump.inputText, /Lumbridge Castle Staircase/u);
    assert.equal(Array.isArray(debugDump.events), true);
    assert.equal(debugDump.events.some((event) => event.kind === 'planner_model_response' && /json_filter/u.test(String(event.thinkingProcess || ''))), true);
    assert.equal(debugDump.events.some((event) => event.kind === 'planner_tool' && event.command === 'json_filter {"filters":[{"path":"from.worldX","op":"gte","value":3200},{"path":"from.worldX","op":"lte","value":3215}],"select":["id","label","from","to","bidirectional"],"limit":20}'), true);
    assert.equal(debugDump.events.some((event) => event.kind === 'planner_tool' && typeof event.output?.text === 'string' && /Lumbridge Castle Staircase/u.test(event.output.text)), true);
    assert.equal(debugDump.final.finalOutput, 'debug dump summary');
  });
});

test('planner json_filter accepts combined gte and lte bounds in one filter value', async () => {
  await withTempEnv(async () => {
    const plannerLogsPath = getPlannerLogsPath();
    fs.mkdirSync(plannerLogsPath, { recursive: true });
    const before = new Set(fs.readdirSync(plannerLogsPath).filter((entry) => /^planner_debug_.*\.json$/u.test(entry)));

    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputText = buildOversizedTransitionsInput(threshold + 1000);

      const result = await summarizeRequest({
        question: 'Find all transitions in the Lumbridge Castle area.',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.Classification, 'summary');
      assert.equal(result.Summary, 'combined bounds worked');
    }, {
      assistantContent(promptText, parsed, requestIndex) {
        if (requestIndex === 1) {
          return JSON.stringify({
            action: 'tool',
            tool_name: 'json_filter',
            args: {
              filters: [
                { path: 'from.worldX', op: 'gte', value: { gte: 3200, lte: 3215 } },
                { path: 'from.worldY', op: 'gte', value: { gte: 3210, lte: 3225 } },
              ],
              select: ['id', 'label', 'type', 'from', 'to', 'bidirectional'],
              limit: 100,
            },
          });
        }

        return JSON.stringify({
          action: 'finish',
          classification: 'summary',
          raw_review_required: false,
          output: 'combined bounds worked',
        });
      },
    });

    const after = fs.readdirSync(plannerLogsPath).filter((entry) => /^planner_debug_.*\.json$/u.test(entry));
    const added = after.filter((entry) => !before.has(entry));
    assert.equal(added.length, 1);

    const debugDump = JSON.parse(fs.readFileSync(path.join(plannerLogsPath, added[0]), 'utf8'));
    const jsonFilterEvent = debugDump.events.find((event) => event.kind === 'planner_tool' && event.toolName === 'json_filter');
    assert.equal(jsonFilterEvent.output.matchedCount, 2);
    assert.match(jsonFilterEvent.output.text, /Lumbridge Castle Staircase/u);
    assert.match(jsonFilterEvent.output.text, /Lumbridge Castle Courtyard Gate/u);
  });
});

test('planner retries malformed json_filter schema-placeholder args once and then succeeds', async () => {
  await withTempEnv(async () => {
    const plannerLogsPath = getPlannerLogsPath();
    fs.mkdirSync(plannerLogsPath, { recursive: true });
    const before = new Set(fs.readdirSync(plannerLogsPath).filter((entry) => /^planner_debug_.*\.json$/u.test(entry)));

    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputText = buildOversizedTransitionsInput(threshold + 1000);

      const result = await summarizeRequest({
        question: 'Find ladder transitions near worldX 3228-3230 and worldY 3210-3215. Return full objects.',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.Classification, 'summary');
      assert.equal(result.Summary, 'recovered malformed planner tool args');
    }, {
      assistantContent(promptText, parsed, requestIndex) {
        if (requestIndex === 1) {
          return JSON.stringify({
            action: 'tool',
            tool_name: 'json_filter',
            args: {
              filters: [
                { path: 'from.worldX', op: 'gte', value: { type: 'integer' } },
                { path: 'from.worldX', op: 'lte', value: { type: 'integer' } },
                { path: 'from.worldY', op: 'gte', value: { type: 'integer' } },
                { path: 'from.worldY', op: 'lte', value: { type: 'integer' } },
              ],
              limit: 100,
            },
          });
        }

        if (requestIndex === 2) {
          return JSON.stringify({
            action: 'tool',
            tool_name: 'json_filter',
            args: {
              filters: [
                { path: 'from.worldX', op: 'gte', value: 3228 },
                { path: 'from.worldX', op: 'lte', value: 3230 },
                { path: 'from.worldY', op: 'gte', value: 3210 },
                { path: 'from.worldY', op: 'lte', value: 3215 },
              ],
              limit: 100,
            },
          });
        }

        return JSON.stringify({
          action: 'finish',
          classification: 'summary',
          raw_review_required: false,
          output: 'recovered malformed planner tool args',
        });
      },
    });

    const after = fs.readdirSync(plannerLogsPath).filter((entry) => /^planner_debug_.*\.json$/u.test(entry));
    const added = after.filter((entry) => !before.has(entry));
    assert.equal(added.length, 1);

    const debugDump = JSON.parse(fs.readFileSync(path.join(plannerLogsPath, added[0]), 'utf8'));
    assert.equal(
      debugDump.events.some((event) => event.kind === 'planner_invalid_response' && /json_filter gte requires a scalar value\./u.test(String(event.error || ''))),
      true,
    );
    assert.equal(
      debugDump.events.some((event) => event.kind === 'planner_tool' && event.toolName === 'json_filter' && /"value":3228/u.test(String(event.command || ''))),
      true,
    );
    assert.equal(debugDump.final.finalOutput, 'recovered malformed planner tool args');
  });
});

test('planner malformed json_filter schema-placeholder args fail on invalid response limit after retry', async () => {
  await withTempEnv(async () => {
    const plannerLogsPath = getPlannerLogsPath();
    fs.mkdirSync(plannerLogsPath, { recursive: true });
    const before = new Set(fs.readdirSync(plannerLogsPath).filter((entry) => /^planner_debug_.*\.json$/u.test(entry)));

    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputText = buildOversizedTransitionsInput(threshold + 1000);

      await assert.rejects(
        () => summarizeRequest({
          question: 'Find ladder transitions near worldX 3228-3230 and worldY 3210-3215. Return full objects.',
          inputText,
          format: 'text',
          policyProfile: 'general',
          backend: 'llama.cpp',
          model: 'mock-model',
        }),
        /planner_invalid_response_limit/u,
      );
    }, {
      assistantContent() {
        return JSON.stringify({
          action: 'tool',
          tool_name: 'json_filter',
          args: {
            filters: [
              { path: 'from.worldX', op: 'gte', value: { type: 'integer' } },
              { path: 'from.worldX', op: 'lte', value: { type: 'integer' } },
              { path: 'from.worldY', op: 'gte', value: { type: 'integer' } },
              { path: 'from.worldY', op: 'lte', value: { type: 'integer' } },
            ],
            limit: 100,
          },
        });
      },
    });

    const after = fs.readdirSync(plannerLogsPath).filter((entry) => /^planner_debug_.*\.json$/u.test(entry));
    const added = after.filter((entry) => !before.has(entry));
    assert.equal(added.length, 1);

    const debugDump = JSON.parse(fs.readFileSync(path.join(plannerLogsPath, added[0]), 'utf8'));
    assert.equal(debugDump.final.reason, 'planner_invalid_response_limit');
    assert.equal(
      debugDump.events.filter((event) => event.kind === 'planner_invalid_response').length,
      2,
    );
  });
});

test('planner json_filter supports scalar timestamp ranges on object-root array collections', async () => {
  await withTempEnv(async () => {
    const plannerLogsPath = getPlannerLogsPath();
    fs.mkdirSync(plannerLogsPath, { recursive: true });
    const before = new Set(fs.readdirSync(plannerLogsPath).filter((entry) => /^planner_debug_.*\.json$/u.test(entry)));

    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputText = buildOversizedRunnerStateHistoryInput(threshold + 1000);

      const result = await summarizeRequest({
        question: 'Summarize runner_state_history between 2026-03-30T18:40:00Z and 18:50:00Z.',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.Classification, 'summary');
      assert.equal(result.Summary, 'timestamp filter worked');
      const firstPrompt = getChatRequestText(server.state.chatRequests[0]);
      assert.match(firstPrompt, /collectionPath/i);
      assert.match(firstPrompt, /"collectionPath":"states"/u);
      assert.match(firstPrompt, /object_array_paths=states/u);
    }, {
      assistantContent(promptText, parsed, requestIndex) {
        if (requestIndex === 1) {
          return JSON.stringify({
            action: 'tool',
            tool_name: 'json_filter',
            args: {
              collectionPath: 'states',
              filters: [
                { path: 'timestamp', op: 'gte', value: '2026-03-30T18:40:00Z' },
                { path: 'timestamp', op: 'lte', value: '2026-03-30T18:50:00Z' },
              ],
              select: ['timestamp', 'lifecycle_state', 'bridge_state', 'scenario_id', 'step_id', 'state_json'],
              limit: 10,
            },
          });
        }

        return JSON.stringify({
          action: 'finish',
          classification: 'summary',
          raw_review_required: false,
          output: 'timestamp filter worked',
        });
      },
    });

    const after = fs.readdirSync(plannerLogsPath).filter((entry) => /^planner_debug_.*\.json$/u.test(entry));
    const added = after.filter((entry) => !before.has(entry));
    assert.equal(added.length, 1);

    const debugDump = JSON.parse(fs.readFileSync(path.join(plannerLogsPath, added[0]), 'utf8'));
    const jsonFilterEvent = debugDump.events.find((event) => event.kind === 'planner_tool' && event.toolName === 'json_filter');
    assert.equal(jsonFilterEvent.output.collectionPath, 'states');
    assert.equal(jsonFilterEvent.output.matchedCount, 2);
    assert.match(jsonFilterEvent.output.text, /2026-03-30T18:42:57Z/u);
    assert.match(jsonFilterEvent.output.text, /2026-03-30T18:45:22Z/u);
    assert.doesNotMatch(jsonFilterEvent.output.text, /2026-03-30T18:39:59Z/u);
    assert.doesNotMatch(jsonFilterEvent.output.text, /2026-03-30T18:50:01Z/u);
  });
});

test('planner json_filter falls back to embedded JSON in command-output text and reports ignored prefix', async () => {
  await withTempEnv(async () => {
    const plannerLogsPath = getPlannerLogsPath();
    fs.mkdirSync(plannerLogsPath, { recursive: true });
    const before = new Set(fs.readdirSync(plannerLogsPath).filter((entry) => /^planner_debug_.*\.json$/u.test(entry)));

    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const embedded = JSON.stringify({
        openHandles: [],
        wasInterrupted: false,
        testResults: [
          {
            name: 'C:\\repo\\apps\\runner\\src\\__tests__\\navigation\\slow.test.ts',
            perfStats: { runtime: 91024 },
            status: 'passed',
          },
          {
            name: 'C:\\repo\\apps\\runner\\src\\__tests__\\navigation\\fast.test.ts',
            perfStats: { runtime: 421 },
            status: 'passed',
          },
        ],
      });
      const mixedInput = [
        'A worker process has failed to exit gracefully and has been force exited.',
        '',
        'Test Suites: 57 passed, 57 total',
        `Time:        135.456 s`,
        embedded,
      ].join('\n');
      const inputText = `${mixedInput}\n${buildOversizedTransitionsInput(Math.max(1000, threshold - mixedInput.length + 1000))}`;

      const result = await summarizeRequest({
        question: 'Extract names and runtime.',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
        sourceKind: 'command-output',
      });

      assert.equal(result.Classification, 'summary');
      assert.equal(result.Summary, 'fallback parse worked');
      assert.equal(server.state.chatRequests.length, 2);
      const followupPrompt = getChatRequestText(server.state.chatRequests[1]);
      assert.match(followupPrompt, /json_filter ignored "/u);
      assert.match(followupPrompt, /due to not being valid json, here is the parsed valid section:/u);
      assert.match(followupPrompt, /"testResults"/u);
    }, {
      assistantContent(promptText, parsed, requestIndex) {
        if (requestIndex === 1) {
          return JSON.stringify({
            action: 'tool',
            tool_name: 'json_filter',
            args: {
              collectionPath: 'testResults',
              filters: [{ path: 'name', op: 'exists' }],
              select: ['name', 'perfStats.runtime', 'status'],
              limit: 5,
            },
          });
        }

        return JSON.stringify({
          action: 'finish',
          classification: 'summary',
          raw_review_required: false,
          output: 'fallback parse worked',
        });
      },
    });

    const after = fs.readdirSync(plannerLogsPath).filter((entry) => /^planner_debug_.*\.json$/u.test(entry));
    const added = after.filter((entry) => !before.has(entry));
    assert.equal(added.length, 1);

    const debugDump = JSON.parse(fs.readFileSync(path.join(plannerLogsPath, added[0]), 'utf8'));
    const jsonFilterEvent = debugDump.events.find((event) => event.kind === 'planner_tool' && event.toolName === 'json_filter');
    assert.equal(Boolean(jsonFilterEvent?.output?.usedFallback), true);
    assert.match(String(jsonFilterEvent?.output?.ignoredPrefixPreview || ''), /A worker process has failed to exit gracefully/u);
    assert.match(String(jsonFilterEvent?.output?.parsedSectionPreview || ''), /"testResults"/u);
  });
});

test('planner surfaces explicit invalid-json message when json_filter fallback cannot parse any valid section', async () => {
  await withTempEnv(async () => {
    const plannerLogsPath = getPlannerLogsPath();
    fs.mkdirSync(plannerLogsPath, { recursive: true });
    const before = new Set(fs.readdirSync(plannerLogsPath).filter((entry) => /^planner_debug_.*\.json$/u.test(entry)));

    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const badPrefix = [
        'A worker process has failed to exit gracefully.',
        'Test Suites: 57 passed, 57 total',
        'Time: 135.456 s',
      ].join('\n');
      const noJsonText = `${badPrefix}\n${'x'.repeat(Math.max(1, threshold + 1000 - badPrefix.length))}`;

      const result = await summarizeRequest({
        question: 'Extract json info.',
        inputText: noJsonText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
        sourceKind: 'command-output',
      });

      assert.equal(result.Classification, 'summary');
      assert.equal(result.Summary, 'recovered after invalid json tool call');
      assert.equal(server.state.chatRequests.length, 2);
      const secondPrompt = getChatRequestText(server.state.chatRequests[1]);
      assert.match(secondPrompt, /Previous response was invalid: json_filter input is not valid JSON to parse\./u);
    }, {
      assistantContent(promptText, parsed, requestIndex) {
        if (requestIndex === 1) {
          return JSON.stringify({
            action: 'tool',
            tool_name: 'json_filter',
            args: {
              filters: [{ path: 'name', op: 'exists' }],
              select: ['name'],
              limit: 5,
            },
          });
        }

        return JSON.stringify({
          action: 'finish',
          classification: 'summary',
          raw_review_required: false,
          output: 'recovered after invalid json tool call',
        });
      },
    });

    const after = fs.readdirSync(plannerLogsPath).filter((entry) => /^planner_debug_.*\.json$/u.test(entry));
    const added = after.filter((entry) => !before.has(entry));
    assert.equal(added.length, 1);

    const debugDump = JSON.parse(fs.readFileSync(path.join(plannerLogsPath, added[0]), 'utf8'));
    const invalidEvent = debugDump.events.find((event) => event.kind === 'planner_invalid_response');
    assert.match(String(invalidEvent?.error || ''), /json_filter input is not valid JSON to parse\./u);
  });
});

test('planner failures write failed artifacts through status posts', async () => {
  await withTempEnv(async () => {
    const failedLogsPath = getFailedLogsPath();
    fs.mkdirSync(failedLogsPath, { recursive: true });
    const before = new Set(fs.readdirSync(failedLogsPath));
    let statusPosts = [];

    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputText = buildOversizedTransitionsInput(threshold + 1000);

      await assert.rejects(
        () => summarizeRequest({
          question: 'Find all transitions in the Lumbridge Castle area.',
          inputText,
          format: 'text',
          policyProfile: 'general',
          backend: 'llama.cpp',
          model: 'mock-model',
          debugCommand: 'type transitions.json | siftkit "Find all transitions in the Lumbridge Castle area."',
        }),
        /planner/i,
      );
      statusPosts = server.state.statusPosts.slice();
    }, {
      assistantContent() {
        return '{';
      },
    });

    const after = fs.readdirSync(failedLogsPath);
    const added = after.filter((entry) => !before.has(entry));
    assert.equal(added.length, 1);
    const failedDump = JSON.parse(fs.readFileSync(path.join(failedLogsPath, added[0]), 'utf8'));
    assert.equal(typeof failedDump.requestId, 'string');
    assert.equal(failedDump.question, 'Find all transitions in the Lumbridge Castle area.');
    assert.equal(failedDump.command, 'type transitions.json | siftkit "Find all transitions in the Lumbridge Castle area."');
    assert.equal(typeof failedDump.error, 'string');
    assert.equal(typeof failedDump.providerError, 'string');
    assert.equal(
      statusPosts.some((post) => (
        post.running === false
        && post.terminalState === 'failed'
        && typeof post.errorMessage === 'string'
        && /planner/i.test(post.errorMessage)
      )),
      true,
    );
  });
});

test('powershell shim preserves pipeline order for oversized planner input', async () => {
  await withTempEnv(async (tempRoot) => {
    const plannerLogsPath = getPlannerLogsPath();
    fs.mkdirSync(plannerLogsPath, { recursive: true });
    const before = new Set(fs.readdirSync(plannerLogsPath).filter((entry) => /^planner_debug_.*\.json$/u.test(entry)));

    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputPath = path.join(tempRoot, 'pipeline-transitions.json');
      fs.writeFileSync(inputPath, buildOversizedTransitionsInput(threshold + 1000), 'utf8');

      const shimPath = path.join(process.cwd(), 'bin', 'siftkit.ps1').replace(/'/gu, "''");
      const escapedInputPath = inputPath.replace(/'/gu, "''");
      const commandText = [
        `Get-Content -LiteralPath '${escapedInputPath}'`,
        '|',
        `& '${shimPath}'`,
        "'Find all transitions in the Lumbridge Castle area.'",
        '--backend llama.cpp',
        '--model mock-model',
      ].join(' ');
      const result = await spawnProcess('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-Command', commandText,
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          SIFTKIT_STATUS_BACKEND_URL: process.env.SIFTKIT_STATUS_BACKEND_URL,
          SIFTKIT_CONFIG_SERVICE_URL: process.env.SIFTKIT_CONFIG_SERVICE_URL,
        },
      });

      assert.equal(result.code, 0, result.stderr || result.stdout);
    }, {
      assistantContent(promptText, parsed, requestIndex) {
        if (requestIndex === 1) {
          return JSON.stringify({
            action: 'finish',
            classification: 'summary',
            raw_review_required: false,
            output: 'planner succeeded',
          });
        }

        throw new Error(`unexpected powershell shim request ${requestIndex}: ${String(promptText).slice(0, 120)}`);
      },
    });

    const after = fs.readdirSync(plannerLogsPath).filter((entry) => /^planner_debug_.*\.json$/u.test(entry));
    const added = after.filter((entry) => !before.has(entry));
    assert.equal(added.length, 1);

    const debugDump = JSON.parse(fs.readFileSync(path.join(plannerLogsPath, added[0]), 'utf8'));
    assert.match(debugDump.inputText, /^\[/u);
    assert.doesNotMatch(debugDump.inputText, /^\]\r?\n\[/u);
  });
});

test('planner debug dumps always write to the repo-local logs directory', async () => {
  await withTempEnv(async () => {
    const plannerLogsPath = getPlannerLogsPath();
    fs.mkdirSync(plannerLogsPath, { recursive: true });
    const before = new Set(fs.readdirSync(plannerLogsPath).filter((entry) => /^planner_debug_.*\.json$/u.test(entry)));

    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputText = buildOversizedTransitionsInput(threshold + 1000);

      const result = await summarizeRequest({
        question: 'Find all transitions in the Lumbridge Castle area.',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.Classification, 'summary');
    }, {
      assistantContent() {
        return JSON.stringify({
          action: 'finish',
          classification: 'summary',
          raw_review_required: false,
          output: 'repo-local debug dump',
        });
      },
    });

    const after = fs.readdirSync(plannerLogsPath).filter((entry) => /^planner_debug_.*\.json$/u.test(entry));
    const added = after.filter((entry) => !before.has(entry));
    assert.equal(added.length, 1);
  });
});

test('planner read_lines tool results use a compact numbered text block', async () => {
  await withTempEnv(async () => {
    const plannerLogsPath = getPlannerLogsPath();
    fs.mkdirSync(plannerLogsPath, { recursive: true });
    const before = new Set(fs.readdirSync(plannerLogsPath).filter((entry) => /^planner_debug_.*\.json$/u.test(entry)));

    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputText = buildOversizedTransitionsInput(threshold + 1000);

      const result = await summarizeRequest({
        question: 'Read the relevant lines and summarize them.',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.Classification, 'summary');
      assert.equal(server.state.chatRequests.length, 2);
      const followupPrompt = getChatRequestText(server.state.chatRequests[1]);
      assert.doesNotMatch(followupPrompt, /"lines"\s*:\s*\[/u);
      assert.doesNotMatch(followupPrompt, /"line"\s*:/u);
      assert.match(followupPrompt, /lineCount=/u);
      assert.match(followupPrompt, /^\d+: /mu);
    }, {
      assistantContent(promptText, parsed, requestIndex) {
        if (requestIndex === 1) {
          return JSON.stringify({
            action: 'tool',
            tool_name: 'read_lines',
            args: {
              startLine: 2,
              endLine: 5,
            },
          });
        }

        return JSON.stringify({
          action: 'finish',
          classification: 'summary',
          raw_review_required: false,
          output: 'compact read_lines summary',
        });
      },
    });

    const after = fs.readdirSync(plannerLogsPath).filter((entry) => /^planner_debug_.*\.json$/u.test(entry));
    const added = after.filter((entry) => !before.has(entry));
    assert.equal(added.length, 1);

    const debugDump = JSON.parse(fs.readFileSync(path.join(plannerLogsPath, added[0]), 'utf8'));
    const toolEvent = debugDump.events.find((event) => event.kind === 'planner_tool' && event.toolName === 'read_lines');
    assert.equal(Array.isArray(toolEvent?.output?.lines), false);
    assert.equal(typeof toolEvent?.output?.text, 'string');
    assert.match(toolEvent.output.text, /^\d+: /u);
  });
});

test('planner rejects semantically repeated nearby read_lines calls and reprompts for finish', async () => {
  await withTempEnv(async () => {
    const plannerLogsPath = getPlannerLogsPath();
    fs.mkdirSync(plannerLogsPath, { recursive: true });
    const before = new Set(fs.readdirSync(plannerLogsPath).filter((entry) => /^planner_debug_.*\.json$/u.test(entry)));

    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputText = buildOversizedTransitionsInput(threshold + 1000);

      const result = await summarizeRequest({
        question: 'Read the relevant lines conservatively, then summarize them.',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.Classification, 'summary');
      assert.equal(result.Summary, 'semantic repeat handled');
      assert.equal(server.state.chatRequests.length, 3);
      const followupPrompt = getChatRequestText(server.state.chatRequests[2]);
      assert.match(followupPrompt, /repeats the same search intent/u);
    }, {
      assistantContent(promptText, parsed, requestIndex) {
        if (requestIndex === 1) {
          return JSON.stringify({
            action: 'tool',
            tool_name: 'read_lines',
            args: {
              startLine: 2,
              endLine: 5,
            },
          });
        }
        if (requestIndex === 2) {
          return JSON.stringify({
            action: 'tool',
            tool_name: 'read_lines',
            args: {
              startLine: 6,
              endLine: 9,
            },
          });
        }
        return JSON.stringify({
          action: 'finish',
          classification: 'summary',
          raw_review_required: false,
          output: 'semantic repeat handled',
        });
      },
    });

    const after = fs.readdirSync(plannerLogsPath).filter((entry) => /^planner_debug_.*\.json$/u.test(entry));
    const added = after.filter((entry) => !before.has(entry));
    assert.equal(added.length, 1);

    const debugDump = JSON.parse(fs.readFileSync(path.join(plannerLogsPath, added[0]), 'utf8'));
    assert.equal(
      debugDump.events.some((event) => event.kind === 'planner_semantic_repeat' && event.toolCall?.tool_name === 'read_lines'),
      true,
    );
  });
});

test('planner find_text and json_filter results use compact text blocks in prompts and debug dumps', async () => {
  await withTempEnv(async () => {
    const plannerLogsPath = getPlannerLogsPath();
    fs.mkdirSync(plannerLogsPath, { recursive: true });
    const before = new Set(fs.readdirSync(plannerLogsPath).filter((entry) => /^planner_debug_.*\.json$/u.test(entry)));

    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputText = buildOversizedTransitionsInput(threshold + 1000);

      const result = await summarizeRequest({
        question: 'Use find_text and json_filter, then summarize.',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.Classification, 'summary');
      assert.equal(server.state.chatRequests.length, 3);
      const secondPrompt = getChatRequestText(server.state.chatRequests[1]);
      assert.doesNotMatch(secondPrompt, /"hits"\s*:\s*\[/u);
      assert.doesNotMatch(secondPrompt, /"context"\s*:\s*\[/u);
      assert.match(secondPrompt, /hitCount=/u);
      const thirdPrompt = getChatRequestText(server.state.chatRequests[2]);
      assert.doesNotMatch(thirdPrompt, /"results"\s*:\s*\[/u);
      assert.match(thirdPrompt, /matchedCount=/u);
    }, {
      assistantContent(promptText, parsed, requestIndex) {
        if (requestIndex === 1) {
          return JSON.stringify({
            action: 'tool',
            tool_name: 'find_text',
            args: {
              query: 'Lumbridge Castle',
              mode: 'literal',
              maxHits: 2,
              contextLines: 1,
            },
          });
        }

        if (requestIndex === 2) {
          return JSON.stringify({
            action: 'tool',
            tool_name: 'json_filter',
            args: {
              filters: [
                { path: 'from.worldX', op: 'gte', value: 3200 },
                { path: 'from.worldX', op: 'lte', value: 3215 },
              ],
              select: ['id', 'label', 'from', 'to', 'bidirectional'],
              limit: 5,
            },
          });
        }

        return JSON.stringify({
          action: 'finish',
          classification: 'summary',
          raw_review_required: false,
          output: 'compact framing summary',
        });
      },
    });

    const after = fs.readdirSync(plannerLogsPath).filter((entry) => /^planner_debug_.*\.json$/u.test(entry));
    const added = after.filter((entry) => !before.has(entry));
    assert.equal(added.length, 1);

    const debugDump = JSON.parse(fs.readFileSync(path.join(plannerLogsPath, added[0]), 'utf8'));
    const findTextEvent = debugDump.events.find((event) => event.kind === 'planner_tool' && event.toolName === 'find_text');
    assert.equal(Array.isArray(findTextEvent?.output?.hits), false);
    assert.equal(typeof findTextEvent?.output?.text, 'string');
    assert.match(findTextEvent.output.text, /^\d+: /u);
    const jsonFilterEvent = debugDump.events.find((event) => event.kind === 'planner_tool' && event.toolName === 'json_filter');
    assert.equal(Array.isArray(jsonFilterEvent?.output?.results), false);
    assert.equal(typeof jsonFilterEvent?.output?.text, 'string');
    assert.match(jsonFilterEvent.output.text, /"id"/u);
  });
});

test('planner replaces oversized tool results with an error stub when they exceed 70 percent of remaining stop-line tokens', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputText = buildOversizedTransitionsInput(threshold + 1000);

      const result = await summarizeRequest({
        question: 'Read some lines, then summarize.',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.Classification, 'summary');
      assert.equal(result.Summary, 'tool output guard applied');
      assert.equal(server.state.chatRequests.length, 2);
      const secondPrompt = getChatRequestText(server.state.chatRequests[1]);
      assert.match(
        secondPrompt,
        /Error: tool call results in 4000 tokens \(more than 70% of remaining tokens\)\. Try again with a more limited tool call\)/u,
      );
      assert.doesNotMatch(secondPrompt, /lineCount=/u);
      assert.doesNotMatch(secondPrompt, /^\d+: /mu);
    }, {
      config: {
        LlamaCpp: {
          NumCtx: 190000,
          Reasoning: 'off',
        },
        Runtime: {
          LlamaCpp: {
            NumCtx: 190000,
            Reasoning: 'off',
          },
        },
      },
      tokenizeTokenCount(content) {
        if (/^read_lines startLine=/mu.test(content)) {
          return 4000;
        }
        if (/Planner mode:/u.test(content)) {
          return 150000;
        }
        return Math.max(1, Math.ceil(content.length / 4));
      },
      assistantContent(promptText, parsed, requestIndex) {
        if (requestIndex === 1) {
          return JSON.stringify({
            action: 'tool',
            tool_name: 'read_lines',
            args: {
              startLine: 2,
              endLine: 5,
            },
          });
        }

        if (requestIndex === 2) {
          return JSON.stringify({
            action: 'finish',
            classification: 'summary',
            raw_review_required: false,
            output: 'tool output guard applied',
          });
        }

        throw new Error(`unexpected guarded planner request ${requestIndex}: ${String(promptText).slice(0, 120)}`);
      },
    });
  });
});

test('planner keeps tool results when they stay within 70 percent of remaining stop-line tokens', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputText = buildOversizedTransitionsInput(threshold + 1000);

      const result = await summarizeRequest({
        question: 'Read some lines, then summarize.',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.Classification, 'summary');
      assert.equal(result.Summary, 'tool output kept');
      assert.equal(server.state.chatRequests.length, 2);
      const secondPrompt = getChatRequestText(server.state.chatRequests[1]);
      assert.match(secondPrompt, /lineCount=/u);
      assert.match(secondPrompt, /^\d+: /mu);
      assert.doesNotMatch(secondPrompt, /Error: tool call results in \d+ tokens \(more than 70% of remaining tokens\)\. Try again with a more limited tool call\)/u);
    }, {
      config: {
        LlamaCpp: {
          NumCtx: 190000,
          Reasoning: 'off',
        },
        Runtime: {
          LlamaCpp: {
            NumCtx: 190000,
            Reasoning: 'off',
          },
        },
      },
      tokenizeTokenCount(content) {
        if (/^read_lines startLine=/mu.test(content)) {
          return 1200;
        }
        if (/Planner mode:/u.test(content)) {
          return 150000;
        }
        return Math.max(1, Math.ceil(content.length / 4));
      },
      assistantContent(promptText, parsed, requestIndex) {
        if (requestIndex === 1) {
          return JSON.stringify({
            action: 'tool',
            tool_name: 'read_lines',
            args: {
              startLine: 2,
              endLine: 5,
            },
          });
        }

        if (requestIndex === 2) {
          return JSON.stringify({
            action: 'finish',
            classification: 'summary',
            raw_review_required: false,
            output: 'tool output kept',
          });
        }

        throw new Error(`unexpected normal planner request ${requestIndex}: ${String(promptText).slice(0, 120)}`);
      },
    });
  });
});

test('planner falls back to estimated tokens for oversized tool-result guard when tokenize is unavailable', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputText = buildOversizedTransitionsInput(threshold + 1000);

      const result = await summarizeRequest({
        question: 'Read many lines, then summarize conservatively.',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.Classification, 'summary');
      assert.equal(result.Summary, 'estimated token guard applied');
      assert.equal(server.state.chatRequests.length, 2);
      assert.equal(
        server.state.tokenizeRequests.some((request) => /^read_lines startLine=/mu.test(String(request?.content || ''))),
        true,
      );
      const secondPrompt = getChatRequestText(server.state.chatRequests[1]);
      const guardMessageMatch = secondPrompt.match(
        /Error: tool call results in (\d+) tokens \(more than 70% of remaining tokens\)\. Try again with a more limited tool call\)/u,
      );
      assert.ok(guardMessageMatch);
      assert.ok(Number(guardMessageMatch[1]) > 0);
      assert.doesNotMatch(secondPrompt, /lineCount=/u);
    }, {
      config: {
        LlamaCpp: {
          NumCtx: 190000,
          Reasoning: 'off',
        },
        Runtime: {
          LlamaCpp: {
            NumCtx: 190000,
            Reasoning: 'off',
          },
        },
      },
      tokenizeTokenCount(content) {
        if (/^read_lines startLine=/mu.test(content)) {
          return -1;
        }
        if (/Planner mode:/u.test(content)) {
          return 150000;
        }
        return Math.max(1, Math.ceil(content.length / 4));
      },
      assistantContent(promptText, parsed, requestIndex) {
        if (requestIndex === 1) {
          return JSON.stringify({
            action: 'tool',
            tool_name: 'read_lines',
            args: {
              startLine: 1,
              endLine: 4000,
            },
          });
        }

        if (requestIndex === 2) {
          return JSON.stringify({
            action: 'finish',
            classification: 'summary',
            raw_review_required: false,
            output: 'estimated token guard applied',
          });
        }

        throw new Error(`unexpected estimated-token request ${requestIndex}: ${String(promptText).slice(0, 120)}`);
      },
    });
  });
});

test('planner activates once input exceeds 75 percent of context length even before chunking would start', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const plannerActivationThreshold = Math.floor(
        getConfiguredLlamaNumCtx(config) * getEffectiveInputCharactersPerContextToken(config) * 0.75
      );
      const chunkThreshold = getChunkThresholdCharacters(config);
      assert.ok(plannerActivationThreshold < chunkThreshold);
      const inputText = buildOversizedTransitionsInput(plannerActivationThreshold + 1000);

      const result = await summarizeRequest({
        question: 'Find the relevant Lumbridge Castle transitions.',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.Classification, 'summary');
      assert.equal(result.Summary, 'planner activated before chunk threshold');
      assert.equal(server.state.chatRequests.length, 1);
      assert.match(String(server.state.chatRequests[0]?.extra_body?.grammar || ''), /action/u);
      assert.equal(
        /Planner mode:/u.test(getChatRequestText(server.state.chatRequests[0])),
        true,
      );
      assert.equal(inputText.length < chunkThreshold, true);
    }, {
      assistantContent() {
        return JSON.stringify({
          action: 'finish',
          classification: 'summary',
          raw_review_required: false,
          output: 'planner activated before chunk threshold',
        });
      },
    });
  });
});

test('planner allows up to thirty tool calls while prompt headroom remains without visible budget counters', async () => {
  await withTempEnv(async () => {
    let toolCallCount = 0;
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputText = buildOversizedTransitionsInput(threshold + 5000);

      const result = await summarizeRequest({
        question: 'Use tools if needed to summarize the relevant transition evidence.',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.Classification, 'summary');
      assert.equal(result.RawReviewRequired, false);
      assert.equal(result.Summary, 'completed after 30 tool calls');
      assert.equal(toolCallCount, 30);
      assert.equal(server.state.chatRequests.length, 31);
      assert.doesNotMatch(getChatRequestText(server.state.chatRequests[0]), /Tool-call budget remaining:/u);
      assert.doesNotMatch(getChatRequestText(server.state.chatRequests[1]), /Tool-call budget remaining:/u);
    }, {
      config: {
        LlamaCpp: {
          NumCtx: 190000,
          Reasoning: 'off',
        },
        Runtime: {
          LlamaCpp: {
            NumCtx: 190000,
            Reasoning: 'off',
          },
        },
      },
      tokenizeTokenCount(content) {
        if (/Planner mode:/u.test(content)) {
          return 1000;
        }
        return Math.max(1, Math.ceil(content.length / 4));
      },
      assistantContent(promptText, parsed, requestIndex) {
        if (requestIndex <= 30) {
          toolCallCount += 1;
          return JSON.stringify({
            action: 'tool',
            tool_name: toolCallCount % 2 === 0 ? 'read_lines' : 'find_text',
            args: toolCallCount % 2 === 0
              ? { startLine: toolCallCount, endLine: toolCallCount + 4 }
              : { query: 'Lumbridge Castle', mode: 'literal', maxHits: 5 },
          });
        }

        if (requestIndex === 31) {
          return JSON.stringify({
            action: 'finish',
            classification: 'summary',
            raw_review_required: false,
            output: `completed after ${toolCallCount} tool calls`,
          });
        }

        throw new Error(`unexpected headroom-allowed request ${requestIndex}: ${String(promptText).slice(0, 120)}`);
      },
    });
  });
});

test('planner reuses one slot within a request and assigns a new slot to the next request', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputText = buildOversizedTransitionsInput(threshold + 1000);

      const first = await summarizeRequest({
        question: 'Find the relevant Lumbridge Castle transitions.',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });
      const second = await summarizeRequest({
        question: 'Find the relevant Lumbridge Castle transitions again.',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(first.Classification, 'summary');
      assert.equal(second.Classification, 'summary');
      assert.equal(server.state.chatRequests.length, 4);
      assert.equal(server.state.chatRequests[0].id_slot, server.state.chatRequests[1].id_slot);
      assert.equal(server.state.chatRequests[2].id_slot, server.state.chatRequests[3].id_slot);
      assert.notEqual(server.state.chatRequests[0].id_slot, server.state.chatRequests[2].id_slot);
    }, {
      config: {
        LlamaCpp: {
          ParallelSlots: 4,
        },
        Runtime: {
          LlamaCpp: {
            ParallelSlots: 4,
          },
        },
      },
      assistantContent(promptText, parsed, requestIndex) {
        if (requestIndex === 1 || requestIndex === 3) {
          return JSON.stringify({
            action: 'tool',
            tool_name: 'json_filter',
            args: {
              filters: [
                { path: 'from.worldX', op: 'gte', value: 3200 },
                { path: 'from.worldX', op: 'lte', value: 3215 },
              ],
              select: ['id', 'label', 'from', 'to'],
              limit: 5,
            },
          });
        }

        if (requestIndex === 2 || requestIndex === 4) {
          return JSON.stringify({
            action: 'finish',
            classification: 'summary',
            raw_review_required: false,
            output: `request ${requestIndex / 2} finished`,
          });
        }

        throw new Error(`unexpected slot request ${requestIndex}: ${String(promptText).slice(0, 120)}`);
      },
    });
  });
});

test('planner fails fast when the next planner turn would exceed non-thinking headroom', async () => {
  await withTempEnv(async () => {
    let servedPlannerToolCall = false;
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputText = buildOversizedTransitionsInput(threshold + 1000);

      await assert.rejects(
        () => summarizeRequest({
          question: 'Summarize the visible transition evidence conservatively.',
          inputText,
          format: 'text',
          policyProfile: 'general',
          backend: 'llama.cpp',
          model: 'mock-model',
        }),
        /Planner mode failed: planner_headroom_exceeded/u,
      );
      assert.equal(servedPlannerToolCall, true);
      assert.match(String(server.state.chatRequests[0]?.extra_body?.grammar || ''), /action/u);
      assert.equal(
        server.state.chatRequests.some((request) => /<<<BEGIN_LITERAL_INPUT_SLICE>>>/u.test(getChatRequestText(request))),
        false,
      );
    }, {
      config: {
        LlamaCpp: {
          NumCtx: 190000,
          Reasoning: 'off',
        },
        Runtime: {
          LlamaCpp: {
            NumCtx: 190000,
            Reasoning: 'off',
          },
        },
      },
      tokenizeTokenCount(content) {
        if (/Planner mode:/u.test(content) && /\[tool\]/u.test(content)) {
          return 154000;
        }
        return 1000;
      },
      assistantContent(promptText, parsed, requestIndex) {
        if (!servedPlannerToolCall) {
          servedPlannerToolCall = true;
          return JSON.stringify({
            action: 'tool',
            tool_name: 'json_filter',
            args: {
              filters: [
                { path: 'from.worldX', op: 'gte', value: 3200 },
                { path: 'from.worldX', op: 'lte', value: 3215 },
              ],
              select: ['id', 'label', 'from', 'to'],
              limit: 20,
            },
          });
        }

        throw new Error(`unexpected fallback request ${requestIndex}: ${String(promptText).slice(0, 120)}`);
      },
    });
  });
});

test('planner fails fast when the next planner turn would exceed thinking headroom', async () => {
  await withTempEnv(async () => {
    let servedPlannerToolCall = false;
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputText = buildOversizedTransitionsInput(threshold + 1000);

      await assert.rejects(
        () => summarizeRequest({
          question: 'Summarize the visible transition evidence conservatively.',
          inputText,
          format: 'text',
          policyProfile: 'general',
          backend: 'llama.cpp',
          model: 'mock-model',
        }),
        /Planner mode failed: planner_headroom_exceeded/u,
      );
      assert.equal(servedPlannerToolCall, true);
      assert.equal(
        server.state.chatRequests.some((request) => /<<<BEGIN_LITERAL_INPUT_SLICE>>>/u.test(getChatRequestText(request))),
        false,
      );
    }, {
      config: {
        LlamaCpp: {
          NumCtx: 190000,
          Reasoning: 'on',
        },
        Runtime: {
          LlamaCpp: {
            NumCtx: 190000,
            Reasoning: 'on',
          },
        },
      },
      tokenizeTokenCount(content) {
        if (/Planner mode:/u.test(content) && /\[tool\]/u.test(content)) {
          return 149000;
        }
        return 1000;
      },
      assistantContent(promptText, parsed, requestIndex) {
        if (!servedPlannerToolCall) {
          servedPlannerToolCall = true;
          return JSON.stringify({
            action: 'tool',
            tool_name: 'json_filter',
            args: {
              filters: [
                { path: 'from.worldY', op: 'gte', value: 3210 },
                { path: 'from.worldY', op: 'lte', value: 3225 },
              ],
              select: ['id', 'label', 'from', 'to'],
              limit: 20,
            },
          });
        }

        throw new Error(`unexpected thinking fallback request ${requestIndex}: ${String(promptText).slice(0, 120)}`);
      },
    });
  });
});

test('planner find_text auto-normalizes lone regex braces like var.*Unlocks.*=.*{', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const filler = buildOversizedTransitionsInput(threshold + 1000);
      const inputText = `${filler}\nvar Unlocks = {`;

      const result = await summarizeRequest({
        question: 'Summarize the visible transition evidence conservatively.',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.Classification, 'summary');
      assert.equal(result.RawReviewRequired, false);
      assert.equal(result.Summary, 'planner recovered from invalid regex');
      assert.equal(server.state.chatRequests.length, 2);
      assert.match(getChatRequestText(server.state.chatRequests[1]), /hitCount=1/u);
    }, {
      assistantContent(promptText, parsed, requestIndex) {
        if (requestIndex === 1) {
          return JSON.stringify({
            action: 'tool',
            tool_name: 'find_text',
            args: {
              query: 'var.*Unlocks.*=.*{',
              mode: 'regex',
              maxHits: 3,
              contextLines: 2,
            },
          });
        }

        if (requestIndex === 2) {
          return JSON.stringify({
            action: 'finish',
            classification: 'summary',
            raw_review_required: false,
            output: 'planner recovered from invalid regex',
          });
        }

        throw new Error(`unexpected invalid-regex request ${requestIndex}: ${String(promptText).slice(0, 120)}`);
      },
    });
  });
});

test('planner fails fast when the planner response body is empty', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputText = buildOversizedTransitionsInput(threshold + 1000);

      await assert.rejects(
        () => summarizeRequest({
          question: 'Find all transitions in the Lumbridge Castle area.',
          inputText,
          format: 'text',
          policyProfile: 'general',
          backend: 'llama.cpp',
          model: 'mock-model',
        }),
        /Planner mode failed: llama\.cpp did not return a response body\./u,
      );
      assert.equal(server.state.chatRequests.length, 1);
      assert.match(String(server.state.chatRequests[0]?.extra_body?.grammar || ''), /action/u);
      assert.equal(
        server.state.chatRequests.some((request) => /<<<BEGIN_LITERAL_INPUT_SLICE>>>/u.test(getChatRequestText(request))),
        false,
      );
    }, {
      assistantContent() {
        return '';
      },
    });
  });
});

test('summarizeRequest no longer rejects input larger than 4x chunk threshold when planner mode can handle it', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });
      const chunkThreshold = getChunkThresholdCharacters(config);
      const inputChars = (chunkThreshold * 4) + 1;
      const result = await summarizeRequest({
        question: 'Summarize oversized input.',
        inputText: buildOversizedTransitionsInput(inputChars),
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.Classification, 'summary');
      assert.equal(result.Summary, 'oversized input accepted');
    }, {
      assistantContent() {
        return JSON.stringify({
          action: 'finish',
          classification: 'summary',
          raw_review_required: false,
          output: 'oversized input accepted',
        });
      },
    });
  });
});


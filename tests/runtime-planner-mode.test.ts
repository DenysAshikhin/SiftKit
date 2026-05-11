// @ts-nocheck — Split from runtime.test.js. Full TS typing deferred.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const { loadConfig, saveConfig, getConfigPath, getExecutionServerState, getChunkThresholdCharacters, getConfiguredLlamaNumCtx, getEffectiveInputCharactersPerContextToken, initializeRuntime, getStatusServerUnavailableMessage } = require('../dist/config/index.js');
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

function buildOversizedAmbiguousCollectionInput(minCharacters) {
  const document = {
    usersA: [],
    usersB: [],
  };

  for (let index = 0; JSON.stringify(document).length < minCharacters; index += 1) {
    document.usersA.push({
      id: index,
      name: `Alpha ${index}`,
      note: `candidate-a-${index}`,
    });
    document.usersB.push({
      id: index,
      name: `Beta ${index}`,
      note: `candidate-b-${index}`,
    });
  }

  return JSON.stringify(document);
}

function buildOversizedWidgetPayloadInput(minCharacters) {
  const document = {
    widgetRootCount: 0,
    widgetRoots: [],
    bankGroupDirectLookup: {},
    textSearchResults: [],
    currentBankDetection: null,
  };

  for (let index = 0; JSON.stringify(document).length < minCharacters; index += 1) {
    const groupId = index % 5 === 0 ? 12 : 164;
    document.widgetRoots.push({
      id: 10747904 + index,
      groupId,
      childIndex: index,
      text: groupId === 12 ? `quantity-${index}` : '',
      name: '',
      isHidden: false,
      hasBounds: true,
      childCount: 0,
      dynamicChildCount: 0,
    });
  }

  document.widgetRootCount = document.widgetRoots.length;
  return JSON.stringify(document);
}

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

test('planner iteration running=false notification is fire-and-forget', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputText = buildOversizedTransitionsInput(threshold + 1000);
      const startedAt = Date.now();

      const result = await summarizeRequest({
        question: 'Find all transitions in the Lumbridge Castle area.',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
        statusBackendUrl: server.statusUrl,
      });

      assert.equal(result.Classification, 'summary');
      assert.equal(result.Summary, 'fire and forget completed');
      assert.ok(Date.now() - startedAt < 1000);
      assert.equal(server.state.statusPosts.some((post) => post.running === false && !post.terminalState), true);
    }, {
      delayNonTerminalStatusFalseMs: 1500,
      assistantContent(promptText, parsed, requestIndex) {
        if (requestIndex === 1) {
          return JSON.stringify({
            action: 'tool',
            tool_name: 'json_filter',
            args: {
              filters: [{ path: 'from.worldX', op: 'gte', value: 3200 }],
              limit: 1,
            },
          });
        }

        return JSON.stringify({
          action: 'finish',
          classification: 'summary',
          raw_review_required: false,
          output: 'fire and forget completed',
        });
      },
    });
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

test('planner accepts exact nested value scalar wrappers in json_filter args', async () => {
  await withTempEnv(async () => {
    const plannerLogsPath = getPlannerLogsPath();
    fs.mkdirSync(plannerLogsPath, { recursive: true });
    const before = new Set(fs.readdirSync(plannerLogsPath).filter((entry) => /^planner_debug_.*\.json$/u.test(entry)));

    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputText = buildOversizedWidgetPayloadInput(threshold + 1000);

      const result = await summarizeRequest({
        question: 'Find widgetRoots entries where groupId is 12. Return id, groupId, childIndex, and text.',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.Classification, 'summary');
      assert.equal(result.Summary, 'nested value wrapper worked');
    }, {
      assistantContent(promptText, parsed, requestIndex) {
        if (requestIndex === 1) {
          return JSON.stringify({
            action: 'tool',
            tool_name: 'json_filter',
            args: {
              filters: [
                { path: 'groupId', op: 'eq', value: { value: 12 } },
              ],
              select: ['id', 'groupId', 'childIndex', 'text'],
              limit: 100,
            },
          });
        }

        return JSON.stringify({
          action: 'finish',
          classification: 'summary',
          raw_review_required: false,
          output: 'nested value wrapper worked',
        });
      },
    });

    const after = fs.readdirSync(plannerLogsPath).filter((entry) => /^planner_debug_.*\.json$/u.test(entry));
    const added = after.filter((entry) => !before.has(entry));
    assert.equal(added.length, 1);

    const debugDump = JSON.parse(fs.readFileSync(path.join(plannerLogsPath, added[0]), 'utf8'));
    const jsonFilterEvent = debugDump.events.find((event) => event.kind === 'planner_tool' && event.toolName === 'json_filter');
    assert.equal(jsonFilterEvent.output.matchedCount > 0, true);
    assert.match(jsonFilterEvent.output.text, /"groupId":12/u);
    assert.equal(
      debugDump.events.some((event) => event.kind === 'planner_invalid_response'),
      false,
    );
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

test('planner returns recoverable json_filter collectionPath guidance without counting an invalid response', async () => {
  await withTempEnv(async () => {
    const plannerLogsPath = getPlannerLogsPath();
    fs.mkdirSync(plannerLogsPath, { recursive: true });
    const before = new Set(fs.readdirSync(plannerLogsPath).filter((entry) => /^planner_debug_.*\.json$/u.test(entry)));

    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputText = buildOversizedAmbiguousCollectionInput(threshold + 1000);

      const result = await summarizeRequest({
        question: 'Find matching id/name rows.',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.Classification, 'summary');
      assert.equal(result.Summary, 'recovered after collectionPath guidance');
      assert.equal(server.state.chatRequests.length, 2);
      const secondPrompt = getChatRequestText(server.state.chatRequests[1]);
      assert.doesNotMatch(secondPrompt, /Previous response was invalid:/u);
      assert.match(secondPrompt, /Candidate collectionPath values: usersA, usersB/u);
    }, {
      assistantContent(promptText, parsed, requestIndex) {
        if (requestIndex === 1) {
          return JSON.stringify({
            action: 'tool',
            tool_name: 'json_filter',
            args: {
              filters: [{ path: 'id', op: 'exists' }],
              select: ['id', 'name'],
              limit: 5,
            },
          });
        }

        return JSON.stringify({
          action: 'finish',
          classification: 'summary',
          raw_review_required: false,
          output: 'recovered after collectionPath guidance',
        });
      },
    });

    const after = fs.readdirSync(plannerLogsPath).filter((entry) => /^planner_debug_.*\.json$/u.test(entry));
    const added = after.filter((entry) => !before.has(entry));
    assert.equal(added.length, 1);

    const debugDump = JSON.parse(fs.readFileSync(path.join(plannerLogsPath, added[0]), 'utf8'));
    assert.equal(
      debugDump.events.filter((event) => event.kind === 'planner_invalid_response').length,
      0,
    );
    const jsonFilterEvent = debugDump.events.find((event) => event.kind === 'planner_tool' && event.toolName === 'json_filter');
    assert.match(String(jsonFilterEvent?.output?.error || ''), /Candidate collectionPath values: usersA, usersB/u);
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
      const secondRequest = server.state.chatRequests[1];
      const secondMessages = Array.isArray(secondRequest?.messages) ? secondRequest.messages : [];
      const secondPrompt = getChatRequestText(secondRequest);
      const assistantMessage = secondMessages.find((message) => Array.isArray(message?.tool_calls));
      const toolMessages = secondMessages.filter((message) => message?.role === 'tool');
      const assistantToolCall = Array.isArray(assistantMessage?.tool_calls) ? assistantMessage.tool_calls[0] : null;
      assert.equal(String(assistantToolCall?.function?.name || ''), 'json_filter');
      assert.equal(toolMessages.length > 0, true);
      assert.match(secondPrompt, /json_filter input is not valid JSON to parse\./u);
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
      await waitForAsyncExpectation(async () => {
        assert.equal(
          server.state.statusPosts.some((post) => (
            post.running === false
            && post.terminalState === 'failed'
            && typeof post.errorMessage === 'string'
            && /planner/i.test(post.errorMessage)
          )),
          true,
        );
      }, 5000);
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

      const shimPath = path.resolve(__dirname, '..', 'bin', 'siftkit.ps1').replace(/'/gu, "''");
      const escapedInputPath = inputPath.replace(/'/gu, "''");
      const commandText = [
        `Get-Content -LiteralPath '${escapedInputPath}'`,
        '|',
        `& (Resolve-Path -LiteralPath '${shimPath}')`,
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
      assert.match(followupPrompt, /duplicate command requested x2\. Issue a different\/unique tool call/u);
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

test('planner keeps the first real tool output and rewrites one duplicate warning tool turn through x5', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputText = buildOversizedTransitionsInput(threshold + 1000);
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
        question: 'Find the exact route id.',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.Classification, 'summary');
      assert.equal(result.Summary, 'duplicate compaction handled');
      assert.equal(server.state.chatRequests.length, 6);
      for (const request of server.state.chatRequests.slice(0, 5)) {
        assert.deepEqual(request.chat_template_kwargs, {
          enable_thinking: true,
        });
      }
      const finalRequest = server.state.chatRequests[5];
      assert.deepEqual(finalRequest.chat_template_kwargs, {
        enable_thinking: false,
      });
      const finalMessages = Array.isArray(finalRequest?.messages) ? finalRequest.messages : [];
      const assistantToolCalls = finalMessages.filter((message) => Array.isArray(message?.tool_calls));
      const toolMessages = finalMessages.filter((message) => message?.role === 'tool');
      const duplicateToolMessages = toolMessages.filter((message) => /duplicate command requested/u.test(String(message?.content || '')));
      const duplicateUserMessages = finalMessages.filter((message) => message?.role === 'user' && /duplicate command requested/u.test(String(message?.content || '')));
      assert.equal(assistantToolCalls.length, 2);
      assert.equal(toolMessages.length, 2);
      assert.equal(duplicateToolMessages.length, 1);
      assert.equal(duplicateUserMessages.length, 0);
      assert.match(String(duplicateToolMessages[0]?.content || ''), /duplicate command requested x5\. Issue a different\/unique tool call/u);
      assert.doesNotMatch(String(duplicateToolMessages[0]?.content || ''), /repeated tool call/u);
    }, {
      assistantContent(_promptText, _parsed, requestIndex) {
        if (requestIndex === 1) {
          return JSON.stringify({
            action: 'tool',
            tool_name: 'find_text',
            args: {
              query: 'NO_MATCH_ALPHA',
              mode: 'literal',
            },
          });
        }
        if (requestIndex === 2) {
          return JSON.stringify({
            action: 'tool',
            tool_name: 'find_text',
            args: {
              query: 'NO_MATCH_ALPHA',
              mode: 'literal',
            },
          });
        }
        if (requestIndex === 3) {
          return JSON.stringify({
            action: 'tool',
            tool_name: 'find_text',
            args: {
              query: 'NO_MATCH_ALPHA',
              mode: 'literal',
            },
          });
        }
        if (requestIndex === 4) {
          return JSON.stringify({
            action: 'tool',
            tool_name: 'find_text',
            args: {
              query: 'NO_MATCH_ALPHA',
              mode: 'literal',
            },
          });
        }
        if (requestIndex === 5) {
          return JSON.stringify({
            action: 'tool',
            tool_name: 'find_text',
            args: {
              query: 'NO_MATCH_ALPHA',
              mode: 'literal',
            },
          });
        }
        return JSON.stringify({
          action: 'finish',
          classification: 'summary',
          raw_review_required: false,
          output: 'duplicate compaction handled',
        });
      },
    });
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
      const plannerBudget = getPlannerPromptBudget(config);
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

function buildOversizedMultilinePlannerInput(targetCharacters) {
  const lines = [];
  let totalCharacters = 0;
  while (totalCharacters < targetCharacters) {
    const line = `line ${lines.length + 1} ${'x'.repeat(120)}`;
    lines.push(line);
    totalCharacters += line.length + 1;
  }
  return lines.join('\n');
}

test('planner keeps short read_lines output when reported token count is high', async () => {
  await withTempEnv(async () => {
    const plannerConfig = {
      LlamaCpp: {
        NumCtx: 19000,
        Reasoning: 'off',
      },
      Runtime: {
        LlamaCpp: {
          NumCtx: 19000,
          Reasoning: 'off',
        },
      },
    };
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputText = buildOversizedMultilinePlannerInput(threshold + 1000);

      const result = await summarizeRequest({
        question: 'Read some lines, then summarize.',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
        allowedPlannerTools: ['read_lines'],
      });

      assert.equal(result.Classification, 'summary');
      assert.equal(result.Summary, 'tool output guard applied');
      assert.equal(server.state.chatRequests.length, 2);
      const secondPrompt = getChatRequestText(server.state.chatRequests[1]);
      assert.match(secondPrompt, /lineCount=4/u);
      assert.match(secondPrompt, /^2: /mu);
    }, {
      config: plannerConfig,
      tokenizeTokenCount(content) {
        if (/read_lines startLine=/u.test(content)) {
          return 4000;
        }
        return 1000;
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
    const plannerConfig = {
      LlamaCpp: {
        NumCtx: 19000,
        Reasoning: 'off',
      },
      Runtime: {
        LlamaCpp: {
          NumCtx: 19000,
          Reasoning: 'off',
        },
      },
    };
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputText = buildOversizedMultilinePlannerInput(threshold + 1000);

      const result = await summarizeRequest({
        question: 'Read some lines, then summarize.',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
        allowedPlannerTools: ['read_lines'],
      });

      assert.equal(result.Classification, 'summary');
      assert.equal(result.Summary, 'tool output kept');
      assert.equal(server.state.chatRequests.length, 2);
      const secondPrompt = getChatRequestText(server.state.chatRequests[1]);
      assert.match(secondPrompt, /lineCount=/u);
      assert.match(secondPrompt, /^\d+: /mu);
      assert.doesNotMatch(secondPrompt, /Error: tool call results in \d+ tokens \(more than 70% of remaining tokens\)\. Try again with a more limited tool call\)/u);
    }, {
      config: plannerConfig,
      tokenizeTokenCount(content) {
        if (/read_lines startLine=/u.test(content)) {
          return 1200;
        }
        return 1000;
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

test('planner keeps read_lines output when tokenize is unavailable', async () => {
  await withTempEnv(async () => {
    const plannerConfig = {
      LlamaCpp: {
        NumCtx: 19000,
        Reasoning: 'off',
      },
      Runtime: {
        LlamaCpp: {
          NumCtx: 19000,
          Reasoning: 'off',
        },
      },
    };
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputText = buildOversizedMultilinePlannerInput(threshold + 1000);

      const result = await summarizeRequest({
        question: 'Read many lines, then summarize conservatively.',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
        allowedPlannerTools: ['read_lines'],
      });

      assert.equal(result.Classification, 'summary');
      assert.equal(result.Summary, 'estimated token guard applied');
      assert.equal(server.state.chatRequests.length, 2);
      assert.equal(
        server.state.tokenizeRequests.some((request) => /read_lines startLine=/u.test(String(request?.content || ''))),
        true,
      );
      const secondPrompt = getChatRequestText(server.state.chatRequests[1]);
      assert.match(secondPrompt, /lineCount=\d+/u);
      assert.match(secondPrompt, /^1: /mu);
    }, {
      config: plannerConfig,
      tokenizeTokenCount(content) {
        if (/read_lines startLine=/u.test(content)) {
          return -1;
        }
        return 1000;
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
      assert.match(JSON.stringify(server.state.chatRequests[0]?.response_format || {}), /action/u);
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
      assert.equal(Number.isInteger(server.state.chatRequests[0].id_slot), true);
      assert.equal(Number.isInteger(server.state.chatRequests[2].id_slot), true);
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
      omitUsage: true,
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
      assert.match(JSON.stringify(server.state.chatRequests[0]?.response_format || {}), /action/u);
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


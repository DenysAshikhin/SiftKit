// @ts-nocheck — Split from runtime.test.js. Full TS typing deferred.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const { loadConfig, saveConfig, getConfigPath, getExecutionServerState, getChunkThresholdCharacters, getConfiguredLlamaNumCtx, getEffectiveInputCharactersPerContextToken, initializeRuntime, getStatusServerUnavailableMessage } = require('../src/config/index.js');
const { summarizeRequest, buildPrompt, getSummaryDecision, planTokenAwareLlamaCppChunks, getPlannerPromptBudget, buildPlannerToolDefinitions, UNSUPPORTED_INPUT_MESSAGE } = require('../src/summary.js');
const { runCommand } = require('./helpers/run-command-for-test.js');
const { runBenchmarkSuite } = require('../bench/benchmark/index.ts');
const { readMatrixManifest, buildLaunchSignature, buildLauncherArgs, buildBenchmarkArgs, pruneOldLauncherLogs, runMatrix, runMatrixWithInterrupt } = require('../bench/benchmark-matrix/index.ts');
const { countLlamaCppTokens, listLlamaCppModels, generateLlamaCppResponse } = require('../src/providers/llama-cpp.js');
const { withExecutionLock } = require('../src/execution-lock.js');
const { buildIdleMetricsLogMessage, buildStatusRequestLogMessage, formatElapsed, getIdleSummarySnapshotsPath, startStatusServer } = require('../src/status-server/index.js');
const { runDebugRequest } = require('../bench/repro/run-benchmark-fixture-debug.ts');
const { runFixture60MalformedJsonRepro } = require('../bench/repro/repro-fixture60-malformed-json.ts');

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
          return JSON.stringify({ action: 'find_text', query: 'var.*Unlocks.*=.*{',
              mode: 'regex',
              maxHits: 3,
              contextLines: 2, });
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
      assert.match(JSON.stringify(server.state.chatRequests[0]?.response_format || {}), /action/u);
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

test('planner tolerates several malformed replies before succeeding instead of aborting after two', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
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
      assert.equal(result.Summary, 'planner tolerated invalid replies');
      // Three malformed replies are fed back with corrective guidance; the
      // fourth reply finishes. The old limit aborted after the second.
      assert.equal(server.state.chatRequests.length, 4);
    }, {
      assistantContent(promptText, parsed, requestIndex) {
        if (requestIndex < 4) {
          return 'this is not a valid planner action';
        }
        return JSON.stringify({
          action: 'finish',
          classification: 'summary',
          raw_review_required: false,
          output: 'planner tolerated invalid replies',
        });
      },
    });
  });
});

test('planner accepts a direct structured summary response for oversized input instead of falling back to chunking', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      const threshold = getChunkThresholdCharacters(config);
      const inputText = buildOversizedTransitionsInput(threshold + 1000);

      const result = await summarizeRequest({
        question: 'Summarize oversized input.',
        inputText,
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.Classification, 'summary');
      assert.equal(result.Summary, 'planner direct summary');
      assert.equal(server.state.chatRequests.length, 1);
      assert.equal(
        server.state.chatRequests.some((request) => /<<<BEGIN_LITERAL_INPUT_SLICE>>>/u.test(getChatRequestText(request))),
        false,
      );
    }, {
      assistantContent() {
        return JSON.stringify({
          classification: 'summary',
          raw_review_required: false,
          output: 'planner direct summary',
        });
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


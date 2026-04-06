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

test('summary aggregation accumulates provider usage and duration in status metrics', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const baselineInputCharacters = server.state.metrics.inputCharactersTotal;
      const baselineOutputCharacters = server.state.metrics.outputCharactersTotal;
      const baselineInputTokens = server.state.metrics.inputTokensTotal;
      const baselineOutputTokens = server.state.metrics.outputTokensTotal;
      const baselineThinkingTokens = server.state.metrics.thinkingTokensTotal;
      const baselineCompletedRequestCount = server.state.metrics.completedRequestCount;
      const baselineRequestDurationMs = server.state.metrics.requestDurationMsTotal;
      const result = await summarizeRequest({
        question: 'summarize this',
        inputText: 'A'.repeat(5000),
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.WasSummarized, true);
      assert.ok(server.state.metrics.inputCharactersTotal > baselineInputCharacters);
      assert.ok(server.state.metrics.outputCharactersTotal > baselineOutputCharacters);
      assert.equal(server.state.metrics.inputTokensTotal - baselineInputTokens, 123);
      assert.equal(server.state.metrics.outputTokensTotal - baselineOutputTokens, 45);
      assert.equal(server.state.metrics.thinkingTokensTotal - baselineThinkingTokens, 0);
      assert.ok(server.state.metrics.completedRequestCount - baselineCompletedRequestCount >= 1);
      assert.ok(server.state.metrics.requestDurationMsTotal >= baselineRequestDurationMs);
    }, {
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

test('summary aggregation records duration without tokens when provider usage is absent', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const baselineInputCharacters = server.state.metrics.inputCharactersTotal;
      const baselineOutputCharacters = server.state.metrics.outputCharactersTotal;
      const baselineInputTokens = server.state.metrics.inputTokensTotal;
      const baselineOutputTokens = server.state.metrics.outputTokensTotal;
      const baselineThinkingTokens = server.state.metrics.thinkingTokensTotal;
      const baselineCompletedRequestCount = server.state.metrics.completedRequestCount;
      const baselineRequestDurationMs = server.state.metrics.requestDurationMsTotal;
      const result = await summarizeRequest({
        question: 'summarize this',
        inputText: 'A'.repeat(5000),
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.WasSummarized, true);
      assert.ok(server.state.metrics.inputCharactersTotal > baselineInputCharacters);
      assert.ok(server.state.metrics.outputCharactersTotal > baselineOutputCharacters);
      assert.equal(server.state.metrics.inputTokensTotal - baselineInputTokens, 0);
      assert.equal(server.state.metrics.outputTokensTotal - baselineOutputTokens, 0);
      assert.equal(server.state.metrics.thinkingTokensTotal - baselineThinkingTokens, 0);
      assert.ok(server.state.metrics.completedRequestCount - baselineCompletedRequestCount >= 1);
      assert.ok(server.state.metrics.requestDurationMsTotal >= baselineRequestDurationMs);
    }, {
      omitUsage: true,
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

test('summary aggregation records thinking tokens independently from output metrics', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const baselineInputTokens = server.state.metrics.inputTokensTotal;
      const baselineOutputTokens = server.state.metrics.outputTokensTotal;
      const baselineThinkingTokens = server.state.metrics.thinkingTokensTotal;
      const baselineCompletedRequestCount = server.state.metrics.completedRequestCount;
      const baselineRequestDurationMs = server.state.metrics.requestDurationMsTotal;
      const result = await summarizeRequest({
        question: 'summarize this',
        inputText: 'A'.repeat(5000),
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
        model: 'mock-model',
      });

      assert.equal(result.WasSummarized, true);
      assert.equal(server.state.metrics.inputTokensTotal - baselineInputTokens, 123);
      assert.equal(server.state.metrics.outputTokensTotal - baselineOutputTokens, 33);
      assert.equal(server.state.metrics.thinkingTokensTotal - baselineThinkingTokens, 12);
      assert.ok(server.state.metrics.completedRequestCount - baselineCompletedRequestCount >= 1);
      assert.ok(server.state.metrics.requestDurationMsTotal >= baselineRequestDurationMs);
    }, {
      reasoningTokens: 12,
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

test('idle metrics formatter emits ANSI colors when enabled on a TTY', () => {
  const message = buildIdleMetricsLogMessage({
    inputCharactersTotal: 200,
    outputCharactersTotal: 80,
    inputTokensTotal: 100,
    outputTokensTotal: 25,
    requestDurationMsTotal: 800,
    completedRequestCount: 1,
  }, {
    isTTY: true,
    env: {},
  });

  assert.match(message, /\u001b\[36minput\u001b\[0m/u);
  assert.match(message, /\u001b\[32moutput\u001b\[0m/u);
  assert.match(message, /\u001b\[33msaved\u001b\[0m/u);
  assert.match(message, /\u001b\[34mtiming\u001b\[0m/u);
});

test('idle metrics formatter disables ANSI colors when NO_COLOR is set', () => {
  const message = buildIdleMetricsLogMessage({
    inputCharactersTotal: 200,
    outputCharactersTotal: 80,
    inputTokensTotal: 100,
    outputTokensTotal: 25,
    requestDurationMsTotal: 800,
    completedRequestCount: 1,
  }, {
    isTTY: true,
    env: { NO_COLOR: '1' },
  });

  assert.doesNotMatch(message, /\u001b\[/u);
  assert.match(message, /  input:  chars=200 tokens=100/u);
});

test('idle metrics formatter disables ANSI colors when stdout is not a TTY', () => {
  const message = buildIdleMetricsLogMessage({
    inputCharactersTotal: 200,
    outputCharactersTotal: 80,
    inputTokensTotal: 100,
    outputTokensTotal: 25,
    requestDurationMsTotal: 800,
    completedRequestCount: 1,
  }, {
    isTTY: false,
    env: {},
  });

  assert.doesNotMatch(message, /\u001b\[/u);
  assert.match(message, /  output: chars=80 tokens=25 avg_tokens_per_request=25\.00/u);
  assert.match(message, /  timing: total=0s avg_request=0\.80s gen_tokens_per_s=31\.25/u);
});

test('idle metrics formatter reports n/a averages when no requests completed', () => {
  const message = buildIdleMetricsLogMessage({
    inputCharactersTotal: 0,
    outputCharactersTotal: 0,
    inputTokensTotal: 0,
    outputTokensTotal: 0,
    requestDurationMsTotal: 0,
    completedRequestCount: 0,
  }, {
    isTTY: false,
    env: {},
  });

  assert.equal(message, [
    'requests=0',
    '  input:  chars=0 tokens=0',
    '  output: chars=0 tokens=0 avg_tokens_per_request=n/a',
    '  saved:  tokens=0 pct=n/a ratio=n/a',
    '  timing: total=0s avg_request=n/a gen_tokens_per_s=n/a',
  ].join('\n'));
});

test('idle metrics formatter groups large values, formats days in elapsed durations, and includes budget details when present', () => {
  const message = buildIdleMetricsLogMessage({
    inputCharactersTotal: 1_868_795,
    outputCharactersTotal: 81_979,
    inputTokensTotal: 1_380_110,
    outputTokensTotal: 83_526,
    requestDurationMsTotal: 30 * 3_600_000 + 3 * 60_000 + 53_000,
    completedRequestCount: 279,
    inputCharactersPerContextToken: 4.15,
    chunkThresholdCharacters: 763_603,
  }, {
    isTTY: false,
    env: {},
  });

  assert.equal(message, [
    'requests=279',
    '  input:  chars=1,868,795 tokens=1,380,110',
    '  output: chars=81,979 tokens=83,526 avg_tokens_per_request=299.38',
    '  saved:  tokens=1,296,584 pct=93.95% ratio=16.52x',
    '  budget: chars_per_token=4.150 chunk_threshold_chars=763,603',
    '  timing: total=1:06:03:53 avg_request=387.93s gen_tokens_per_s=0.77',
  ].join('\n'));
});

test('request status log groups large running counts and uses colon elapsed durations', () => {
  assert.equal(formatElapsed(999), '0s');
  assert.equal(formatElapsed(12_000), '12s');
  assert.equal(formatElapsed(187_000), '3:07');
  assert.equal(formatElapsed(7_449_000), '2:04:09');
  assert.equal(formatElapsed(97_200_000), '1:03:00:00');
  assert.equal(
    buildStatusRequestLogMessage({
      running: true,
      rawInputCharacterCount: 101_891,
      chunkInputCharacterCount: 101_891,
      promptCharacterCount: 102_584,
      promptTokenCount: 55_271,
      budgetSource: 'ObservedCharsPerToken',
      inputCharactersPerContextToken: 1.856,
      chunkThresholdCharacters: 237_565,
    }),
    'request true raw_chars=101,891 prompt=102,584 (55,271)',
  );
  assert.equal(
    buildStatusRequestLogMessage({
      running: true,
      rawInputCharacterCount: 37_947_467,
      chunkInputCharacterCount: 558_055,
      promptCharacterCount: 560_315,
      promptTokenCount: 135_016,
      budgetSource: 'ObservedCharsPerToken',
      inputCharactersPerContextToken: 4.15,
      chunkThresholdCharacters: 763_603,
      chunkIndex: 1,
      chunkTotal: 2,
      chunkPath: '1/50 -> 1/2',
    }),
    'request true raw_chars=37,947,467 prompt=560,315 (135,016) chunk 1/50 -> 1/2',
  );
  assert.equal(
    buildStatusRequestLogMessage({
      running: true,
      rawInputCharacterCount: 300,
      promptCharacterCount: 420,
    }),
    'request true raw_chars=300 prompt=420',
  );
  assert.equal(
    buildStatusRequestLogMessage({ running: false, elapsedMs: 12_000, outputTokens: 7 }),
    'request false elapsed=12s output_tokens=7',
  );
  assert.equal(
    buildStatusRequestLogMessage({ running: false, totalElapsedMs: 187_000, totalOutputTokens: 19 }),
    'request false total_elapsed=3:07 output_tokens=19',
  );
  assert.equal(
    buildStatusRequestLogMessage({
      running: false,
      terminalState: 'failed',
      rawInputCharacterCount: 3_322_607,
      promptCharacterCount: 342_395,
      promptTokenCount: 147_694,
      chunkPath: '1/10',
      elapsedMs: 91_000,
      errorMessage: 'Provider returned an invalid SiftKit decision payload: Unexpected token',
    }),
    'request false raw_chars=3,322,607 prompt=342,395 (147,694) chunk 1/10 failed elapsed=1:31 error=Provider returned an invalid SiftKit decision payload: Unexpected token',
  );
});

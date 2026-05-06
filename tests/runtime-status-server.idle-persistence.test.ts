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
const { writeConfig } = require('../dist/status-server/config-store.js');
const { readStatusText } = require('../dist/status-server/status-file.js');
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
  postCompletedStatus,
} = require('./_runtime-helpers.js');


test('real status server appends one sqlite snapshot for each emitted idle summary', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const idleSummaryDbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
    const firstRequestId = 'idle-persistence-first';
    const secondRequestId = 'idle-persistence-second';
    const server = await startStatusServerProcess({
      statusPath,
      configPath,
      idleSummaryDelayMs: 60,
      terminalMetadataIdleDelayMs: 0,
      disableManagedLlamaStartup: true,
    });

    try {
      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: true, requestId: firstRequestId, rawInputCharacterCount: 200 }),
      });
      await postCompletedStatus(server.statusUrl, {
        requestId: firstRequestId,
        taskKind: 'summary',
        terminalState: 'completed',
        promptCharacterCount: 200,
        inputTokens: 100,
        outputCharacterCount: 80,
        outputTokens: 25,
        requestDurationMs: 800,
      });
      await server.waitForStdoutMatch(/requests=1/u, 1000);

      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: true, requestId: secondRequestId, rawInputCharacterCount: 50 }),
      });
      await postCompletedStatus(server.statusUrl, {
        requestId: secondRequestId,
        taskKind: 'summary',
        terminalState: 'completed',
        promptCharacterCount: 50,
        inputTokens: 20,
        outputCharacterCount: 30,
        outputTokens: 10,
        thinkingTokens: 7,
        requestDurationMs: 200,
      });
      await server.waitForStdoutMatch(/requests=2/u, 1000);

      const rows = readIdleSummarySnapshots(idleSummaryDbPath);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].completed_request_count, 1);
      assert.equal(rows[1].completed_request_count, 2);
      assert.equal(rows[1].input_characters_total, 250);
      assert.equal(rows[1].input_tokens_total, 120);
      assert.equal(rows[1].output_tokens_total, 35);
      assert.equal(rows[1].thinking_tokens_total, 7);
      assert.equal(rows[1].saved_tokens, 85);
      assert.equal(rows[1].request_duration_ms_total, 1000);
      assert.equal(rows[1].avg_request_ms, 500);
      assert.equal(rows[1].avg_tokens_per_second, 35);
    } finally {
      await server.close();
    }
  });
});

test('real status server keeps emitting idle summaries when sqlite persistence fails', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, 'status', 'inference.txt');
    const configPath = path.join(tempRoot, 'config.json');
    const idleSummaryDbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
    const requestId = 'idle-persistence-failure';
    const server = await startStatusServerProcess({
      statusPath,
      configPath,
      idleSummaryDelayMs: 80,
      terminalMetadataIdleDelayMs: 0,
      disableManagedLlamaStartup: true,
    });

    try {
      const database = new Database(idleSummaryDbPath);
      try {
        database.exec('DROP TABLE IF EXISTS idle_summary_snapshots;');
        database.exec(`
          CREATE TABLE idle_summary_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            impossible INTEGER NOT NULL
          );
        `);
      } finally {
        database.close();
      }

      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({ running: true, requestId, rawInputCharacterCount: 200 }),
      });
      await postCompletedStatus(server.statusUrl, {
        requestId,
        taskKind: 'summary',
        terminalState: 'completed',
        promptCharacterCount: 200,
        inputTokens: 100,
        outputCharacterCount: 80,
        outputTokens: 25,
        requestDurationMs: 800,
      });

      await server.waitForStdoutMatch(/requests=1/u, 1000);
      assert.equal(server.stderrLines.some((line) => /Failed to persist idle summary snapshot/u.test(line)), true);
    } finally {
      await server.close();
    }
  });
});


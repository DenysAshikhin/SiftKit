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

test('concurrent oversized CLI summary requests are serialized until the first request fully completes', async () => {
  await withTempEnv(async (tempRoot) => {
    await withSummaryTestServer(async () => {
      process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR = 'recursive-merge';
      process.env.SIFTKIT_TEST_PROVIDER_SLEEP_MS = '100';
      const logPath = path.join(tempRoot, 'provider-events-concurrent.jsonl');
      process.env.SIFTKIT_TEST_PROVIDER_LOG_PATH = logPath;

      const firstInputPath = path.join(tempRoot, 'oversized-a.txt');
      const secondInputPath = path.join(tempRoot, 'oversized-b.txt');
      fs.writeFileSync(firstInputPath, 'A'.repeat(300_001), 'utf8');
      fs.writeFileSync(secondInputPath, 'B'.repeat(300_001), 'utf8');

      const cliPath = path.join(process.cwd(), 'bin', 'siftkit.js');
      const childEnv = {
        ...process.env,
        SIFTKIT_TEST_PROVIDER: 'mock',
        SIFTKIT_TEST_PROVIDER_BEHAVIOR: 'recursive-merge',
        SIFTKIT_TEST_PROVIDER_SLEEP_MS: '100',
        SIFTKIT_TEST_PROVIDER_LOG_PATH: logPath,
      };

      const [firstResult, secondResult] = await Promise.all([
        spawnProcess(process.execPath, [
          cliPath,
          'summary',
          '--question',
          'summarize oversized request A',
          '--file',
          firstInputPath,
          '--backend',
          'mock',
          '--model',
          'mock-model',
        ], {
          cwd: process.cwd(),
          env: childEnv,
        }),
        spawnProcess(process.execPath, [
          cliPath,
          'summary',
          '--question',
          'summarize oversized request B',
          '--file',
          secondInputPath,
          '--backend',
          'mock',
          '--model',
          'mock-model',
        ], {
          cwd: process.cwd(),
          env: childEnv,
        }),
      ]);

      const events = fs.readFileSync(logPath, 'utf8')
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line));
      const questions = events.map((event) => event.question);
      const firstQuestion = 'summarize oversized request A';
      const secondQuestion = 'summarize oversized request B';
      const referencesFirstRequest = (question) => String(question).includes(firstQuestion);
      const referencesSecondRequest = (question) => String(question).includes(secondQuestion);
      const firstSecondIndex = questions.indexOf(secondQuestion);

      assert.equal(firstResult.code, 0);
      assert.equal(secondResult.code, 0);
      assert.match(firstResult.stdout, /merge summary/u);
      assert.match(secondResult.stdout, /merge summary/u);
      assert.equal(firstResult.stderr, '');
      assert.equal(secondResult.stderr, '');
      assert.ok(firstSecondIndex > 0);
      assert.equal(questions.slice(0, firstSecondIndex).some(referencesSecondRequest), false);
      assert.equal(questions.slice(firstSecondIndex).some(referencesFirstRequest), false);
      assert.ok(questions.slice(0, firstSecondIndex).every(referencesFirstRequest));
      assert.ok(questions.slice(firstSecondIndex).every(referencesSecondRequest));
    }, {
      running: false,
    });
  });
});

test('CLI summary fails closed with the canonical message when the external server is unreachable', async () => {
  await withTempEnv(async () => {
    const port = '4778';
    const expectedMessage = `SiftKit status/config server is not reachable at http://127.0.0.1:${port}/health. Start the separate server process and stop issuing further siftkit commands until it is available.`;
    const result = spawnSync(
      process.execPath,
      [path.join(process.cwd(), 'bin', 'siftkit.js'), 'summary', '--question', 'summarize this', '--text', 'hello world'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          SIFTKIT_STATUS_BACKEND_URL: `http://127.0.0.1:${port}/status`,
          SIFTKIT_CONFIG_SERVICE_URL: `http://127.0.0.1:${port}/config`,
          SIFTKIT_STATUS_PORT: port,
        },
      }
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(expectedMessage.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  });
});

test('CLI summary preflight tolerates transient health failures', async () => {
  await withTempEnv(async () => {
    await withSummaryTestServer(async (server) => {
      const result = await spawnProcess(
        process.execPath,
        [path.join(process.cwd(), 'bin', 'siftkit.js'), 'summary', '--question', 'summarize this', '--text', 'hello world'],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            SIFTKIT_HEALTHCHECK_ATTEMPTS: '5',
            SIFTKIT_HEALTHCHECK_TIMEOUT_MS: '100',
            SIFTKIT_HEALTHCHECK_BACKOFF_MS: '1',
          },
        },
      );
      assert.equal(result.code, 0);
      assert.doesNotMatch(result.stderr, /status\/config server is not reachable/iu);
      assert.match(result.stdout, /summary:/u);
      assert.ok(Number(server?.state?.healthChecks || 0) >= 3);
    }, {
      healthFailuresBeforeOk: 2,
    });
  });
});

test('local-only find-files CLI works without the external server', async () => {
  await withTempEnv(async (tempRoot) => {
    const port = '4777';
    const findRoot = path.join(tempRoot, 'find-fixtures');
    fs.mkdirSync(findRoot, { recursive: true });
    fs.writeFileSync(path.join(findRoot, 'package.json'), '{"name":"fixture"}', 'utf8');
    const result = spawnSync(
      process.execPath,
      [path.join(process.cwd(), 'bin', 'siftkit.js'), 'find-files', '--path', findRoot, 'package.json'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          SIFTKIT_STATUS_BACKEND_URL: `http://127.0.0.1:${port}/status`,
          SIFTKIT_CONFIG_SERVICE_URL: `http://127.0.0.1:${port}/config`,
          SIFTKIT_STATUS_PORT: port,
        },
      }
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /package\.json/u);
  });
});

test('unsupported input returns the exact terminal message', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const result = await summarizeRequest({
        question: 'Summarize this unsupported input.',
        inputText: 'unsupported fixture marker',
        format: 'text',
        policyProfile: 'general',
        backend: 'mock',
        model: 'mock-model',
      });

      assert.equal(result.WasSummarized, false);
      assert.equal(result.PolicyDecision, 'model-unsupported-input');
      assert.equal(result.Classification, 'unsupported_input');
      assert.equal(result.RawReviewRequired, false);
      assert.equal(result.Summary, UNSUPPORTED_INPUT_MESSAGE);
    });
  });
});


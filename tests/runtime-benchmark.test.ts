// @ts-nocheck — Split from runtime.test.js. Full TS typing deferred.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const { loadConfig, getConfigPath, getExecutionServerState, getChunkThresholdCharacters, getConfiguredLlamaNumCtx, getEffectiveInputCharactersPerContextToken, initializeRuntime, getStatusServerUnavailableMessage } = require('../dist/config/index.js');
const { summarizeRequest, buildPrompt, getSummaryDecision, planTokenAwareLlamaCppChunks, getPlannerPromptBudget, buildPlannerToolDefinitions, UNSUPPORTED_INPUT_MESSAGE } = require('../dist/summary.js');
const { runCommand } = require('../dist/command.js');
const { runBenchmarkSuite } = require('../dist/benchmark/index.js');
const { withExecutionLock } = require('../dist/execution-lock.js');
const { buildIdleMetricsLogMessage, buildStatusRequestLogMessage, formatElapsed, getIdleSummarySnapshotsPath, startStatusServer } = require('../dist/status-server/index.js');
const { runDebugRequest } = require('../dist/scripts/run-benchmark-fixture-debug.js');

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

test('benchmark runner writes prompt, output, classification metadata, per-case duration, and total duration', async () => {
  await withTempEnv(async (tempRoot) => {
    await withStubServer(async () => {
      const fixtureRoot = path.join(tempRoot, 'bench-fixtures');
      const outputPath = path.join(tempRoot, 'bench-output.json');
      fs.mkdirSync(fixtureRoot, { recursive: true });
      fs.writeFileSync(path.join(fixtureRoot, 'case1.txt'), 'A'.repeat(600), 'utf8');
      fs.writeFileSync(path.join(fixtureRoot, 'case2.txt'), 'short text that should stay raw', 'utf8');
      fs.writeFileSync(path.join(fixtureRoot, 'fixtures.json'), JSON.stringify([
        {
          Name: 'summarized-case',
          File: 'case1.txt',
          Question: 'summarize this',
          Format: 'text',
          PolicyProfile: 'general',
          SourceCommand: 'Get-Content case1.txt | siftkit "summarize this"',
        },
        {
          Name: 'raw-case',
          File: 'case2.txt',
          Question: 'summarize this',
          Format: 'text',
          PolicyProfile: 'general',
        },
      ], null, 2), 'utf8');

      const result = await runBenchmarkSuite({
        fixtureRoot,
        outputPath,
        backend: 'mock',
        model: 'mock-model',
      });
      const artifact = JSON.parse(fs.readFileSync(outputPath, 'utf8'));

      assert.equal(result.OutputPath, outputPath);
      assert.equal(result.Status, 'completed');
      assert.equal(result.CompletedFixtureCount, 2);
      assert.equal(result.FatalError, null);
      assert.equal(result.PromptPrefix, null);
      assert.equal(fs.existsSync(outputPath), true);
      assert.equal(artifact.Status, 'completed');
      assert.equal(artifact.CompletedFixtureCount, 2);
      assert.equal(artifact.FatalError, null);
      assert.equal(typeof artifact.TotalDurationMs, 'number');
      assert.ok(artifact.TotalDurationMs >= 0);
      assert.equal(Array.isArray(artifact.Results), true);
      assert.equal(artifact.Results.length, 2);
      assert.equal(typeof artifact.Results[0].DurationMs, 'number');
      assert.ok(artifact.Results[0].DurationMs >= 0);
      assert.equal(artifact.Results[0].Prompt, 'Get-Content case1.txt | siftkit "summarize this"');
      assert.match(artifact.Results[0].Output, /mock summary/u);
      assert.equal(artifact.Results[0].PolicyDecision, 'model-summary');
      assert.equal(artifact.Results[0].Classification, 'summary');
      assert.equal(artifact.Results[0].ModelCallSucceeded, true);
      assert.equal(artifact.Results[0].Error, null);
      assert.equal(artifact.Results[0].Name, undefined);
      assert.equal(artifact.Results[0].SourcePath, undefined);
      assert.match(artifact.Results[1].Prompt, /You are SiftKit/u);
      assert.match(artifact.Results[1].Output, /mock summary/u);
      assert.equal(artifact.Results[1].PolicyDecision, 'model-summary');
      assert.equal(artifact.Results[1].Classification, 'summary');
    });
  });
});

test('benchmark runner times out fatally and writes a partial artifact', async () => {
  await withTempEnv(async (tempRoot) => {
    await withStubServer(async (server) => {
      const fixtureRoot = path.join(tempRoot, 'bench-fixtures');
      const outputPath = path.join(tempRoot, 'bench-output.json');
      fs.mkdirSync(fixtureRoot, { recursive: true });
      fs.writeFileSync(path.join(fixtureRoot, 'case1.txt'), 'A'.repeat(600), 'utf8');
      fs.writeFileSync(path.join(fixtureRoot, 'fixtures.json'), JSON.stringify([
        {
          Name: 'timeout-case',
          File: 'case1.txt',
          Question: 'summarize this',
          Format: 'text',
          PolicyProfile: 'general',
        },
      ], null, 2), 'utf8');

      process.env.SIFTKIT_TEST_PROVIDER_SLEEP_MS = '200';
      await assert.rejects(
        () => runBenchmarkSuite({
          fixtureRoot,
          outputPath,
          backend: 'mock',
          model: 'mock-model',
          requestTimeoutSeconds: 0.01,
        }),
        /timed out after 0\.01 seconds/u,
      );

      const artifact = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      assert.equal(artifact.Status, 'failed');
      assert.equal(artifact.CompletedFixtureCount, 0);
      assert.equal(artifact.Results.length, 0);
      assert.match(artifact.FatalError, /timeout-case/u);

      await waitForAsyncExpectation(async () => {
        assert.equal(
          server.state.artifactPosts.some((artifactPost) => artifactPost.type === 'summary_request'),
          true,
        );
      }, 1000);
    });
  });
});

test('benchmark runner uses a 30 minute default request timeout when omitted', async () => {
  await withTempEnv(async (tempRoot) => {
    await withStubServer(async () => {
      const fixtureRoot = path.join(tempRoot, 'bench-fixtures');
      const outputPath = path.join(tempRoot, 'bench-output.json');
      const observedTimeouts = [];
      const originalSetTimeout = global.setTimeout;
      fs.mkdirSync(fixtureRoot, { recursive: true });
      fs.writeFileSync(path.join(fixtureRoot, 'case1.txt'), 'A'.repeat(600), 'utf8');
      fs.writeFileSync(path.join(fixtureRoot, 'fixtures.json'), JSON.stringify([
        {
          Name: 'default-timeout-case',
          File: 'case1.txt',
          Question: 'summarize this',
          Format: 'text',
          PolicyProfile: 'general',
        },
      ], null, 2), 'utf8');

      global.setTimeout = (...args) => {
        observedTimeouts.push(args[1]);
        return originalSetTimeout(...args);
      };

      try {
        const result = await runBenchmarkSuite({
          fixtureRoot,
          outputPath,
          backend: 'mock',
          model: 'mock-model',
        });

        assert.equal(result.Status, 'completed');
      } finally {
        global.setTimeout = originalSetTimeout;
      }

      assert.ok(observedTimeouts.includes(1_800_000), `Expected a 30 minute timeout, observed: ${observedTimeouts.join(', ')}`);
    });
  });
});

test('benchmark runner fails fast on provider errors and writes the fatal error text', async () => {
  await withTempEnv(async (tempRoot) => {
    await withStubServer(async () => {
      const fixtureRoot = path.join(tempRoot, 'bench-fixtures');
      const outputPath = path.join(tempRoot, 'bench-output.json');
      fs.mkdirSync(fixtureRoot, { recursive: true });
      fs.writeFileSync(path.join(fixtureRoot, 'case1.txt'), 'A'.repeat(600), 'utf8');
      fs.writeFileSync(path.join(fixtureRoot, 'fixtures.json'), JSON.stringify([
        {
          Name: 'provider-error-case',
          File: 'case1.txt',
          Question: 'summarize this',
          Format: 'text',
          PolicyProfile: 'general',
        },
      ], null, 2), 'utf8');

      process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR = 'throw';
      await assert.rejects(
        () => runBenchmarkSuite({
          fixtureRoot,
          outputPath,
          backend: 'mock',
          model: 'mock-model',
        }),
        /Benchmark fixture 'provider-error-case' failed: mock provider failure/u,
      );

      const artifact = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      assert.equal(artifact.Status, 'failed');
      assert.equal(artifact.CompletedFixtureCount, 0);
      assert.equal(artifact.Results.length, 0);
      assert.match(artifact.FatalError, /mock provider failure/u);
    });
  });
});

test('run-benchmark-fixture-debug writes an artifact for fixture mode', async () => {
  await withTempEnv(async (tempRoot) => {
    const longSummary = `fixture-debug-full-summary:${'X'.repeat(1300)}:END`;
    await withStubServer(async () => {
      const fixtureRoot = path.join(tempRoot, 'bench-fixtures');
      const outputRoot = path.join(tempRoot, 'fixture-debug-output');
      fs.mkdirSync(fixtureRoot, { recursive: true });
      fs.writeFileSync(path.join(fixtureRoot, 'case1.txt'), 'A'.repeat(600), 'utf8');
      fs.writeFileSync(path.join(fixtureRoot, 'fixtures.json'), JSON.stringify([
        {
          Name: 'fixture-debug-case',
          File: 'case1.txt',
          Question: 'summarize this',
          Format: 'text',
          PolicyProfile: 'general',
        },
      ], null, 2), 'utf8');

      let stdoutText = '';
      let stderrText = '';
      const result = await runDebugRequest([
        '--fixture-root', fixtureRoot,
        '--fixture-index', '1',
        '--output-root', outputRoot,
      ], {
        stdout: { write: (text) => { stdoutText += String(text); return true; } },
        stderr: { write: (text) => { stderrText += String(text); return true; } },
      });

      assert.equal(result.exitCode, 0);
      const artifact = JSON.parse(fs.readFileSync(path.join(outputRoot, 'result.json'), 'utf8'));
      assert.equal(artifact.ok, true);
      assert.equal(typeof artifact.requestId, 'string');
      assert.equal(artifact.classification, 'summary');
      assert.equal(artifact.summary, longSummary);
      assert.equal(artifact.summaryPreview, longSummary.slice(0, 1000));
      assert.equal(fs.readFileSync(path.join(outputRoot, 'summary.txt'), 'utf8'), longSummary);
      assert.match(stdoutText, /Request id:/u);
      assert.match(stdoutText, /Summary path:/u);
      assert.match(stdoutText, /:END/u);
      assert.match(stderrText, /siftkit-trace/u);
    }, {
      assistantContent() {
        return JSON.stringify({
          classification: 'summary',
          raw_review_required: false,
          output: longSummary,
        });
      },
    });
  });
});

test('run-benchmark-fixture-debug supports direct file mode', async () => {
  await withTempEnv(async (tempRoot) => {
    await withStubServer(async () => {
      const inputPath = path.join(tempRoot, 'input.txt');
      const outputRoot = path.join(tempRoot, 'file-debug-output');
      fs.writeFileSync(inputPath, 'A'.repeat(600), 'utf8');

      const result = await runDebugRequest([
        '--file', inputPath,
        '--question', 'summarize this',
        '--format', 'text',
        '--policy-profile', 'general',
        '--output-root', outputRoot,
      ]);

      assert.equal(result.exitCode, 0);
      const artifact = JSON.parse(fs.readFileSync(path.join(outputRoot, 'result.json'), 'utf8'));
      assert.equal(artifact.ok, true);
      assert.equal(artifact.sourcePath, inputPath);
      assert.equal(artifact.classification, 'summary');
    });
  });
});

test('run-benchmark-fixture-debug writes failure artifacts and exits nonzero on summarize errors', async () => {
  await withTempEnv(async (tempRoot) => {
    await withStubServer(async () => {
      const inputPath = path.join(tempRoot, 'input.txt');
      const outputRoot = path.join(tempRoot, 'file-debug-failure-output');
      fs.writeFileSync(inputPath, 'A'.repeat(600), 'utf8');

      let stderrText = '';
      const result = await runDebugRequest([
        '--file', inputPath,
        '--question', 'summarize this',
        '--format', 'text',
        '--policy-profile', 'general',
        '--output-root', outputRoot,
      ], {
        stderr: { write: (text) => { stderrText += String(text); return true; } },
      });

      assert.equal(result.exitCode, 1);
      const artifact = JSON.parse(fs.readFileSync(path.join(outputRoot, 'result.json'), 'utf8'));
      assert.equal(artifact.ok, false);
      assert.match(artifact.error, /Provider returned an invalid SiftKit decision payload/u);
      assert.match(stderrText, /Provider returned an invalid SiftKit decision payload/u);
    }, {
      assistantContent: 'not valid json',
    });
  });
});

test('benchmark runner records a custom prompt prefix from file', async () => {
  await withTempEnv(async (tempRoot) => {
    await withStubServer(async () => {
      const fixtureRoot = path.join(tempRoot, 'bench-fixtures');
      const outputPath = path.join(tempRoot, 'bench-output.json');
      const promptPrefixPath = path.join(tempRoot, 'prompt-prefix.txt');
      fs.mkdirSync(fixtureRoot, { recursive: true });
      fs.writeFileSync(path.join(fixtureRoot, 'case1.txt'), 'A'.repeat(600), 'utf8');
      fs.writeFileSync(path.join(fixtureRoot, 'fixtures.json'), JSON.stringify([
        {
          Name: 'summarized-case',
          File: 'case1.txt',
          Question: 'summarize this',
          Format: 'text',
          PolicyProfile: 'general',
        },
      ], null, 2), 'utf8');
      fs.writeFileSync(promptPrefixPath, 'Always answer in terse benchmark mode.', 'utf8');

      const result = await runBenchmarkSuite({
        fixtureRoot,
        outputPath,
        backend: 'mock',
        model: 'mock-model',
        promptPrefixFile: promptPrefixPath,
      });

      assert.equal(result.PromptPrefix, 'Always answer in terse benchmark mode.');
    });
  });
});

// eval/fixtures/ai_core_60_tests is gitignored benchmark data, absent on a
// fresh clone. Skip rather than fail when it is not present locally.
const aiCoreRawFixturesPresent = fs.existsSync(
  path.resolve(__dirname, '..', 'eval', 'fixtures', 'ai_core_60_tests', 'raw'),
);
test('benchmark error-log fixtures now reach the model-first summary path', {
  skip: aiCoreRawFixturesPresent ? false : 'eval/fixtures/ai_core_60_tests is gitignored and not present locally',
}, async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });
      const maxChars = getChunkThresholdCharacters(config) * 4;
      const fixtureRoot = path.resolve(__dirname, '..', 'eval', 'fixtures', 'ai_core_60_tests', 'raw');
      const cases = [
        {
          file: '17_autorun_error_log.txt',
          question: 'Summarize whether this log contains script errors, crashes, or actionable failures. Quote exact error types, file paths, and line numbers if present.',
          pattern: /run is not clean|script errors/i,
        },
        {
          file: '18_autorun_output_log.txt',
          question: 'Summarize what happened during this run, including startup markers, warnings, and any pass/fail indicators.',
          pattern: /failed autonomous-mode validation|stay threshold/i,
        },
        {
          file: '19_script_error_and_crash_marker_scan.txt',
          question: 'Summarize any crash, popup, assertion, or script-error markers found in these logs, grouped by file.',
          pattern: /run is not clean|script errors/i,
        },
        {
          file: '20_specific_historical_failure_log.txt',
          question: 'Summarize the failure in this log. Identify the exact script error, whether the run still reached its completion marker, and any likely implication for shutdown integrity.',
          pattern: /passed numerically but is still not clean|shutdown integrity/i,
        },
        {
          file: '30_explicit_test_result_markers.txt',
          question: 'Summarize any explicit pass/fail test result markers in these logs. Name the files and whether they show passing or failing suites.',
          pattern: /pass markers alone do not prove|numeric pass markers/i,
        },
        {
          file: '50_main_game_smoke_stderr_log.txt',
          question: 'Summarize the main failure in this stderr log and whether it indicates startup/runtime failure or shutdown-only noise.',
          pattern: /failing during script compilation|parse errors/i,
        },
      ];

      for (const fixture of cases) {
        const inputText = fs.readFileSync(path.join(fixtureRoot, fixture.file), 'utf8');
        const normalizedInputLength = inputText.replace(/[\r\n]+$/u, '').length;
        if (inputText.length > maxChars) {
          await assert.rejects(
            () => summarizeRequest({
              question: fixture.question,
              inputText,
              format: 'text',
              policyProfile: 'general',
              backend: 'mock',
              model: 'mock-model',
              sourceKind: 'standalone',
            }),
            new RegExp(`Error: recieved input of ${normalizedInputLength} characters, current maximum is \\d+ chars`, 'u'),
            fixture.file,
          );
          continue;
        }

        const result = await summarizeRequest({
          question: fixture.question,
          inputText,
          format: 'text',
          policyProfile: 'general',
          backend: 'mock',
          model: 'mock-model',
          sourceKind: 'standalone',
        });

        assert.equal(result.ModelCallSucceeded, true, fixture.file);
        assert.equal(result.PolicyDecision, 'model-summary', fixture.file);
        assert.equal(result.Classification, 'summary', fixture.file);
        assert.equal(result.RawReviewRequired, true, fixture.file);
        assert.equal(result.WasSummarized, true, fixture.file);
        assert.match(result.Summary, fixture.pattern, fixture.file);
      }
    });
  });
});


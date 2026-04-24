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
    await withStubServer(async () => {
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

test('repro-fixture60-malformed-json writes chunk artifacts and stops on malformed chunk payload', async () => {
  await withTempEnv(async (tempRoot) => {
    let chunkResponseCount = 0;
    await withStubServer(async () => {
      const fixtureRoot = path.join(tempRoot, 'bench-fixtures');
      const outputRoot = path.join(tempRoot, 'fixture60-repro-output');
      fs.mkdirSync(fixtureRoot, { recursive: true });
      fs.writeFileSync(path.join(fixtureRoot, 'case1.txt'), 'A'.repeat(11_000), 'utf8');
      fs.writeFileSync(path.join(fixtureRoot, 'fixtures.json'), JSON.stringify([
        {
          Name: 'fixture60-repro-case',
          File: 'case1.txt',
          Question: 'summarize this',
          Format: 'text',
          PolicyProfile: 'general',
        },
      ], null, 2), 'utf8');

      const config = await loadConfig({ ensure: true });
      config.Backend = 'llama.cpp';
      config.LlamaCpp.NumCtx = 12_000;
      config.Runtime ??= {};
      config.Runtime.LlamaCpp = {
        ...(config.Runtime.LlamaCpp || {}),
        NumCtx: 12_000,
      };
      config.Server ??= {};
      config.Server.LlamaCpp ??= {};
      config.Server.LlamaCpp.NumCtx = 12_000;
      config.Server.LlamaCpp.ActivePresetId = 'default';
      config.Server.LlamaCpp.Presets = [{ id: 'default', label: 'Default', NumCtx: 12_000 }];
      await saveConfig(config);

      let stderrText = '';
      const result = await runFixture60MalformedJsonRepro([
        '--fixture-index', '1',
        '--output-root', outputRoot,
      ], {
        fixtureRoot,
        stderr: { write: (text) => { stderrText += String(text); return true; } },
      });

      assert.equal(result.exitCode, 1);
      const artifact = JSON.parse(fs.readFileSync(path.join(outputRoot, 'manifest.json'), 'utf8'));
      assert.equal(artifact.ok, false);
      assert.equal(artifact.chunkCount > 1, true);
      assert.equal(artifact.malformedChunk.chunkPath, '2/3');
      assert.match(artifact.malformedChunk.error, /Provider returned an invalid SiftKit decision payload/u);
      assert.match(stderrText, /Provider returned an invalid SiftKit decision payload/u);

      const firstChunkPrompt = fs.readFileSync(
        path.join(outputRoot, 'fixtures', 'fixture-01', 'chunks', 'chunk-01', 'prompt.txt'),
        'utf8',
      );
      const secondChunkResponse = fs.readFileSync(
        path.join(outputRoot, 'fixtures', 'fixture-01', 'chunks', 'chunk-02', 'response.txt'),
        'utf8',
      );
      assert.match(firstChunkPrompt, /Chunk path: 1\/3/u);
      assert.equal(secondChunkResponse.endsWith('"output":"broken'), true);
      assert.equal(artifact.chunks.length, 2);
    }, {
      assistantContent(promptText) {
        if (!/<<<BEGIN_LITERAL_INPUT_SLICE>>>/u.test(promptText)) {
          return JSON.stringify({
            classification: 'summary',
            raw_review_required: false,
            output: 'merge summary',
          });
        }

        chunkResponseCount += 1;
        if (chunkResponseCount === 2) {
          return '{"classification":"summary","raw_review_required":false,"output":"broken';
        }

        return JSON.stringify({
          classification: 'summary',
          raw_review_required: false,
          output: `chunk ${chunkResponseCount} summary`,
        });
      },
    });
  });
});

test('repro-fixture60-malformed-json writes a completed manifest for valid chunk responses', async () => {
  await withTempEnv(async (tempRoot) => {
    let chunkResponseCount = 0;
    await withStubServer(async () => {
      const fixtureRoot = path.join(tempRoot, 'bench-fixtures');
      const outputRoot = path.join(tempRoot, 'fixture60-repro-success-output');
      fs.mkdirSync(fixtureRoot, { recursive: true });
      fs.writeFileSync(path.join(fixtureRoot, 'case1.txt'), 'A'.repeat(11_000), 'utf8');
      fs.writeFileSync(path.join(fixtureRoot, 'fixtures.json'), JSON.stringify([
        {
          Name: 'fixture60-repro-case',
          File: 'case1.txt',
          Question: 'summarize this',
          Format: 'text',
          PolicyProfile: 'general',
        },
      ], null, 2), 'utf8');

      const config = await loadConfig({ ensure: true });
      config.Backend = 'llama.cpp';
      config.LlamaCpp.NumCtx = 12_000;
      config.Runtime ??= {};
      config.Runtime.LlamaCpp = {
        ...(config.Runtime.LlamaCpp || {}),
        NumCtx: 12_000,
      };
      config.Server ??= {};
      config.Server.LlamaCpp ??= {};
      config.Server.LlamaCpp.NumCtx = 12_000;
      config.Server.LlamaCpp.ActivePresetId = 'default';
      config.Server.LlamaCpp.Presets = [{ id: 'default', label: 'Default', NumCtx: 12_000 }];
      await saveConfig(config);

      const result = await runFixture60MalformedJsonRepro([
        '--fixture-index', '1',
        '--output-root', outputRoot,
      ], {
        fixtureRoot,
      });

      assert.equal(result.exitCode, 0);
      const artifact = JSON.parse(fs.readFileSync(path.join(outputRoot, 'manifest.json'), 'utf8'));
      assert.equal(artifact.ok, true);
      assert.equal(artifact.malformedChunk, null);
      assert.equal(artifact.chunkCount, 3);
      assert.equal(artifact.chunks.length, 3);
      assert.equal(artifact.chunks.every((chunk) => chunk.parsed === true), true);
      assert.match(
        fs.readFileSync(path.join(outputRoot, 'fixtures', 'fixture-01', 'chunks', 'chunk-03', 'response.txt'), 'utf8'),
        /chunk 3 summary/u,
      );
    }, {
      assistantContent(promptText) {
        if (!/<<<BEGIN_LITERAL_INPUT_SLICE>>>/u.test(promptText)) {
          return JSON.stringify({
            classification: 'summary',
            raw_review_required: false,
            output: 'merge summary',
          });
        }

        chunkResponseCount += 1;
        return JSON.stringify({
          classification: 'summary',
          raw_review_required: false,
          output: `chunk ${chunkResponseCount} summary`,
        });
      },
    });
  });
});

test('repro-fixture60-malformed-json can run a fixture range and stop on a later malformed fixture', async () => {
  await withTempEnv(async (tempRoot) => {
    let fixture2ChunkResponses = 0;
    await withStubServer(async () => {
      const fixtureRoot = path.join(tempRoot, 'bench-fixtures');
      const outputRoot = path.join(tempRoot, 'fixture60-repro-range-output');
      fs.mkdirSync(fixtureRoot, { recursive: true });
      fs.writeFileSync(path.join(fixtureRoot, 'case1.txt'), 'A'.repeat(11_000), 'utf8');
      fs.writeFileSync(path.join(fixtureRoot, 'case2.txt'), 'B'.repeat(11_000), 'utf8');
      fs.writeFileSync(path.join(fixtureRoot, 'fixtures.json'), JSON.stringify([
        {
          Name: 'fixture-1',
          File: 'case1.txt',
          Question: 'fixture 1 question',
          Format: 'text',
          PolicyProfile: 'general',
        },
        {
          Name: 'fixture-2',
          File: 'case2.txt',
          Question: 'fixture 2 question',
          Format: 'text',
          PolicyProfile: 'general',
        },
      ], null, 2), 'utf8');

      const config = await loadConfig({ ensure: true });
      config.Backend = 'llama.cpp';
      config.LlamaCpp.NumCtx = 12_000;
      config.Runtime ??= {};
      config.Runtime.LlamaCpp = {
        ...(config.Runtime.LlamaCpp || {}),
        NumCtx: 12_000,
      };
      config.Server ??= {};
      config.Server.LlamaCpp ??= {};
      config.Server.LlamaCpp.NumCtx = 12_000;
      config.Server.LlamaCpp.ActivePresetId = 'default';
      config.Server.LlamaCpp.Presets = [{ id: 'default', label: 'Default', NumCtx: 12_000 }];
      await saveConfig(config);

      const result = await runFixture60MalformedJsonRepro([
        '--fixture-start-index', '1',
        '--fixture-end-index', '2',
        '--output-root', outputRoot,
      ], {
        fixtureRoot,
      });

      assert.equal(result.exitCode, 1);
      const artifact = JSON.parse(fs.readFileSync(path.join(outputRoot, 'manifest.json'), 'utf8'));
      assert.equal(artifact.fixtureCount, 2);
      assert.equal(artifact.malformedFixture.fixtureIndex, 2);
      assert.equal(artifact.fixtures.length, 2);
      assert.equal(artifact.fixtures[0].ok, true);
      assert.equal(artifact.fixtures[1].malformedChunk.chunkPath, '2/3');
      assert.match(
        fs.readFileSync(path.join(outputRoot, 'fixtures', 'fixture-01', 'chunks', 'chunk-03', 'response.txt'), 'utf8'),
        /fixture 1 chunk 3/u,
      );
    }, {
      assistantContent(promptText) {
        if (!/<<<BEGIN_LITERAL_INPUT_SLICE>>>/u.test(promptText)) {
          return JSON.stringify({
            classification: 'summary',
            raw_review_required: false,
            output: 'merge summary',
          });
        }

        if (/fixture 2 question/u.test(promptText)) {
          fixture2ChunkResponses += 1;
          if (fixture2ChunkResponses === 2) {
            return '{"classification":"summary","raw_review_required":false,"output":"broken';
          }

          return JSON.stringify({
            classification: 'summary',
            raw_review_required: false,
            output: `fixture 2 chunk ${fixture2ChunkResponses}`,
          });
        }

        const match = /Chunk path: (\d+\/\d+)/u.exec(promptText);
        return JSON.stringify({
          classification: 'summary',
          raw_review_required: false,
          output: `fixture 1 chunk ${match ? match[1].split('/')[0] : 'x'}`,
        });
      },
    });
  });
});

test('benchmark matrix respects per-run launcher overrides and script-owned reasoning', async () => {
  await withTempEnv(async (tempRoot) => {
    const fixtureRoot = path.join(tempRoot, 'bench-fixtures');
    const resultsRoot = path.join(tempRoot, 'bench-results');
    const scriptsRoot = path.join(tempRoot, 'scripts');
    const model9bPath = path.join(scriptsRoot, 'Qwen3.5-9B-Q8_0.gguf');
    const model35bPath = path.join(scriptsRoot, 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf');
    const start9bPath = path.join(scriptsRoot, 'Start-Qwen35-9B-Q8-200k.ps1');
    const start35bPath = path.join(scriptsRoot, 'Start-Qwen35-35B-4bit-150k.ps1');
    const promptPrefixPath = path.join(tempRoot, 'anchor_prompt_prefix.txt');
    const manifestPath = path.join(tempRoot, 'matrix.json');

    fs.mkdirSync(fixtureRoot, { recursive: true });
    fs.mkdirSync(scriptsRoot, { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, 'fixtures.json'), '[]', 'utf8');
    fs.writeFileSync(model9bPath, '', 'utf8');
    fs.writeFileSync(model35bPath, '', 'utf8');
    fs.writeFileSync(start9bPath, '', 'utf8');
    fs.writeFileSync(start35bPath, '', 'utf8');
    fs.writeFileSync(promptPrefixPath, 'Anchor prefix', 'utf8');
    fs.writeFileSync(manifestPath, JSON.stringify({
      fixtureRoot,
      configUrl: 'http://127.0.0.1:4765/config',
      promptPrefixFile: promptPrefixPath,
      requestTimeoutSeconds: 45,
      startScript: start9bPath,
      resultsRoot,
      baseline: {
        modelId: 'Qwen3.5-9B-Q8_0.gguf',
        modelPath: 'Qwen3.5-9B-Q8_0.gguf',
        contextSize: 200000,
        maxTokens: 15000,
        reasoning: 'off',
        passReasoningArg: false,
      },
      runs: [
        {
          index: 1,
          id: '9b-script-owned',
          label: '9b script-owned',
          enabled: true,
          modelId: 'Qwen3.5-9B-Q8_0.gguf',
          modelPath: 'Qwen3.5-9B-Q8_0.gguf',
          reasoning: 'off',
          sampling: {
            temperature: 0.7,
            topP: 0.8,
            topK: 20,
            minP: 0,
            presencePenalty: 1.5,
            repetitionPenalty: 1,
          },
        },
        {
          index: 2,
          id: '35b-script-owned',
          label: '35b script-owned',
          enabled: true,
          modelId: 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf',
          modelPath: 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf',
          startScript: start35bPath,
          contextSize: 150000,
          maxTokens: 9000,
          reasoning: 'on',
          passReasoningArg: false,
          sampling: {
            temperature: 0.7,
            topP: 0.95,
            topK: 20,
            minP: 0,
            presencePenalty: 1.5,
            repetitionPenalty: 1.06,
          },
        },
      ],
    }, null, 2), 'utf8');

    const manifest = readMatrixManifest({
      manifestPath,
      runIds: [],
      promptPrefixFile: null,
      validateOnly: false,
    });
    const [run9b, run35b] = manifest.selectedRuns;

    assert.equal(manifest.baseline.passReasoningArg, false);
    assert.equal(run9b.contextSize, 200000);
    assert.equal(run9b.maxTokens, 15000);
    assert.equal(run35b.contextSize, 150000);
    assert.equal(run35b.maxTokens, 9000);

    const launcherArgs = buildLauncherArgs(manifest, run35b);
    assert.equal(launcherArgs.includes('-Reasoning'), false);
    assert.deepEqual(launcherArgs.slice(-6), [
      '-ConfigUrl', manifest.configUrl,
      '-ModelPath', run35b.modelPath,
      '-ContextSize', '150000',
      '-MaxTokens', '9000',
    ].slice(-6));

    const benchmarkArgs = buildBenchmarkArgs(manifest, run35b, path.join(tempRoot, 'out.json'), promptPrefixPath);
    assert.equal(benchmarkArgs.includes('--prompt-prefix-file'), true);
    assert.equal(benchmarkArgs.includes('--request-timeout-seconds'), true);
    assert.equal(benchmarkArgs[benchmarkArgs.indexOf('--request-timeout-seconds') + 1], '45');
    assert.equal(benchmarkArgs.includes('--max-tokens'), true);
    assert.equal(benchmarkArgs[benchmarkArgs.indexOf('--max-tokens') + 1], '9000');
  });
});

test('benchmark matrix defaults request timeout to 30 minutes when omitted', async () => {
  await withTempEnv(async (tempRoot) => {
    const fixtureRoot = path.join(tempRoot, 'bench-fixtures');
    const resultsRoot = path.join(tempRoot, 'bench-results');
    const scriptsRoot = path.join(tempRoot, 'scripts');
    const modelPath = path.join(scriptsRoot, 'Qwen3.5-9B-Q8_0.gguf');
    const startScriptPath = path.join(scriptsRoot, 'Start-Qwen35-9B-Q8-200k.ps1');
    const manifestPath = path.join(tempRoot, 'matrix.json');

    fs.mkdirSync(fixtureRoot, { recursive: true });
    fs.mkdirSync(scriptsRoot, { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, 'fixtures.json'), '[]', 'utf8');
    fs.writeFileSync(modelPath, '', 'utf8');
    fs.writeFileSync(startScriptPath, '', 'utf8');
    fs.writeFileSync(manifestPath, JSON.stringify({
      fixtureRoot,
      configUrl: 'http://127.0.0.1:4765/config',
      startScript: startScriptPath,
      resultsRoot,
      baseline: {
        modelId: 'Qwen3.5-9B-Q8_0.gguf',
        modelPath: 'Qwen3.5-9B-Q8_0.gguf',
        contextSize: 200000,
        maxTokens: 15000,
        reasoning: 'off',
        passReasoningArg: false,
      },
      runs: [
        {
          index: 1,
          id: 'default-timeout-run',
          label: 'default timeout run',
          enabled: true,
          modelId: 'Qwen3.5-9B-Q8_0.gguf',
          modelPath: 'Qwen3.5-9B-Q8_0.gguf',
          reasoning: 'off',
          sampling: {
            temperature: 0.7,
            topP: 0.8,
            topK: 20,
            minP: 0,
            presencePenalty: 1.5,
            repetitionPenalty: 1,
          },
        },
      ],
    }, null, 2), 'utf8');

    const manifest = readMatrixManifest({
      manifestPath,
      runIds: [],
      promptPrefixFile: null,
      requestTimeoutSeconds: null,
      validateOnly: false,
    });

    assert.equal(manifest.requestTimeoutSeconds, 1800);
  });
});

test('benchmark matrix marks interrupted runs failed, preserves benchmark log paths, and restores baseline', async () => {
  await withTempEnv(async (tempRoot) => {
    await withStubServer(async (server) => {
      const fixtureRoot = path.join(tempRoot, 'bench-fixtures');
      const resultsRoot = path.join(tempRoot, 'bench-results');
      const scriptsRoot = path.join(tempRoot, 'scripts');
      const startScriptPath = path.join(scriptsRoot, 'start.ps1');
      const stopScriptPath = path.join(scriptsRoot, 'stop.ps1');
      const modelPath = path.join(scriptsRoot, `${server.state.config.Model}.gguf`);
      const manifestPath = path.join(tempRoot, 'matrix.json');
      const benchmarkEntrypointPath = path.join(process.cwd(), 'dist', 'benchmark.js');
      const benchmarkIndexPath = path.join(process.cwd(), 'dist', 'benchmark', 'index.js');
      const createdBenchmarkEntrypoint = !fs.existsSync(benchmarkEntrypointPath) && fs.existsSync(benchmarkIndexPath);

      fs.mkdirSync(fixtureRoot, { recursive: true });
      fs.mkdirSync(scriptsRoot, { recursive: true });
      fs.writeFileSync(path.join(fixtureRoot, 'case1.txt'), 'A'.repeat(600), 'utf8');
      fs.writeFileSync(path.join(fixtureRoot, 'fixtures.json'), JSON.stringify([
        {
          Name: 'interrupt-case',
          File: 'case1.txt',
          Question: 'summarize this',
          Format: 'text',
          PolicyProfile: 'general',
        },
      ], null, 2), 'utf8');
      fs.writeFileSync(modelPath, '', 'utf8');
      fs.writeFileSync(startScriptPath, 'Start-Sleep -Seconds 2\n', 'utf8');
      fs.writeFileSync(stopScriptPath, 'exit 0\n', 'utf8');
      if (createdBenchmarkEntrypoint) {
        fs.writeFileSync(benchmarkEntrypointPath, "require('./benchmark/index.js');\n", 'utf8');
      }
      fs.writeFileSync(manifestPath, JSON.stringify({
        fixtureRoot,
        configUrl: server.configUrl,
        startScript: startScriptPath,
        stopScript: stopScriptPath,
        resultsRoot,
        requestTimeoutSeconds: 60,
        baseline: {
          modelId: server.state.config.Model,
          modelPath: path.basename(modelPath),
          contextSize: 128000,
          maxTokens: 4096,
          reasoning: 'off',
          passReasoningArg: false,
        },
        runs: [
          {
            index: 1,
            id: 'interrupt-run',
            label: 'interrupt run',
            enabled: true,
            modelId: server.state.config.Model,
            modelPath: path.basename(modelPath),
            reasoning: 'off',
            passReasoningArg: false,
            sampling: {
              temperature: 0.7,
              topP: 0.8,
              topK: 20,
              minP: 0,
              presencePenalty: 1.5,
              repetitionPenalty: 1,
            },
          },
        ],
      }, null, 2), 'utf8');

      try {
        let rejectInterrupted;
        const interrupted = new Promise((_, reject) => {
          rejectInterrupted = reject;
        });
        const runPromise = runMatrixWithInterrupt(
          {
            manifestPath,
            runIds: [],
            promptPrefixFile: null,
            requestTimeoutSeconds: null,
            validateOnly: false,
          },
          {
            interrupted,
            dispose: () => {},
          },
        );

        const waitForRunEntryPath = async () => {
          const [latestSessionEntry] = fs.readdirSync(resultsRoot).sort().reverse();
          const matrixIndexPath = path.join(resultsRoot, latestSessionEntry, 'matrix_index.json');
          const matrixIndex = JSON.parse(fs.readFileSync(matrixIndexPath, 'utf8'));
          assert.ok(Array.isArray(matrixIndex.runs));
          assert.ok(matrixIndex.runs.length >= 1);
        };
        await waitForAsyncExpectation(waitForRunEntryPath, 8000);
        rejectInterrupted(new Error('Benchmark matrix interrupted by SIGINT.'));

        await assert.rejects(() => runPromise, /Benchmark matrix interrupted by SIGINT/u);
        await sleep(300);

        const [sessionEntry] = fs.readdirSync(resultsRoot).sort().reverse();
        const matrixIndex = JSON.parse(fs.readFileSync(path.join(resultsRoot, sessionEntry, 'matrix_index.json'), 'utf8'));
        assert.equal(matrixIndex.status, 'failed');
        assert.equal(matrixIndex.baselineRestore.status, 'completed');
        assert.equal(matrixIndex.runs.length, 1);
        assert.equal(matrixIndex.runs[0].status, 'failed');
        assert.match(matrixIndex.runs[0].error, /SIGINT/u);
        assert.equal(typeof matrixIndex.runs[0].benchmarkStdoutPath, 'string');
        assert.equal(typeof matrixIndex.runs[0].benchmarkStderrPath, 'string');
        assert.match(path.basename(matrixIndex.runs[0].benchmarkStdoutPath), /^benchmark_1_interrupt-run_stdout\.log$/u);
        assert.match(path.basename(matrixIndex.runs[0].benchmarkStderrPath), /^benchmark_1_interrupt-run_stderr\.log$/u);
      } finally {
        if (createdBenchmarkEntrypoint) {
          fs.rmSync(benchmarkEntrypointPath, { force: true });
        }
      }
    }, {
      chatDelayMs: 250,
    });
  });
});

test('benchmark matrix launch signature changes for script and context changes but ignores metadata-only reasoning when script-owned', async () => {
  await withTempEnv(async (tempRoot) => {
    const fixtureRoot = path.join(tempRoot, 'bench-fixtures');
    const resultsRoot = path.join(tempRoot, 'bench-results');
    const scriptsRoot = path.join(tempRoot, 'scripts');
    const start9bPath = path.join(scriptsRoot, 'Start-Qwen35-9B-Q8-200k.ps1');
    const start35bPath = path.join(scriptsRoot, 'Start-Qwen35-35B-4bit-150k.ps1');
    const manifestPath = path.join(tempRoot, 'matrix.json');

    fs.mkdirSync(fixtureRoot, { recursive: true });
    fs.mkdirSync(scriptsRoot, { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, 'fixtures.json'), '[]', 'utf8');
    fs.writeFileSync(path.join(scriptsRoot, 'Qwen3.5-9B-Q8_0.gguf'), '', 'utf8');
    fs.writeFileSync(start9bPath, '', 'utf8');
    fs.writeFileSync(start35bPath, '', 'utf8');
    fs.writeFileSync(manifestPath, JSON.stringify({
      fixtureRoot,
      configUrl: 'http://127.0.0.1:4765/config',
      startScript: start9bPath,
      resultsRoot,
      baseline: {
        modelId: 'Qwen3.5-9B-Q8_0.gguf',
        modelPath: 'Qwen3.5-9B-Q8_0.gguf',
        contextSize: 200000,
        maxTokens: 15000,
        reasoning: 'off',
        passReasoningArg: false,
      },
      runs: [
        {
          index: 1,
          id: 'same-script',
          label: 'same-script',
          enabled: true,
          modelId: 'Qwen3.5-9B-Q8_0.gguf',
          modelPath: 'Qwen3.5-9B-Q8_0.gguf',
          reasoning: 'off',
          sampling: {
            temperature: 0.7,
            topP: 0.8,
            topK: 20,
            minP: 0,
            presencePenalty: 1.5,
            repetitionPenalty: 1,
          },
        },
      ],
    }, null, 2), 'utf8');

    const manifest = readMatrixManifest({
      manifestPath,
      runIds: [],
      promptPrefixFile: null,
      validateOnly: false,
    });
    const run = manifest.selectedRuns[0];
    const sameScriptDifferentReasoning = { ...run, reasoning: 'on' };
    const differentScript = { ...run, startScript: start35bPath };
    const differentContext = { ...run, contextSize: 150000 };

    assert.equal(buildLaunchSignature(run), buildLaunchSignature(sameScriptDifferentReasoning));
    assert.notEqual(buildLaunchSignature(run), buildLaunchSignature(differentScript));
    assert.notEqual(buildLaunchSignature(run), buildLaunchSignature(differentContext));
  });
});

test('benchmark matrix passes reasoning by default when the launcher supports it', async () => {
  await withTempEnv(async (tempRoot) => {
    const fixtureRoot = path.join(tempRoot, 'bench-fixtures');
    const resultsRoot = path.join(tempRoot, 'bench-results');
    const scriptsRoot = path.join(tempRoot, 'scripts');
    const startPath = path.join(scriptsRoot, 'Start-Qwen.ps1');
    const manifestPath = path.join(tempRoot, 'matrix.json');

    fs.mkdirSync(fixtureRoot, { recursive: true });
    fs.mkdirSync(scriptsRoot, { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, 'fixtures.json'), '[]', 'utf8');
    fs.writeFileSync(path.join(scriptsRoot, 'model.gguf'), '', 'utf8');
    fs.writeFileSync(startPath, '', 'utf8');
    fs.writeFileSync(manifestPath, JSON.stringify({
      fixtureRoot,
      configUrl: 'http://127.0.0.1:4765/config',
      startScript: startPath,
      resultsRoot,
      baseline: {
        modelId: 'model.gguf',
        modelPath: 'model.gguf',
        contextSize: 200000,
        maxTokens: 15000,
        reasoning: 'off',
      },
      runs: [
        {
          index: 1,
          id: 'thinking',
          label: 'thinking',
          enabled: true,
          modelId: 'model.gguf',
          modelPath: 'model.gguf',
          reasoning: 'on',
          sampling: {
            temperature: 0.7,
            topP: 0.8,
            topK: 20,
            minP: 0,
            presencePenalty: 1.5,
            repetitionPenalty: 1,
          },
        },
      ],
    }, null, 2), 'utf8');

    const manifest = readMatrixManifest({
      manifestPath,
      runIds: [],
      promptPrefixFile: null,
      validateOnly: false,
    });
    const launcherArgs = buildLauncherArgs(manifest, manifest.selectedRuns[0]);

    assert.deepEqual(launcherArgs.slice(-2), ['-Reasoning', 'on']);
  });
});

test('benchmark matrix prunes llama launcher logs older than 7 days', async () => {
  await withTempEnv(async (tempRoot) => {
    const resultsRoot = path.join(tempRoot, 'bench-results');
    const nestedDir = path.join(resultsRoot, 'session-a');
    fs.mkdirSync(nestedDir, { recursive: true });

    const oldStdoutLogPath = path.join(resultsRoot, 'launcher_1_old_stdout.log');
    const oldStderrLogPath = path.join(nestedDir, 'launcher_2_old_stderr.log');
    const freshStdoutLogPath = path.join(resultsRoot, 'launcher_3_fresh_stdout.log');
    const nonLauncherLogPath = path.join(resultsRoot, 'benchmark_1_run_stdout.log');
    const nowMs = Date.now();
    const oneWeekMs = 7 * 24 * 60 * 60 * 1000;

    fs.writeFileSync(oldStdoutLogPath, 'old stdout', 'utf8');
    fs.writeFileSync(oldStderrLogPath, 'old stderr', 'utf8');
    fs.writeFileSync(freshStdoutLogPath, 'fresh stdout', 'utf8');
    fs.writeFileSync(nonLauncherLogPath, 'benchmark log', 'utf8');

    const oldDate = new Date(nowMs - oneWeekMs - 1000);
    const freshDate = new Date(nowMs - oneWeekMs + 1000);
    fs.utimesSync(oldStdoutLogPath, oldDate, oldDate);
    fs.utimesSync(oldStderrLogPath, oldDate, oldDate);
    fs.utimesSync(freshStdoutLogPath, freshDate, freshDate);
    fs.utimesSync(nonLauncherLogPath, oldDate, oldDate);

    const deletedCount = pruneOldLauncherLogs(resultsRoot, nowMs);

    assert.equal(deletedCount, 2);
    assert.equal(fs.existsSync(oldStdoutLogPath), false);
    assert.equal(fs.existsSync(oldStderrLogPath), false);
    assert.equal(fs.existsSync(freshStdoutLogPath), true);
    assert.equal(fs.existsSync(nonLauncherLogPath), true);
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

test('benchmark error-log fixtures now reach the model-first summary path', async () => {
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


// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fs,
  path,
  readMatrixManifest,
  buildLaunchSignature,
  buildLauncherArgs,
  buildBenchmarkArgs,
  pruneOldLauncherLogs,
  runMatrixWithInterrupt,
  sleep,
  withTempEnv,
  withStubServer,
  waitForAsyncExpectation,
} = require('./_runtime-helpers.js');
const {
  listBenchmarkMatrixSessions,
  listBenchmarkMatrixRunsForSession,
  readBenchmarkMatrixRunLogTextByStream,
} = require('../dist/state/benchmark-matrix.js');

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

test('benchmark matrix marks interrupted runs failed, preserves benchmark logs, and restores baseline', async () => {
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

        const waitForPersistedRun = async () => {
          const [session] = listBenchmarkMatrixSessions({ limit: 1 });
          assert.ok(session);
          const runs = listBenchmarkMatrixRunsForSession(session.id);
          assert.ok(runs.length >= 1);
        };
        await waitForAsyncExpectation(waitForPersistedRun, 8000);
        rejectInterrupted(new Error('Benchmark matrix interrupted by SIGINT.'));

        await assert.rejects(() => runPromise, /Benchmark matrix interrupted by SIGINT/u);
        await sleep(300);

        const [session] = listBenchmarkMatrixSessions({ limit: 1 });
        const [run] = listBenchmarkMatrixRunsForSession(session.id);
        const logs = readBenchmarkMatrixRunLogTextByStream(run.id);
        assert.equal(session.status, 'failed');
        assert.equal(session.baselineRestoreStatus, 'completed');
        assert.equal(run.status, 'failed');
        assert.match(run.errorMessage, /SIGINT/u);
        assert.match(logs.benchmark_stdout, /Fixture 1\/1 \[interrupt-case\] start/u);
        assert.equal(typeof logs.benchmark_stderr, 'string');
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

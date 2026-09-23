import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fs,
  path,
  readMatrixManifest,
  buildLaunchSignature,
  buildLauncherArgs,
  buildBenchmarkArgs,
  pruneOldLauncherLogs,
  withTempEnv,
} from './_runtime-helpers.js';

test('benchmark matrix respects per-run launcher overrides and script-owned reasoning', async () => {
  await withTempEnv(async (tempRoot) => {
    const fixtureRoot = path.join(tempRoot, 'bench-fixtures');
    const resultsRoot = path.join(tempRoot, 'bench-results');
    const scriptsRoot = path.join(tempRoot, 'scripts');
    const model9bPath = path.join(scriptsRoot, 'Qwen3.5-9B-EXL3');
    const model35bPath = path.join(scriptsRoot, 'Qwen3.5-35B-A3B-EXL3');
    const start9bPath = path.join(scriptsRoot, 'Start-Qwen35-9B-Q8-200k.ps1');
    const start35bPath = path.join(scriptsRoot, 'Start-Qwen35-35B-4bit-150k.ps1');
    const stopScriptPath = path.join(scriptsRoot, 'Stop-Engine.ps1');
    const promptPrefixPath = path.join(tempRoot, 'anchor_prompt_prefix.txt');
    const manifestPath = path.join(tempRoot, 'matrix.json');

    fs.mkdirSync(fixtureRoot, { recursive: true });
    fs.mkdirSync(scriptsRoot, { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, 'fixtures.json'), '[]', 'utf8');
    fs.writeFileSync(model9bPath, '', 'utf8');
    fs.writeFileSync(model35bPath, '', 'utf8');
    fs.writeFileSync(start9bPath, '', 'utf8');
    fs.writeFileSync(start35bPath, '', 'utf8');
    fs.writeFileSync(stopScriptPath, '', 'utf8');
    fs.writeFileSync(promptPrefixPath, 'Anchor prefix', 'utf8');
    fs.writeFileSync(manifestPath, JSON.stringify({
      fixtureRoot,
      configUrl: 'http://127.0.0.1:4765/config',
      promptPrefixFile: promptPrefixPath,
      requestTimeoutSeconds: 45,
      startScript: start9bPath,
      stopScript: stopScriptPath,
      resultsRoot,
      baseline: {
        modelId: 'Qwen3.5-9B-EXL3',
        modelPath: 'Qwen3.5-9B-EXL3',
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
          modelId: 'Qwen3.5-9B-EXL3',
          modelPath: 'Qwen3.5-9B-EXL3',
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
          modelId: 'Qwen3.5-35B-A3B-EXL3',
          modelPath: 'Qwen3.5-35B-A3B-EXL3',
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
      requestTimeoutSeconds: null,
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

    const benchmarkArgs = buildBenchmarkArgs(manifest, run35b, promptPrefixPath);
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
    const modelPath = path.join(scriptsRoot, 'Qwen3.5-9B-EXL3');
    const startScriptPath = path.join(scriptsRoot, 'Start-Qwen35-9B-Q8-200k.ps1');
    const stopScriptPath = path.join(scriptsRoot, 'Stop-Engine.ps1');
    const manifestPath = path.join(tempRoot, 'matrix.json');

    fs.mkdirSync(fixtureRoot, { recursive: true });
    fs.mkdirSync(scriptsRoot, { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, 'fixtures.json'), '[]', 'utf8');
    fs.writeFileSync(modelPath, '', 'utf8');
    fs.writeFileSync(startScriptPath, '', 'utf8');
    fs.writeFileSync(stopScriptPath, '', 'utf8');
    fs.writeFileSync(manifestPath, JSON.stringify({
      fixtureRoot,
      configUrl: 'http://127.0.0.1:4765/config',
      startScript: startScriptPath,
      stopScript: stopScriptPath,
      resultsRoot,
      baseline: {
        modelId: 'Qwen3.5-9B-EXL3',
        modelPath: 'Qwen3.5-9B-EXL3',
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
          modelId: 'Qwen3.5-9B-EXL3',
          modelPath: 'Qwen3.5-9B-EXL3',
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

test('benchmark matrix launch signature changes for script and context changes but ignores metadata-only reasoning when script-owned', async () => {
  await withTempEnv(async (tempRoot) => {
    const fixtureRoot = path.join(tempRoot, 'bench-fixtures');
    const resultsRoot = path.join(tempRoot, 'bench-results');
    const scriptsRoot = path.join(tempRoot, 'scripts');
    const start9bPath = path.join(scriptsRoot, 'Start-Qwen35-9B-Q8-200k.ps1');
    const start35bPath = path.join(scriptsRoot, 'Start-Qwen35-35B-4bit-150k.ps1');
    const stopScriptPath = path.join(scriptsRoot, 'Stop-Engine.ps1');
    const manifestPath = path.join(tempRoot, 'matrix.json');

    fs.mkdirSync(fixtureRoot, { recursive: true });
    fs.mkdirSync(scriptsRoot, { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, 'fixtures.json'), '[]', 'utf8');
    fs.writeFileSync(path.join(scriptsRoot, 'Qwen3.5-9B-EXL3'), '', 'utf8');
    fs.writeFileSync(start9bPath, '', 'utf8');
    fs.writeFileSync(start35bPath, '', 'utf8');
    fs.writeFileSync(stopScriptPath, '', 'utf8');
    fs.writeFileSync(manifestPath, JSON.stringify({
      fixtureRoot,
      configUrl: 'http://127.0.0.1:4765/config',
      startScript: start9bPath,
      stopScript: stopScriptPath,
      resultsRoot,
      baseline: {
        modelId: 'Qwen3.5-9B-EXL3',
        modelPath: 'Qwen3.5-9B-EXL3',
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
          modelId: 'Qwen3.5-9B-EXL3',
          modelPath: 'Qwen3.5-9B-EXL3',
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
    const run = manifest.selectedRuns[0];
    const sameScriptDifferentReasoning = { ...run, reasoning: 'on' as const };
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
    const stopScriptPath = path.join(scriptsRoot, 'Stop-Engine.ps1');
    const manifestPath = path.join(tempRoot, 'matrix.json');

    fs.mkdirSync(fixtureRoot, { recursive: true });
    fs.mkdirSync(scriptsRoot, { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, 'fixtures.json'), '[]', 'utf8');
    fs.writeFileSync(path.join(scriptsRoot, 'model-exl3'), '', 'utf8');
    fs.writeFileSync(startPath, '', 'utf8');
    fs.writeFileSync(stopScriptPath, '', 'utf8');
    fs.writeFileSync(manifestPath, JSON.stringify({
      fixtureRoot,
      configUrl: 'http://127.0.0.1:4765/config',
      startScript: startPath,
      stopScript: stopScriptPath,
      resultsRoot,
      baseline: {
        modelId: 'model-exl3',
        modelPath: 'model-exl3',
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
          modelId: 'model-exl3',
          modelPath: 'model-exl3',
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
      requestTimeoutSeconds: null,
      validateOnly: false,
    });
    const launcherArgs = buildLauncherArgs(manifest, manifest.selectedRuns[0]);

    assert.deepEqual(launcherArgs.slice(-2), ['-Reasoning', 'on']);
  });
});

test('benchmark matrix prunes engine launcher logs older than 7 days', async () => {
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

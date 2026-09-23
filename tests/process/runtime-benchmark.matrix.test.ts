import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fs,
  path,
  runMatrixWithInterrupt,
  withTempEnv,
  withStubServer,
  waitForAsyncExpectation,
} from '../_runtime-helpers.js';
import {
  listBenchmarkMatrixSessions,
  listBenchmarkMatrixRunsForSession,
  readBenchmarkMatrixRunLogTextByStream,
} from '../../src/state/benchmark-matrix.js';

test('benchmark matrix marks interrupted runs failed, preserves benchmark logs, and restores baseline', { timeout: 60000 }, async () => {
  await withTempEnv(async (tempRoot) => {
    await withStubServer(async (server) => {
      const fixtureRoot = path.join(tempRoot, 'bench-fixtures');
      const resultsRoot = path.join(tempRoot, 'bench-results');
      const scriptsRoot = path.join(tempRoot, 'scripts');
      const startScriptPath = path.join(scriptsRoot, 'start.ps1');
      const stopScriptPath = path.join(scriptsRoot, 'stop.ps1');
      const configuredModel = server.state.config.Server.ModelPresets.Presets[0].Model;
      if (!configuredModel) throw new Error('Expected a configured model.');
      const modelPath = path.join(scriptsRoot, configuredModel);
      const manifestPath = path.join(tempRoot, 'matrix.json');

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
      fs.writeFileSync(startScriptPath, 'Start-Sleep -Seconds 1\n', 'utf8');
      fs.writeFileSync(stopScriptPath, 'exit 0\n', 'utf8');
      fs.writeFileSync(manifestPath, JSON.stringify({
        fixtureRoot,
        configUrl: server.configUrl,
        startScript: startScriptPath,
        stopScript: stopScriptPath,
        resultsRoot,
        requestTimeoutSeconds: 60,
        baseline: {
          modelId: server.state.config.Server.ModelPresets.Presets[0].Model,
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
            modelId: server.state.config.Server.ModelPresets.Presets[0].Model,
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

      let rejectInterrupted!: (reason: Error) => void;
      const interrupted = new Promise<never>((_, reject) => {
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

      const waitForBenchmarkStart = async () => {
        const [session] = listBenchmarkMatrixSessions({ limit: 1 });
        assert.ok(session);
        const runs = listBenchmarkMatrixRunsForSession(session.id);
        assert.ok(runs.length >= 1);
        const logs = readBenchmarkMatrixRunLogTextByStream(runs[0].id);
        assert.match(logs.benchmark_stdout, /Fixture 1\/1 \[interrupt-case\] start/u);
      };
      await waitForAsyncExpectation(waitForBenchmarkStart, 25000);
      rejectInterrupted(new Error('Benchmark matrix interrupted by SIGINT.'));

      await assert.rejects(() => runPromise, /Benchmark matrix interrupted by SIGINT/u);

      await waitForAsyncExpectation(() => {
        const [session] = listBenchmarkMatrixSessions({ limit: 1 });
        assert.ok(session);
        const [run] = listBenchmarkMatrixRunsForSession(session.id);
        assert.ok(run);
        assert.equal(session.status, 'failed');
        assert.equal(session.baselineRestoreStatus, 'completed');
        assert.equal(run.status, 'failed');
      }, 5_000);

      const [session] = listBenchmarkMatrixSessions({ limit: 1 });
      const [run] = listBenchmarkMatrixRunsForSession(session.id);
      const logs = readBenchmarkMatrixRunLogTextByStream(run.id);
      assert.equal(session.status, 'failed');
      assert.equal(session.baselineRestoreStatus, 'completed');
      assert.equal(run.status, 'failed');
      assert.match(String(run.errorMessage), /SIGINT/u);
      assert.match(logs.benchmark_stdout, /Fixture 1\/1 \[interrupt-case\] start/u);
      assert.equal(typeof logs.benchmark_stderr, 'string');
    }, {
      chatDelayMs: 250,
    });
  });
});

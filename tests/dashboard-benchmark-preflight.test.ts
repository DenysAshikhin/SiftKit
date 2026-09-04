import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { getRuntimeDatabasePath } from '../src/state/runtime-db.js';
import { createBenchmarkQuestionPreset, createBenchmarkSessionPlan, readBenchmarkSessionDetail, updateBenchmarkAttempt } from '../src/state/dashboard-benchmark.js';
import { readConfig, writeConfig } from '../src/status-server/config-store.js';
import { hasActiveBenchmarkJob, startBenchmarkJob } from '../src/status-server/dashboard-benchmark-runner.js';
import { PresetRuntimeCoordinator } from '../src/status-server/preset-runtime-coordinator.js';
import { IsolatedRuntime } from './helpers/isolated-runtime.js';
import { REMOVED_BACKEND_ID } from './helpers/legacy-backend-fixtures.js';
import { mockModelPreset, mockSiftConfig } from './helpers/mock-config.js';
import { RecordingInferenceRuntime } from './helpers/recording-inference-runtime.js';
import { createTestServerContext } from './helpers/server-context-fixture.js';

const retainedPreset = mockModelPreset({ id: 'retained', label: 'Retained EXL3' });
const { Backend: _backend, ...missingBackendPreset } = retainedPreset;

for (const scenario of [
  { name: 'missing preset identity', preset: { ...retainedPreset, id: 'missing' }, rejected: true },
  { name: 'removed backend snapshot', preset: { ...retainedPreset, Backend: REMOVED_BACKEND_ID }, rejected: true },
  { name: 'missing backend snapshot', preset: missingBackendPreset, rejected: true },
  { name: 'retained EXL3 case', preset: retainedPreset, rejected: false },
]) {
  test(`benchmark preflight handles ${scenario.name} before runtime changes`, async () => {
    const isolated = new IsolatedRuntime();
    isolated.start();
    const configPath = getRuntimeDatabasePath();
    const config = mockSiftConfig({ Server: { ModelPresets: { Presets: [retainedPreset] } } });
    writeConfig(configPath, config);
    const ctx = createTestServerContext(configPath);
    const events: string[] = [];
    // A valid case reaches the runtime, whose deliberate load failure stops it before inference.
    const coordinator = new PresetRuntimeCoordinator(
      configPath,
      new RecordingInferenceRuntime('exl3', events, new Set([retainedPreset.id])),
      ctx.activeModelRequests,
      ctx.appliedModelPresetState,
    );
    try {
      const question = createBenchmarkQuestionPreset({
        title: 'Preflight test', taskKind: 'summary', prompt: 'Explain the fixture.', enabled: true,
      });
      const plan = createBenchmarkSessionPlan({
        questionPresetIds: [question.id], repetitions: 2, managedPresets: [scenario.preset],
        specOverrides: [], originalConfigJson: JSON.stringify(config),
      });
      const historicalAttempt = plan.attempts[1];
      assert.ok(historicalAttempt);
      updateBenchmarkAttempt({ attemptId: historicalAttempt.id, status: 'completed', outputText: 'historical result' });
      let startError: Error | null = null;
      try {
        startBenchmarkJob({ ...ctx, presetRuntimeCoordinator: coordinator }, plan.session.id);
      } catch (error) {
        assert.ok(error instanceof Error);
        startError = error;
      }
      const deadline = Date.now() + 5_000;
      while (hasActiveBenchmarkJob() && Date.now() < deadline) await delay(10);
      assert.equal(hasActiveBenchmarkJob(), false);

      if (scenario.rejected) {
        assert.ok(startError, 'invalid historical case must fail synchronously');
        assert.match(startError.message, /Benchmark case.*(backend|preset)/u);
        assert.deepEqual(events, [], 'preflight must not restart or load an alternative model');
        const failed = readBenchmarkSessionDetail(plan.session.id);
        assert.equal(failed?.session.status, 'failed');
        assert.equal(failed?.session.restoreStatus, 'completed');
        assert.equal(failed?.attempts[0]?.status, 'failed');
        assert.equal(failed?.attempts[1]?.status, 'completed');
        assert.equal(failed?.attempts[1]?.outputText, 'historical result');
      } else {
        assert.equal(startError, null);
        assert.ok(events.includes(`load:${retainedPreset.id}`));
      }
      assert.deepEqual(readConfig(configPath), config);
    } finally {
      await coordinator.shutdown();
      await isolated.close();
    }
  });
}

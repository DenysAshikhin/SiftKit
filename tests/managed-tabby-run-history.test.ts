import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { InferenceRunFlushQueue } from '../src/status-server/inference-run-flush-queue.js';
import { ManagedTabbyRuntime } from '../src/status-server/managed-tabby.js';
import { listInferenceRuns, readInferenceRunLogTextByStream } from '../src/state/inference-runs.js';
import { acquireChildPortLease, withTempEnv } from './_runtime-helpers.js';
import { writeFakeTabby } from './helpers/tabby-fake.js';

async function createManagedTabbyRun(root: string, leaseName: string) {
  const portLease = await acquireChildPortLease(leaseName);
  const { scriptPath, pythonPath, capabilities } = writeFakeTabby(root, portLease.port, null);
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  const flushQueue = new InferenceRunFlushQueue({ idleDelayMs: 0 });
  const runtime = new ManagedTabbyRuntime({
    Managed: true,
    WorkingDirectory: root,
    PythonPath: pythonPath,
    Entrypoint: path.basename(scriptPath),
    ModelRoot: root,
    AdminApiKey: '',
    ShutdownTimeoutMs: 5_000,
  }, flushQueue, capabilities);

  return {
    runtime,
    preset: {
      ...preset,
      Backend: 'exl3' as const,
      BaseUrl: `http://127.0.0.1:${portLease.port}`,
      Model: 'model-a',
      ModelPath: path.join(root, 'model-a'),
      SpeculativeEnabled: true,
      SpeculativeType: 'draft-mtp' as const,
    },
    entrypointPath: path.basename(scriptPath),
    async [Symbol.asyncDispose]() {
      await runtime.stopProcess();
      await flushQueue.close();
      await portLease[Symbol.asyncDispose]();
    },
  };
}

test('a managed TabbyAPI launch records a ready startup run', async () => {
  await withTempEnv(async (root) => {
    await using fixture = await createManagedTabbyRun(root, 'managed-tabby-run-launch');

    await fixture.runtime.ensurePresetReady(fixture.preset);

    const runs = listInferenceRuns({ backend: 'exl3' });
    assert.equal(runs.length, 1, 'exactly one exl3 run must be recorded');
    assert.equal(runs[0].status, 'ready');
    assert.equal(runs[0].purpose, 'startup');
    assert.equal(runs[0].entrypointPath, fixture.entrypointPath);
  });
});

test('a managed TabbyAPI launch records its engine output', async () => {
  await withTempEnv(async (root) => {
    await using fixture = await createManagedTabbyRun(root, 'managed-tabby-run-log');

    await fixture.runtime.ensurePresetReady(fixture.preset);

    const runs = listInferenceRuns({ backend: 'exl3' });
    assert.equal(runs.length, 1, 'exactly one exl3 run must be recorded');
    const streams = readInferenceRunLogTextByStream(runs[0].id);
    assert.match(streams.engine_stdout, /Using main model MTP component for drafting/u);
  });
});

test('stopping managed TabbyAPI marks its recorded run stopped', async () => {
  await withTempEnv(async (root) => {
    await using fixture = await createManagedTabbyRun(root, 'managed-tabby-run-stop');
    await fixture.runtime.ensurePresetReady(fixture.preset);
    const runs = listInferenceRuns({ backend: 'exl3' });
    assert.equal(runs.length, 1, 'exactly one exl3 run must be recorded');

    await fixture.runtime.stopProcess();

    const stoppedRuns = listInferenceRuns({ backend: 'exl3' });
    assert.equal(stoppedRuns.length, 1);
    assert.equal(stoppedRuns[0].id, runs[0].id);
    assert.equal(stoppedRuns[0].status, 'stopped');
  });
});

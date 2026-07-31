import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { Exl3ModelCapabilities } from '../src/inference-presets/exl3-model-capabilities.js';
import { InferenceRunFlushQueue } from '../src/status-server/inference-run-flush-queue.js';
import { ManagedTabbyRuntime } from '../src/status-server/managed-tabby.js';

import { getFreePort, withTempEnv } from './_runtime-helpers.js';
import { writeFakeExl3Venv, writeFakeTabby } from './helpers/tabby-fake.js';

test('Exl3ModelCapabilities accepts an exllamav3 carrying the 8e08af9 watermark', async () => {
  await withTempEnv((root) => {
    const { pythonPath } = writeFakeExl3Venv(root, true);
    assert.equal(new Exl3ModelCapabilities().hasDeviceResidentPastIds(pythonPath), true);
  });
});

test('Exl3ModelCapabilities rejects an exllamav3 predating 8e08af9', async () => {
  await withTempEnv((root) => {
    const { pythonPath } = writeFakeExl3Venv(root, false);
    assert.equal(new Exl3ModelCapabilities().hasDeviceResidentPastIds(pythonPath), false);
  });
});

test('Exl3ModelCapabilities rejects a venv with no exllamav3 installed', async () => {
  await withTempEnv((root) => {
    const { pythonPath, jobSourcePath } = writeFakeExl3Venv(root, true);
    fs.rmSync(path.dirname(path.dirname(jobSourcePath)), { recursive: true, force: true });
    assert.equal(new Exl3ModelCapabilities().hasDeviceResidentPastIds(pythonPath), false);
  });
});

test('Exl3ModelCapabilities rejects an interpreter outside a venv layout', () => {
  assert.equal(new Exl3ModelCapabilities().hasDeviceResidentPastIds(process.execPath), false);
});

test('managed Tabby refuses to launch against an exllamav3 predating 8e08af9', async () => {
  await withTempEnv(async (root) => {
    const port = await getFreePort();
    const { scriptPath, pythonPath, startsPath } = writeFakeTabby(root, port, null);
    writeFakeExl3Venv(root, false);
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
    }, flushQueue);
    try {
      await assert.rejects(runtime.ensurePresetReady({
        ...preset,
        Backend: 'exl3' as const,
        BaseUrl: `http://127.0.0.1:${port}`,
        Model: 'model-a',
        ModelPath: path.join(root, 'model-a'),
      }), /has no exllamav3 with turboderp-org\/exllamav3@8e08af9/u);
      assert.equal(fs.existsSync(startsPath), false);
      assert.equal(runtime.getProcessState(), 'failed');
    } finally {
      await runtime.stopProcess();
      await flushQueue.close();
    }
  });
});

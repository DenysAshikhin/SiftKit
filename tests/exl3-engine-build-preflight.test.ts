import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { Exl3ModelCapabilities } from '../src/inference-presets/exl3-model-capabilities.js';
import { InferenceRunFlushQueue } from '../src/status-server/inference-run-flush-queue.js';
import { ManagedTabbyRuntime } from '../src/status-server/managed-tabby.js';

import { acquireChildPortLease, withTempEnv } from './_runtime-helpers.js';
import {
  createFakeExl3Capabilities,
  writeFakeUnifiedExl3Venv,
  writeFakeExl3Venv,
  writeFakeTabby,
} from './helpers/tabby-fake.js';

function capabilitiesForJobSource(jobSourcePath: string): Exl3ModelCapabilities {
  const packageDirectory = path.dirname(path.dirname(jobSourcePath));
  const pythonPath = path.join(path.dirname(path.dirname(path.dirname(packageDirectory))), 'Scripts', 'python.exe');
  return createFakeExl3Capabilities(pythonPath, packageDirectory);
}

test('Exl3ModelCapabilities accepts an exllamav3 carrying the 8e08af9 watermark', async () => {
  await withTempEnv((root) => {
    const { pythonPath, jobSourcePath } = writeFakeExl3Venv(root, true);
    assert.equal(capabilitiesForJobSource(jobSourcePath).inspectDeviceResidentPastIds(pythonPath), 'compatible');
  });
});

test('Exl3ModelCapabilities reads the package resolved by the configured interpreter', async () => {
  await withTempEnv((root) => {
    const { pythonPath, editablePackageDirectory } = writeFakeUnifiedExl3Venv(root);
    const capabilities = createFakeExl3Capabilities(pythonPath, editablePackageDirectory);

    assert.equal(capabilities.inspectDeviceResidentPastIds(pythonPath), 'compatible');
  });
});

test('Exl3ModelCapabilities rejects an exllamav3 predating 8e08af9', async () => {
  await withTempEnv((root) => {
    const { pythonPath, jobSourcePath } = writeFakeExl3Venv(root, false);
    assert.equal(capabilitiesForJobSource(jobSourcePath).inspectDeviceResidentPastIds(pythonPath), 'incompatible');
  });
});

test('Exl3ModelCapabilities rejects a venv with no exllamav3 installed', async () => {
  await withTempEnv((root) => {
    const { pythonPath, jobSourcePath } = writeFakeExl3Venv(root, true);
    fs.rmSync(path.dirname(path.dirname(jobSourcePath)), { recursive: true, force: true });
    assert.equal(capabilitiesForJobSource(jobSourcePath).inspectDeviceResidentPastIds(pythonPath), 'package-missing');
  });
});

test('Exl3ModelCapabilities reports an executable that cannot run the package probe', () => {
  assert.equal(new Exl3ModelCapabilities().inspectDeviceResidentPastIds(process.execPath), 'interpreter-unavailable');
});

test('managed Tabby refuses to launch against an exllamav3 predating 8e08af9', async () => {
  await withTempEnv(async (root) => {
    await using portLease = await acquireChildPortLease('exl3-engine-build-preflight');
    const port = portLease.port;
    const { scriptPath, pythonPath, startsPath } = writeFakeTabby(root, port, null);
    const { jobSourcePath } = writeFakeExl3Venv(root, false);
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
    }, flushQueue, capabilitiesForJobSource(jobSourcePath));
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

test('managed Tabby reports a missing configured Python interpreter before checking exllamav3', async () => {
  await withTempEnv(async (root) => {
    await using portLease = await acquireChildPortLease('exl3-missing-python-preflight');
    const port = portLease.port;
    const { scriptPath, startsPath } = writeFakeTabby(root, port, null);
    const missingPythonPath = path.join(root, 'missing-venv', 'Scripts', 'python.exe');
    const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
    if (!preset) throw new Error('Default model preset is missing');
    const flushQueue = new InferenceRunFlushQueue({ idleDelayMs: 0 });
    const runtime = new ManagedTabbyRuntime({
      Managed: true,
      WorkingDirectory: root,
      PythonPath: missingPythonPath,
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
      }), new RegExp(`Configured EXL3 Python interpreter does not exist: ${missingPythonPath.replaceAll('\\', '\\\\')}`, 'u'));
      assert.equal(fs.existsSync(startsPath), false);
      assert.equal(runtime.getProcessState(), 'failed');
    } finally {
      await runtime.stopProcess();
      await flushQueue.close();
    }
  });
});

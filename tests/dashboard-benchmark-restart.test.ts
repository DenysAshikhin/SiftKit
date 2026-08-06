import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { restartManagedLlama } from '../src/status-server/dashboard-benchmark-runner.js';
import { PresetRuntimeCoordinator } from '../src/status-server/preset-runtime-coordinator.js';
import { writeConfig } from '../src/status-server/config-store.js';
import { closeRuntimeDatabase } from '../src/state/runtime-db.js';
import { RecordingInferenceRuntime } from './helpers/recording-inference-runtime.js';
import { createTestServerContext } from './helpers/server-context-fixture.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

function createConfigPath(externalServerEnabled: boolean): string {
  const root = createManagedTempDir('siftkit-benchmark-restart-');
  const configPath = path.join(root, 'runtime.sqlite');
  const config = getDefaultConfigObject();
  const base = config.Server.ModelPresets.Presets[0];
  if (!base) throw new Error('Default model preset is missing');
  config.Server.ModelPresets = {
    ActivePresetId: 'llama-main',
    Presets: [{ ...base, id: 'llama-main', label: 'Llama main', Backend: 'llama', ExternalServerEnabled: externalServerEnabled }],
  };
  writeConfig(configPath, config);
  return configPath;
}

function cleanup(configPath: string): void {
  closeRuntimeDatabase();
  fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
}

test('benchmark restart drives the preset runtime coordinator', async () => {
  const configPath = createConfigPath(false);
  const events: string[] = [];
  const baseContext = createTestServerContext(configPath);
  const coordinator = new PresetRuntimeCoordinator(
    configPath,
    new RecordingInferenceRuntime('llama', events),
    new RecordingInferenceRuntime('exl3', events),
    baseContext.activeModelRequests,
    baseContext.appliedModelPresetState,
  );
  const ctx = {
    ...baseContext,
    presetRuntimeCoordinator: coordinator,
    async shutdownManagedLlamaIfNeeded(): Promise<never> {
      throw new Error('benchmark restart must not bypass the coordinator');
    },
  };
  try {
    await coordinator.initialize();
    events.length = 0;

    await restartManagedLlama(ctx);

    assert.deepEqual(events, ['stop:llama', 'start:llama', 'load:llama-main']);
    assert.equal(coordinator.getStatus().processState, 'ready');
  } finally {
    await coordinator.shutdown();
    cleanup(configPath);
  }
});

test('benchmark restart fails loudly instead of measuring an unrestarted external server', async () => {
  const configPath = createConfigPath(true);
  const events: string[] = [];
  const baseContext = createTestServerContext(configPath);
  const coordinator = new PresetRuntimeCoordinator(
    configPath,
    new RecordingInferenceRuntime('llama', events),
    new RecordingInferenceRuntime('exl3', events),
    baseContext.activeModelRequests,
    baseContext.appliedModelPresetState,
  );
  const ctx = { ...baseContext, presetRuntimeCoordinator: coordinator };
  try {
    await coordinator.initialize();
    events.length = 0;

    await assert.rejects(restartManagedLlama(ctx), /external inference server/u);
    assert.deepEqual(events, []);
  } finally {
    await coordinator.shutdown();
    cleanup(configPath);
  }
});

test('benchmark restart fails loudly when no runtime coordinator is available', async () => {
  const configPath = createConfigPath(false);
  const ctx = createTestServerContext(configPath);
  try {
    await assert.rejects(restartManagedLlama(ctx), /coordinator/iu);
  } finally {
    cleanup(configPath);
  }
});

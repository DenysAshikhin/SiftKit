import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { ExternalServerRestartError, PresetRuntimeCoordinator } from '../src/status-server/preset-runtime-coordinator.js';
import { readConfig, writeConfig } from '../src/status-server/config-store.js';
import { closeRuntimeDatabase } from '../src/state/runtime-db.js';
import type { ModelRequestLock } from '../src/status-server/server-types.js';
import { RecordingInferenceRuntime as RecordingRuntime } from './helpers/recording-inference-runtime.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { AppliedModelPresetState } from '../src/status-server/applied-model-preset-state.js';
import { getActiveModelPreset } from '../src/config/getters.js';

function createConfigPath(): string {
  const root = createManagedTempDir('siftkit-preset-coordinator-');
  const configPath = path.join(root, 'runtime.sqlite');
  const config = getDefaultConfigObject();
  const base = config.Server.ModelPresets.Presets[0];
  if (!base) throw new Error('Default model preset is missing');
  config.Server.ModelPresets = {
    ActivePresetId: 'llama-main',
    Presets: [
      { ...base, id: 'llama-main', label: 'Llama main', Backend: 'llama' },
      { ...base, id: 'exl3-main', label: 'EXL3 main', Backend: 'exl3' },
      { ...base, id: 'broken-llama', label: 'Broken llama', Backend: 'llama' },
      { ...base, id: 'external-llama', label: 'External llama', Backend: 'llama', ExternalServerEnabled: true },
    ],
  };
  writeConfig(configPath, config);
  return configPath;
}

interface CoordinatorFixture {
  coordinator: PresetRuntimeCoordinator;
  appliedState: AppliedModelPresetState;
  events: string[];
  configPath: string;
  /** Stands in for `ServerContext.activeModelRequests`, the one place in-flight requests live. */
  activeModelRequests: Map<string, ModelRequestLock>;
}

function createCoordinator(
  failingLlamaPresetIds = new Set<string>(),
  failingExl3PresetIds = new Set<string>(),
): CoordinatorFixture {
  const configPath = createConfigPath();
  const events: string[] = [];
  const activeModelRequests = new Map<string, ModelRequestLock>();
  const appliedState = new AppliedModelPresetState(getActiveModelPreset(readConfig(configPath)));
  const coordinator = new PresetRuntimeCoordinator(
    configPath,
    new RecordingRuntime('llama', events, failingLlamaPresetIds),
    new RecordingRuntime('exl3', events, failingExl3PresetIds),
    activeModelRequests,
    appliedState,
  );
  return { coordinator, appliedState, events, configPath, activeModelRequests };
}

function setActiveModelRequests(activeModelRequests: Map<string, ModelRequestLock>, count: number): void {
  activeModelRequests.clear();
  for (let index = 0; index < count; index += 1) {
    activeModelRequests.set(`token-${index}`, {
      token: `token-${index}`,
      kind: 'repo_search',
      startedAtUtc: new Date().toISOString(),
      ownerRunId: null,
      holdTimeoutHandle: null,
    });
  }
}

async function disposeCoordinator({ coordinator, configPath }: CoordinatorFixture): Promise<void> {
  await coordinator.shutdown();
  closeRuntimeDatabase();
  fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
}

test('preset coordinator drains by preset and switches backend processes', async () => {
  const fixture = createCoordinator();
  const { coordinator, appliedState, events, configPath, activeModelRequests } = fixture;
  try {
    await coordinator.initialize();
    assert.equal(coordinator.getActiveBackend(), 'llama');
    setActiveModelRequests(activeModelRequests, 1);
    const savedConfig = readConfig(configPath);
    savedConfig.Server.ModelPresets.ActivePresetId = 'exl3-main';
    writeConfig(configPath, savedConfig);
    assert.equal(await coordinator.applyPreset('exl3-main'), 'queued');
    assert.equal(coordinator.canGrantModelRequest(), false);
    setActiveModelRequests(activeModelRequests, 0);
    await coordinator.onModelRequestReleased();
    assert.deepEqual(events, [
      'start:llama', 'load:llama-main', 'stop:llama', 'start:exl3', 'load:exl3-main',
    ]);
    assert.equal(coordinator.getStatus().activePresetId, 'exl3-main');
    assert.equal(coordinator.getActiveBackend(), 'exl3');
    assert.equal(readConfig(configPath).Server.ModelPresets.ActivePresetId, 'exl3-main');
    assert.equal(appliedState.getPreset().id, 'exl3-main');
  } finally {
    await disposeCoordinator(fixture);
  }
});

test('pending switch waits until the active requests drain to zero', async () => {
  const fixture = createCoordinator();
  const { coordinator, configPath, activeModelRequests } = fixture;
  try {
    await coordinator.initialize();
    setActiveModelRequests(activeModelRequests, 2);
    const savedConfig = readConfig(configPath);
    savedConfig.Server.ModelPresets.ActivePresetId = 'exl3-main';
    writeConfig(configPath, savedConfig);
    assert.equal(await coordinator.applyPreset('exl3-main'), 'queued');

    setActiveModelRequests(activeModelRequests, 1);
    await coordinator.onModelRequestReleased();
    assert.equal(coordinator.getStatus().activePresetId, 'llama-main');

    setActiveModelRequests(activeModelRequests, 0);
    await coordinator.onModelRequestReleased();
    assert.equal(coordinator.getStatus().activePresetId, 'exl3-main');
  } finally {
    await disposeCoordinator(fixture);
  }
});

test('restartConfiguredPreset stops and restarts the running llama preset', async () => {
  const fixture = createCoordinator();
  const { coordinator, events } = fixture;
  try {
    await coordinator.initialize();
    events.length = 0;

    await coordinator.restartConfiguredPreset();

    assert.deepEqual(events, ['stop:llama', 'start:llama', 'load:llama-main']);
    assert.equal(coordinator.getStatus().activePresetId, 'llama-main');
    assert.equal(coordinator.getStatus().processState, 'ready');
  } finally {
    await disposeCoordinator(fixture);
  }
});

test('restartConfiguredPreset unloads and restarts the running exl3 preset', async () => {
  const fixture = createCoordinator();
  const { coordinator, events, configPath } = fixture;
  try {
    await coordinator.initialize();
    const savedConfig = readConfig(configPath);
    savedConfig.Server.ModelPresets.ActivePresetId = 'exl3-main';
    writeConfig(configPath, savedConfig);
    await coordinator.applyPreset('exl3-main');
    events.length = 0;

    await coordinator.restartConfiguredPreset();

    assert.deepEqual(events, ['unload:exl3', 'stop:exl3', 'start:exl3', 'load:exl3-main']);
    assert.equal(coordinator.getStatus().activePresetId, 'exl3-main');
  } finally {
    await disposeCoordinator(fixture);
  }
});

test('restartConfiguredPreset applies the preset persisted by a plain config save', async () => {
  const fixture = createCoordinator();
  const { coordinator, events, configPath } = fixture;
  try {
    await coordinator.initialize();
    const savedConfig = readConfig(configPath);
    savedConfig.Server.ModelPresets.ActivePresetId = 'exl3-main';
    writeConfig(configPath, savedConfig);
    // A plain save must not have touched the runtime.
    assert.equal(coordinator.getStatus().activePresetId, 'llama-main');
    events.length = 0;

    await coordinator.restartConfiguredPreset();

    assert.deepEqual(events, ['stop:llama', 'start:exl3', 'load:exl3-main']);
    assert.equal(coordinator.getStatus().activePresetId, 'exl3-main');
    assert.equal(readConfig(configPath).Server.ModelPresets.ActivePresetId, 'exl3-main');
  } finally {
    await disposeCoordinator(fixture);
  }
});

test('restartConfiguredPreset refuses to interrupt an active model request', async () => {
  const fixture = createCoordinator();
  const { coordinator, events, activeModelRequests } = fixture;
  try {
    await coordinator.initialize();
    setActiveModelRequests(activeModelRequests, 1);
    events.length = 0;

    await assert.rejects(coordinator.restartConfiguredPreset(), /model request is in progress/u);
    assert.deepEqual(events, []);
  } finally {
    setActiveModelRequests(activeModelRequests, 0);
    await disposeCoordinator(fixture);
  }
});

test('restartConfiguredPreset refuses a preset whose inference server SiftKit does not own', async () => {
  const fixture = createCoordinator();
  const { coordinator, events, configPath } = fixture;
  try {
    await coordinator.initialize();
    const savedConfig = readConfig(configPath);
    savedConfig.Server.ModelPresets.ActivePresetId = 'external-llama';
    writeConfig(configPath, savedConfig);
    events.length = 0;

    await assert.rejects(coordinator.restartConfiguredPreset(), ExternalServerRestartError);
    assert.deepEqual(events, []);
    assert.equal(coordinator.getStatus().activePresetId, 'llama-main');
  } finally {
    await disposeCoordinator(fixture);
  }
});

test('editing the active preset reloads it and rolls back the previous definition on failure', async () => {
  const failingPresetIds = new Set<string>();
  const fixture = createCoordinator(failingPresetIds);
  const { coordinator, events, configPath } = fixture;
  try {
    await coordinator.initialize();
    failingPresetIds.add('llama-main');
    events.length = 0;
    const nextConfig = readConfig(configPath);
    const activePreset = nextConfig.Server.ModelPresets.Presets.find((preset) => preset.id === 'llama-main');
    if (!activePreset) throw new Error('Active preset is missing');
    activePreset.label = 'Changed llama';
    writeConfig(configPath, nextConfig);

    await assert.rejects(coordinator.ensureActivePresetReady(), /load failed: llama-main/u);
    assert.deepEqual(events, [
      'stop:llama', 'start:llama', 'load:llama-main',
      'stop:llama', 'start:llama', 'load:llama-main',
    ]);
    assert.equal(readConfig(configPath).Server.ModelPresets.Presets[0]?.label, 'Llama main');
    assert.equal(coordinator.getStatus().activePresetLabel, 'Llama main');
  } finally {
    await disposeCoordinator(fixture);
  }
});

test('preset coordinator rolls back by preset id after target load failure', async () => {
  const fixture = createCoordinator(new Set(['broken-llama']));
  const { coordinator, appliedState, configPath } = fixture;
  try {
    await coordinator.initialize();
    const previous = appliedState.getPreset();
    await assert.rejects(coordinator.applyPreset('broken-llama'), /load failed: broken-llama/u);
    assert.equal(coordinator.getStatus().activePresetId, 'llama-main');
    assert.equal(coordinator.getStatus().rollback, "Restored preset 'llama-main'.");
    assert.equal(readConfig(configPath).Server.ModelPresets.ActivePresetId, 'llama-main');
    assert.equal(appliedState.getPreset().id, previous.id); // after failed switch rollback
  } finally {
    await disposeCoordinator(fixture);
  }
});

test('cross-backend rollback restores the previous preset when failed target cleanup also fails', async () => {
  const fixture = createCoordinator(new Set<string>(), new Set(['exl3-main']));
  const { coordinator, configPath } = fixture;
  try {
    await coordinator.initialize();
    await assert.rejects(coordinator.applyPreset('exl3-main'), /load failed: exl3-main/u);
    assert.equal(coordinator.getStatus().activePresetId, 'llama-main');
    assert.equal(coordinator.getStatus().processState, 'ready');
    assert.match(coordinator.getStatus().rollback ?? '', /Restored preset 'llama-main'.*nothing loaded: exl3/u);
    assert.equal(readConfig(configPath).Server.ModelPresets.ActivePresetId, 'llama-main');
  } finally {
    await disposeCoordinator(fixture);
  }
});

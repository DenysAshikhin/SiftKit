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
    ActivePresetId: 'exl3-main',
    Presets: [
      { ...base, id: 'exl3-main', label: 'EXL3 main', Backend: 'exl3' },
      { ...base, id: 'exl3-alt', label: 'EXL3 alt', Backend: 'exl3' },
      { ...base, id: 'broken-exl3', label: 'Broken EXL3', Backend: 'exl3' },
      { ...base, id: 'external-exl3', label: 'External EXL3', Backend: 'exl3', ExternalServerEnabled: true },
    ],
  };
  writeConfig(configPath, config);
  return configPath;
}

interface CoordinatorFixture {
  coordinator: PresetRuntimeCoordinator;
  appliedState: AppliedModelPresetState;
  runtime: RecordingRuntime;
  events: string[];
  configPath: string;
  /** Stands in for `ServerContext.activeModelRequests`, the one place in-flight requests live. */
  activeModelRequests: Map<string, ModelRequestLock>;
}

function createCoordinator(failingPresetIds = new Set<string>()): CoordinatorFixture {
  const configPath = createConfigPath();
  const events: string[] = [];
  const activeModelRequests = new Map<string, ModelRequestLock>();
  const appliedState = new AppliedModelPresetState(getActiveModelPreset(readConfig(configPath)));
  const runtime = new RecordingRuntime('exl3', events, failingPresetIds);
  const coordinator = new PresetRuntimeCoordinator(configPath, runtime, activeModelRequests, appliedState);
  return { coordinator, appliedState, runtime, events, configPath, activeModelRequests };
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

function persistActivePreset(configPath: string, presetId: string): void {
  const config = readConfig(configPath);
  config.Server.ModelPresets.ActivePresetId = presetId;
  writeConfig(configPath, config);
}

async function applyAltPreset(fixture: CoordinatorFixture): Promise<void> {
  persistActivePreset(fixture.configPath, 'exl3-alt');
  await fixture.coordinator.applyPreset('exl3-alt');
  assert.equal(fixture.coordinator.getStatus().activePresetId, 'exl3-alt');
}

test('preset coordinator drains by preset and swaps the resident model without a process restart', async () => {
  const fixture = createCoordinator();
  const { coordinator, appliedState, events, configPath, activeModelRequests } = fixture;
  try {
    await coordinator.initialize();
    assert.equal(coordinator.getActiveBackend(), 'exl3');
    setActiveModelRequests(activeModelRequests, 1);
    persistActivePreset(configPath, 'exl3-alt');
    assert.equal(await coordinator.applyPreset('exl3-alt'), 'queued');
    assert.equal(coordinator.canGrantModelRequest(), false);
    setActiveModelRequests(activeModelRequests, 0);
    await coordinator.onModelRequestReleased();
    assert.deepEqual(events, ['start:exl3', 'load:exl3-main', 'unload:exl3', 'load:exl3-alt']);
    assert.equal(coordinator.getStatus().activePresetId, 'exl3-alt');
    assert.equal(readConfig(configPath).Server.ModelPresets.ActivePresetId, 'exl3-alt');
    assert.equal(appliedState.getPreset().id, 'exl3-alt');
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
    persistActivePreset(configPath, 'exl3-alt');
    assert.equal(await coordinator.applyPreset('exl3-alt'), 'queued');

    setActiveModelRequests(activeModelRequests, 1);
    await coordinator.onModelRequestReleased();
    assert.equal(coordinator.getStatus().activePresetId, 'exl3-main');

    setActiveModelRequests(activeModelRequests, 0);
    await coordinator.onModelRequestReleased();
    assert.equal(coordinator.getStatus().activePresetId, 'exl3-alt');
  } finally {
    await disposeCoordinator(fixture);
  }
});

test('idle unload refuses a preset id that is not applied', async () => {
  const fixture = createCoordinator();
  const { coordinator, events } = fixture;
  try {
    await coordinator.initialize();
    await applyAltPreset(fixture);
    events.length = 0;

    assert.equal(await coordinator.applyIdleResidencyAction('exl3-main', 'unload'), false);
    assert.deepEqual(events, []);
  } finally {
    await disposeCoordinator(fixture);
  }
});

test('idle unload refuses while a model request is active', async () => {
  const fixture = createCoordinator();
  const { coordinator, events, activeModelRequests } = fixture;
  try {
    await coordinator.initialize();
    setActiveModelRequests(activeModelRequests, 1);
    events.length = 0;

    assert.equal(await coordinator.applyIdleResidencyAction('exl3-main', 'unload'), false);
    assert.deepEqual(events, []);
  } finally {
    setActiveModelRequests(activeModelRequests, 0);
    await disposeCoordinator(fixture);
  }
});

test('idle unload refuses while a preset switch is pending', async () => {
  const fixture = createCoordinator();
  const { coordinator, events, activeModelRequests } = fixture;
  try {
    await coordinator.initialize();
    setActiveModelRequests(activeModelRequests, 1);
    assert.equal(await coordinator.applyPreset('exl3-alt'), 'queued');
    setActiveModelRequests(activeModelRequests, 0);
    events.length = 0;

    assert.equal(await coordinator.applyIdleResidencyAction('exl3-main', 'unload'), false);
    assert.deepEqual(events, []);
  } finally {
    setActiveModelRequests(activeModelRequests, 0);
    await coordinator.onModelRequestReleased();
    await disposeCoordinator(fixture);
  }
});

test('idle unload applies to the ready applied preset', async () => {
  const fixture = createCoordinator();
  const { coordinator, events } = fixture;
  try {
    await coordinator.initialize();
    events.length = 0;

    assert.equal(await coordinator.applyIdleResidencyAction('exl3-main', 'unload'), true);
    assert.deepEqual(events, ['unload:exl3']);
  } finally {
    await disposeCoordinator(fixture);
  }
});

test('idle unload refuses a runtime whose model is not ready', async () => {
  const fixture = createCoordinator();
  const { coordinator, runtime, events } = fixture;
  try {
    await coordinator.initialize();
    await runtime.unloadPreset();
    events.length = 0;

    assert.equal(await coordinator.applyIdleResidencyAction('exl3-main', 'unload'), false);
    assert.deepEqual(events, []);
  } finally {
    await disposeCoordinator(fixture);
  }
});

test('restartConfiguredPreset unloads, stops, and restarts the running preset', async () => {
  const fixture = createCoordinator();
  const { coordinator, events } = fixture;
  try {
    await coordinator.initialize();
    events.length = 0;

    await coordinator.restartConfiguredPreset();

    assert.deepEqual(events, ['unload:exl3', 'stop:exl3', 'start:exl3', 'load:exl3-main']);
    assert.equal(coordinator.getStatus().activePresetId, 'exl3-main');
    assert.equal(coordinator.getStatus().processState, 'ready');
  } finally {
    await disposeCoordinator(fixture);
  }
});

test('restartConfiguredPreset applies the preset persisted by a plain config save', async () => {
  const fixture = createCoordinator();
  const { coordinator, events, configPath } = fixture;
  try {
    await coordinator.initialize();
    persistActivePreset(configPath, 'exl3-alt');
    // A plain save must not have touched the runtime.
    assert.equal(coordinator.getStatus().activePresetId, 'exl3-main');
    events.length = 0;

    await coordinator.restartConfiguredPreset();

    assert.deepEqual(events, ['unload:exl3', 'stop:exl3', 'start:exl3', 'load:exl3-alt']);
    assert.equal(coordinator.getStatus().activePresetId, 'exl3-alt');
    assert.equal(readConfig(configPath).Server.ModelPresets.ActivePresetId, 'exl3-alt');
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
    persistActivePreset(configPath, 'external-exl3');
    events.length = 0;

    await assert.rejects(coordinator.restartConfiguredPreset(), ExternalServerRestartError);
    assert.deepEqual(events, []);
    assert.equal(coordinator.getStatus().activePresetId, 'exl3-main');
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
    failingPresetIds.add('exl3-main');
    events.length = 0;
    const nextConfig = readConfig(configPath);
    const activePreset = nextConfig.Server.ModelPresets.Presets.find((preset) => preset.id === 'exl3-main');
    if (!activePreset) throw new Error('Active preset is missing');
    activePreset.label = 'Changed EXL3';
    writeConfig(configPath, nextConfig);

    await assert.rejects(coordinator.ensureActivePresetReady(), /load failed: exl3-main/u);
    assert.deepEqual(events, [
      'unload:exl3', 'load:exl3-main',
      'unload:exl3', 'load:exl3-main',
    ]);
    assert.equal(readConfig(configPath).Server.ModelPresets.Presets[0]?.label, 'EXL3 main');
    assert.equal(coordinator.getStatus().activePresetLabel, 'EXL3 main');
  } finally {
    await disposeCoordinator(fixture);
  }
});

test('preset coordinator rolls back by preset id after target load failure', async () => {
  const fixture = createCoordinator(new Set(['broken-exl3']));
  const { coordinator, appliedState, configPath } = fixture;
  try {
    await coordinator.initialize();
    const previous = appliedState.getPreset();
    await assert.rejects(coordinator.applyPreset('broken-exl3'), /load failed: broken-exl3/u);
    assert.equal(coordinator.getStatus().activePresetId, 'exl3-main');
    assert.equal(coordinator.getStatus().processState, 'ready');
    assert.match(coordinator.getStatus().rollback ?? '', /Restored preset 'exl3-main'.*nothing loaded: exl3/u);
    assert.equal(readConfig(configPath).Server.ModelPresets.ActivePresetId, 'exl3-main');
    assert.equal(appliedState.getPreset().id, previous.id); // after failed switch rollback
  } finally {
    await disposeCoordinator(fixture);
  }
});

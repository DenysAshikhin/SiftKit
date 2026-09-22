import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { ExternalServerRestartError, PresetRuntimeCoordinator } from '../src/status-server/preset-runtime-coordinator.js';
import { readConfig, writeConfig } from '../src/status-server/config-store.js';
import { closeAllRuntimeDatabases } from '../src/state/runtime-db.js';
import type { ModelRequestLock } from '../src/status-server/server-types.js';
import type { ModelRequestContext } from '../src/status-server/model-request-context.js';
import { RecordingInferenceRuntime as RecordingRuntime } from './helpers/recording-inference-runtime.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { AppliedModelPresetState } from '../src/status-server/applied-model-preset-state.js';
import { getActiveModelPreset } from '../src/config/getters.js';
import type { ModelRuntimePreset } from '../src/config/types.js';

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
      { ...base, id: 'exl3-alt', label: 'EXL3 alt', Backend: 'exl3', Model: 'alt-model' },
      { ...base, id: 'broken-exl3', label: 'Broken EXL3', Backend: 'exl3', Model: 'broken-model' },
      { ...base, id: 'external-exl3', label: 'External EXL3', Backend: 'exl3', Model: 'external-model', ExternalServerEnabled: true },
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

function setActiveModelRequests(fixture: CoordinatorFixture, count: number): void {
  const { activeModelRequests, appliedState, runtime, configPath } = fixture;
  const applied = appliedState.getPreset();
  const context: ModelRequestContext = { operationPreset: null, modelPreset: applied, config: readConfig(configPath) };
  const residencyKey = runtime.getPresetResidencyKey(applied);
  activeModelRequests.clear();
  for (let index = 0; index < count; index += 1) {
    activeModelRequests.set(`token-${index}`, {
      token: `token-${index}`,
      kind: 'repo_search',
      startedAtUtc: new Date().toISOString(),
      ownerRunId: null,
      context,
      residencyKey,
      lastActivityAtMs: Date.now(),
      inactivityTimeoutHandle: null,
    });
  }
}

async function disposeCoordinator({ coordinator, configPath }: CoordinatorFixture): Promise<void> {
  await coordinator.shutdown();
  closeAllRuntimeDatabases();
  fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
}

function persistActivePreset(configPath: string, presetId: string): void {
  const config = readConfig(configPath);
  config.Server.ModelPresets.ActivePresetId = presetId;
  writeConfig(configPath, config);
}

type Deferred = { promise: Promise<void>; resolve: () => void };

function createDeferred(): Deferred {
  let resolveDeferred: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolveDeferred = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (!resolveDeferred) throw new Error('Deferred promise was not initialized.');
      resolveDeferred();
    },
  };
}

/** Recording runtime that can hold a model load open so a save can land mid-transition. */
class BlockingRecordingRuntime extends RecordingRuntime {
  blockedTransition: 'ensure' | null = null;
  readonly transitionStarted = createDeferred();
  private readonly releaseTransitionDeferred = createDeferred();

  releaseTransition(): void {
    this.releaseTransitionDeferred.resolve();
  }

  setBlockedTransition(transition: 'ensure' | null): void {
    this.blockedTransition = transition;
  }

  override async ensurePresetReady(preset: ModelRuntimePreset): Promise<void> {
    if (this.blockedTransition === 'ensure') {
      this.transitionStarted.resolve();
      await this.releaseTransitionDeferred.promise;
    }
    await super.ensurePresetReady(preset);
  }
}

function createBlockingCoordinator(failingPresetIds = new Set<string>()): CoordinatorFixture & { runtime: BlockingRecordingRuntime } {
  const configPath = createConfigPath();
  const events: string[] = [];
  const activeModelRequests = new Map<string, ModelRequestLock>();
  const appliedState = new AppliedModelPresetState(getActiveModelPreset(readConfig(configPath)));
  const runtime = new BlockingRecordingRuntime('exl3', events, failingPresetIds);
  const coordinator = new PresetRuntimeCoordinator(configPath, runtime, activeModelRequests, appliedState);
  return { coordinator, appliedState, runtime, events, configPath, activeModelRequests };
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
    setActiveModelRequests(fixture, 1);
    persistActivePreset(configPath, 'exl3-alt');
    assert.equal(await coordinator.applyPreset('exl3-alt'), 'queued');
    assert.equal(coordinator.canGrantModelRequest(), false);
    setActiveModelRequests(fixture, 0);
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
    setActiveModelRequests(fixture, 2);
    persistActivePreset(configPath, 'exl3-alt');
    assert.equal(await coordinator.applyPreset('exl3-alt'), 'queued');

    setActiveModelRequests(fixture, 1);
    await coordinator.onModelRequestReleased();
    assert.equal(coordinator.getStatus().activePresetId, 'exl3-main');

    setActiveModelRequests(fixture, 0);
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
    setActiveModelRequests(fixture, 1);
    events.length = 0;

    assert.equal(await coordinator.applyIdleResidencyAction('exl3-main', 'unload'), false);
    assert.deepEqual(events, []);
  } finally {
    setActiveModelRequests(fixture, 0);
    await disposeCoordinator(fixture);
  }
});

test('idle unload refuses while a preset switch is pending', async () => {
  const fixture = createCoordinator();
  const { coordinator, events, activeModelRequests } = fixture;
  try {
    await coordinator.initialize();
    setActiveModelRequests(fixture, 1);
    assert.equal(await coordinator.applyPreset('exl3-alt'), 'queued');
    setActiveModelRequests(fixture, 0);
    events.length = 0;

    assert.equal(await coordinator.applyIdleResidencyAction('exl3-main', 'unload'), false);
    assert.deepEqual(events, []);
  } finally {
    setActiveModelRequests(fixture, 0);
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
    setActiveModelRequests(fixture, 1);
    events.length = 0;

    await assert.rejects(coordinator.restartConfiguredPreset(), /model request is in progress/u);
    assert.deepEqual(events, []);
  } finally {
    setActiveModelRequests(fixture, 0);
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
    activePreset.Model = 'changed-load-model';
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

test('concurrent ensureActivePresetReady callers join the in-flight switch instead of failing', async () => {
  const fixture = createCoordinator();
  const { coordinator, events, configPath } = fixture;
  try {
    await coordinator.initialize();
    persistActivePreset(configPath, 'exl3-alt');
    const first = coordinator.ensureActivePresetReady();
    const second = coordinator.ensureActivePresetReady();
    await Promise.all([first, second]);
    assert.deepEqual(events, ['start:exl3', 'load:exl3-main', 'unload:exl3', 'load:exl3-alt']);
    assert.equal(coordinator.getStatus().activePresetId, 'exl3-alt');
    assert.equal(coordinator.getStatus().error, null);
  } finally {
    await disposeCoordinator(fixture);
  }
});

test('concurrent ensureActivePresetReady joiners all see the switch failure without retrying the load', async () => {
  const fixture = createCoordinator(new Set(['broken-exl3']));
  const { coordinator, events, configPath } = fixture;
  try {
    await coordinator.initialize();
    persistActivePreset(configPath, 'broken-exl3');
    const first = coordinator.ensureActivePresetReady();
    const second = coordinator.ensureActivePresetReady();
    await Promise.all([
      assert.rejects(first, /load failed: broken-exl3/u),
      assert.rejects(second, /load failed: broken-exl3/u),
    ]);
    // Exactly one target load attempt, then rollback; a retry would succeed (failing set is single-shot) and show up here.
    assert.deepEqual(events, [
      'start:exl3', 'load:exl3-main',
      'unload:exl3', 'load:broken-exl3',
      'unload:exl3', 'load:exl3-main',
    ]);
    assert.equal(coordinator.getStatus().activePresetId, 'exl3-main');
    assert.equal(readConfig(configPath).Server.ModelPresets.ActivePresetId, 'exl3-main');
  } finally {
    await disposeCoordinator(fixture);
  }
});

test('ensureActivePresetReady applies a preset re-saved mid-switch and every caller waits for it', async () => {
  const fixture = createCoordinator();
  const { coordinator, events, configPath } = fixture;
  try {
    await coordinator.initialize();
    persistActivePreset(configPath, 'exl3-alt');
    const first = coordinator.ensureActivePresetReady();
    const second = coordinator.ensureActivePresetReady();
    persistActivePreset(configPath, 'broken-exl3'); // re-saved while the alt switch is in flight
    await Promise.all([first, second]);
    assert.deepEqual(events, [
      'start:exl3', 'load:exl3-main',
      'unload:exl3', 'load:exl3-alt',
      'unload:exl3', 'load:broken-exl3',
    ]);
    assert.equal(coordinator.getStatus().activePresetId, 'broken-exl3');
    assert.equal(coordinator.getStatus().error, null);
  } finally {
    await disposeCoordinator(fixture);
  }
});

// Guards the re-check without any timing helper: a caller whose own switch started before the config
// was re-saved must keep looping until the newly saved preset is applied, not report the stale one.
test('ensureActivePresetReady applies a preset re-saved during its own switch', async () => {
  const fixture = createCoordinator();
  const { coordinator, events, configPath } = fixture;
  try {
    await coordinator.initialize();
    persistActivePreset(configPath, 'exl3-alt');
    const ready = coordinator.ensureActivePresetReady();
    persistActivePreset(configPath, 'broken-exl3'); // re-saved after the switch began, before it settled
    await ready;
    assert.deepEqual(events, [
      'start:exl3', 'load:exl3-main',
      'unload:exl3', 'load:exl3-alt',
      'unload:exl3', 'load:broken-exl3',
    ]);
    assert.equal(coordinator.getStatus().activePresetId, 'broken-exl3');
  } finally {
    await disposeCoordinator(fixture);
  }
});

test('an automatic request switch remains selected after readiness is checked again', async () => {
  const fixture = createCoordinator();
  try {
    await fixture.coordinator.initialize();
    const target = readConfig(fixture.configPath).Server.ModelPresets.Presets
      .find(preset => preset.id === 'exl3-alt');
    assert.ok(target);
    await fixture.coordinator.ensureRequestPresetReady(target);
    fixture.events.length = 0;
    await fixture.coordinator.ensureActivePresetReady();
    assert.equal(fixture.coordinator.getStatus().activePresetId, target.id);
    assert.equal(readConfig(fixture.configPath).Server.ModelPresets.ActivePresetId, target.id);
    assert.deepEqual(fixture.events, []);
  } finally {
    await disposeCoordinator(fixture);
  }
});

test('a same-residency request updates the applied profile without lifecycle calls', async () => {
  const fixture = createCoordinator();
  const { coordinator, events, configPath, appliedState } = fixture;
  try {
    await coordinator.initialize();
    const current = readConfig(configPath).Server.ModelPresets.Presets
      .find(preset => preset.id === 'exl3-main');
    assert.ok(current);
    const target = { ...current, label: 'Renamed main' };
    events.length = 0;

    await coordinator.ensureRequestPresetReady(target);

    assert.deepEqual(events, []);
    assert.equal(coordinator.getStatus().activePresetLabel, 'Renamed main');
    assert.equal(appliedState.getPreset().label, 'Renamed main');
    assert.equal(fixture.runtime.preparedPreset?.label, 'Renamed main');
    assert.equal(readConfig(configPath).Server.ModelPresets.ActivePresetId, 'exl3-main');
  } finally {
    await disposeCoordinator(fixture);
  }
});

test('a same-id request with a changed loading key performs one ordered transition', async () => {
  const fixture = createCoordinator();
  const { coordinator, events, configPath, appliedState } = fixture;
  try {
    await coordinator.initialize();
    const current = readConfig(configPath).Server.ModelPresets.Presets
      .find(preset => preset.id === 'exl3-main');
    assert.ok(current);
    const target = { ...current, Model: 'changed-model' };
    events.length = 0;

    await coordinator.ensureRequestPresetReady(target);

    assert.deepEqual(events, ['unload:exl3', 'load:exl3-main']);
    assert.equal(coordinator.getStatus().activePresetId, 'exl3-main');
    assert.equal(appliedState.getPreset().Model, 'changed-model');
    assert.equal(readConfig(configPath).Server.ModelPresets.ActivePresetId, 'exl3-main');
  } finally {
    await disposeCoordinator(fixture);
  }
});

test('a failed requested switch rolls back the previous model and releases the admission blocker', async () => {
  const fixture = createCoordinator(new Set(['broken-exl3']));
  const { coordinator, events, configPath, appliedState } = fixture;
  try {
    await coordinator.initialize();
    const broken = readConfig(configPath).Server.ModelPresets.Presets
      .find(preset => preset.id === 'broken-exl3');
    assert.ok(broken);
    const target = { ...broken, Model: 'broken-model' }; // changed loading key forces a real transition
    events.length = 0;

    await assert.rejects(coordinator.ensureRequestPresetReady(target), /load failed: broken-exl3/u);

    assert.deepEqual(events, ['unload:exl3', 'load:broken-exl3', 'unload:exl3', 'load:exl3-main']);
    assert.equal(coordinator.getStatus().activePresetId, 'exl3-main');
    assert.match(coordinator.getStatus().rollback ?? '', /Restored preset 'exl3-main'.*nothing loaded: exl3/u);
    assert.equal(readConfig(configPath).Server.ModelPresets.ActivePresetId, 'exl3-main');
    assert.equal(appliedState.getPreset().id, 'exl3-main');
    assert.equal(coordinator.canGrantModelRequest(), true);
  } finally {
    await disposeCoordinator(fixture);
  }
});

test('a missing target fails before any lifecycle call', async () => {
  const fixture = createCoordinator();
  const { coordinator, events } = fixture;
  try {
    await coordinator.initialize();
    events.length = 0;

    await assert.rejects(coordinator.applyPreset('missing-preset'), /does not exist/u);

    assert.deepEqual(events, []);
  } finally {
    await disposeCoordinator(fixture);
  }
});

test('a settings save landing while a requested switch is blocked is preserved', async () => {
  const fixture = createBlockingCoordinator();
  const { coordinator, events, configPath, appliedState, runtime } = fixture;
  try {
    await coordinator.initialize();
    const alt = readConfig(configPath).Server.ModelPresets.Presets
      .find(preset => preset.id === 'exl3-alt');
    assert.ok(alt);
    const target = { ...alt, Model: 'alt-model' }; // changed loading key forces a real transition
    runtime.setBlockedTransition('ensure');
    events.length = 0;

    const ready = coordinator.ensureRequestPresetReady(target);
    await runtime.transitionStarted.promise;
    assert.equal(coordinator.canGrantModelRequest(), false);
    persistActivePreset(configPath, 'external-exl3'); // newer save lands mid-transition
    runtime.releaseTransition();
    await ready;

    assert.deepEqual(events, ['unload:exl3', 'load:exl3-alt']);
    assert.equal(readConfig(configPath).Server.ModelPresets.ActivePresetId, 'external-exl3');
    assert.equal(coordinator.getStatus().activePresetId, 'exl3-alt');
    assert.equal(appliedState.getPreset().id, 'exl3-alt');
    assert.equal(coordinator.canGrantModelRequest(), true);
  } finally {
    await disposeCoordinator(fixture);
  }
});

for (const sameResidency of [true, false]) {
  test(`a removed request profile fails before lifecycle changes (same residency: ${sameResidency})`, async () => {
    const fixture = createCoordinator();
    try {
      await fixture.coordinator.initialize();
      const config = readConfig(fixture.configPath);
      const current = getActiveModelPreset(config);
      const target = { ...current, id: 'removed-model', Model: sameResidency ? current.Model : 'removed-weights' };
      fixture.events.length = 0;
      await assert.rejects(fixture.coordinator.ensureRequestPresetReady(target), /does not exist/u);
      assert.deepEqual(fixture.events, []);
      assert.equal(fixture.appliedState.getPreset().id, current.id);
      assert.equal(fixture.coordinator.canGrantModelRequest(), true);
    } finally {
      await disposeCoordinator(fixture);
    }
  });
}

test('a failed target and failed rollback release admission for a later request', async () => {
  const failures = new Set<string>();
  const fixture = createCoordinator(failures);
  try {
    await fixture.coordinator.initialize();
    const target = readConfig(fixture.configPath).Server.ModelPresets.Presets
      .find((preset) => preset.id === 'broken-exl3');
    assert.ok(target);
    failures.add(target.id);
    failures.add('exl3-main');
    await assert.rejects(fixture.coordinator.ensureRequestPresetReady(target), /load failed: broken-exl3/u);
    assert.equal(fixture.coordinator.canGrantModelRequest(), true);
    await fixture.coordinator.waitForCurrentAdmissionBlocker();
    assert.match(fixture.coordinator.getStatus().rollback ?? '', /load failed: exl3-main/u);
  } finally {
    await disposeCoordinator(fixture);
  }
});

test('failed administrative loading preserves a newer edit to the target profile', async () => {
  const fixture = createBlockingCoordinator(new Set(['broken-exl3']));
  const { coordinator, runtime, configPath } = fixture;
  try {
    await coordinator.initialize();
    persistActivePreset(configPath, 'broken-exl3');
    runtime.setBlockedTransition('ensure');
    const ready = coordinator.applyPreset('broken-exl3');
    const rejected = assert.rejects(ready, /load failed: broken-exl3/u);
    await runtime.transitionStarted.promise;
    const edited = readConfig(configPath);
    const target = edited.Server.ModelPresets.Presets.find((preset) => preset.id === 'broken-exl3');
    assert.ok(target);
    target.Model = 'newer-model-selection';
    writeConfig(configPath, edited);
    const saved = readConfig(configPath);
    runtime.releaseTransition();
    await rejected;
    assert.equal(readConfig(configPath).Server.ModelPresets.ActivePresetId, 'broken-exl3');
    assert.deepEqual(readConfig(configPath), saved);
    assert.equal(coordinator.getStatus().activePresetId, 'exl3-main');
    assert.equal(coordinator.canGrantModelRequest(), true);
  } finally {
    runtime.releaseTransition();
    await disposeCoordinator(fixture);
  }
});

test('an administrative selection reuses equivalent residency and updates profile settings', async () => {
  const fixture = createCoordinator();
  try {
    await fixture.coordinator.initialize();
    const config = readConfig(fixture.configPath);
    const current = getActiveModelPreset(config);
    const equivalent = { ...current, id: 'exl3-alt', label: 'Equivalent profile', Temperature: 0.125 };
    config.Server.ModelPresets.Presets = config.Server.ModelPresets.Presets
      .map((preset) => preset.id === equivalent.id ? equivalent : preset);
    config.Server.ModelPresets.ActivePresetId = equivalent.id;
    writeConfig(fixture.configPath, config);
    fixture.events.length = 0;
    await fixture.coordinator.ensureActivePresetReady();
    assert.deepEqual(fixture.events, []);
    assert.equal(fixture.appliedState.getPreset().id, equivalent.id);
    assert.equal(fixture.appliedState.getPreset().Temperature, 0.125);
    assert.equal(fixture.runtime.preparedPreset?.Temperature, 0.125);
  } finally {
    await disposeCoordinator(fixture);
  }
});

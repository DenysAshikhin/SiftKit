import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { ExternalServerRestartError, PresetRuntimeCoordinator } from '../src/status-server/preset-runtime-coordinator.js';
import { readConfig, writeConfig } from '../src/status-server/config-store.js';
import { closeRuntimeDatabase } from '../src/state/runtime-db.js';
import { RecordingInferenceRuntime as RecordingRuntime } from './helpers/recording-inference-runtime.js';

function createConfigPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-preset-coordinator-'));
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

test('preset coordinator drains by preset and switches backend processes', async () => {
  const configPath = createConfigPath();
  const events: string[] = [];
  const coordinator = new PresetRuntimeCoordinator(
    configPath,
    new RecordingRuntime('llama', events),
    new RecordingRuntime('exl3', events),
  );
  try {
    await coordinator.initialize();
    coordinator.setModelRequestActive(true);
    const savedConfig = readConfig(configPath);
    savedConfig.Server.ModelPresets.ActivePresetId = 'exl3-main';
    writeConfig(configPath, savedConfig);
    assert.equal(await coordinator.applyPreset('exl3-main'), 'queued');
    assert.equal(coordinator.canGrantModelRequest(), false);
    coordinator.setModelRequestActive(false);
    await coordinator.onModelRequestReleased();
    assert.deepEqual(events, [
      'start:llama', 'load:llama-main', 'stop:llama', 'start:exl3', 'load:exl3-main',
    ]);
    assert.equal(coordinator.getStatus().activePresetId, 'exl3-main');
    assert.equal(readConfig(configPath).Server.ModelPresets.ActivePresetId, 'exl3-main');
  } finally {
    await coordinator.shutdown();
    closeRuntimeDatabase();
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
  }
});

test('restartConfiguredPreset stops and restarts the running llama preset', async () => {
  const configPath = createConfigPath();
  const events: string[] = [];
  const coordinator = new PresetRuntimeCoordinator(
    configPath,
    new RecordingRuntime('llama', events),
    new RecordingRuntime('exl3', events),
  );
  try {
    await coordinator.initialize();
    events.length = 0;

    await coordinator.restartConfiguredPreset();

    assert.deepEqual(events, ['stop:llama', 'start:llama', 'load:llama-main']);
    assert.equal(coordinator.getStatus().activePresetId, 'llama-main');
    assert.equal(coordinator.getStatus().processState, 'ready');
  } finally {
    await coordinator.shutdown();
    closeRuntimeDatabase();
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
  }
});

test('restartConfiguredPreset unloads and restarts the running exl3 preset', async () => {
  const configPath = createConfigPath();
  const events: string[] = [];
  const coordinator = new PresetRuntimeCoordinator(
    configPath,
    new RecordingRuntime('llama', events),
    new RecordingRuntime('exl3', events),
  );
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
    await coordinator.shutdown();
    closeRuntimeDatabase();
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
  }
});

test('restartConfiguredPreset applies the preset persisted by a plain config save', async () => {
  const configPath = createConfigPath();
  const events: string[] = [];
  const coordinator = new PresetRuntimeCoordinator(
    configPath,
    new RecordingRuntime('llama', events),
    new RecordingRuntime('exl3', events),
  );
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
    await coordinator.shutdown();
    closeRuntimeDatabase();
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
  }
});

test('restartConfiguredPreset refuses to interrupt an active model request', async () => {
  const configPath = createConfigPath();
  const events: string[] = [];
  const coordinator = new PresetRuntimeCoordinator(
    configPath,
    new RecordingRuntime('llama', events),
    new RecordingRuntime('exl3', events),
  );
  try {
    await coordinator.initialize();
    coordinator.setModelRequestActive(true);
    events.length = 0;

    await assert.rejects(coordinator.restartConfiguredPreset(), /model request is in progress/u);
    assert.deepEqual(events, []);
  } finally {
    coordinator.setModelRequestActive(false);
    await coordinator.shutdown();
    closeRuntimeDatabase();
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
  }
});

test('restartConfiguredPreset refuses a preset whose inference server SiftKit does not own', async () => {
  const configPath = createConfigPath();
  const events: string[] = [];
  const coordinator = new PresetRuntimeCoordinator(
    configPath,
    new RecordingRuntime('llama', events),
    new RecordingRuntime('exl3', events),
  );
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
    await coordinator.shutdown();
    closeRuntimeDatabase();
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
  }
});

test('editing the active preset reloads it and rolls back the previous definition on failure', async () => {
  const configPath = createConfigPath();
  const events: string[] = [];
  const failingPresetIds = new Set<string>();
  const coordinator = new PresetRuntimeCoordinator(
    configPath,
    new RecordingRuntime('llama', events, failingPresetIds),
    new RecordingRuntime('exl3', events),
  );
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
    await coordinator.shutdown();
    closeRuntimeDatabase();
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
  }
});

test('preset coordinator rolls back by preset id after target load failure', async () => {
  const configPath = createConfigPath();
  const events: string[] = [];
  const coordinator = new PresetRuntimeCoordinator(
    configPath,
    new RecordingRuntime('llama', events, new Set(['broken-llama'])),
    new RecordingRuntime('exl3', events),
  );
  try {
    await coordinator.initialize();
    await assert.rejects(coordinator.applyPreset('broken-llama'), /load failed: broken-llama/u);
    assert.equal(coordinator.getStatus().activePresetId, 'llama-main');
    assert.equal(coordinator.getStatus().rollback, "Restored preset 'llama-main'.");
    assert.equal(readConfig(configPath).Server.ModelPresets.ActivePresetId, 'llama-main');
  } finally {
    await coordinator.shutdown();
    closeRuntimeDatabase();
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
  }
});

test('cross-backend rollback restores the previous preset when failed target cleanup also fails', async () => {
  const configPath = createConfigPath();
  const events: string[] = [];
  const coordinator = new PresetRuntimeCoordinator(
    configPath,
    new RecordingRuntime('llama', events),
    new RecordingRuntime('exl3', events, new Set(['exl3-main'])),
  );
  try {
    await coordinator.initialize();
    await assert.rejects(coordinator.applyPreset('exl3-main'), /load failed: exl3-main/u);
    assert.equal(coordinator.getStatus().activePresetId, 'llama-main');
    assert.equal(coordinator.getStatus().processState, 'ready');
    assert.match(coordinator.getStatus().rollback ?? '', /Restored preset 'llama-main'.*nothing loaded: exl3/u);
    assert.equal(readConfig(configPath).Server.ModelPresets.ActivePresetId, 'llama-main');
  } finally {
    await coordinator.shutdown();
    closeRuntimeDatabase();
    fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
  }
});

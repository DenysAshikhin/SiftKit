import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { InferenceBackendId, ModelRuntimePreset } from '../src/config/types.js';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import { ManagedInferenceRuntime } from '../src/status-server/managed-inference-runtime.js';
import { PresetRuntimeCoordinator } from '../src/status-server/preset-runtime-coordinator.js';
import { readConfig, writeConfig } from '../src/status-server/config-store.js';
import { closeRuntimeDatabase } from '../src/state/runtime-db.js';

const capabilities = {
  chatTemplateKwargs: true,
  reasoningContent: true,
  toolCalling: true,
  jsonSchema: true,
  speculativeMode: 'none',
  reusablePrefixCache: 'unknown',
} as const;

class RecordingRuntime extends ManagedInferenceRuntime {
  constructor(
    id: InferenceBackendId,
    private readonly events: string[],
    private readonly failingPresetIds = new Set<string>(),
  ) {
    super(id, capabilities);
  }

  async startProcess(): Promise<void> {
    this.events.push(`start:${this.id}`);
    this.transitionProcessTo('ready');
  }

  async stopProcess(): Promise<void> {
    this.events.push(`stop:${this.id}`);
    this.transitionModelTo('unloaded');
    this.transitionProcessTo('stopped');
  }

  async ensurePresetReady(preset: ModelRuntimePreset): Promise<void> {
    if (this.getProcessState() !== 'ready') await this.startProcess();
    this.events.push(`load:${preset.id}`);
    if (this.failingPresetIds.has(preset.id)) {
      this.failingPresetIds.delete(preset.id);
      this.transitionModelTo('failed');
      throw new Error(`load failed: ${preset.id}`);
    }
    this.transitionModelTo('ready');
  }

  async unloadPreset(): Promise<void> {
    this.events.push(`unload:${this.id}`);
    if (this.getModelState() === 'failed') throw new Error(`nothing loaded: ${this.id}`);
    this.transitionModelTo('unloaded');
  }
}

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

test('preset config save stages the selected preset until the active request drains', async () => {
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
    const nextConfig = readConfig(configPath);
    nextConfig.Server.ModelPresets.ActivePresetId = 'exl3-main';
    const exl3Preset = nextConfig.Server.ModelPresets.Presets.find((preset) => preset.id === 'exl3-main');
    if (!exl3Preset) throw new Error('EXL3 preset is missing');
    exl3Preset.label = 'Updated EXL3';

    assert.equal(await coordinator.applyConfig(nextConfig), 'queued');
    assert.equal(readConfig(configPath).Server.ModelPresets.ActivePresetId, 'llama-main');
    assert.equal(
      readConfig(configPath).Server.ModelPresets.Presets.find((preset) => preset.id === 'exl3-main')?.label,
      'Updated EXL3',
    );

    coordinator.setModelRequestActive(false);
    await coordinator.onModelRequestReleased();
    assert.equal(readConfig(configPath).Server.ModelPresets.ActivePresetId, 'exl3-main');
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

    await assert.rejects(coordinator.applyConfig(nextConfig), /load failed: llama-main/u);
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

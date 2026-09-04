import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModelRuntimePresetSchema, type ModelRuntimePreset } from '@siftkit/contracts';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import type { JsonValue } from '../src/lib/json-types.js';
import { Exl3ModelCapabilities } from '../src/inference-presets/exl3-model-capabilities.js';
import { Exl3PresetAdapter } from '../src/inference-presets/exl3-preset-adapter.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { REMOVED_BACKEND_ID } from './helpers/legacy-backend-fixtures.js';

function createTempDir(prefix: string): string {
  return createManagedTempDir(prefix);
}

function writeConfig(dir: string, obj: JsonValue): void {
  writeFileSync(join(dir, 'config.json'), JSON.stringify(obj), { encoding: 'utf8' });
}

function createModelPreset(overrides: Partial<ModelRuntimePreset> = {}): ModelRuntimePreset {
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  return ModelRuntimePresetSchema.parse({ ...preset, Backend: 'exl3', ...overrides });
}

test('Exl3ModelCapabilities accepts valid vision_config object', () => {
  const dir = createTempDir('exl3-vision-');
  try {
    writeConfig(dir, { vision_config: { hidden_size: 1024, num_layers: 24 } });
    const caps = new Exl3ModelCapabilities();
    assert.equal(caps.hasVisionTower(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Exl3ModelCapabilities rejects missing vision_config key', () => {
  const dir = createTempDir('exl3-vision-');
  try {
    writeConfig(dir, { arch_name: REMOVED_BACKEND_ID });
    const caps = new Exl3ModelCapabilities();
    assert.equal(caps.hasVisionTower(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Exl3ModelCapabilities rejects missing config.json', () => {
  const dir = createTempDir('exl3-vision-');
  try {
    const caps = new Exl3ModelCapabilities();
    assert.equal(caps.hasVisionTower(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Exl3ModelCapabilities rejects malformed JSON in config.json', () => {
  const dir = createTempDir('exl3-vision-');
  try {
    writeFileSync(join(dir, 'config.json'), '{ broken json', { encoding: 'utf8' });
    const caps = new Exl3ModelCapabilities();
    assert.equal(caps.hasVisionTower(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Exl3ModelCapabilities rejects non-object vision_config (string)', () => {
  const dir = createTempDir('exl3-vision-');
  try {
    writeConfig(dir, { vision_config: 'not-an-object' });
    const caps = new Exl3ModelCapabilities();
    assert.equal(caps.hasVisionTower(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Exl3ModelCapabilities rejects array vision_config', () => {
  const dir = createTempDir('exl3-vision-');
  try {
    writeConfig(dir, { vision_config: [1, 2, 3] });
    const caps = new Exl3ModelCapabilities();
    assert.equal(caps.hasVisionTower(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Exl3ModelCapabilities rejects null vision_config', () => {
  const dir = createTempDir('exl3-vision-');
  try {
    writeConfig(dir, { vision_config: null });
    const caps = new Exl3ModelCapabilities();
    assert.equal(caps.hasVisionTower(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Exl3ModelCapabilities rejects top-level config that is not an object', () => {
  const dir = createTempDir('exl3-vision-');
  try {
    writeFileSync(join(dir, 'config.json'), '[1,2]', { encoding: 'utf8' });
    const caps = new Exl3ModelCapabilities();
    assert.equal(caps.hasVisionTower(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Exl3ModelCapabilities empty vision_config object still counts as present', () => {
  const dir = createTempDir('exl3-vision-');
  try {
    writeConfig(dir, { vision_config: {} });
    const caps = new Exl3ModelCapabilities();
    assert.equal(caps.hasVisionTower(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createModelDir(baseDir: string): string {
  const modelDir = join(baseDir, 'model');
  mkdirSync(modelDir, { recursive: true });
  return modelDir;
}

test('Exl3PresetAdapter validatePreset throws when VisionEnabled=true but no vision tower', () => {
  const baseDir = createTempDir('exl3-vision-');
  try {
    const modelDir = createModelDir(baseDir);
    writeConfig(modelDir, { arch_name: REMOVED_BACKEND_ID });
    const preset = createModelPreset({
      Backend: 'exl3',
      ModelPath: modelDir,
      VisionEnabled: true,
    });
    const adapter = new Exl3PresetAdapter(baseDir);
    assert.throws(
      () => adapter.validatePreset(preset),
      /VisionEnabled=true but .* has no vision_config/u,
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('Exl3PresetAdapter validatePreset passes when VisionEnabled=false regardless of config', () => {
  const baseDir = createTempDir('exl3-vision-');
  try {
    const modelDir = createModelDir(baseDir);
    // No config.json at all — should not matter when VisionEnabled=false
    const preset = createModelPreset({
      Backend: 'exl3',
      ModelPath: modelDir,
      VisionEnabled: false,
    });
    const adapter = new Exl3PresetAdapter(baseDir);
    assert.doesNotThrow(() => adapter.validatePreset(preset));
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('Exl3PresetAdapter validatePreset passes when VisionEnabled=true and vision tower exists', () => {
  const baseDir = createTempDir('exl3-vision-');
  try {
    const modelDir = createModelDir(baseDir);
    writeConfig(modelDir, { vision_config: { hidden_size: 1024 } });
    const preset = createModelPreset({
      Backend: 'exl3',
      ModelPath: modelDir,
      VisionEnabled: true,
    });
    const adapter = new Exl3PresetAdapter(baseDir);
    assert.doesNotThrow(() => adapter.validatePreset(preset));
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

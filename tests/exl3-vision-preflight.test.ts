import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModelRuntimePresetSchema, type ModelRuntimePreset } from '@siftkit/contracts';
import { getDefaultConfigObject } from '../src/config/defaults.ts';
import type { JsonValue } from '../src/lib/json-types.ts';
import { inspectModelDirectory } from '../src/inference-presets/model-profile-inspector.ts';
import { Exl3PresetAdapter } from '../src/inference-presets/exl3-preset-adapter.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';
import { REMOVED_BACKEND_ID } from './helpers/legacy-backend-fixtures.ts';

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

const ARCHITECTURES = ['Qwen3_5ForConditionalGeneration'];

function profileVision(config: string): boolean {
  const dir = createTempDir('exl3-vision-');
  try {
    writeFileSync(join(dir, 'config.json'), config, { encoding: 'utf8' });
    return inspectModelDirectory(dir).vision;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the model profile reports a vision tower for any vision_config object, even an empty one', () => {
  assert.equal(profileVision(JSON.stringify({ architectures: ARCHITECTURES, vision_config: { hidden_size: 1024, num_layers: 24 } })), true);
  assert.equal(profileVision(JSON.stringify({ architectures: ARCHITECTURES, vision_config: {} })), true);
  assert.equal(profileVision(JSON.stringify({ architectures: ARCHITECTURES, arch_name: REMOVED_BACKEND_ID })), false);
});

test('the model profile fails loudly on a missing, malformed, or mistyped config.json', () => {
  const dir = createTempDir('exl3-vision-');
  try {
    assert.throws(() => inspectModelDirectory(dir), /has no config.json/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(() => profileVision('{ broken json'));
  assert.throws(() => profileVision('[1,2]'));
  for (const visionConfig of ['not-an-object', [1, 2, 3], null]) {
    assert.throws(() => profileVision(JSON.stringify({ architectures: ARCHITECTURES, vision_config: visionConfig })));
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
    writeConfig(modelDir, { architectures: ARCHITECTURES, arch_name: REMOVED_BACKEND_ID });
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
    writeConfig(modelDir, { architectures: ARCHITECTURES, vision_config: { hidden_size: 1024 } });
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

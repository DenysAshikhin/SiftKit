import assert from 'node:assert/strict';
import test from 'node:test';

import { getActiveModelPreset } from '../src/config/getters.js';
import type { ModelRuntimePreset, SiftConfig } from '../src/config/types.js';
import {
  resolveModelRequestContext,
} from '../src/status-server/model-request-context.js';
import {
  createPresetRoutingConfig,
  PRESET_ROUTING_MODEL_A,
  PRESET_ROUTING_MODEL_B,
  PRESET_ROUTING_MODEL_C,
} from './helpers/preset-routing-config.js';

function findModelPreset(config: SiftConfig, id: string): ModelRuntimePreset {
  const preset = config.Server.ModelPresets.Presets.find((entry) => entry.id === id);
  if (!preset) {
    throw new Error(`Fixture model preset '${id}' is missing.`);
  }
  return preset;
}

function withModelValue(config: SiftConfig, presetId: string, model: string): SiftConfig {
  return {
    ...config,
    Server: {
      ...config.Server,
      ModelPresets: {
        ...config.Server.ModelPresets,
        Presets: config.Server.ModelPresets.Presets.map((preset) =>
          preset.id === presetId ? { ...preset, Model: model } : preset),
      },
    },
  };
}

function withOperationModelReference(config: SiftConfig, operationId: string, modelPresetId: string): SiftConfig {
  return {
    ...config,
    Presets: config.Presets.map((preset) =>
      preset.id === operationId ? { ...preset, modelPresetId } : preset),
  };
}

function withoutModelPreset(config: SiftConfig, presetId: string): SiftConfig {
  return {
    ...config,
    Server: {
      ...config.Server,
      ModelPresets: {
        ...config.Server.ModelPresets,
        Presets: config.Server.ModelPresets.Presets.filter((preset) => preset.id !== presetId),
      },
    },
  };
}

test('operation without a model reference inherits the applied model', () => {
  const config = createPresetRoutingConfig();
  const applied = findModelPreset(config, PRESET_ROUTING_MODEL_A);
  const resolved = resolveModelRequestContext(config, applied, { presetId: 'chat', model: null });
  assert.equal(resolved.modelPreset.id, PRESET_ROUTING_MODEL_A);
  assert.equal(resolved.operationPreset?.id, 'chat');
  assert.equal(getActiveModelPreset(resolved.config).id, PRESET_ROUTING_MODEL_A);
});

test('operation with a model reference resolves the referenced profile', () => {
  const config = createPresetRoutingConfig();
  const applied = findModelPreset(config, PRESET_ROUTING_MODEL_A);
  const resolved = resolveModelRequestContext(config, applied, { presetId: 'repo-search', model: null });
  assert.equal(resolved.modelPreset.id, PRESET_ROUTING_MODEL_B);
  assert.equal(resolved.operationPreset?.id, 'repo-search');
  assert.equal(getActiveModelPreset(resolved.config).id, PRESET_ROUTING_MODEL_B);
  assert.equal(config.Server.ModelPresets.ActivePresetId, PRESET_ROUTING_MODEL_A);
});

test('current-model resolution uses the applied selection at admission', () => {
  const config = createPresetRoutingConfig();
  const applied = config.Server.ModelPresets.Presets.find(preset => preset.id === 'model-c');
  assert.ok(applied);
  const resolved = resolveModelRequestContext(config, applied, { presetId: 'chat', model: null });
  assert.equal(resolved.modelPreset.id, 'model-c');
  assert.equal(getActiveModelPreset(resolved.config).id, 'model-c');
  assert.equal(config.Server.ModelPresets.ActivePresetId, 'model-a');
});

test('null operation preset id resolves without an operation preset', () => {
  const config = createPresetRoutingConfig();
  const applied = findModelPreset(config, PRESET_ROUTING_MODEL_B);
  const resolved = resolveModelRequestContext(config, applied, { presetId: null, model: null });
  assert.equal(resolved.operationPreset, null);
  assert.equal(resolved.modelPreset.id, PRESET_ROUTING_MODEL_B);
  assert.equal(getActiveModelPreset(resolved.config).id, PRESET_ROUTING_MODEL_B);
});

test('CLI model equal to the chosen profile retains that profile', () => {
  const config = createPresetRoutingConfig();
  const applied = findModelPreset(config, PRESET_ROUTING_MODEL_A);
  const inherited = resolveModelRequestContext(config, applied, { presetId: 'chat', model: PRESET_ROUTING_MODEL_A });
  assert.equal(inherited.modelPreset.id, PRESET_ROUTING_MODEL_A);
  const referenced = resolveModelRequestContext(config, applied, { presetId: 'repo-search', model: PRESET_ROUTING_MODEL_B });
  assert.equal(referenced.modelPreset.id, PRESET_ROUTING_MODEL_B);
});

test('CLI model equal to the chosen profile wins over other profiles sharing the model', () => {
  const config = withModelValue(createPresetRoutingConfig(), PRESET_ROUTING_MODEL_C, PRESET_ROUTING_MODEL_B);
  const applied = findModelPreset(config, PRESET_ROUTING_MODEL_A);
  const resolved = resolveModelRequestContext(config, applied, { presetId: 'repo-search', model: PRESET_ROUTING_MODEL_B });
  assert.equal(resolved.modelPreset.id, PRESET_ROUTING_MODEL_B);
});

test('CLI model override selects the unique matching profile', () => {
  const config = createPresetRoutingConfig();
  const applied = findModelPreset(config, PRESET_ROUTING_MODEL_A);
  const resolved = resolveModelRequestContext(config, applied, { presetId: 'chat', model: PRESET_ROUTING_MODEL_C });
  assert.equal(resolved.modelPreset.id, PRESET_ROUTING_MODEL_C);
  assert.equal(getActiveModelPreset(resolved.config).id, PRESET_ROUTING_MODEL_C);
});

test('CLI overrides match model names rather than model preset IDs', () => {
  const config = withModelValue(createPresetRoutingConfig(), PRESET_ROUTING_MODEL_C, 'vendor/coding-weights');
  const applied = findModelPreset(config, PRESET_ROUTING_MODEL_A);
  const resolved = resolveModelRequestContext(config, applied, { presetId: 'chat', model: 'vendor/coding-weights' });
  assert.equal(resolved.modelPreset.id, PRESET_ROUTING_MODEL_C);
  assert.throws(
    () => resolveModelRequestContext(config, applied, { presetId: 'chat', model: PRESET_ROUTING_MODEL_C }),
    /CLI model 'model-c' does not match any configured model preset\./u,
  );
});

test('an inherited applied snapshot supplies execution settings independently of the saved profile', () => {
  const config = createPresetRoutingConfig();
  const saved = findModelPreset(config, PRESET_ROUTING_MODEL_C);
  const applied = { ...structuredClone(saved), Temperature: 0.125, NumCtx: saved.NumCtx + 1024 };
  const before = structuredClone(config);
  const resolved = resolveModelRequestContext(config, applied, { presetId: 'chat', model: null });
  assert.deepEqual(resolved.modelPreset, applied);
  assert.deepEqual(getActiveModelPreset(resolved.config), applied);
  assert.deepEqual(config, before);
  applied.Temperature = 0.25;
  assert.equal(resolved.modelPreset.Temperature, 0.125);
  assert.equal(getActiveModelPreset(resolved.config).Temperature, 0.125);
});

test('CLI model matching several profiles is rejected as ambiguous', () => {
  const config = withModelValue(createPresetRoutingConfig(), PRESET_ROUTING_MODEL_C, PRESET_ROUTING_MODEL_B);
  const applied = findModelPreset(config, PRESET_ROUTING_MODEL_A);
  assert.throws(
    () => resolveModelRequestContext(config, applied, { presetId: 'chat', model: PRESET_ROUTING_MODEL_B }),
    /ambiguous: model-b, model-c/u,
  );
});

test('CLI model matching no profile is rejected', () => {
  const config = createPresetRoutingConfig();
  const applied = findModelPreset(config, PRESET_ROUTING_MODEL_A);
  assert.throws(
    () => resolveModelRequestContext(config, applied, { presetId: 'chat', model: 'model-x' }),
    /CLI model 'model-x' does not match any configured model preset\./u,
  );
});

test('unknown operation preset id is rejected', () => {
  const config = createPresetRoutingConfig();
  const applied = findModelPreset(config, PRESET_ROUTING_MODEL_A);
  assert.throws(
    () => resolveModelRequestContext(config, applied, { presetId: 'deleted-op', model: null }),
    /Preset 'deleted-op' was not found\./u,
  );
});

test('operation referencing a deleted model preset is rejected', () => {
  const base = createPresetRoutingConfig();
  const config = withOperationModelReference(base, 'repo-search', 'model-deleted');
  const applied = findModelPreset(base, PRESET_ROUTING_MODEL_A);
  assert.throws(
    () => resolveModelRequestContext(config, applied, { presetId: 'repo-search', model: null }),
    /Operation preset 'repo-search' references missing model preset 'model-deleted'\./u,
  );
});

test('applied model preset missing from the config is rejected', () => {
  const base = createPresetRoutingConfig();
  const config = withoutModelPreset(base, PRESET_ROUTING_MODEL_C);
  const applied = findModelPreset(base, PRESET_ROUTING_MODEL_C);
  assert.throws(
    () => resolveModelRequestContext(config, applied, { presetId: 'chat', model: null }),
    /Model preset 'model-c' does not exist\./u,
  );
});

test('resolution snapshots the model, settings, and operation preset; later edits do not leak in', () => {
  const config = createPresetRoutingConfig();
  const applied = findModelPreset(config, PRESET_ROUTING_MODEL_B);
  const resolved = resolveModelRequestContext(config, applied, { presetId: 'repo-search', model: null });
  const snapshotTemperature = resolved.modelPreset.Temperature;
  const snapshotNumCtx = resolved.modelPreset.NumCtx;
  const snapshotPromptPrefix = resolved.operationPreset?.promptPrefix;

  config.Server.ModelPresets.ActivePresetId = PRESET_ROUTING_MODEL_C;
  const savedModel = findModelPreset(config, PRESET_ROUTING_MODEL_B);
  savedModel.Temperature = 0.1;
  savedModel.NumCtx = 12_345;
  const savedOperation = config.Presets.find((preset) => preset.id === 'repo-search');
  assert.ok(savedOperation);
  savedOperation.promptPrefix = 'edited after admission';

  assert.equal(resolved.modelPreset.id, PRESET_ROUTING_MODEL_B);
  assert.equal(resolved.modelPreset.Temperature, snapshotTemperature);
  assert.equal(resolved.modelPreset.NumCtx, snapshotNumCtx);
  assert.equal(resolved.operationPreset?.promptPrefix, snapshotPromptPrefix);
  assert.equal(getActiveModelPreset(resolved.config).id, PRESET_ROUTING_MODEL_B);
  const resolvedModel = resolved.config.Server.ModelPresets.Presets.find((preset) => preset.id === PRESET_ROUTING_MODEL_B);
  assert.ok(resolvedModel);
  assert.equal(resolvedModel.Temperature, snapshotTemperature);
  assert.equal(resolvedModel.NumCtx, snapshotNumCtx);
});

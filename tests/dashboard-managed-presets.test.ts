import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addModelPreset,
  applyModelPresetSelection,
  deleteModelPreset,
  getActiveModelPreset,
  type DashboardModelRuntimePreset,
} from '../dashboard/src/model-runtime-presets.js';
import type { DashboardConfig } from '../dashboard/src/types.js';
import { DashboardSettingsDraftEditor } from '../dashboard/src/settings-draft-editor.js';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import { normalizeConfigObject } from '../src/config/normalization.js';
import { getTestExl3Engine, getTestInferenceConfig } from './helpers/runtime-config.js';

function createPreset(overrides: Partial<DashboardModelRuntimePreset> = {}): DashboardModelRuntimePreset {
  const defaultPreset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!defaultPreset) throw new Error('Default model preset is missing');
  return {
    ...defaultPreset,
    Model: 'default-model',
    NumCtx: 150_000,
    ...overrides,
  };
}

function createConfig(): DashboardConfig {
  const defaultPreset = createPreset();
  const qwenPreset = createPreset({
    id: 'qwen-27b',
    label: 'Qwen 27B',
    Model: 'qwen-27b',
    ModelPath: 'D:\\models\\qwen-27b',
    UBatchSize: 1024,
    SleepIdleSeconds: 120,
  });
  return {
    Version: '0.1.0',
    PolicyMode: 'conservative',
    RawLogRetention: true,
    ExpandReads: true,
    PromptPrefix: 'prompt',
    Inference: getTestInferenceConfig(),
    OperationModeAllowedTools: {
      summary: ['find_text', 'read_lines', 'json_filter'],
      'read-only': [],
      full: [],
    },
    Presets: [],
    Runtime: {
      Engine: {},
    },
    Thresholds: {
      MinCharactersForSummary: 500,
      MinLinesForSummary: 16,
    },
    Interactive: {
      Enabled: true,
      WrappedCommands: ['git'],
      IdleTimeoutMs: 900000,
      MaxTranscriptCharacters: 60000,
      TranscriptRetention: true,
    },
    WebSearch: {
      EnabledDefault: true,
      Providers: {
        tavily: { Enabled: false, ApiKey: '' },
        firecrawl: { Enabled: false, ApiKey: '' },
      },
      ProviderOrder: ['tavily', 'firecrawl'],
      ResultCount: 5,
      FetchMaxPages: 3,
      TimeoutMs: 15000,
      FetchMaxCharacters: 12000,
    },
    Assistant: getDefaultConfigObject().Assistant,
    Server: {
      ModelPresets: {
        Presets: [defaultPreset, qwenPreset],
        ActivePresetId: 'default',
      },
      Engines: { Exl3: getTestExl3Engine() },
    },
  };
}

test('dashboard defaults omit model response MaxTokens', () => {
  const preset = createPreset();
  assert.equal(Object.hasOwn(preset, 'MaxTokens'), false);
  assert.equal(Object.hasOwn(createConfig().Runtime.Engine, 'MaxTokens'), false);
});

function normalizeSingleModelPreset(
  preset: Partial<DashboardModelRuntimePreset>,
): DashboardConfig {
  const defaults = getDefaultConfigObject();
  return normalizeConfigObject({
    ...defaults,
    Server: {
      ...defaults.Server,
      ModelPresets: {
        Presets: [preset],
        ActivePresetId: preset.id ?? '',
      },
    },
  });
}

test('applyModelPresetSelection switches the active managed preset', () => {
  const config = createConfig();
  Object.assign(config.Server.ModelPresets.Presets[1], {
    ReasoningContent: true,
    PreserveThinking: true,
    SpeculativeEnabled: true,
    SpeculativeDraftMax: 32,
  });

  applyModelPresetSelection(config, 'qwen-27b');

  assert.equal(config.Server.ModelPresets.ActivePresetId, 'qwen-27b');
  const active = getActiveModelPreset(config);
  assert.equal(active.ModelPath, 'D:\\models\\qwen-27b');
  assert.equal(active.UBatchSize, 1024);
  assert.equal(active.ReasoningContent, true);
  assert.equal(active.PreserveThinking, true);
  assert.equal(active.MaintainPerStepThinking, false);
  assert.equal(active.SpeculativeEnabled, true);
  assert.equal(active.SpeculativeDraftMax, 32);
  assert.equal(active.SleepIdleSeconds, 120);
});

test('model preset defaults MaintainPerStepThinking on when reasoning is enabled', () => {
  const config = normalizeSingleModelPreset({
    id: 'thinking-on',
    label: 'Thinking On',
    Reasoning: 'on',
    ReasoningContent: true,
    PreserveThinking: true,
    IdleAction: 'unload',
  });

  const preset = config.Server.ModelPresets.Presets[0];
  assert.equal(preset.Reasoning, 'on');
  assert.equal(preset.MaintainPerStepThinking, true);
});

test('model preset honors explicit MaintainPerStepThinking false when reasoning is enabled', () => {
  const config = normalizeSingleModelPreset({
    id: 'thinking-on-last-only',
    label: 'Thinking On Last Only',
    Reasoning: 'on',
    ReasoningContent: true,
    PreserveThinking: true,
    MaintainPerStepThinking: false,
    IdleAction: 'unload',
  });

  assert.equal(config.Server.ModelPresets.Presets[0].MaintainPerStepThinking, false);
});

test('model preset disables MaintainPerStepThinking when reasoning is disabled', () => {
  const config = normalizeSingleModelPreset({
    id: 'thinking-off',
    label: 'Thinking Off',
    Reasoning: 'off',
    MaintainPerStepThinking: true,
    IdleAction: 'unload',
  });

  assert.equal(config.Server.ModelPresets.Presets[0].MaintainPerStepThinking, false);
});

test('addModelPreset clones the active preset and creates a unique id', () => {
  const config = createConfig();

  const addedPresetId = addModelPreset(config);

  assert.equal(addedPresetId, 'default-2');
  assert.equal(config.Server.ModelPresets.ActivePresetId, 'default-2');
  assert.equal(config.Server.ModelPresets.Presets.some((preset) => preset.id === 'default-2'), true);
});

test('deleteModelPreset removes the preset and falls back to another preset', () => {
  const config = createConfig();

  deleteModelPreset(config, 'default');

  assert.equal(config.Server.ModelPresets.Presets.some((preset) => preset.id === 'default'), false);
  assert.equal(config.Server.ModelPresets.ActivePresetId, 'qwen-27b');
  assert.equal(getActiveModelPreset(config).ModelPath, 'D:\\models\\qwen-27b');
});

test('set-model-boolean VisionEnabled toggles the targeted preset and leaves others unchanged', () => {
  const config = createConfig();
  const editor = new DashboardSettingsDraftEditor(config);

  editor.apply({ type: 'set-model-boolean', presetId: 'qwen-27b', field: 'VisionEnabled', value: true });

  const result = editor.getConfig();
  const defaultPreset = result.Server.ModelPresets.Presets.find((p) => p.id === 'default');
  const qwenPreset = result.Server.ModelPresets.Presets.find((p) => p.id === 'qwen-27b');
  assert.equal(defaultPreset?.VisionEnabled, false);
  assert.equal(qwenPreset?.VisionEnabled, true);
});

test('disabling vision clears vision offload on the targeted preset', () => {
  const config = createConfig();
  const editor = new DashboardSettingsDraftEditor(config);
  editor.apply({ type: 'set-model-boolean', presetId: 'qwen-27b', field: 'VisionEnabled', value: true });
  editor.apply({ type: 'set-model-boolean', presetId: 'qwen-27b', field: 'VisionOffload', value: true });

  editor.apply({ type: 'set-model-boolean', presetId: 'qwen-27b', field: 'VisionEnabled', value: false });

  const preset = editor.getConfig().Server.ModelPresets.Presets.find((candidate) => candidate.id === 'qwen-27b');
  assert.equal(preset?.VisionEnabled, false);
  assert.equal(preset?.VisionOffload, false);
});

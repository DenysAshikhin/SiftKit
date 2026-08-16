import assert from 'node:assert/strict';
import test from 'node:test';

import { DashboardSettingsDraftEditor } from '../dashboard/src/settings-draft-editor.js';
import { CUSTOM_PRESET, DASHBOARD_CONFIG, MANAGED_PRESET, PRESET } from '../dashboard/tests/fixtures.js';

test('settings draft editor replaces the assistant config as one validated value', () => {
  const editor = new DashboardSettingsDraftEditor(DASHBOARD_CONFIG);
  editor.apply({
    type: 'set-assistant',
    value: { ...DASHBOARD_CONFIG.Assistant, Enabled: true },
  });
  assert.equal(editor.getConfig().Assistant.Enabled, true);
  assert.equal(DASHBOARD_CONFIG.Assistant.Enabled, false);
});

test('settings draft editor applies general, policy, interactive, and web-search actions', () => {
  const editor = new DashboardSettingsDraftEditor(DASHBOARD_CONFIG);

  editor.apply({ type: 'set-general-string', field: 'Version', value: '2' });
  editor.apply({ type: 'set-general-string', field: 'PolicyMode', value: 'balanced' });
  editor.apply({ type: 'set-general-string', field: 'PromptPrefix', value: 'Be exact.' });
  editor.apply({ type: 'set-general-boolean', field: 'RawLogRetention', value: false });
  editor.apply({ type: 'set-general-boolean', field: 'ExpandReads', value: false });
  editor.apply({ type: 'set-threshold-integer', field: 'MinCharactersForSummary', value: 25 });
  editor.apply({ type: 'set-threshold-integer', field: 'MinLinesForSummary', value: 4 });
  editor.apply({ type: 'set-operation-tool-enabled', operationMode: 'full', tool: 'run', enabled: true });
  editor.apply({ type: 'set-interactive-boolean', field: 'Enabled', value: false });
  editor.apply({ type: 'set-interactive-boolean', field: 'TranscriptRetention', value: false });
  editor.apply({ type: 'set-interactive-integer', field: 'IdleTimeoutMs', value: 2200 });
  editor.apply({ type: 'set-interactive-integer', field: 'MaxTranscriptCharacters', value: 4400 });
  editor.apply({ type: 'set-interactive-wrapped-commands', value: ['npm test', 'npm run build'] });
  editor.apply({ type: 'set-web-search-primary-provider', provider: 'firecrawl' });
  editor.apply({ type: 'set-web-search-enabled-default', value: false });
  editor.apply({ type: 'set-web-search-provider-enabled', provider: 'tavily', value: false });
  editor.apply({ type: 'set-web-search-provider-api-key', provider: 'firecrawl', value: 'fire-key' });
  editor.apply({ type: 'set-web-search-integer', field: 'ResultCount', value: 9 });
  editor.apply({ type: 'set-web-search-integer', field: 'TimeoutMs', value: 9000 });
  editor.apply({ type: 'set-web-search-integer', field: 'FetchMaxPages', value: 7 });
  editor.apply({ type: 'set-web-search-integer', field: 'FetchMaxCharacters', value: 7000 });

  const config = editor.getConfig();
  assert.equal(config.Version, '2');
  assert.equal(config.PolicyMode, 'balanced');
  assert.equal(config.PromptPrefix, 'Be exact.');
  assert.equal(config.RawLogRetention, false);
  assert.equal(config.ExpandReads, false);
  assert.deepEqual(config.Thresholds, { MinCharactersForSummary: 25, MinLinesForSummary: 4 });
  assert.deepEqual(config.OperationModeAllowedTools.full, ['read_lines', 'run']);
  assert.deepEqual(config.Interactive, {
    Enabled: false,
    WrappedCommands: ['npm test', 'npm run build'],
    IdleTimeoutMs: 2200,
    MaxTranscriptCharacters: 4400,
    TranscriptRetention: false,
  });
  assert.deepEqual(config.WebSearch.ProviderOrder, ['firecrawl', 'tavily']);
  assert.equal(config.WebSearch.EnabledDefault, false);
  assert.equal(config.WebSearch.Providers.tavily.Enabled, false);
  assert.equal(config.WebSearch.Providers.firecrawl.ApiKey, 'fire-key');
  assert.equal(config.WebSearch.ResultCount, 9);
  assert.equal(config.WebSearch.TimeoutMs, 9000);
  assert.equal(config.WebSearch.FetchMaxPages, 7);
  assert.equal(config.WebSearch.FetchMaxCharacters, 7000);
});

test('settings draft editor applies every preset action', () => {
  const editor = new DashboardSettingsDraftEditor(DASHBOARD_CONFIG);

  editor.apply({ type: 'set-preset-string', presetId: CUSTOM_PRESET.id, field: 'label', value: 'Investigation' });
  editor.apply({ type: 'set-preset-string', presetId: CUSTOM_PRESET.id, field: 'description', value: 'Investigate and edit' });
  editor.apply({ type: 'set-preset-string', presetId: CUSTOM_PRESET.id, field: 'promptPrefix', value: 'Be exact.' });
  editor.apply({ type: 'set-preset-kind', presetId: CUSTOM_PRESET.id, value: 'chat' });
  editor.apply({ type: 'set-preset-operation-mode', presetId: CUSTOM_PRESET.id, value: 'full' });
  editor.apply({ type: 'set-preset-tool-enabled', presetId: CUSTOM_PRESET.id, tool: 'write', enabled: true });
  editor.apply({ type: 'set-preset-tool-enabled', presetId: CUSTOM_PRESET.id, tool: 'read', enabled: false });
  editor.apply({ type: 'set-preset-surface-enabled', presetId: CUSTOM_PRESET.id, surface: 'cli', enabled: false });
  editor.apply({ type: 'set-preset-surface-enabled', presetId: CUSTOM_PRESET.id, surface: 'web', enabled: true });
  editor.apply({ type: 'set-preset-boolean', presetId: CUSTOM_PRESET.id, field: 'includeAgentsMd', value: true });
  editor.apply({ type: 'set-preset-boolean', presetId: CUSTOM_PRESET.id, field: 'includeRepoFileListing', value: true });
  editor.apply({ type: 'set-preset-boolean', presetId: CUSTOM_PRESET.id, field: 'assistantMemory', value: true });
  editor.apply({ type: 'set-preset-boolean', presetId: CUSTOM_PRESET.id, field: 'repoRootRequired', value: true });
  editor.apply({ type: 'set-preset-max-turns', presetId: CUSTOM_PRESET.id, value: 12 });
  editor.apply({ type: 'add-preset-autoload-file', presetId: CUSTOM_PRESET.id });
  editor.apply({ type: 'set-preset-autoload-file', presetId: CUSTOM_PRESET.id, index: 0, value: 'docs/rules.md' });
  editor.apply({ type: 'add-preset-autoload-file', presetId: CUSTOM_PRESET.id });
  editor.apply({ type: 'set-preset-autoload-file', presetId: CUSTOM_PRESET.id, index: 1, value: 'AGENTS.md' });
  editor.apply({ type: 'remove-preset-autoload-file', presetId: CUSTOM_PRESET.id, index: 0 });
  editor.apply({ type: 'set-summary-default-preset', presetId: PRESET.id });

  assert.deepEqual(editor.getConfig().Presets.find((preset) => preset.id === CUSTOM_PRESET.id), {
    ...CUSTOM_PRESET,
    label: 'Investigation',
    description: 'Investigate and edit',
    presetKind: 'chat',
    operationMode: 'full',
    promptPrefix: 'Be exact.',
    allowedTools: ['grep', 'find', 'ls', 'git', 'web_search', 'web_fetch', 'write', 'edit', 'run'],
    surfaces: ['web'],
    includeAgentsMd: true,
    includeRepoFileListing: true,
    assistantMemory: true,
    autoloadFiles: ['AGENTS.md'],
    repoRootRequired: true,
    maxTurns: 12,
  });
  assert.equal(editor.getConfig().Presets.find((preset) => preset.id === PRESET.id)?.useForSummary, true);
});

test('settings draft editor applies all model value categories and coupled transitions', () => {
  const editor = new DashboardSettingsDraftEditor(DASHBOARD_CONFIG);
  const presetId = MANAGED_PRESET.id;

  editor.apply({ type: 'set-model-string', presetId, field: 'label', value: 'Fast model' });
  editor.apply({ type: 'set-model-string', presetId, field: 'BindHost', value: '0.0.0.0' });
  editor.apply({ type: 'set-model-nullable-string', presetId, field: 'ExecutablePath', value: 'llama-server.exe' });
  editor.apply({ type: 'set-model-nullable-string', presetId, field: 'BaseUrl', value: null });
  editor.apply({ type: 'set-model-nullable-string', presetId, field: 'ModelPath', value: 'models/fast.gguf' });
  editor.apply({ type: 'set-model-nullable-string', presetId, field: 'Model', value: 'fast.gguf' });
  editor.apply({ type: 'set-model-path', presetId, value: 'models/derived.gguf' });
  editor.apply({ type: 'set-model-nullable-string', presetId, field: 'ReasoningBudgetMessage', value: null });
  editor.apply({ type: 'set-model-integer', presetId, field: 'NumCtx', value: 8192 });
  editor.apply({ type: 'set-model-integer', presetId, field: 'TopK', value: 17 });
  editor.apply({ type: 'set-model-float', presetId, field: 'Temperature', value: 0.2 });
  editor.apply({ type: 'set-model-float', presetId, field: 'RepetitionPenalty', value: 1.2 });
  editor.apply({ type: 'set-model-boolean', presetId, field: 'ExternalServerEnabled', value: true });
  editor.apply({ type: 'set-model-boolean', presetId, field: 'VerboseLogging', value: true });
  editor.apply({ type: 'set-model-kv-cache-quantization', presetId, value: 'q8_0' });
  editor.apply({ type: 'set-model-speculative-type', presetId, value: 'ngram-mod' });
  editor.apply({ type: 'set-model-reasoning', presetId, value: 'on' });
  editor.apply({ type: 'set-model-reasoning-content', presetId, value: true });
  editor.apply({ type: 'set-model-boolean', presetId, field: 'PreserveThinking', value: true });
  editor.apply({ type: 'set-model-reasoning-content', presetId, value: false });
  editor.apply({ type: 'set-model-backend', presetId, value: 'exl3' });

  const preset = editor.getConfig().Server.ModelPresets.Presets[0];
  assert.equal(preset?.label, 'Fast model');
  assert.equal(preset?.BindHost, '0.0.0.0');
  assert.equal(preset?.ExecutablePath, 'llama-server.exe');
  assert.equal(preset?.BaseUrl, null);
  assert.equal(preset?.ModelPath, 'models/derived.gguf');
  assert.equal(preset?.Model, 'derived.gguf');
  assert.equal(preset?.ReasoningBudgetMessage, null);
  assert.equal(preset?.NumCtx, 8192);
  assert.equal(preset?.TopK, 17);
  assert.equal(preset?.Temperature, 0.2);
  assert.equal(preset?.RepetitionPenalty, 1.2);
  assert.equal(preset?.ExternalServerEnabled, true);
  assert.equal(preset?.VerboseLogging, true);
  assert.equal(preset?.KvCacheQuantization, 'q8_0');
  assert.equal(preset?.Reasoning, 'on');
  assert.equal(preset?.ReasoningContent, false);
  assert.equal(preset?.PreserveThinking, false);
  assert.equal(preset?.MaintainPerStepThinking, true);
  assert.equal(preset?.Backend, 'exl3');
  assert.equal(preset?.SpeculativeType, 'draft-mtp');
  assert.equal(preset?.SpeculativeMtpEnabled, false);
  assert.equal(editor.getConfig().Runtime.LlamaCpp.NumCtx, 8192);
});

test('switching a frozen EXL3 draft to llama resets idle action and remains saveable', () => {
  const config = {
    ...DASHBOARD_CONFIG,
    Server: {
      ...DASHBOARD_CONFIG.Server,
      ModelPresets: {
        ActivePresetId: MANAGED_PRESET.id,
        Presets: [{ ...MANAGED_PRESET, Backend: 'exl3' as const, IdleAction: 'freeze' as const }],
      },
    },
  };
  const editor = new DashboardSettingsDraftEditor(config);

  editor.apply({ type: 'set-model-backend', presetId: MANAGED_PRESET.id, value: 'llama' });

  const preset = editor.getConfig().Server.ModelPresets.Presets[0];
  assert.equal(preset?.Backend, 'llama');
  assert.equal(preset?.IdleAction, 'unload');
});

test('switching to EXL3 preserves a non-freeze idle action', () => {
  const editor = new DashboardSettingsDraftEditor(DASHBOARD_CONFIG);

  editor.apply({ type: 'set-model-backend', presetId: MANAGED_PRESET.id, value: 'exl3' });

  const preset = editor.getConfig().Server.ModelPresets.Presets[0];
  assert.equal(preset?.Backend, 'exl3');
  assert.equal(preset?.IdleAction, 'unload');
});

test('settings draft editor adds, selects, and deletes regular and model presets', () => {
  const editor = new DashboardSettingsDraftEditor(DASHBOARD_CONFIG);

  editor.apply({ type: 'add-preset', presetId: 'custom-preset-3', label: 'Custom Preset 2' });
  editor.apply({ type: 'delete-preset', presetId: CUSTOM_PRESET.id });
  editor.apply({ type: 'add-model-preset' });
  const addedModelId = editor.getConfig().Server.ModelPresets.ActivePresetId;
  editor.apply({ type: 'set-active-model-preset', presetId: MANAGED_PRESET.id });
  editor.apply({ type: 'delete-model-preset', presetId: addedModelId });

  const config = editor.getConfig();
  assert.equal(config.Presets.some((preset) => preset.id === CUSTOM_PRESET.id), false);
  assert.equal(config.Presets.some((preset) => preset.id === 'custom-preset-3'), true);
  assert.equal(config.Server.ModelPresets.ActivePresetId, MANAGED_PRESET.id);
  assert.equal(config.Server.ModelPresets.Presets.length, 1);
});

test('settings draft editor rejects unknown IDs, invalid indices, protected deletes, and the final model delete', () => {
  const editor = new DashboardSettingsDraftEditor(DASHBOARD_CONFIG);

  assert.throws(
    () => editor.apply({ type: 'set-preset-string', presetId: 'missing', field: 'label', value: 'Missing' }),
    /Unknown preset: missing/u,
  );
  assert.throws(
    () => editor.apply({ type: 'set-preset-autoload-file', presetId: CUSTOM_PRESET.id, index: 0, value: 'missing.md' }),
    /Invalid autoload file index 0 for preset deep-dive/u,
  );
  assert.throws(
    () => editor.apply({ type: 'delete-preset', presetId: PRESET.id }),
    /Preset summary-default is not deletable/u,
  );
  assert.throws(
    () => editor.apply({ type: 'set-model-string', presetId: 'missing', field: 'label', value: 'Missing' }),
    /Unknown model preset: missing/u,
  );
  assert.throws(
    () => editor.apply({ type: 'set-active-model-preset', presetId: 'missing' }),
    /Unknown model preset: missing/u,
  );
  assert.throws(
    () => editor.apply({ type: 'delete-model-preset', presetId: MANAGED_PRESET.id }),
    /Cannot delete the final model preset/u,
  );
  assert.throws(
    () => editor.apply({ type: 'add-preset', presetId: PRESET.id, label: 'Duplicate' }),
    /Preset already exists: summary-default/u,
  );
});

test('settings draft editor disables all dependent thinking fields with reasoning', () => {
  const editor = new DashboardSettingsDraftEditor(DASHBOARD_CONFIG);

  editor.apply({ type: 'set-model-reasoning', presetId: MANAGED_PRESET.id, value: 'on' });
  editor.apply({ type: 'set-model-reasoning-content', presetId: MANAGED_PRESET.id, value: true });
  editor.apply({ type: 'set-model-boolean', presetId: MANAGED_PRESET.id, field: 'PreserveThinking', value: true });
  editor.apply({ type: 'set-model-reasoning', presetId: MANAGED_PRESET.id, value: 'off' });

  const preset = editor.getConfig().Server.ModelPresets.Presets[0];
  assert.equal(preset?.ReasoningContent, false);
  assert.equal(preset?.PreserveThinking, false);
  assert.equal(preset?.MaintainPerStepThinking, false);
});

test('settings draft editor clones once and never mutates its source config', () => {
  const editor = new DashboardSettingsDraftEditor(DASHBOARD_CONFIG);
  editor.apply({ type: 'set-preset-string', presetId: CUSTOM_PRESET.id, field: 'label', value: 'Changed' });
  editor.apply({ type: 'set-model-string', presetId: MANAGED_PRESET.id, field: 'label', value: 'Changed model' });

  assert.equal(CUSTOM_PRESET.label, 'Deep Dive');
  assert.equal(MANAGED_PRESET.label, 'Managed');
  assert.equal(DASHBOARD_CONFIG.Presets[1]?.label, 'Deep Dive');
});

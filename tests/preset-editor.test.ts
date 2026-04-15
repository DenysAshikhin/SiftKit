import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  DashboardOperationModeAllowedTools,
  DashboardPreset,
  DashboardPresetToolName,
} from '../dashboard/src/types.ts';
import {
  applyOperationModeDefaults,
  applyPresetKindDefaults,
  getDefaultOperationModeForPresetKind,
  getDefaultToolsForOperationMode,
  getEffectivePresetTools,
  PRESET_TOOL_OPTIONS,
  getFallbackPresetId,
  getNextPresetIdAfterDelete,
  getPresetToolsSummary,
  togglePresetTool,
} from '../dashboard/src/preset-editor.ts';

function createPreset(id: string, overrides: Partial<DashboardPreset> = {}): DashboardPreset {
  return {
    id,
    label: id,
    description: '',
    presetKind: 'summary',
    operationMode: 'summary',
    executionFamily: 'summary',
    promptPrefix: '',
    allowedTools: ['find_text'],
    surfaces: ['cli'],
    useForSummary: false,
    builtin: false,
    deletable: true,
    includeAgentsMd: false,
    includeRepoFileListing: false,
    repoRootRequired: false,
    maxTurns: null,
    thinkingInterval: null,
    thinkingEnabled: null,
    ...overrides,
  };
}

test('PRESET_TOOL_OPTIONS exposes every supported tool exactly once', () => {
  assert.deepEqual(PRESET_TOOL_OPTIONS, [
    'find_text',
    'read_lines',
    'json_filter',
    'run_repo_cmd',
  ] satisfies DashboardPresetToolName[]);
});

test('getFallbackPresetId keeps the selected preset when still present', () => {
  const presets = [createPreset('summary'), createPreset('chat')];
  assert.equal(getFallbackPresetId(presets, 'chat'), 'chat');
});

test('getNextPresetIdAfterDelete selects the next preset after deleting the current one', () => {
  const presets = [createPreset('summary'), createPreset('chat'), createPreset('plan')];
  assert.equal(getNextPresetIdAfterDelete(presets, 'chat'), 'plan');
});

test('getNextPresetIdAfterDelete selects the previous preset when the deleted preset was last', () => {
  const presets = [createPreset('summary'), createPreset('chat'), createPreset('plan')];
  assert.equal(getNextPresetIdAfterDelete(presets, 'plan'), 'chat');
});

test('getFallbackPresetId defaults to the first preset when selection is missing', () => {
  const presets = [createPreset('summary'), createPreset('chat')];
  assert.equal(getFallbackPresetId(presets, 'missing'), 'summary');
});

test('getPresetToolsSummary returns a comma-separated list in supported-option order', () => {
  assert.equal(getPresetToolsSummary(['run_repo_cmd', 'find_text']), 'find_text, run_repo_cmd');
});

test('togglePresetTool adds missing tools and removes existing ones', () => {
  assert.deepEqual(togglePresetTool(['find_text'], 'read_lines'), ['find_text', 'read_lines']);
  assert.deepEqual(togglePresetTool(['find_text', 'read_lines'], 'find_text'), ['read_lines']);
});

test('getDefaultOperationModeForPresetKind maps summary/chat to summary and planner kinds to read-only', () => {
  assert.equal(getDefaultOperationModeForPresetKind('summary'), 'summary');
  assert.equal(getDefaultOperationModeForPresetKind('chat'), 'summary');
  assert.equal(getDefaultOperationModeForPresetKind('plan'), 'read-only');
  assert.equal(getDefaultOperationModeForPresetKind('repo-search'), 'read-only');
});

test('getDefaultToolsForOperationMode returns the builtin defaults for each mode', () => {
  assert.deepEqual(getDefaultToolsForOperationMode('summary'), ['find_text', 'read_lines', 'json_filter']);
  assert.deepEqual(getDefaultToolsForOperationMode('read-only'), ['run_repo_cmd']);
  assert.deepEqual(getDefaultToolsForOperationMode('full'), []);
});

test('applyPresetKindDefaults makes preset kind authoritative over operation mode and repo settings', () => {
  const preset = createPreset('custom', {
    presetKind: 'chat',
    operationMode: 'summary',
    executionFamily: 'chat',
    allowedTools: ['find_text'],
    repoRootRequired: false,
    maxTurns: null,
    thinkingInterval: null,
    thinkingEnabled: true,
  });

  applyPresetKindDefaults(preset, 'plan');

  assert.equal(preset.presetKind, 'plan');
  assert.equal(preset.executionFamily, 'plan');
  assert.equal(preset.operationMode, 'read-only');
  assert.deepEqual(preset.allowedTools, ['run_repo_cmd']);
  assert.equal(preset.repoRootRequired, true);
  assert.equal(preset.maxTurns, 45);
  assert.equal(preset.thinkingInterval, 5);
  assert.equal(preset.thinkingEnabled, null);
});

test('applyOperationModeDefaults swaps allowed tools while preserving chat-kind runtime defaults', () => {
  const preset = createPreset('chat', {
    presetKind: 'chat',
    operationMode: 'summary',
    executionFamily: 'chat',
    allowedTools: ['find_text'],
    thinkingEnabled: null,
  });

  applyOperationModeDefaults(preset, 'full');

  assert.equal(preset.operationMode, 'full');
  assert.deepEqual(preset.allowedTools, []);
  assert.equal(preset.repoRootRequired, false);
  assert.equal(preset.maxTurns, null);
  assert.equal(preset.thinkingInterval, null);
  assert.equal(preset.thinkingEnabled, true);
});

test('getEffectivePresetTools intersects preset allowlist with operation-mode policy', () => {
  const operationModeAllowedTools: DashboardOperationModeAllowedTools = {
    summary: ['find_text', 'read_lines', 'json_filter'],
    'read-only': ['run_repo_cmd'],
    full: [],
  };

  assert.deepEqual(
    getEffectivePresetTools({
      allowedTools: ['find_text', 'run_repo_cmd'],
      operationMode: 'summary',
    }, operationModeAllowedTools),
    ['find_text'],
  );
});

test('applyOperationModeDefaults preserves prompt-context toggles across mode changes', () => {
  const preset = createPreset('custom', {
    includeAgentsMd: true,
    includeRepoFileListing: true,
  });

  applyOperationModeDefaults(preset, 'read-only');
  applyOperationModeDefaults(preset, 'summary');

  assert.equal(preset.includeAgentsMd, true);
  assert.equal(preset.includeRepoFileListing, true);
});

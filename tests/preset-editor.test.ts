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
    ...overrides,
  };
}

const SUMMARY_TOOL_OPTIONS: DashboardPresetToolName[] = ['find_text', 'read_lines', 'json_filter', 'json_get'];
const REPO_TOOL_OPTIONS: DashboardPresetToolName[] = PRESET_TOOL_OPTIONS.filter(
  (tool): tool is DashboardPresetToolName => tool.startsWith('repo_'),
);

test('PRESET_TOOL_OPTIONS exposes every supported tool exactly once', () => {
  assert.equal(new Set(PRESET_TOOL_OPTIONS).size, PRESET_TOOL_OPTIONS.length);
  assert.deepEqual(PRESET_TOOL_OPTIONS, [
    ...SUMMARY_TOOL_OPTIONS,
    ...REPO_TOOL_OPTIONS,
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
  assert.equal(getPresetToolsSummary(['repo_rg', 'find_text']), 'find_text, repo_rg');
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
  assert.deepEqual(getDefaultToolsForOperationMode('summary'), SUMMARY_TOOL_OPTIONS);
  assert.deepEqual(getDefaultToolsForOperationMode('read-only'), REPO_TOOL_OPTIONS);
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
  });

  applyPresetKindDefaults(preset, 'plan');

  assert.equal(preset.presetKind, 'plan');
  assert.equal(preset.executionFamily, 'plan');
  assert.equal(preset.operationMode, 'read-only');
  assert.deepEqual(preset.allowedTools, REPO_TOOL_OPTIONS);
  assert.equal(preset.repoRootRequired, true);
  assert.equal(preset.maxTurns, 45);
});

test('applyOperationModeDefaults swaps allowed tools while preserving chat-kind runtime defaults', () => {
  const preset = createPreset('chat', {
    presetKind: 'chat',
    operationMode: 'summary',
    executionFamily: 'chat',
    allowedTools: ['find_text'],
  });

  applyOperationModeDefaults(preset, 'full');

  assert.equal(preset.operationMode, 'full');
  assert.deepEqual(preset.allowedTools, []);
  assert.equal(preset.repoRootRequired, false);
  assert.equal(preset.maxTurns, null);
});

test('getEffectivePresetTools intersects preset allowlist with operation-mode policy', () => {
  const operationModeAllowedTools: DashboardOperationModeAllowedTools = {
    summary: [...SUMMARY_TOOL_OPTIONS],
    'read-only': [...REPO_TOOL_OPTIONS],
    full: [],
  };

  assert.deepEqual(
    getEffectivePresetTools({
      allowedTools: ['find_text', 'repo_rg'],
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

import assert from 'node:assert/strict';
import test from 'node:test';

import type { DashboardPreset, DashboardPresetToolName } from '../dashboard/src/types.ts';
import {
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
    executionFamily: 'summary',
    promptPrefix: '',
    allowedTools: ['find_text'],
    surfaces: ['cli'],
    useForSummary: false,
    builtin: false,
    deletable: true,
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

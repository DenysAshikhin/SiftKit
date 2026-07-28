import test from 'node:test';
import assert from 'node:assert/strict';

import { DashboardPresetDraftEditor } from '../src/preset-draft-editor';
import { CUSTOM_PRESET, DASHBOARD_CONFIG, PRESET } from './fixtures';

test('preset draft editor applies explicit preset field operations', () => {
  const editor = new DashboardPresetDraftEditor(DASHBOARD_CONFIG);

  editor.setLabel(CUSTOM_PRESET.id, 'Investigation');
  editor.setKind(CUSTOM_PRESET.id, 'chat');
  editor.setOperationMode(CUSTOM_PRESET.id, 'full');
  editor.toggleTool(CUSTOM_PRESET.id, 'write');
  editor.toggleTool(CUSTOM_PRESET.id, 'write');
  editor.setDescription(CUSTOM_PRESET.id, 'Investigate and edit');
  editor.setPromptPrefix(CUSTOM_PRESET.id, 'Be exact.');
  editor.setSurfaceEnabled(CUSTOM_PRESET.id, 'cli', false);
  editor.setSurfaceEnabled(CUSTOM_PRESET.id, 'web', true);
  editor.setAgentsMdEnabled(CUSTOM_PRESET.id, true);
  editor.setRepoFileListingEnabled(CUSTOM_PRESET.id, true);

  const preset = editor.getConfig().Presets.find((entry) => entry.id === CUSTOM_PRESET.id);
  assert.deepEqual(preset, {
    ...CUSTOM_PRESET,
    label: 'Investigation',
    description: 'Investigate and edit',
    presetKind: 'chat',
    operationMode: 'full',
    executionFamily: 'chat',
    promptPrefix: 'Be exact.',
    allowedTools: [
      'read',
      'grep',
      'find',
      'ls',
      'git',
      'web_search',
      'web_fetch',
      'write',
      'edit',
      'run',
    ],
    surfaces: ['web'],
    includeAgentsMd: true,
    includeRepoFileListing: true,
  });
});

test('preset draft editor applies explicit autoload and summary-selection operations', () => {
  const editor = new DashboardPresetDraftEditor(DASHBOARD_CONFIG);

  editor.addAutoloadFile(CUSTOM_PRESET.id);
  editor.setAutoloadFile(CUSTOM_PRESET.id, 0, 'docs/rules.md');
  editor.addAutoloadFile(CUSTOM_PRESET.id);
  editor.setAutoloadFile(CUSTOM_PRESET.id, 1, 'AGENTS.md');
  editor.removeAutoloadFile(CUSTOM_PRESET.id, 0);
  editor.setDefaultSummaryPreset(PRESET.id, true);

  const config = editor.getConfig();
  assert.deepEqual(
    config.Presets.find((entry) => entry.id === CUSTOM_PRESET.id)?.autoloadFiles,
    ['AGENTS.md'],
  );
  assert.equal(config.Presets.find((entry) => entry.id === PRESET.id)?.useForSummary, true);
  assert.equal(config.Presets.find((entry) => entry.id === CUSTOM_PRESET.id)?.useForSummary, false);

  editor.setDefaultSummaryPreset(PRESET.id, false);
  assert.equal(editor.getConfig().Presets.some((entry) => entry.useForSummary), false);
});

test('preset draft editor rejects missing presets and invalid autoload indices', () => {
  const editor = new DashboardPresetDraftEditor(DASHBOARD_CONFIG);

  assert.throws(
    () => editor.setLabel('missing', 'Missing'),
    /Unknown preset: missing/u,
  );
  assert.throws(
    () => editor.setAutoloadFile(CUSTOM_PRESET.id, 0, 'missing.md'),
    /Invalid autoload file index 0 for preset deep-dive/u,
  );
  assert.throws(
    () => editor.removeAutoloadFile(CUSTOM_PRESET.id, -1),
    /Invalid autoload file index -1 for preset deep-dive/u,
  );
});

test('preset draft editor does not mutate the source config', () => {
  const editor = new DashboardPresetDraftEditor(DASHBOARD_CONFIG);
  editor.setLabel(CUSTOM_PRESET.id, 'Changed');

  assert.equal(CUSTOM_PRESET.label, 'Deep Dive');
  assert.equal(DASHBOARD_CONFIG.Presets[1]?.label, 'Deep Dive');
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  POLICY_MODE_OPTIONS,
  SETTINGS_SECTION_ORDER,
  SETTINGS_SECTIONS,
  SETTINGS_TOOLTIP_LABELS,
} from '../dashboard/src/settings-sections.ts';

test('settings section order matches the integrated layout', () => {
  assert.deepEqual(
    SETTINGS_SECTION_ORDER,
    ['general', 'tool-policy', 'presets', 'model-runtime', 'sampling', 'interactive', 'managed-llama'],
  );
});

test('settings tooltip labels include the documented fields', () => {
  assert.deepEqual(
    SETTINGS_TOOLTIP_LABELS,
    [
      'Version',
      'Backend',
      'Policy Mode',
      'Raw log retention',
      'Prompt prefix',
      'Operation mode tool policy',
      'Preset library',
      'Runtime model id',
      'llama.cpp Base URL',
      'Model path (.gguf)',
      'NumCtx',
      'MaxTokens',
      'Threads',
      'Flash attention',
      'Temperature',
      'TopP',
      'TopK',
      'MinP',
      'PresencePenalty',
      'RepetitionPenalty',
      'ParallelSlots',
      'Reasoning',
      'MinCharsForSummary',
      'MinLinesForSummary',
      'Interactive IdleTimeoutMs',
      'MaxTranscriptChars',
      'Wrapped commands',
      'Interactive enabled',
      'Interactive transcript retention',
      'Startup script path',
      'Shutdown script path',
      'StartupTimeoutMs',
      'HealthcheckTimeoutMs',
      'HealthcheckIntervalMs',
      'Managed llama verbose logging',
      'Additional llama.cpp args',
    ],
  );
});

test('every integrated settings field includes help text', () => {
  for (const sectionId of SETTINGS_SECTION_ORDER) {
    for (const field of SETTINGS_SECTIONS[sectionId].fields) {
      assert.equal(typeof field.helpText, 'string', `${sectionId}:${field.label} is missing help text`);
      assert.ok(field.helpText.trim().length > 0, `${sectionId}:${field.label} help text is empty`);
    }
  }
});

test('policy mode options match the supported UI choices', () => {
  assert.deepEqual(POLICY_MODE_OPTIONS, ['conservative', 'aggressive']);
});

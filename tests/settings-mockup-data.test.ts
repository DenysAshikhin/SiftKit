import assert from 'node:assert/strict';
import test from 'node:test';

import { SETTINGS_MOCKUP_SECTIONS, SETTINGS_MOCKUP_TOOLTIP_FIELDS } from '../dashboard/src/settings-mockup-data.ts';

test('settings mockup sections expose the expected group order', () => {
  assert.deepEqual(
    SETTINGS_MOCKUP_SECTIONS.map((section) => section.id),
    ['general', 'model-runtime', 'sampling', 'interactive', 'managed-llama'],
  );
});

test('settings mockup tooltip fields include documented explanatory labels', () => {
  assert.deepEqual(
    SETTINGS_MOCKUP_TOOLTIP_FIELDS,
    [
      'NumCtx',
      'MaxTokens',
      'Threads',
      'Temperature',
      'TopP',
      'TopK',
      'MinP',
      'PresencePenalty',
      'RepetitionPenalty',
      'ParallelSlots',
      'Reasoning',
      'Wrapped commands',
      'Interactive IdleTimeoutMs',
      'HealthcheckTimeoutMs',
      'HealthcheckIntervalMs',
    ],
  );
});

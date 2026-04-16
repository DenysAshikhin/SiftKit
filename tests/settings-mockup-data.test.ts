import assert from 'node:assert/strict';
import test from 'node:test';

import { SETTINGS_MOCKUP_SECTIONS, SETTINGS_MOCKUP_TOOLTIP_FIELDS } from '../dashboard/src/settings-mockup-data.ts';

test('settings mockup sections expose the expected group order', () => {
  assert.deepEqual(
    SETTINGS_MOCKUP_SECTIONS.map((section) => section.id),
    ['general', 'interactive', 'managed-llama'],
  );
});

test('settings mockup tooltip fields include documented explanatory labels', () => {
  assert.deepEqual(
    SETTINGS_MOCKUP_TOOLTIP_FIELDS,
    [
      'Wrapped commands',
      'Interactive IdleTimeoutMs',
      'Executable path',
      'Base URL',
      'Model path (.gguf)',
      'NumCtx',
      'GpuLayers',
      'BatchSize',
      'Temperature',
      'TopP',
      'ParallelSlots',
      'Reasoning',
      'ReasoningBudget',
      'HealthcheckTimeoutMs',
      'HealthcheckIntervalMs',
    ],
  );
});

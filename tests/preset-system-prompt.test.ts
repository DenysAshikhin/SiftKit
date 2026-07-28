import test from 'node:test';
import assert from 'node:assert/strict';

import { PresetSystemPromptComposer } from '../src/preset-system-prompt.js';

const context = {
  content: '--- Autoloaded file: rules.md ---\n\nLoaded rules.',
  warnings: [],
  hasAgentsMd: false,
  hasRepoFileListing: false,
  loadedFiles: ['rules.md'],
};

test('composer includes the preset prefix exactly once', () => {
  const composer = new PresetSystemPromptComposer('Preset instructions.', context);

  assert.equal(
    composer.compose('Base system prompt.'),
    [
      'Preset instructions.',
      'Base system prompt.',
      '--- Autoloaded file: rules.md ---\n\nLoaded rules.',
    ].join('\n\n'),
  );
});

test('composer places a genuine additional prefix after the preset prefix', () => {
  const composer = new PresetSystemPromptComposer('Preset instructions.', context);

  assert.equal(
    composer.compose('Base system prompt.', 'Benchmark addition.'),
    [
      'Preset instructions.',
      'Benchmark addition.',
      'Base system prompt.',
      '--- Autoloaded file: rules.md ---\n\nLoaded rules.',
    ].join('\n\n'),
  );
});

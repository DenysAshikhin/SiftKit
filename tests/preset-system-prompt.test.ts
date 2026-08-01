import test from 'node:test';
import assert from 'node:assert/strict';

import { PresetSystemPromptComposer } from '../src/preset-system-prompt.js';
import { longestCommonPrefixLength } from './helpers/common-prefix.js';

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
      '--- Autoloaded file: rules.md ---\n\nLoaded rules.',
      'Preset instructions.',
      'Base system prompt.',
    ].join('\n\n'),
  );
});

test('composer keeps the system context in the shared prefix when an additional prefix is added', () => {
  const composer = new PresetSystemPromptComposer('Preset instructions.', context);

  const withoutAdditional = composer.compose('Base system prompt.');
  const withAdditional = composer.compose('Base system prompt.', 'Benchmark addition.');

  assert.ok(
    longestCommonPrefixLength(withoutAdditional, withAdditional) >= context.content.length,
    `additional prefix shortened the shared prefix to `
    + `${longestCommonPrefixLength(withoutAdditional, withAdditional)} chars; `
    + `system context is ${context.content.length} chars`,
  );
});

test('composer places a genuine additional prefix last, below the system context', () => {
  const composer = new PresetSystemPromptComposer('Preset instructions.', context);

  assert.equal(
    composer.compose('Base system prompt.', 'Benchmark addition.'),
    [
      '--- Autoloaded file: rules.md ---\n\nLoaded rules.',
      'Preset instructions.',
      'Base system prompt.',
      'Benchmark addition.',
    ].join('\n\n'),
  );
});

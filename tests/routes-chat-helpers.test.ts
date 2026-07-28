import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  withEffectiveWebTools,
} from '../src/status-server/routes/chat.js';
import type { PresetToolName } from '../src/presets.js';

test('withEffectiveWebTools returns input unchanged when disabled', () => {
  const tools: PresetToolName[] = ['find_text'];
  assert.deepEqual(withEffectiveWebTools(tools, false), ['find_text']);
});

test('withEffectiveWebTools adds web tools without duplicates when enabled', () => {
  const result = withEffectiveWebTools(['web_search'], true);
  assert.deepEqual([...(result ?? [])].sort(), ['web_fetch', 'web_search']);
});

test('withEffectiveWebTools returns undefined input unchanged', () => {
  assert.equal(withEffectiveWebTools(undefined, true), undefined);
});

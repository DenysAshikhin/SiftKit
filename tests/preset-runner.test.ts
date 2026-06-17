import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectPresetRunKind } from '../src/status-server/preset-runner.js';

test('selectPresetRunKind maps summary presets to the summary runner', () => {
  assert.equal(selectPresetRunKind('summary'), 'summary');
});

test('selectPresetRunKind maps chat presets to the chat runner', () => {
  assert.equal(selectPresetRunKind('chat'), 'chat');
});

test('selectPresetRunKind routes plan and repo-search presets to the repo-search runner', () => {
  assert.equal(selectPresetRunKind('plan'), 'repo-search');
  assert.equal(selectPresetRunKind('repo-search'), 'repo-search');
});

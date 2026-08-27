import assert from 'node:assert/strict';
import test from 'node:test';

import { getToolActivityLabel } from '../../src/lib/tool-status';

test('getToolActivityLabel derives every lifecycle label from the structured activity kind', () => {
  assert.equal(getToolActivityLabel('read', 'running', 'ignored'), 'Reading files\u2026');
  assert.equal(getToolActivityLabel('read', 'completed', 'ignored'), 'Read files');
  assert.equal(getToolActivityLabel('read', 'failed', 'ignored'), 'File read failed');
  assert.equal(getToolActivityLabel('search', 'running', 'ignored'), 'Searching code\u2026');
  assert.equal(getToolActivityLabel('search', 'completed', 'ignored'), 'Searched code');
  assert.equal(getToolActivityLabel('search', 'failed', 'ignored'), 'Search failed');
  assert.equal(getToolActivityLabel('edit', 'running', 'ignored'), 'Editing files\u2026');
  assert.equal(getToolActivityLabel('edit', 'completed', 'ignored'), 'Edited files');
  assert.equal(getToolActivityLabel('edit', 'failed', 'ignored'), 'File edit failed');
  assert.equal(getToolActivityLabel('validate', 'running', 'ignored'), 'Validating project\u2026');
  assert.equal(getToolActivityLabel('validate', 'completed', 'ignored'), 'Validation complete');
  assert.equal(getToolActivityLabel('validate', 'failed', 'ignored'), 'Validation failed');
  assert.equal(getToolActivityLabel('web_search', 'running', 'ignored'), 'Fetching search results\u2026');
  assert.equal(getToolActivityLabel('web_search', 'completed', 'ignored'), 'Search complete');
  assert.equal(getToolActivityLabel('web_search', 'failed', 'ignored'), 'Search failed');
  assert.equal(getToolActivityLabel('command', 'running', 'ignored'), 'Running command\u2026');
  assert.equal(getToolActivityLabel('command', 'completed', 'ignored'), 'Command complete');
  assert.equal(getToolActivityLabel('command', 'failed', 'ignored'), 'Command failed');
});

test('getToolActivityLabel uses the web fetch URL only for its optional host detail', () => {
  const command = 'web_fetch url="https://example.com/iron"';
  assert.equal(getToolActivityLabel('web_fetch', 'running', command), 'Loading example.com\u2026');
  assert.equal(getToolActivityLabel('web_fetch', 'completed', command), 'example.com loaded');
  assert.equal(getToolActivityLabel('web_fetch', 'failed', command), 'Page load failed');
  assert.equal(getToolActivityLabel('web_fetch', 'running', 'web_fetch'), 'Loading page\u2026');
  assert.equal(getToolActivityLabel('web_fetch', 'completed', 'web_fetch'), 'Page loaded');
});

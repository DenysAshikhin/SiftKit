import assert from 'node:assert/strict';
import test from 'node:test';

import { getToolActivityKind } from '../src/repo-search/tool-activity.js';

test('getToolActivityKind derives activity from validated native tool identity', () => {
  assert.equal(getToolActivityKind({ toolName: 'read', args: { path: 'src/main.ts' } }), 'read');
  assert.equal(getToolActivityKind({ toolName: 'grep', args: { pattern: 'target' } }), 'search');
  assert.equal(getToolActivityKind({ toolName: 'find', args: { pattern: '*.ts' } }), 'search');
  assert.equal(getToolActivityKind({ toolName: 'ls', args: {} }), 'search');
  assert.equal(getToolActivityKind({ toolName: 'git', args: { operation: 'diff' } }), 'search');
  assert.equal(getToolActivityKind({ toolName: 'write', args: { path: 'x', content: 'y' } }), 'edit');
  assert.equal(getToolActivityKind({ toolName: 'edit', args: { path: 'x', edits: [{ oldText: 'a', newText: 'b' }] } }), 'edit');
  assert.equal(getToolActivityKind({ toolName: 'web_search', args: { query: 'query' } }), 'web_search');
  assert.equal(getToolActivityKind({ toolName: 'web_fetch', args: { url: 'https://example.com' } }), 'web_fetch');
});

test('getToolActivityKind reuses validation-command recognition for run tools', () => {
  assert.equal(getToolActivityKind({ toolName: 'run', args: { command: 'npm test' } }), 'validate');
  assert.equal(getToolActivityKind({ toolName: 'run', args: { command: 'npm run build' } }), 'validate');
  assert.equal(getToolActivityKind({ toolName: 'run', args: { command: 'node script.js' } }), 'command');
});

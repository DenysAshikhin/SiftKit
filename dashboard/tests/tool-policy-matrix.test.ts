import test from 'node:test';
import assert from 'node:assert/strict';
import { buildToolPolicyMatrixRows, toggleToolInMode, TOOL_POLICY_GROUPS } from '../src/lib/tool-policy-matrix';
import type { DashboardOperationModeAllowedTools } from '../src/types';

const ALLOWED: DashboardOperationModeAllowedTools = {
  summary: ['find_text', 'read_lines'],
  'read-only': ['find_text', 'read_lines', 'grep'],
  full: ['find_text', 'read_lines', 'grep', 'web_search'],
};

test('groups follow the mockup group order', () => {
  const groups = buildToolPolicyMatrixRows(ALLOWED);
  assert.deepEqual(groups.map((group) => group.title), ['Text & JSON', 'Repository', 'Object pipeline', 'Formatting', 'Web']);
  assert.equal(TOOL_POLICY_GROUPS.length, 5);
});

test('rows reflect per-mode membership', () => {
  const groups = buildToolPolicyMatrixRows(ALLOWED);
  const findText = groups[0]?.rows.find((row) => row.tool === 'find_text');
  assert.deepEqual({ s: findText?.summary, r: findText?.readOnly, f: findText?.full }, { s: true, r: true, f: true });
  const repoRg = groups[1]?.rows.find((row) => row.tool === 'grep');
  assert.deepEqual({ s: repoRg?.summary, r: repoRg?.readOnly, f: repoRg?.full }, { s: false, r: true, f: true });
  const webSearch = groups[4]?.rows.find((row) => row.tool === 'web_search');
  assert.deepEqual({ s: webSearch?.summary, r: webSearch?.readOnly, f: webSearch?.full }, { s: false, r: false, f: true });
});

test('toggleToolInMode adds and removes via togglePresetTool', () => {
  const added = toggleToolInMode(ALLOWED, 'grep', 'summary');
  assert.ok(added.includes('grep'));
  const removed = toggleToolInMode(ALLOWED, 'find_text', 'summary');
  assert.ok(!removed.includes('find_text'));
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { getToolActivity } from '../src/repo-search/tool-activity.js';

test('getToolActivity derives kind and concise subject from validated native tool identity', () => {
  assert.deepEqual(getToolActivity({ toolName: 'read', args: { path: 'dashboard/src/tabs/ChatTab.tsx' } }), {
    activityKind: 'read', activitySubject: { kind: 'file', value: 'ChatTab.tsx' },
  });
  assert.deepEqual(getToolActivity({ toolName: 'write', args: { path: 'src\\main.ts', content: 'y' } }), {
    activityKind: 'edit', activitySubject: { kind: 'file', value: 'main.ts' },
  });
  assert.deepEqual(getToolActivity({ toolName: 'edit', args: { path: 'x.ts', edits: [{ oldText: 'a', newText: 'b' }] } }), {
    activityKind: 'edit', activitySubject: { kind: 'file', value: 'x.ts' },
  });
  assert.deepEqual(getToolActivity({ toolName: 'web_fetch', args: { url: 'https://example.com/docs' } }), {
    activityKind: 'web_fetch', activitySubject: { kind: 'host', value: 'example.com' },
  });
  assert.deepEqual(getToolActivity({ toolName: 'grep', args: { pattern: 'target' } }), {
    activityKind: 'search', activitySubject: { kind: 'none' },
  });
  assert.deepEqual(getToolActivity({ toolName: 'web_search', args: { query: 'query' } }), {
    activityKind: 'web_search', activitySubject: { kind: 'none' },
  });
});

test('getToolActivity reuses validation-command recognition and leaves commands targetless', () => {
  assert.deepEqual(getToolActivity({ toolName: 'run', args: { command: 'npm test' } }), {
    activityKind: 'validate', activitySubject: { kind: 'none' },
  });
  assert.deepEqual(getToolActivity({ toolName: 'run', args: { command: 'node script.js' } }), {
    activityKind: 'command', activitySubject: { kind: 'none' },
  });
});

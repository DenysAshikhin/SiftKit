import test from 'node:test';
import assert from 'node:assert/strict';

import { TurnCommandResultEventSchema } from '../src/repo-search/live-snapshot/schemas.js';

test('TurnCommandResultEventSchema accepts a rejected command with a null exit code', () => {
  const parsed = TurnCommandResultEventSchema.safeParse({
    turn: 4,
    command: 'web_search query="x"',
    toolName: 'web_search',
    exitCode: null,
    output: 'Rejected command: No web search provider configured.',
    rejected: true,
    rejectionReason: 'No web search provider configured.',
  });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(parsed.data.toolName, 'web_search');
  assert.equal(parsed.data.rejected, true);
  assert.equal(parsed.data.exitCode, null);
});

test('TurnCommandResultEventSchema still accepts a plain executed result', () => {
  const parsed = TurnCommandResultEventSchema.safeParse({
    turn: 1,
    command: 'grep pattern="x"',
    exitCode: 0,
    output: 'hit',
    resultTokenCount: 12,
  });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(parsed.data.rejected, undefined);
  assert.equal(parsed.data.toolName, undefined);
});

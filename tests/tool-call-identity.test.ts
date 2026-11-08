import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBatchToolCallId,
  resolveToolActionIdentity,
} from '../src/repo-search/engine/pending-tool-call-message.ts';
import type { AgentLoopToolAction } from '../src/agent-loop/types.ts';

test('tool-call ids depend only on turn and batch index', () => {
  assert.equal(buildBatchToolCallId(3, 0), 't3_c0');
  assert.equal(buildBatchToolCallId(3, 1), 't3_c1');
  assert.notEqual(buildBatchToolCallId(3, 0), buildBatchToolCallId(4, 0));
});

test('a typed Git tool resolves to its native normalized identity', () => {
  const toolAction = {
    kind: 'tool', callId: 'provider-status', toolName: 'git', args: { operation: 'status' },
  } satisfies AgentLoopToolAction;

  assert.deepEqual(resolveToolActionIdentity(toolAction), {
    normalizedToolName: 'git',
    isNativeTool: true,
    rawArgs: { operation: 'status' },
  });
});

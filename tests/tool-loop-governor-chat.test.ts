import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFinishAttempt } from '../src/tool-loop-governor.js';

const anchoredOutput = 'See src/foo.ts:42 for details.';
const oneSupportingCall = [{ toolName: 'read', promptResultText: 'src/foo.ts:42 export const x = 1;' }];

test('repo-search rejects anchored finish with a single supporting tool call', () => {
  const result = evaluateFinishAttempt({ loopKind: 'repo-search', finalOutput: anchoredOutput, successfulToolCalls: oneSupportingCall });
  assert.equal(result.allowed, false);
});

test('chat allows the same finish (no repo-evidence coercion)', () => {
  const result = evaluateFinishAttempt({ loopKind: 'chat', finalOutput: anchoredOutput, successfulToolCalls: oneSupportingCall });
  assert.equal(result.allowed, true);
});

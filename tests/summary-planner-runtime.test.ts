import * as assert from 'node:assert/strict';
import test from 'node:test';

import type { SummaryPlannerLoopController } from '../src/summary/planner/agent-loop-adapter.js';
import {
  SummaryPlannerCompletionState,
  SummaryPlannerLoopRuntime,
  SummaryPlannerTranscriptState,
} from '../src/summary/planner/mode.js';

test('SummaryPlannerLoopRuntime keeps the existing controller surface', () => {
  type RuntimeIsController = SummaryPlannerLoopRuntime extends SummaryPlannerLoopController ? true : false;
  const runtimeIsController: RuntimeIsController = true;

  assert.equal(runtimeIsController, true);
});

test('SummaryPlannerCompletionState records completed and failed planner outcomes', () => {
  const completion = new SummaryPlannerCompletionState();

  assert.equal(completion.isFinished(), false);
  completion.complete({
    classification: 'summary',
    rawReviewRequired: false,
    output: 'done',
  });

  assert.equal(completion.isFinished(), true);
  assert.deepEqual(completion.getDecision(), {
    classification: 'summary',
    rawReviewRequired: false,
    output: 'done',
  });

  completion.fail();
  assert.equal(completion.isFinished(), true);
  assert.equal(completion.getDecision(), null);
});

test('SummaryPlannerTranscriptState owns mutable planner transcript state', () => {
  const transcript = new SummaryPlannerTranscriptState({
    messages: [],
    toolResults: [],
    inputText: 'first\r\nsecond\nthird',
  });

  assert.equal(transcript.getToolResultCount(), 0);
  assert.deepEqual(transcript.inputLines, ['first', 'second', 'third']);

  transcript.toolResults.push({
    toolName: 'read_lines',
    args: { startLine: 1, endLine: 1 },
    result: { text: 'first' },
    resultText: '1: first',
  });

  assert.equal(transcript.getToolResultCount(), 1);
});

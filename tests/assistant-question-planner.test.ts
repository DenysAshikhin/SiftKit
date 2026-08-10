import assert from 'node:assert/strict';
import test from 'node:test';

import { StructuredOutputRunner } from '../src/assistant/inference/structured-runner.js';
import { QuestionPlanner } from '../src/assistant/questions/planner.js';
import type { QuestionCandidate } from '../src/assistant/questions/candidates.js';
import { FakeAssistantInference } from './helpers/assistant-inference-fake.js';

const candidate: QuestionCandidate = {
  id: 'qc_1', ownerId: 'owner_local', topicKey: 'shell',
  questionType: 'confirm_inference', gapType: 'candidate_confirmation',
  candidateIds: ['cand_1'], concreteBenefit: 'Improve future shell answers.',
  uncertaintyReduction: 0.8, futureUsefulness: 0.9, currentRelevance: 0.8,
  answerability: 0.9, interruptionCost: 0.1, sensitivityCost: 0.1,
  repeatPenalty: 0, expiresAtUtc: '2026-08-12T00:00:00.000Z',
};

test('planner produces text only from policy-approved structured facts', async () => {
  const inference = new FakeAssistantInference([
    JSON.stringify({ questionText: 'Should I remember that you prefer PowerShell?' }),
  ]);
  const result = await new QuestionPlanner(new StructuredOutputRunner(inference))
    .plan(candidate, new AbortController().signal);
  assert.deepEqual(result, { questionText: 'Should I remember that you prefer PowerShell?' });
  assert.equal(inference.requests[0]?.role, 'question_planner');
  const sent = inference.requests[0]?.userText ?? '';
  assert.ok(sent.includes('confirm_inference'));
  assert.ok(sent.includes('shell'));
  assert.ok(!sent.includes('uncertaintyReduction'));
  assert.ok(!sent.includes('expiresAtUtc'));
});

test('planner retries malformed output once and rejects a second malformed result', async () => {
  const repaired = new FakeAssistantInference([
    '{}', JSON.stringify({ questionText: 'Can you clarify this preference?' }),
  ]);
  const result = await new QuestionPlanner(new StructuredOutputRunner(repaired))
    .plan(candidate, new AbortController().signal);
  assert.equal(result.questionText, 'Can you clarify this preference?');
  assert.equal(repaired.requests.length, 2);

  const invalid = new QuestionPlanner(new StructuredOutputRunner(
    new FakeAssistantInference(['{}', '{}']),
  ));
  await assert.rejects(
    invalid.plan(candidate, new AbortController().signal),
    /question planner output/i,
  );
});

test('planner honors cancellation without issuing inference', async () => {
  const inference = new FakeAssistantInference([]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    new QuestionPlanner(new StructuredOutputRunner(inference)).plan(candidate, controller.signal),
    /aborted/i,
  );
  assert.equal(inference.requests.length, 0);
});

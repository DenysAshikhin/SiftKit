import test from 'node:test';
import assert from 'node:assert/strict';

import { withAssistantContext } from './helpers/assistant-fixture.js';

const NOW = '2026-08-05T09:00:00.000Z';

test('QuestionStore creates, orders, transitions, and deduplicates live topics', () => {
  withAssistantContext(({ graph, ownerId, clock }) => {
    const first = graph.questions.create({
      ownerId, topicKey: 'project:siftkit', questionText: 'Is SiftKit active?',
      questionType: 'confirm_inference', candidateIds: ['cand_1'],
      expectedValue: 0.9, interruptionCost: 0.1, eligibleAfterUtc: null,
      expiresAtUtc: '2026-08-12T09:00:00.000Z',
    });
    assert.equal(first.status, 'planned');
    assert.deepEqual(graph.questions.readCandidateIds(first), ['cand_1']);
    assert.equal(graph.questions.findLiveByTopic(ownerId, 'project:siftkit')?.id, first.id);
    assert.throws(() => graph.questions.create({
      ownerId, topicKey: 'project:siftkit', questionText: 'Duplicate?',
      questionType: 'confirm_inference', candidateIds: [], expectedValue: 0.5,
      interruptionCost: 0.2, eligibleAfterUtc: null, expiresAtUtc: null,
    }), /live question already exists/);

    graph.questions.markEligible(first.id, NOW);
    clock.advanceSeconds(1);
    graph.questions.markShown(first.id);
    const evidence = graph.evidence.recordTextEvidence({
      ownerId, deviceId: null, sourceEventId: 'answer_1', parentEvidenceId: null,
      sourceType: 'question_answer', sourceRef: first.id, capturedAtUtc: clock.nowUtc(),
      sourceTimezone: null, sensitivity: 'personal', retentionUntilUtc: null,
      metadata: {}, text: 'Yes.',
    });
    const answered = graph.questions.answer(first.id, evidence.id);
    assert.equal(answered.status, 'answered');
    assert.equal(answered.answer_evidence_id, evidence.id);
    assert.equal(graph.questions.findLiveByTopic(ownerId, 'project:siftkit'), null);
    assert.equal(graph.questions.listPending(ownerId).length, 0);
  });
});

test('QuestionStore snoozes, expires due questions, and records feedback', () => {
  withAssistantContext(({ graph, ownerId, clock }) => {
    const question = graph.questions.create({
      ownerId, topicKey: 'goal:release', questionText: 'What is next?',
      questionType: 'follow_active_goal', candidateIds: [], expectedValue: 0.7,
      interruptionCost: 0.2, eligibleAfterUtc: NOW,
      expiresAtUtc: '2026-08-05T10:00:00.000Z',
    });
    graph.questions.markEligible(question.id, NOW);
    const snoozed = graph.questions.snooze(question.id, '2026-08-05T09:30:00.000Z');
    assert.equal(snoozed.status, 'snoozed');
    assert.equal(snoozed.eligible_after_utc, '2026-08-05T09:30:00.000Z');

    const feedback = graph.questions.recordFeedback({
      ownerId, questionId: question.id, feedbackType: 'snooze',
      value: { untilUtc: '2026-08-05T09:30:00.000Z' },
    });
    assert.equal(feedback.feedback_type, 'snooze');
    assert.deepEqual(graph.questions.readFeedbackValue(feedback), {
      untilUtc: '2026-08-05T09:30:00.000Z',
    });

    clock.advanceSeconds(3_600);
    assert.equal(graph.questions.expireDue(ownerId), 1);
    assert.equal(graph.questions.requireQuestion(question.id).status, 'expired');
    assert.equal(graph.questions.listFeedback(ownerId, question.id).length, 1);
  });
});

test('countPending matches listPending length', () => {
  withAssistantContext(({ graph, ownerId, clock }) => {
    const base = {
      questionType: 'confirm_inference', candidateIds: [], expectedValue: 0.5,
      interruptionCost: 0.1, eligibleAfterUtc: null, expiresAtUtc: null,
    } as const;
    graph.questions.create({ ownerId, topicKey: 'topic:a', questionText: 'A?', ...base });
    graph.questions.create({ ownerId, topicKey: 'topic:b', questionText: 'B?', ...base });
    const answered = graph.questions.create({
      ownerId, topicKey: 'topic:c', questionText: 'C?', ...base,
    });
    graph.questions.markEligible(answered.id, NOW);
    graph.questions.markShown(answered.id);
    const evidence = graph.evidence.recordTextEvidence({
      ownerId, deviceId: null, sourceEventId: 'answer_c', parentEvidenceId: null,
      sourceType: 'question_answer', sourceRef: answered.id, capturedAtUtc: clock.nowUtc(),
      sourceTimezone: null, sensitivity: 'personal', retentionUntilUtc: null,
      metadata: {}, text: 'Yes.',
    });
    graph.questions.answer(answered.id, evidence.id);
    assert.equal(graph.questions.countPending(ownerId), graph.questions.listPending(ownerId).length);
    assert.equal(graph.questions.countPending(ownerId), 2);
  });
});

test('QuestionStore rejects illegal transitions loudly', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const question = graph.questions.create({
      ownerId, topicKey: 'topic', questionText: 'Question?', questionType: 'clarify_scope',
      candidateIds: [], expectedValue: 0.5, interruptionCost: 0.1,
      eligibleAfterUtc: null, expiresAtUtc: null,
    });
    assert.throws(() => graph.questions.markShown(question.id), /planned.*shown/);
  });
});

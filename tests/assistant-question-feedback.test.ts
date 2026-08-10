import assert from 'node:assert/strict';
import test from 'node:test';

import { SecretScanner } from '../src/assistant/domain/secrets.js';
import { StructuredOutputRunner } from '../src/assistant/inference/structured-runner.js';
import { CandidateGate } from '../src/assistant/ingestion/candidate-gate.js';
import { CandidatePromoter } from '../src/assistant/ingestion/candidate-promoter.js';
import { ConversationExtractor } from '../src/assistant/ingestion/conversation-extractor.js';
import { QuestionAnswerIngestor } from '../src/assistant/questions/answer-ingestor.js';
import {
  QuestionFeedbackService,
  type AssistantQuestionConfigWriter,
} from '../src/assistant/questions/feedback-service.js';
import { FakeAssistantInference } from './helpers/assistant-inference-fake.js';
import { withAssistantContext, withAssistantContextAsync } from './helpers/assistant-fixture.js';

class RecordingConfigWriter implements AssistantQuestionConfigWriter {
  schedule: readonly [string, string] | null = null;
  limits: readonly [number, number] | null = null;
  setQuestionSchedule(start: string, end: string): void { this.schedule = [start, end]; }
  setQuestionRateLimits(day: number, week: number): void { this.limits = [day, week]; }
}

test('answer atomically records evidence, feedback, status, and an idempotent job', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const question = graph.questions.create({
      ownerId, topicKey: 'shell', questionText: 'Preferred shell?',
      questionType: 'confirm_inference', candidateIds: ['cand_1'],
      expectedValue: 0.8, interruptionCost: 0.1,
      eligibleAfterUtc: null, expiresAtUtc: '2026-08-12T09:00:00.000Z',
    });
    graph.questions.markEligible(question.id, graph.nowUtc());
    const service = new QuestionFeedbackService(
      graph, new SecretScanner(), new RecordingConfigWriter(), 850,
    );
    const first = service.answer({ ownerId, questionId: question.id, answer: 'PowerShell 7.' });
    assert.equal(first.kind, 'accepted');
    assert.equal(graph.questions.requireQuestion(question.id).status, 'answered');
    assert.equal(graph.questions.listFeedback(ownerId, question.id).length, 1);
    assert.equal(graph.jobs.countByStatus(ownerId, 'queued'), 1);
    const evidence = graph.evidence.requireEvidence(first.evidenceId);
    assert.equal(evidence.source_type, 'question_answer');

    const replay = service.answer({ ownerId, questionId: question.id, answer: 'PowerShell 7.' });
    assert.deepEqual(replay, { kind: 'duplicate', evidenceId: first.evidenceId });
    assert.equal(graph.questions.listFeedback(ownerId, question.id).length, 1);
    assert.equal(graph.jobs.countByStatus(ownerId, 'queued'), 1);
  });
});

test('question answer ingestion priority refreshes without recreating the service', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const question = graph.questions.create({
      ownerId, topicKey: 'priority', questionText: 'Priority?',
      questionType: 'confirm_inference', candidateIds: [], expectedValue: 0.8,
      interruptionCost: 0.1, eligibleAfterUtc: null,
      expiresAtUtc: '2026-08-12T09:00:00.000Z',
    });
    const service = new QuestionFeedbackService(
      graph, new SecretScanner(), new RecordingConfigWriter(), 850,
    );
    service.refreshAnswerIngestionPriority(975);
    const outcome = service.answer({ ownerId, questionId: question.id, answer: 'Use it.' });
    assert.equal(outcome.kind, 'accepted');
    if (outcome.kind !== 'accepted') return;
    assert.equal(graph.jobs.requireJob(outcome.jobId).priority, 975);
  });
});

test('empty and secret answers are rejected before any write', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const question = graph.questions.create({
      ownerId, topicKey: 'shell', questionText: 'Preferred shell?',
      questionType: 'confirm_inference', candidateIds: [], expectedValue: 0.8,
      interruptionCost: 0.1, eligibleAfterUtc: null,
      expiresAtUtc: '2026-08-12T09:00:00.000Z',
    });
    const service = new QuestionFeedbackService(
      graph, new SecretScanner(), new RecordingConfigWriter(), 850,
    );
    assert.throws(
      () => service.answer({ ownerId, questionId: question.id, answer: '   ' }),
      /empty/i,
    );
    assert.throws(
      () => service.answer({
        ownerId, questionId: question.id,
        answer: 'api_key=abcdefghijklmnop123456789',
      }),
      /secret/i,
    );
    assert.equal(graph.questions.listFeedback(ownerId, question.id).length, 0);
    assert.equal(graph.jobs.countByStatus(ownerId, 'queued'), 0);
  });
});

test('skip, snooze, do-not-repeat, block-topic, and config feedback are durable', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const writer = new RecordingConfigWriter();
    const service = new QuestionFeedbackService(graph, new SecretScanner(), writer, 850);
    const makeQuestion = (topicKey: string) => graph.questions.create({
      ownerId, topicKey, questionText: 'Question?', questionType: 'confirm_inference',
      candidateIds: [], expectedValue: 0.8, interruptionCost: 0.1,
      eligibleAfterUtc: null, expiresAtUtc: '2026-08-12T09:00:00.000Z',
    });
    const skipped = makeQuestion('skip');
    service.skip(ownerId, skipped.id);
    assert.equal(graph.questions.requireQuestion(skipped.id).status, 'dismissed');

    const snoozed = makeQuestion('snooze');
    assert.throws(
      () => service.snooze(ownerId, snoozed.id, graph.nowUtc()),
      /future/i,
    );
    service.snooze(ownerId, snoozed.id, '2026-08-06T09:00:00.000Z');
    assert.equal(graph.questions.requireQuestion(snoozed.id).status, 'snoozed');

    const repeated = makeQuestion('repeat');
    service.doNotRepeat(ownerId, repeated.id);
    assert.equal(graph.policies.isTopicBlockedFromInference(ownerId, 'repeat'), true);
    const blocked = makeQuestion('finance');
    service.blockTopic(ownerId, blocked.id);
    assert.equal(graph.policies.isTopicBlockedFromInference(ownerId, 'finance'), true);

    service.changeSchedule(ownerId, '20:00', '23:00');
    service.changeRateLimit(ownerId, 2, 5);
    assert.deepEqual(writer.schedule, ['20:00', '23:00']);
    assert.deepEqual(writer.limits, [2, 5]);
  });
});

test('question answer ingestion fixes promoted memory basis to explicit question answer', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    const evidence = graph.evidence.recordTextEvidence({
      ownerId, deviceId: null, parentEvidenceId: null, sourceType: 'question_answer',
      sourceEventId: 'question:q1:answer', sourceRef: 'q1', capturedAtUtc: graph.nowUtc(),
      sourceTimezone: null, sensitivity: 'personal', retentionUntilUtc: null,
      metadata: { questionId: 'q1' }, text: 'I am a developer.',
    });
    const inference = new FakeAssistantInference([JSON.stringify({ statements: [{
      statementKind: 'direct_fact',
      subject: { nodeType: 'person', displayName: 'the user' },
      predicate: 'HAS_ROLE',
      object: { kind: 'literal', valueType: 'string', value: 'developer' },
      scope: null, validFromUtc: null, validToUtc: null,
      rationale: 'The user answered that they are a developer.', suggestedConfidence: 0.9,
    }] })]);
    const extractor = new ConversationExtractor(graph, new StructuredOutputRunner(inference));
    const promoter = new CandidatePromoter(
      graph, new CandidateGate(graph.policies, new SecretScanner()),
    );
    const result = await new QuestionAnswerIngestor(extractor, promoter).ingest(
      ownerId, evidence.id, new AbortController().signal,
    );
    assert.equal(result.promotions[0]?.kind, 'promoted');
    const assertion = graph.assertions.list(ownerId, 10, 0)[0];
    assert.equal(assertion?.basis, 'explicit_question_answer');
  });
});

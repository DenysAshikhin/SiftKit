import test from 'node:test';
import assert from 'node:assert/strict';

import { CandidateGate } from '../src/assistant/ingestion/candidate-gate.js';
import { CandidatePromoter } from '../src/assistant/ingestion/candidate-promoter.js';
import { SecretScanner } from '../src/assistant/domain/secrets.js';
import { LIVE_ASSERTION_STATUSES } from '../src/assistant/storage/assertion-store.js';
import { withAssistantContext } from './helpers/assistant-fixture.js';

test('a direct fact becomes a live assertion with its evidence linked', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const evidence = graph.evidence.recordTextEvidence({
      ownerId, deviceId: null, sourceType: 'conversation_message', parentEvidenceId: null,
      sourceEventId: 'chat_1:msg_1', sourceRef: 'chat_1', sourceTimezone: null,
      capturedAtUtc: '2026-08-05T09:00:00.000Z', sensitivity: 'personal',
      retentionUntilUtc: null, metadata: {}, text: 'I use PowerShell.',
    });
    const observation = graph.observations.record({
      ownerId, evidenceId: evidence.id, observationType: 'conversation_statement',
      payload: {}, confidence: 0.9, sensitivity: 'personal',
      extractorName: 'conversation_memory_extractor', extractorVersion: '1',
    });
    const candidate = graph.candidates.propose({
      ownerId, observationId: observation.id,
      subject: { nodeType: 'person', displayName: 'the user' },
      predicate: 'USES',
      object: { kind: 'unresolved', nodeType: 'software', displayName: 'PowerShell' },
      scope: null, basis: 'explicit_user_statement', confidence: 0.9, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, rationale: 'User said "I use PowerShell".',
    });
    const promoter = new CandidatePromoter(graph, new CandidateGate(graph.policies, new SecretScanner()));
    const outcome = promoter.promote({ ownerId, candidateId: candidate?.id ?? '' });

    assert.equal(outcome.kind, 'promoted');
    const assertionId = outcome.kind === 'promoted' ? outcome.assertionId : '';
    const row = graph.assertions.requireAssertion(assertionId);
    assert.equal(row.predicate, 'USES');
    assert.equal(row.status, 'active');
    assert.equal(graph.candidates.requireCandidate(candidate?.id ?? '').status, 'accepted');
    assert.deepEqual(
      graph.assertions.listEvidence(assertionId).map((link) => link.evidence_id),
      [evidence.id],
    );
    assert.equal(graph.nodes.requireNode(row.subject_node_id).type, 'person');
  });
});

test('a correction supersedes the prior assertion instead of coexisting', () => {
  withAssistantContext(({ graph, ownerId, clock }) => {
    const promoter = new CandidatePromoter(graph, new CandidateGate(graph.policies, new SecretScanner()));
    const promoteStatement = (
      text: string, objectName: string, observationType: 'conversation_statement' | 'conversation_correction',
      sourceEventId: string,
    ): string => {
      const evidence = graph.evidence.recordTextEvidence({
        ownerId, deviceId: null, sourceType: 'conversation_message', parentEvidenceId: null,
        sourceEventId, sourceRef: 'chat_1', sourceTimezone: null,
        capturedAtUtc: clock.nowUtc(), sensitivity: 'personal',
        retentionUntilUtc: null, metadata: {}, text,
      });
      const observation = graph.observations.record({
        ownerId, evidenceId: evidence.id, observationType, payload: {}, confidence: 0.9,
        sensitivity: 'personal', extractorName: 'conversation_memory_extractor',
        extractorVersion: '1',
      });
      const candidate = graph.candidates.propose({
        ownerId, observationId: observation.id,
        subject: { nodeType: 'person', displayName: 'the user' },
        predicate: 'PREFERS',
        object: { kind: 'unresolved', nodeType: 'software', displayName: objectName },
        scope: null, basis: 'explicit_user_statement', confidence: 0.9, sensitivity: 'personal',
        validFromUtc: null, validToUtc: null, rationale: text,
      });
      const outcome = promoter.promote({ ownerId, candidateId: candidate?.id ?? '' });
      return outcome.kind === 'promoted' ? outcome.assertionId : '';
    };

    const firstId = promoteStatement('I prefer PowerShell.', 'PowerShell', 'conversation_statement', 'chat_1:m1');
    clock.advanceSeconds(60);
    const secondId = promoteStatement('No, I meant Bash.', 'Bash', 'conversation_correction', 'chat_1:m2');

    assert.notEqual(firstId, secondId);
    assert.equal(graph.assertions.requireAssertion(firstId).status, 'superseded');
    assert.equal(graph.assertions.requireAssertion(secondId).status, 'active');
    const live = graph.assertions
      .listBySubject(ownerId, graph.assertions.requireAssertion(secondId).subject_node_id, LIVE_ASSERTION_STATUSES)
      .filter((row) => row.predicate === 'PREFERS');
    assert.equal(live.length, 1);
  });
});

test('a gate rejection marks the candidate rejected and writes no assertion', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const evidence = graph.evidence.recordTextEvidence({
      ownerId, deviceId: null, sourceType: 'conversation_message', parentEvidenceId: null,
      sourceEventId: 'chat_1:msg_9', sourceRef: 'chat_1', sourceTimezone: null,
      capturedAtUtc: '2026-08-05T09:00:00.000Z', sensitivity: 'personal',
      retentionUntilUtc: null, metadata: {}, text: 'noise',
    });
    const observation = graph.observations.record({
      ownerId, evidenceId: evidence.id, observationType: 'conversation_statement',
      payload: {}, confidence: 0.9, sensitivity: 'personal',
      extractorName: 'conversation_memory_extractor', extractorVersion: '1',
    });
    const candidate = graph.candidates.propose({
      ownerId, observationId: observation.id,
      subject: { nodeType: 'person', displayName: 'the user' },
      predicate: 'USES',
      object: { kind: 'literal', valueType: 'string', value: 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB' },
      scope: null, basis: 'explicit_user_statement', confidence: 0.9, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, rationale: 'leaked token',
    });
    const promoter = new CandidatePromoter(graph, new CandidateGate(graph.policies, new SecretScanner()));
    const outcome = promoter.promote({ ownerId, candidateId: candidate?.id ?? '' });
    assert.equal(outcome.kind, 'rejected');
    assert.equal(graph.candidates.requireCandidate(candidate?.id ?? '').status, 'rejected');
  });
});

test('a candidate needing confirmation is parked, not written', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const evidence = graph.evidence.recordTextEvidence({
      ownerId, deviceId: null, sourceType: 'conversation_message', parentEvidenceId: null,
      sourceEventId: 'chat_1:msg_10', sourceRef: 'chat_1', sourceTimezone: null,
      capturedAtUtc: '2026-08-05T09:00:00.000Z', sensitivity: 'sensitive',
      retentionUntilUtc: null, metadata: {}, text: 'inferred health note',
    });
    const observation = graph.observations.record({
      ownerId, evidenceId: evidence.id, observationType: 'conversation_statement',
      payload: {}, confidence: 0.7, sensitivity: 'sensitive',
      extractorName: 'conversation_memory_extractor', extractorVersion: '1',
    });
    const candidate = graph.candidates.propose({
      ownerId, observationId: observation.id,
      subject: { nodeType: 'person', displayName: 'the user' },
      predicate: 'INTERESTED_IN',
      object: { kind: 'unresolved', nodeType: 'health_topic', displayName: 'a new medication from my doctor' },
      scope: null, basis: 'assistant_inference', confidence: 0.7, sensitivity: 'sensitive',
      validFromUtc: null, validToUtc: null, rationale: 'inferred from context',
    });
    const promoter = new CandidatePromoter(graph, new CandidateGate(graph.policies, new SecretScanner()));
    const outcome = promoter.promote({ ownerId, candidateId: candidate?.id ?? '' });
    assert.equal(outcome.kind, 'needs_confirmation');
    assert.equal(graph.candidates.requireCandidate(candidate?.id ?? '').status, 'needs_confirmation');
  });
});
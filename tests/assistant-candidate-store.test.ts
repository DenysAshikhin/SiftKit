import test from 'node:test';
import assert from 'node:assert/strict';

import { withAssistantContext } from './helpers/assistant-fixture.js';

test('an observation is stored against its evidence with its extractor identity', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const evidence = graph.evidence.recordTextEvidence({
      ownerId, deviceId: null, sourceType: 'conversation_message', parentEvidenceId: null,
      sourceEventId: 'chat_1:msg_1', sourceRef: 'chat_1', sourceTimezone: null,
      capturedAtUtc: '2026-08-05T09:00:00.000Z', sensitivity: 'personal',
      retentionUntilUtc: null, metadata: {}, text: 'I use PowerShell on Windows.',
    });
    const observation = graph.observations.record({
      ownerId, evidenceId: evidence.id, observationType: 'conversation_statement',
      payload: { text: 'I use PowerShell on Windows.' }, confidence: 0.9,
      sensitivity: 'personal', extractorName: 'conversation_memory_extractor',
      extractorVersion: '1',
    });
    assert.equal(observation.evidence_id, evidence.id);
    assert.equal(observation.extractor_name, 'conversation_memory_extractor');
    assert.deepEqual(
      graph.observations.listByEvidence(evidence.id).map((row) => row.id),
      [observation.id],
    );
    assert.deepEqual(
      graph.observations.readPayload(observation),
      { text: 'I use PowerShell on Windows.' },
    );
  });
});

test('a candidate is stored pending and is unique per fingerprint and observation', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const evidence = graph.evidence.recordTextEvidence({
      ownerId, deviceId: null, sourceType: 'conversation_message', parentEvidenceId: null,
      sourceEventId: 'chat_1:msg_1', sourceRef: 'chat_1', sourceTimezone: null,
      capturedAtUtc: '2026-08-05T09:00:00.000Z', sensitivity: 'personal',
      retentionUntilUtc: null, metadata: {}, text: 'I use PowerShell.',
    });
    const observation = graph.observations.record({
      ownerId, evidenceId: evidence.id, observationType: 'conversation_statement',
      payload: { text: 'I use PowerShell.' }, confidence: 0.9, sensitivity: 'personal',
      extractorName: 'conversation_memory_extractor', extractorVersion: '1',
    });
    const input = {
      ownerId, observationId: observation.id,
      subject: { nodeType: 'person', displayName: 'the user' },
      predicate: 'USES',
      object: { kind: 'unresolved', nodeType: 'software', displayName: 'PowerShell' },
      scope: null, basis: 'explicit_user_statement', confidence: 0.9,
      sensitivity: 'personal', validFromUtc: null, validToUtc: null,
      rationale: 'User said "I use PowerShell."',
    } as const;
    const candidate = graph.candidates.propose(input);
    assert.equal(candidate?.status, 'pending');
    assert.equal(candidate?.user_notes, '');
    assert.equal(graph.candidates.propose(input), null, 'a duplicate proposal is dropped');
    assert.equal(graph.candidates.listPending(ownerId).length, 1);
    const noted = graph.candidates.setUserNotes(candidate?.id ?? '', 'Verify the Windows version.');
    assert.equal(noted.user_notes, 'Verify the Windows version.');
    graph.candidates.needsConfirmation(noted.id, { kind: 'topic', topic: 'health' });
    assert.deepEqual(
      graph.candidates.listValidationQueue(ownerId).map((row) => row.id),
      [noted.id],
    );
    const removed = graph.candidates.removeFromValidationQueue(noted.id);
    assert.equal(removed.status, 'rejected');
    assert.equal(removed.rejection_reason, 'removed_by_user');
    assert.deepEqual(graph.candidates.listValidationQueue(ownerId), []);
  });
});

test('countValidationQueue matches listValidationQueue length', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const evidence = graph.evidence.recordTextEvidence({
      ownerId, deviceId: null, sourceType: 'conversation_message', parentEvidenceId: null,
      sourceEventId: 'chat_1:msg_3', sourceRef: 'chat_1', sourceTimezone: null,
      capturedAtUtc: '2026-08-05T09:00:00.000Z', sensitivity: 'personal',
      retentionUntilUtc: null, metadata: {}, text: 'I use PowerShell and Bash on a Golf.',
    });
    const observation = graph.observations.record({
      ownerId, evidenceId: evidence.id, observationType: 'conversation_statement',
      payload: { text: 'I use PowerShell and Bash on a Golf.' }, confidence: 0.9,
      sensitivity: 'personal', extractorName: 'conversation_memory_extractor',
      extractorVersion: '1',
    });
    const propose = (predicate: 'USES' | 'DRIVES', name: string) => graph.candidates.propose({
      ownerId, observationId: observation.id,
      subject: { nodeType: 'person', displayName: 'the user' },
      predicate,
      object: { kind: 'unresolved', nodeType: 'software', displayName: name },
      scope: null, basis: 'explicit_user_statement', confidence: 0.9,
      sensitivity: 'personal', validFromUtc: null, validToUtc: null,
      rationale: `User mentioned ${name}.`,
    });
    const pending = propose('USES', 'PowerShell');
    assert.ok(pending);
    const needsConfirmation = propose('USES', 'Bash');
    assert.ok(needsConfirmation);
    graph.candidates.needsConfirmation(needsConfirmation.id, { kind: 'topic', topic: 'health' });
    const accepted = propose('DRIVES', 'Golf');
    assert.ok(accepted);
    graph.candidates.reject(accepted.id, 'unknown_predicate');
    assert.equal(graph.candidates.countValidationQueue(ownerId), 2);
    assert.equal(
      graph.candidates.countValidationQueue(ownerId),
      graph.candidates.listValidationQueue(ownerId).length,
    );
  });
});

test('candidate refs round-trip and a rejection records its reason', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const evidence = graph.evidence.recordTextEvidence({
      ownerId, deviceId: null, sourceType: 'conversation_message', parentEvidenceId: null,
      sourceEventId: 'chat_1:msg_2', sourceRef: 'chat_1', sourceTimezone: null,
      capturedAtUtc: '2026-08-05T09:00:00.000Z', sensitivity: 'personal',
      retentionUntilUtc: null, metadata: {}, text: 'I drive a Golf.',
    });
    const observation = graph.observations.record({
      ownerId, evidenceId: evidence.id, observationType: 'conversation_statement',
      payload: { text: 'I drive a Golf.' }, confidence: 0.9, sensitivity: 'personal',
      extractorName: 'conversation_memory_extractor', extractorVersion: '1',
    });
    const candidate = graph.candidates.propose({
      ownerId, observationId: observation.id,
      subject: { nodeType: 'person', displayName: 'the user' },
      predicate: 'DRIVES',
      object: { kind: 'literal', valueType: 'string', value: 'Golf' },
      scope: null, basis: 'explicit_user_statement', confidence: 0.9,
      sensitivity: 'personal', validFromUtc: null, validToUtc: null,
      rationale: 'User said "I drive a Golf."',
    });
    const refs = graph.candidates.readRefs(graph.candidates.requireCandidate(candidate?.id ?? ''));
    assert.equal(refs.subject.nodeType, 'person');
    assert.equal(refs.object.kind, 'literal');

    const rejected = graph.candidates.reject(candidate?.id ?? '', 'unknown_predicate');
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.rejection_reason, 'unknown_predicate');
    assert.equal(graph.candidates.listPending(ownerId).length, 0);
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';

import type { AssistantGraph } from '../src/assistant/assistant-graph.js';
import { CandidateGate } from '../src/assistant/ingestion/candidate-gate.js';
import { CandidatePromoter } from '../src/assistant/ingestion/candidate-promoter.js';
import { SecretScanner } from '../src/assistant/domain/secrets.js';
import { LIVE_ASSERTION_STATUSES } from '../src/assistant/storage/assertion-store.js';
import { OWNER_PERSON_CANONICAL_KEY } from '../src/assistant/storage/schema.js';
import { proposePersonUses, withAssistantContext } from './helpers/assistant-fixture.js';

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
/**
 * `finish` used to commit on the rejection branch too, so nodes created by `resolveNode` for a
 * proposal the validator then refused were left behind. That leaked 13 junk `person` nodes in
 * production — `Discord`, `League of Legends`, `Windows` — one per rejected screenshot statement.
 */
test('a rejected candidate leaves no new nodes behind', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const evidence = graph.evidence.recordTextEvidence({
      ownerId, deviceId: null, sourceType: 'conversation_message', parentEvidenceId: null,
      sourceEventId: 'chat_reject:msg_1', sourceRef: 'chat_reject', sourceTimezone: null,
      capturedAtUtc: '2026-08-05T09:00:00.000Z', sensitivity: 'personal',
      retentionUntilUtc: null, metadata: {}, text: 'Nonsense.',
    });
    const observation = graph.observations.record({
      ownerId, evidenceId: evidence.id, observationType: 'conversation_statement',
      payload: {}, confidence: 0.9, sensitivity: 'personal',
      extractorName: 'conversation_memory_extractor', extractorVersion: '1',
    });
    // USES accepts only tool-ish objects, so a project object cannot validate.
    const candidate = graph.candidates.propose({
      ownerId, observationId: observation.id,
      subject: { nodeType: 'person', displayName: 'the user' },
      predicate: 'USES',
      object: { kind: 'unresolved', nodeType: 'project', displayName: 'Some Project' },
      scope: null, basis: 'explicit_user_statement', confidence: 0.9, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, rationale: 'Rejected by the object type rule.',
    });
    const before = graph.nodes.list(ownerId, 500, 0).length;
    const promoter = new CandidatePromoter(graph, new CandidateGate(graph.policies, new SecretScanner()));
    const outcome = promoter.promote({ ownerId, candidateId: candidate?.id ?? '' });

    assert.equal(outcome.kind, 'rejected');
    assert.equal(graph.nodes.list(ownerId, 500, 0).length, before);
  });
});

/** Rolling back must not also discard the rejection: it is a durable outcome. */
test('a rejected candidate is still recorded as rejected', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const evidence = graph.evidence.recordTextEvidence({
      ownerId, deviceId: null, sourceType: 'conversation_message', parentEvidenceId: null,
      sourceEventId: 'chat_reject:msg_2', sourceRef: 'chat_reject', sourceTimezone: null,
      capturedAtUtc: '2026-08-05T09:00:00.000Z', sensitivity: 'personal',
      retentionUntilUtc: null, metadata: {}, text: 'Nonsense.',
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
      object: { kind: 'unresolved', nodeType: 'project', displayName: 'Some Project' },
      scope: null, basis: 'explicit_user_statement', confidence: 0.9, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, rationale: 'Rejected by the object type rule.',
    });
    const promoter = new CandidatePromoter(graph, new CandidateGate(graph.policies, new SecretScanner()));
    promoter.promote({ ownerId, candidateId: candidate?.id ?? '' });

    const row = graph.candidates.requireCandidate(candidate?.id ?? '');
    assert.equal(row.status, 'rejected');
    assert.equal(row.rejection_reason, 'object_type_not_allowed');
  });
});

/** Builds a person subject candidate that promotes cleanly, so only the subject node varies. */
/** Creates the owner person node the service normally bootstraps, with one extra alias. */
function seedOwnerNode(
  context: { graph: AssistantGraph; ownerId: string }, alias: string,
): string {
  const node = context.graph.nodes.createNode({
    ownerId: context.ownerId, type: 'person', canonicalKey: OWNER_PERSON_CANONICAL_KEY,
    displayName: 'the user', description: null, sensitivity: 'personal', properties: {},
  });
  context.graph.nodes.addAlias({
    ownerId: context.ownerId, nodeId: node.id, alias,
    aliasType: 'user_supplied', sourceEvidenceId: null,
  });
  return node.id;
}

test('a configured owner alias resolves to the owner node', () => {
  withAssistantContext((context) => {
    const ownerNodeId = seedOwnerNode(context, 'Denys');
    const candidateId = proposePersonUses(context, {
      subjectName: 'Denys', objectName: 'PowerShell', sourceEventId: 'chat_1:msg_owner',
      sourceType: 'conversation_message', basis: 'explicit_user_statement', confidence: 0.9,
    });

    const outcome = new CandidatePromoter(
      context.graph, new CandidateGate(context.graph.policies, new SecretScanner()),
    ).promote({ ownerId: context.ownerId, candidateId });

    assert.equal(outcome.kind, 'promoted');
    const assertionId = outcome.kind === 'promoted' ? outcome.assertionId : '';
    assert.equal(context.graph.assertions.requireAssertion(assertionId).subject_node_id, ownerNodeId);
    assert.equal(context.graph.nodes.listNodesByType(context.ownerId, 'person').length, 1);
  });
});

test('an unrelated person name still creates its own node', () => {
  withAssistantContext((context) => {
    const ownerNodeId = seedOwnerNode(context, 'Denys');
    const candidateId = proposePersonUses(context, {
      subjectName: 'Alice', objectName: 'PowerShell', sourceEventId: 'chat_1:msg_alice',
      sourceType: 'conversation_message', basis: 'explicit_user_statement', confidence: 0.9,
    });

    const outcome = new CandidatePromoter(
      context.graph, new CandidateGate(context.graph.policies, new SecretScanner()),
    ).promote({ ownerId: context.ownerId, candidateId });

    assert.equal(outcome.kind, 'promoted');
    const assertionId = outcome.kind === 'promoted' ? outcome.assertionId : '';
    const subjectNodeId = context.graph.assertions.requireAssertion(assertionId).subject_node_id;
    assert.notEqual(subjectNodeId, ownerNodeId);
    assert.equal(context.graph.nodes.requireNode(subjectNodeId).display_name, 'Alice');
  });
});

test('owner alias matching is normalization-insensitive', () => {
  withAssistantContext((context) => {
    const ownerNodeId = seedOwnerNode(context, 'Denys Ashikhin');
    const candidateId = proposePersonUses(context, {
      subjectName: '  DENYS   ashikhin ', objectName: 'PowerShell', sourceEventId: 'chat_1:msg_case',
      sourceType: 'conversation_message', basis: 'explicit_user_statement', confidence: 0.9,
    });

    const outcome = new CandidatePromoter(
      context.graph, new CandidateGate(context.graph.policies, new SecretScanner()),
    ).promote({ ownerId: context.ownerId, candidateId });

    assert.equal(outcome.kind, 'promoted');
    const assertionId = outcome.kind === 'promoted' ? outcome.assertionId : '';
    assert.equal(context.graph.assertions.requireAssertion(assertionId).subject_node_id, ownerNodeId);
  });
});

test('an owner alias shared with a rival person node still lands on the owner', () => {
  withAssistantContext((context) => {
    const ownerNodeId = seedOwnerNode(context, 'Denys');
    // The exact live state the alias leak produced: a second `person` node already answers to the
    // same name, so plain alias resolution would report an ambiguity instead of resolving.
    const rival = context.graph.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: null, displayName: 'Denys',
      description: null, sensitivity: 'personal', properties: {},
    });
    context.graph.nodes.addAlias({
      ownerId: context.ownerId, nodeId: rival.id, alias: 'Denys',
      aliasType: 'name', sourceEvidenceId: null,
    });
    const candidateId = proposePersonUses(context, {
      subjectName: 'Denys', objectName: 'PowerShell', sourceEventId: 'chat_1:msg_rival',
      sourceType: 'conversation_message', basis: 'explicit_user_statement', confidence: 0.9,
    });

    const outcome = new CandidatePromoter(
      context.graph, new CandidateGate(context.graph.policies, new SecretScanner()),
    ).promote({ ownerId: context.ownerId, candidateId });

    assert.equal(outcome.kind, 'promoted');
    const assertionId = outcome.kind === 'promoted' ? outcome.assertionId : '';
    assert.equal(context.graph.assertions.requireAssertion(assertionId).subject_node_id, ownerNodeId);
  });
});

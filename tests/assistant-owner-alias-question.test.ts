import test from 'node:test';
import assert from 'node:assert/strict';

import type { AssistantGraph } from '../src/assistant/assistant-graph.js';
import { CandidateGate } from '../src/assistant/ingestion/candidate-gate.js';
import { CandidatePromoter } from '../src/assistant/ingestion/candidate-promoter.js';
import { ValidationQueueService } from '../src/assistant/control/validation-queue-service.js';
import { SecretScanner } from '../src/assistant/domain/secrets.js';
import { OWNER_PERSON_CANONICAL_KEY } from '../src/assistant/storage/schema.js';
import { withAssistantContext, type AssistantTestContext } from './helpers/assistant-fixture.js';

const OBSERVED_AT = '2026-08-05T09:00:00.000Z';

function buildPromoter(graph: AssistantGraph): CandidatePromoter {
  return new CandidatePromoter(graph, new CandidateGate(graph.policies, new SecretScanner()));
}

/** The owner node the service bootstraps, carrying the aliases a near miss is measured against. */
function seedOwner(context: AssistantTestContext): string {
  const node = context.graph.nodes.createNode({
    ownerId: context.ownerId, type: 'person', canonicalKey: OWNER_PERSON_CANONICAL_KEY,
    displayName: 'the user', description: null, sensitivity: 'personal', properties: {},
  });
  for (const alias of ['the user', 'me', 'denys']) {
    context.graph.nodes.addAlias({
      ownerId: context.ownerId, nodeId: node.id, alias,
      aliasType: 'user_supplied', sourceEvidenceId: null,
    });
  }
  return node.id;
}

function proposePersonUses(
  context: AssistantTestContext, subjectName: string, sourceEventId: string,
): string {
  const { graph, ownerId } = context;
  const evidence = graph.evidence.recordTextEvidence({
    ownerId, deviceId: null, sourceType: 'screenshot', parentEvidenceId: null,
    sourceEventId, sourceRef: 'app:code', sourceTimezone: null,
    capturedAtUtc: OBSERVED_AT, sensitivity: 'personal',
    retentionUntilUtc: null, metadata: {}, text: `${subjectName} uses Tauri.`,
  });
  const observation = graph.observations.record({
    ownerId, evidenceId: evidence.id, observationType: 'screenshot_extraction',
    payload: {}, confidence: 0.7, sensitivity: 'personal',
    extractorName: 'image_extraction', extractorVersion: '1',
  });
  const candidate = graph.candidates.propose({
    ownerId, observationId: observation.id,
    subject: { nodeType: 'person', displayName: subjectName },
    predicate: 'USES',
    object: { kind: 'unresolved', nodeType: 'software', displayName: 'Tauri' },
    scope: null, basis: 'passive_observation', confidence: 0.7, sensitivity: 'personal',
    validFromUtc: null, validToUtc: null,
    rationale: `The screenshot shows ${subjectName} in Tauri.`,
  });
  if (candidate === null) throw new Error('Candidate proposal was deduplicated unexpectedly.');
  return candidate.id;
}

test('a near-miss person name parks the candidate instead of creating a node', () => {
  withAssistantContext((context) => {
    seedOwner(context);
    const candidateId = proposePersonUses(context, 'denyz', 'cap:1');

    const outcome = buildPromoter(context.graph)
      .promote({ ownerId: context.ownerId, candidateId });

    assert.equal(outcome.kind, 'needs_confirmation');
    assert.equal(
      context.graph.candidates.requireCandidate(candidateId).status, 'needs_confirmation',
    );
    assert.deepEqual(
      context.graph.nodes.findByAlias(context.ownerId, 'denyz', 'person'), [],
      'no rival person node is created while the question is open',
    );
  });
});

test('an exact owner alias still resolves silently', () => {
  withAssistantContext((context) => {
    const ownerNodeId = seedOwner(context);
    const candidateId = proposePersonUses(context, 'denys', 'cap:2');

    const outcome = buildPromoter(context.graph)
      .promote({ ownerId: context.ownerId, candidateId });

    assert.equal(outcome.kind, 'promoted');
    const assertionId = outcome.kind === 'promoted' ? outcome.assertionId : '';
    assert.equal(
      context.graph.assertions.requireAssertion(assertionId).subject_node_id, ownerNodeId,
    );
  });
});

test('an unrelated person name still creates its own node', () => {
  withAssistantContext((context) => {
    const ownerNodeId = seedOwner(context);
    const candidateId = proposePersonUses(context, 'turboDerp', 'cap:3');

    const outcome = buildPromoter(context.graph)
      .promote({ ownerId: context.ownerId, candidateId });

    assert.equal(outcome.kind, 'promoted');
    const assertionId = outcome.kind === 'promoted' ? outcome.assertionId : '';
    assert.notEqual(
      context.graph.assertions.requireAssertion(assertionId).subject_node_id, ownerNodeId,
    );
  });
});

test('a name already known to be someone else is never questioned again', () => {
  withAssistantContext((context) => {
    seedOwner(context);
    const existing = context.graph.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: null, displayName: 'denyz',
      description: null, sensitivity: 'personal', properties: {},
    });
    context.graph.nodes.addAlias({
      ownerId: context.ownerId, nodeId: existing.id, alias: 'denyz',
      aliasType: 'name', sourceEvidenceId: null,
    });
    const candidateId = proposePersonUses(context, 'denyz', 'cap:4');

    const outcome = buildPromoter(context.graph)
      .promote({ ownerId: context.ownerId, candidateId });

    assert.equal(outcome.kind, 'promoted');
    const assertionId = outcome.kind === 'promoted' ? outcome.assertionId : '';
    assert.equal(
      context.graph.assertions.requireAssertion(assertionId).subject_node_id, existing.id,
    );
  });
});

test('answering yes adds the alias and promotes onto the owner', () => {
  withAssistantContext((context) => {
    const ownerNodeId = seedOwner(context);
    const candidateId = proposePersonUses(context, 'denyz', 'cap:5');
    const promoter = buildPromoter(context.graph);
    promoter.promote({ ownerId: context.ownerId, candidateId });
    const queue = new ValidationQueueService(context.graph, context.ownerId, promoter);

    const outcome = queue.resolveIdentity(candidateId, true);

    assert.equal(outcome.kind, 'promoted');
    const assertionId = outcome.kind === 'promoted' ? outcome.assertionId : '';
    assert.equal(
      context.graph.assertions.requireAssertion(assertionId).subject_node_id, ownerNodeId,
    );
    assert.ok(
      context.graph.nodes.listAliases(ownerNodeId)
        .some((row) => row.normalized_alias === 'denyz'),
      'the confirmed spelling becomes an owner alias so it is never asked again',
    );
  });
});

test('answering no promotes onto a separate node and is not asked again', () => {
  withAssistantContext((context) => {
    const ownerNodeId = seedOwner(context);
    const promoter = buildPromoter(context.graph);
    const queue = new ValidationQueueService(context.graph, context.ownerId, promoter);
    const firstId = proposePersonUses(context, 'denyz', 'cap:6');
    promoter.promote({ ownerId: context.ownerId, candidateId: firstId });

    const outcome = queue.resolveIdentity(firstId, false);

    assert.equal(outcome.kind, 'promoted');
    const assertionId = outcome.kind === 'promoted' ? outcome.assertionId : '';
    const subjectNodeId = context.graph.assertions.requireAssertion(assertionId).subject_node_id;
    assert.notEqual(subjectNodeId, ownerNodeId);
    assert.equal(context.graph.nodes.requireNode(subjectNodeId).display_name, 'denyz');

    // The answer left an alias behind, so the second sighting resolves without another question.
    const secondId = proposePersonUses(context, 'denyz', 'cap:7');
    const second = promoter.promote({ ownerId: context.ownerId, candidateId: secondId });
    assert.equal(second.kind, 'promoted');
  });
});

test('the validation queue reports why a candidate is held', () => {
  withAssistantContext((context) => {
    seedOwner(context);
    const candidateId = proposePersonUses(context, 'denyz', 'cap:8');
    const promoter = buildPromoter(context.graph);
    promoter.promote({ ownerId: context.ownerId, candidateId });
    const queue = new ValidationQueueService(context.graph, context.ownerId, promoter);

    const item = queue.list().find((row) => row.id === candidateId);

    assert.equal(item?.status, 'needs_confirmation');
    assert.equal(item?.confirmationReason, 'possible_owner_alias');
    assert.equal(item?.identityName, 'denyz');
  });
});

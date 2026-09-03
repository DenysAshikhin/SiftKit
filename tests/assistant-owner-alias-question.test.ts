import test from 'node:test';
import assert from 'node:assert/strict';

import type { AssistantGraph } from '../src/assistant/assistant-graph.js';
import { CandidateGate } from '../src/assistant/ingestion/candidate-gate.js';
import { CandidatePromoter } from '../src/assistant/ingestion/candidate-promoter.js';
import { ValidationQueueService } from '../src/assistant/control/validation-queue-service.js';
import { SecretScanner } from '../src/assistant/domain/secrets.js';
import { OWNER_PERSON_CANONICAL_KEY } from '../src/assistant/storage/schema.js';
import {
  proposePersonUses, withAssistantContext, type AssistantTestContext,
} from './helpers/assistant-fixture.js';

const OBSERVED_AT = '2026-08-05T09:00:00.000Z';

function buildPromoter(graph: AssistantGraph): CandidatePromoter {
  return new CandidatePromoter(graph, new CandidateGate(graph.policies, new SecretScanner()));
}

function buildQueue(
  context: AssistantTestContext, promoter: CandidatePromoter,
): ValidationQueueService {
  return new ValidationQueueService({
    graph: context.graph, ownerId: context.ownerId, promoter, projectionPriority: 300,
  });
}

function queuedRecompiles(context: AssistantTestContext): number {
  return context.graph.jobs.listByStatus(context.ownerId, 'queued')
    .filter((job) => job.job_type === 'projection_maintenance').length;
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

test('a near-miss person name parks the candidate instead of creating a node', () => {
  withAssistantContext((context) => {
    seedOwner(context);
    const candidateId = proposePersonUses(context, {
      subjectName: 'denyz', objectName: 'Tauri', sourceEventId: 'cap:1',
      sourceType: 'screenshot', basis: 'passive_observation', confidence: 0.7,
    });

    const outcome = buildPromoter(context.graph)
      .promote({ ownerId: context.ownerId, candidateId });

    assert.equal(outcome.kind, 'needs_confirmation');
    assert.deepEqual(
      outcome.kind === 'needs_confirmation' ? outcome.hold : null,
      { kind: 'possible_owner_alias', name: 'denyz' },
    );
    assert.equal(context.graph.candidates.requireCandidate(candidateId).rejection_reason, null);
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
    const candidateId = proposePersonUses(context, {
      subjectName: 'denys', objectName: 'Tauri', sourceEventId: 'cap:2',
      sourceType: 'screenshot', basis: 'passive_observation', confidence: 0.7,
    });

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
    const candidateId = proposePersonUses(context, {
      subjectName: 'turboDerp', objectName: 'Tauri', sourceEventId: 'cap:3',
      sourceType: 'screenshot', basis: 'passive_observation', confidence: 0.7,
    });

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
    const candidateId = proposePersonUses(context, {
      subjectName: 'denyz', objectName: 'Tauri', sourceEventId: 'cap:4',
      sourceType: 'screenshot', basis: 'passive_observation', confidence: 0.7,
    });

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
    const candidateId = proposePersonUses(context, {
      subjectName: 'denyz', objectName: 'Tauri', sourceEventId: 'cap:5',
      sourceType: 'screenshot', basis: 'passive_observation', confidence: 0.7,
    });
    const promoter = buildPromoter(context.graph);
    promoter.promote({ ownerId: context.ownerId, candidateId });
    const queue = buildQueue(context, promoter);

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
    const queue = buildQueue(context, promoter);
    const firstId = proposePersonUses(context, {
      subjectName: 'denyz', objectName: 'Tauri', sourceEventId: 'cap:6',
      sourceType: 'screenshot', basis: 'passive_observation', confidence: 0.7,
    });
    promoter.promote({ ownerId: context.ownerId, candidateId: firstId });

    const outcome = queue.resolveIdentity(firstId, false);

    assert.equal(outcome.kind, 'promoted');
    const assertionId = outcome.kind === 'promoted' ? outcome.assertionId : '';
    const subjectNodeId = context.graph.assertions.requireAssertion(assertionId).subject_node_id;
    assert.notEqual(subjectNodeId, ownerNodeId);
    assert.equal(context.graph.nodes.requireNode(subjectNodeId).display_name, 'denyz');

    // The answer left an alias behind, so the second sighting resolves without another question.
    const secondId = proposePersonUses(context, {
      subjectName: 'denyz', objectName: 'Tauri', sourceEventId: 'cap:7',
      sourceType: 'screenshot', basis: 'passive_observation', confidence: 0.7,
    });
    const second = promoter.promote({ ownerId: context.ownerId, candidateId: secondId });
    assert.equal(second.kind, 'promoted');
  });
});

test('the validation queue reports why a candidate is held', () => {
  withAssistantContext((context) => {
    seedOwner(context);
    const candidateId = proposePersonUses(context, {
      subjectName: 'denyz', objectName: 'Tauri', sourceEventId: 'cap:8',
      sourceType: 'screenshot', basis: 'passive_observation', confidence: 0.7,
    });
    const promoter = buildPromoter(context.graph);
    promoter.promote({ ownerId: context.ownerId, candidateId });
    const queue = buildQueue(context, promoter);

    const item = queue.list().find((row) => row.id === candidateId);

    assert.equal(item?.status, 'needs_confirmation');
    assert.deepEqual(item?.hold, { kind: 'possible_owner_alias', name: 'denyz' });
  });
});

/**
 * Either answer puts a fact on a node the tiers read from — the owner, or a person the owner
 * just named — and the documents are only rebuilt when something asks.
 */
test('answering yes to an identity question queues a projection recompile', () => {
  withAssistantContext((context) => {
    seedOwner(context);
    const candidateId = proposePersonUses(context, {
      subjectName: 'denyz', objectName: 'Tauri', sourceEventId: 'cap:9',
      sourceType: 'screenshot', basis: 'passive_observation', confidence: 0.7,
    });
    const promoter = buildPromoter(context.graph);
    promoter.promote({ ownerId: context.ownerId, candidateId });

    buildQueue(context, promoter).resolveIdentity(candidateId, true);

    assert.equal(queuedRecompiles(context), 1);
  });
});

test('answering no to an identity question queues a projection recompile', () => {
  withAssistantContext((context) => {
    seedOwner(context);
    const candidateId = proposePersonUses(context, {
      subjectName: 'denyz', objectName: 'Tauri', sourceEventId: 'cap:10',
      sourceType: 'screenshot', basis: 'passive_observation', confidence: 0.7,
    });
    const promoter = buildPromoter(context.graph);
    promoter.promote({ ownerId: context.ownerId, candidateId });

    buildQueue(context, promoter).resolveIdentity(candidateId, false);

    assert.equal(queuedRecompiles(context), 1);
  });
});

/** `user` and `myself` are seeded as owner aliases, but they are not names. A real person two
 * edits from a pronoun must not be asked whether they are the owner. */
test('a name near a pronoun alias is not questioned', () => {
  withAssistantContext((context) => {
    const ownerNodeId = seedOwner(context);
    context.graph.nodes.addAlias({
      ownerId: context.ownerId, nodeId: ownerNodeId, alias: 'user',
      aliasType: 'user_supplied', sourceEvidenceId: null,
    });
    const candidateId = proposePersonUses(context, {
      subjectName: 'Ester', objectName: 'Tauri', sourceEventId: 'cap:11',
      sourceType: 'screenshot', basis: 'passive_observation', confidence: 0.7,
    });

    const outcome = buildPromoter(context.graph)
      .promote({ ownerId: context.ownerId, candidateId });

    assert.equal(outcome.kind, 'promoted');
    const assertionId = outcome.kind === 'promoted' ? outcome.assertionId : '';
    assert.notEqual(
      context.graph.assertions.requireAssertion(assertionId).subject_node_id, ownerNodeId,
    );
  });
});

/** A candidate the validator will refuse: `USES` does not accept a `project` object. */
function proposeInvalidPersonUses(
  context: AssistantTestContext, subjectName: string, sourceEventId: string,
): string {
  const { graph, ownerId } = context;
  const evidence = graph.evidence.recordTextEvidence({
    ownerId, deviceId: null, sourceType: 'screenshot', parentEvidenceId: null,
    sourceEventId, sourceRef: 'app:code', sourceTimezone: null,
    capturedAtUtc: OBSERVED_AT, sensitivity: 'personal',
    retentionUntilUtc: null, metadata: {}, text: `${subjectName} uses Some Project.`,
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
    object: { kind: 'unresolved', nodeType: 'project', displayName: 'Some Project' },
    scope: null, basis: 'passive_observation', confidence: 0.7, sensitivity: 'personal',
    validFromUtc: null, validToUtc: null, rationale: 'object type the validator refuses',
  });
  if (candidate === null) throw new Error('Candidate proposal was deduplicated unexpectedly.');
  return candidate.id;
}

test('a no answer is remembered even when the promotion is then refused', () => {
  withAssistantContext((context) => {
    const ownerNodeId = seedOwner(context);
    const promoter = buildPromoter(context.graph);
    const firstId = proposeInvalidPersonUses(context, 'denyz', 'cap:12');
    promoter.promote({ ownerId: context.ownerId, candidateId: firstId });

    const outcome = buildQueue(context, promoter).resolveIdentity(firstId, false);

    assert.equal(outcome.kind, 'rejected');
    const [named] = context.graph.nodes.findByAlias(context.ownerId, 'denyz', 'person');
    assert.ok(named !== undefined, 'the person the owner named still exists');
    assert.ok(
      context.graph.nodes.listAliases(named.id)
        .some((row) => row.alias_type === 'user_supplied'),
      'the alias records that the owner supplied it',
    );
    const created = context.graph.audit.listMutations(context.ownerId, 'graph_nodes', named.id)
      .find((row) => row.operation === 'create_node');
    assert.equal(created?.actor_type, 'user');

    const secondId = proposePersonUses(context, {
      subjectName: 'denyz', objectName: 'Tauri', sourceEventId: 'cap:13',
      sourceType: 'screenshot', basis: 'passive_observation', confidence: 0.7,
    });
    const second = promoter.promote({ ownerId: context.ownerId, candidateId: secondId });
    assert.equal(second.kind, 'promoted');
    const assertionId = second.kind === 'promoted' ? second.assertionId : '';
    assert.equal(
      context.graph.assertions.requireAssertion(assertionId).subject_node_id, named.id,
    );
    assert.notEqual(named.id, ownerNodeId);
  });
});

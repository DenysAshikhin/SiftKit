import test from 'node:test';
import assert from 'node:assert/strict';

import type { AssistantService } from '../src/assistant/assistant-service.js';
import { CandidateGate } from '../src/assistant/ingestion/candidate-gate.js';
import { CandidatePromoter } from '../src/assistant/ingestion/candidate-promoter.js';
import { SecretScanner } from '../src/assistant/domain/secrets.js';
import { OWNER_PERSON_CANONICAL_KEY } from '../src/assistant/storage/schema.js';
import { DEFAULT_ASSISTANT_CONFIG } from '../src/config/defaults.js';
import { closeRuntimeDatabase } from '../src/state/runtime-db.js';
import {
  buildAssistantService, proposePersonUses,
} from './helpers/assistant-fixture.js';

const OBSERVED_AT = '2026-08-05T09:00:00.000Z';

/** A duplicate of the owner, holding one fact the owner's profile cannot currently see. */
function seedDuplicate(service: AssistantService, displayName: string): {
  nodeId: string; assertionId: string;
} {
  const { graph, ownerId } = service;
  const node = graph.nodes.createNode({
    ownerId, type: 'person', canonicalKey: null, displayName,
    description: null, sensitivity: 'personal', properties: {},
  });
  graph.nodes.addAlias({
    ownerId, nodeId: node.id, alias: displayName, aliasType: 'name', sourceEvidenceId: null,
  });
  const software = graph.nodes.createNode({
    ownerId, type: 'software', canonicalKey: null, displayName: 'Tauri',
    description: null, sensitivity: 'personal', properties: {},
  });
  const assertion = graph.assertions.createAssertion({
    ownerId, subjectNodeId: node.id, predicate: 'USES',
    object: { kind: 'node', nodeId: software.id }, scopeNodeId: null, status: 'active',
    basis: 'passive_observation', confidence: 0.7, sensitivity: 'personal',
    validFromUtc: null, validToUtc: null, observedAtUtc: OBSERVED_AT,
    supersedesAssertionId: null, pinned: false, attributes: {},
    searchText: { subject: displayName, predicate: 'USES', object: 'Tauri', scope: '' },
  });
  return { nodeId: node.id, assertionId: assertion.id };
}

test('claiming a person node moves its facts onto the owner', async () => {
  try {
    const service = buildAssistantService({ ownerDisplayName: 'Denys' });
    const ownerNodeId = service.ownerPersonNodeId ?? '';
    const { nodeId, assertionId } = seedDuplicate(service, 'demyus');

    const result = await service.claimNodeAsOwner(nodeId, 'this spelling is me');

    assert.equal(result.ownerNodeId, ownerNodeId);
    assert.equal(result.movedAssertionCount, 1);
    assert.equal(result.retiredAssertionCount, 0);
    assert.deepEqual(result.movedAliases, ['demyus']);
    assert.equal(service.graph.assertions.requireAssertion(assertionId).subject_node_id, ownerNodeId);
    assert.equal(service.graph.nodes.requireNode(nodeId).status, 'merged');
    assert.ok(
      service.graph.nodes.listAliases(ownerNodeId)
        .some((row) => row.normalized_alias === 'demyus'),
      'the claimed spelling becomes an owner alias so it never splits again',
    );
  } finally {
    closeRuntimeDatabase();
  }
});

test('a later statement using the claimed spelling resolves to the owner', async () => {
  try {
    const service = buildAssistantService({ ownerDisplayName: 'Denys' });
    const ownerNodeId = service.ownerPersonNodeId ?? '';
    const { nodeId } = seedDuplicate(service, 'dengy');
    await service.claimNodeAsOwner(nodeId, 'this spelling is me');

    const resolved = service.graph.resolver.resolve({
      ownerId: service.ownerId, nodeType: 'person', displayName: 'dengy',
      canonicalKey: null, contextNodeIds: [], createIfMissing: true,
    });

    assert.equal(resolved.kind === 'resolved' && resolved.nodeId, ownerNodeId);
  } finally {
    closeRuntimeDatabase();
  }
});

test('claiming the owner node itself is refused', async () => {
  try {
    const service = buildAssistantService({ ownerDisplayName: 'Denys' });
    const ownerNodeId = service.ownerPersonNodeId ?? '';

    await assert.rejects(
      () => service.claimNodeAsOwner(ownerNodeId, 'redundant'),
      /already the owner/iu,
    );
  } finally {
    closeRuntimeDatabase();
  }
});

test('claiming a node that is not a person is refused', async () => {
  try {
    const service = buildAssistantService({ ownerDisplayName: 'Denys' });
    const software = service.graph.nodes.createNode({
      ownerId: service.ownerId, type: 'software', canonicalKey: null, displayName: 'Tauri',
      description: null, sensitivity: 'personal', properties: {},
    });

    await assert.rejects(
      () => service.claimNodeAsOwner(software.id, 'wrong type'),
      /person/iu,
    );
  } finally {
    closeRuntimeDatabase();
  }
});

test('a claim is reversible through the merge log', async () => {
  try {
    const service = buildAssistantService({ ownerDisplayName: 'Denys' });
    const { nodeId, assertionId } = seedDuplicate(service, 'derys');
    const result = await service.claimNodeAsOwner(nodeId, 'this spelling is me');

    service.graph.merges.unmerge({
      ownerId: service.ownerId, mergeId: result.mergeId, reason: 'that was not me after all',
    });

    assert.equal(service.graph.assertions.requireAssertion(assertionId).subject_node_id, nodeId);
    assert.equal(service.graph.nodes.requireNode(nodeId).status, 'active');
    assert.equal(
      service.graph.nodes.findByCanonicalKey(
        service.ownerId, 'person', OWNER_PERSON_CANONICAL_KEY,
      )?.id,
      service.ownerPersonNodeId,
    );
  } finally {
    closeRuntimeDatabase();
  }
});

/**
 * Most of a duplicate's facts are facts the owner already holds: the same screenshot fact read
 * under two spellings. The merge retires those as duplicates and moves only the rest, and the
 * response has to say so instead of counting the source's facts before the merge ran.
 */
test('a claim reports duplicate facts as retired, not moved', async () => {
  try {
    const service = buildAssistantService({ ownerDisplayName: 'Denys' });
    const { graph, ownerId } = service;
    const ownerNodeId = service.ownerPersonNodeId ?? '';
    const duplicate = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: null, displayName: 'demyx',
      description: null, sensitivity: 'personal', properties: {},
    });
    const tauri = graph.nodes.createNode({
      ownerId, type: 'software', canonicalKey: null, displayName: 'Tauri',
      description: null, sensitivity: 'personal', properties: {},
    });
    const vite = graph.nodes.createNode({
      ownerId, type: 'software', canonicalKey: null, displayName: 'Vite',
      description: null, sensitivity: 'personal', properties: {},
    });
    const uses = (subjectNodeId: string, objectNodeId: string, confidence: number): string =>
      graph.assertions.createAssertion({
        ownerId, subjectNodeId, predicate: 'USES',
        object: { kind: 'node', nodeId: objectNodeId }, scopeNodeId: null, status: 'active',
        basis: 'passive_observation', confidence, sensitivity: 'personal',
        validFromUtc: null, validToUtc: null, observedAtUtc: OBSERVED_AT,
        supersedesAssertionId: null, pinned: false, attributes: {},
        searchText: { subject: 'demyx', predicate: 'USES', object: 'tool', scope: '' },
      }).id;
    uses(ownerNodeId, tauri.id, 0.9);
    const duplicateTauri = uses(duplicate.id, tauri.id, 0.7);
    const duplicateVite = uses(duplicate.id, vite.id, 0.7);

    const result = await service.claimNodeAsOwner(duplicate.id, 'this spelling is me');

    assert.equal(result.movedAssertionCount, 1);
    assert.equal(result.retiredAssertionCount, 1);
    assert.equal(graph.assertions.requireAssertion(duplicateVite).subject_node_id, ownerNodeId);
    assert.equal(graph.assertions.requireAssertion(duplicateTauri).status, 'superseded');
  } finally {
    closeRuntimeDatabase();
  }
});

/** Recompiles queued for the owner. `enqueueSuperseding` keeps at most one queued at a time. */
function queuedRecompiles(service: AssistantService): number {
  return service.graph.jobs.listByStatus(service.ownerId, 'queued')
    .filter((job) => job.job_type === 'projection_maintenance').length;
}

/**
 * The compiled memory documents are only rebuilt when something asks. The runner asks after
 * every extraction; a claim has to ask too, or the facts it just moved stay out of every tier
 * until an unrelated screenshot happens to trigger a rebuild.
 */
test('a claim queues a projection recompile', async () => {
  try {
    const service = buildAssistantService({ ownerDisplayName: 'Denys' });
    const { nodeId } = seedDuplicate(service, 'demys');

    await service.claimNodeAsOwner(nodeId, 'this spelling is me');

    assert.equal(queuedRecompiles(service), 1);
  } finally {
    closeRuntimeDatabase();
  }
});

test('a refused claim queues nothing', async () => {
  try {
    const service = buildAssistantService({ ownerDisplayName: 'Denys' });
    const ownerNodeId = service.ownerPersonNodeId ?? '';

    await assert.rejects(() => service.claimNodeAsOwner(ownerNodeId, 'redundant'));

    assert.equal(queuedRecompiles(service), 0);
  } finally {
    closeRuntimeDatabase();
  }
});

test('an identity answer uses the projection priority from the latest config', () => {
  try {
    const service = buildAssistantService({ ownerDisplayName: 'Denys' });
    const { graph, ownerId } = service;
    const candidateId = proposePersonUses(service, {
      subjectName: 'denyz', objectName: 'Tauri', sourceEventId: 'cap:priority',
      sourceType: 'screenshot', basis: 'passive_observation', confidence: 0.7,
    });
    // Park it on the identity question the way the runner would.
    new CandidatePromoter(graph, new CandidateGate(graph.policies, new SecretScanner()))
      .promote({ ownerId, candidateId });
    service.refreshConfig({
      ...DEFAULT_ASSISTANT_CONFIG,
      Enabled: true,
      Owner: { ...DEFAULT_ASSISTANT_CONFIG.Owner, DisplayName: 'Denys' },
      Background: {
        ...DEFAULT_ASSISTANT_CONFIG.Background,
        JobPriorities: {
          ...DEFAULT_ASSISTANT_CONFIG.Background.JobPriorities, ProjectionMaintenance: 123,
        },
      },
    });

    const outcome = service.validation.resolveIdentity(candidateId, true);

    assert.equal(outcome.kind, 'promoted');
    const recompiles = graph.jobs.listByStatus(ownerId, 'queued')
      .filter((job) => job.job_type === 'projection_maintenance');
    assert.equal(recompiles.length, 1);
    assert.equal(recompiles[0]?.priority, 123);
  } finally {
    closeRuntimeDatabase();
  }
});

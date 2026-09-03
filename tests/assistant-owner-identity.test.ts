import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { AssistantService } from '../src/assistant/assistant-service.js';
import { FixedClock } from '../src/assistant/clock.js';
import { SequentialIdGenerator } from '../src/assistant/ids.js';
import { EstimateTokenCounter } from '../src/assistant/domain/tokens.js';
import { OWNER_PERSON_CANONICAL_KEY } from '../src/assistant/storage/schema.js';
import { DEFAULT_ASSISTANT_CONFIG } from '../src/config/defaults.js';
import { closeRuntimeDatabase, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { MemoryAssistantConfigWriter } from './helpers/assistant-fixture.js';
import { FakeAssistantInference } from './helpers/assistant-inference-fake.js';
import { ALWAYS_IDLE, ALWAYS_RESIDENT } from './helpers/assistant-gates.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const OBSERVED_AT = '2026-08-05T09:00:00.000Z';

function buildService(): AssistantService {
  const runtimeRoot = createManagedTempDir('siftkit-owner-identity-');
  const config = {
    ...DEFAULT_ASSISTANT_CONFIG,
    Enabled: true,
    Owner: { ...DEFAULT_ASSISTANT_CONFIG.Owner, DisplayName: 'Denys' },
  };
  return AssistantService.create({
    database: getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite')),
    runtimeRoot,
    clock: new FixedClock(OBSERVED_AT),
    ids: new SequentialIdGenerator(),
    configWriter: new MemoryAssistantConfigWriter(config),
    inference: new FakeAssistantInference([]),
    tokens: new EstimateTokenCounter(4),
    idleGate: ALWAYS_IDLE,
    residencyGate: ALWAYS_RESIDENT,
    config,
  });
}

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
    const service = buildService();
    const ownerNodeId = service.ownerPersonNodeId ?? '';
    const { nodeId, assertionId } = seedDuplicate(service, 'demyus');

    const result = await service.claimNodeAsOwner(nodeId, 'this spelling is me');

    assert.equal(result.ownerNodeId, ownerNodeId);
    assert.equal(result.movedAssertionCount, 1);
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
    const service = buildService();
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
    const service = buildService();
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
    const service = buildService();
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
    const service = buildService();
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

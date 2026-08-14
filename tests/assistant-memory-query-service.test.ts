import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryQueryService } from '../src/assistant/control/memory-query-service.js';
import { withAssistantContext } from './helpers/assistant-fixture.js';

test('MemoryQueryService provides bounded, owner-isolated graph and explanation DTOs', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const owner = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: 'person:owner', displayName: 'the user',
      description: null, sensitivity: 'personal', properties: { role: 'owner' },
    });
    graph.nodes.addAlias({
      ownerId, nodeId: owner.id, alias: 'Denys', aliasType: 'user_supplied', sourceEvidenceId: null,
    });
    const secret = graph.nodes.createNode({
      ownerId, type: 'health_topic', canonicalKey: null, displayName: 'private detail',
      description: 'must redact', sensitivity: 'sensitive', properties: { raw: 'secret' },
    });
    const evidence = graph.evidence.recordTextEvidence({
      ownerId, deviceId: null, parentEvidenceId: null, sourceType: 'conversation_message',
      sourceEventId: 'chat:m1', sourceRef: 'chat', capturedAtUtc: '2026-08-10T00:00:00.000Z',
      sourceTimezone: null, sensitivity: 'sensitive', retentionUntilUtc: null,
      metadata: { raw: 'secret' }, text: 'private source text',
    });
    const outcome = graph.assertionService.assert({
      ownerId, actorType: 'user', actorRef: null, subjectNodeId: owner.id,
      predicate: 'INTERESTED_IN', object: { kind: 'node', nodeId: secret.id }, scopeNodeId: null,
      basis: 'explicit_user_statement', sensitivity: 'sensitive',
      validFromUtc: null, validToUtc: null, observedAtUtc: '2026-08-10T00:00:00.000Z',
      topics: [], attributes: {},
      searchText: { subject: 'the user', predicate: 'INTERESTED_IN', object: 'private detail', scope: '' },
      evidence: [{ evidenceId: evidence.id, stance: 'supports', weight: 1 }],
    });
    assert.equal(outcome.kind, 'created');
    if (outcome.kind !== 'created') return;

    const service = new MemoryQueryService(graph);
    assert.throws(() => service.listAssertions(ownerId, { limit: 101, offset: 0 }), /limit/i);
    assert.equal(service.getNode(ownerId, 'missing').kind, 'not_found');
    const node = service.getNode(ownerId, secret.id);
    assert.equal(node.kind, 'found');
    if (node.kind === 'found') {
      assert.equal(node.value.description, null);
      assert.deepEqual(node.value.properties, { redacted: true });
    }

    const assertions = service.listAssertions(ownerId, { limit: 10, offset: 0 });
    assert.equal(assertions.length, 1);
    assert.equal(assertions[0]?.objectText, '[redacted]');
    const explanation = service.explainAssertion(ownerId, outcome.assertionId);
    assert.equal(explanation.kind, 'found');
    if (explanation.kind === 'found') {
      assert.deepEqual(explanation.value.evidenceIds, [evidence.id]);
      assert.ok(explanation.value.mutationIds.length > 0);
    }
    const evidenceDto = service.getEvidenceMetadata(ownerId, evidence.id);
    assert.equal(evidenceDto.kind, 'found');
    if (evidenceDto.kind === 'found') {
      assert.deepEqual(evidenceDto.value.metadata, { redacted: true });
      assert.equal(evidenceDto.value.contentRevealed, false);
    }
    assert.deepEqual(service.search(ownerId, 'private', 10).assertions, [], 'sensitive facts are not indexed');
    assert.deepEqual(service.search(ownerId, 'Denys', 10).nodes.map((item) => item.id), [owner.id]);
    assert.deepEqual(service.getNeighborhood(ownerId, owner.id, 1).kind, 'found');
  });
});

test('listMemoryHistory pages newest-first and validates the page', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const subject = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: null, displayName: 'Pager',
      description: null, sensitivity: 'personal', properties: {},
    });
    for (let index = 0; index < 5; index += 1) {
      graph.audit.recordMutation({
        ownerId, actorType: 'system', actorRef: null, operation: 'update_node',
        targetType: 'graph_nodes', targetId: subject.id, before: null, after: null,
        reason: `mutation ${index}`,
      });
    }
    const service = new MemoryQueryService(graph);
    const firstPage = service.listMemoryHistory(ownerId, { limit: 3, offset: 0 });
    const secondPage = service.listMemoryHistory(ownerId, { limit: 3, offset: 3 });
    assert.equal(firstPage.length, 3);
    assert.ok(secondPage.length >= 2);
    assert.notDeepEqual(firstPage.map((entry) => entry.id), secondPage.map((entry) => entry.id));
    assert.throws(() => service.listMemoryHistory(ownerId, { limit: 0, offset: 0 }));
    assert.throws(() => service.listMemoryHistory(ownerId, { limit: 10, offset: -1 }));
  });
});

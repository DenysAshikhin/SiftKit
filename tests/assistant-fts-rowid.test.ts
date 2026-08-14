import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { withAssistantContext } from './helpers/assistant-fixture.js';

const FtsRowidSchema = z.object({ fts_rowid: z.number().int().nullable() });
const CountSchema = z.object({ count: z.number() });

test('node FTS rows are tracked by rowid across create, update, and de-index', () => {
  withAssistantContext(({ database, graph, ownerId }) => {
    const node = graph.nodes.createNode({
      ownerId, type: 'software', canonicalKey: null, displayName: 'Rowid Tool',
      description: null, sensitivity: 'personal', properties: {},
    });
    const afterCreate = FtsRowidSchema.parse(
      database.prepare('SELECT fts_rowid FROM graph_nodes WHERE id = ?').get(node.id),
    );
    assert.notEqual(afterCreate.fts_rowid, null, 'create must record the FTS rowid');
    assert.deepEqual(graph.nodes.searchNodes(ownerId, 'Rowid', 10), [node.id]);

    graph.nodes.updateNode(node.id, { displayName: 'Renamed Tool' });
    assert.deepEqual(graph.nodes.searchNodes(ownerId, 'Renamed', 10), [node.id]);
    assert.deepEqual(graph.nodes.searchNodes(ownerId, 'Rowid', 10), []);

    graph.nodes.updateNode(node.id, { sensitivity: 'sensitive' });
    const afterDeindex = FtsRowidSchema.parse(
      database.prepare('SELECT fts_rowid FROM graph_nodes WHERE id = ?').get(node.id),
    );
    assert.equal(afterDeindex.fts_rowid, null, 'de-indexed node must clear fts_rowid');
    const remaining = CountSchema.parse(database.prepare(
      'SELECT COUNT(*) AS count FROM graph_nodes_fts WHERE node_id = ?',
    ).get(node.id));
    assert.equal(remaining.count, 0, 'no orphaned FTS row may remain');
  });
});

test('assertion FTS rows are tracked by rowid across create and retire', () => {
  withAssistantContext(({ database, graph, ownerId }) => {
    const subject = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: null, displayName: 'Subject',
      description: null, sensitivity: 'personal', properties: {},
    });
    const object = graph.nodes.createNode({
      ownerId, type: 'software', canonicalKey: null, displayName: 'Object Tool',
      description: null, sensitivity: 'personal', properties: {},
    });
    const assertion = graph.assertions.createAssertion({
      ownerId, subjectNodeId: subject.id, predicate: 'USES',
      object: { kind: 'node', nodeId: object.id }, scopeNodeId: null,
      status: 'active', basis: 'explicit_user_statement', confidence: 0.9,
      sensitivity: 'personal', validFromUtc: null, validToUtc: null,
      observedAtUtc: '2026-08-05T09:00:00.000Z', supersedesAssertionId: null,
      pinned: false, attributes: {},
      searchText: { subject: 'Subject', predicate: 'uses', object: 'Object Tool', scope: '' },
    });
    assert.notEqual(assertion.fts_rowid, null, 'create must record the FTS rowid');
    assert.deepEqual(graph.assertions.searchAssertions(ownerId, 'Object', 10), [assertion.id]);

    const retired = graph.assertions.retireAssertion(assertion.id, 'superseded');
    assert.equal(retired.fts_rowid, null, 'retire must clear fts_rowid');
    const remaining = CountSchema.parse(database.prepare(
      'SELECT COUNT(*) AS count FROM graph_assertions_fts WHERE assertion_id = ?',
    ).get(assertion.id));
    assert.equal(remaining.count, 0, 'retire must remove the FTS row');
  });
});

test('projection FTS rows are tracked by rowid across upsert, status change, and delete', () => {
  withAssistantContext(({ database, graph, ownerId }) => {
    const projection = graph.projections.upsert({
      ownerId, tier: 2, topicKey: 'rowid-topic', title: 'Rowid Topic',
      content: 'body about unusual rowid topics', contentHash: 'hash-1',
      tokenCount: 8, tokenizerId: 'estimate', graphVersion: 1,
      includedAssertionIds: [], sensitivity: 'personal',
    });
    assert.notEqual(projection.fts_rowid, null, 'upsert must record the FTS rowid');
    assert.deepEqual(graph.projections.search(ownerId, 'unusual', 10), [projection.id]);

    const archived = graph.projections.setStatus(projection.id, 'archived');
    assert.equal(archived.fts_rowid, null, 'non-active projection must clear fts_rowid');
    assert.deepEqual(graph.projections.search(ownerId, 'unusual', 10), []);

    graph.projections.setStatus(projection.id, 'active');
    graph.projections.deleteProjection(projection.id);
    const remaining = CountSchema.parse(database.prepare(
      'SELECT COUNT(*) AS count FROM memory_projections_fts WHERE projection_id = ?',
    ).get(projection.id));
    assert.equal(remaining.count, 0, 'delete must remove the FTS row');
  });
});

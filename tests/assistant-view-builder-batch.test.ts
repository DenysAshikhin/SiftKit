import test from 'node:test';
import assert from 'node:assert/strict';

import { AssertionViewBuilder } from '../src/assistant/projections/assertion-view-builder.js';
import { withAssistantContext } from './helpers/assistant-fixture.js';

test('buildMany resolves node references in one batch and matches build', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const subject = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: null, displayName: 'The User',
      description: null, sensitivity: 'personal', properties: {},
    });
    const rows = [0, 1, 2].map((index) => {
      const object = graph.nodes.createNode({
        ownerId, type: 'software', canonicalKey: null, displayName: `Batch Tool ${index}`,
        description: null, sensitivity: 'personal', properties: {},
      });
      return graph.assertions.createAssertion({
        ownerId, subjectNodeId: subject.id, predicate: 'USES',
        object: { kind: 'node', nodeId: object.id }, scopeNodeId: null,
        status: 'active', basis: 'explicit_user_statement', confidence: 0.9,
        sensitivity: 'personal', validFromUtc: null, validToUtc: null,
        observedAtUtc: '2026-08-05T09:00:00.000Z', supersedesAssertionId: null,
        pinned: false, attributes: {},
        searchText: { subject: 'The User', predicate: 'uses', object: `Batch Tool ${index}`, scope: '' },
      });
    });
    const views = new AssertionViewBuilder(graph);
    const batch = views.buildMany(rows);
    assert.equal(batch.length, rows.length);
    for (const [index, row] of rows.entries()) {
      assert.deepEqual(batch[index], views.build(row));
    }
  });
});

test('buildMany fails loudly on a missing node reference', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const subject = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: null, displayName: 'The User',
      description: null, sensitivity: 'personal', properties: {},
    });
    const object = graph.nodes.createNode({
      ownerId, type: 'software', canonicalKey: null, displayName: 'Tool',
      description: null, sensitivity: 'personal', properties: {},
    });
    const row = graph.assertions.createAssertion({
      ownerId, subjectNodeId: subject.id, predicate: 'USES',
      object: { kind: 'node', nodeId: object.id }, scopeNodeId: null,
      status: 'active', basis: 'explicit_user_statement', confidence: 0.9,
      sensitivity: 'personal', validFromUtc: null, validToUtc: null,
      observedAtUtc: '2026-08-05T09:00:00.000Z', supersedesAssertionId: null,
      pinned: false, attributes: {},
      searchText: { subject: 'The User', predicate: 'uses', object: 'Tool', scope: '' },
    });
    const views = new AssertionViewBuilder(graph);
    const broken = { ...row, subject_node_id: 'node_missing' };
    assert.throws(() => views.buildMany([broken]), /Unknown graph node: node_missing/);
  });
});

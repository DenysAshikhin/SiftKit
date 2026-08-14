import test from 'node:test';
import assert from 'node:assert/strict';

import {
  renderAssertionLiteral, searchTextForAssertion,
} from '../src/assistant/storage/assertion-search-text.js';
import { AssertionViewBuilder } from '../src/assistant/projections/assertion-view-builder.js';
import { withAssistantContext } from './helpers/assistant-fixture.js';

test('searchTextForAssertion renders node objects and scopes from display names', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const subject = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: null, displayName: 'The User',
      description: null, sensitivity: 'personal', properties: {},
    });
    const object = graph.nodes.createNode({
      ownerId, type: 'software', canonicalKey: null, displayName: 'Search Tool',
      description: null, sensitivity: 'personal', properties: {},
    });
    const scope = graph.nodes.createNode({
      ownerId, type: 'project', canonicalKey: null, displayName: 'Side Project',
      description: null, sensitivity: 'personal', properties: {},
    });
    const row = graph.assertions.createAssertion({
      ownerId, subjectNodeId: subject.id, predicate: 'USES',
      object: { kind: 'node', nodeId: object.id }, scopeNodeId: scope.id,
      status: 'active', basis: 'explicit_user_statement', confidence: 0.9,
      sensitivity: 'personal', validFromUtc: null, validToUtc: null,
      observedAtUtc: '2026-08-05T09:00:00.000Z', supersedesAssertionId: null,
      pinned: false, attributes: {},
      searchText: { subject: 'The User', predicate: 'uses', object: 'Search Tool', scope: 'Side Project' },
    });
    assert.deepEqual(searchTextForAssertion(graph.nodes, row), {
      subject: 'The User',
      predicate: 'USES',
      object: 'Search Tool',
      scope: 'Side Project',
    });
  });
});

test('searchTextForAssertion renders literal objects exactly as the view builder does', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const subject = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: null, displayName: 'The User',
      description: null, sensitivity: 'personal', properties: {},
    });
    const row = graph.assertions.createAssertion({
      ownerId, subjectNodeId: subject.id, predicate: 'PREFERS',
      object: { kind: 'literal', valueType: 'string', value: 'Dark Roast' }, scopeNodeId: null,
      status: 'active', basis: 'explicit_user_statement', confidence: 0.9,
      sensitivity: 'personal', validFromUtc: null, validToUtc: null,
      observedAtUtc: '2026-08-05T09:00:00.000Z', supersedesAssertionId: null,
      pinned: false, attributes: {},
      searchText: { subject: 'The User', predicate: 'prefers', object: 'Dark Roast', scope: '' },
    });
    const viewObjectText = new AssertionViewBuilder(graph).build(row).objectText;
    const searchText = searchTextForAssertion(graph.nodes, row);
    assert.equal(searchText.object, viewObjectText, 'FTS and views must share one derivation');
    assert.equal(renderAssertionLiteral(row), viewObjectText);
    assert.equal(searchText.scope, '');
  });
});

test('searchTextForAssertion fails loudly on a missing node or empty literal', () => {
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
    assert.throws(
      () => searchTextForAssertion(graph.nodes, { ...row, subject_node_id: 'node_missing' }),
      /Unknown graph node: node_missing/,
    );
    assert.throws(
      () => searchTextForAssertion(graph.nodes, {
        ...row, object_node_id: null, object_value_type: null, object_value_json: null,
      }),
      /literal object with no value/,
    );
  });
});

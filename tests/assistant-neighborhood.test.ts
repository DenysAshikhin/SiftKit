import test from 'node:test';
import assert from 'node:assert/strict';

import { NeighborhoodReader } from '../src/assistant/graph/neighborhood.js';
import { AssertionStore } from '../src/assistant/storage/assertion-store.js';
import { NodeStore } from '../src/assistant/storage/node-store.js';
import { withAssistantContext, type AssistantTestContext } from './helpers/assistant-fixture.js';

interface TraversalHarness {
  readonly reader: NeighborhoodReader;
  readonly nodes: NodeStore;
  readonly assertions: AssertionStore;
}

function harness(context: AssistantTestContext): TraversalHarness {
  const nodes = new NodeStore(context.database, context.clock, context.ids);
  const assertions = new AssertionStore(context.database, context.clock, context.ids);
  return { reader: new NeighborhoodReader(nodes, assertions), nodes, assertions };
}

function makeNode(
  h: TraversalHarness, context: AssistantTestContext,
  type: Parameters<NodeStore['createNode']>[0]['type'], name: string,
): string {
  return h.nodes.createNode({
    ownerId: context.ownerId, type, canonicalKey: null, displayName: name,
    description: null, sensitivity: 'low', properties: {},
  }).id;
}

function linkAt(
  h: TraversalHarness, context: AssistantTestContext,
  subjectNodeId: string, predicate: 'DEPENDS_ON' | 'RUNS_ON' | 'RELATED_TO',
  objectNodeId: string, observedAtUtc: string,
): string {
  return h.assertions.createAssertion({
    ownerId: context.ownerId, subjectNodeId, predicate,
    object: { kind: 'node', nodeId: objectNodeId }, scopeNodeId: null,
    status: 'active', basis: 'manual_import', confidence: 0.9, sensitivity: 'low',
    validFromUtc: null, validToUtc: null, observedAtUtc,
    supersedesAssertionId: null, pinned: false, attributes: {},
    searchText: { subject: subjectNodeId, predicate, object: objectNodeId, scope: '' },
  }).id;
}

function link(
  h: TraversalHarness, context: AssistantTestContext,
  subjectNodeId: string, predicate: 'DEPENDS_ON' | 'RUNS_ON' | 'RELATED_TO',
  objectNodeId: string,
): string {
  return linkAt(h, context, subjectNodeId, predicate, objectNodeId, '2026-08-05T09:00:00.000Z');
}

const LIMITS = {
  maxHops: 2, maxNodes: 80, maxAssertions: 160, maxFanoutPerNodePredicate: 20,
} as const;

test('a one-hop neighborhood returns the root, its neighbours, and the connecting assertions', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const root = makeNode(h, context, 'project', 'SiftKit');
    const first = makeNode(h, context, 'software', 'better-sqlite3');
    const second = makeNode(h, context, 'software', 'zod');
    const edgeOne = link(h, context, root, 'DEPENDS_ON', first);
    const edgeTwo = link(h, context, root, 'DEPENDS_ON', second);

    const result = h.reader.read({
      ownerId: context.ownerId, rootNodeId: root, predicates: ['DEPENDS_ON'],
      ...LIMITS, maxHops: 1,
    });
    assert.deepEqual([...result.nodeIds].sort(), [root, first, second].sort());
    assert.deepEqual([...result.assertionIds].sort(), [edgeOne, edgeTwo].sort());
    assert.deepEqual(result.truncatedBy, []);
  });
});

test('traversal follows edges in both directions', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const root = makeNode(h, context, 'software', 'better-sqlite3');
    const dependent = makeNode(h, context, 'project', 'SiftKit');
    link(h, context, dependent, 'DEPENDS_ON', root);

    const result = h.reader.read({
      ownerId: context.ownerId, rootNodeId: root, predicates: ['DEPENDS_ON'],
      ...LIMITS, maxHops: 1,
    });
    assert.ok(result.nodeIds.includes(dependent));
  });
});

test('traversal stops at maxHops and reports the truncation', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const hop0 = makeNode(h, context, 'project', 'Root');
    const hop1 = makeNode(h, context, 'software', 'Hop 1');
    const hop2 = makeNode(h, context, 'software', 'Hop 2');
    const hop3 = makeNode(h, context, 'software', 'Hop 3');
    link(h, context, hop0, 'DEPENDS_ON', hop1);
    link(h, context, hop1, 'DEPENDS_ON', hop2);
    link(h, context, hop2, 'DEPENDS_ON', hop3);

    const twoHops = h.reader.read({
      ownerId: context.ownerId, rootNodeId: hop0, predicates: ['DEPENDS_ON'], ...LIMITS,
    });
    assert.deepEqual([...twoHops.nodeIds].sort(), [hop0, hop1, hop2].sort());
    assert.deepEqual(twoHops.truncatedBy, ['max_hops']);

    const threeHops = h.reader.read({
      ownerId: context.ownerId, rootNodeId: hop0, predicates: ['DEPENDS_ON'],
      ...LIMITS, maxHops: 3,
    });
    assert.equal(threeHops.nodeIds.length, 4);
    assert.deepEqual(threeHops.truncatedBy, []);
  });
});

test('only the requested predicates are followed', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const root = makeNode(h, context, 'project', 'SiftKit');
    const dependency = makeNode(h, context, 'software', 'zod');
    const host = makeNode(h, context, 'device', 'Workstation');
    link(h, context, root, 'DEPENDS_ON', dependency);
    link(h, context, root, 'RUNS_ON', host);

    const result = h.reader.read({
      ownerId: context.ownerId, rootNodeId: root, predicates: ['DEPENDS_ON'],
      ...LIMITS, maxHops: 1,
    });
    assert.ok(result.nodeIds.includes(dependency));
    assert.equal(result.nodeIds.includes(host), false);
  });
});

test('RELATED_TO is not expanded unless explicitly allowlisted', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const root = makeNode(h, context, 'topic', 'Root topic');
    const related = makeNode(h, context, 'topic', 'Loosely related');
    link(h, context, root, 'RELATED_TO', related);

    const withoutAllowlist = h.reader.read({
      ownerId: context.ownerId, rootNodeId: root, predicates: ['DEPENDS_ON', 'RUNS_ON'],
      ...LIMITS, maxHops: 2,
    });
    assert.deepEqual([...withoutAllowlist.nodeIds], [root]);

    const withAllowlist = h.reader.read({
      ownerId: context.ownerId, rootNodeId: root, predicates: ['RELATED_TO'],
      ...LIMITS, maxHops: 1,
    });
    assert.ok(withAllowlist.nodeIds.includes(related));
  });
});

test('fanout per node and predicate is capped and reported', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const root = makeNode(h, context, 'project', 'SiftKit');
    for (let index = 0; index < 30; index += 1) {
      link(h, context, root, 'DEPENDS_ON', makeNode(h, context, 'software', `dep ${index}`));
    }
    const result = h.reader.read({
      ownerId: context.ownerId, rootNodeId: root, predicates: ['DEPENDS_ON'],
      ...LIMITS, maxHops: 1, maxFanoutPerNodePredicate: 5,
    });
    assert.equal(result.nodeIds.length, 6, 'root plus five neighbours');
    assert.equal(result.assertionIds.length, 5);
    assert.ok(result.truncatedBy.includes('max_fanout'));
  });
});

test('the node cap is never exceeded and is reported', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const root = makeNode(h, context, 'project', 'SiftKit');
    for (let index = 0; index < 30; index += 1) {
      link(h, context, root, 'DEPENDS_ON', makeNode(h, context, 'software', `dep ${index}`));
    }
    const result = h.reader.read({
      ownerId: context.ownerId, rootNodeId: root, predicates: ['DEPENDS_ON'],
      ...LIMITS, maxHops: 1, maxNodes: 10,
    });
    assert.ok(result.nodeIds.length <= 10);
    assert.ok(result.truncatedBy.includes('max_nodes'));
  });
});

test('the assertion cap is never exceeded and is reported', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const root = makeNode(h, context, 'project', 'SiftKit');
    for (let index = 0; index < 30; index += 1) {
      link(h, context, root, 'DEPENDS_ON', makeNode(h, context, 'software', `dep ${index}`));
    }
    const result = h.reader.read({
      ownerId: context.ownerId, rootNodeId: root, predicates: ['DEPENDS_ON'],
      ...LIMITS, maxHops: 1, maxAssertions: 7,
    });
    assert.ok(result.assertionIds.length <= 7);
    assert.ok(result.truncatedBy.includes('max_assertions'));
  });
});

test('a cycle in the graph terminates without repeating a node', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const first = makeNode(h, context, 'software', 'A');
    const second = makeNode(h, context, 'software', 'B');
    const third = makeNode(h, context, 'software', 'C');
    link(h, context, first, 'DEPENDS_ON', second);
    link(h, context, second, 'DEPENDS_ON', third);
    link(h, context, third, 'DEPENDS_ON', first);

    const result = h.reader.read({
      ownerId: context.ownerId, rootNodeId: first, predicates: ['DEPENDS_ON'],
      ...LIMITS, maxHops: 3,
    });
    assert.equal(new Set(result.nodeIds).size, result.nodeIds.length);
    assert.deepEqual([...result.nodeIds].sort(), [first, second, third].sort());
  });
});

test('frontier edges the traversal cannot follow are not reported as a hop truncation', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const root = makeNode(h, context, 'project', 'Root');
    const hop1 = makeNode(h, context, 'software', 'Hop 1');
    const offPredicate = makeNode(h, context, 'device', 'Workstation');
    link(h, context, root, 'DEPENDS_ON', hop1);
    link(h, context, hop1, 'RUNS_ON', offPredicate);
    h.assertions.createAssertion({
      ownerId: context.ownerId, subjectNodeId: hop1, predicate: 'DEPENDS_ON',
      object: { kind: 'literal', valueType: 'string', value: 'libc' },
      scopeNodeId: null, status: 'active', basis: 'manual_import', confidence: 0.9,
      sensitivity: 'low', validFromUtc: null, validToUtc: null,
      observedAtUtc: '2026-08-05T09:00:00.000Z', supersedesAssertionId: null,
      pinned: false, attributes: {},
      searchText: { subject: hop1, predicate: 'DEPENDS_ON', object: 'libc', scope: '' },
    });

    const result = h.reader.read({
      ownerId: context.ownerId, rootNodeId: root, predicates: ['DEPENDS_ON'],
      ...LIMITS, maxHops: 1,
    });
    assert.deepEqual([...result.nodeIds].sort(), [root, hop1].sort());
    assert.deepEqual(result.truncatedBy, []);
  });
});

test('listTopLiveNodeEdges returns the most recent subject-side edges, bounded and ordered', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const root = makeNode(h, context, 'project', 'SiftKit');
    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      ids.push(linkAt(
        h, context, root, 'DEPENDS_ON', makeNode(h, context, 'software', `dep ${index}`),
        `2026-08-0${index + 1}T09:00:00.000Z`,
      ));
    }

    const top = h.assertions.listTopLiveNodeEdges(context.ownerId, root, 'subject', 'DEPENDS_ON', 2);
    assert.deepEqual(top.map((row) => row.id), [ids[3], ids[2]]);
  });
});

test('listTopLiveNodeEdges returns object-side edges for the object direction only', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const root = makeNode(h, context, 'software', 'better-sqlite3');
    const dependent = makeNode(h, context, 'project', 'SiftKit');
    const incoming = link(h, context, dependent, 'DEPENDS_ON', root);

    const objectSide = h.assertions.listTopLiveNodeEdges(
      context.ownerId, root, 'object', 'DEPENDS_ON', 5,
    );
    assert.deepEqual(objectSide.map((row) => row.id), [incoming]);
    assert.deepEqual(
      h.assertions.listTopLiveNodeEdges(context.ownerId, root, 'subject', 'DEPENDS_ON', 5),
      [],
    );
  });
});

test('listTopLiveNodeEdges excludes retired, literal-object, and other-predicate assertions', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const root = makeNode(h, context, 'project', 'SiftKit');
    const live = link(h, context, root, 'DEPENDS_ON', makeNode(h, context, 'software', 'zod'));
    const retired = link(h, context, root, 'DEPENDS_ON', makeNode(h, context, 'software', 'gone'));
    h.assertions.retireAssertion(retired, 'superseded');
    link(h, context, root, 'RUNS_ON', makeNode(h, context, 'device', 'Workstation'));
    h.assertions.createAssertion({
      ownerId: context.ownerId, subjectNodeId: root, predicate: 'DEPENDS_ON',
      object: { kind: 'literal', valueType: 'string', value: 'libc' },
      scopeNodeId: null, status: 'active', basis: 'manual_import', confidence: 0.9,
      sensitivity: 'low', validFromUtc: null, validToUtc: null,
      observedAtUtc: '2026-08-05T09:00:00.000Z', supersedesAssertionId: null,
      pinned: false, attributes: {},
      searchText: { subject: root, predicate: 'DEPENDS_ON', object: 'libc', scope: '' },
    });

    const top = h.assertions.listTopLiveNodeEdges(
      context.ownerId, root, 'subject', 'DEPENDS_ON', 10,
    );
    assert.deepEqual(top.map((row) => row.id), [live]);
  });
});

test('listLiveNodeEdgeIds returns ids for allowlisted live node edges only, bounded', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const root = makeNode(h, context, 'project', 'SiftKit');
    const outgoing = link(h, context, root, 'DEPENDS_ON', makeNode(h, context, 'software', 'zod'));
    const incoming = link(h, context, makeNode(h, context, 'project', 'App'), 'DEPENDS_ON', root);
    const retired = link(h, context, root, 'DEPENDS_ON', makeNode(h, context, 'software', 'gone'));
    h.assertions.retireAssertion(retired, 'superseded');
    link(h, context, root, 'RUNS_ON', makeNode(h, context, 'device', 'Workstation'));

    assert.deepEqual(
      h.assertions.listLiveNodeEdgeIds(context.ownerId, root, 'subject', ['DEPENDS_ON'], 10),
      [outgoing],
    );
    assert.deepEqual(
      h.assertions.listLiveNodeEdgeIds(context.ownerId, root, 'object', ['DEPENDS_ON'], 10),
      [incoming],
    );
    assert.deepEqual(
      h.assertions.listLiveNodeEdgeIds(context.ownerId, root, 'subject', ['DEPENDS_ON'], 10)
        .concat(h.assertions.listLiveNodeEdgeIds(context.ownerId, root, 'subject', [], 10)),
      [outgoing],
    );
    assert.equal(
      h.assertions.listLiveNodeEdgeIds(
        context.ownerId, root, 'subject', ['DEPENDS_ON', 'RUNS_ON'], 1,
      ).length,
      1,
    );
  });
});

test('the fanout cap keeps the most recent edges, subject side before object side', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const root = makeNode(h, context, 'project', 'Root');
    const subjectEdges: string[] = [];
    const objectEdges: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      subjectEdges.push(linkAt(
        h, context, root, 'DEPENDS_ON', makeNode(h, context, 'software', `out ${index}`),
        `2026-08-01T0${index * 2}:00:00.000Z`,
      ));
      objectEdges.push(linkAt(
        h, context, makeNode(h, context, 'project', `in ${index}`), 'DEPENDS_ON', root,
        `2026-08-01T0${index * 2 + 1}:00:00.000Z`,
      ));
    }

    const result = h.reader.read({
      ownerId: context.ownerId, rootNodeId: root, predicates: ['DEPENDS_ON'],
      ...LIMITS, maxHops: 1, maxFanoutPerNodePredicate: 5,
    });
    const expected = [...subjectEdges, objectEdges[3]].filter(
      (id): id is string => id !== undefined,
    );
    assert.deepEqual([...result.assertionIds].sort(), [...expected].sort());
    assert.ok(result.truncatedBy.includes('max_fanout'));
  });
});

test('retired and deleted assertions are not traversed', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const root = makeNode(h, context, 'project', 'SiftKit');
    const live = makeNode(h, context, 'software', 'zod');
    const gone = makeNode(h, context, 'software', 'removed');
    link(h, context, root, 'DEPENDS_ON', live);
    const retired = link(h, context, root, 'DEPENDS_ON', gone);
    h.assertions.retireAssertion(retired, 'superseded');

    const result = h.reader.read({
      ownerId: context.ownerId, rootNodeId: root, predicates: ['DEPENDS_ON'],
      ...LIMITS, maxHops: 1,
    });
    assert.deepEqual([...result.nodeIds].sort(), [root, live].sort());
  });
});
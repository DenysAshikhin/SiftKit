import test from 'node:test';
import assert from 'node:assert/strict';

import { NodeMergeService } from '../src/assistant/graph/merge-service.js';
import { AssertionStore } from '../src/assistant/storage/assertion-store.js';
import { AuditStore } from '../src/assistant/storage/audit-store.js';
import { NodeStore } from '../src/assistant/storage/node-store.js';
import { PolicyStore } from '../src/assistant/storage/policy-store.js';
import { AssistantTransactionManager } from '../src/assistant/transactions/assistant-transaction-manager.js';
import { OWNER_PERSON_CANONICAL_KEY } from '../src/assistant/storage/schema.js';
import { withAssistantContext, type AssistantTestContext } from './helpers/assistant-fixture.js';

interface MergeHarness {
  readonly merges: NodeMergeService;
  readonly nodes: NodeStore;
  readonly assertions: AssertionStore;
  readonly audit: AuditStore;
  readonly policies: PolicyStore;
  readonly personId: string;
}

function harness(context: AssistantTestContext): MergeHarness {
  const nodes = new NodeStore(context.database, context.clock, context.ids);
  const assertions = new AssertionStore(context.database, context.clock, context.ids);
  const audit = new AuditStore(context.database, context.clock, context.ids);
  const policies = new PolicyStore(context.database, context.clock, context.ids);
  const transactions = new AssistantTransactionManager(context.database);
  const merges = new NodeMergeService(
    transactions, nodes, assertions, audit, policies,
  );
  const person = nodes.createNode({
    ownerId: context.ownerId, type: 'person', canonicalKey: OWNER_PERSON_CANONICAL_KEY,
    displayName: 'Denys', description: null, sensitivity: 'personal', properties: {},
  });
  return { merges, nodes, assertions, audit, policies, personId: person.id };
}

function makeSoftware(
  h: MergeHarness, context: AssistantTestContext, key: string | null, name: string,
): string {
  return h.nodes.createNode({
    ownerId: context.ownerId, type: 'software', canonicalKey: key, displayName: name,
    description: null, sensitivity: 'low', properties: {},
  }).id;
}

function makeUses(
  h: MergeHarness, context: AssistantTestContext, objectNodeId: string, name: string,
): string {
  return h.assertions.createAssertion({
    ownerId: context.ownerId, subjectNodeId: h.personId, predicate: 'USES',
    object: { kind: 'node', nodeId: objectNodeId }, scopeNodeId: null,
    status: 'active', basis: 'passive_observation', confidence: 0.5, sensitivity: 'personal',
    validFromUtc: null, validToUtc: null, observedAtUtc: '2026-08-05T09:00:00.000Z',
    supersedesAssertionId: null, pinned: false, attributes: {},
    searchText: { subject: 'Denys', predicate: 'uses', object: name, scope: '' },
  }).id;
}

test('a merge re-points assertions and aliases and marks the source merged', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const target = makeSoftware(h, context, 'software:vscode', 'Visual Studio Code');
    const source = makeSoftware(h, context, null, 'VSCode');
    h.nodes.addAlias({
      ownerId: context.ownerId, nodeId: source, alias: 'vsc',
      aliasType: 'name', sourceEvidenceId: null,
    });
    const assertionId = makeUses(h, context, source, 'VSCode');

    const outcome = h.merges.merge({
      ownerId: context.ownerId, sourceNodeId: source, targetNodeId: target,
      actorType: 'user', basis: 'user confirmed they are the same editor', reason: 'user merge',
    });
    assert.equal(outcome.kind, 'merged');
    if (outcome.kind !== 'merged') return;

    const merged = h.nodes.requireNode(source);
    assert.equal(merged.status, 'merged');
    assert.equal(merged.merged_into_node_id, target);
    assert.equal(h.assertions.requireAssertion(assertionId).object_node_id, target);
    assert.deepEqual(
      h.nodes.listAliases(target).map((alias) => alias.normalized_alias).sort(),
      ['vsc'],
    );
    assert.equal(h.nodes.listAliases(source).length, 0);
    assert.equal(h.nodes.listMerges(context.ownerId).length, 1);
  });
});

test('a merge is reversible and restores every moved reference', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const target = makeSoftware(h, context, 'software:vscode', 'Visual Studio Code');
    const source = makeSoftware(h, context, null, 'VSCode');
    h.nodes.addAlias({
      ownerId: context.ownerId, nodeId: source, alias: 'vsc',
      aliasType: 'name', sourceEvidenceId: null,
    });
    const assertionId = makeUses(h, context, source, 'VSCode');
    const originalKey = h.assertions.requireAssertion(assertionId).assertion_key;

    const outcome = h.merges.merge({
      ownerId: context.ownerId, sourceNodeId: source, targetNodeId: target,
      actorType: 'user', basis: 'automatic alias match', reason: 'merge',
    });
    if (outcome.kind !== 'merged') return;

    h.merges.unmerge({
      ownerId: context.ownerId, mergeId: outcome.mergeId, reason: 'user reversed the merge',
    });

    const restored = h.nodes.requireNode(source);
    assert.equal(restored.status, 'active');
    assert.equal(restored.merged_into_node_id, null);
    const restoredAssertion = h.assertions.requireAssertion(assertionId);
    assert.equal(restoredAssertion.object_node_id, source);
    assert.equal(restoredAssertion.assertion_key, originalKey);
    assert.deepEqual(h.nodes.listAliases(source).map((alias) => alias.normalized_alias), ['vsc']);
    assert.equal(h.nodes.listAliases(target).length, 0);
    assert.notEqual(h.nodes.requireMerge(outcome.mergeId).reversed_at_utc, null);
  });
});

test('a merge that would collide two live assertions retires the weaker one', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const target = makeSoftware(h, context, 'software:vscode', 'Visual Studio Code');
    const source = makeSoftware(h, context, null, 'VSCode');
    const keptId = makeUses(h, context, target, 'Visual Studio Code');
    const collidingId = makeUses(h, context, source, 'VSCode');

    const outcome = h.merges.merge({
      ownerId: context.ownerId, sourceNodeId: source, targetNodeId: target,
      actorType: 'user', basis: 'user confirmed', reason: 'merge',
    });
    assert.equal(outcome.kind, 'merged');

    assert.equal(h.assertions.requireAssertion(keptId).status, 'active');
    assert.equal(h.assertions.requireAssertion(collidingId).status, 'superseded');
    assert.equal(
      h.assertions.listBySubject(context.ownerId, h.personId, ['active']).length, 1,
    );
  });
});

test('unmerging a colliding merge reindexes a reactivated assertion', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const target = makeSoftware(h, context, 'software:vscode', 'Visual Studio Code');
    const source = makeSoftware(h, context, null, 'VSCode');
    const keptId = makeUses(h, context, target, 'Visual Studio Code');
    const retiredId = makeUses(h, context, source, 'VSCode');
    assert.deepEqual(h.assertions.searchAssertions(context.ownerId, 'VSCode', 10), [retiredId]);

    const outcome = h.merges.merge({
      ownerId: context.ownerId, sourceNodeId: source, targetNodeId: target,
      actorType: 'user', basis: 'user confirmed', reason: 'merge',
    });
    assert.equal(outcome.kind, 'merged');
    if (outcome.kind !== 'merged') return;
    assert.equal(h.assertions.requireAssertion(keptId).status, 'active');
    assert.equal(h.assertions.requireAssertion(retiredId).status, 'superseded');
    assert.deepEqual(h.assertions.searchAssertions(context.ownerId, 'VSCode', 10), []);

    h.merges.unmerge({
      ownerId: context.ownerId, mergeId: outcome.mergeId, reason: 'reversed',
    });

    const restored = h.assertions.requireAssertion(retiredId);
    assert.equal(restored.status, 'active');
    assert.notEqual(restored.fts_rowid, null);
    assert.deepEqual(h.assertions.searchAssertions(context.ownerId, 'VSCode', 10), [retiredId]);
  });
});

test('merging different node types is blocked', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const software = makeSoftware(h, context, 'software:vscode', 'Visual Studio Code');
    const outcome = h.merges.merge({
      ownerId: context.ownerId, sourceNodeId: h.personId, targetNodeId: software,
      actorType: 'user', basis: 'bad idea', reason: 'merge',
    });
    assert.equal(outcome.kind, 'blocked');
    assert.equal(outcome.kind === 'blocked' && outcome.code, 'type_mismatch');
  });
});

test('merging two nodes that both carry distinct canonical keys is blocked', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const first = makeSoftware(h, context, 'software:vscode', 'Visual Studio Code');
    const second = makeSoftware(h, context, 'software:neovim', 'Neovim');
    const outcome = h.merges.merge({
      ownerId: context.ownerId, sourceNodeId: second, targetNodeId: first,
      actorType: 'assistant_proposal', basis: 'name similarity', reason: 'merge',
    });
    assert.equal(outcome.kind === 'blocked' && outcome.code, 'canonical_key_conflict');
  });
});

test('merging the owner with a third party is blocked', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const other = h.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: 'person:colleague',
      displayName: 'Alex', description: null, sensitivity: 'personal', properties: {},
    });
    const outcome = h.merges.merge({
      ownerId: context.ownerId, sourceNodeId: other.id, targetNodeId: h.personId,
      actorType: 'assistant_proposal', basis: 'both are people', reason: 'merge',
    });
    assert.equal(outcome.kind === 'blocked' && outcome.code, 'owner_identity_collapse');
  });
});

test('a do_not_merge_node policy blocks the merge in both directions', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const first = makeSoftware(h, context, null, 'Editor A');
    const second = makeSoftware(h, context, null, 'Editor B');
    h.policies.blockMerge(context.ownerId, first, second, 'user said they differ');

    assert.equal(
      h.merges.merge({
        ownerId: context.ownerId, sourceNodeId: first, targetNodeId: second,
        actorType: 'user', basis: 'x', reason: 'merge',
      }).kind === 'blocked', true,
    );
    const reverse = h.merges.merge({
      ownerId: context.ownerId, sourceNodeId: second, targetNodeId: first,
      actorType: 'user', basis: 'x', reason: 'merge',
    });
    assert.equal(reverse.kind === 'blocked' && reverse.code, 'do_not_merge_policy');
  });
});

test('a merge that would form a cycle is blocked', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const first = makeSoftware(h, context, null, 'Editor A');
    const second = makeSoftware(h, context, null, 'Editor B');
    const forward = h.merges.merge({
      ownerId: context.ownerId, sourceNodeId: first, targetNodeId: second,
      actorType: 'user', basis: 'user confirmed', reason: 'merge',
    });
    assert.equal(forward.kind, 'merged');

    const cycle = h.merges.merge({
      ownerId: context.ownerId, sourceNodeId: second, targetNodeId: first,
      actorType: 'user', basis: 'user confirmed', reason: 'merge',
    });
    assert.equal(cycle.kind === 'blocked' && cycle.code, 'merge_cycle');
  });
});

test('a merge blocked by incompatible explicit assertions reports that reason', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const first = makeSoftware(h, context, null, 'Editor A');
    const second = makeSoftware(h, context, null, 'Editor B');
    const explicitSetting = (nodeId: string, value: string) =>
      h.assertions.createAssertion({
        ownerId: context.ownerId, subjectNodeId: nodeId, predicate: 'HAS_SETTING',
        object: { kind: 'literal', valueType: 'string', value },
        scopeNodeId: null, status: 'active', basis: 'explicit_user_statement',
        confidence: 0.99, sensitivity: 'low', validFromUtc: null, validToUtc: null,
        observedAtUtc: '2026-08-05T09:00:00.000Z', supersedesAssertionId: null,
        pinned: false, attributes: {},
        searchText: { subject: nodeId, predicate: 'has setting', object: value, scope: '' },
      });
    explicitSetting(first, 'theme dark');
    explicitSetting(second, 'theme light');

    const outcome = h.merges.merge({
      ownerId: context.ownerId, sourceNodeId: first, targetNodeId: second,
      actorType: 'assistant_proposal', basis: 'name similarity', reason: 'merge',
    });
    assert.equal(outcome.kind === 'blocked' && outcome.code, 'incompatible_explicit_assertions');
  });
});

test('a merge and its reversal both appear in the mutation log', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const target = makeSoftware(h, context, 'software:vscode', 'Visual Studio Code');
    const source = makeSoftware(h, context, null, 'VSCode');
    const outcome = h.merges.merge({
      ownerId: context.ownerId, sourceNodeId: source, targetNodeId: target,
      actorType: 'user', basis: 'user confirmed', reason: 'merge',
    });
    if (outcome.kind !== 'merged') return;
    h.merges.unmerge({
      ownerId: context.ownerId, mergeId: outcome.mergeId, reason: 'reversed',
    });

    const log = h.audit.listMutations(context.ownerId, 'graph_nodes', source);
    assert.deepEqual(log.map((entry) => entry.operation), ['merge_node', 'unmerge_node']);
  });
});

/**
 * The guard keyed off `person:self` while every production path writes `person:owner`, so
 * `owner_identity_collapse` never fired outside this suite: `CandidatePromoter`,
 * `ProjectionCompiler`, and `AssistantService` all use `OWNER_PERSON_CANONICAL_KEY`.
 */
test('the guard fires for the canonical key the runtime actually writes', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    assert.equal(
      h.nodes.requireNode(h.personId).canonical_key, OWNER_PERSON_CANONICAL_KEY,
      'the harness owner must carry the key the runtime writes',
    );
    const other = h.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: null,
      displayName: 'denys', description: null, sensitivity: 'personal', properties: {},
    });

    const outcome = h.merges.merge({
      ownerId: context.ownerId, sourceNodeId: other.id, targetNodeId: h.personId,
      actorType: 'assistant_proposal', basis: 'both are people', reason: 'merge',
    });

    assert.equal(outcome.kind === 'blocked' && outcome.code, 'owner_identity_collapse');
  });
});

/**
 * OCR reads the owner's name off a title bar several ways, so consolidating those spellings onto
 * the owner is a routine repair — but only ever on the owner's own instruction. A model that
 * decided a third party were the owner must still be refused.
 */
test('the owner may merge a duplicate of themselves when they ask for it', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const duplicate = h.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: null,
      displayName: 'demyus', description: null, sensitivity: 'personal', properties: {},
    });
    const software = makeSoftware(h, context, 'software:vscode-dup', 'VS Code');
    const stranded = h.assertions.createAssertion({
      ownerId: context.ownerId, subjectNodeId: duplicate.id, predicate: 'USES',
      object: { kind: 'node', nodeId: software }, scopeNodeId: null, status: 'active',
      basis: 'passive_observation', confidence: 0.7, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, observedAtUtc: '2026-08-05T09:00:00.000Z',
      supersedesAssertionId: null, pinned: false, attributes: {},
      searchText: { subject: 'demyus', predicate: 'USES', object: 'VS Code', scope: '' },
    });

    const outcome = h.merges.merge({
      ownerId: context.ownerId, sourceNodeId: duplicate.id, targetNodeId: h.personId,
      actorType: 'user', basis: 'the owner confirmed this spelling is them',
      reason: 'owner alias consolidation',
    });

    assert.equal(outcome.kind, 'merged');
    assert.equal(h.assertions.requireAssertion(stranded.id).subject_node_id, h.personId);
    assert.equal(h.nodes.requireNode(duplicate.id).status, 'merged');
  });
});

test('an assistant-proposed merge into the owner is still refused', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const other = h.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: null,
      displayName: 'a colleague', description: null, sensitivity: 'personal', properties: {},
    });

    const outcome = h.merges.merge({
      ownerId: context.ownerId, sourceNodeId: other.id, targetNodeId: h.personId,
      actorType: 'assistant_proposal', basis: 'name similarity', reason: 'merge',
    });

    assert.equal(outcome.kind === 'blocked' && outcome.code, 'owner_identity_collapse');
  });
});

/**
 * `claimNodeAsOwner` shows these counts to the owner. Counting the source's live assertions
 * before the merge overstated them: a duplicate of a fact the target already holds is retired
 * as the weaker half of a collision, not moved.
 */
test('a merge reports moved and retired assertions separately', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const target = makeSoftware(h, context, 'software:vscode', 'Visual Studio Code');
    const source = makeSoftware(h, context, null, 'VSCode');
    makeUses(h, context, target, 'Visual Studio Code');
    const collidingId = makeUses(h, context, source, 'VSCode');
    const colleague = h.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: null, displayName: 'Alice',
      description: null, sensitivity: 'personal', properties: {},
    });
    const movedId = h.assertions.createAssertion({
      ownerId: context.ownerId, subjectNodeId: colleague.id, predicate: 'USES',
      object: { kind: 'node', nodeId: source }, scopeNodeId: null,
      status: 'active', basis: 'passive_observation', confidence: 0.5, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, observedAtUtc: '2026-08-05T09:00:00.000Z',
      supersedesAssertionId: null, pinned: false, attributes: {},
      searchText: { subject: 'Alice', predicate: 'uses', object: 'VSCode', scope: '' },
    }).id;

    const outcome = h.merges.merge({
      ownerId: context.ownerId, sourceNodeId: source, targetNodeId: target,
      actorType: 'user', basis: 'user confirmed', reason: 'merge',
    });

    assert.equal(outcome.kind, 'merged');
    if (outcome.kind !== 'merged') return;
    assert.equal(outcome.movedAssertionCount, 1);
    assert.equal(outcome.retiredAssertionCount, 1);
    assert.equal(h.assertions.requireAssertion(movedId).object_node_id, target);
    assert.equal(h.assertions.requireAssertion(collidingId).status, 'superseded');
  });
});

/** A merge only ever consolidates *into* the owner. Merging the owner away would leave
 * `ownerPersonId` pointing at a merged node, whatever actor asked. */
test('even the owner cannot merge the owner node into another person', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const other = h.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: null, displayName: 'demyx',
      description: null, sensitivity: 'personal', properties: {},
    });

    const outcome = h.merges.merge({
      ownerId: context.ownerId, sourceNodeId: h.personId, targetNodeId: other.id,
      actorType: 'user', basis: 'wrong direction', reason: 'merge',
    });

    assert.equal(outcome.kind === 'blocked' && outcome.code, 'owner_identity_collapse');
    assert.equal(h.nodes.requireNode(h.personId).status, 'active');
  });
});

test('the mutation log records who asked for the merge', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const target = makeSoftware(h, context, 'software:vscode', 'Visual Studio Code');
    const source = makeSoftware(h, context, null, 'VSCode');

    const outcome = h.merges.merge({
      ownerId: context.ownerId, sourceNodeId: source, targetNodeId: target,
      actorType: 'assistant_proposal', basis: 'alias match', reason: 'merge',
    });

    assert.equal(outcome.kind, 'merged');
    const entry = h.audit.listMutations(context.ownerId, 'graph_nodes', source)
      .find((row) => row.operation === 'merge_node');
    assert.equal(entry?.actor_type, 'assistant_proposal');
  });
});

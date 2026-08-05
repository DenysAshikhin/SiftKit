import test from 'node:test';
import assert from 'node:assert/strict';

import { EntityResolver } from '../src/assistant/graph/entity-resolver.js';
import { AuditStore } from '../src/assistant/storage/audit-store.js';
import { NodeStore } from '../src/assistant/storage/node-store.js';
import { withAssistantContext, type AssistantTestContext } from './helpers/assistant-fixture.js';

interface ResolverHarness {
  readonly resolver: EntityResolver;
  readonly nodes: NodeStore;
}

function harness(context: AssistantTestContext): ResolverHarness {
  const nodes = new NodeStore(context.database, context.clock, context.ids);
  const audit = new AuditStore(context.database, context.clock, context.ids);
  return { resolver: new EntityResolver(nodes, audit), nodes };
}

test('step 1: a canonical key resolves directly', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const node = h.nodes.createNode({
      ownerId: context.ownerId, type: 'software', canonicalKey: 'software:powershell',
      displayName: 'PowerShell', description: null, sensitivity: 'low', properties: {},
    });
    const outcome = h.resolver.resolve({
      ownerId: context.ownerId, nodeType: 'software', displayName: 'Whatever',
      canonicalKey: 'software:powershell', contextNodeIds: [], createIfMissing: false,
    });
    assert.equal(outcome.kind, 'resolved');
    assert.equal(outcome.kind === 'resolved' && outcome.nodeId, node.id);
    assert.equal(outcome.kind === 'resolved' && outcome.step, 'canonical_key');
  });
});

test('step 2: a user-supplied alias outranks a machine-supplied one', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const machine = h.nodes.createNode({
      ownerId: context.ownerId, type: 'software', canonicalKey: 'software:code-oss',
      displayName: 'Code OSS', description: null, sensitivity: 'low', properties: {},
    });
    const chosen = h.nodes.createNode({
      ownerId: context.ownerId, type: 'software', canonicalKey: 'software:vscode',
      displayName: 'Visual Studio Code', description: null, sensitivity: 'low', properties: {},
    });
    h.nodes.addAlias({
      ownerId: context.ownerId, nodeId: machine.id, alias: 'code',
      aliasType: 'name', sourceEvidenceId: null,
    });
    h.nodes.addAlias({
      ownerId: context.ownerId, nodeId: chosen.id, alias: 'code',
      aliasType: 'user_supplied', sourceEvidenceId: null,
    });

    const outcome = h.resolver.resolve({
      ownerId: context.ownerId, nodeType: 'software', displayName: 'code',
      canonicalKey: null, contextNodeIds: [], createIfMissing: false,
    });
    assert.equal(outcome.kind === 'resolved' && outcome.nodeId, chosen.id);
    assert.equal(outcome.kind === 'resolved' && outcome.step, 'user_alias');
  });
});

test('step 3: a unique normalized alias of the right type resolves', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const node = h.nodes.createNode({
      ownerId: context.ownerId, type: 'model', canonicalKey: 'model:qwen3.5-27b',
      displayName: 'Qwen3.5 27B', description: null, sensitivity: 'low', properties: {},
    });
    h.nodes.addAlias({
      ownerId: context.ownerId, nodeId: node.id, alias: 'Qwen 3.5',
      aliasType: 'model', sourceEvidenceId: null,
    });
    const outcome = h.resolver.resolve({
      ownerId: context.ownerId, nodeType: 'model', displayName: '  qwen   3.5 ',
      canonicalKey: null, contextNodeIds: [], createIfMissing: false,
    });
    assert.equal(outcome.kind === 'resolved' && outcome.nodeId, node.id);
    assert.equal(outcome.kind === 'resolved' && outcome.step, 'normalized_alias');
  });
});

test('an alias matching two nodes of the same type needs confirmation, never a guess', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const first = h.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: 'person:alex-1',
      displayName: 'Alex Smith', description: null, sensitivity: 'personal', properties: {},
    });
    const second = h.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: 'person:alex-2',
      displayName: 'Alex Jones', description: null, sensitivity: 'personal', properties: {},
    });
    for (const nodeId of [first.id, second.id]) {
      h.nodes.addAlias({
        ownerId: context.ownerId, nodeId, alias: 'Alex',
        aliasType: 'name', sourceEvidenceId: null,
      });
    }
    const outcome = h.resolver.resolve({
      ownerId: context.ownerId, nodeType: 'person', displayName: 'Alex',
      canonicalKey: null, contextNodeIds: [], createIfMissing: true,
    });
    assert.equal(outcome.kind, 'needs_confirmation');
    assert.deepEqual(
      outcome.kind === 'needs_confirmation' ? [...outcome.candidateNodeIds].sort() : [],
      [first.id, second.id].sort(),
    );
  });
});

test('step 4: an ambiguous alias resolves uniquely when context disambiguates it', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const work = h.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: 'person:alex-work',
      displayName: 'Alex Smith', description: null, sensitivity: 'personal', properties: {},
    });
    const other = h.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: 'person:alex-other',
      displayName: 'Alex Jones', description: null, sensitivity: 'personal', properties: {},
    });
    for (const nodeId of [work.id, other.id]) {
      h.nodes.addAlias({
        ownerId: context.ownerId, nodeId, alias: 'Alex',
        aliasType: 'name', sourceEvidenceId: null,
      });
    }
    const outcome = h.resolver.resolve({
      ownerId: context.ownerId, nodeType: 'person', displayName: 'Alex',
      canonicalKey: null, contextNodeIds: [work.id], createIfMissing: false,
    });
    assert.equal(outcome.kind === 'resolved' && outcome.nodeId, work.id);
    assert.equal(outcome.kind === 'resolved' && outcome.step, 'context_match');
  });
});

test('step 6: an unmatched name creates a node, with the name registered as an alias', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const outcome = h.resolver.resolve({
      ownerId: context.ownerId, nodeType: 'software', displayName: 'Neovim',
      canonicalKey: 'software:neovim', contextNodeIds: [], createIfMissing: true,
    });
    assert.equal(outcome.kind, 'created');
    if (outcome.kind !== 'created') return;

    const created = h.nodes.requireNode(outcome.nodeId);
    assert.equal(created.display_name, 'Neovim');
    assert.equal(created.canonical_key, 'software:neovim');
    assert.deepEqual(
      h.nodes.listAliases(outcome.nodeId).map((alias) => alias.normalized_alias),
      ['neovim'],
    );
    // resolving again finds the node it just created
    const again = h.resolver.resolve({
      ownerId: context.ownerId, nodeType: 'software', displayName: 'neovim',
      canonicalKey: null, contextNodeIds: [], createIfMissing: false,
    });
    assert.equal(again.kind === 'resolved' && again.nodeId, outcome.nodeId);
  });
});

test('step 7: with creation disabled an unmatched name needs confirmation', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const outcome = h.resolver.resolve({
      ownerId: context.ownerId, nodeType: 'software', displayName: 'Unknown Editor',
      canonicalKey: null, contextNodeIds: [], createIfMissing: false,
    });
    assert.equal(outcome.kind, 'needs_confirmation');
    assert.deepEqual(outcome.kind === 'needs_confirmation' ? outcome.candidateNodeIds : ['x'], []);
  });
});

test('a name matching a node of a different type never resolves across types', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    h.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: 'person:mercury',
      displayName: 'Mercury', description: null, sensitivity: 'personal', properties: {},
    });
    const outcome = h.resolver.resolve({
      ownerId: context.ownerId, nodeType: 'place', displayName: 'Mercury',
      canonicalKey: null, contextNodeIds: [], createIfMissing: false,
    });
    assert.equal(outcome.kind, 'needs_confirmation');
  });
});

test('a merged node is followed to its target rather than returned', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const target = h.nodes.createNode({
      ownerId: context.ownerId, type: 'software', canonicalKey: 'software:vscode',
      displayName: 'Visual Studio Code', description: null, sensitivity: 'low', properties: {},
    });
    const source = h.nodes.createNode({
      ownerId: context.ownerId, type: 'software', canonicalKey: 'software:vscode-old',
      displayName: 'VSCode', description: null, sensitivity: 'low', properties: {},
    });
    h.nodes.addAlias({
      ownerId: context.ownerId, nodeId: source.id, alias: 'vscode',
      aliasType: 'name', sourceEvidenceId: null,
    });
    h.nodes.setNodeStatus(source.id, 'merged', target.id);

    const outcome = h.resolver.resolve({
      ownerId: context.ownerId, nodeType: 'software', displayName: 'vscode',
      canonicalKey: 'software:vscode-old', contextNodeIds: [], createIfMissing: false,
    });
    assert.equal(outcome.kind === 'resolved' && outcome.nodeId, target.id);
  });
});
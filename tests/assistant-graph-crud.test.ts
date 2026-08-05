import test from 'node:test';
import assert from 'node:assert/strict';

import { AuditStore } from '../src/assistant/storage/audit-store.js';
import { IdentityStore } from '../src/assistant/storage/identity-store.js';
import { LOCAL_OWNER_ID } from '../src/assistant/storage/schema.js';
import { NodeStore } from '../src/assistant/storage/node-store.js';
import { withAssistantContext, type AssistantTestContext } from './helpers/assistant-fixture.js';

function newNodeStore(context: AssistantTestContext): NodeStore {
  return new NodeStore(context.database, context.clock, context.ids);
}

test('identity store reads the seeded owner and local device', () => {
  withAssistantContext((context) => {
    const identity = new IdentityStore(context.database);
    const owner = identity.getOwner();
    assert.equal(owner.id, LOCAL_OWNER_ID);

    const deviceId = identity.getLocalDeviceId();
    const device = identity.getDevice(deviceId);
    assert.notEqual(device, null);
    assert.equal(device?.status, 'active');
    assert.equal(device?.owner_id, LOCAL_OWNER_ID);
    assert.equal(identity.listDevices(LOCAL_OWNER_ID).length, 1);
  });
});

test('audit store appends mutation log entries in order with before and after state', () => {
  withAssistantContext((context) => {
    const audit = new AuditStore(context.database, context.clock, context.ids);
    audit.recordMutation({
      ownerId: context.ownerId, actorType: 'system', actorRef: null,
      operation: 'create_node', targetType: 'graph_nodes', targetId: 'node_1',
      before: null, after: { displayName: 'VS Code' }, reason: 'seeded by test',
    });
    context.clock.advanceSeconds(60);
    audit.recordMutation({
      ownerId: context.ownerId, actorType: 'user', actorRef: 'own_local',
      operation: 'update_node', targetType: 'graph_nodes', targetId: 'node_1',
      before: { displayName: 'VS Code' }, after: { displayName: 'Visual Studio Code' },
      reason: 'renamed by test',
    });

    const entries = audit.listMutations(context.ownerId, 'graph_nodes', 'node_1');
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.operation, 'create_node');
    assert.equal(entries[0]?.before_json, null);
    assert.equal(entries[1]?.operation, 'update_node');
    assert.equal(entries[1]?.actor_type, 'user');
    assert.equal(
      entries[1]?.after_json,
      JSON.stringify({ displayName: 'Visual Studio Code' }),
    );
    assert.equal(entries[0]?.created_at_utc, '2026-08-05T09:00:00.000Z');
    assert.equal(entries[1]?.created_at_utc, '2026-08-05T09:01:00.000Z');
  });
});

test('audit store records non-content audit events newest first', () => {
  withAssistantContext((context) => {
    const audit = new AuditStore(context.database, context.clock, context.ids);
    audit.recordAuditEvent({
      ownerId: context.ownerId, eventType: 'secret_discarded',
      targetType: null, targetId: null,
      summary: 'Discarded secret_prohibited content during extraction',
      details: { detector: 'test' },
    });
    const events = audit.listAuditEvents(context.ownerId, 10);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event_type, 'secret_discarded');
    assert.equal(events[0]?.summary.includes('secret_prohibited'), true);
  });
});

test('graph version starts at zero and increments monotonically', () => {
  withAssistantContext((context) => {
    const audit = new AuditStore(context.database, context.clock, context.ids);
    assert.equal(audit.getGraphVersion(), 0);
    assert.equal(audit.incrementGraphVersion(), 1);
    assert.equal(audit.incrementGraphVersion(), 2);
    assert.equal(audit.getGraphVersion(), 2);
  });
});

// ── Task 9: Node store ─────────────────────────────────────────────────────

test('node store creates, reads, and lists nodes', () => {
  withAssistantContext((context) => {
    const nodes = newNodeStore(context);
    const created = nodes.createNode({
      ownerId: context.ownerId, type: 'software', canonicalKey: 'software:visual-studio-code',
      displayName: 'Visual Studio Code', description: 'Code editor',
      sensitivity: 'low', properties: { vendor: 'Microsoft' },
    });
    assert.equal(created.id, 'node_0001');
    assert.equal(created.status, 'active');
    assert.equal(created.created_at_utc, '2026-08-05T09:00:00.000Z');

    const fetched = nodes.getNode(created.id);
    assert.equal(fetched?.display_name, 'Visual Studio Code');
    assert.equal(JSON.parse(fetched?.properties_json ?? '{}').vendor, 'Microsoft');

    const listed = nodes.listNodesByType(context.ownerId, 'software');
    assert.deepEqual(listed.map((row) => row.id), [created.id]);
  });
});

test('canonical keys are unique per owner and type among non-deleted nodes', () => {
  withAssistantContext((context) => {
    const nodes = newNodeStore(context);
    nodes.createNode({
      ownerId: context.ownerId, type: 'device', canonicalKey: 'device:main',
      displayName: 'Workstation', description: null, sensitivity: 'personal', properties: {},
    });
    assert.throws(
      () => nodes.createNode({
        ownerId: context.ownerId, type: 'device', canonicalKey: 'device:main',
        displayName: 'Duplicate workstation', description: null,
        sensitivity: 'personal', properties: {},
      }),
      /UNIQUE constraint failed/,
    );
  });
});

test('findByCanonicalKey ignores deleted nodes', () => {
  withAssistantContext((context) => {
    const nodes = newNodeStore(context);
    const node = nodes.createNode({
      ownerId: context.ownerId, type: 'project', canonicalKey: 'project:siftkit',
      displayName: 'SiftKit', description: null, sensitivity: 'low', properties: {},
    });
    assert.equal(nodes.findByCanonicalKey(context.ownerId, 'project', 'project:siftkit')?.id, node.id);
    nodes.setNodeStatus(node.id, 'deleted');
    assert.equal(nodes.findByCanonicalKey(context.ownerId, 'project', 'project:siftkit'), null);
  });
});

test('aliases resolve case- and whitespace-insensitively and are type-filtered', () => {
  withAssistantContext((context) => {
    const nodes = newNodeStore(context);
    const editor = nodes.createNode({
      ownerId: context.ownerId, type: 'software', canonicalKey: 'software:visual-studio-code',
      displayName: 'Visual Studio Code', description: null, sensitivity: 'low', properties: {},
    });
    const person = nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: 'person:self',
      displayName: 'Code', description: null, sensitivity: 'personal', properties: {},
    });
    nodes.addAlias({
      ownerId: context.ownerId, nodeId: editor.id, alias: 'VS  Code',
      aliasType: 'name', sourceEvidenceId: null,
    });
    nodes.addAlias({
      ownerId: context.ownerId, nodeId: person.id, alias: 'vs code',
      aliasType: 'user_supplied', sourceEvidenceId: null,
    });

    const all = nodes.findByAlias(context.ownerId, '  vs   code ');
    assert.equal(all.length, 2);

    const softwareOnly = nodes.findByAlias(context.ownerId, 'VS Code', 'software');
    assert.deepEqual(softwareOnly.map((row) => row.id), [editor.id]);
  });
});

test('adding the same alias to the same node twice is idempotent', () => {
  withAssistantContext((context) => {
    const nodes = newNodeStore(context);
    const node = nodes.createNode({
      ownerId: context.ownerId, type: 'model', canonicalKey: 'model:qwen3.5-27b',
      displayName: 'Qwen3.5 27B', description: null, sensitivity: 'low', properties: {},
    });
    nodes.addAlias({
      ownerId: context.ownerId, nodeId: node.id, alias: 'qwen', aliasType: 'model',
      sourceEvidenceId: null,
    });
    nodes.addAlias({
      ownerId: context.ownerId, nodeId: node.id, alias: 'Qwen', aliasType: 'model',
      sourceEvidenceId: null,
    });
    assert.equal(nodes.listAliases(node.id).length, 1);
  });
});

test('full-text search matches display name, alias, and description', () => {
  withAssistantContext((context) => {
    const nodes = newNodeStore(context);
    const node = nodes.createNode({
      ownerId: context.ownerId, type: 'software', canonicalKey: 'software:powershell',
      displayName: 'PowerShell', description: 'Windows automation shell',
      sensitivity: 'low', properties: {},
    });
    nodes.addAlias({
      ownerId: context.ownerId, nodeId: node.id, alias: 'pwsh',
      aliasType: 'name', sourceEvidenceId: null,
    });

    assert.deepEqual(nodes.searchNodes(context.ownerId, 'powershell', 10), [node.id]);
    assert.deepEqual(nodes.searchNodes(context.ownerId, 'pwsh', 10), [node.id]);
    assert.deepEqual(nodes.searchNodes(context.ownerId, 'automation', 10), [node.id]);
    assert.deepEqual(nodes.searchNodes(context.ownerId, 'nothingmatches', 10), []);
  });
});

test('sensitive and highly sensitive nodes are excluded from the FTS index', () => {
  withAssistantContext((context) => {
    const nodes = newNodeStore(context);
    nodes.createNode({
      ownerId: context.ownerId, type: 'financial_account', canonicalKey: null,
      displayName: 'Brokerage account', description: null,
      sensitivity: 'highly_sensitive', properties: {},
    });
    assert.deepEqual(nodes.searchNodes(context.ownerId, 'brokerage', 10), []);
  });
});

test('renaming a node refreshes its FTS row rather than duplicating it', () => {
  withAssistantContext((context) => {
    const nodes = newNodeStore(context);
    const node = nodes.createNode({
      ownerId: context.ownerId, type: 'project', canonicalKey: 'project:siftkit',
      displayName: 'Siftkit', description: null, sensitivity: 'low', properties: {},
    });
    nodes.updateNode(node.id, { displayName: 'SiftKit Toolkit', description: 'CLI toolkit' });
    assert.deepEqual(nodes.searchNodes(context.ownerId, 'toolkit', 10), [node.id]);
    assert.deepEqual(nodes.searchNodes(context.ownerId, 'siftkit', 10), [node.id]);
    assert.equal(nodes.getNode(node.id)?.display_name, 'SiftKit Toolkit');
  });
});

test('deleting a node drops it from the FTS index', () => {
  withAssistantContext((context) => {
    const nodes = newNodeStore(context);
    const node = nodes.createNode({
      ownerId: context.ownerId, type: 'topic', canonicalKey: null,
      displayName: 'Transient topic', description: null, sensitivity: 'low', properties: {},
    });
    assert.deepEqual(nodes.searchNodes(context.ownerId, 'transient', 10), [node.id]);
    nodes.setNodeStatus(node.id, 'deleted');
    assert.deepEqual(nodes.searchNodes(context.ownerId, 'transient', 10), []);
  });
});
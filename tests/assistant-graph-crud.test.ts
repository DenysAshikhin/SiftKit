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

// ── Task 10: Assertion store ────────────────────────────────────────────────

import { AssertionStore } from '../src/assistant/storage/assertion-store.js';
import { buildAssertionKey } from '../src/assistant/domain/keys.js';

interface SeededAssertion {
  readonly assertions: AssertionStore;
  readonly assertionId: string;
  readonly evidenceIds: readonly string[];
}

function seedAssertionWithEvidence(
  context: Parameters<Parameters<typeof withAssistantContext>[0]>[0],
): SeededAssertion {
  const nodes = newNodeStore(context);
  const assertions = new AssertionStore(context.database, context.clock, context.ids);
  const person = nodes.createNode({
    ownerId: context.ownerId, type: 'person', canonicalKey: 'person:self',
    displayName: 'Denys', description: null, sensitivity: 'personal', properties: {},
  });
  const created = assertions.createAssertion({
    ownerId: context.ownerId, subjectNodeId: person.id, predicate: 'HAS_CONSTRAINT',
    object: { kind: 'literal', valueType: 'string', value: 'Short answers' },
    scopeNodeId: null, status: 'active', basis: 'passive_observation', confidence: 0.5,
    sensitivity: 'personal', validFromUtc: null, validToUtc: null,
    observedAtUtc: '2026-08-05T09:00:00.000Z', supersedesAssertionId: null,
    pinned: false, attributes: {},
    searchText: {
      subject: 'Denys', predicate: 'has constraint', object: 'Short answers', scope: '',
    },
  });

  const evidenceIds: string[] = [];
  const insert = context.database.prepare(`
    INSERT INTO evidence_records (
      id, owner_id, device_id, source_event_id, parent_evidence_id, blob_id, source_type,
      source_ref, captured_at_utc, source_timezone, ingested_at_utc, content_hash, mime_type,
      sensitivity, retention_until_utc, status, metadata_json, created_at_utc, updated_at_utc
    ) VALUES (?, ?, NULL, ?, NULL, NULL, 'conversation_message', NULL, ?, NULL, ?, ?, 'text/plain',
              'personal', NULL, 'active', '{}', ?, ?)
  `);
  for (let index = 0; index < 3; index += 1) {
    const id = `ev_seed_${index}`;
    insert.run(
      id, context.ownerId, `evt_${index}`, '2026-08-05T09:00:00.000Z',
      '2026-08-05T09:00:00.000Z', `hash_${index}`,
      '2026-08-05T09:00:00.000Z', '2026-08-05T09:00:00.000Z',
    );
    evidenceIds.push(id);
  }
  return { assertions, assertionId: created.id, evidenceIds };
}

test('assertion store writes a node-object assertion and reads it back by subject', () => {
  withAssistantContext((context) => {
    const nodes = newNodeStore(context);
    const assertions = new AssertionStore(context.database, context.clock, context.ids);
    const person = nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: 'person:self',
      displayName: 'Denys', description: null, sensitivity: 'personal', properties: {},
    });
    const shell = nodes.createNode({
      ownerId: context.ownerId, type: 'software', canonicalKey: 'software:powershell',
      displayName: 'PowerShell', description: null, sensitivity: 'low', properties: {},
    });

    const created = assertions.createAssertion({
      ownerId: context.ownerId,
      subjectNodeId: person.id,
      predicate: 'PREFERS',
      object: { kind: 'node', nodeId: shell.id },
      scopeNodeId: null,
      status: 'active',
      basis: 'explicit_user_statement',
      confidence: 0.99,
      sensitivity: 'personal',
      validFromUtc: null,
      validToUtc: null,
      observedAtUtc: '2026-08-05T09:00:00.000Z',
      supersedesAssertionId: null,
      pinned: false,
      attributes: {},
      searchText: {
        subject: 'Denys', predicate: 'prefers', object: 'PowerShell', scope: '',
      },
    });

    assert.equal(created.object_kind, 'node');
    assert.equal(created.object_node_id, shell.id);
    assert.equal(created.object_value_json, null);
    assert.equal(created.pinned, false);
    assert.equal(created.assertion_key, buildAssertionKey({
      ownerId: context.ownerId, subjectNodeId: person.id, predicate: 'PREFERS',
      object: { kind: 'node', nodeId: shell.id }, scopeNodeId: null,
    }));

    const bySubject = assertions.listBySubject(context.ownerId, person.id, ['active']);
    assert.deepEqual(bySubject.map((row) => row.id), [created.id]);
    assert.deepEqual(
      assertions.listByObjectNode(context.ownerId, shell.id, ['active']).map((row) => row.id),
      [created.id],
    );
  });
});

test('assertion store writes a literal-object assertion with a normalized object text', () => {
  withAssistantContext((context) => {
    const nodes = newNodeStore(context);
    const assertions = new AssertionStore(context.database, context.clock, context.ids);
    const device = nodes.createNode({
      ownerId: context.ownerId, type: 'device', canonicalKey: 'device:main',
      displayName: 'Workstation', description: null, sensitivity: 'personal', properties: {},
    });

    const created = assertions.createAssertion({
      ownerId: context.ownerId, subjectNodeId: device.id, predicate: 'HAS_SETTING',
      object: { kind: 'literal', valueType: 'quantity', value: { amount: 24, unit: 'GB' } },
      scopeNodeId: null, status: 'active', basis: 'manual_import', confidence: 0.95,
      sensitivity: 'low', validFromUtc: null, validToUtc: null,
      observedAtUtc: '2026-08-05T09:00:00.000Z', supersedesAssertionId: null,
      pinned: false, attributes: {},
      searchText: { subject: 'Workstation', predicate: 'has setting', object: '24 GB', scope: '' },
    });

    assert.equal(created.object_kind, 'literal');
    assert.equal(created.object_node_id, null);
    assert.equal(created.object_value_type, 'quantity');
    assert.equal(created.object_normalized_text, '24 gb');
    assert.equal(JSON.parse(created.object_value_json ?? 'null').amount, 24);
  });
});

test('two live assertions cannot share an assertion key', () => {
  withAssistantContext((context) => {
    const nodes = newNodeStore(context);
    const assertions = new AssertionStore(context.database, context.clock, context.ids);
    const person = nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: 'person:self',
      displayName: 'Denys', description: null, sensitivity: 'personal', properties: {},
    });
    const editor = nodes.createNode({
      ownerId: context.ownerId, type: 'software', canonicalKey: 'software:vscode',
      displayName: 'VS Code', description: null, sensitivity: 'low', properties: {},
    });
    const write = () => assertions.createAssertion({
      ownerId: context.ownerId, subjectNodeId: person.id, predicate: 'USES',
      object: { kind: 'node', nodeId: editor.id }, scopeNodeId: null,
      status: 'active', basis: 'passive_observation', confidence: 0.5, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, observedAtUtc: '2026-08-05T09:00:00.000Z',
      supersedesAssertionId: null, pinned: false, attributes: {},
      searchText: { subject: 'Denys', predicate: 'uses', object: 'VS Code', scope: '' },
    });
    const first = write();
    assert.throws(write, /UNIQUE constraint failed/);

    // retiring the first frees the key
    assertions.retireAssertion(first.id, 'superseded');
    const second = write();
    assert.notEqual(second.id, first.id);
  });
});

test('evidence links carry stance and weight and drive the support and contradiction split', () => {
  withAssistantContext((context) => {
    const { assertions, assertionId, evidenceIds } = seedAssertionWithEvidence(context);
    assertions.linkEvidence(assertionId, evidenceIds[0], 'supports', 0.9);
    assertions.linkEvidence(assertionId, evidenceIds[1], 'supports', 0.6);
    assertions.linkEvidence(assertionId, evidenceIds[2], 'contradicts', 0.4);

    const links = assertions.listEvidence(assertionId);
    assert.equal(links.length, 3);
    assert.deepEqual(assertions.supportWeights(assertionId), [0.9, 0.6]);
    assert.equal(assertions.contradictionCount(assertionId), 1);
  });
});

test('the same evidence may support and contextualize one assertion but not duplicate a stance', () => {
  withAssistantContext((context) => {
    const { assertions, assertionId, evidenceIds } = seedAssertionWithEvidence(context);
    assertions.linkEvidence(assertionId, evidenceIds[0], 'supports', 0.9);
    assertions.linkEvidence(assertionId, evidenceIds[0], 'context', 0.1);
    assertions.linkEvidence(assertionId, evidenceIds[0], 'supports', 0.7);
    const links = assertions.listEvidence(assertionId);
    assert.equal(links.length, 2);
    assert.deepEqual(assertions.supportWeights(assertionId), [0.7]);
  });
});

test('current-state queries exclude superseded, expired, and future-dated assertions', () => {
  withAssistantContext((context) => {
    const nodes = newNodeStore(context);
    const assertions = new AssertionStore(context.database, context.clock, context.ids);
    const person = nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: 'person:self',
      displayName: 'Denys', description: null, sensitivity: 'personal', properties: {},
    });
    const makeRole = (role: string, validFrom: string | null, validTo: string | null) =>
      assertions.createAssertion({
        ownerId: context.ownerId, subjectNodeId: person.id, predicate: 'HAS_ROLE',
        object: { kind: 'literal', valueType: 'string', value: role },
        scopeNodeId: null, status: 'active', basis: 'explicit_user_statement',
        confidence: 0.99, sensitivity: 'personal',
        validFromUtc: validFrom, validToUtc: validTo,
        observedAtUtc: '2026-08-05T09:00:00.000Z', supersedesAssertionId: null,
        pinned: false, attributes: {},
        searchText: { subject: 'Denys', predicate: 'has role', object: role, scope: '' },
      });

    const past = makeRole('Junior engineer', '2020-01-01T00:00:00.000Z', '2023-01-01T00:00:00.000Z');
    const current = makeRole('Staff engineer', '2023-01-01T00:00:00.000Z', null);
    const future = makeRole('Principal engineer', '2030-01-01T00:00:00.000Z', null);

    const currentIds = assertions
      .listCurrent(context.ownerId, person.id, '2026-08-05T09:00:00.000Z')
      .map((row) => row.id);
    assert.deepEqual(currentIds, [current.id]);

    assertions.retireAssertion(current.id, 'superseded');
    assert.deepEqual(
      assertions.listCurrent(context.ownerId, person.id, '2026-08-05T09:00:00.000Z'),
      [],
    );

    // history stays queryable
    const all = assertions.listBySubject(
      context.ownerId, person.id, ['active', 'superseded', 'expired'],
    );
    assert.equal(all.length, 3);
    assert.ok(all.some((row) => row.id === past.id));
    assert.ok(all.some((row) => row.id === future.id));
  });
});

test('assertion full-text search excludes sensitive assertions', () => {
  withAssistantContext((context) => {
    const nodes = newNodeStore(context);
    const assertions = new AssertionStore(context.database, context.clock, context.ids);
    const person = nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: 'person:self',
      displayName: 'Denys', description: null, sensitivity: 'personal', properties: {},
    });
    const visible = assertions.createAssertion({
      ownerId: context.ownerId, subjectNodeId: person.id, predicate: 'HAS_CONSTRAINT',
      object: { kind: 'literal', valueType: 'string', value: 'Prefers concise answers' },
      scopeNodeId: null, status: 'active', basis: 'explicit_user_statement', confidence: 0.99,
      sensitivity: 'personal', validFromUtc: null, validToUtc: null,
      observedAtUtc: '2026-08-05T09:00:00.000Z', supersedesAssertionId: null,
      pinned: false, attributes: {},
      searchText: {
        subject: 'Denys', predicate: 'has constraint',
        object: 'Prefers concise answers', scope: '',
      },
    });
    assertions.createAssertion({
      ownerId: context.ownerId, subjectNodeId: person.id, predicate: 'LIVES_IN',
      object: { kind: 'literal', valueType: 'string', value: 'Redacted address' },
      scopeNodeId: null, status: 'active', basis: 'explicit_user_statement', confidence: 0.99,
      sensitivity: 'highly_sensitive', validFromUtc: null, validToUtc: null,
      observedAtUtc: '2026-08-05T09:00:00.000Z', supersedesAssertionId: null,
      pinned: false, attributes: {},
      searchText: {
        subject: 'Denys', predicate: 'lives in', object: 'Redacted address', scope: '',
      },
    });

    assert.deepEqual(assertions.searchAssertions(context.ownerId, 'concise', 10), [visible.id]);
    assert.deepEqual(assertions.searchAssertions(context.ownerId, 'redacted', 10), []);
  });
});
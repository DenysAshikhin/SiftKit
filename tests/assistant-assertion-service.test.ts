import test from 'node:test';
import assert from 'node:assert/strict';

import { AssertionService } from '../src/assistant/graph/assertion-service.js';
import { AssertionValidator } from '../src/assistant/graph/validation.js';
import { AssertionStore } from '../src/assistant/storage/assertion-store.js';
import { AuditStore } from '../src/assistant/storage/audit-store.js';
import { NodeStore } from '../src/assistant/storage/node-store.js';
import { PolicyStore } from '../src/assistant/storage/policy-store.js';
import { AssistantTransactionManager } from '../src/assistant/transactions/assistant-transaction-manager.js';
import { withAssistantContext, type AssistantTestContext } from './helpers/assistant-fixture.js';

interface ServiceHarness {
  readonly service: AssertionService;
  readonly assertions: AssertionStore;
  readonly audit: AuditStore;
  readonly nodes: NodeStore;
  readonly policies: PolicyStore;
  readonly personId: string;
  readonly powershellId: string;
  readonly bashId: string;
  readonly windowsScopeId: string;
  readonly linuxScopeId: string;
  readonly evidenceIds: readonly string[];
}

function harness(context: AssistantTestContext): ServiceHarness {
  const nodes = new NodeStore(context.database, context.clock, context.ids);
  const assertions = new AssertionStore(context.database, context.clock, context.ids);
  const audit = new AuditStore(context.database, context.clock, context.ids);
  const policies = new PolicyStore(context.database, context.clock, context.ids);
  const validator = new AssertionValidator(nodes, policies);
  const transactions = new AssistantTransactionManager(context.database);
  const service = new AssertionService(
    transactions, context.database, context.clock, nodes, assertions, audit, policies, validator,
  );

  const make = (type: Parameters<NodeStore['createNode']>[0]['type'], key: string, name: string) =>
    nodes.createNode({
      ownerId: context.ownerId, type, canonicalKey: key, displayName: name,
      description: null, sensitivity: 'personal', properties: {},
    }).id;

  const personId = make('person', 'person:self', 'Denys');
  const powershellId = make('software', 'software:powershell', 'PowerShell');
  const bashId = make('software', 'software:bash', 'Bash');
  const windowsScopeId = make('preference_context', 'context:windows', 'Windows command examples');
  const linuxScopeId = make('preference_context', 'context:linux', 'Linux server work');

  const evidenceIds: string[] = [];
  const insert = context.database.prepare(`
    INSERT INTO evidence_records (
      id, owner_id, device_id, source_event_id, parent_evidence_id, blob_id, source_type,
      source_ref, captured_at_utc, source_timezone, ingested_at_utc, content_hash, mime_type,
      sensitivity, retention_until_utc, status, metadata_json, created_at_utc, updated_at_utc
    ) VALUES (?, ?, NULL, ?, NULL, NULL, 'conversation_message', NULL, ?, NULL, ?, ?, 'text/plain',
              'personal', NULL, 'active', '{}', ?, ?)
  `);
  for (let index = 0; index < 5; index += 1) {
    const id = `ev_${index}`;
    insert.run(
      id, context.ownerId, `evt_${index}`, '2026-08-05T09:00:00.000Z',
      '2026-08-05T09:00:00.000Z', `hash_${index}`,
      '2026-08-05T09:00:00.000Z', '2026-08-05T09:00:00.000Z',
    );
    evidenceIds.push(id);
  }

  return {
    service, assertions, audit, nodes, policies,
    personId, powershellId, bashId, windowsScopeId, linuxScopeId, evidenceIds,
  };
}

function preferenceRequest(
  context: AssistantTestContext,
  h: ServiceHarness,
  overrides: Partial<Parameters<AssertionService['assert']>[0]> = {},
): Parameters<AssertionService['assert']>[0] {
  return {
    ownerId: context.ownerId,
    actorType: 'system',
    actorRef: null,
    subjectNodeId: h.personId,
    predicate: 'PREFERS',
    object: { kind: 'node', nodeId: h.powershellId },
    scopeNodeId: h.windowsScopeId,
    basis: 'explicit_user_statement',
    sensitivity: 'personal',
    validFromUtc: null,
    validToUtc: null,
    observedAtUtc: '2026-08-05T09:00:00.000Z',
    topics: [],
    attributes: {},
    searchText: {
      subject: 'Denys', predicate: 'prefers', object: 'PowerShell',
      scope: 'Windows command examples',
    },
    evidence: [{ evidenceId: h.evidenceIds[0], stance: 'supports', weight: 0.9 }],
    ...overrides,
  };
}

test('asserting a new fact creates it, links evidence, logs, and bumps the graph version', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    assert.equal(h.audit.getGraphVersion(), 0);

    const outcome = h.service.assert(preferenceRequest(context, h));
    assert.equal(outcome.kind, 'created');
    if (outcome.kind !== 'created') return;

    const stored = h.assertions.requireAssertion(outcome.assertionId);
    assert.equal(stored.status, 'active');
    assert.equal(stored.basis, 'explicit_user_statement');
    assert.equal(stored.confidence, 0.9);
    assert.deepEqual(h.assertions.supportWeights(outcome.assertionId), [0.9]);

    assert.equal(h.audit.getGraphVersion(), 1);
    const log = h.audit.listMutations(context.ownerId, 'graph_assertions', outcome.assertionId);
    assert.equal(log.length, 1);
    assert.equal(log[0]?.operation, 'create_assertion');
    assert.equal(log[0]?.before_json, null);
  });
});

test('a rejected assertion writes nothing and does not bump the graph version', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const outcome = h.service.assert(preferenceRequest(context, h, {
      predicate: 'NOT_A_PREDICATE',
    }));
    assert.equal(outcome.kind, 'rejected');
    assert.equal(outcome.kind === 'rejected' && outcome.code, 'unknown_predicate');
    assert.equal(h.audit.getGraphVersion(), 0);
    assert.equal(h.assertions.listBySubject(context.ownerId, h.personId, ['active']).length, 0);
  });
});

test('re-asserting the same fact reinforces it instead of creating a duplicate', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const first = h.service.assert(preferenceRequest(context, h));
    context.clock.advanceDays(3);
    const second = h.service.assert(preferenceRequest(context, h, {
      observedAtUtc: '2026-08-08T09:00:00.000Z',
      evidence: [{ evidenceId: h.evidenceIds[1], stance: 'supports', weight: 0.8 }],
    }));

    assert.equal(second.kind, 'reinforced');
    assert.equal(first.kind === 'created' && second.kind === 'reinforced'
      && first.assertionId === second.assertionId, true);
    if (second.kind !== 'reinforced') return;

    const stored = h.assertions.requireAssertion(second.assertionId);
    assert.equal(stored.first_observed_at_utc, '2026-08-05T09:00:00.000Z');
    assert.equal(stored.last_observed_at_utc, '2026-08-08T09:00:00.000Z');
    assert.deepEqual(h.assertions.supportWeights(second.assertionId).sort(), [0.8, 0.9]);
    // 1 - (1-0.9)(1-0.8) = 0.98, clamped to the explicit_user_statement ceiling 0.99
    assert.ok(Math.abs(stored.confidence - 0.98) < 1e-9);
    assert.equal(h.assertions.listBySubject(context.ownerId, h.personId, ['active']).length, 1);
  });
});

test('a scoped preference coexists with a differently scoped one', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    h.service.assert(preferenceRequest(context, h));
    const linux = h.service.assert(preferenceRequest(context, h, {
      object: { kind: 'node', nodeId: h.bashId },
      scopeNodeId: h.linuxScopeId,
      evidence: [{ evidenceId: h.evidenceIds[1], stance: 'supports', weight: 0.9 }],
      searchText: {
        subject: 'Denys', predicate: 'prefers', object: 'Bash', scope: 'Linux server work',
      },
    }));
    assert.equal(linux.kind, 'created');
    assert.equal(h.assertions.listBySubject(context.ownerId, h.personId, ['active']).length, 2);
  });
});

test('an explicit correction supersedes the previous value within the same scope', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const original = h.service.assert(preferenceRequest(context, h));
    context.clock.advanceDays(1);
    const corrected = h.service.assert(preferenceRequest(context, h, {
      object: { kind: 'node', nodeId: h.bashId },
      evidence: [{ evidenceId: h.evidenceIds[1], stance: 'supports', weight: 0.95 }],
      searchText: {
        subject: 'Denys', predicate: 'prefers', object: 'Bash',
        scope: 'Windows command examples',
      },
    }));

    assert.equal(corrected.kind, 'superseded');
    if (corrected.kind !== 'superseded' || original.kind !== 'created') return;
    assert.equal(corrected.supersededAssertionId, original.assertionId);

    const old = h.assertions.requireAssertion(original.assertionId);
    assert.equal(old.status, 'superseded');
    assert.notEqual(old.retired_at_utc, null);

    const current = h.assertions.requireAssertion(corrected.assertionId);
    assert.equal(current.status, 'active');
    assert.equal(current.supersedes_assertion_id, original.assertionId);

    // history is preserved and still queryable
    assert.equal(
      h.assertions.listBySubject(context.ownerId, h.personId, ['active', 'superseded']).length, 2,
    );
    const log = h.audit.listMutations(context.ownerId, 'graph_assertions', original.assertionId);
    assert.ok(log.some((entry) => entry.operation === 'supersede_assertion'));
  });
});

test('passive evidence never overrides an explicit statement; it records a contradiction', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const explicit = h.service.assert(preferenceRequest(context, h));
    context.clock.advanceDays(1);
    const passive = h.service.assert(preferenceRequest(context, h, {
      object: { kind: 'node', nodeId: h.bashId },
      basis: 'passive_observation',
      evidence: [{ evidenceId: h.evidenceIds[2], stance: 'supports', weight: 0.8 }],
      searchText: {
        subject: 'Denys', predicate: 'prefers', object: 'Bash',
        scope: 'Windows command examples',
      },
    }));

    assert.equal(passive.kind, 'contradiction_recorded');
    if (passive.kind !== 'contradiction_recorded' || explicit.kind !== 'created') return;
    assert.equal(passive.assertionId, explicit.assertionId);

    const survivor = h.assertions.requireAssertion(explicit.assertionId);
    assert.equal(survivor.status, 'active');
    assert.equal(survivor.object_node_id, h.powershellId);

    // the contradicting evidence is attached to the surviving assertion, not to a new one
    assert.equal(h.assertions.contradictionCount(explicit.assertionId), 1);
    assert.equal(h.assertions.listBySubject(context.ownerId, h.personId, ['active']).length, 1);
    // and confidence falls because of it
    assert.ok(survivor.confidence < 0.9);
  });
});

test('a temporal change closes the old window rather than deleting it', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const acme = h.nodes.createNode({
      ownerId: context.ownerId, type: 'organization', canonicalKey: 'org:acme',
      displayName: 'Acme', description: null, sensitivity: 'personal', properties: {},
    });
    const globex = h.nodes.createNode({
      ownerId: context.ownerId, type: 'organization', canonicalKey: 'org:globex',
      displayName: 'Globex', description: null, sensitivity: 'personal', properties: {},
    });
    const employment = (organizationId: string, from: string, evidenceId: string) =>
      h.service.assert(preferenceRequest(context, h, {
        predicate: 'EMPLOYED_BY',
        object: { kind: 'node', nodeId: organizationId },
        scopeNodeId: null,
        validFromUtc: from,
        evidence: [{ evidenceId, stance: 'supports', weight: 0.95 }],
        searchText: {
          subject: 'Denys', predicate: 'employed by', object: organizationId, scope: '',
        },
      }));

    const first = employment(acme.id, '2020-01-01T00:00:00.000Z', h.evidenceIds[0]);
    context.clock.advanceDays(30);
    const second = employment(globex.id, '2026-01-01T00:00:00.000Z', h.evidenceIds[1]);

    assert.equal(second.kind, 'temporally_closed');
    if (second.kind !== 'temporally_closed' || first.kind !== 'created') return;
    assert.equal(second.closedAssertionId, first.assertionId);

    const closed = h.assertions.requireAssertion(first.assertionId);
    assert.equal(closed.valid_to_utc, '2026-01-01T00:00:00.000Z');
    assert.equal(closed.status, 'active', 'history stays active but out of the current window');

    const current = h.assertions
      .listCurrent(context.ownerId, h.personId, '2026-08-05T09:00:00.000Z')
      .map((row) => row.object_node_id);
    assert.deepEqual(current, [globex.id]);
  });
});

test('a locked assertion refuses automatic supersession but allows a user correction', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const original = h.service.assert(preferenceRequest(context, h));
    if (original.kind !== 'created') return;
    h.policies.lockAssertion(context.ownerId, original.assertionId, 'user pinned this');

    const automatic = h.service.assert(preferenceRequest(context, h, {
      object: { kind: 'node', nodeId: h.bashId },
      basis: 'manual_import',
      evidence: [{ evidenceId: h.evidenceIds[1], stance: 'supports', weight: 0.9 }],
      searchText: {
        subject: 'Denys', predicate: 'prefers', object: 'Bash',
        scope: 'Windows command examples',
      },
    }));
    assert.equal(automatic.kind, 'rejected');
    assert.equal(automatic.kind === 'rejected' && automatic.code, 'assertion_locked');

    const userCorrection = h.service.correct({
      ownerId: context.ownerId,
      assertionId: original.assertionId,
      object: { kind: 'node', nodeId: h.bashId },
      reason: 'user corrected the value',
      observedAtUtc: '2026-08-06T09:00:00.000Z',
      evidenceId: h.evidenceIds[2],
      searchText: {
        subject: 'Denys', predicate: 'prefers', object: 'Bash',
        scope: 'Windows command examples',
      },
    });
    assert.equal(userCorrection.kind, 'superseded');
  });
});

test('a user correction pins confidence at 1.00 and supersedes the prior value', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const original = h.service.assert(preferenceRequest(context, h, {
      basis: 'passive_observation',
      evidence: [{ evidenceId: h.evidenceIds[0], stance: 'supports', weight: 0.5 }],
    }));
    if (original.kind !== 'created') return;

    const corrected = h.service.correct({
      ownerId: context.ownerId,
      assertionId: original.assertionId,
      object: { kind: 'node', nodeId: h.bashId },
      reason: 'no, I meant Bash',
      observedAtUtc: '2026-08-06T09:00:00.000Z',
      evidenceId: h.evidenceIds[1],
      searchText: {
        subject: 'Denys', predicate: 'prefers', object: 'Bash',
        scope: 'Windows command examples',
      },
    });
    assert.equal(corrected.kind, 'superseded');
    if (corrected.kind !== 'superseded') return;
    const current = h.assertions.requireAssertion(corrected.assertionId);
    assert.equal(current.confidence, 1);
    assert.equal(current.basis, 'explicit_user_statement');
    assert.equal(h.assertions.requireAssertion(original.assertionId).status, 'superseded');
  });
});

test('confirm, pin, expire, and delete each log and bump the graph version', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const created = h.service.assert(preferenceRequest(context, h, {
      basis: 'assistant_inference',
      evidence: [{ evidenceId: h.evidenceIds[0], stance: 'supports', weight: 0.5 }],
    }));
    if (created.kind !== 'created') return;
    const id = created.assertionId;

    let version = h.audit.getGraphVersion();

    h.service.confirm({
      ownerId: context.ownerId, assertionId: id, reason: 'user confirmed',
      evidenceId: h.evidenceIds[1],
    });
    assert.equal(h.assertions.requireAssertion(id).basis, 'explicit_question_answer');
    assert.equal(h.audit.getGraphVersion(), version + 1);
    version += 1;

    h.service.setPinned({ ownerId: context.ownerId, assertionId: id, pinned: true, reason: 'pin' });
    assert.equal(h.assertions.requireAssertion(id).pinned, true);
    assert.equal(h.audit.getGraphVersion(), version + 1);
    version += 1;

    h.service.expire({ ownerId: context.ownerId, assertionId: id, reason: 'no longer true' });
    assert.equal(h.assertions.requireAssertion(id).status, 'expired');
    assert.equal(h.audit.getGraphVersion(), version + 1);
    version += 1;

    h.service.forget({ ownerId: context.ownerId, assertionId: id, reason: 'user deleted' });
    assert.equal(h.assertions.requireAssertion(id).status, 'deleted');
    assert.equal(h.audit.getGraphVersion(), version + 1);

    const log = h.audit.listMutations(context.ownerId, 'graph_assertions', id);
    const operations = log.map((entry) => entry.operation);
    assert.deepEqual(operations, [
      'create_assertion', 'confirm_assertion', 'update_assertion',
      'expire_assertion', 'delete_assertion',
    ]);
  });
});

test('recalculating confidence after evidence deletion drops the deleted support', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const created = h.service.assert(preferenceRequest(context, h, {
      basis: 'passive_observation',
      evidence: [
        { evidenceId: h.evidenceIds[0], stance: 'supports', weight: 0.8 },
        { evidenceId: h.evidenceIds[1], stance: 'supports', weight: 0.8 },
      ],
    }));
    if (created.kind !== 'created') return;
    // 1 - 0.2*0.2 = 0.96, clamped to the passive ceiling 0.85
    assert.equal(h.assertions.requireAssertion(created.assertionId).confidence, 0.85);

    context.database
      .prepare("UPDATE evidence_records SET status = 'deleted' WHERE id = ?")
      .run(h.evidenceIds[0]);
    const recalculated = h.service.recalculateConfidence({
      ownerId: context.ownerId, assertionId: created.assertionId,
      reason: 'evidence deleted',
    });
    assert.ok(Math.abs(recalculated - 0.8) < 1e-9);
  });
});

test('two incompatible explicit statements both become disputed', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const constraint = (value: string, evidenceId: string) =>
      h.service.assert(preferenceRequest(context, h, {
        predicate: 'HAS_CONSTRAINT',
        object: { kind: 'literal', valueType: 'string', value },
        scopeNodeId: null,
        evidence: [{ evidenceId, stance: 'supports', weight: 0.9 }],
        searchText: { subject: 'Denys', predicate: 'has constraint', object: value, scope: '' },
      }));

    const first = constraint('Always answer in under 50 words', h.evidenceIds[0]);
    context.clock.advanceDays(1);
    const second = constraint('Always answer in over 500 words', h.evidenceIds[1]);

    assert.equal(second.kind, 'disputed');
    if (second.kind !== 'disputed' || first.kind !== 'created') return;
    assert.equal(second.disputedWithAssertionId, first.assertionId);
    assert.equal(h.assertions.requireAssertion(first.assertionId).status, 'disputed');
    assert.equal(h.assertions.requireAssertion(second.assertionId).status, 'disputed');
    assert.equal(
      h.assertions.listBySubject(context.ownerId, h.personId, ['disputed']).length, 2,
    );
  });
});
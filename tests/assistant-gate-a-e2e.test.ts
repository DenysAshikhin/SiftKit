import test from 'node:test';
import assert from 'node:assert/strict';

import { withAssistantContext, type AssistantTestContext } from './helpers/assistant-fixture.js';

function recordStatement(context: AssistantTestContext, sourceEventId: string, text: string): string {
  return context.graph.evidence.recordTextEvidence({
    ownerId: context.ownerId, deviceId: null, sourceEventId, parentEvidenceId: null,
    sourceType: 'conversation_message', sourceRef: 'session_1',
    capturedAtUtc: context.clock.nowUtc(), sourceTimezone: 'UTC',
    sensitivity: 'personal', retentionUntilUtc: null, metadata: { role: 'user' }, text,
  }).id;
}

test('gate A: a stated preference becomes an explainable, correctable, deletable memory', () => {
  withAssistantContext((context) => {
    const { graph } = context;

    // 1. resolve the entities the statement mentions
    const person = graph.resolver.resolve({
      ownerId: context.ownerId, nodeType: 'person', displayName: 'Denys',
      canonicalKey: 'person:self', contextNodeIds: [], createIfMissing: true,
    });
    const shell = graph.resolver.resolve({
      ownerId: context.ownerId, nodeType: 'software', displayName: 'PowerShell',
      canonicalKey: 'software:powershell', contextNodeIds: [], createIfMissing: true,
    });
    const scope = graph.resolver.resolve({
      ownerId: context.ownerId, nodeType: 'preference_context',
      displayName: 'Windows command examples', canonicalKey: 'context:windows-commands',
      contextNodeIds: [], createIfMissing: true,
    });
    assert.equal(person.kind, 'created');
    assert.equal(shell.kind, 'created');
    assert.equal(scope.kind, 'created');
    if (person.kind !== 'created' || shell.kind !== 'created' || scope.kind !== 'created') return;

    // 2. the statement becomes evidence, then an assertion
    const evidenceId = recordStatement(
      context, 'chat:msg_1', 'I prefer PowerShell for Windows command examples.',
    );
    const outcome = graph.assertionService.assert({
      ownerId: context.ownerId, actorType: 'system', actorRef: null,
      subjectNodeId: person.nodeId, predicate: 'PREFERS',
      object: { kind: 'node', nodeId: shell.nodeId }, scopeNodeId: scope.nodeId,
      basis: 'explicit_user_statement', sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, observedAtUtc: context.clock.nowUtc(),
      topics: ['tooling'], attributes: {},
      searchText: {
        subject: 'Denys', predicate: 'prefers', object: 'PowerShell',
        scope: 'Windows command examples',
      },
      evidence: [{ evidenceId, stance: 'supports', weight: 0.95 }],
    });
    assert.equal(outcome.kind, 'created');
    if (outcome.kind !== 'created') return;

    // 3. it is findable by lexical search over both nodes and assertions
    assert.deepEqual(graph.nodes.searchNodes(context.ownerId, 'powershell', 10), [shell.nodeId]);
    assert.deepEqual(
      graph.assertions.searchAssertions(context.ownerId, 'powershell', 10),
      [outcome.assertionId],
    );

    // 4. it is explainable: value, basis, confidence, scope, evidence, and history
    const belief = graph.assertions.requireAssertion(outcome.assertionId);
    assert.equal(belief.basis, 'explicit_user_statement');
    assert.equal(belief.confidence, 0.95);
    assert.equal(belief.scope_node_id, scope.nodeId);
    assert.deepEqual(
      graph.assertions.listEvidence(outcome.assertionId).map((link) => link.evidence_id),
      [evidenceId],
    );
    assert.equal(
      graph.audit.listMutations(context.ownerId, 'graph_assertions', outcome.assertionId).length, 1,
    );

    // 5. a correction supersedes without erasing history
    const bash = graph.resolver.resolve({
      ownerId: context.ownerId, nodeType: 'software', displayName: 'Bash',
      canonicalKey: 'software:bash', contextNodeIds: [], createIfMissing: true,
    });
    if (bash.kind !== 'created') return;
    context.clock.advanceDays(1);
    const correctionEvidenceId = recordStatement(context, 'chat:msg_2', 'No, I meant Bash.');
    const corrected = graph.assertionService.correct({
      ownerId: context.ownerId, assertionId: outcome.assertionId,
      object: { kind: 'node', nodeId: bash.nodeId },
      reason: 'user correction in conversation',
      observedAtUtc: context.clock.nowUtc(), evidenceId: correctionEvidenceId,
      searchText: {
        subject: 'Denys', predicate: 'prefers', object: 'Bash',
        scope: 'Windows command examples',
      },
    });
    assert.equal(corrected.kind, 'superseded');
    if (corrected.kind !== 'superseded') return;
    assert.equal(graph.assertions.requireAssertion(outcome.assertionId).status, 'superseded');
    assert.equal(graph.assertions.requireAssertion(corrected.assertionId).confidence, 1);

    // 6. deletion is first-class
    graph.assertionService.forget({
      ownerId: context.ownerId, assertionId: corrected.assertionId, reason: 'user deleted',
    });
    assert.equal(graph.assertions.requireAssertion(corrected.assertionId).status, 'deleted');
    assert.deepEqual(graph.assertions.searchAssertions(context.ownerId, 'bash', 10), []);
  });
});

test('gate A: passive observation never overrides an explicit statement', () => {
  withAssistantContext((context) => {
    const { graph } = context;
    const person = graph.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: 'person:self',
      displayName: 'Denys', description: null, sensitivity: 'personal', properties: {},
    });
    const vim = graph.nodes.createNode({
      ownerId: context.ownerId, type: 'software', canonicalKey: 'software:vim',
      displayName: 'Vim', description: null, sensitivity: 'low', properties: {},
    });
    const vscode = graph.nodes.createNode({
      ownerId: context.ownerId, type: 'software', canonicalKey: 'software:vscode',
      displayName: 'VS Code', description: null, sensitivity: 'low', properties: {},
    });

    const statedEvidence = recordStatement(context, 'chat:msg_1', 'I prefer Vim.');
    const stated = graph.assertionService.assert({
      ownerId: context.ownerId, actorType: 'system', actorRef: null,
      subjectNodeId: person.id, predicate: 'PREFERS',
      object: { kind: 'node', nodeId: vim.id }, scopeNodeId: null,
      basis: 'explicit_user_statement', sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, observedAtUtc: context.clock.nowUtc(),
      topics: [], attributes: {},
      searchText: { subject: 'Denys', predicate: 'prefers', object: 'Vim', scope: '' },
      evidence: [{ evidenceId: statedEvidence, stance: 'supports', weight: 0.95 }],
    });
    if (stated.kind !== 'created') return;
    const before = graph.assertions.requireAssertion(stated.assertionId).confidence;

    // three days of passive evidence pointing the other way
    for (let day = 1; day <= 3; day += 1) {
      context.clock.advanceDays(1);
      const observed = recordStatement(context, `activity:day_${day}`, 'VS Code was foreground.');
      const outcome = graph.assertionService.assert({
        ownerId: context.ownerId, actorType: 'system', actorRef: null,
        subjectNodeId: person.id, predicate: 'PREFERS',
        object: { kind: 'node', nodeId: vscode.id }, scopeNodeId: null,
        basis: 'passive_observation', sensitivity: 'personal',
        validFromUtc: null, validToUtc: null, observedAtUtc: context.clock.nowUtc(),
        topics: [], attributes: {},
        searchText: { subject: 'Denys', predicate: 'prefers', object: 'VS Code', scope: '' },
        evidence: [{ evidenceId: observed, stance: 'supports', weight: 0.85 }],
      });
      assert.equal(outcome.kind, 'contradiction_recorded');
    }

    const survivor = graph.assertions.requireAssertion(stated.assertionId);
    assert.equal(survivor.status, 'active');
    assert.equal(survivor.object_node_id, vim.id);
    assert.equal(graph.assertions.contradictionCount(stated.assertionId), 3);
    assert.ok(survivor.confidence < before, 'contradictions lower confidence but do not flip it');
    assert.equal(
      graph.assertions.listBySubject(context.ownerId, person.id, ['active']).length, 1,
    );
  });
});

test('gate A: evidence deletion recalculates dependent confidence', () => {
  withAssistantContext((context) => {
    const { graph } = context;
    const person = graph.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: 'person:self',
      displayName: 'Denys', description: null, sensitivity: 'personal', properties: {},
    });
    const editor = graph.nodes.createNode({
      ownerId: context.ownerId, type: 'software', canonicalKey: 'software:vscode',
      displayName: 'VS Code', description: null, sensitivity: 'low', properties: {},
    });
    const firstEvidence = recordStatement(context, 'chat:msg_1', 'I use VS Code.');
    context.clock.advanceDays(1);
    const secondEvidence = recordStatement(context, 'chat:msg_2', 'VS Code again.');

    const created = graph.assertionService.assert({
      ownerId: context.ownerId, actorType: 'system', actorRef: null,
      subjectNodeId: person.id, predicate: 'USES',
      object: { kind: 'node', nodeId: editor.id }, scopeNodeId: null,
      basis: 'passive_observation', sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, observedAtUtc: context.clock.nowUtc(),
      topics: [], attributes: {},
      searchText: { subject: 'Denys', predicate: 'uses', object: 'VS Code', scope: '' },
      evidence: [
        { evidenceId: firstEvidence, stance: 'supports', weight: 0.6 },
        { evidenceId: secondEvidence, stance: 'supports', weight: 0.6 },
      ],
    });
    if (created.kind !== 'created') return;
    // 1 - 0.4*0.4 = 0.84, under the 0.85 passive ceiling
    assert.ok(Math.abs(graph.assertions.requireAssertion(created.assertionId).confidence - 0.84) < 1e-9);

    graph.evidence.deleteEvidence(firstEvidence);
    const recalculated = graph.assertionService.recalculateConfidence({
      ownerId: context.ownerId, assertionId: created.assertionId,
      reason: 'source evidence deleted',
    });
    assert.ok(Math.abs(recalculated - 0.6) < 1e-9);
    assert.equal(graph.evidence.requireEvidence(firstEvidence).status, 'deleted');
    assert.equal(graph.evidence.requireEvidence(secondEvidence).status, 'active');
  });
});

test('gate A: the graph version advances once per mutation and is queryable', () => {
  withAssistantContext((context) => {
    const { graph } = context;
    assert.equal(graph.graphVersion, 0);
    const person = graph.resolver.resolve({
      ownerId: context.ownerId, nodeType: 'person', displayName: 'Denys',
      canonicalKey: 'person:self', contextNodeIds: [], createIfMissing: true,
    });
    assert.equal(graph.graphVersion, 1);
    if (person.kind !== 'created') return;

    const goal = graph.nodes.createNode({
      ownerId: context.ownerId, type: 'goal', canonicalKey: 'goal:ship-gate-a',
      displayName: 'Ship Gate A', description: null, sensitivity: 'personal', properties: {},
    });
    const evidenceId = recordStatement(context, 'chat:msg_1', 'My goal is to ship Gate A.');
    graph.assertionService.assert({
      ownerId: context.ownerId, actorType: 'system', actorRef: null,
      subjectNodeId: person.nodeId, predicate: 'HAS_GOAL',
      object: { kind: 'node', nodeId: goal.id }, scopeNodeId: null,
      basis: 'explicit_user_statement', sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, observedAtUtc: context.clock.nowUtc(),
      topics: [], attributes: {},
      searchText: { subject: 'Denys', predicate: 'has goal', object: 'Ship Gate A', scope: '' },
      evidence: [{ evidenceId, stance: 'supports', weight: 0.9 }],
    });
    assert.equal(graph.graphVersion, 2);
  });
});

test('gate A: the assistant surface is inert on a database where nothing was written', () => {
  withAssistantContext((context) => {
    const { graph } = context;
    assert.equal(graph.ownerId, context.ownerId);
    assert.equal(graph.graphVersion, 0);
    assert.deepEqual(graph.nodes.listNodesByType(context.ownerId, 'person'), []);
    assert.deepEqual(graph.nodes.searchNodes(context.ownerId, 'anything', 10), []);
    assert.deepEqual(graph.assertions.searchAssertions(context.ownerId, 'anything', 10), []);
    assert.equal(graph.evidence.countEvidence(context.ownerId), 0);
    assert.deepEqual(graph.policies.listPolicies(context.ownerId), []);
    assert.deepEqual(graph.audit.listAuditEvents(context.ownerId, 10), []);
  });
});
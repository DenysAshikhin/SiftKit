import test from 'node:test';
import assert from 'node:assert/strict';

import { AssertionValidator } from '../src/assistant/graph/validation.js';
import { NodeStore } from '../src/assistant/storage/node-store.js';
import { PolicyStore } from '../src/assistant/storage/policy-store.js';
import { withAssistantContext, type AssistantTestContext } from './helpers/assistant-fixture.js';

interface ValidationHarness {
  readonly validator: AssertionValidator;
  readonly nodes: NodeStore;
  readonly policies: PolicyStore;
  readonly personId: string;
  readonly softwareId: string;
  readonly scopeId: string;
}

function harness(context: AssistantTestContext): ValidationHarness {
  const nodes = new NodeStore(context.database, context.clock, context.ids);
  const policies = new PolicyStore(context.database, context.clock, context.ids);
  const person = nodes.createNode({
    ownerId: context.ownerId, type: 'person', canonicalKey: 'person:self',
    displayName: 'Denys', description: null, sensitivity: 'personal', properties: {},
  });
  const software = nodes.createNode({
    ownerId: context.ownerId, type: 'software', canonicalKey: 'software:powershell',
    displayName: 'PowerShell', description: null, sensitivity: 'low', properties: {},
  });
  const scope = nodes.createNode({
    ownerId: context.ownerId, type: 'preference_context', canonicalKey: 'context:windows',
    displayName: 'Windows command examples', description: null,
    sensitivity: 'low', properties: {},
  });
  return {
    validator: new AssertionValidator(nodes, policies),
    nodes, policies,
    personId: person.id, softwareId: software.id, scopeId: scope.id,
  };
}

test('a well-formed request validates', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const result = h.validator.validate({
      ownerId: context.ownerId, subjectNodeId: h.personId, predicate: 'PREFERS',
      object: { kind: 'node', nodeId: h.softwareId }, scopeNodeId: h.scopeId,
      basis: 'explicit_user_statement', confidence: 0.99, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, topics: ['tooling'],
    });
    assert.equal(result.ok, true);
  });
});

test('an unknown predicate is rejected', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const result = h.validator.validate({
      ownerId: context.ownerId, subjectNodeId: h.personId, predicate: 'ENJOYS_DEEPLY',
      object: { kind: 'node', nodeId: h.softwareId }, scopeNodeId: null,
      basis: 'explicit_user_statement', confidence: 0.9, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, topics: [],
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, 'unknown_predicate');
  });
});

test('a subject or object node type outside the descriptor is rejected', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const wrongSubject = h.validator.validate({
      ownerId: context.ownerId, subjectNodeId: h.softwareId, predicate: 'PREFERS',
      object: { kind: 'node', nodeId: h.softwareId }, scopeNodeId: null,
      basis: 'explicit_user_statement', confidence: 0.9, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, topics: [],
    });
    assert.equal(wrongSubject.ok === false && wrongSubject.code, 'subject_type_not_allowed');

    const wrongObject = h.validator.validate({
      ownerId: context.ownerId, subjectNodeId: h.personId, predicate: 'OWNS',
      object: { kind: 'node', nodeId: h.scopeId }, scopeNodeId: null,
      basis: 'explicit_user_statement', confidence: 0.9, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, topics: [],
    });
    assert.equal(wrongObject.ok === false && wrongObject.code, 'object_type_not_allowed');
  });
});

test('object kind must match the descriptor', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const literalWhereNodeExpected = h.validator.validate({
      ownerId: context.ownerId, subjectNodeId: h.personId, predicate: 'OWNS',
      object: { kind: 'literal', valueType: 'string', value: 'a laptop' }, scopeNodeId: null,
      basis: 'explicit_user_statement', confidence: 0.9, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, topics: [],
    });
    assert.equal(literalWhereNodeExpected.ok === false && literalWhereNodeExpected.code,
      'literal_object_not_allowed');

    const nodeWhereLiteralExpected = h.validator.validate({
      ownerId: context.ownerId, subjectNodeId: h.personId, predicate: 'HAS_ROLE',
      object: { kind: 'node', nodeId: h.softwareId }, scopeNodeId: null,
      basis: 'explicit_user_statement', confidence: 0.9, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, topics: [],
    });
    assert.equal(nodeWhereLiteralExpected.ok === false && nodeWhereLiteralExpected.code,
      'node_object_not_allowed');
  });
});

test('a missing, deleted, or merged node reference is rejected', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const missing = h.validator.validate({
      ownerId: context.ownerId, subjectNodeId: 'node_missing', predicate: 'PREFERS',
      object: { kind: 'node', nodeId: h.softwareId }, scopeNodeId: null,
      basis: 'explicit_user_statement', confidence: 0.9, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, topics: [],
    });
    assert.equal(missing.ok === false && missing.code, 'subject_unresolved');

    h.nodes.setNodeStatus(h.softwareId, 'deleted');
    const deleted = h.validator.validate({
      ownerId: context.ownerId, subjectNodeId: h.personId, predicate: 'PREFERS',
      object: { kind: 'node', nodeId: h.softwareId }, scopeNodeId: null,
      basis: 'explicit_user_statement', confidence: 0.9, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, topics: [],
    });
    assert.equal(deleted.ok === false && deleted.code, 'object_unresolved');
  });
});

test('confidence above the basis ceiling is rejected', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const result = h.validator.validate({
      ownerId: context.ownerId, subjectNodeId: h.personId, predicate: 'USES',
      object: { kind: 'node', nodeId: h.softwareId }, scopeNodeId: null,
      basis: 'passive_observation', confidence: 0.95, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, topics: [],
    });
    assert.equal(result.ok === false && result.code, 'confidence_above_ceiling');
  });
});

test('secret_prohibited content is rejected outright', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const result = h.validator.validate({
      ownerId: context.ownerId, subjectNodeId: h.personId, predicate: 'USES',
      object: { kind: 'node', nodeId: h.softwareId }, scopeNodeId: null,
      basis: 'explicit_user_statement', confidence: 0.9, sensitivity: 'secret_prohibited',
      validFromUtc: null, validToUtc: null, topics: [],
    });
    assert.equal(result.ok === false && result.code, 'secret_prohibited');
  });
});

test('a never_infer_topic policy blocks a non-explicit assertion but not an explicit one', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    h.policies.upsertPolicy({
      ownerId: context.ownerId, policyType: 'never_infer_topic', key: 'health',
      value: {}, enabled: true, source: 'user',
    });
    const inferred = h.validator.validate({
      ownerId: context.ownerId, subjectNodeId: h.personId, predicate: 'INTERESTED_IN',
      object: { kind: 'node', nodeId: h.softwareId }, scopeNodeId: null,
      basis: 'assistant_inference', confidence: 0.5, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, topics: ['Health'],
    });
    assert.equal(inferred.ok === false && inferred.code, 'blocked_topic');

    const stated = h.validator.validate({
      ownerId: context.ownerId, subjectNodeId: h.personId, predicate: 'INTERESTED_IN',
      object: { kind: 'node', nodeId: h.softwareId }, scopeNodeId: null,
      basis: 'explicit_user_statement', confidence: 0.9, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, topics: ['Health'],
    });
    assert.equal(stated.ok, true);
  });
});

test('a required temporal window must be present and internally consistent', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const organization = h.nodes.createNode({
      ownerId: context.ownerId, type: 'organization', canonicalKey: 'org:acme',
      displayName: 'Acme', description: null, sensitivity: 'personal', properties: {},
    });
    const missingWindow = h.validator.validate({
      ownerId: context.ownerId, subjectNodeId: h.personId, predicate: 'EMPLOYED_BY',
      object: { kind: 'node', nodeId: organization.id }, scopeNodeId: null,
      basis: 'explicit_user_statement', confidence: 0.9, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, topics: [],
    });
    assert.equal(missingWindow.ok === false && missingWindow.code, 'temporal_window_required');

    const inverted = h.validator.validate({
      ownerId: context.ownerId, subjectNodeId: h.personId, predicate: 'EMPLOYED_BY',
      object: { kind: 'node', nodeId: organization.id }, scopeNodeId: null,
      basis: 'explicit_user_statement', confidence: 0.9, sensitivity: 'personal',
      validFromUtc: '2026-01-01T00:00:00.000Z', validToUtc: '2025-01-01T00:00:00.000Z',
      topics: [],
    });
    assert.equal(inverted.ok === false && inverted.code, 'temporal_window_inconsistent');

    const malformed = h.validator.validate({
      ownerId: context.ownerId, subjectNodeId: h.personId, predicate: 'EMPLOYED_BY',
      object: { kind: 'node', nodeId: organization.id }, scopeNodeId: null,
      basis: 'explicit_user_statement', confidence: 0.9, sensitivity: 'personal',
      validFromUtc: 'last tuesday', validToUtc: null, topics: [],
    });
    assert.equal(malformed.ok === false && malformed.code, 'temporal_window_malformed');
  });
});

test('a scope node must be a preference_context', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const result = h.validator.validate({
      ownerId: context.ownerId, subjectNodeId: h.personId, predicate: 'PREFERS',
      object: { kind: 'node', nodeId: h.softwareId }, scopeNodeId: h.softwareId,
      basis: 'explicit_user_statement', confidence: 0.9, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, topics: [],
    });
    assert.equal(result.ok === false && result.code, 'scope_type_not_allowed');
  });
});

test('a literal value that does not match its declared type is rejected', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const result = h.validator.validate({
      ownerId: context.ownerId, subjectNodeId: h.personId, predicate: 'HAS_ROLE',
      object: { kind: 'literal', valueType: 'integer', value: 'not a number' },
      scopeNodeId: null, basis: 'explicit_user_statement', confidence: 0.9,
      sensitivity: 'personal', validFromUtc: null, validToUtc: null, topics: [],
    });
    assert.equal(result.ok === false && result.code, 'literal_value_invalid');
  });
});
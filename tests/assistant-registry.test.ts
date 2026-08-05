import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ASSERTION_BASES,
  ASSERTION_STATUSES,
  EXPLICIT_BASES,
  PASSIVE_BASES,
  SENSITIVITIES,
  SENSITIVITY_RANK,
  isExplicitBasis,
  isSensitivityAtLeast,
} from '../src/assistant/domain/enums.js';

test('sensitivity levels are ordered least to most restrictive', () => {
  assert.deepEqual(
    [...SENSITIVITIES],
    ['low', 'personal', 'sensitive', 'highly_sensitive', 'secret_prohibited'],
  );
  assert.equal(SENSITIVITY_RANK.low, 0);
  assert.equal(SENSITIVITY_RANK.secret_prohibited, 4);
  assert.equal(isSensitivityAtLeast('highly_sensitive', 'sensitive'), true);
  assert.equal(isSensitivityAtLeast('personal', 'sensitive'), false);
});

test('assertion bases partition into explicit and passive with no overlap or gap', () => {
  assert.equal(ASSERTION_BASES.length, 6);
  const union = [...EXPLICIT_BASES, ...PASSIVE_BASES].sort();
  assert.deepEqual(union, [...ASSERTION_BASES].sort());
  assert.equal(new Set(union).size, ASSERTION_BASES.length);
  assert.equal(isExplicitBasis('explicit_user_statement'), true);
  assert.equal(isExplicitBasis('passive_observation'), false);
});

test('assertion statuses cover the full lifecycle', () => {
  assert.deepEqual(
    [...ASSERTION_STATUSES],
    ['active', 'disputed', 'superseded', 'rejected', 'expired', 'deleted'],
  );
});

import { NODE_TYPES, NODE_TYPE_DEFINITIONS } from '../src/assistant/domain/node-types.js';
import {
  RELATION_DEFINITIONS,
  RELATION_TYPES,
  getRelationDefinition,
  isNodeTypeAllowedAsObject,
  isNodeTypeAllowedAsSubject,
} from '../src/assistant/domain/relation-types.js';

test('node type registry has 28 unique types, each with a definition', () => {
  assert.equal(NODE_TYPES.length, 28);
  assert.equal(new Set(NODE_TYPES).size, 28);
  for (const nodeType of NODE_TYPES) {
    const definition = NODE_TYPE_DEFINITIONS[nodeType];
    assert.equal(typeof definition, 'string');
    assert.ok(definition.length > 10, `${nodeType} needs a real definition`);
  }
});

test('relation registry has 38 unique predicates with complete descriptors', () => {
  assert.equal(RELATION_TYPES.length, 38);
  assert.equal(new Set(RELATION_TYPES).size, 38);
  for (const predicate of RELATION_TYPES) {
    const definition = getRelationDefinition(predicate);
    assert.equal(definition.predicate, predicate);
    assert.ok(definition.allowedSubjectTypes.length > 0);
    if (definition.allowedObjectTypes !== 'literal') {
      assert.ok(definition.allowedObjectTypes.length > 0);
    }
  }
});

test('every declared node type in a relation descriptor exists in the node registry', () => {
  const known = new Set<string>(NODE_TYPES);
  for (const definition of Object.values(RELATION_DEFINITIONS)) {
    for (const subjectType of definition.allowedSubjectTypes) {
      assert.ok(known.has(subjectType), `unknown subject type ${subjectType}`);
    }
    if (definition.allowedObjectTypes !== 'literal') {
      for (const objectType of definition.allowedObjectTypes) {
        assert.ok(known.has(objectType), `unknown object type ${objectType}`);
      }
    }
  }
});

test('inverse predicates are symmetric', () => {
  for (const definition of Object.values(RELATION_DEFINITIONS)) {
    if (definition.inversePredicate === null) continue;
    const inverse = getRelationDefinition(definition.inversePredicate);
    assert.equal(
      inverse.inversePredicate,
      definition.predicate,
      `${definition.predicate} <-> ${definition.inversePredicate} is not symmetric`,
    );
  }
});

test('subject and object type membership checks respect the descriptor', () => {
  assert.equal(isNodeTypeAllowedAsSubject('OWNS', 'person'), true);
  assert.equal(isNodeTypeAllowedAsSubject('OWNS', 'software'), false);
  assert.equal(isNodeTypeAllowedAsObject('OWNS', 'vehicle'), true);
  assert.equal(isNodeTypeAllowedAsObject('OWNS', 'topic'), false);
  assert.equal(isNodeTypeAllowedAsObject('HAS_ROLE', 'person'), false);
});

test('RELATED_TO is never projected', () => {
  assert.equal(getRelationDefinition('RELATED_TO').projectionBehavior, 'never_project');
});

test('HAS_CONSTRAINT disputes rather than superseding, and is exclusive per scope', () => {
  const definition = getRelationDefinition('HAS_CONSTRAINT');
  assert.equal(definition.cardinality, 'single_per_scope');
  assert.equal(definition.conflictStrategy, 'mark_disputed');
});

test('getRelationDefinition rejects a predicate outside the registry', () => {
  assert.throws(() => getRelationDefinition('DEFINITELY_NOT_A_PREDICATE'), /unknown predicate/i);
});
import test from 'node:test';
import assert from 'node:assert/strict';

import { z } from '../src/lib/zod.js';
import type { JsonValue } from '../src/lib/json-types.js';
import { buildProposedStatementSchema, SCOPE_NODE_TYPE } from '../src/assistant/domain/proposal-schema.js';
import { RELATION_TYPES, RELATION_DEFINITIONS } from '../src/assistant/domain/relation-types.js';

const Statement = buildProposedStatementSchema({});

function statement(overrides: Record<string, JsonValue>) {
  return {
    subject: { nodeType: 'person', displayName: 'the user' },
    predicate: 'USES',
    object: { kind: 'unresolved', nodeType: 'software', displayName: 'Visual Studio Code' },
    scope: null,
    rationale: 'The screenshot shows the editor in use.',
    suggestedConfidence: 0.6,
    ...overrides,
  };
}

test('a triple whose types match the relation table validates', () => {
  assert.equal(Statement.safeParse(statement({})).success, true);
});

/** `USES` allows only tool-ish objects; a project object is what the model kept emitting. */
test('an object type the predicate forbids is rejected by the schema itself', () => {
  const parsed = Statement.safeParse(statement({
    object: { kind: 'unresolved', nodeType: 'project', displayName: 'SiftKit' },
  }));
  assert.equal(parsed.success, false);
});

test('a subject type the predicate forbids is rejected', () => {
  const parsed = Statement.safeParse(statement({
    predicate: 'PART_OF',
    subject: { nodeType: 'person', displayName: 'the user' },
    object: { kind: 'unresolved', nodeType: 'project', displayName: 'SiftKit' },
  }));
  assert.equal(parsed.success, false);
});

/** Every scope node is a preference_context; the old schema allowed all 28 node types. */
test('a scope of any other node type is rejected', () => {
  const parsed = Statement.safeParse(statement({
    scope: { nodeType: 'person', displayName: 'the user' },
  }));
  assert.equal(parsed.success, false);
});

test('a preference_context scope is accepted', () => {
  const parsed = Statement.safeParse(statement({
    scope: { nodeType: SCOPE_NODE_TYPE, displayName: 'at work' },
  }));
  assert.equal(parsed.success, true);
});

/** HAS_SETTING is a literal-object predicate, so a node object must not be representable. */
test('a node object for a literal-only predicate is rejected', () => {
  const parsed = Statement.safeParse(statement({
    predicate: 'HAS_SETTING',
    subject: { nodeType: 'software', displayName: 'Visual Studio Code' },
    object: { kind: 'unresolved', nodeType: 'software', displayName: 'dark mode' },
  }));
  assert.equal(parsed.success, false);
});

test('a literal object for a literal-only predicate is accepted', () => {
  const parsed = Statement.safeParse(statement({
    predicate: 'HAS_SETTING',
    subject: { nodeType: 'software', displayName: 'Visual Studio Code' },
    object: { kind: 'literal', valueType: 'string', value: 'dark' },
  }));
  assert.equal(parsed.success, true);
});

/** A predicate added to the table but missing here would silently never be proposable. */
test('every relation type is representable', () => {
  const text = JSON.stringify(z.toJSONSchema(Statement));
  for (const predicate of RELATION_TYPES) {
    assert.equal(text.includes(`"${predicate}"`), true, `${predicate} is missing from the wire schema`);
  }
  assert.equal(RELATION_TYPES.length, Object.keys(RELATION_DEFINITIONS).length);
});

/** Still grammar-compilable: a recursive reference is what broke extraction in the first place. */
test('the generated schema carries no recursive reference', () => {
  const text = JSON.stringify(z.toJSONSchema(Statement));
  assert.equal(text.includes('$ref'), false);
  assert.equal(text.includes('$defs'), false);
});

test('extra fields are carried into every variant', () => {
  const WithKind = buildProposedStatementSchema({ statementKind: z.literal('direct_fact') });
  const parsed = WithKind.safeParse({ ...statement({}), statementKind: 'direct_fact' });
  assert.equal(parsed.success, true);
  assert.equal(WithKind.safeParse(statement({})).success, false);
});

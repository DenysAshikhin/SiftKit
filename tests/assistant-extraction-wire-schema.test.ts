import test from 'node:test';
import assert from 'node:assert/strict';

import { z } from '../src/lib/zod.js';
import { CandidateObjectRefSchema, ProposedObjectRefSchema } from '../src/assistant/domain/keys.js';

function schemaText(schema: z.ZodType<unknown>): string {
  return JSON.stringify(z.toJSONSchema(schema));
}

/**
 * A constrained-decoding backend compiles the supplied JSON Schema into a grammar. A self
 * recursive `$ref` has no finite expansion, so the backend silently drops the constraint and
 * generates freely — which produced fenced, wrong-shaped output and rejected every extraction.
 */
test('the model-facing object ref carries no recursive reference', () => {
  const text = schemaText(ProposedObjectRefSchema);
  assert.equal(text.includes('$ref'), false, 'a $ref cannot be compiled into a finite grammar');
  assert.equal(text.includes('$defs'), false, 'a $defs block implies a reference');
});

test('the model-facing object ref accepts a scalar literal', () => {
  const parsed = ProposedObjectRefSchema.safeParse({
    kind: 'literal', valueType: 'string', value: 'dark',
  });
  assert.equal(parsed.success, true);
});

test('the model-facing object ref rejects a nested literal', () => {
  const parsed = ProposedObjectRefSchema.safeParse({
    kind: 'literal', valueType: 'json', value: { nested: ['deep'] },
  });
  assert.equal(parsed.success, false);
});

test('the model-facing object ref still describes an unresolved node', () => {
  const parsed = ProposedObjectRefSchema.safeParse({
    kind: 'unresolved', nodeType: 'software', displayName: 'Visual Studio Code',
  });
  assert.equal(parsed.success, true);
});

/** Storage keeps the full JsonValue: narrowing the wire must not narrow what can be stored. */
test('the stored object ref still accepts a nested literal', () => {
  const parsed = CandidateObjectRefSchema.safeParse({
    kind: 'literal', valueType: 'json', value: { nested: ['deep'] },
  });
  assert.equal(parsed.success, true);
});

/** Whatever the model may propose must be storable without a cast. */
test('every proposed object ref is a valid stored object ref', () => {
  for (const value of ['dark', 7, true, null]) {
    const proposed = ProposedObjectRefSchema.parse({ kind: 'literal', valueType: 'string', value });
    assert.equal(CandidateObjectRefSchema.safeParse(proposed).success, true);
  }
});

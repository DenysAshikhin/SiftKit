import test from 'node:test';
import assert from 'node:assert/strict';

import { z } from '../src/lib/zod.js';
import { CandidateObjectRefSchema } from '../src/assistant/domain/keys.js';
import { ImageExtractionSchema } from '../src/assistant/images/image-extractor.js';
import { ConversationExtractionSchema } from '../src/assistant/ingestion/conversation-extractor.js';

function schemaText<T>(schema: z.ZodType<T>): string {
  return JSON.stringify(z.toJSONSchema(schema));
}

/**
 * A constrained-decoding backend compiles the supplied JSON Schema into a grammar. A self
 * recursive `$ref` has no finite expansion, so the backend silently drops the constraint and
 * generates freely — which produced fenced, wrong-shaped output and rejected every extraction.
 */
test('the screenshot extraction payload carries no recursive reference', () => {
  const text = schemaText(ImageExtractionSchema);
  assert.equal(text.includes('$ref'), false, 'a $ref cannot be compiled into a finite grammar');
  assert.equal(text.includes('$defs'), false, 'a $defs block implies a reference');
});

test('the conversation extraction payload carries no recursive reference', () => {
  const text = schemaText(ConversationExtractionSchema);
  assert.equal(text.includes('$ref'), false);
  assert.equal(text.includes('$defs'), false);
});

/** Storage keeps the full JsonValue: narrowing the wire must not narrow what can be stored. */
test('the stored object ref still accepts a nested literal', () => {
  const parsed = CandidateObjectRefSchema.safeParse({
    kind: 'literal', valueType: 'json', value: { nested: ['deep'] },
  });
  assert.equal(parsed.success, true);
});

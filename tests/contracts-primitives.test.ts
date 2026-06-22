import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonDataSchema, JsonObjectSchema } from '@siftkit/contracts';

test('JsonDataSchema accepts nested json', () => {
  const value = { a: 1, b: [true, null, 'x'], c: { d: 2 } };
  assert.deepEqual(JsonDataSchema.parse(value), value);
});

test('JsonObjectSchema rejects a non-object', () => {
  assert.throws(() => JsonObjectSchema.parse([1, 2, 3]));
});

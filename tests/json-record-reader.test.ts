import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonRecordReader } from '../src/lib/json-record-reader.js';
import type { JsonObject } from '../src/lib/json-types.js';

test('JsonRecordReader reads trimmed strings and optional strings', () => {
  const reader = new JsonRecordReader({ name: '  alpha  ', empty: '   ', count: 4 });

  assert.equal(reader.string('name'), 'alpha');
  assert.equal(reader.string('missing'), '');
  assert.equal(reader.optionalString('name'), 'alpha');
  assert.equal(reader.optionalString('empty'), undefined);
  assert.equal(reader.optionalString('count'), undefined);
});

test('JsonRecordReader reads positive and non-negative numbers', () => {
  const reader = new JsonRecordReader({ good: '4', zero: 0, bad: -1, text: 'x' });

  assert.equal(reader.positiveNumber('good', 9), 4);
  assert.equal(reader.positiveNumber('zero', 9), 9);
  assert.equal(reader.nonNegativeInteger('good', 0), 4);
  assert.equal(reader.nonNegativeInteger('bad', 7), 7);
  assert.equal(reader.nullableNonNegativeInteger('text'), null);
});

test('JsonRecordReader reads booleans, arrays, and nested objects without exposing unknown maps', () => {
  const nested: JsonObject = { enabled: true, tags: ['a', 'b'], child: { id: 'x' } };
  const reader = new JsonRecordReader(nested);

  assert.equal(reader.boolean('enabled', false), true);
  assert.deepEqual(reader.stringArray('tags'), ['a', 'b']);
  assert.deepEqual(reader.object('child'), { id: 'x' });
  assert.equal(reader.object('missing'), null);
});

test('JsonRecordReader rejects non-object input through fromUnknown', () => {
  assert.deepEqual(JsonRecordReader.fromUnknown(null).record, {});
  assert.deepEqual(JsonRecordReader.fromUnknown(['x']).record, {});
  assert.deepEqual(JsonRecordReader.fromUnknown({ id: 'ok' }).record, { id: 'ok' });
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { FixedClock, SystemClock } from '../src/assistant/clock.js';
import { RandomIdGenerator, SequentialIdGenerator } from '../src/assistant/ids.js';
import {
  buildAssertionKey,
  buildCandidateFingerprint,
  hashBytes,
  hashTextContent,
  normalizeAliasText,
  normalizeLiteralValue,
} from '../src/assistant/domain/keys.js';

test('FixedClock returns the configured instant and advances only on request', () => {
  const clock = new FixedClock('2026-08-05T10:00:00.000Z');
  assert.equal(clock.nowUtc(), '2026-08-05T10:00:00.000Z');
  assert.equal(clock.nowUtc(), '2026-08-05T10:00:00.000Z');
  clock.advanceSeconds(90);
  assert.equal(clock.nowUtc(), '2026-08-05T10:01:30.000Z');
  assert.equal(clock.nowEpochMs(), Date.parse('2026-08-05T10:01:30.000Z'));
});

test('FixedClock rejects a non-ISO instant', () => {
  assert.throws(() => new FixedClock('not-a-date'), /invalid instant/i);
});

test('SystemClock emits a UTC ISO-8601 instant', () => {
  const value = new SystemClock().nowUtc();
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('SequentialIdGenerator is deterministic and prefixed', () => {
  const ids = new SequentialIdGenerator();
  assert.equal(ids.next('node'), 'node_0001');
  assert.equal(ids.next('node'), 'node_0002');
  assert.equal(ids.next('ast'), 'ast_0003');
});

test('RandomIdGenerator emits unique prefixed ids', () => {
  const ids = new RandomIdGenerator();
  const first = ids.next('ast');
  const second = ids.next('ast');
  assert.notEqual(first, second);
  assert.ok(first.startsWith('ast_'));
  assert.ok(first.length > 10);
});

test('alias normalization trims, NFC-normalizes, collapses whitespace, and lowercases', () => {
  assert.equal(normalizeAliasText('  Visual   Studio Code  '), 'visual studio code');
  assert.equal(normalizeAliasText('Cafe\u0301'), normalizeAliasText('Caf\u00e9'));
});

test('literal normalization is type-directed', () => {
  assert.equal(normalizeLiteralValue('string', '  PowerShell  '), 'powershell');
  assert.equal(normalizeLiteralValue('integer', 42), '42');
  assert.equal(normalizeLiteralValue('number', 1.5000), '1.5');
  assert.equal(normalizeLiteralValue('boolean', true), 'true');
  assert.equal(normalizeLiteralValue('date', '2026-08-05'), '2026-08-05');
  assert.equal(
    normalizeLiteralValue('datetime', '2026-08-05T12:00:00+02:00'),
    '2026-08-05T10:00:00.000Z',
  );
  assert.equal(normalizeLiteralValue('quantity', { amount: 24, unit: 'GB' }), '24 gb');
  assert.equal(normalizeLiteralValue('duration', 'PT30M'), 'PT30M');
  assert.equal(normalizeLiteralValue('json', { b: 1, a: 2 }), '{"a":2,"b":1}');
});

test('literal normalization rejects a value that does not match its declared type', () => {
  assert.throws(() => normalizeLiteralValue('integer', 1.5), /integer/i);
  assert.throws(() => normalizeLiteralValue('datetime', 'yesterday'), /datetime/i);
  assert.throws(() => normalizeLiteralValue('quantity', 'lots'), /quantity/i);
});

test('assertion key is stable, scope-sensitive, and object-kind sensitive', () => {
  const base = {
    ownerId: 'own_1',
    subjectNodeId: 'node_1',
    predicate: 'PREFERS',
    scopeNodeId: null,
  } as const;
  const nodeObject = buildAssertionKey({ ...base, object: { kind: 'node', nodeId: 'node_2' } });
  const sameAgain = buildAssertionKey({ ...base, object: { kind: 'node', nodeId: 'node_2' } });
  assert.equal(nodeObject, sameAgain);
  assert.match(nodeObject, /^[0-9a-f]{64}$/);

  const scoped = buildAssertionKey({
    ...base,
    scopeNodeId: 'node_scope',
    object: { kind: 'node', nodeId: 'node_2' },
  });
  assert.notEqual(nodeObject, scoped);

  const literalObject = buildAssertionKey({
    ...base,
    object: { kind: 'literal', valueType: 'string', value: 'PowerShell' },
  });
  const literalCasing = buildAssertionKey({
    ...base,
    object: { kind: 'literal', valueType: 'string', value: '  powershell ' },
  });
  assert.equal(literalObject, literalCasing);
  assert.notEqual(literalObject, nodeObject);
});

test('candidate fingerprint collides for the same unresolved proposal', () => {
  const first = buildCandidateFingerprint({
    ownerId: 'own_1',
    subject: { nodeType: 'person', displayName: 'Denys' },
    predicate: 'USES',
    object: { kind: 'unresolved', nodeType: 'software', displayName: '  PowerShell ' },
    scope: null,
  });
  const second = buildCandidateFingerprint({
    ownerId: 'own_1',
    subject: { nodeType: 'person', displayName: 'denys' },
    predicate: 'USES',
    object: { kind: 'unresolved', nodeType: 'software', displayName: 'PowerShell' },
    scope: null,
  });
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test('text content hash normalizes line endings and Unicode form', () => {
  assert.equal(hashTextContent('a\r\nb'), hashTextContent('a\nb'));
  assert.equal(hashTextContent('Cafe\u0301'), hashTextContent('Caf\u00e9'));
  assert.notEqual(hashTextContent('a'), hashTextContent('b'));
});

test('byte hash is raw SHA-256, distinct from the text hash pipeline', () => {
  assert.match(hashBytes(Buffer.from([1, 2, 3])), /^[0-9a-f]{64}$/);
  assert.equal(hashBytes(Buffer.from('abc', 'utf8')), hashBytes(Buffer.from('abc', 'utf8')));
});
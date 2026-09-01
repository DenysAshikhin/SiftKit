import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRepoSearchMockCommandResults } from '../src/status-server/repo-search-request-normalizers.js';

test('returns undefined for non-object inputs', () => {
  assert.equal(normalizeRepoSearchMockCommandResults(null), undefined);
  assert.equal(normalizeRepoSearchMockCommandResults('x'), undefined);
  assert.equal(normalizeRepoSearchMockCommandResults([1, 2]), undefined);
});

test('returns undefined when no valid entries', () => {
  assert.equal(normalizeRepoSearchMockCommandResults({ cmd: 5 }), undefined);
});

test('normalizes a valid mock entry, coercing field types', () => {
  const result = normalizeRepoSearchMockCommandResults({
    'rg foo': { exitCode: 0, stdout: 'hit', stderr: '', delayMs: 12 },
  });
  assert.deepEqual(result, {
    'rg foo': { exitCode: 0, stdout: 'hit', stderr: '', delayMs: 12 },
  });
});

test('drops non-finite numbers and non-string fields to undefined', () => {
  const result = normalizeRepoSearchMockCommandResults({
    'rg foo': { exitCode: 'nope', stdout: 9, stderr: null, delayMs: 'x' },
  });
  assert.deepEqual(result, {
    'rg foo': { exitCode: undefined, stdout: undefined, stderr: undefined, delayMs: undefined },
  });
});

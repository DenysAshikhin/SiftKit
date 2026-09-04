import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePlanMaxTurnsOverride,
  requireSelectedSession,
  resolveRepoRoot,
} from '../src/lib/chat-composer-inputs';
import type { ChatSession } from '../src/types';

const SESSION: ChatSession = {
  id: 's1',
  title: 'Session',
  model: null,
  contextWindowTokens: 100,
  planRepoRoot: 'C:/repo',
  createdAtUtc: '2026-06-03T12:00:00.000Z',
  updatedAtUtc: '2026-06-03T12:00:00.000Z',
  messages: [],
};

test('parsePlanMaxTurnsOverride returns maxTurns when input is a positive number', () => {
  assert.deepEqual(parsePlanMaxTurnsOverride('45'), { maxTurns: 45 });
});

test('parsePlanMaxTurnsOverride returns empty object for invalid values', () => {
  assert.deepEqual(parsePlanMaxTurnsOverride('0'), {});
  assert.deepEqual(parsePlanMaxTurnsOverride('-5'), {});
  assert.deepEqual(parsePlanMaxTurnsOverride('abc'), {});
  assert.deepEqual(parsePlanMaxTurnsOverride(''), {});
});

test('resolveRepoRoot trims input and falls back for blanks', () => {
  assert.equal(resolveRepoRoot('  C:\\repo  ', 'fallback'), 'C:\\repo');
  assert.equal(resolveRepoRoot('   ', 'fallback'), 'fallback');
  assert.equal(resolveRepoRoot('', ''), '');
});

test('requireSelectedSession rejects null and returns a session', () => {
  assert.throws(() => requireSelectedSession(null), /selectedSession is required/);
  assert.equal(requireSelectedSession(SESSION), SESSION);
});
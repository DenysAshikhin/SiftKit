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

test('parsePlanMaxTurnsOverride treats blank input as no override', () => {
  assert.deepEqual(parsePlanMaxTurnsOverride(''), {});
  assert.deepEqual(parsePlanMaxTurnsOverride('  '), {});
});

for (const value of ['1', '1000', '10000', '9007199254740991']) {
  test(`parsePlanMaxTurnsOverride accepts ${value}`, () => {
    assert.deepEqual(parsePlanMaxTurnsOverride(value), { maxTurns: Number(value) });
  });
}

for (const value of ['0', '-5', '1.5', '1k', '1e3', '0x10', '+1', 'NaN', 'Infinity', '9007199254740992']) {
  test(`parsePlanMaxTurnsOverride rejects ${JSON.stringify(value)}`, () => {
    assert.throws(
      () => parsePlanMaxTurnsOverride(value),
      /whole number from 1 to 9007199254740991/u,
    );
  });
}

test('parsePlanMaxTurnsOverride trims valid decimal digits', () => {
  assert.deepEqual(parsePlanMaxTurnsOverride('  001000  '), { maxTurns: 1000 });
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

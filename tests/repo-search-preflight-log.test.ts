import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRepoSearchPreflightLogBody } from '../src/repo-search/execute.js';

test('a fast, clean preflight prints nothing: the command line already carries the turn', () => {
  assert.equal(
    buildRepoSearchPreflightLogBody({
      turn: 4,
      maxTurns: 45,
      promptTokenCount: 32_944,
      tokenizeElapsedMs: 14,
      tokenCountSource: 'exl3',
      tokenizeRetryCount: 0,
      tokenizeStatus: 'completed',
      elapsedMs: 31_195,
    }),
    null,
  );
});

test('the threshold is exclusive: 25ms stays silent, 26ms speaks up', () => {
  const summary = {
    turn: 4,
    maxTurns: 45,
    promptTokenCount: 32_944,
    tokenCountSource: 'exl3',
    tokenizeRetryCount: 0,
    tokenizeStatus: 'completed',
    elapsedMs: 31_195,
  } as const;

  assert.equal(buildRepoSearchPreflightLogBody({ ...summary, tokenizeElapsedMs: 25 }), null);
  assert.notEqual(buildRepoSearchPreflightLogBody({ ...summary, tokenizeElapsedMs: 26 }), null);
});

test('a slow tokenize surfaces the duration and its source as a red alert fragment', () => {
  assert.deepEqual(
    buildRepoSearchPreflightLogBody({
      turn: 4,
      maxTurns: 45,
      promptTokenCount: 32_944,
      tokenizeElapsedMs: 111,
      tokenCountSource: 'exl3',
      tokenizeRetryCount: 0,
      tokenizeStatus: 'completed',
      elapsedMs: 31_195,
    }),
    {
      event: 'preflight',
      fields: 't4/45  prompt=32,944tok  elapsed=31s',
      alert: 'tokenize=111ms(exl3)',
      severity: 'normal',
    },
  );
});

test('the character count is gone from the preflight line', () => {
  const body = buildRepoSearchPreflightLogBody({
    turn: 4,
    maxTurns: 45,
    promptTokenCount: 32_944,
    tokenizeElapsedMs: 900,
    tokenCountSource: 'estimate',
    tokenizeRetryCount: 0,
    tokenizeStatus: 'completed',
    elapsedMs: 31_000,
  });

  assert.notEqual(body, null);
  assert.doesNotMatch(String(body?.fields), /kc/u);
});

test('retries print the line even when tokenization was fast, and carry no alert', () => {
  const body = buildRepoSearchPreflightLogBody({
    turn: 1,
    maxTurns: 45,
    promptTokenCount: 120,
    tokenizeElapsedMs: 4,
    tokenCountSource: 'exl3',
    tokenizeRetryCount: 2,
    tokenizeStatus: 'completed',
    elapsedMs: 900,
  });

  assert.deepEqual(body, {
    event: 'preflight',
    fields: 't1/45  prompt=120tok  elapsed=1s  retries=2',
    severity: 'normal',
  });
});

test('a failed tokenize carries error severity, the status and the message', () => {
  const body = buildRepoSearchPreflightLogBody({
    turn: 1,
    maxTurns: 45,
    promptTokenCount: 0,
    tokenizeElapsedMs: 10_000,
    tokenCountSource: 'estimate',
    tokenizeRetryCount: 3,
    tokenizeStatus: 'failed',
    elapsedMs: 10_000,
    errorMessage: 'tokenize timed out',
  });

  assert.equal(body?.severity, 'error');
  assert.match(String(body?.fields), /retries=3/u);
  assert.match(String(body?.fields), /status=failed/u);
  assert.match(String(body?.fields), /tokenize timed out/u);
  assert.equal(body?.alert, 'tokenize=10000ms(estimate)');
});

test('a failure that tokenized quickly still prints, without an alert fragment', () => {
  const body = buildRepoSearchPreflightLogBody({
    turn: 7,
    maxTurns: 45,
    promptTokenCount: 0,
    tokenizeElapsedMs: 3,
    tokenCountSource: 'estimate',
    tokenizeRetryCount: 0,
    tokenizeStatus: 'aborted',
    elapsedMs: 2_000,
  });

  assert.deepEqual(body, {
    event: 'preflight',
    fields: 't7/45  prompt=0tok  elapsed=2s  status=aborted',
    severity: 'error',
  });
});

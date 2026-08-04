import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRepoSearchPreflightLogBody } from '../src/repo-search/execute.js';

test('one preflight body replaces the four preflight events', () => {
  assert.deepEqual(
    buildRepoSearchPreflightLogBody({
      turn: 4,
      maxTurns: 45,
      promptChars: 102_949,
      promptTokenCount: 32_944,
      tokenizeElapsedMs: 111,
      tokenCountSource: 'exl3',
      tokenizeRetryCount: 0,
      tokenizeStatus: 'completed',
      elapsedMs: 31_195,
    }),
    {
      event: 'preflight',
      fields: 't4/45  prompt=32,944tok/102.9kc  tokenize=111ms(exl3)  elapsed=31s',
      severity: 'normal',
    },
  );
});

test('the preflight line reports estimate when the server tokenizer was unavailable', () => {
  const body = buildRepoSearchPreflightLogBody({
    turn: 4,
    maxTurns: 45,
    promptChars: 102_900,
    promptTokenCount: 32_944,
    tokenizeElapsedMs: 111,
    tokenCountSource: 'estimate',
    tokenizeRetryCount: 0,
    tokenizeStatus: 'completed',
    elapsedMs: 31_000,
  });
  assert.match(body.fields, /tokenize=111ms\(estimate\)/u);
});

test('retries are printed only when the tokenizer actually retried', () => {
  assert.match(
    buildRepoSearchPreflightLogBody({
      turn: 1,
      maxTurns: 45,
      promptChars: 500,
      promptTokenCount: 120,
      tokenizeElapsedMs: 40,
      tokenCountSource: 'llama',
      tokenizeRetryCount: 2,
      tokenizeStatus: 'completed',
      elapsedMs: 900,
    }).fields,
    /retries=2/u,
  );
});

test('a failed tokenize carries error severity, the status and the message', () => {
  const body = buildRepoSearchPreflightLogBody({
    turn: 1,
    maxTurns: 45,
    promptChars: 10,
    promptTokenCount: 0,
    tokenizeElapsedMs: 10_000,
    tokenCountSource: 'estimate',
    tokenizeRetryCount: 3,
    tokenizeStatus: 'failed',
    elapsedMs: 10_000,
    errorMessage: 'tokenize timed out',
  });

  assert.equal(body.severity, 'error');
  assert.match(body.fields, /retries=3/u);
  assert.match(body.fields, /status=failed/u);
  assert.match(body.fields, /tokenize timed out/u);
});

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
      tokenCountSource: 'llama.cpp',
      tokenizeRetryCount: 0,
      tokenizeStatus: 'completed',
      elapsedMs: 31_195,
    }),
    {
      event: 'preflight',
      fields: 't4/45  prompt=32,944tok/102.9kc  tokenize=111ms(llama.cpp)  elapsed=31s',
      severity: 'normal',
    },
  );
});

test('retries are printed only when the tokenizer actually retried', () => {
  assert.match(
    buildRepoSearchPreflightLogBody({
      turn: 1,
      maxTurns: 45,
      promptChars: 500,
      promptTokenCount: 120,
      tokenizeElapsedMs: 40,
      tokenCountSource: 'llama.cpp',
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

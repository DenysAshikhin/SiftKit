import test from 'node:test';
import assert from 'node:assert/strict';

import { ServerLogger } from '../src/status-server/server-logger.js';
import { logRepoSearchPreflight } from '../src/repo-search/execute.js';

function collect(): { lines: string[]; write: (text: string) => void } {
  const lines: string[] = [];
  return { lines, write: (text: string) => { lines.push(text); } };
}

test('one preflight line replaces the four preflight events', () => {
  const sink = collect();
  const logger = new ServerLogger({ level: 'normal', colour: false, write: sink.write });

  logRepoSearchPreflight(logger, 'ddda7acf-fe04-45b8-9005-2180c3327878', {
    turn: 4,
    maxTurns: 45,
    promptChars: 102_949,
    promptTokenCount: 32_944,
    tokenizeElapsedMs: 111,
    tokenCountSource: 'llama.cpp',
    tokenizeRetryCount: 0,
    tokenizeStatus: 'completed',
    elapsedMs: 31_195,
  });

  assert.equal(sink.lines.length, 1);
  assert.equal(
    sink.lines[0].slice('20:42:37  '.length),
    'rs ddda7acf  preflight  t4/45  prompt=32,944tok/102.9kc  tokenize=111ms(llama.cpp)  elapsed=31s\n',
  );
});

test('retries are printed only when the tokenizer actually retried', () => {
  const sink = collect();
  const logger = new ServerLogger({ level: 'normal', colour: false, write: sink.write });

  logRepoSearchPreflight(logger, 'ddda7acf', {
    turn: 1,
    maxTurns: 45,
    promptChars: 500,
    promptTokenCount: 120,
    tokenizeElapsedMs: 40,
    tokenCountSource: 'llama.cpp',
    tokenizeRetryCount: 2,
    tokenizeStatus: 'completed',
    elapsedMs: 900,
  });

  assert.match(sink.lines[0], /retries=2/u);
});

test('a failed tokenize is logged as an error with the message', () => {
  const sink = collect();
  const logger = new ServerLogger({ level: 'quiet', colour: false, write: sink.write });

  logRepoSearchPreflight(logger, 'ddda7acf', {
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

  assert.equal(sink.lines.length, 1, 'failures survive the quiet level');
  assert.match(sink.lines[0], /retries=3/u);
  assert.match(sink.lines[0], /status=failed/u);
  assert.match(sink.lines[0], /tokenize timed out/u);
});

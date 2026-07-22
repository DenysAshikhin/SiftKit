import test from 'node:test';
import assert from 'node:assert/strict';
import { CliProgressRenderer, SilentProgressRenderer } from '../src/cli/progress-renderer.js';
import { makeCaptureStream } from './_test-helpers.js';

test('renders known progress kinds as single stderr lines', () => {
  const stderr = makeCaptureStream();
  const renderer = new CliProgressRenderer(stderr.stream, 'repo-search');
  renderer.render({ kind: 'lock_wait', queueLength: 1, elapsedMs: 4_200 });
  renderer.render({ kind: 'llm_start', turn: 3, maxTurns: 24, promptTokenCount: 1_234 });
  renderer.render({ kind: 'tool_start', turn: 3, maxTurns: 24, command: 'git grep -n "x" src' });
  renderer.render({
    kind: 'tool_result',
    turn: 3,
    maxTurns: 24,
    command: 'git grep -n "x" src',
    exitCode: 0,
    outputTokens: 57,
  });
  const lines = stderr.read().trim().split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0] ?? '', /repo-search waiting for model lock \(1 queued, 4s\)/u);
  assert.match(lines[1] ?? '', /repo-search t3\/24 llm_start prompt=1,234tok/u);
  assert.match(lines[2] ?? '', /repo-search t3\/24 git grep -n "x" src/u);
  assert.match(lines[3] ?? '', /repo-search t3\/24 done exit=0 57tok/u);
});

test('skips thinking and answer events and renders unknown kinds by name', () => {
  const stderr = makeCaptureStream();
  const renderer = new CliProgressRenderer(stderr.stream, 'summary');
  renderer.render({ kind: 'thinking', thinkingText: 'hidden' });
  renderer.render({ kind: 'answer', answerText: 'hidden' });
  renderer.render({ kind: 'core_start', backend: 'llama.cpp' });
  const lines = stderr.read().trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /summary core_start/u);
});

test('SilentProgressRenderer renders nothing', () => {
  const stderr = makeCaptureStream();
  const renderer = new SilentProgressRenderer(stderr.stream, 'eval');
  renderer.render({ kind: 'core_start' });
  assert.equal(stderr.read(), '');
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { runCli } from '../dist/cli/index.js';
import { makeCaptureStream } from './_test-helpers.js';

test('CLI accepts --h as help alias', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['--h'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 0);
  assert.match(stdout.read(), /SiftKit CLI/u);
});

test('CLI accepts -help as help alias', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['-help'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 0);
  assert.match(stdout.read(), /Usage:/u);
});

test('CLI help advertises preset commands', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['--help'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 0);
  assert.match(stdout.read(), /siftkit preset list/u);
});

test('repo-search help works without server startup', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['repo-search', '-h'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 0);
  assert.match(stdout.read(), /repo-search/u);
});

test('run help works without executing --help as a command', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['run', '--help'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 0);
  assert.match(stdout.read(), /siftkit run --command <cmd>/u);
  assert.equal(stderr.read(), '');
});

test('repo-search rejects unknown flags before startup checks', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['repo-search', '--prmopt', 'find planner tools'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 1);
  assert.match(stderr.read(), /Unknown option for repo-search: --prmopt/u);
});

test('repo-search rejects --max-turns for CLI usage', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['repo-search', '--prompt', 'find planner tools', '--max-turns', '5'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 1);
  assert.match(stderr.read(), /Unknown option for repo-search: --max-turns/u);
});

test('summary requires stdin, --text, or --file', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['summary', '--question', 'hello'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 1);
  assert.match(stderr.read(), /stdin, --text or --file required|not reachable/u);
});

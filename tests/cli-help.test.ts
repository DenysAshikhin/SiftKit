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

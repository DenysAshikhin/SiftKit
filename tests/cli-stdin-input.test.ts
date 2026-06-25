import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { commandReadsStdin, readStdinToEnd } from '../src/cli/stdin-input.js';

test('commandReadsStdin: stdin-consuming commands without inline input', () => {
  assert.equal(commandReadsStdin(['summary', '--question', 'q']), true);
  assert.equal(commandReadsStdin(['--question', 'q']), true);
  assert.equal(commandReadsStdin(['run', '--preset', 'p', '--question', 'q']), true);
  assert.equal(commandReadsStdin(['internal', '--op', 'summary']), true);
});

test('commandReadsStdin: inline --text/--file/--request-file suppress stdin', () => {
  assert.equal(commandReadsStdin(['summary', '--text', 't', '--question', 'q']), false);
  assert.equal(commandReadsStdin(['summary', '--file', 'f', '--question', 'q']), false);
  assert.equal(commandReadsStdin(['run', '--preset', 'p', '--text', 't']), false);
  assert.equal(commandReadsStdin(['internal', '--op', 'x', '--request-file', 'r']), false);
});

test('commandReadsStdin: non-consuming commands never read stdin', () => {
  assert.equal(commandReadsStdin(['repo-search', '--prompt', 'x']), false);
  assert.equal(commandReadsStdin(['--prompt', 'x']), false);
  assert.equal(commandReadsStdin(['find-files', '--path', '.']), false);
  assert.equal(commandReadsStdin(['run', 'echo', 'hi']), false);
  assert.equal(commandReadsStdin(['help']), false);
  assert.equal(commandReadsStdin([]), false);
});

test('readStdinToEnd: concatenates chunks until end', async () => {
  const stream = Readable.from(['hello ', 'world']);
  const result = await readStdinToEnd(stream);
  assert.equal(result.text, 'hello world');
  assert.ok(result.stdinWaitMs >= 0);
});

test('readStdinToEnd: empty stream resolves empty', async () => {
  const stream = Readable.from([]);
  const result = await readStdinToEnd(stream);
  assert.equal(result.text, '');
});

test('readStdinToEnd: rejects on stream error', async () => {
  const stream = new Readable({ read() { this.destroy(new Error('boom')); } });
  await assert.rejects(readStdinToEnd(stream), /boom/u);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { readCliTextInput } from '../src/cli/input.ts';
import { runCli } from '../src/cli/index.ts';
import { makeCaptureStream } from './_test-helpers.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';
import { withBoundaryServer } from './helpers/cli-boundary-server.ts';

test('readCliTextInput: a set but missing --file throws instead of using empty stdin', () => {
  const tempRoot = createManagedTempDir('siftkit-cli-input-');
  const missingPath = path.join(tempRoot, 'missing.txt');
  try {
    assert.throws(
      () => readCliTextInput({ file: missingPath, stdinText: '' }),
      /Input file not found/u,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('readCliTextInput: a missing --file does not fall back to the pipe', () => {
  const tempRoot = createManagedTempDir('siftkit-cli-input-');
  const missingPath = path.join(tempRoot, 'missing.txt');
  try {
    assert.throws(
      () => readCliTextInput({ file: missingPath, stdinText: 'piped' }),
      /Input file not found/u,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('readCliTextInput: an existing --file wins over the pipe', () => {
  const tempRoot = createManagedTempDir('siftkit-cli-input-');
  const inputPath = path.join(tempRoot, 'input.txt');
  fs.writeFileSync(inputPath, 'file text\n', 'utf8');
  try {
    assert.equal(readCliTextInput({ file: inputPath, stdinText: 'piped' }), 'file text');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('readCliTextInput: stdin is consulted only when no --file was given', () => {
  assert.equal(readCliTextInput({ stdinText: '' }), '');
  assert.equal(readCliTextInput({}), null);
});

test('summary with a missing --file fails without summarising empty input', async () => {
  await withBoundaryServer(async (server) => {
    const tempRoot = createManagedTempDir('siftkit-cli-input-e2e-');
    const missingPath = path.join(tempRoot, 'missing.txt');
    try {
      const stdout = makeCaptureStream();
      const stderr = makeCaptureStream();
      const code = await runCli({
        argv: ['summary', '--question', 'q', '--file', missingPath],
        stdinText: '',
        stdout: stdout.stream,
        stderr: stderr.stream,
      });
      assert.equal(code, 1);
      assert.match(stderr.read(), /Input file not found/u);
      assert.equal(server.requests.length, 0);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
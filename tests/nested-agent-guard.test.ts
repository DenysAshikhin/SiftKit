import test from 'node:test';
import assert from 'node:assert/strict';

import { runCli } from '../src/cli/index.js';
import { AGENT_RUN_ID_ENV } from '../src/lib/agent-run-marker.js';
import { makeCaptureStream } from './_test-helpers.js';

async function runGuardedCli(argv: string[], stdinText?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const previous = process.env[AGENT_RUN_ID_ENV];
  const previousBackend = process.env.SIFTKIT_STATUS_BACKEND_URL;
  const previousConfig = process.env.SIFTKIT_CONFIG_SERVICE_URL;
  process.env[AGENT_RUN_ID_ENV] = 'run-guard-1';
  process.env.SIFTKIT_STATUS_BACKEND_URL = 'http://127.0.0.1:9/status';
  process.env.SIFTKIT_CONFIG_SERVICE_URL = 'http://127.0.0.1:9/config';
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  try {
    const code = await runCli({ argv, stdout: stdout.stream, stderr: stderr.stream, stdinText });
    return { code, stdout: stdout.read(), stderr: stderr.read() };
  } finally {
    if (previous === undefined) {
      delete process.env[AGENT_RUN_ID_ENV];
    } else {
      process.env[AGENT_RUN_ID_ENV] = previous;
    }
    if (previousBackend === undefined) {
      delete process.env.SIFTKIT_STATUS_BACKEND_URL;
    } else {
      process.env.SIFTKIT_STATUS_BACKEND_URL = previousBackend;
    }
    if (previousConfig === undefined) {
      delete process.env.SIFTKIT_CONFIG_SERVICE_URL;
    } else {
      process.env.SIFTKIT_CONFIG_SERVICE_URL = previousConfig;
    }
  }
}

async function runGuardedCliWithProcessStderr(
  argv: string[],
  stdinText?: string,
): Promise<{ code: number; stdout: string; stderr: string; processStderr: string }> {
  const originalWrite = process.stderr.write;
  let processStderr = '';
  const patchedWrite = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    processStderr += String(chunk);
    if (typeof encodingOrCallback === 'function') {
      encodingOrCallback();
    } else if (callback) {
      callback();
    }
    return true;
  };

  process.stderr.write = patchedWrite;
  try {
    const result = await runGuardedCli(argv, stdinText);
    return { ...result, processStderr };
  } finally {
    process.stderr.write = originalWrite;
  }
}

test('nested summary passes stdin through raw with a banner and no server contact', async () => {
  const result = await runGuardedCli(
    ['summary', '--question', 'did it pass?'],
    'raw build output line 1\nraw build output line 2',
  );
  assert.equal(result.code, 0);
  assert.match(result.stdout, /nested in agent run run-guard-1/);
  assert.match(result.stdout, /raw build output line 1\nraw build output line 2/);
});

test('nested summary still requires input', async () => {
  const result = await runGuardedCli(['summary', '--question', 'did it pass?']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /stdin, --text or --file required/);
});

test('nested summary with positional input does not reinterpret command words', async () => {
  const result = await runGuardedCli(
    ['summary', 'run'],
    'raw summary input line 1\nraw summary input line 2',
  );
  assert.equal(result.code, 0);
  assert.match(result.stdout, /nested in agent run run-guard-1/);
  assert.match(result.stdout, /raw summary input line 1\nraw summary input line 2/);
});

for (const argv of [
  ['repo-search', '--prompt', 'find things'],
  ['repo-agent', '--prompt', 'do things'],
  ['run', 'echo hi'],
  ['eval'],
]) {
  test(`nested ${argv[0]} fails fast with a deadlock explanation`, async () => {
    const result = await runGuardedCli(argv);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /blocked inside agent run run-guard-1/);
    assert.match(result.stderr, /deadlock/);
  });
}

test('nested eval with explicit model token is rejected with lock deadlock error', async () => {
  const result = await runGuardedCliWithProcessStderr(['eval', '--model', 'mock-model']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /blocked inside agent run run-guard-1/);
  assert.match(result.stderr, /deadlock/);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.processStderr, /http_client\b/);
});

test('nested non-model blocked command still returns not-exposed error', async () => {
  const result = await runGuardedCli(['install']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /not exposed in this CLI build/u);
});

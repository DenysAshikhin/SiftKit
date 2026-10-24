import test from 'node:test';
import assert from 'node:assert/strict';

import { runCli } from '../src/cli/index.ts';
import { AGENT_RUN_ID_ENV, AGENT_SERVER_URL_ENV } from '../src/lib/agent-run-marker.ts';
import { makeCaptureStream } from './_test-helpers.ts';

const GUARDED_SERVER_URL = 'http://127.0.0.1:9/status';

async function runGuardedCli(argv: string[], stdinText?: string, markerServerUrl: string | null = GUARDED_SERVER_URL): Promise<{ code: number; stdout: string; stderr: string }> {
  const previous = process.env[AGENT_RUN_ID_ENV];
  const previousServer = process.env[AGENT_SERVER_URL_ENV];
  const previousBackend = process.env.SIFTKIT_STATUS_BACKEND_URL;
  const previousConfig = process.env.SIFTKIT_CONFIG_SERVICE_URL;
  process.env[AGENT_RUN_ID_ENV] = 'run-guard-1';
  if (markerServerUrl === null) delete process.env[AGENT_SERVER_URL_ENV];
  else process.env[AGENT_SERVER_URL_ENV] = markerServerUrl;
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
    if (previousServer === undefined) {
      delete process.env[AGENT_SERVER_URL_ENV];
    } else {
      process.env[AGENT_SERVER_URL_ENV] = previousServer;
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
  assert.match(result.stderr, /stdin, --text, --file or --image required/);
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
  const result = await runGuardedCli(['eval', '--model', 'mock-model']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /blocked inside agent run run-guard-1/);
  assert.match(result.stderr, /deadlock/);
  assert.equal(result.stdout, '');
});

test('nested non-model blocked command still returns not-exposed error', async () => {
  const result = await runGuardedCli(['install']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /not exposed in this CLI build/u);
});

test('a marker from another status server does not block the CLI aimed at this one', async () => {
  const result = await runGuardedCli(['repo-search', '--prompt', 'find things'], undefined, 'http://127.0.0.1:65000/status');
  assert.doesNotMatch(result.stderr, /blocked inside agent run/u);
});

test('a run marker without its server fails loudly instead of guessing', async () => {
  const result = await runGuardedCli(['repo-search', '--prompt', 'find things'], undefined, null);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /SIFTKIT_AGENT_SERVER_URL/u);
});

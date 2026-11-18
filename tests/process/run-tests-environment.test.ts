import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { spawnDirectCommand } from '../../src/lib/command-spawn.ts';
import { toStringRecord } from '../../src/lib/captured-command.ts';
import { AGENT_RUN_ID_ENV, AGENT_SERVER_URL_ENV } from '../../src/lib/agent-run-marker.ts';

// An agent's shell carries the nested-run marker, which makes the CLI refuse server calls; a test of that CLI
// must behave the same whether a person or an agent started the suite.
test('the test runner strips the nested-run marker an agent shell carries', async () => {
  const env = toStringRecord(process.env);
  delete env.NODE_TEST_CONTEXT;
  const result = await spawnDirectCommand(
    process.execPath,
    [path.join('src', 'test-runner', 'run-tests.ts'), path.join('tests', 'fixtures', 'no-agent-run-marker.test.ts')],
    {
      cwd: process.cwd(),
      timeoutMs: 60_000,
      env: { ...env, [AGENT_RUN_ID_ENV]: 'agent-run-1', [AGENT_SERVER_URL_ENV]: 'http://127.0.0.1:4765' },
    },
  );
  assert.equal(result.exitCode, 0, result.output);
});

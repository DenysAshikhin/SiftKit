import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { spawnDirectCommand } from '../src/lib/command-spawn.js';
import { TIMEOUT_EXIT_CODE, toStringRecord } from '../src/lib/captured-command.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { waitForGrandchildPidFile, waitForProcessExit } from './helpers/process-tree-fixture.js';

const repoRoot = process.cwd();
const RUN_BUDGET_MS = 500;
// Only reached if the runner never bounds itself; the elapsed assertion fails long before this.
const HARD_LIMIT_MS = 10_000;

// --test-timeout fails a hung test but cannot bound the run around it, so the budget is enforced
// from outside, by killing the tree. Killing only the runner would strand its descendants.
test('the test runner ends a run that exceeds its budget and reaps its descendants', { timeout: HARD_LIMIT_MS * 2 }, async () => {
  const grandchildPidPath = path.join(createManagedTempDir('run-tests-watchdog-'), 'grandchild.pid');
  // node:test refuses to run files when it detects it is already inside a test process, so the
  // nested runner must not inherit that marker.
  const childEnv = toStringRecord(process.env);
  delete childEnv.NODE_TEST_CONTEXT;
  const startedAt = Date.now();
  const resultPromise = spawnDirectCommand(
    process.execPath,
    [path.join('dist', 'scripts', 'run-tests.js'), path.join('tests', 'fixtures', 'hangs-forever.test.ts')],
    {
      cwd: repoRoot,
      timeoutMs: HARD_LIMIT_MS,
      env: {
        ...childEnv,
        SIFTKIT_TEST_RUN_BUDGET_MS: String(RUN_BUDGET_MS),
        SIFTKIT_WATCHDOG_GRANDCHILD_PID_PATH: grandchildPidPath,
      },
    },
  );
  const grandchildPid = await waitForGrandchildPidFile(grandchildPidPath);
  const result = await resultPromise;
  const elapsedMs = Date.now() - startedAt;

  assert.match(result.output, /Test run exceeded/u);
  // spawnDirectCommand reports the same code for its own HARD_LIMIT_MS kill, so the exit code
  // alone cannot say which timeout fired; the elapsed assertion below is what separates them.
  assert.equal(result.exitCode, TIMEOUT_EXIT_CODE);
  assert.ok(
    elapsedMs < HARD_LIMIT_MS / 2,
    `the runner did not bound itself; it ran for ${elapsedMs}ms`,
  );

  await waitForProcessExit(grandchildPid);
});

// setTimeout coerces NaN to zero, so an unparseable budget would arm the watchdog for right now:
// the run dies before it starts and reports a hang that never happened.
test('an unparseable budget override falls back to the default instead of firing at once', async () => {
  const childEnv = toStringRecord(process.env);
  delete childEnv.NODE_TEST_CONTEXT;
  const result = await spawnDirectCommand(
    process.execPath,
    [path.join('dist', 'scripts', 'run-tests.js'), path.join('tests', 'fixtures', 'settles-immediately.test.ts')],
    {
      cwd: repoRoot,
      timeoutMs: HARD_LIMIT_MS,
      env: { ...childEnv, SIFTKIT_TEST_RUN_BUDGET_MS: 'not-a-number' },
    },
  );

  assert.doesNotMatch(result.output, /Test run exceeded/u);
  assert.equal(result.exitCode, 0);
});

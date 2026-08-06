import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { spawnDirectCommand } from '../src/lib/command-spawn.js';
import { TIMEOUT_EXIT_CODE, toStringRecord } from '../src/lib/captured-command.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const repoRoot = path.resolve(__dirname, '..');
const RUN_BUDGET_MS = 8_000;
// Later than the budget and earlier than node:test's own 30s per-test timeout, so the marker
// separates the two: only a run the watchdog ended stops before the descendant can write it.
const MARKER_DELAY_MS = 14_000;
const MARKER_SETTLE_MS = 3_000;
// Only reached if the runner never bounds itself; the elapsed assertion fails long before this.
const HARD_LIMIT_MS = 60_000;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// --test-timeout fails a hung test but cannot bound the run around it, so the budget is enforced
// from outside, by killing the tree. Killing only the runner would strand its descendants.
test('the test runner ends a run that exceeds its budget and reaps its descendants', { timeout: HARD_LIMIT_MS * 2 }, async () => {
  const markerPath = path.join(createManagedTempDir('run-tests-watchdog-'), 'descendant-survived.txt');
  // node:test refuses to run files when it detects it is already inside a test process, so the
  // nested runner must not inherit that marker.
  const childEnv = toStringRecord(process.env);
  delete childEnv.NODE_TEST_CONTEXT;
  const startedAt = Date.now();
  const result = await spawnDirectCommand(
    process.execPath,
    [path.join('dist', 'scripts', 'run-tests.js'), path.join('tests', 'fixtures', 'hangs-forever.test.ts')],
    {
      cwd: repoRoot,
      timeoutMs: HARD_LIMIT_MS,
      env: {
        ...childEnv,
        SIFTKIT_TEST_RUN_BUDGET_MS: String(RUN_BUDGET_MS),
        SIFTKIT_WATCHDOG_MARKER_PATH: markerPath,
        SIFTKIT_WATCHDOG_MARKER_DELAY_MS: String(MARKER_DELAY_MS),
      },
    },
  );
  const elapsedMs = Date.now() - startedAt;

  assert.match(result.output, /Test run exceeded/u);
  // spawnDirectCommand reports the same code for its own HARD_LIMIT_MS kill, so the exit code
  // alone cannot say which timeout fired; the elapsed assertion below is what separates them.
  assert.equal(result.exitCode, TIMEOUT_EXIT_CODE);
  assert.ok(
    elapsedMs < MARKER_DELAY_MS,
    `the runner did not bound itself; it ran for ${elapsedMs}ms`,
  );

  // Absence proves nothing until the moment the marker would have been written has passed.
  await sleep(MARKER_DELAY_MS + MARKER_SETTLE_MS - (Date.now() - startedAt));
  assert.equal(fs.existsSync(markerPath), false, 'a descendant of the run outlived the kill');
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

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { spawnDirectCommand } from '../src/lib/command-spawn.js';
import { terminateProcessTree } from '../src/lib/process-tree.js';
import { TIMEOUT_EXIT_CODE, toStringRecord } from '../src/lib/captured-command.js';
import { z } from '../src/lib/zod.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import {
  isProcessAlive,
  waitForGrandchildPidFile,
  waitForProcessExit,
} from './helpers/process-tree-fixture.js';

const repoRoot = process.cwd();
const RUN_BUDGET_MS = 500;
// Only reached if the runner never bounds itself; the elapsed assertion fails long before this.
const HARD_LIMIT_MS = 10_000;
const ManagedProcessIdsSchema = z.array(z.coerce.number().int().positive());

function readManagedProcessIds(pidHistoryPath: string): number[] {
  if (!fs.existsSync(pidHistoryPath)) {
    return [];
  }
  const lines = fs.readFileSync(pidHistoryPath, 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0);
  return ManagedProcessIdsSchema.parse(lines);
}

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
    [path.join('dist', 'test-runner', 'run-tests.js'), path.join('tests', 'fixtures', 'hangs-forever.test.ts')],
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
    [path.join('dist', 'test-runner', 'run-tests.js'), path.join('tests', 'fixtures', 'settles-immediately.test.ts')],
    {
      cwd: repoRoot,
      timeoutMs: HARD_LIMIT_MS,
      env: { ...childEnv, SIFTKIT_TEST_RUN_BUDGET_MS: 'not-a-number' },
    },
  );

  assert.doesNotMatch(result.output, /Test run exceeded/u);
  assert.equal(result.exitCode, 0);
});

test('managed llama readiness cleanup releases its worker and every failed launcher process', {
  timeout: HARD_LIMIT_MS * 3,
}, async () => {
  const pidHistoryPath = path.join(createManagedTempDir('managed-llama-pid-history-'), 'pids.txt');
  const childEnv = toStringRecord(process.env);
  delete childEnv.NODE_TEST_CONTEXT;
  childEnv.SIFTKIT_FAKE_MANAGED_PID_HISTORY_PATH = pidHistoryPath;
  const failedTaskkillPreload = `data:text/javascript,${encodeURIComponent([
    "import { createRequire, syncBuiltinESMExports } from 'node:module';",
    "const require = createRequire(process.cwd() + '/package.json');",
    "const childProcess = require('node:child_process');",
    'const originalSpawnSync = childProcess.spawnSync;',
    "childProcess.spawnSync = (file, args, options) => String(file).toLowerCase() === 'taskkill'",
    "  ? { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), pid: 0, signal: null, output: [] }",
    '  : originalSpawnSync(file, args, options);',
    'syncBuiltinESMExports();',
  ].join('\n'))}`;
  childEnv.NODE_OPTIONS = `${childEnv.NODE_OPTIONS ?? ''} --import=${failedTaskkillPreload}`.trim();
  const result = await spawnDirectCommand(
    process.execPath,
    [
      '--test',
      '--test-timeout=30000',
      '--test-concurrency=1',
      '--test-name-pattern=^managed llama readiness wait is serialized by the model request queue$',
      path.join('.test-build', 'tests', 'repo-search-status-server.test.js'),
    ],
    {
      cwd: repoRoot,
      timeoutMs: 15_000,
      env: childEnv,
    },
  );
  const managedProcessIds = readManagedProcessIds(pidHistoryPath);
  const survivingProcessIds = managedProcessIds.filter((pid) => isProcessAlive(pid));

  try {
    assert.equal(result.exitCode, 0, result.output);
    assert.equal(managedProcessIds.length, 3);
    assert.deepEqual(survivingProcessIds, []);
  } finally {
    for (const pid of survivingProcessIds) {
      terminateProcessTree(pid);
    }
  }
});

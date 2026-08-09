import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildNodeTestArgs } from './test-targets.js';
import { assertCurrentTestBuild } from './test-build-state.js';
import { terminateProcessTree } from '../lib/process-tree.js';
import { TIMEOUT_EXIT_CODE } from '../lib/captured-command.js';
import { SIFT_DEFAULT_LLAMA_PORT, SIFT_DEFAULT_STATUS_PORT } from '../config/constants.js';

/**
 * Wall-clock ceiling for the whole run. Exceeding it exits with `TIMEOUT_EXIT_CODE`.
 *
 * `--test-timeout` bounds each test but not the run: node:test cannot cancel the promise of a
 * test it timed out, so a handle that promise still owns keeps the isolation child alive and the
 * runner waits on it forever — a two-minute command once froze a session for 17 minutes this way.
 * `--test-force-exit` looks like the fix and is not: exiting while a handle is mid-close trips a
 * libuv assertion on Windows (`!(handle->flags & UV_HANDLE_CLOSING)`) and aborts the process, so
 * a passing file reports as failed. Killing the tree from outside bounds the run without racing
 * libuv's teardown.
 */
const DEFAULT_RUN_BUDGET_MS = 900_000;

// An unparseable override must not become the budget: setTimeout coerces NaN to zero, so a typo'd
// env var would fire the watchdog before the run began and report a hang that never happened.
function readRunBudgetMs(): number {
  const parsed = Number.parseInt(String(process.env.SIFTKIT_TEST_RUN_BUDGET_MS || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RUN_BUDGET_MS;
}

const RUN_BUDGET_MS = readRunBudgetMs();

const repoRoot = process.cwd();
// The guard does travel in NODE_OPTIONS, because catching a leak from a spawned CLI is
// exactly its job. It is the compiled sibling of this file, so no loader is needed to read
// it, and the URL is absolute so a child in a temp cwd resolves it like one in the repo.
const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const liveInstanceGuardUrl = pathToFileURL(path.resolve(scriptsDirectory, 'live-instance-guard.js')).href;
assertCurrentTestBuild(repoRoot);
const testArgs = buildNodeTestArgs(repoRoot, process.argv.slice(2));
// Node defaults to no per-test timeout, so one test awaiting a server or child process that never
// answers freezes the whole run with no output. A bounded failure is always more useful than a hang.
// buildNodeTestArgs owns that timeout; passing a second --test-timeout here would only shadow it.
const child = spawn(process.execPath, ['--test', ...testArgs], {
  cwd: repoRoot,
  env: {
    ...process.env,
    // The guard preload cannot import this module: it runs inside every process the suite
    // touches, including the production CLIs the tests spawn, so anything it imports is
    // injected into their module graphs. The ports therefore travel to it as env, sourced
    // from the same constants src uses so there is nothing to keep in sync.
    SIFTKIT_GUARD_STATUS_PORT: String(SIFT_DEFAULT_STATUS_PORT),
    SIFTKIT_GUARD_LLAMA_PORT: String(SIFT_DEFAULT_LLAMA_PORT),
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${liveInstanceGuardUrl}`.trim(),
  },
  stdio: 'inherit',
});

let timedOut = false;
const watchdog = setTimeout(() => {
  timedOut = true;
  process.stderr.write(
    `\nTest run exceeded ${RUN_BUDGET_MS}ms and was terminated. `
    + 'A test is holding a handle its timed-out promise still owns; the reporter output above '
    + 'ends at the file that hung.\n',
  );
  // The runner's per-file children are what actually hang, and they outlive a signal aimed at
  // their parent, so the whole tree goes.
  terminateProcessTree(child.pid ?? 0);
}, RUN_BUDGET_MS);
watchdog.unref();

child.on('error', (error) => { throw error; });
child.on('exit', (code) => {
  clearTimeout(watchdog);
  process.exit(timedOut ? TIMEOUT_EXIT_CODE : code ?? 1);
});

import test from 'node:test';
import { spawn } from 'node:child_process';

/**
 * Fixture for tests/run-tests-watchdog.test.ts: a run that outlives any budget those tests set.
 *
 * The test never settles, and it leaves behind a grandchild that inherits the isolation child's
 * stdio — the shape that froze a session for 17 minutes, where terminating only the direct child
 * leaves descendants running. The grandchild writes its marker file well after the budget expires,
 * so the marker is present only if nothing reaped the tree.
 *
 * It lives under tests/fixtures/ because buildNodeTestArgs only collects the top level of tests/,
 * which keeps it out of the real suite.
 */
const markerPath = process.env.SIFTKIT_WATCHDOG_MARKER_PATH;
const markerDelayMs = Number(process.env.SIFTKIT_WATCHDOG_MARKER_DELAY_MS);
if (!markerPath || !Number.isFinite(markerDelayMs)) {
  throw new Error('SIFTKIT_WATCHDOG_MARKER_PATH and SIFTKIT_WATCHDOG_MARKER_DELAY_MS are required');
}

test('never settles, and leaves a descendant only a tree-kill can reap', async () => {
  const grandchild = [
    `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'alive'), ${markerDelayMs});`,
  ].join('\n');
  spawn(process.execPath, ['-e', grandchild], { stdio: 'inherit' });
  await new Promise<never>(() => {});
});

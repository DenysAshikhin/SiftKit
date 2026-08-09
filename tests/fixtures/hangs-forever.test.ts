import test from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

/**
 * Fixture for tests/run-tests-watchdog.test.ts: a run that outlives any budget those tests set.
 *
 * The test never settles, and it leaves behind a grandchild that inherits the isolation child's
 * stdio — the shape that froze a session for 17 minutes, where terminating only the direct child
 * leaves descendants running. The fixture records the grandchild PID so the caller can prove that
 * the watchdog reaped it directly.
 *
 * It lives under tests/fixtures/ because buildNodeTestArgs only collects the top level of tests/,
 * which keeps it out of the real suite.
 */
const grandchildPidPath = process.env.SIFTKIT_WATCHDOG_GRANDCHILD_PID_PATH;
if (!grandchildPidPath) {
  throw new Error('SIFTKIT_WATCHDOG_GRANDCHILD_PID_PATH is required');
}

test('never settles, and leaves a descendant only a tree-kill can reap', async () => {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'inherit' });
  if (grandchild.pid === undefined) {
    throw new Error('Grandchild process did not expose a PID.');
  }
  fs.writeFileSync(grandchildPidPath, String(grandchild.pid), 'utf8');
  await new Promise<never>(() => {});
});

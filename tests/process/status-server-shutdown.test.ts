import test from 'node:test';
import assert from 'node:assert/strict';

import { z } from '../../src/lib/zod.ts';
import { terminateProcessTree } from '../../src/status-server/index.ts';
import { isProcessAlive } from '../../src/lib/process-tree.ts';
import { makeProcessObject, makeSpawnImpl, STALE_PARENT_SNAPSHOT } from '../helpers/process-tree-stubs.ts';

const InvalidPidSchema = z.custom<number>(() => true);

test('terminateProcessTree rejects invalid pid values', async () => {
  assert.equal(await terminateProcessTree(0), false);
  assert.equal(await terminateProcessTree(-1), false);
  assert.equal(await terminateProcessTree(InvalidPidSchema.parse('abc')), false);
});

test('isProcessAlive validates pids and observes the current process', () => {
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(InvalidPidSchema.parse('abc')), false);
  assert.equal(isProcessAlive(process.pid), true);
});

function processThatThrows(code: string): Pick<NodeJS.Process, 'kill'> {
  return {
    kill(): true {
      throw Object.assign(new Error(`kill failed: ${code}`), { code });
    },
  };
}

test('isProcessAlive distinguishes gone, inaccessible, and unexpected process errors', () => {
  assert.equal(isProcessAlive(1234, processThatThrows('ESRCH')), false);
  assert.equal(isProcessAlive(1234, processThatThrows('EPERM')), true);
  assert.throws(() => isProcessAlive(1234, processThatThrows('EIO')), /kill failed: EIO/u);
});

test('terminateProcessTree on Windows kills verified descendants deepest first, then the root, never a stale-parent process', async () => {
  const spawned: { file: string; args: readonly string[] }[] = [];
  const killCalls: { pid: number; signal: string | undefined }[] = [];
  const result = await terminateProcessTree(1234, {
    processObject: makeProcessObject('win32', (pid, signal) => {
      killCalls.push({ pid, signal });
    }),
    spawnImpl: makeSpawnImpl((file, args) => {
      spawned.push({ file, args });
      return { kind: 'exits', stdout: STALE_PARENT_SNAPSHOT, exitCode: 0 };
    }),
  });

  assert.equal(result, true);
  assert.deepEqual(spawned.map((call) => call.file), ['powershell.exe']);
  assert.deepEqual(killCalls, [
    { pid: 1400, signal: 'SIGTERM' },
    { pid: 1300, signal: 'SIGTERM' },
    { pid: 1234, signal: 'SIGTERM' },
  ]);
});

test('terminateProcessTree keeps the event loop responsive while the snapshot runs', async (t) => {
  let ticks = 0;
  const interval = setInterval(() => { ticks += 1; }, 25);
  t.after(() => { clearInterval(interval); });
  const result = await terminateProcessTree(1234, {
    processObject: makeProcessObject('win32', () => true),
    spawnImpl: makeSpawnImpl(() => ({ kind: 'exits', stdout: STALE_PARENT_SNAPSHOT, exitCode: 0, delayMs: 250 })),
  });

  assert.equal(result, true);
  // A synchronous snapshot would have blocked the loop for the whole 250 ms delay.
  assert.ok(ticks >= 2, `the event loop ticked ${ticks} times during the snapshot, expected at least 2`);
});

test('terminateProcessTree on Windows kills only the root when the snapshot exits nonzero', async () => {
  const killCalls: { pid: number; signal: string | undefined }[] = [];
  const result = await terminateProcessTree(2222, {
    processObject: makeProcessObject('win32', (pid, signal) => {
      killCalls.push({ pid, signal });
    }),
    spawnImpl: makeSpawnImpl(() => ({ kind: 'exits', stdout: '', exitCode: 1 })),
  });

  assert.equal(result, true);
  assert.deepEqual(killCalls, [{ pid: 2222, signal: 'SIGTERM' }]);
});

test('terminateProcessTree on Windows kills only the root when the snapshot errors or cannot start', async () => {
  const erroredKillCalls: { pid: number; signal: string | undefined }[] = [];
  const errored = await terminateProcessTree(2222, {
    processObject: makeProcessObject('win32', (pid, signal) => {
      erroredKillCalls.push({ pid, signal });
    }),
    spawnImpl: makeSpawnImpl(() => ({ kind: 'spawn-error' })),
  });

  assert.equal(errored, true);
  assert.deepEqual(erroredKillCalls, [{ pid: 2222, signal: 'SIGTERM' }]);

  const thrownKillCalls: { pid: number; signal: string | undefined }[] = [];
  const thrown = await terminateProcessTree(2222, {
    processObject: makeProcessObject('win32', (pid, signal) => {
      thrownKillCalls.push({ pid, signal });
    }),
    spawnImpl: makeSpawnImpl(() => { throw new Error('the snapshot could not start'); }),
  });

  assert.equal(thrown, true);
  assert.deepEqual(thrownKillCalls, [{ pid: 2222, signal: 'SIGTERM' }]);
});

test('terminateProcessTree uses process.kill on non-Windows platforms', async () => {
  const killCalls: { pid: number; signal: string | undefined }[] = [];
  const result = await terminateProcessTree(3333, {
    processObject: makeProcessObject('linux', (pid, signal) => {
      killCalls.push({ pid, signal });
    }),
    spawnImpl: makeSpawnImpl(() => {
      throw new Error('no process snapshot runs on non-Windows');
    }),
  });

  assert.equal(result, true);
  assert.deepEqual(killCalls, [{ pid: 3333, signal: 'SIGTERM' }]);
});

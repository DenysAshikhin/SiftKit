import test from 'node:test';
import assert from 'node:assert/strict';

import { z } from '../src/lib/zod.ts';
import { terminateProcessTree } from '../src/status-server/index.ts';
import { isProcessAlive } from '../src/lib/process-tree.ts';
import { makeProcessObject, makeSpawnSyncImpl, STALE_PARENT_SNAPSHOT } from './helpers/process-tree-stubs.ts';

const InvalidPidSchema = z.custom<number>(() => true);

test('terminateProcessTree rejects invalid pid values', () => {
  assert.equal(terminateProcessTree(0), false);
  assert.equal(terminateProcessTree(-1), false);
  assert.equal(terminateProcessTree(InvalidPidSchema.parse('abc')), false);
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

test('terminateProcessTree on Windows kills verified descendants deepest first, then the root, never a stale-parent process', () => {
  const spawned: { file: string; args: readonly string[] }[] = [];
  const killCalls: { pid: number; signal: string | undefined }[] = [];
  const result = terminateProcessTree(1234, {
    processObject: makeProcessObject('win32', (pid, signal) => {
      killCalls.push({ pid, signal });
    }),
    spawnSyncImpl: makeSpawnSyncImpl((file, args) => {
      spawned.push({ file, args });
      return { status: 0, stdout: STALE_PARENT_SNAPSHOT };
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

test('terminateProcessTree on Windows kills only the root when the process snapshot fails', () => {
  const killCalls: { pid: number; signal: string | undefined }[] = [];
  const result = terminateProcessTree(2222, {
    processObject: makeProcessObject('win32', (pid, signal) => {
      killCalls.push({ pid, signal });
    }),
    spawnSyncImpl: makeSpawnSyncImpl(() => ({ status: 1, stdout: Buffer.from('') })),
  });

  assert.equal(result, true);
  assert.deepEqual(killCalls, [{ pid: 2222, signal: 'SIGTERM' }]);
});

test('terminateProcessTree uses process.kill on non-Windows platforms', () => {
  const killCalls: { pid: number; signal: string | undefined }[] = [];
  const result = terminateProcessTree(3333, {
    processObject: makeProcessObject('linux', (pid, signal) => {
      killCalls.push({ pid, signal });
    }),
    spawnSyncImpl: makeSpawnSyncImpl(() => {
      throw new Error('no process snapshot runs on non-Windows');
    }),
  });

  assert.equal(result, true);
  assert.deepEqual(killCalls, [{ pid: 3333, signal: 'SIGTERM' }]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import type { SpawnSyncReturns } from 'node:child_process';

import { terminateProcessTree, type TerminateProcessTreeOptions } from '../dist/status-server/index.js';

type SpawnSyncImpl = TerminateProcessTreeOptions['spawnSyncImpl'];
type ProcessObject = TerminateProcessTreeOptions['processObject'];

function makeSpawnSyncImpl(handler: (file: string, args: readonly string[]) => { status: number }): SpawnSyncImpl {
  const impl = ((file: string, args?: readonly string[]) => {
    const result = handler(file, args || []);
    return result as unknown as SpawnSyncReturns<Buffer>;
  }) as unknown as SpawnSyncImpl;
  return impl;
}

function makeProcessObject(platform: string, killFn: (pid: number, signal?: string) => void): ProcessObject {
  return {
    platform,
    kill(pid: number, signal?: string): boolean {
      killFn(pid, signal);
      return true;
    },
  };
}

test('terminateProcessTree rejects invalid pid values', () => {
  assert.equal(terminateProcessTree(0), false);
  assert.equal(terminateProcessTree(-1), false);
  assert.equal(terminateProcessTree('abc' as unknown as number), false);
});

test('terminateProcessTree uses taskkill on Windows and returns true on success', () => {
  const calls: { file: string; args: readonly string[] }[] = [];
  const result = terminateProcessTree(1234, {
    processObject: makeProcessObject('win32', () => {
      throw new Error('kill should not be called when taskkill succeeds');
    }),
    spawnSyncImpl: makeSpawnSyncImpl((file, args) => {
      calls.push({ file, args });
      return { status: 0 };
    }),
  });

  assert.equal(result, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'taskkill');
  assert.deepEqual(calls[0].args, ['/PID', '1234', '/T', '/F']);
});

test('terminateProcessTree falls back to process.kill when taskkill fails', () => {
  const killCalls: { pid: number; signal: string | undefined }[] = [];
  const result = terminateProcessTree(2222, {
    processObject: makeProcessObject('win32', (pid, signal) => {
      killCalls.push({ pid, signal });
    }),
    spawnSyncImpl: makeSpawnSyncImpl(() => ({ status: 1 })),
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
      throw new Error('taskkill should not run on non-Windows');
    }),
  });

  assert.equal(result, true);
  assert.deepEqual(killCalls, [{ pid: 3333, signal: 'SIGTERM' }]);
});

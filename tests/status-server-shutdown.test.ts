import test from 'node:test';
import assert from 'node:assert/strict';
import type { SpawnSyncReturns } from 'node:child_process';

import { z } from '../src/lib/zod.js';
import { terminateProcessTree, type TerminateProcessTreeOptions } from '../src/status-server/index.js';

type SpawnSyncImpl = TerminateProcessTreeOptions['spawnSyncImpl'];
type ProcessObject = TerminateProcessTreeOptions['processObject'];

// terminateProcessTree reads only `.status` off the spawnSync result and invokes
// the impl as a plain function; minimal runtime stubs are branded to the wire
// types at this single boundary.
const SpawnSyncImplSchema = z.custom<SpawnSyncImpl>((value) => typeof value === 'function');
const SpawnSyncReturnsSchema = z.custom<SpawnSyncReturns<Buffer>>((value) => typeof value === 'object' && value !== null);
const InvalidPidSchema = z.custom<number>(() => true);

function makeSpawnSyncImpl(handler: (file: string, args: readonly string[]) => { status: number }): SpawnSyncImpl {
  return SpawnSyncImplSchema.parse((file: string, args?: readonly string[]) =>
    SpawnSyncReturnsSchema.parse(handler(file, args || [])));
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
  assert.equal(terminateProcessTree(InvalidPidSchema.parse('abc')), false);
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

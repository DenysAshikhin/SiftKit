import type { SpawnSyncReturns } from 'node:child_process';

import { z } from '../../src/lib/zod.ts';
import type { TerminateProcessTreeOptions } from '../../src/lib/process-tree.ts';

type SpawnSyncImpl = TerminateProcessTreeOptions['spawnSyncImpl'];
type ProcessObject = TerminateProcessTreeOptions['processObject'];

// terminateProcessTree reads only `.status` and `.stdout` off the spawnSync result and invokes
// the impl as a plain function; minimal runtime stubs are branded to the wire types at this boundary.
const SpawnSyncImplSchema = z.custom<SpawnSyncImpl>((value) => typeof value === 'function');
const SpawnSyncReturnsSchema = z.custom<SpawnSyncReturns<Buffer>>((value) => typeof value === 'object' && value !== null);

export function makeSpawnSyncImpl(handler: (file: string, args: readonly string[]) => { status: number; stdout: Buffer }): SpawnSyncImpl {
  return SpawnSyncImplSchema.parse((file: string, args?: readonly string[]) =>
    SpawnSyncReturnsSchema.parse(handler(file, args || [])));
}

export function makeProcessObject(platform: string, killFn: (pid: number, signal?: string) => void): ProcessObject {
  return {
    platform,
    kill(pid: number, signal?: string): boolean {
      killFn(pid, signal);
      return true;
    },
  };
}

/** A Toolhelp snapshot as JSON: root 1234 with child 1300, plus 900, a stale child of an earlier 1234. */
export const STALE_PARENT_SNAPSHOT = Buffer.from(JSON.stringify([
  { ProcessId: 1234, ParentProcessId: 1, CreatedMs: 1_000 },
  { ProcessId: 1300, ParentProcessId: 1234, CreatedMs: 1_100 },
  { ProcessId: 1400, ParentProcessId: 1300, CreatedMs: 1_200 },
  { ProcessId: 900, ParentProcessId: 1234, CreatedMs: 10 },
]));

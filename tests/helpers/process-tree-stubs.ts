import { spawn } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';

import type { SnapshotSpawn, TerminateProcessTreeOptions } from '../../src/lib/process-tree.ts';

type ProcessObject = TerminateProcessTreeOptions['processObject'];

/** What the real snapshot child does: print `stdout` after `delayMs` and exit, or fail to spawn at all. */
export type SpawnStubOutcome =
  | { readonly kind: 'exits'; readonly stdout: string; readonly exitCode: number; readonly delayMs?: number }
  | { readonly kind: 'spawn-error' };

/** Spawns a real node child per call, so the snapshot code reads a genuine ChildProcess. */
export function makeSpawnImpl(handler: (file: string, args: readonly string[]) => SpawnStubOutcome): SnapshotSpawn {
  return (file, args, options) => {
    const outcome = handler(file, args);
    if (outcome.kind === 'spawn-error') return spawn(path.join(tmpdir(), 'siftkit-missing-snapshot-exe.exe'), [], options);
    const script = `setTimeout(() => { process.stdout.write(${JSON.stringify(outcome.stdout)}); process.exitCode = ${outcome.exitCode}; }, ${outcome.delayMs ?? 0});`;
    return spawn(process.execPath, ['-e', script], options);
  };
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
export const STALE_PARENT_SNAPSHOT = JSON.stringify([
  { ProcessId: 1234, ParentProcessId: 1, CreatedMs: 1_000 },
  { ProcessId: 1300, ParentProcessId: 1234, CreatedMs: 1_100 },
  { ProcessId: 1400, ParentProcessId: 1300, CreatedMs: 1_200 },
  { ProcessId: 900, ParentProcessId: 1234, CreatedMs: 10 },
]);
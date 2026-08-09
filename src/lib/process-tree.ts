/**
 * Whole-tree process termination.
 *
 * `child.kill()` signals only the process it was given. On Windows that leaves every descendant
 * running, and descendants that inherited the parent's stdio keep those pipes open, so a caller
 * capturing output waits forever on a `'close'` that cannot arrive. Killing the tree is the only
 * termination that actually ends a command.
 */
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';

export type TerminateProcessTreeOptions = {
  processObject?: { platform: string; kill: (pid: number, signal?: string) => boolean };
  spawnSyncImpl?: typeof spawnSync;
};

export function isProcessAlive(pid: number | string): boolean {
  const numericPid = Number(pid);
  if (!Number.isFinite(numericPid) || numericPid <= 0) {
    return false;
  }
  try {
    process.kill(Math.trunc(numericPid), 0);
    return true;
  } catch {
    return false;
  }
}

export function terminateProcessTree(pid: number | string, options: TerminateProcessTreeOptions = {}): boolean {
  const processObject = options.processObject || process;
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const numericPid = Number(pid);
  if (!Number.isFinite(numericPid) || numericPid <= 0) {
    return false;
  }
  if (processObject.platform === 'win32') {
    try {
      const result: SpawnSyncReturns<Buffer> = spawnSyncImpl('taskkill', ['/PID', String(Math.trunc(numericPid)), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      if ((result?.status ?? 1) === 0) {
        return true;
      }
    } catch {
      // Fall back to process.kill below.
    }
  }
  try {
    processObject.kill(Math.trunc(numericPid), 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

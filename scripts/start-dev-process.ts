import { spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

import { SHUTDOWN_FORCED_EXIT_TIMEOUT_MS } from '../src/status-server/shutdown-budget.ts';
import { SHUTDOWN_MESSAGE } from '../src/status-server/shutdown-message.ts';

/** The server's own forced-exit watchdog fires first; the tree kill is only the last resort. */
export const DEV_CHILD_STOP_TIMEOUT_MS = SHUTDOWN_FORCED_EXIT_TIMEOUT_MS + 5_000;

type KillableChild = {
  pid?: number;
  killed?: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
};

type StopChildProcessTreeOptions = {
  platform?: NodeJS.Platform;
  // Only the taskkill invocation's `.status` is read, so accept any spawnSync-shaped impl
  // (the real spawnSync and narrow test stubs both satisfy this).
  spawnSync?: (command: string, args: string[], options: { stdio: 'ignore'; windowsHide: boolean }) => { status: number | null };
};

export function stopChildProcessTree(
  child: KillableChild | null,
  options: StopChildProcessTreeOptions = {},
): boolean {
  if (!child || child.killed) {
    return false;
  }
  const platform = options.platform || process.platform;
  const spawnSyncImpl = options.spawnSync || spawnSync;
  if (platform === 'win32' && Number.isFinite(Number(child.pid)) && Number(child.pid) > 0) {
    try {
      const result = spawnSyncImpl('taskkill', ['/PID', String(Math.trunc(Number(child.pid))), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      if ((result.status ?? 1) === 0) {
        return true;
      }
    } catch {
      // Fall back to direct signal below.
    }
  }
  try {
    return child.kill('SIGINT');
  } catch {
    return false;
  }
}

/** Waits for a child that is already shutting down, tree-killing it if it outlives `timeoutMs`. */
export async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const fallback = setTimeout(() => { stopChildProcessTree(child); }, timeoutMs);
  await exited;
  clearTimeout(fallback);
}

/** Asks an IPC child to run its graceful shutdown, then waits for it to exit. */
export async function stopChildGracefully(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.connected) child.send(SHUTDOWN_MESSAGE);
  await waitForChildExit(child, timeoutMs);
}

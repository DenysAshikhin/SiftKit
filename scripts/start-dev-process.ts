import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';

import { raiseProcessTreePriority } from '../src/lib/process-priority.ts';
import { terminateProcessTree, type TerminateProcessTreeOptions } from '../src/lib/process-tree.ts';
import { SHUTDOWN_FORCED_EXIT_TIMEOUT_MS } from '../src/status-server/shutdown-budget.ts';
import { SHUTDOWN_MESSAGE } from '../src/status-server/shutdown-message.ts';

/** The server's own forced-exit watchdog fires first; the tree kill is only the last resort. */
const DEV_CHILD_STOP_TIMEOUT_MS = SHUTDOWN_FORCED_EXIT_TIMEOUT_MS + 5_000;

type KillableChild = {
  pid?: number;
  killed?: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
};

/** Raises a started child and the processes it started so far to High, reporting what it could not raise. */
export async function raiseChildTreePriority(child: ChildProcess, name: string): Promise<void> {
  if (child.pid === undefined) return;
  const problem = await raiseProcessTreePriority(child.pid);
  if (problem !== null) process.stderr.write(`[start-dev] ${name}: ${problem}\n`);
}

/** Windows kills the child's verified process tree; elsewhere the child gets SIGINT and stops its own. */
export async function stopChildProcessTree(
  child: KillableChild | null,
  options: TerminateProcessTreeOptions = {},
): Promise<boolean> {
  if (!child || child.killed) {
    return false;
  }
  if ((options.processObject ?? process).platform === 'win32' && child.pid !== undefined) {
    return await terminateProcessTree(child.pid, options);
  }
  try {
    return child.kill('SIGINT');
  } catch {
    return false;
  }
}

/**
 * Stops an IPC status-server child and waits for it to exit, tree-killing it only past the shutdown budget.
 * A console Ctrl-C (SIGINT) already reached it, so only another stop is asked for over IPC.
 */
export async function stopStatusChild(child: ChildProcess, signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  if (signal === 'SIGTERM' && child.connected) child.send(SHUTDOWN_MESSAGE);
  const fallback = setTimeout(() => { void stopChildProcessTree(child); }, DEV_CHILD_STOP_TIMEOUT_MS);
  await exited;
  clearTimeout(fallback);
}

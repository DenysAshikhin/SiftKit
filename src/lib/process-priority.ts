// High priority for SiftKit and its engines: Windows starts every child at Normal, so trees are swept.
// High, not Realtime: Realtime needs elevation; other platforms need privileges, so they are left alone.
import os from 'node:os';

import { listWindowsDescendantPids } from './process-tree.ts';

const HIGH = os.constants.priority.PRIORITY_HIGH;

export function raiseOwnPriority(): void {
  if (process.platform === 'win32') os.setPriority(HIGH);
}

/** Raises `rootPid` and its live descendants; returns what could not be raised, or null when all were. */
export function raiseProcessTreePriority(rootPid: number): string | null {
  if (process.platform !== 'win32') return null;
  const descendants = listWindowsDescendantPids(rootPid);
  const failed = [rootPid, ...(descendants ?? [])].filter((pid) => {
    try {
      os.setPriority(pid, HIGH);
      return false;
    } catch {
      return true;
    }
  });
  const problems = [
    ...(descendants === null ? [`the processes started by ${rootPid} could not be listed`] : []),
    ...(failed.length > 0 ? [`processes ${failed.join(', ')} could not be raised`] : []),
  ];
  return problems.length > 0 ? `Could not raise every process to High priority: ${problems.join('; ')}.` : null;
}

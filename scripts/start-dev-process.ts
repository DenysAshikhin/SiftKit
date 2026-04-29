import { spawnSync } from 'node:child_process';

type KillableChild = {
  pid?: number;
  killed?: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
};

type StopChildProcessTreeOptions = {
  platform?: NodeJS.Platform;
  spawnSync?: typeof spawnSync;
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

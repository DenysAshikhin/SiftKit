/**
 * Whole-tree process termination.
 *
 * `child.kill()` signals only the process it was given. On Windows that leaves every descendant
 * running, and descendants that inherited the parent's stdio keep those pipes open, so a caller
 * capturing output waits forever on a `'close'` that cannot arrive. Killing the tree is the only
 * termination that actually ends a command.
 *
 * `taskkill /T /F` is the primary Windows path. When it is denied, a bounded Toolhelp32 snapshot
 * supplies the descendant graph so every descendant is terminated deepest-first before the root.
 */
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { parseJsonValueText } from './json.js';
import { z } from './zod.js';

const ProcessErrorSchema = z.object({ code: z.string() });

const WindowsProcessEntrySchema = z.object({
  ProcessId: z.number().int().positive(),
  ParentProcessId: z.number().int().nonnegative(),
});
const WindowsProcessSnapshotSchema = z.array(WindowsProcessEntrySchema);

export type WindowsProcessEntry = z.infer<typeof WindowsProcessEntrySchema>;

export type TerminateProcessTreeOptions = {
  processObject?: { platform: string; kill: (pid: number, signal?: string) => boolean };
  spawnSyncImpl?: typeof spawnSync;
};

/**
 * Orders the descendants reachable from `rootPid` deepest-first (each child after its own
 * descendants). `rootPid` itself is never included, entries outside the root's descendant graph
 * are never traversed, and the visited set makes parent/child cycles terminate.
 */
export function orderDescendantProcessIds(rootPid: number, entries: readonly WindowsProcessEntry[]): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const entry of entries) {
    const children = childrenByParent.get(entry.ParentProcessId) ?? [];
    children.push(entry.ProcessId);
    childrenByParent.set(entry.ParentProcessId, children);
  }
  const ordered: number[] = [];
  const visited = new Set<number>([rootPid]);
  const visit = (pid: number): void => {
    for (const childPid of childrenByParent.get(pid) ?? []) {
      if (!visited.has(childPid)) {
        visited.add(childPid);
        visit(childPid);
        ordered.push(childPid);
      }
    }
  };
  visit(rootPid);
  return ordered;
}

export function isProcessAlive(
  pid: number | string,
  processObject: Pick<NodeJS.Process, 'kill'> = process,
): boolean {
  const numericPid = Number(pid);
  if (!Number.isFinite(numericPid) || numericPid <= 0) {
    return false;
  }
  try {
    processObject.kill(Math.trunc(numericPid), 0);
    return true;
  } catch (error) {
    const parsedError = ProcessErrorSchema.safeParse(error);
    if (parsedError.success && parsedError.data.code === 'ESRCH') {
      return false;
    }
    if (parsedError.success && parsedError.data.code === 'EPERM') {
      return true;
    }
    throw error;
  }
}

const TOOLHELP_SNAPSHOT_TIMEOUT_MS = 5_000;

/**
 * Bounded Toolhelp32 snapshot helper: enumerates every process as `{ ProcessId, ParentProcessId }`
 * and emits the list as a compact JSON array. It performs no termination itself.
 */
const TOOLHELP_SNAPSHOT_COMMAND = `$toolhelpSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class SiftKitProcessSnapshot
{
    private const uint TH32CS_SNAPPROCESS = 2;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32W
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32FirstW(IntPtr hSnapshot, ref PROCESSENTRY32W lppe);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32NextW(IntPtr hSnapshot, ref PROCESSENTRY32W lppe);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr hObject);

    public static List<KeyValuePair<uint, uint>> EnumerateProcesses()
    {
        var processes = new List<KeyValuePair<uint, uint>>();
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == new IntPtr(-1))
        {
            return processes;
        }
        try
        {
            var entry = new PROCESSENTRY32W();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
            if (Process32FirstW(snapshot, ref entry))
            {
                do
                {
                    processes.Add(new KeyValuePair<uint, uint>(entry.th32ProcessID, entry.th32ParentProcessID));
                }
                while (Process32NextW(snapshot, ref entry));
            }
        }
        finally
        {
            CloseHandle(snapshot);
        }
        return processes;
    }
}
'@
Add-Type -TypeDefinition $toolhelpSource -Language CSharp | Out-Null
$processes = [SiftKitProcessSnapshot]::EnumerateProcesses() |
    Where-Object { $_.Key -gt 0 } |
    ForEach-Object { [pscustomobject]@{ ProcessId = [int]$_.Key; ParentProcessId = [int]$_.Value } }
ConvertTo-Json -Compress @($processes)
`;

function snapshotWindowsDescendantPids(rootPid: number, spawnSyncImpl: typeof spawnSync): number[] {
  let result: SpawnSyncReturns<Buffer>;
  try {
    result = spawnSyncImpl(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', TOOLHELP_SNAPSHOT_COMMAND],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: TOOLHELP_SNAPSHOT_TIMEOUT_MS },
    );
  } catch {
    return [];
  }
  if (result.error !== undefined || (result.status ?? 1) !== 0) {
    return [];
  }
  const stdout = result.stdout?.toString('utf8').trim() ?? '';
  if (stdout === '') {
    return [];
  }
  try {
    const snapshot = WindowsProcessSnapshotSchema.safeParse(parseJsonValueText(stdout));
    return snapshot.success ? orderDescendantProcessIds(rootPid, snapshot.data) : [];
  } catch {
    return [];
  }
}

function terminateWindowsFallback(
  rootPid: number,
  processObject: NonNullable<TerminateProcessTreeOptions['processObject']>,
  spawnSyncImpl: typeof spawnSync,
): boolean {
  let terminated = false;
  for (const descendantPid of snapshotWindowsDescendantPids(rootPid, spawnSyncImpl)) {
    try {
      if (processObject.kill(descendantPid, 'SIGTERM')) {
        terminated = true;
      }
    } catch {
      // The descendant already exited; keep terminating the rest of the tree.
    }
  }
  try {
    if (processObject.kill(rootPid, 'SIGTERM')) {
      terminated = true;
    }
  } catch {
    // The root already exited.
  }
  return terminated;
}

export function terminateProcessTree(pid: number | string, options: TerminateProcessTreeOptions = {}): boolean {
  const processObject = options.processObject || process;
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const numericPid = Number(pid);
  if (!Number.isFinite(numericPid) || numericPid <= 0) {
    return false;
  }
  const rootPid = Math.trunc(numericPid);
  if (processObject.platform === 'win32') {
    try {
      const result: SpawnSyncReturns<Buffer> = spawnSyncImpl('taskkill', ['/PID', String(rootPid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      if ((result?.status ?? 1) === 0) {
        return true;
      }
    } catch {
      // taskkill is unavailable; the Toolhelp fallback below still terminates the tree.
    }
    return terminateWindowsFallback(rootPid, processObject, spawnSyncImpl);
  }
  try {
    processObject.kill(rootPid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

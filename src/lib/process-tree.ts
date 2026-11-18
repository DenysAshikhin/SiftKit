/**
 * Whole-tree process termination.
 *
 * `child.kill()` signals only the process it was given. On Windows that leaves every descendant
 * running, and descendants that inherited the parent's stdio keep those pipes open, so a caller
 * capturing output waits forever on a `'close'` that cannot arrive. Killing the tree is the only
 * termination that actually ends a command.
 *
 * On Windows a bounded Toolhelp32 snapshot supplies the descendant graph, and every descendant is
 * terminated deepest-first before the root. Windows never clears a dead parent's id and reuses ids,
 * so a child counts only when it started after its parent; `taskkill /T` skips that check.
 */
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { parseJsonValueText } from './json.ts';
import { z } from './zod.ts';

const ProcessErrorSchema = z.object({ code: z.string() });

const WindowsProcessEntrySchema = z.object({
  ProcessId: z.number().int().positive(),
  ParentProcessId: z.number().int().nonnegative(),
  // Milliseconds since 1601; null when the process cannot be opened to read it.
  CreatedMs: z.number().int().nonnegative().nullable(),
});
const WindowsProcessSnapshotSchema = z.array(WindowsProcessEntrySchema);

export type WindowsProcessEntry = z.infer<typeof WindowsProcessEntrySchema>;

export type TerminateProcessTreeOptions = {
  processObject?: { platform: string; kill: (pid: number, signal?: string) => boolean };
  spawnSyncImpl?: typeof spawnSync;
};

/**
 * Orders the descendants reachable from `rootPid` deepest-first (each child after its own
 * descendants). `rootPid` itself is never included, and a child counts only when both creation
 * times are known and it started no earlier than its parent, which excludes stale parent ids.
 */
export function orderDescendantProcessIds(rootPid: number, entries: readonly WindowsProcessEntry[]): number[] {
  const createdMsByPid = new Map(entries.map((entry) => [entry.ProcessId, entry.CreatedMs]));
  const childrenByParent = new Map<number, WindowsProcessEntry[]>();
  for (const entry of entries) {
    const children = childrenByParent.get(entry.ParentProcessId) ?? [];
    children.push(entry);
    childrenByParent.set(entry.ParentProcessId, children);
  }
  const ordered: number[] = [];
  const visited = new Set<number>([rootPid]);
  const visit = (pid: number): void => {
    const parentCreatedMs = createdMsByPid.get(pid) ?? null;
    if (parentCreatedMs === null) return;
    for (const child of childrenByParent.get(pid) ?? []) {
      if (child.CreatedMs === null || child.CreatedMs < parentCreatedMs || visited.has(child.ProcessId)) continue;
      visited.add(child.ProcessId);
      visit(child.ProcessId);
      ordered.push(child.ProcessId);
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
 * Bounded Toolhelp32 snapshot helper: enumerates every process as `{ ProcessId, ParentProcessId, CreatedMs }`
 * and emits the list as a compact JSON array. It performs no termination itself.
 */
const TOOLHELP_SNAPSHOT_COMMAND = `$toolhelpSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class SiftKitProcessSnapshot
{
    private const uint TH32CS_SNAPPROCESS = 2;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    public sealed class Row
    {
        public uint ProcessId;
        public uint ParentProcessId;
        public long CreatedMs;
    }

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

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessTimes(IntPtr hProcess, out long creation, out long exit, out long kernel, out long user);

    // FILETIME ticks are 100 ns; -1 when the process cannot be opened.
    private static long CreatedMs(uint processId)
    {
        IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
        if (handle == IntPtr.Zero)
        {
            return -1;
        }
        try
        {
            long creation, exit, kernel, user;
            return GetProcessTimes(handle, out creation, out exit, out kernel, out user) ? creation / 10000 : -1;
        }
        finally
        {
            CloseHandle(handle);
        }
    }

    public static List<Row> EnumerateProcesses()
    {
        var processes = new List<Row>();
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
                    processes.Add(new Row { ProcessId = entry.th32ProcessID, ParentProcessId = entry.th32ParentProcessID, CreatedMs = CreatedMs(entry.th32ProcessID) });
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
    Where-Object { $_.ProcessId -gt 0 } |
    ForEach-Object { [pscustomobject]@{ ProcessId = [int]$_.ProcessId; ParentProcessId = [int]$_.ParentProcessId; CreatedMs = $(if ($_.CreatedMs -ge 0) { $_.CreatedMs } else { $null }) } }
ConvertTo-Json -Compress @($processes)
`;

/** The descendants of `rootPid` alive now, deepest first, from one Toolhelp32 snapshot; null when it fails. Windows only. */
export function listWindowsDescendantPids(rootPid: number, spawnSyncImpl: typeof spawnSync = spawnSync): number[] | null {
  let result: SpawnSyncReturns<Buffer>;
  try {
    result = spawnSyncImpl(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', TOOLHELP_SNAPSHOT_COMMAND],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: TOOLHELP_SNAPSHOT_TIMEOUT_MS },
    );
  } catch {
    return null;
  }
  if (result.error !== undefined || (result.status ?? 1) !== 0) {
    return null;
  }
  const stdout = result.stdout?.toString('utf8').trim() ?? '';
  if (stdout === '') {
    return null;
  }
  try {
    const snapshot = WindowsProcessSnapshotSchema.safeParse(parseJsonValueText(stdout));
    return snapshot.success ? orderDescendantProcessIds(rootPid, snapshot.data) : null;
  } catch {
    return null;
  }
}

function terminateWindowsTree(
  rootPid: number,
  processObject: NonNullable<TerminateProcessTreeOptions['processObject']>,
  spawnSyncImpl: typeof spawnSync,
): boolean {
  let terminated = false;
  // Without a snapshot only the root is left to terminate
  for (const pid of [...(listWindowsDescendantPids(rootPid, spawnSyncImpl) ?? []), rootPid]) {
    try {
      if (processObject.kill(pid, 'SIGTERM')) {
        terminated = true;
      }
    } catch {
      // The process already exited; keep terminating the rest of the tree.
    }
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
    return terminateWindowsTree(rootPid, processObject, spawnSyncImpl);
  }
  try {
    processObject.kill(rootPid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

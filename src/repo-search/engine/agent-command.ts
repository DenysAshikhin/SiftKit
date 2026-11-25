/**
 * Every shell command an agent starts: the shell sits in a Windows job object holding its only handle,
 * so the kernel ends whatever is left when it ends.
 */
import { serverLogger } from '../../status-server/server-logger.ts';
import type { OutputPolicy } from '../../lib/bounded-output.ts';
import { CapturedCommand, type CapturedCommandResult } from '../../lib/captured-command.ts';
import { startPowerShell } from '../../lib/powershell.ts';

/** What a command and its descendants may hold together: committed memory, and live processes with the shell itself. */
export type AgentJobLimits = { memoryGib: number; processes: number };
const AGENT_JOB_LIMITS: AgentJobLimits = { memoryGib: 16, processes: 128 };
/** The shell could not contain itself, so the command never ran. */
export const CONTAINMENT_FAILED_EXIT_CODE = 125;
/** Kept of each output stream; the middle of a longer one is dropped. */
const AGENT_OUTPUT: OutputPolicy = { kind: 'window', headBytes: 2 * 1024 * 1024, tailBytes: 6 * 1024 * 1024 };

/** PowerShell that puts the shell running it in a job, or exits 125 before the command runs. */
export function buildJobPrelude(limits: AgentJobLimits): string {
  // 0x2000 KILL_ON_JOB_CLOSE, 0x200 JOB_MEMORY, 0x8 ACTIVE_PROCESS. BREAKAWAY_OK is never set.
  return String.raw`
try {
  Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class SiftKitAgentJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long a, b; public uint LimitFlags; public UIntPtr c, d; public uint ActiveProcessLimit; public UIntPtr e; public uint f, g; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic Basic; public Io Io; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob; }
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Extended info, int length);
  [DllImport("kernel32", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32")] static extern IntPtr GetCurrentProcess();
  public static void Enter(ulong memoryBytes, uint processes) {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception();
    Extended limits = new Extended();
    limits.Basic.LimitFlags = 0x2000 | 0x200 | 0x8;
    limits.Basic.ActiveProcessLimit = processes;
    limits.JobMemory = (UIntPtr)memoryBytes;
    if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(Extended)))) throw new Win32Exception();
    if (!AssignProcessToJobObject(job, GetCurrentProcess())) throw new Win32Exception();
  }
}
'@
  [SiftKitAgentJob]::Enter(${limits.memoryGib}GB, ${limits.processes})
} catch {
  [Console]::Error.WriteLine("Command not run: it could not be contained. $($_.Exception.Message)")
  exit ${CONTAINMENT_FAILED_EXIT_CODE}
}
`;
}

const AGENT_JOB_PRELUDE = buildJobPrelude(AGENT_JOB_LIMITS);

export type AgentCommandOptions = {
  cwd: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  /** Merged over the inherited environment. */
  env?: Record<string, string>;
  stdinData?: string;
};

export function startAgentCommand(command: string, options: AgentCommandOptions): CapturedCommand {
  if (process.platform !== 'win32') throw new Error('Agent commands run only on Windows.');
  const running = startPowerShell(command, {
    ...options, prelude: AGENT_JOB_PRELUDE, outputPolicy: AGENT_OUTPUT, termination: 'process',
  });
  void running.result.then((result) => {
    if (result.pipesClosed) return;
    serverLogger.emitBody('agent', String(running.pid ?? 'unknown'), {
      event: 'agent_command_pipes_open', severity: 'warning',
      fields: 'a process outside the command\'s job still held its output pipes after it ended',
    });
  }, () => undefined);
  return running;
}

const PIPES_OPEN_WARNING = 'Warning: something this command started outside its job is still running and may have kept output.';

export async function runAgentCommand(command: string, options: AgentCommandOptions): Promise<CapturedCommandResult> {
  const result = await startAgentCommand(command, options).result;
  return { ...result, output: reportedOutput(result) };
}

/** A command's output, saying so when something it started may have kept the rest. */
export function reportedOutput(result: CapturedCommandResult): string {
  return result.pipesClosed ? result.output : `${result.output}\n\n${PIPES_OPEN_WARNING}`.trim();
}

/**
 * Shared helpers for spawning PowerShell processes.  All invocations use
 * `-NoProfile -ExecutionPolicy Bypass` to avoid user-profile interference
 * and permit unsigned scripts.
 */

import { spawnSync, type StdioOptions, type SpawnSyncReturns } from 'node:child_process';

import { runCapturedCommand, toStringRecord, type CapturedCommandResult } from './captured-command.js';

export const POWERSHELL_EXECUTABLE = 'powershell.exe';
export const POWERSHELL_BASE_ARGS = ['-NoProfile', '-ExecutionPolicy', 'Bypass'] as const;

// Single source of truth for how the `run` tool's shell is described to callers
// and models. Derived from the executable so the prompt cannot drift from spawn.
export const RUN_SHELL_LABEL = `PowerShell (Windows, ${POWERSHELL_EXECUTABLE})`;

/**
 * Sets native stdout decoding, native stdin encoding, and shim stdin decoding to UTF-8.
 * User source is parsed separately so first-position grammar remains valid and host details
 * never enter requested commands, duplicate fingerprints, or transcripts.
 */
const POWERSHELL_UTF8_PRELUDE =
  '[Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = [Text.UTF8Encoding]::new($false); ';

function buildPowerShellInvocation(command: string, pipeStdin: boolean): string {
  const commandWithExitGuard = `${command}\nif (-not $?) { exit 1 }`;
  const escapedCommand = commandWithExitGuard.replaceAll("'", "''");
  const invokeCommand = `& ([ScriptBlock]::Create('${escapedCommand}'))`;
  return pipeStdin
    ? `${POWERSHELL_UTF8_PRELUDE}[Console]::In.ReadToEnd() | ${invokeCommand}`
    : `${POWERSHELL_UTF8_PRELUDE}${invokeCommand}`;
}

/**
 * Bounds for the `run` tool's timeout, in milliseconds. Both the tool schema shown to models
 * and the argument validation read these, so the advertised limits cannot drift from the
 * enforced ones.
 *
 * The unit lives in every name because it used to not: the argument was `timeout` in seconds,
 * a model passed the millisecond value `120000`, and the run was scheduled to be killed 33
 * hours later. Milliseconds also make the remaining failure mode benign — a seconds value like
 * `120` expires almost immediately and is visible on the next turn, where the reverse mistake
 * hangs silently for a day.
 */
export const DEFAULT_RUN_TIMEOUT_MS = 120_000;
export const MAX_RUN_TIMEOUT_MS = 600_000;

// ---------------------------------------------------------------------------
// Synchronous
// ---------------------------------------------------------------------------

export type PowerShellSyncOptions = {
  cwd?: string;
  encoding?: BufferEncoding;
  stdio?: StdioOptions;
  windowsHide?: boolean;
};

export function spawnPowerShellSync(
  command: string,
  options: PowerShellSyncOptions = {},
): SpawnSyncReturns<string> {
  return spawnSync(
    POWERSHELL_EXECUTABLE,
    [...POWERSHELL_BASE_ARGS, '-Command', buildPowerShellInvocation(command, false)],
    {
      cwd: options.cwd,
      encoding: options.encoding ?? 'utf8',
      stdio: options.stdio,
      windowsHide: options.windowsHide ?? true,
    },
  );
}

// ---------------------------------------------------------------------------
// Asynchronous (captures stdout + stderr)
// ---------------------------------------------------------------------------

export type PowerShellAsyncResult = CapturedCommandResult;

export type PowerShellAsyncOptions = {
  cwd?: string;
  windowsHide?: boolean;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  /** Merged over the inherited environment, unlike `spawnDirectCommand`'s full replacement. */
  env?: Record<string, string>;
  /** Written to the child's stdin and closed; keeps payloads off the command line. */
  stdinData?: string;
};

export function spawnPowerShellAsync(
  command: string,
  options: PowerShellAsyncOptions = {},
): Promise<PowerShellAsyncResult> {
  return runCapturedCommand(
    POWERSHELL_EXECUTABLE,
    [...POWERSHELL_BASE_ARGS, '-Command', buildPowerShellInvocation(command, options.stdinData !== undefined)],
    {
      ...options,
      env: options.env ? { ...toStringRecord(process.env), ...options.env } : undefined,
    },
  );
}

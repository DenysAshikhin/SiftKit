/**
 * Shared helpers for spawning PowerShell processes.  All invocations use
 * `-NoProfile -ExecutionPolicy Bypass` to avoid user-profile interference
 * and permit unsigned scripts.
 */

import { spawn, spawnSync, type StdioOptions, type SpawnSyncReturns } from 'node:child_process';

export const POWERSHELL_EXECUTABLE = 'powershell.exe';
export const POWERSHELL_BASE_ARGS = ['-NoProfile', '-ExecutionPolicy', 'Bypass'] as const;

// Single source of truth for how the `run` tool's shell is described to callers
// and models. Derived from the executable so the prompt cannot drift from spawn.
export const RUN_SHELL_LABEL = `PowerShell (Windows, ${POWERSHELL_EXECUTABLE})`;

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
  return spawnSync(POWERSHELL_EXECUTABLE, [...POWERSHELL_BASE_ARGS, '-Command', command], {
    cwd: options.cwd,
    encoding: options.encoding ?? 'utf8',
    stdio: options.stdio,
    windowsHide: options.windowsHide ?? true,
  });
}

// ---------------------------------------------------------------------------
// Asynchronous (captures stdout + stderr)
// ---------------------------------------------------------------------------

export type PowerShellAsyncResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
};

export type PowerShellAsyncOptions = {
  cwd?: string;
  windowsHide?: boolean;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
};

export function spawnPowerShellAsync(
  command: string,
  options: PowerShellAsyncOptions = {},
): Promise<PowerShellAsyncResult> {
  return new Promise((resolve) => {
    const child = spawn(POWERSHELL_EXECUTABLE, [...POWERSHELL_BASE_ARGS, '-Command', command], {
      cwd: options.cwd,
      windowsHide: options.windowsHide ?? true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let spawnError: (Error & { code?: string }) | null = null;
    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | null = null;

    const abort = (): void => { child.kill(); };
    const cleanup = (): void => {
      options.abortSignal?.removeEventListener('abort', abort);
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    };

    if (options.abortSignal?.aborted) {
      child.kill();
    } else {
      options.abortSignal?.addEventListener('abort', abort, { once: true });
    }
    if (options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, options.timeoutMs);
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error: Error & { code?: string }) => { spawnError = error; });
    child.on('close', (code) => {
      cleanup();
      const outputParts: string[] = [];
      if (timedOut) {
        outputParts.push(`timeout=${options.timeoutMs}ms exceeded; command was killed`);
      }
      if (spawnError) {
        const errorCode = typeof spawnError.code === 'string' ? spawnError.code : 'unknown';
        outputParts.push(`spawn_error=${errorCode} message=${spawnError.message}`);
      }
      const textOutput = `${stdout}${stderr}`.trim();
      if (textOutput) outputParts.push(textOutput);
      resolve({
        exitCode: typeof code === 'number' ? code : (timedOut ? 124 : spawnError ? 126 : 1),
        stdout,
        stderr,
        output: outputParts.join('\n').trim(),
      });
    });
  });
}

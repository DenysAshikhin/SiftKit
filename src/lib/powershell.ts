/**
 * Shared helpers for spawning PowerShell processes.  All invocations use
 * `-NoProfile -ExecutionPolicy Bypass` to avoid user-profile interference
 * and permit unsigned scripts.
 */

import { spawn, spawnSync, type StdioOptions, type SpawnSyncReturns } from 'node:child_process';

export const POWERSHELL_BASE_ARGS = ['-NoProfile', '-ExecutionPolicy', 'Bypass'] as const;

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
  return spawnSync('powershell.exe', [...POWERSHELL_BASE_ARGS, '-Command', command], {
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

export function spawnPowerShellAsync(
  command: string,
  options: { cwd?: string; windowsHide?: boolean } = {},
): Promise<PowerShellAsyncResult> {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', [...POWERSHELL_BASE_ARGS, '-Command', command], {
      cwd: options.cwd,
      windowsHide: options.windowsHide ?? true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let spawnError: (Error & { code?: string }) | null = null;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error: Error & { code?: string }) => { spawnError = error; });
    child.on('close', (code) => {
      const outputParts: string[] = [];
      if (spawnError) {
        const errorCode = typeof spawnError.code === 'string' ? spawnError.code : 'unknown';
        outputParts.push(`spawn_error=${errorCode} message=${spawnError.message}`);
      }
      const textOutput = `${stdout}${stderr}`.trim();
      if (textOutput) outputParts.push(textOutput);
      resolve({
        exitCode: typeof code === 'number' ? code : (spawnError ? 126 : 1),
        stdout,
        stderr,
        output: outputParts.join('\n').trim(),
      });
    });
  });
}

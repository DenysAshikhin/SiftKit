/**
 * The single spawn-and-capture implementation behind every command the agent runs.
 *
 * Two rules make a captured command impossible to hang on:
 *
 * 1. A timeout terminates the whole process tree, not just the direct child. Signalling only the
 *    child leaves descendants alive, and on Windows they keep running indefinitely.
 * 2. Settlement is driven by `'exit'` with a bounded drain window, never by `'close'` alone.
 *    `'close'` waits for the stdio pipes, and a descendant that inherited them holds them open
 *    after the child is gone — which is exactly how a two-minute command froze a run for 17
 *    minutes. The normal path still settles on `'close'`, so complete output is the default.
 */
import { spawn } from 'node:child_process';

import { terminateProcessTree } from './process-tree.js';

export type CapturedCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
};

export type CapturedCommandOptions = {
  cwd?: string;
  windowsHide?: boolean;
  abortSignal?: AbortSignal;
  /** Wall-clock budget. When it elapses the process tree is terminated and `exitCode` is 124. */
  timeoutMs?: number;
  /** The child's entire environment when provided; callers decide whether to merge or replace. */
  env?: Record<string, string>;
  /**
   * Written to the child's stdin, which is then closed. The channel for payloads that must not
   * appear on the command line — secrets are visible in process listings, and argv tops out
   * around 32K characters on Windows.
   */
  stdinData?: string;
};

/** Exit code reported for a command the timeout terminated, matching `timeout(1)`. */
export const TIMEOUT_EXIT_CODE = 124;
/** Exit code reported when the spawn itself failed, matching the shell's "cannot execute". */
const SPAWN_ERROR_EXIT_CODE = 126;
/** Exit code reported when the child produced none of its own. */
const UNKNOWN_EXIT_CODE = 1;

/**
 * Drops the undefined-valued entries `process.env` is typed with.
 *
 * A spawn `env` is a full replacement, so callers that want to inherit have to pass
 * `process.env` through, and its `string | undefined` values do not fit without this.
 */
export function toStringRecord(source: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * How long to wait after `'exit'` for the stdio pipes to close on their own.
 *
 * Long enough that a healthy child's final output always lands, short enough that a descendant
 * holding the pipes open costs seconds instead of forever.
 */
const STDIO_DRAIN_GRACE_MS = 2_000;

export function runCapturedCommand(
  file: string,
  args: string[],
  options: CapturedCommandOptions = {},
): Promise<CapturedCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      windowsHide: options.windowsHide ?? true,
      stdio: [options.stdinData === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: options.env,
    });
    if (options.stdinData !== undefined && child.stdin !== null) {
      // A child that exits without reading breaks the pipe; that must not crash this process.
      child.stdin.on('error', () => undefined);
      child.stdin.end(options.stdinData);
    }

    let stdout = '';
    let stderr = '';
    let spawnError: (Error & { code?: string }) | null = null;
    let timedOut = false;
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | null = null;
    let drainHandle: NodeJS.Timeout | null = null;

    const terminate = (): void => {
      if (typeof child.pid === 'number' && child.pid > 0) {
        terminateProcessTree(child.pid);
        return;
      }
      child.kill();
    };

    const settle = (code: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (drainHandle) clearTimeout(drainHandle);
      options.abortSignal?.removeEventListener('abort', terminate);
      // Nothing further is read, and leaving the pipes attached would keep this process's event
      // loop alive on the very handles the drain window exists to escape.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();

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
        // A timeout reports 124 whatever the kill happened to produce: terminating a tree on
        // Windows yields an ordinary exit code, which would otherwise read as a real result.
        exitCode: timedOut
          ? TIMEOUT_EXIT_CODE
          : typeof code === 'number' ? code : (spawnError ? SPAWN_ERROR_EXIT_CODE : UNKNOWN_EXIT_CODE),
        stdout,
        stderr,
        output: outputParts.join('\n').trim(),
      });
    };

    if (options.abortSignal?.aborted) {
      terminate();
    } else {
      options.abortSignal?.addEventListener('abort', terminate, { once: true });
    }
    if (options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        terminate();
      }, options.timeoutMs);
    }

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error: Error & { code?: string }) => { spawnError = error; });
    child.on('exit', (code) => {
      if (drainHandle === null) {
        drainHandle = setTimeout(() => settle(code), STDIO_DRAIN_GRACE_MS);
        drainHandle.unref();
      }
    });
    child.on('close', (code) => { settle(code); });
  });
}

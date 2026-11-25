/**
 * The single spawn-and-capture implementation behind every command the agent runs.
 *
 * Two rules make a captured command impossible to hang on:
 *
 * 1. A timeout ends everything the command started: the process tree, or, for a command in a job
 *    object, the one process whose end makes the kernel end the rest.
 * 2. Settlement is driven by `'exit'` with a bounded drain window, never by `'close'` alone.
 *    `'close'` waits for the stdio pipes, and a descendant that inherited them holds them open
 *    after the child is gone — which is exactly how a two-minute command froze a run for 17
 *    minutes. The normal path still settles on `'close'`, so complete output is the default.
 */
import { spawn, type ChildProcess } from 'node:child_process';

import { BoundedOutput, type OutputPolicy } from './bounded-output.ts';
import { terminateProcessTree } from './process-tree.ts';

export type CapturedCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
  timedOut: boolean;
  /** False when something the command started still held the output pipes 2 s after it exited. */
  pipesClosed: boolean;
};

/** `tree` walks parent ids; `process` is enough only for a command that contains itself in a job object. */
export type CommandTermination = 'tree' | 'process';

export type CapturedCommandOptions = {
  /** Applied to stdout and to stderr separately. */
  outputPolicy: OutputPolicy;
  termination: CommandTermination;
  cwd?: string;
  windowsHide?: boolean;
  abortSignal?: AbortSignal;
  /** Wall-clock budget. When it elapses the command is terminated and `exitCode` is 124. */
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

/** A running command: its output so far, a way to end it, and the result every ending settles. */
export class CapturedCommand {
  readonly result: Promise<CapturedCommandResult>;
  private readonly child: ChildProcess;
  private readonly options: CapturedCommandOptions;
  private readonly stdout: BoundedOutput;
  private readonly stderr: BoundedOutput;

  constructor(file: string, args: string[], options: CapturedCommandOptions) {
    this.options = options;
    this.stdout = new BoundedOutput(options.outputPolicy);
    this.stderr = new BoundedOutput(options.outputPolicy);
    this.child = spawn(file, args, {
      cwd: options.cwd,
      windowsHide: options.windowsHide ?? true,
      stdio: [options.stdinData === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: options.env,
    });
    if (options.stdinData !== undefined && this.child.stdin !== null) {
      // A child that exits without reading breaks the pipe; that must not crash this process.
      this.child.stdin.on('error', () => undefined);
      this.child.stdin.end(options.stdinData);
    }
    this.result = this.capture();
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Everything kept so far, stdout first; empty once the result has settled. */
  outputSoFar(): string {
    return `${this.stdout.text()}${this.stderr.text()}`;
  }

  terminate(): void {
    const { pid } = this.child;
    if (this.options.termination === 'tree' && typeof pid === 'number' && pid > 0) {
      terminateProcessTree(pid);
      return;
    }
    this.child.kill();
  }

  private capture(): Promise<CapturedCommandResult> {
    const { child, options, stdout, stderr } = this;
    return new Promise((resolve, reject) => {
      let spawnError: (Error & { code?: string }) | null = null;
      let timedOut = false;
      let overLimit = false;
      let settled = false;
      let timeoutHandle: NodeJS.Timeout | null = null;
      let drainHandle: NodeJS.Timeout | null = null;
      const terminate = (): void => { this.terminate(); };

      const settle = (code: number | null, pipesClosed: boolean): void => {
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
        const stdoutText = stdout.text();
        const stderrText = stderr.text();
        stdout.release();
        stderr.release();

        if (overLimit && options.outputPolicy.kind === 'limit') {
          reject(new Error(`Command output passed ${options.outputPolicy.bytes} bytes, so the command was stopped and its output discarded.`));
          return;
        }
        const outputParts: string[] = [];
        if (timedOut) {
          outputParts.push(`timeout=${options.timeoutMs}ms exceeded; command was killed`);
        }
        if (spawnError) {
          const errorCode = typeof spawnError.code === 'string' ? spawnError.code : 'unknown';
          outputParts.push(`spawn_error=${errorCode} message=${spawnError.message}`);
        }
        const textOutput = `${stdoutText}${stderrText}`.trim();
        if (textOutput) outputParts.push(textOutput);
        resolve({
          // A timeout reports 124 whatever the kill happened to produce: terminating a tree on
          // Windows yields an ordinary exit code, which would otherwise read as a real result.
          exitCode: timedOut
            ? TIMEOUT_EXIT_CODE
            : typeof code === 'number' ? code : (spawnError ? SPAWN_ERROR_EXIT_CODE : UNKNOWN_EXIT_CODE),
          stdout: stdoutText,
          stderr: stderrText,
          output: outputParts.join('\n').trim(),
          timedOut,
          pipesClosed,
        });
      };

      const keep = (stream: BoundedOutput, chunk: Buffer): void => {
        if (overLimit) return;
        stream.write(chunk);
        if (options.outputPolicy.kind === 'limit' && stream.dropped > 0) {
          overLimit = true;
          terminate();
        }
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

      child.stdout?.on('data', (chunk: Buffer) => { keep(stdout, chunk); });
      child.stderr?.on('data', (chunk: Buffer) => { keep(stderr, chunk); });
      child.on('error', (error: Error & { code?: string }) => { spawnError = error; });
      child.on('exit', (code) => {
        if (drainHandle === null) {
          drainHandle = setTimeout(() => { settle(code, false); }, STDIO_DRAIN_GRACE_MS);
          drainHandle.unref();
        }
      });
      child.on('close', (code) => { settle(code, true); });
    });
  }
}

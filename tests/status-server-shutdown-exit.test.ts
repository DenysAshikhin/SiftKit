/**
 * Process-level regression for the shutdown exit contract
 * (`docs/shutdown-persistence-bugs-2026-09-15.md` §4): a shutdown whose persistence chain
 * rejected must be reported on stderr and must not leave through exit code 0.
 *
 * The built entrypoint is spawned for real, in a throwaway runtime root, so the whole chain —
 * `main.ts` close callback, `index.ts` shutdown stages, the process exit code — is the shipped one.
 *
 * Windows cannot deliver a POSIX signal to a spawned child: `child.kill('SIGINT')` terminates it
 * without running any listener (verified against this Node version). The harness therefore preloads
 * a two-line bootstrap that turns a stdin line into `process.emit('SIGINT')` — the very event the
 * entrypoint's own SIGINT listener is registered for. Only the delivery mechanism is substituted;
 * the handler, the close callback and the exit code under test are the production ones.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { toError } from '../src/lib/errors.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { isJsonObject } from '../src/lib/json-types.js';
import { findNearestSiftKitRepoRoot, moduleDirname } from '../src/lib/paths.js';
import {
  SHUTDOWN_CLOSE_FLUSH_WAIT_MS,
  SHUTDOWN_FORCED_EXIT_TIMEOUT_MS,
  SHUTDOWN_PERSISTENCE_STAGE_COUNT,
  SHUTDOWN_PERSISTENCE_TIMEOUT_MS,
} from '../src/status-server/shutdown-budget.js';
import { countRunLogs, installRejectingTriggerOnFile, withRuntimeDatabaseConnection } from './helpers/runtime-database-probe.js';
import { createManagedTempDir, removeDirectoryWithRetries } from './helpers/temp-dirs.js';

const READY_TIMEOUT_MS = 20_000;
const EXIT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 25;
/** Long enough that the queued metadata is still queued when shutdown starts. */
const DEFERRED_IDLE_DELAY_MS = 60_000;

const SHUTDOWN_BOOTSTRAP = [
  "const readline = require('node:readline').createInterface({ input: process.stdin });",
  "readline.on('line', (line) => { if (line.trim() === 'shutdown') process.emit('SIGINT'); });",
  "void import(process.env.SIFTKIT_TEST_ENTRYPOINT);",
].join('\n');

function getStatusServerEntrypoint(): string {
  const packageRoot = findNearestSiftKitRepoRoot(moduleDirname(import.meta.url));
  if (packageRoot === null) {
    throw new Error('Unable to locate the SiftKit package root for the status-server entrypoint.');
  }
  return pathToFileURL(path.join(packageRoot, 'dist', 'status-server', 'main.js')).href;
}

async function waitFor(check: () => boolean, timeoutMs: number, description: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description} after ${timeoutMs}ms.`);
    }
    await delay(POLL_INTERVAL_MS);
  }
}

/** One spawned status server: its temp runtime root, its output, and its exit. */
class StatusServerProcess {
  readonly stdoutLines: string[] = [];
  readonly stderrLines: string[] = [];
  private stdoutBuffer = '';
  private port: number | null = null;
  private readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  private constructor(readonly child: ChildProcess, readonly tempRoot: string) {
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk;
      const lines = this.stdoutBuffer.split(/\r?\n/u);
      this.stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        this.stdoutLines.push(line);
        const port = readReadyPort(line);
        if (port !== null) this.port = port;
      }
    });
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/u)) {
        if (line.trim()) this.stderrLines.push(line);
      }
    });
    this.exit = new Promise((resolve) => {
      child.once('exit', (code, signal) => { resolve({ code, signal }); });
    });
  }

  static async start(): Promise<StatusServerProcess> {
    const tempRoot = createManagedTempDir('siftkit-shutdown-exit-');
    // `--` keeps the entrypoint's own flag out of Node's option parser: with `-e`, anything else
    // on the command line is read as a node option.
    const child = spawn(process.execPath, ['-e', SHUTDOWN_BOOTSTRAP, '--', '--disable-managed-engine-startup'], {
      cwd: tempRoot,
      env: {
        ...process.env,
        SIFTKIT_TEST_ENTRYPOINT: getStatusServerEntrypoint(),
        SIFTKIT_STATUS_HOST: '127.0.0.1',
        SIFTKIT_STATUS_PORT: '0',
        SIFTKIT_DISABLE_RUNTIME_HISTORY_PRUNE: '1',
        SIFTKIT_TERMINAL_METADATA_IDLE_DELAY_MS: String(DEFERRED_IDLE_DELAY_MS),
        SIFTKIT_INFERENCE_RUN_FLUSH_IDLE_DELAY_MS: String(DEFERRED_IDLE_DELAY_MS),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const server = new StatusServerProcess(child, tempRoot);
    try {
      await waitFor(() => server.port !== null, READY_TIMEOUT_MS, 'the status server ready line');
    } catch (error) {
      const detail = toError(error).message
        + `\nstdout:\n${server.stdoutLines.join('\n')}`
        + `\nstderr:\n${server.stderrText}`;
      await server.stop();
      throw new Error(detail);
    }
    return server;
  }

  get runtimeDatabasePath(): string {
    return path.join(this.tempRoot, '.siftkit', 'runtime.sqlite');
  }

  get terminalMetadataUrl(): string {
    if (this.port === null) throw new Error('The status server never reported its port.');
    return `http://127.0.0.1:${this.port}/status/terminal-metadata`;
  }

  get stderrText(): string {
    return this.stderrLines.join('\n');
  }

  get stdoutText(): string {
    return this.stdoutLines.join('\n');
  }

  get exitCode(): number | null {
    return this.child.exitCode;
  }

  /** Row count in the child's runtime database, read from this process after it exits. */
  countRunLogs(requestId: string): number {
    return withRuntimeDatabaseConnection(this.runtimeDatabasePath, database => countRunLogs(database, requestId));
  }

  async postTerminalMetadata(requestId: string): Promise<void> {
    const response = await fetch(this.terminalMetadataUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId,
        running: false,
        terminalState: 'completed',
        taskKind: 'summary',
        outputTokens: 4,
      }),
    });
    if (!response.ok) {
      throw new Error(`Terminal metadata post failed with status ${response.status}: ${await response.text()}`);
    }
  }

  requestShutdown(): void {
    this.child.stdin?.write('shutdown\n');
  }

  async waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        this.exit,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Timed out waiting for the status server to exit after ${EXIT_TIMEOUT_MS}ms: ${this.stderrText}`));
          }, EXIT_TIMEOUT_MS);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  /** Best-effort teardown: the child is only still alive when a test failed before its exit. */
  async stop(): Promise<void> {
    if (this.exitCode === null && !this.child.killed) {
      this.child.kill('SIGKILL');
      await Promise.race([this.exit, delay(5_000, undefined, { ref: false })]);
    }
    await removeDirectoryWithRetries(this.tempRoot);
  }
}

function readReadyPort(line: string): number | null {
  try {
    const parsed = parseJsonValueText(line);
    if (!isJsonObject(parsed)) {
      return null;
    }
    return parsed.ok === true && typeof parsed.port === 'number' ? parsed.port : null;
  } catch {
    // Log lines precede and follow the ready line; only the ready JSON matters.
    return null;
  }
}

// §4: the close callback's error is the only thing standing between a lost write and a green exit.
test('a rejected shutdown persistence stage exits non-zero and reports the failure on stderr', async t => {
  const server = await StatusServerProcess.start();
  t.after(async () => { await server.stop(); });

  installRejectingTriggerOnFile(server.runtimeDatabasePath, 'run_logs', 'reject_run_logs', ['INSERT']);
  await server.postTerminalMetadata('shutdown-exit-rejected-write');
  server.requestShutdown();

  const { code } = await server.waitForExit();
  assert.notEqual(code, 0, `shutdown reported success despite a rejected write; stderr:\n${server.stderrText}`);
  assert.match(server.stderrText, /Shutdown failed: reject_run_logs/u, 'the failure reaches stderr with its reason');
  assert.match(server.stdoutText, /terminal_metadata_process_failed/u, 'and is still logged as a process failure');
  assert.doesNotMatch(server.stdoutText, /\bdone\b  task=/u, 'the clean-shutdown line is not reported');
  assert.equal(server.countRunLogs('shutdown-exit-rejected-write'), 0, 'nothing was written');
  assert.equal(
    await removeDirectoryWithRetries(server.tempRoot),
    true,
    'the shutdown chain must release its handles even when a stage rejected',
  );
});

// Budget inversion: the forced-exit watchdog used to fire at 15s while two 10s stages plus the
// close wait can legitimately take 22s, killing a slow-but-successful shutdown with no report.
test('the forced-exit watchdog outlives every shutdown persistence budget', () => {
  assert.ok(
    SHUTDOWN_FORCED_EXIT_TIMEOUT_MS
      > SHUTDOWN_PERSISTENCE_STAGE_COUNT * SHUTDOWN_PERSISTENCE_TIMEOUT_MS + SHUTDOWN_CLOSE_FLUSH_WAIT_MS,
    `forced exit ${SHUTDOWN_FORCED_EXIT_TIMEOUT_MS}ms must exceed the slowest legitimate shutdown`,
  );
});
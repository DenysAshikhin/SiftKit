import { spawn, type ChildProcess, type Serializable } from 'node:child_process';
import { readdirSync, statSync, watch } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { BUSY_QUERY_MESSAGE, BusyReplyMessageSchema, ShutdownMessageSchema } from '../src/status-server/shutdown-message.ts';
import { stopChildProcessTree, stopStatusChild } from './start-dev-process.ts';

export type FileStamp = { mtimeMs: number; size: number };
export type RestarterOptions = { entry: string; args: string[]; roots: string[]; extensions: string[] };

const RESTART_DEBOUNCE_MS = 200;
const IDLE_POLL_MS = 1_000;
const BUSY_REPLY_TIMEOUT_MS = 5_000;

export function readStamp(filePath: string): FileStamp | null {
  const stats = statSync(filePath, { throwIfNoEntry: false });
  return stats?.isFile() ? { mtimeMs: stats.mtimeMs, size: stats.size } : null;
}

/** Windows reports last-access stamps as changes; only new content, a deletion, or a newly written file counts. */
export function isSourceChange(previous: FileStamp | undefined, current: FileStamp | null, watchStartedAtMs: number): boolean {
  if (current === null) return previous !== undefined;
  if (previous === undefined) return current.mtimeMs > watchStartedAtMs;
  return current.mtimeMs !== previous.mtimeMs || current.size !== previous.size;
}

function snapshotSources(roots: string[], extensions: string[]): Map<string, FileStamp> {
  const stamps = new Map<string, FileStamp>();
  for (const root of roots) {
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !extensions.includes(path.extname(entry.name))) continue;
      const filePath = path.join(entry.parentPath, entry.name);
      const stamp = readStamp(filePath);
      if (stamp !== null) stamps.set(filePath, stamp);
    }
  }
  return stamps;
}

/** The live runs `child` reports over IPC; a server that cannot answer (starting, exited, hung) holds nothing up. */
function askBusy(child: ChildProcess): Promise<string[]> {
  if (child.exitCode !== null || child.signalCode !== null || !child.connected) return Promise.resolve([]);
  return new Promise((resolve) => {
    const finish = (busy: string[]): void => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      resolve(busy);
    };
    const onMessage = (message: Serializable): void => {
      const reply = BusyReplyMessageSchema.safeParse(message);
      if (reply.success) finish(reply.data.busy);
    };
    const onExit = (): void => { finish([]); };
    const timer = setTimeout(() => { finish([]); }, BUSY_REPLY_TIMEOUT_MS);
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.send(BUSY_QUERY_MESSAGE, (error) => { if (error) finish([]); });
  });
}

/** Runs `entry`, restarting it after real source edits once it has no live runs; every stop is a graceful IPC shutdown. */
export function superviseWithRestarts(options: RestarterOptions): void {
  const watchStartedAtMs = Date.now();
  let stopping = false;
  let restartInFlight = false;
  let restartQueued = false;
  let restartTimer: NodeJS.Timeout | null = null;
  let lastChanged = '';

  const startChild = (): ChildProcess => {
    const next = spawn(process.execPath, [options.entry, ...options.args], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
    next.on('error', (error) => { process.stderr.write(`[start-dev] Failed to start ${options.entry}: ${error.message}\n`); });
    next.once('exit', (code) => {
      if (!stopping && !restartInFlight) {
        process.stderr.write(`[start-dev] ${path.basename(options.entry)} exited with code ${code ?? 'null'}; it restarts on the next source edit.\n`);
      }
    });
    return next;
  };

  /** Holds a restart while the server reports live runs, announcing the wait once. */
  const waitUntilIdle = async (): Promise<void> => {
    let announced = false;
    for (;;) {
      const busy = stopping ? [] : await askBusy(child);
      if (busy.length === 0) return;
      if (!announced) {
        process.stdout.write(`[start-dev] ${lastChanged} changed; ${path.basename(options.entry)} is busy with ${busy.join(', ')}, `
          + 'so the restart waits until it is idle.\n');
        announced = true;
      }
      await delay(IDLE_POLL_MS);
    }
  };

  const restart = async (): Promise<void> => {
    if (restartInFlight) {
      restartQueued = true;
      return;
    }
    restartInFlight = true;
    do {
      restartQueued = false;
      await waitUntilIdle();
      if (stopping) break;
      process.stdout.write(`[start-dev] ${lastChanged} changed; restarting ${path.basename(options.entry)}.\n`);
      await stopStatusChild(child, 'SIGTERM');
      if (!stopping) child = startChild();
    } while (restartQueued && !stopping);
    restartInFlight = false;
  };

  const onSourceEvent = (root: string, filename: string | null): void => {
    if (filename === null || stopping) return;
    const filePath = path.join(root, filename);
    if (!options.extensions.includes(path.extname(filePath))) return;
    const current = readStamp(filePath);
    const changed = isSourceChange(stamps.get(filePath), current, watchStartedAtMs);
    if (current === null) stamps.delete(filePath);
    else stamps.set(filePath, current);
    if (!changed) return;
    if (restartTimer !== null) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      lastChanged = filename;
      void restart();
    }, RESTART_DEBOUNCE_MS);
  };

  // Watch before the snapshot so no edit falls between them; events queue until the snapshot returns.
  const watchers = options.roots.map((root) => watch(root, { recursive: true }, (_event, filename) => { onSourceEvent(root, filename); }));
  const stamps = snapshotSources(options.roots, options.extensions);
  let child = startChild();

  const stopAll = async (signal: 'SIGINT' | 'SIGTERM'): Promise<void> => {
    stopping = true;
    for (const watcher of watchers) watcher.close();
    if (restartTimer !== null) clearTimeout(restartTimer);
    await stopStatusChild(child, signal);
    process.exit(signal === 'SIGINT' ? 130 : 0);
  };

  process.on('message', (message) => {
    if (ShutdownMessageSchema.safeParse(message).success && !stopping) void stopAll('SIGTERM');
  });
  process.on('SIGTERM', () => { if (!stopping) void stopAll('SIGTERM'); });
  process.on('SIGINT', () => {
    if (!stopping) {
      void stopAll('SIGINT');
      return;
    }
    stopChildProcessTree(child);
    process.exit(130);
  });
}

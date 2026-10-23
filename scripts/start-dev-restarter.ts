import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync, statSync, watch } from 'node:fs';
import path from 'node:path';

import { ShutdownMessageSchema } from '../src/status-server/shutdown-message.ts';
import { stopChildGracefully, stopChildProcessTree, waitForChildExit } from './start-dev-process.ts';

export type FileStamp = { mtimeMs: number; size: number };
export type RestarterOptions = { entry: string; args: string[]; roots: string[]; extensions: string[]; stopTimeoutMs: number };

const RESTART_DEBOUNCE_MS = 200;

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

/** Runs `entry`, restarting it after real source edits; every stop is a graceful IPC shutdown. */
export function superviseWithRestarts(options: RestarterOptions): void {
  const watchStartedAtMs = Date.now();
  let stopping = false;
  let restartInFlight = false;
  let restartQueued = false;
  let restartTimer: NodeJS.Timeout | null = null;

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

  const restart = async (): Promise<void> => {
    if (restartInFlight) {
      restartQueued = true;
      return;
    }
    restartInFlight = true;
    do {
      restartQueued = false;
      await stopChildGracefully(child, options.stopTimeoutMs);
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
      process.stdout.write(`[start-dev] ${filename} changed; restarting ${path.basename(options.entry)}.\n`);
      void restart();
    }, RESTART_DEBOUNCE_MS);
  };

  // Watch before the snapshot so no edit falls between them; events queue until the snapshot returns.
  const watchers = options.roots.map((root) => watch(root, { recursive: true }, (_event, filename) => { onSourceEvent(root, filename); }));
  const stamps = snapshotSources(options.roots, options.extensions);
  let child = startChild();

  // A console Ctrl-C already reached the child, so it is awaited; a launcher's request is forwarded.
  const stopAll = async (forwardShutdown: boolean, exitCode: number): Promise<void> => {
    stopping = true;
    for (const watcher of watchers) watcher.close();
    if (restartTimer !== null) clearTimeout(restartTimer);
    if (forwardShutdown) await stopChildGracefully(child, options.stopTimeoutMs);
    else await waitForChildExit(child, options.stopTimeoutMs);
    process.exit(exitCode);
  };

  process.on('message', (message) => {
    if (ShutdownMessageSchema.safeParse(message).success && !stopping) void stopAll(true, 0);
  });
  process.on('SIGTERM', () => { if (!stopping) void stopAll(true, 0); });
  process.on('SIGINT', () => {
    if (!stopping) {
      void stopAll(false, 130);
      return;
    }
    stopChildProcessTree(child);
    process.exit(130);
  });
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDirectory, getRuntimeRoot } from './config.js';

let activeLock: { lockPath: string; handle: number } | null = null;
let activeLockDepth = 0;

function sleepMs(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function getExecutionLockTimeoutMilliseconds(): number {
  const raw = process.env.SIFTKIT_LOCK_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  return 300_000;
}

export function acquireExecutionLock(): {
  lockPath: string;
  handle: number;
} {
  if (activeLock) {
    activeLockDepth += 1;
    return activeLock;
  }

  const runtimeRoot = getRuntimeRoot();
  const lockPath = path.join(runtimeRoot, 'execution.lock');
  ensureDirectory(path.dirname(lockPath));
  const timeoutMs = getExecutionLockTimeoutMilliseconds();
  const startedAt = Date.now();

  while (true) {
    try {
      const handle = fs.openSync(lockPath, 'wx');
      activeLock = { lockPath, handle };
      activeLockDepth = 1;
      return activeLock;
    } catch (error) {
      const exception = error as NodeJS.ErrnoException;
      if (exception.code !== 'EEXIST') {
        throw error;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`SiftKit is busy. Timed out after ${timeoutMs} ms waiting for the execution lock.`);
      }

      sleepMs(25);
    }
  }
}

export function releaseExecutionLock(lock: {
  lockPath: string;
  handle: number;
}): void {
  if (!activeLock) {
    return;
  }

  activeLockDepth -= 1;
  if (activeLockDepth > 0) {
    return;
  }

  fs.closeSync(lock.handle);
  fs.rmSync(lock.lockPath, { force: true });
  activeLock = null;
}

export async function withExecutionLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const lock = acquireExecutionLock();
  try {
    return await fn();
  } finally {
    releaseExecutionLock(lock);
  }
}

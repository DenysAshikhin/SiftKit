import {
  getExecutionServerState,
  refreshExecutionLease,
  releaseExecutionLease,
  tryAcquireExecutionLease,
} from './config.js';

let activeLeaseToken: string | null = null;
let activeLockDepth = 0;
let activeHeartbeat: NodeJS.Timeout | null = null;

function sleepMs(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function stopHeartbeat(): void {
  if (!activeHeartbeat) {
    return;
  }

  clearInterval(activeHeartbeat);
  activeHeartbeat = null;
}

function startHeartbeat(token: string): void {
  stopHeartbeat();
  activeHeartbeat = setInterval(() => {
    void refreshExecutionLease(token).catch(() => {
      // The owning operation will surface the canonical server-unavailable error.
    });
  }, 3_000);
  if (typeof activeHeartbeat.unref === 'function') {
    activeHeartbeat.unref();
  }
}

export function getExecutionLockTimeoutMilliseconds(): number {
  const raw = process.env.SIFTKIT_LOCK_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  return 300_000;
}

export async function acquireExecutionLock(): Promise<{
  token: string;
}> {
  if (activeLeaseToken) {
    activeLockDepth += 1;
    return { token: activeLeaseToken };
  }

  const timeoutMs = getExecutionLockTimeoutMilliseconds();
  const startedAt = Date.now();

  while (true) {
    const lease = await tryAcquireExecutionLease();
    if (lease.acquired && lease.token) {
      activeLeaseToken = lease.token;
      activeLockDepth = 1;
      startHeartbeat(lease.token);
      return { token: lease.token };
    }

    const state = await getExecutionServerState();
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`SiftKit is busy. Timed out after ${timeoutMs} ms waiting for the server to report idle.`);
    }

    if (!state.busy) {
      continue;
    }

    await sleepMs(250);
  }
}

export function releaseExecutionLock(lock: {
  token: string;
}): Promise<void> | void {
  if (!activeLeaseToken) {
    return;
  }

  activeLockDepth -= 1;
  if (activeLockDepth > 0) {
    return;
  }

  stopHeartbeat();
  activeLeaseToken = null;
  return releaseExecutionLease(lock.token);
}

export async function withExecutionLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const lock = await acquireExecutionLock();
  try {
    return await fn();
  } finally {
    await releaseExecutionLock(lock);
  }
}

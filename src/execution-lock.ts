import {
  getExecutionServerState,
  refreshExecutionLease,
  releaseExecutionLease,
  tryAcquireExecutionLease,
} from './config/index.js';
import { sleep } from './lib/time.js';
import { createTracer } from './lib/trace.js';

let activeLeaseToken: string | null = null;
let activeLockDepth = 0;
let activeHeartbeat: NodeJS.Timeout | null = null;

const traceExecutionLock = createTracer('SIFTKIT_TRACE_SUMMARY', 'execution-lock');

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
    traceExecutionLock(`reenter token=${activeLeaseToken} depth=${activeLockDepth}`);
    return { token: activeLeaseToken };
  }

  const timeoutMs = getExecutionLockTimeoutMilliseconds();
  const startedAt = Date.now();
  traceExecutionLock(`acquire start timeout_ms=${timeoutMs}`);

  while (true) {
    const lease = await tryAcquireExecutionLease();
    if (lease.acquired && lease.token) {
      activeLeaseToken = lease.token;
      activeLockDepth = 1;
      startHeartbeat(lease.token);
      traceExecutionLock(`acquire success token=${lease.token} elapsed_ms=${Date.now() - startedAt}`);
      return { token: lease.token };
    }

    const state = await getExecutionServerState();
    if (Date.now() - startedAt >= timeoutMs) {
      traceExecutionLock(`acquire timeout elapsed_ms=${Date.now() - startedAt}`);
      throw new Error(`SiftKit is busy. Timed out after ${timeoutMs} ms waiting for the server to report idle.`);
    }

    if (!state.busy) {
      traceExecutionLock('acquire retry server_not_busy');
      continue;
    }

    await sleep(250);
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
    traceExecutionLock(`release deferred token=${lock.token} depth=${activeLockDepth}`);
    return;
  }

  stopHeartbeat();
  activeLeaseToken = null;
  traceExecutionLock(`release token=${lock.token}`);
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

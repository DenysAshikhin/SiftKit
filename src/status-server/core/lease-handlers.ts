import type { ExecutionLease } from '../server-types.js';

/** A lease is stale once it has gone `staleMs` or longer without a heartbeat. */
export function isLeaseStale(lease: ExecutionLease, now: number, staleMs: number): boolean {
  return (now - lease.heartbeatAt) >= staleMs;
}

/** The lease still active at `now`, or null when absent or stale. */
export function resolveActiveLease(lease: ExecutionLease | null, now: number, staleMs: number): ExecutionLease | null {
  if (!lease || isLeaseStale(lease, now, staleMs)) {
    return null;
  }
  return lease;
}

export type AcquireResult =
  | { acquired: true; lease: ExecutionLease }
  | { acquired: false; lease: ExecutionLease };

/** Grant a fresh lease only when no active lease is held; otherwise report the holder. */
export function acquireLease(current: ExecutionLease | null, token: string, now: number, staleMs: number): AcquireResult {
  const active = resolveActiveLease(current, now, staleMs);
  if (active) {
    return { acquired: false, lease: active };
  }
  return { acquired: true, lease: { token, heartbeatAt: now } };
}

/** Release succeeds only when the caller holds the active lease. */
export function releaseLease(current: ExecutionLease | null, token: string, now: number, staleMs: number): boolean {
  const active = resolveActiveLease(current, now, staleMs);
  return Boolean(active && active.token === token);
}

/** The refreshed lease when the caller holds the active lease, otherwise null. */
export function heartbeatLease(current: ExecutionLease | null, token: string, now: number, staleMs: number): ExecutionLease | null {
  const active = resolveActiveLease(current, now, staleMs);
  if (!active || active.token !== token) {
    return null;
  }
  return { token: active.token, heartbeatAt: now };
}

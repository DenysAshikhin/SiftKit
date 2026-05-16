/**
 * The SiftKit status server's network identity has two distinct meanings that
 * must not be conflated:
 *
 *  - the *bind* host — the interface the server listens on. Defaults to
 *    `0.0.0.0` so the status API is reachable from other machines (e.g. a
 *    pass-through SiftKit pulling host config). A wildcard bind is valid here.
 *  - the *connect* host — the address a client uses to reach the local status
 *    server. `0.0.0.0` is NOT a valid connect target, so it must collapse to
 *    loopback; otherwise every local CLI/worker → status-server call breaks.
 *
 * Both are derived from the single `SIFTKIT_STATUS_HOST` env var, so this
 * module is the one place that resolves it for each purpose.
 */

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_BIND_HOST = '0.0.0.0';

// Wildcard / unspecified addresses are bind-only — they can never be dialed.
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]', '*']);

function readConfiguredStatusHost(): string {
  return (process.env.SIFTKIT_STATUS_HOST ?? '').trim();
}

/**
 * Interface the status server should listen on. Defaults to `0.0.0.0` so the
 * status API is reachable across the network, not just over loopback.
 */
export function getStatusServerBindHost(): string {
  return readConfiguredStatusHost() || DEFAULT_BIND_HOST;
}

/**
 * Address to use when *connecting* to the local status server. Falls back to
 * loopback when the configured host is unset or a non-dialable wildcard, so
 * `SIFTKIT_STATUS_HOST=0.0.0.0` (or the default) still yields working
 * client → server calls.
 */
export function getStatusServerConnectHost(): string {
  const configured = readConfiguredStatusHost();
  if (!configured || WILDCARD_HOSTS.has(configured)) {
    return LOOPBACK_HOST;
  }
  return configured;
}

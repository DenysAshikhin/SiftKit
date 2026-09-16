/**
 * Shutdown cleanup contract (`docs/shutdown-persistence-bugs-2026-09-15.md` §5): the close handler
 * drains its writers and then *always* releases the flush worker, the chat lease and the runtime
 * database handle. A persistence stage that rejects must not skip the steps that free them — on
 * Windows a handle left open holds the directory that contains `runtime.sqlite`.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { JsonRecordReader } from '../src/lib/json-record-reader.js';
import { getRuntimeDatabasePath } from '../src/state/runtime-db.js';
import { writeConfig } from '../src/status-server/config-store.js';
import { startStatusServer } from '../src/status-server/index.js';
import { getRuntimeRoot } from '../src/status-server/paths.js';
import type { ExtendedServer } from '../src/status-server/server-types.js';
import { IsolatedRuntime } from './helpers/isolated-runtime.js';
import { getDefaultServerConfig } from './helpers/mock-config.js';
import { getAddressInfo, requestJson } from './helpers/dashboard-http.js';
import { installRejectingTriggerOnFile, withRuntimeDatabaseConnection } from './helpers/runtime-database-probe.js';
import { removeDirectoryWithRetries } from './helpers/temp-dirs.js';

// The server defers its history prune to an immediate, which can land after a test has restored
// the working directory — and a prune that then resolves the repo's own runtime database trips the
// protected-database guard. This file owns one process, so the switch stays off for all of it.
process.env.SIFTKIT_DISABLE_RUNTIME_HISTORY_PRUNE = '1';

type ShutdownHarness = {
  readonly server: ExtendedServer;
  /** Requests the shutdown under test. Teardown only closes the server when nobody has yet. */
  shutdown(): void;
};

/** The real status server, booted in a throwaway runtime root with no managed engine. */
function startServer(t: TestContext): ShutdownHarness {
  const runtime = new IsolatedRuntime();
  runtime.start();
  writeConfig(getRuntimeDatabasePath(), getDefaultServerConfig());
  const previousPort = process.env.SIFTKIT_STATUS_PORT;
  process.env.SIFTKIT_STATUS_PORT = '0';
  const server = startStatusServer({ disableManagedEngineStartup: true });
  let closeRequested = false;
  t.after(async () => {
    if (!closeRequested) server.close();
    await server.waitForShutdown().catch(() => undefined);
    if (previousPort === undefined) delete process.env.SIFTKIT_STATUS_PORT;
    else process.env.SIFTKIT_STATUS_PORT = previousPort;
    await runtime.close();
  });
  return {
    server,
    shutdown(): void {
      closeRequested = true;
      server.close();
    },
  };
}

/** The SQLite lease the server holds over this runtime; a released lease is an expired one. */
function leaseIsReleased(): boolean {
  return withRuntimeDatabaseConnection(getRuntimeDatabasePath(), database => {
    const row = JsonRecordReader.asObject(database.prepare('SELECT lease_expires_at_utc FROM chat_runtime_owner WHERE id = 1').get());
    const expiresAtUtc = row?.lease_expires_at_utc;
    return typeof expiresAtUtc === 'string' && Date.parse(expiresAtUtc) <= Date.now();
  });
}

/** Queues completion metadata that the idle delay will not drain before shutdown starts. */
async function postPendingTerminalMetadata(server: ExtendedServer, requestId: string): Promise<void> {
  const address = getAddressInfo(server);
  await requestJson(`http://127.0.0.1:${address.port}/status/terminal-metadata`, {
    method: 'POST',
    body: JSON.stringify({ running: false, requestId, taskKind: 'summary', terminalState: 'completed', outputTokens: 4 }),
  });
}

test('a successful shutdown releases the chat lease and closes the runtime database', async t => {
  const harness = startServer(t);
  await harness.server.startupPromise;

  harness.shutdown();
  await harness.server.waitForShutdown();

  assert.equal(leaseIsReleased(), true, 'the lease is released while the handle is still open');
  assert.equal(await removeDirectoryWithRetries(getRuntimeRoot()), true,
    'closing the runtime database handle is what makes the runtime directory removable again');
});

// The stages succeeded, so this cleanup failure is the only failure there is — and it still must
// not cost the caller the handles that cleanup owns.
test('a cleanup failure rejects shutdown and still closes the runtime database', async t => {
  const harness = startServer(t);
  await harness.server.startupPromise;
  installRejectingTriggerOnFile(getRuntimeDatabasePath(), 'chat_runtime_owner', 'reject_lease_release', ['UPDATE']);

  harness.shutdown();
  await assert.rejects(() => harness.server.waitForShutdown(), /reject_lease_release/u);

  assert.equal(await removeDirectoryWithRetries(getRuntimeRoot()), true,
    'a failing cleanup step must not skip the steps after it');
});

// The persistence failure is the diagnosis an operator needs; a cleanup failure on top of it must
// not replace it, and must not cost the handles either.
test('the persistence failure is what shutdown reports when a cleanup step fails as well', async t => {
  const harness = startServer(t);
  await harness.server.startupPromise;
  await postPendingTerminalMetadata(harness.server, 'cleanup-chain');
  installRejectingTriggerOnFile(getRuntimeDatabasePath(), 'run_logs', 'reject_run_logs', ['INSERT']);
  installRejectingTriggerOnFile(getRuntimeDatabasePath(), 'chat_runtime_owner', 'reject_lease_release', ['UPDATE']);

  harness.shutdown();
  await assert.rejects(() => harness.server.waitForShutdown(), /reject_run_logs/u);

  assert.equal(leaseIsReleased(), false, 'the cleanup step was attempted, and failed');
  assert.equal(await removeDirectoryWithRetries(getRuntimeRoot()), true,
    'the steps after the failing one still ran');
});
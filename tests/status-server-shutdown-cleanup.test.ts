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
import { countRunLogs, installRejectingTriggerOnFile, withRuntimeDatabaseConnection } from './helpers/runtime-database-probe.js';
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

type StartOptions = {
  readonly idleSummaryDelayMs?: number;
  readonly terminalMetadataIdleDelayMs?: number;
};

/** The real status server, booted in a throwaway runtime root with no managed engine. */
function startServer(t: TestContext, options: StartOptions = {}): ShutdownHarness {
  const runtime = new IsolatedRuntime();
  runtime.start();
  writeConfig(getRuntimeDatabasePath(), getDefaultServerConfig());
  const previousPort = process.env.SIFTKIT_STATUS_PORT;
  process.env.SIFTKIT_STATUS_PORT = '0';
  const server = startStatusServer({
    disableManagedEngineStartup: true,
    idleSummaryDelayMs: options.idleSummaryDelayMs,
    terminalMetadataIdleDelayMs: options.terminalMetadataIdleDelayMs,
  });
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

/**
 * The same, for a request that was actually started: only a run the server saw running can finish,
 * and finishing one is what arms the idle-summary timer.
 */
async function postCompletedTerminalMetadata(server: ExtendedServer, requestId: string): Promise<void> {
  const address = getAddressInfo(server);
  await requestJson(`http://127.0.0.1:${address.port}/status`, {
    method: 'POST',
    body: JSON.stringify({ running: true, requestId, rawInputCharacterCount: 200 }),
  });
  await postPendingTerminalMetadata(server, requestId);
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

/** Committed idle-summary snapshots, read after the server has closed its own handle. */
function idleSummarySnapshotCount(): number {
  return withRuntimeDatabaseConnection(getRuntimeDatabasePath(), database => {
    const row = JsonRecordReader.asObject(database.prepare('SELECT COUNT(*) AS count FROM idle_summary_snapshots').get());
    return Number(row?.count);
  });
}

/** Committed `run_logs` rows for one request id, read over the server's own handle. */
function runLogCount(requestId: string): number {
  return withRuntimeDatabaseConnection(getRuntimeDatabasePath(), database => countRunLogs(database, requestId));
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

// The metadata item that succeeds arms the idle-summary timer, and the one after it is the one that
// fails. Cancelling that timer is cleanup, not a persistence stage: left armed, it fires after
// shutdown has closed the database, reopens it through the path it was closed with, and writes a
// snapshot into the file shutdown was supposed to be done with.
const IDLE_SUMMARY_DELAY_MS = 1_500;

test('a shutdown that fails to persist never writes an idle summary into its closed database', async t => {
  const harness = startServer(t, {
    idleSummaryDelayMs: IDLE_SUMMARY_DELAY_MS,
    // Both items have to still be queued when the shutdown drain starts, because the arming happens
    // inside that drain: the first item commits, and only the next one is failed.
    terminalMetadataIdleDelayMs: 60_000,
  });
  await harness.server.startupPromise;
  await postCompletedTerminalMetadata(harness.server, 'idle-summary-armed');
  // Only the item that is to be written needs a run the server saw: an unfinished second run would
  // keep the server non-idle, and an idle summary is only ever armed for an idle server.
  await postPendingTerminalMetadata(harness.server, 'idle-summary-rejected');
  installRejectingTriggerOnFile(getRuntimeDatabasePath(), 'run_logs', 'reject_run_logs', ['INSERT'],
    "NEW.request_id = 'idle-summary-rejected'");
  assert.equal(runLogCount('idle-summary-armed'), 0, 'neither item may be written before the shutdown drain');

  harness.shutdown();
  await assert.rejects(() => harness.server.waitForShutdown(), /reject_run_logs/u);

  assert.equal(runLogCount('idle-summary-armed'), 1,
    'the item before the failing one did get written, which is what armed the timer');
  await delay(IDLE_SUMMARY_DELAY_MS + 500);
  assert.equal(idleSummarySnapshotCount(), 0,
    'a timer shutdown cancelled cannot write into the database shutdown closed');
});
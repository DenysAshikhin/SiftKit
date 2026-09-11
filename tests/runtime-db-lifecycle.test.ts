import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { z } from '../src/lib/zod.js';
import {
  closeAllRuntimeDatabases,
  closeRuntimeDatabase,
  getRuntimeDatabase,
  getRuntimeDatabasePath,
} from '../src/state/runtime-db.js';
import { enqueueDeferredArtifacts, flushDeferredArtifacts } from '../src/status-server/server-ops.js';
import { UNRECORDED_RUN_IDENTITY } from '../src/status-server/dashboard-runs/run-identity.js';
import { createTestServerContext } from './helpers/server-context-fixture.js';
import { createManagedTempDir, removeDirectoryWithRetries } from './helpers/temp-dirs.js';

const ValueRowsSchema = z.array(z.object({ value: z.string() }));
const JournalModeRowSchema = z.object({ journal_mode: z.string() });

function readValues(database: ReturnType<typeof getRuntimeDatabase>): string[] {
  return ValueRowsSchema.parse(database.prepare('SELECT value FROM audit_value ORDER BY value').all())
    .map((row) => row.value);
}

function twoPaths(prefix: string): { firstPath: string; secondPath: string } {
  const root = createManagedTempDir(prefix);
  return { firstPath: path.join(root, 'a', 'runtime.sqlite'), secondPath: path.join(root, 'b', 'runtime.sqlite') };
}

test('opening a second database leaves the first handle open and usable', () => {
  const { firstPath, secondPath } = twoPaths('runtime-db-lifecycle-scoped-');
  try {
    const first = getRuntimeDatabase(firstPath);
    first.exec("CREATE TABLE audit_value(value TEXT); INSERT INTO audit_value VALUES ('A')");
    const second = getRuntimeDatabase(secondPath);
    assert.notEqual(first, second);
    assert.equal(first.open, true);
    first.exec("INSERT INTO audit_value VALUES ('A2')");
    assert.deepEqual(readValues(first), ['A', 'A2']);

    closeRuntimeDatabase(secondPath);
    assert.equal(second.open, false);
    assert.equal(first.open, true);
    assert.deepEqual(first.prepare('SELECT value FROM audit_value ORDER BY value').all(), [{ value: 'A' }, { value: 'A2' }]);
    assert.equal(JournalModeRowSchema.parse(first.prepare('PRAGMA journal_mode').get()).journal_mode, 'wal');
  } finally {
    closeAllRuntimeDatabases();
  }
});

test('the same path and its case/separator aliases share one handle', () => {
  const { firstPath } = twoPaths('runtime-db-lifecycle-alias-');
  try {
    const first = getRuntimeDatabase(firstPath);
    assert.equal(getRuntimeDatabase(firstPath), first);
    assert.equal(getRuntimeDatabase(path.join(path.dirname(firstPath), '.', 'runtime.sqlite')), first);
    if (process.platform === 'win32') {
      assert.equal(getRuntimeDatabase(firstPath.toUpperCase()), first);
      assert.equal(getRuntimeDatabase(firstPath.replaceAll('\\', '/')), first);
    }
  } finally {
    closeAllRuntimeDatabases();
  }
});

test('an explicitly closed database reopens as a new handle', () => {
  const { firstPath } = twoPaths('runtime-db-lifecycle-reopen-');
  try {
    const first = getRuntimeDatabase(firstPath);
    first.exec("CREATE TABLE audit_value(value TEXT); INSERT INTO audit_value VALUES ('A')");
    closeRuntimeDatabase(firstPath);
    assert.equal(first.open, false);
    closeRuntimeDatabase(firstPath); // Idempotent for a path that is not open.
    const reopened = getRuntimeDatabase(firstPath);
    assert.notEqual(reopened, first);
    assert.deepEqual(readValues(reopened), ['A']);
  } finally {
    closeAllRuntimeDatabases();
  }
});

test('a failed second initialization closes only its own handle', () => {
  const { firstPath, secondPath } = twoPaths('runtime-db-lifecycle-failed-');
  try {
    const first = getRuntimeDatabase(firstPath);
    first.exec("CREATE TABLE audit_value(value TEXT); INSERT INTO audit_value VALUES ('A')");
    mkdirSync(path.dirname(secondPath), { recursive: true });
    writeFileSync(secondPath, 'not a sqlite database at all, just enough bytes to fail the header check');
    assert.throws(() => getRuntimeDatabase(secondPath));
    assert.equal(first.open, true);
    assert.deepEqual(readValues(first), ['A']);
    assert.throws(() => getRuntimeDatabase(secondPath), 'a failed path is not registered');
  } finally {
    closeAllRuntimeDatabases();
  }
});

test('the protected-database guard matches canonical aliases of the guarded path', () => {
  const { firstPath } = twoPaths('runtime-db-lifecycle-guard-');
  const previousGuard = process.env.SIFTKIT_GUARD_RUNTIME_DATABASE;
  const previousExitCode = process.exitCode;
  const stderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    process.env.SIFTKIT_GUARD_RUNTIME_DATABASE = firstPath.replaceAll('\\', '/');
    const alias = process.platform === 'win32' ? firstPath.toUpperCase() : firstPath;
    assert.throws(() => getRuntimeDatabase(alias), /protected runtime database/u);
  } finally {
    process.stderr.write = stderrWrite;
    process.exitCode = previousExitCode;
    if (previousGuard === undefined) delete process.env.SIFTKIT_GUARD_RUNTIME_DATABASE;
    else process.env.SIFTKIT_GUARD_RUNTIME_DATABASE = previousGuard;
    closeAllRuntimeDatabases();
  }
});

test('transactions on two open databases roll back independently', () => {
  const { firstPath, secondPath } = twoPaths('runtime-db-lifecycle-transactions-');
  try {
    const first = getRuntimeDatabase(firstPath);
    const second = getRuntimeDatabase(secondPath);
    first.exec('CREATE TABLE audit_value(value TEXT)');
    second.exec('CREATE TABLE audit_value(value TEXT)');
    assert.throws(() => first.transaction(() => {
      first.prepare('INSERT INTO audit_value VALUES (?)').run('A');
      second.transaction(() => {
        second.prepare('INSERT INTO audit_value VALUES (?)').run('B');
      })();
      throw new Error('roll back A only');
    })(), /roll back A only/u);
    assert.deepEqual(readValues(first), []);
    assert.deepEqual(readValues(second), ['B']);
    closeRuntimeDatabase(secondPath);
    assert.equal(first.inTransaction, false);
    first.exec("INSERT INTO audit_value VALUES ('A')");
    assert.deepEqual(readValues(first), ['A']);
  } finally {
    closeAllRuntimeDatabases();
  }
});

test('close-all closes every registered handle and leaves the registry empty', () => {
  const { firstPath, secondPath } = twoPaths('runtime-db-lifecycle-close-all-');
  const first = getRuntimeDatabase(firstPath);
  const second = getRuntimeDatabase(secondPath);
  closeAllRuntimeDatabases();
  assert.equal(first.open, false);
  assert.equal(second.open, false);
  const reopened = getRuntimeDatabase(firstPath);
  assert.notEqual(reopened, first);
  closeAllRuntimeDatabases();
});

test('deferred writers stay pinned to each server database while both queues drain', async t => {
  const root = createManagedTempDir('runtime-db-lifecycle-deferred-');
  const previousGuard = process.env.SIFTKIT_GUARD_RUNTIME_DATABASE;
  const previousExitCode = process.exitCode;
  t.after(async () => {
    if (previousGuard === undefined) delete process.env.SIFTKIT_GUARD_RUNTIME_DATABASE;
    else process.env.SIFTKIT_GUARD_RUNTIME_DATABASE = previousGuard;
    process.exitCode = previousExitCode;
    closeAllRuntimeDatabases();
    assert.equal(await removeDirectoryWithRetries(root), true);
  });
  const firstRoot = path.join(root, 'first');
  const secondRoot = path.join(root, 'second');
  const first = createTestServerContext(path.join(firstRoot, 'config.json'), firstRoot);
  const second = createTestServerContext(path.join(secondRoot, 'config.json'), secondRoot);
  first.idleSummary.database = first.runtimeDatabase;
  second.idleSummary.database = second.runtimeDatabase;
  process.env.SIFTKIT_GUARD_RUNTIME_DATABASE = getRuntimeDatabasePath();
  try {
    enqueueDeferredArtifacts(first, [{ artifactType: 'planner_debug', artifactRequestId: 'first-artifact', artifactPayload: { owner: 'first' }, identity: UNRECORDED_RUN_IDENTITY }]);
    enqueueDeferredArtifacts(second, [{ artifactType: 'planner_debug', artifactRequestId: 'second-artifact', artifactPayload: { owner: 'second' }, identity: UNRECORDED_RUN_IDENTITY }]);
    await Promise.all([flushDeferredArtifacts(first), flushDeferredArtifacts(second)]);

    const firstCount = z.object({ count: z.number() }).parse(first.runtimeDatabase.prepare(
      "SELECT count(*) AS count FROM runtime_artifacts WHERE request_id = 'first-artifact'",
    ).get()).count;
    const secondCount = z.object({ count: z.number() }).parse(second.runtimeDatabase.prepare(
      "SELECT count(*) AS count FROM runtime_artifacts WHERE request_id = 'second-artifact'",
    ).get()).count;
    assert.equal(firstCount, 1);
    assert.equal(secondCount, 1);
    assert.equal(first.runtimeDatabase.open, true);
    assert.equal(second.runtimeDatabase.open, true);
  } finally {
    if (previousGuard === undefined) delete process.env.SIFTKIT_GUARD_RUNTIME_DATABASE;
    else process.env.SIFTKIT_GUARD_RUNTIME_DATABASE = previousGuard;
    process.exitCode = previousExitCode;
    closeAllRuntimeDatabases();
  }
});

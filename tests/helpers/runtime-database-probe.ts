import Database from 'better-sqlite3';
import { JsonRecordReader } from '../../src/lib/json-record-reader.js';
import type { RuntimeDatabase } from '../../src/state/database-handle.js';

/**
 * Helpers for inspecting and sabotaging a runtime database from *outside* the process that owns it,
 * so a test can tell whether a failed write was reported or quietly survived. Triggers are schema
 * state, so one installed on a second connection (or by a parent process) fails the owner's writes.
 */

const WRITE_EVENTS = ['INSERT', 'UPDATE'] as const;

export type WriteEvent = (typeof WRITE_EVENTS)[number];

/** Opens a second connection to `databasePath`; the owner's own handle is never disturbed. */
export function withRuntimeDatabaseConnection<T>(databasePath: string, run: (database: RuntimeDatabase) => T): T {
  const database = new Database(databasePath);
  try {
    database.pragma('busy_timeout = 5000');
    return run(database);
  } finally {
    database.close();
  }
}

/**
 * Make every write to `table` fail with `name` as the SQLite message. Both events are covered
 * because an upsert runs its UPDATE triggers on the conflict path and its INSERT triggers otherwise.
 * `when` narrows the trigger to the rows a test cares about, so a write can be failed *mid-batch*.
 */
export function installRejectingTrigger(
  database: RuntimeDatabase,
  table: string,
  name: string,
  events: readonly WriteEvent[] = WRITE_EVENTS,
  when: string | null = null,
): void {
  for (const event of events) {
    database.exec(`CREATE TRIGGER ${name}_${event.toLowerCase()} BEFORE ${event} ON ${table} `
      + (when === null ? '' : `WHEN ${when} `)
      + `BEGIN SELECT RAISE(ABORT, '${name}'); END;`);
  }
}

export function removeRejectingTrigger(
  database: RuntimeDatabase,
  name: string,
  events: readonly WriteEvent[] = WRITE_EVENTS,
): void {
  for (const event of events) {
    database.exec(`DROP TRIGGER ${name}_${event.toLowerCase()}`);
  }
}

export function installRejectingTriggerOnFile(
  databasePath: string,
  table: string,
  name: string,
  events: readonly WriteEvent[] = WRITE_EVENTS,
  when: string | null = null,
): void {
  withRuntimeDatabaseConnection(databasePath, database => {
    installRejectingTrigger(database, table, name, events, when);
  });
}

export function removeRejectingTriggerFromFile(databasePath: string, name: string, events: readonly WriteEvent[] = WRITE_EVENTS): void {
  withRuntimeDatabaseConnection(databasePath, database => {
    removeRejectingTrigger(database, name, events);
  });
}

/** Committed chunk rows only; the text reader also folds in chunks still buffered in memory. */
export function countLogRows(database: RuntimeDatabase, runId: string): number {
  return countRows(database, 'inference_run_log_chunks', 'run_id', runId);
}

export function countRunLogs(database: RuntimeDatabase, requestId: string): number {
  return countRows(database, 'run_logs', 'request_id', requestId);
}

export function countMetricsRows(database: RuntimeDatabase): number {
  return countRows(database, 'runtime_metrics_totals', null, null);
}

function countRows(database: RuntimeDatabase, table: string, key: string | null, value: string | null): number {
  const statement = key === null
    ? database.prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    : database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${key} = ?`);
  const row = JsonRecordReader.asObject(key === null ? statement.get() : statement.get(value));
  return Number(row?.count);
}
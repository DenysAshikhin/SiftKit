import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { z } from '../lib/zod.js';
import { ensureDirectory } from '../lib/fs.js';
import { findNearestSiftKitRepoRoot } from '../lib/paths.js';
import { SystemClock } from '../assistant/clock.js';
import { seedAssistantRegistries } from '../assistant/storage/schema.js';
import { initializeRuntimeSchema } from './runtime-schema.js';
import type { RuntimeDatabase } from './database-handle.js';
export type { RuntimeDatabase } from './database-handle.js';

const VersionRowsSchema = z.array(z.object({ id: z.literal(1), version: z.number().int() })).length(1);
const MetadataValueRowSchema = z.object({ value: z.string().nullable() });
const FreelistRowSchema = z.object({ freelist_count: z.number().nullable() });
const PageCountRowSchema = z.object({ page_count: z.number().nullable() });
const ObjectCountRowSchema = z.object({ object_count: z.number() });
const RuntimeSchemaTableRowSchema = z.object({ type: z.literal('table') });

export const CURRENT_SCHEMA_VERSION = 66;

let cachedDatabasePath: string | null = null;
let cachedDatabase: RuntimeDatabase | null = null;

export function getSchemaVersion(database: RuntimeDatabase): number {
  const marker = RuntimeSchemaTableRowSchema.safeParse(database.prepare(
    "SELECT type FROM sqlite_schema WHERE name = 'runtime_schema'",
  ).get());
  if (!marker.success) throw new Error('Runtime schema marker table is missing or invalid.', { cause: marker.error });
  const rows = VersionRowsSchema.parse(database.prepare(
    'SELECT id, version FROM runtime_schema ORDER BY id',
  ).all());
  const row = rows[0];
  if (row === undefined) throw new Error('Runtime schema marker is missing.');
  return row.version;
}

function hasDatabaseObjects(database: RuntimeDatabase): boolean {
  const rawRow = database.prepare(`
    SELECT count(*) AS object_count
    FROM sqlite_master
    WHERE type IN ('table', 'index', 'view', 'trigger')
  `).get();
  return ObjectCountRowSchema.parse(rawRow).object_count > 0;
}

type RuntimeDatabaseState = 'fresh' | 'current';

function inspectRuntimeDatabase(database: RuntimeDatabase, databasePath: string): RuntimeDatabaseState {
  if (!hasDatabaseObjects(database)) return 'fresh';

  let version: number;
  try {
    version = getSchemaVersion(database);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Runtime schema marker is missing or invalid at ${databasePath}; expected schema version ${CURRENT_SCHEMA_VERSION}: ${message}`, { cause: error });
  }
  if (version !== CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Runtime schema version ${String(version)} is incompatible at ${databasePath}; expected ${String(CURRENT_SCHEMA_VERSION)}.`,
    );
  }
  return 'current';
}

export function getRepoRuntimeRoot(startPath: string = process.cwd()): string {
  const repoRoot = findNearestSiftKitRepoRoot(startPath);
  const resolvedBaseRoot = repoRoot ? resolve(repoRoot) : resolve(startPath);
  return join(resolvedBaseRoot, '.siftkit');
}

export function getRuntimeDatabasePath(startPath: string = process.cwd()): string {
  return join(getRepoRuntimeRoot(startPath), 'runtime.sqlite');
}

function configureRuntimeDatabase(database: RuntimeDatabase): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
  `);
}

function closeRuntimeDatabaseHandle(database: RuntimeDatabase): void {
  try {
    database.exec(`
      PRAGMA wal_checkpoint(TRUNCATE);
      PRAGMA journal_mode = DELETE;
    `);
  } catch {
    // Best effort before close.
  }
  database.close();
}

function closeFailedDatabaseHandle(database: RuntimeDatabase): void {
  try {
    database.close();
  } catch {
    // Best effort after a failed open.
  }
}

export function getRuntimeDatabase(databasePath: string = getRuntimeDatabasePath()): RuntimeDatabase {
  const resolvedPath = resolve(databasePath);
  if (cachedDatabase && cachedDatabasePath === resolvedPath) {
    return cachedDatabase;
  }
  if (cachedDatabase) {
    closeRuntimeDatabaseHandle(cachedDatabase);
    cachedDatabase = null;
    cachedDatabasePath = null;
  }

  ensureDirectory(dirname(resolvedPath));
  const database = new Database(resolvedPath);
  try {
    const state = inspectRuntimeDatabase(database, resolvedPath);
    configureRuntimeDatabase(database);
    database.transaction(() => {
      initializeRuntimeSchema(database);
      if (state === 'fresh') {
        seedAssistantRegistries(database, new SystemClock(), randomUUID());
        database.prepare('INSERT INTO runtime_schema (id, version) VALUES (1, ?)').run(CURRENT_SCHEMA_VERSION);
      }
    })();
  } catch (error) {
    closeFailedDatabaseHandle(database);
    throw error;
  }

  cachedDatabase = database;
  cachedDatabasePath = resolvedPath;
  return database;
}

export function closeRuntimeDatabase(): void {
  if (!cachedDatabase) {
    return;
  }
  closeRuntimeDatabaseHandle(cachedDatabase);
  cachedDatabase = null;
  cachedDatabasePath = null;
}

export function getRuntimeMetadataValue(
  key: string,
  databasePath: string = getRuntimeDatabasePath(),
): string | null {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) {
    return null;
  }
  const database = getRuntimeDatabase(databasePath);
  const rawRow = database.prepare(`
    SELECT value
    FROM runtime_metadata
    WHERE key = ?
    LIMIT 1
  `).get(normalizedKey);
  const row = rawRow == null ? undefined : MetadataValueRowSchema.parse(rawRow);
  return typeof row?.value === 'string' ? row.value : null;
}

export interface PruneRuntimeHistoryResult {
  retentionDays: number;
  cutoffUtc: string;
  deleted: { table: string; rows: number }[];
  vacuumed: boolean;
}

const RUNTIME_HISTORY_VACUUM_FREELIST_RATIO = 0.1;

export function pruneRuntimeHistory(
  retentionDays: number,
  databasePath: string = getRuntimeDatabasePath(),
): PruneRuntimeHistoryResult {
  const days = Math.max(1, Math.floor(retentionDays));
  const cutoffUtc = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const database = getRuntimeDatabase(databasePath);
  const deleted: { table: string; rows: number }[] = [];

  const deleteStatements: { table: string; sql: string }[] = [
    { table: 'runtime_artifacts', sql: 'DELETE FROM runtime_artifacts WHERE created_at_utc < ?' },
    {
      table: 'run_logs',
      sql: 'DELETE FROM run_logs WHERE COALESCE(finished_at_utc, started_at_utc, flushed_at_utc) < ?',
    },
    {
      table: 'inference_runs',
      sql: "DELETE FROM inference_runs WHERE status != 'running' AND COALESCE(finished_at_utc, started_at_utc) < ?",
    },
    { table: 'idle_summary_snapshots', sql: 'DELETE FROM idle_summary_snapshots WHERE emitted_at_utc < ?' },
    { table: 'runtime_error_events', sql: 'DELETE FROM runtime_error_events WHERE created_at_utc < ?' },
    { table: 'benchmark_runs', sql: 'DELETE FROM benchmark_runs WHERE created_at_utc < ?' },
  ];

  database.transaction(() => {
    for (const { table, sql } of deleteStatements) {
      const info = database.prepare(sql).run(cutoffUtc);
      deleted.push({ table, rows: Number(info.changes) || 0 });
    }
  })();

  try {
    database.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch {
    // Best-effort; continue.
  }

  let vacuumed = false;
  try {
    const rawFreelistRow = database.prepare('PRAGMA freelist_count').get();
    const rawPageRow = database.prepare('PRAGMA page_count').get();
    const freelistRow = rawFreelistRow == null ? undefined : FreelistRowSchema.parse(rawFreelistRow);
    const pageRow = rawPageRow == null ? undefined : PageCountRowSchema.parse(rawPageRow);
    const freelistCount = Number(freelistRow?.freelist_count) || 0;
    const pageCount = Number(pageRow?.page_count) || 0;
    if (pageCount > 0 && freelistCount / pageCount > RUNTIME_HISTORY_VACUUM_FREELIST_RATIO) {
      database.exec('VACUUM;');
      vacuumed = true;
    }
  } catch {
    // VACUUM cannot run inside an open transaction or while locks are held; best-effort.
  }

  return { retentionDays: days, cutoffUtc, deleted, vacuumed };
}

export function setRuntimeMetadataValue(
  key: string,
  value: string,
  databasePath: string = getRuntimeDatabasePath(),
): void {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) {
    throw new Error('Runtime metadata key is required.');
  }
  const database = getRuntimeDatabase(databasePath);
  database.prepare(`
    INSERT INTO runtime_metadata (key, value, updated_at_utc)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at_utc = excluded.updated_at_utc
  `).run(
    normalizedKey,
    String(value || ''),
    new Date().toISOString(),
  );
}

import { basename, dirname, join, resolve } from 'node:path';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { z } from '../lib/zod.js';
import { ensureDirectory } from '../lib/fs.js';
import { findNearestSiftKitRepoRoot } from '../lib/paths.js';
import { SystemClock } from '../assistant/clock.js';
import { seedAssistantRegistries } from '../assistant/storage/schema.js';
import { CHAT_PENDING_MESSAGES_SCHEMA_SQL, initializeRuntimeSchema } from './runtime-schema.js';
import { upgradeChatSubmissionsSchema } from './schema-upgrades/chat-submissions.js';
import { upgradeInferenceThroughputSchema } from './schema-upgrades/inference-throughput.js';
import { retireRepoAgentHistoryRepairMarkers, upgradeChatProjectionCheckpoints, upgradeChatRecoverySchema } from './schema-upgrades/chat-recovery.js';
import { upgradeChatJournalEventsToVersion2 } from './schema-upgrades/chat-replay-transport.js';
import { upgradeChatProgressEventsToDeltas } from './schema-upgrades/chat-progress-delta.js';
import { upgradePresetModelRouting } from './schema-upgrades/preset-model-routing.js';
import { upgradeOrchestratorPreset } from './schema-upgrades/orchestrator.js';
import { upgradeOrchestratorRepoKey, upgradeOrchestratorRuns } from './schema-upgrades/orchestrator-runs.js';
import { upgradeChatStatusNarration } from './schema-upgrades/chat-status-narration.js';
import type { RuntimeDatabase } from './database-handle.js';
export type { RuntimeDatabase } from './database-handle.js';

const VersionRowsSchema = z.tuple([z.object({ id: z.literal(1), version: z.number().int() })]);
const MetadataValueRowSchema = z.object({ value: z.string().nullable() });
const FreelistRowSchema = z.object({ freelist_count: z.number().nullable() });
const PageCountRowSchema = z.object({ page_count: z.number().nullable() });
const ObjectCountRowSchema = z.object({ object_count: z.number() });
const RuntimeSchemaTableRowSchema = z.object({ type: z.literal('table') });

export const CURRENT_SCHEMA_VERSION = 79;

type SchemaUpgradeStep = { from: number; apply(database: RuntimeDatabase): void };

/**
 * Explicit, ordered, in-place upgrades. Each step takes a database at exactly `from` and leaves it
 * at `from + 1`; the whole chain runs in one transaction with the marker bump, so a failure leaves
 * the file at its original version. A version with no step here is rejected, never guessed at.
 */
const SCHEMA_UPGRADES: readonly SchemaUpgradeStep[] = [
  { from: 66, apply: (database) => database.exec(CHAT_PENDING_MESSAGES_SCHEMA_SQL) },
  { from: 67, apply: upgradeChatRecoverySchema },
  { from: 68, apply: retireRepoAgentHistoryRepairMarkers },
  { from: 69, apply: upgradeChatProjectionCheckpoints },
  { from: 70, apply: upgradeChatJournalEventsToVersion2 },
  { from: 71, apply: upgradeChatSubmissionsSchema },
  { from: 72, apply: upgradeInferenceThroughputSchema },
  { from: 73, apply: upgradeChatProgressEventsToDeltas },
  { from: 74, apply: upgradePresetModelRouting },
  { from: 75, apply: upgradeChatStatusNarration },
  { from: 76, apply: upgradeOrchestratorPreset },
  { from: 77, apply: upgradeOrchestratorRuns },
  { from: 78, apply: upgradeOrchestratorRepoKey },
];

function findUpgradeChain(fromVersion: number): SchemaUpgradeStep[] | null {
  const chain: SchemaUpgradeStep[] = [];
  for (let version = fromVersion; version < CURRENT_SCHEMA_VERSION; version += 1) {
    const step = SCHEMA_UPGRADES.find((candidate) => candidate.from === version);
    if (!step) return null;
    chain.push(step);
  }
  return chain;
}

/** Open connections keyed by canonical path; opening one path never closes another. */
const openDatabases = new Map<string, RuntimeDatabase>();
/** The path each registry connection was opened for; an in-memory connection has no file name. */
const databasePaths = new WeakMap<RuntimeDatabase, string>();
/** In memory storage, the image a closed path reopens from. */
const memoryImages = new Map<string, Buffer>();

const RuntimeDatabaseStorageSchema = z.enum(['file', 'memory']);
export type RuntimeDatabaseStorage = z.infer<typeof RuntimeDatabaseStorageSchema>;

/** `memory` keeps every runtime database in this process only; hermetic test runs select it. */
export function getRuntimeDatabaseStorage(): RuntimeDatabaseStorage {
  return RuntimeDatabaseStorageSchema.parse(process.env.SIFTKIT_RUNTIME_DATABASE_STORAGE ?? 'file');
}

/** Registry key: real parent directory where it exists, plus case folding on Windows. */
function canonicalDatabaseKey(databasePath: string): string {
  const resolvedPath = resolve(databasePath);
  let canonicalPath = resolvedPath;
  try {
    canonicalPath = join(realpathSync.native(dirname(resolvedPath)), basename(resolvedPath));
  } catch {
    // The parent does not exist yet; the resolved path is the best canonical form available.
  }
  return process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;
}

export function getSchemaVersion(database: RuntimeDatabase): number {
  try {
    RuntimeSchemaTableRowSchema.parse(database.prepare(
      "SELECT type FROM sqlite_schema WHERE name = 'runtime_schema'",
    ).get());
    const [row] = VersionRowsSchema.parse(database.prepare(
      'SELECT id, version FROM runtime_schema ORDER BY id',
    ).all());
    return row.version;
  } catch (error) {
    throw new Error(
      `Runtime schema marker is missing or invalid at ${databasePaths.get(database) ?? database.name}; expected schema version ${CURRENT_SCHEMA_VERSION}`
      + ' in one runtime_schema row with id 1 and an integer version.',
      { cause: error },
    );
  }
}

function hasDatabaseObjects(database: RuntimeDatabase): boolean {
  const rawRow = database.prepare(`
    SELECT count(*) AS object_count
    FROM sqlite_master
    WHERE type IN ('table', 'index', 'view', 'trigger')
  `).get();
  return ObjectCountRowSchema.parse(rawRow).object_count > 0;
}

type RuntimeDatabaseState = { kind: 'fresh' } | { kind: 'current' } | { kind: 'upgrade'; fromVersion: number };

function inspectRuntimeDatabase(database: RuntimeDatabase, databasePath: string): RuntimeDatabaseState {
  if (!hasDatabaseObjects(database)) return { kind: 'fresh' };

  const version = getSchemaVersion(database);
  if (version === CURRENT_SCHEMA_VERSION) return { kind: 'current' };
  if (version < CURRENT_SCHEMA_VERSION && findUpgradeChain(version) !== null) {
    return { kind: 'upgrade', fromVersion: version };
  }
  throw new Error(
    `Runtime schema version ${String(version)} is incompatible at ${databasePath}; expected ${String(CURRENT_SCHEMA_VERSION)}.`,
  );
}

export function getRepoRuntimeRoot(startPath: string = process.cwd()): string {
  const repoRoot = findNearestSiftKitRepoRoot(startPath);
  const resolvedBaseRoot = repoRoot ? resolve(repoRoot) : resolve(startPath);
  return join(resolvedBaseRoot, '.siftkit');
}

export function getRuntimeDatabasePath(startPath: string = process.cwd()): string {
  return join(getRepoRuntimeRoot(startPath), 'runtime.sqlite');
}

/**
 * This one connection carries the chat journal, and a journal that loses its last commit on a hard
 * power loss cannot promise that an approved tool was recorded before it ran. WAL keeps readers
 * unblocked; FULL is what makes a committed event actually durable. This is the only place the
 * setting is chosen, so no later initializer can quietly drop it back to NORMAL.
 */
function configureRuntimeDatabase(database: RuntimeDatabase): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
  `);
}

/** Ordinary close: the last connection checkpoints on its own, and WAL stays on for any other. */
function closeRuntimeDatabaseHandle(key: string, database: RuntimeDatabase): void {
  if (getRuntimeDatabaseStorage() === 'memory') memoryImages.set(key, database.serialize());
  database.close();
}

function closeFailedDatabaseHandle(database: RuntimeDatabase): void {
  try {
    database.close();
  } catch {
    // Best effort after a failed open.
  }
}

/** In memory storage, a path reopens its last image, else a file seeded on disk, else starts empty. */
function openDatabaseConnection(resolvedPath: string, key: string): RuntimeDatabase {
  if (getRuntimeDatabaseStorage() === 'file') return new Database(resolvedPath);
  const image = memoryImages.get(key) ?? (existsSync(resolvedPath) ? readFileSync(resolvedPath) : null);
  return new Database(image ?? ':memory:');
}

export function isRuntimeDatabaseOpen(databasePath: string): boolean {
  return openDatabases.has(canonicalDatabaseKey(databasePath));
}

export function runtimeDatabaseExists(databasePath: string): boolean {
  const key = canonicalDatabaseKey(databasePath);
  return openDatabases.has(key) || memoryImages.has(key) || existsSync(databasePath);
}

/** The stored database as a raw image, open or closed, with no bootstrap run over it; null when none exists. */
export function readRuntimeDatabaseImage(databasePath: string): Buffer | null {
  const key = canonicalDatabaseKey(databasePath);
  const open = openDatabases.get(key);
  if (open) return open.serialize();
  const image = memoryImages.get(key);
  if (image) return image;
  return existsSync(databasePath) ? readFileSync(databasePath) : null;
}

/** Replaces what a closed path stores; the next open reads it through the ordinary bootstrap. */
export function writeRuntimeDatabaseImage(databasePath: string, image: Buffer): void {
  const key = canonicalDatabaseKey(databasePath);
  if (openDatabases.has(key)) throw new Error(`Runtime database ${databasePath} is open; close it before replacing its image.`);
  if (getRuntimeDatabaseStorage() === 'memory') {
    memoryImages.set(key, image);
    return;
  }
  ensureDirectory(dirname(resolve(databasePath)));
  writeFileSync(databasePath, image);
}

export function getRuntimeDatabaseFilePath(database: RuntimeDatabase): string {
  const databasePath = databasePaths.get(database);
  if (databasePath === undefined) throw new Error('The database was not opened through the runtime database registry.');
  return databasePath;
}

export function getRuntimeDatabase(databasePath: string = getRuntimeDatabasePath()): RuntimeDatabase {
  const resolvedPath = resolve(databasePath);
  const protectedPath = process.env.SIFTKIT_GUARD_RUNTIME_DATABASE;
  if (protectedPath && canonicalDatabaseKey(protectedPath) === canonicalDatabaseKey(resolvedPath)) {
    const error = new Error(`Test attempted to open the protected runtime database: ${resolvedPath}`);
    // As with the HTTP live-instance guard, swallowed background errors must still fail the file.
    process.exitCode = 1;
    process.stderr.write(`${error.stack}\n`);
    throw error;
  }
  // A memory database has no file, so its directory is never needed.
  if (getRuntimeDatabaseStorage() === 'file') ensureDirectory(dirname(resolvedPath));
  const key = canonicalDatabaseKey(resolvedPath);
  const existing = openDatabases.get(key);
  if (existing) return existing;

  const database = openDatabaseConnection(resolvedPath, key);
  databasePaths.set(database, resolvedPath);
  try {
    const state = inspectRuntimeDatabase(database, resolvedPath);
    configureRuntimeDatabase(database);
    database.transaction(() => {
      if (state.kind === 'upgrade') {
        // Upgrades run before the idempotent bootstrap so each step sees exactly the shape it
        // was written for, and the marker moves only once every step has succeeded.
        for (const step of findUpgradeChain(state.fromVersion) ?? []) {
          step.apply(database);
        }
        database.prepare('UPDATE runtime_schema SET version = ? WHERE id = 1').run(CURRENT_SCHEMA_VERSION);
      }
      initializeRuntimeSchema(database);
      if (state.kind === 'fresh') {
        seedAssistantRegistries(database, new SystemClock(), randomUUID());
        database.prepare('INSERT INTO runtime_schema (id, version) VALUES (1, ?)').run(CURRENT_SCHEMA_VERSION);
      }
    })();
  } catch (error) {
    closeFailedDatabaseHandle(database);
    throw error;
  }

  openDatabases.set(key, database);
  return database;
}

/** Closes exactly this path's connection, if open. Other open paths are untouched. */
export function closeRuntimeDatabase(databasePath: string): void {
  const key = canonicalDatabaseKey(databasePath);
  const database = openDatabases.get(key);
  if (!database) return;
  openDatabases.delete(key);
  closeRuntimeDatabaseHandle(key, database);
}

/** Process-exit and test-file teardown only; scoped owners close their own captured path. */
export function closeAllRuntimeDatabases(): void {
  const databases = [...openDatabases.entries()];
  openDatabases.clear();
  for (const [key, database] of databases) closeRuntimeDatabaseHandle(key, database);
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
  database: RuntimeDatabase,
  key: string,
  value: string,
): void {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) {
    throw new Error('Runtime metadata key is required.');
  }
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

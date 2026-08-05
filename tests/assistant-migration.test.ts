import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';
import { z } from 'zod';

import { RELATION_TYPES } from '../src/assistant/domain/relation-types.js';
import { NODE_TYPES } from '../src/assistant/domain/node-types.js';
import { LOCAL_OWNER_ID } from '../src/assistant/storage/schema.js';
import {
  CURRENT_SCHEMA_VERSION,
  closeRuntimeDatabase,
  getRuntimeDatabase,
} from '../src/state/runtime-db.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const NameRowSchema = z.array(z.object({ name: z.string() }));
const CountRowSchema = z.object({ count: z.number() });
const VersionRowSchema = z.object({ version: z.number() });

function tempDbPath(prefix: string): string {
  return path.join(createManagedTempDir(prefix), 'runtime.sqlite');
}

function withReadonlyDb<T>(dbPath: string, read: (database: ReturnType<typeof Database>) => T): T {
  const database = new Database(dbPath, { readonly: true });
  try {
    return read(database);
  } finally {
    database.close();
  }
}

function tableNames(dbPath: string): string[] {
  return withReadonlyDb(dbPath, (database) => NameRowSchema
    .parse(database.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all())
    .map((row) => row.name));
}

function countRows(dbPath: string, table: string): number {
  return withReadonlyDb(dbPath, (database) => CountRowSchema
    .parse(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).count);
}

const EXPECTED_ASSISTANT_TABLES = [
  'assistant_owners', 'assistant_devices', 'graph_node_types', 'graph_relation_types',
  'graph_nodes', 'graph_node_aliases', 'evidence_blobs', 'evidence_records', 'observations',
  'candidate_assertions', 'graph_assertions', 'assertion_evidence', 'graph_entity_merges',
  'graph_mutation_log', 'assistant_policies', 'assistant_audit_events',
  'graph_nodes_fts', 'graph_assertions_fts',
];

test('a fresh database lands on the current schema version with every assistant table', () => {
  const dbPath = tempDbPath('siftkit-assistant-migration-fresh-');
  getRuntimeDatabase(dbPath);
  closeRuntimeDatabase();

  assert.equal(CURRENT_SCHEMA_VERSION, 40);
  const version = withReadonlyDb(dbPath, (database) => VersionRowSchema
    .parse(database.prepare('SELECT version FROM runtime_schema WHERE id = 1').get()).version);
  assert.equal(version, 40);

  const tables = new Set(tableNames(dbPath));
  for (const expected of EXPECTED_ASSISTANT_TABLES) {
    assert.ok(tables.has(expected), `missing table ${expected}`);
  }
});

test('registries, the owner row, and the local device row are seeded from TypeScript', () => {
  const dbPath = tempDbPath('siftkit-assistant-migration-seed-');
  getRuntimeDatabase(dbPath);
  closeRuntimeDatabase();

  assert.equal(countRows(dbPath, 'graph_node_types'), NODE_TYPES.length);
  assert.equal(countRows(dbPath, 'graph_relation_types'), RELATION_TYPES.length);
  assert.equal(countRows(dbPath, 'assistant_owners'), 1);
  assert.equal(countRows(dbPath, 'assistant_devices'), 1);

  const ownerId = withReadonlyDb(dbPath, (database) => z.object({ id: z.string() })
    .parse(database.prepare('SELECT id FROM assistant_owners LIMIT 1').get()).id);
  assert.equal(ownerId, LOCAL_OWNER_ID);

  const graphVersion = withReadonlyDb(dbPath, (database) => z.object({ value: z.string() })
    .parse(database.prepare(
      "SELECT value FROM runtime_metadata WHERE key = 'assistant.graph_version'",
    ).get()).value);
  assert.equal(graphVersion, '0');
});

test('re-opening an already-migrated database is a no-op, not a duplicate seed', () => {
  const dbPath = tempDbPath('siftkit-assistant-migration-reapply-');
  getRuntimeDatabase(dbPath);
  closeRuntimeDatabase();
  getRuntimeDatabase(dbPath);
  closeRuntimeDatabase();

  assert.equal(countRows(dbPath, 'graph_node_types'), NODE_TYPES.length);
  assert.equal(countRows(dbPath, 'graph_relation_types'), RELATION_TYPES.length);
  assert.equal(countRows(dbPath, 'assistant_owners'), 1);
  assert.equal(countRows(dbPath, 'assistant_devices'), 1);
});

test('a v38 database upgrades in place and keeps its pre-existing rows', () => {
  const dbPath = tempDbPath('siftkit-assistant-migration-upgrade-');
  const seed = new Database(dbPath);
  seed.exec(`
    CREATE TABLE runtime_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
    INSERT INTO runtime_schema (id, version) VALUES (1, 38);
    CREATE TABLE runtime_metadata (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at_utc TEXT NOT NULL);
    INSERT INTO runtime_metadata (key, value, updated_at_utc)
      VALUES ('carried.over', 'kept', '2026-08-05T00:00:00.000Z');
  `);
  seed.close();

  getRuntimeDatabase(dbPath);
  closeRuntimeDatabase();

  const tables = new Set(tableNames(dbPath));
  assert.ok(tables.has('graph_assertions'));
  assert.ok(tables.has('graph_nodes_fts'));
  const carried = withReadonlyDb(dbPath, (database) => z.object({ value: z.string() })
    .parse(database.prepare("SELECT value FROM runtime_metadata WHERE key = 'carried.over'").get()).value);
  assert.equal(carried, 'kept');
});

test('the relation registry table matches the TypeScript descriptor exactly', () => {
  const dbPath = tempDbPath('siftkit-assistant-migration-descriptor-');
  getRuntimeDatabase(dbPath);
  closeRuntimeDatabase();

  const stored = withReadonlyDb(dbPath, (database) => z.object({ definition_json: z.string() })
    .parse(database.prepare(
      "SELECT definition_json FROM graph_relation_types WHERE name = 'PREFERS'",
    ).get()).definition_json);
  const parsed = z.object({
    predicate: z.string(),
    cardinality: z.string(),
    conflictStrategy: z.string(),
    projectionBehavior: z.string(),
  }).parse(JSON.parse(stored));
  assert.equal(parsed.predicate, 'PREFERS');
  assert.equal(parsed.cardinality, 'single_per_scope');
  assert.equal(parsed.conflictStrategy, 'supersede_current');
  assert.equal(parsed.projectionBehavior, 'core');
});

test('FTS5 virtual tables accept a match query', () => {
  const dbPath = tempDbPath('siftkit-assistant-migration-fts-');
  const database = getRuntimeDatabase(dbPath);
  database.prepare(`
    INSERT INTO graph_nodes_fts (node_id, owner_id, display_name, aliases, description)
    VALUES ('node_1', ?, 'Visual Studio Code', 'vscode', 'code editor')
  `).run(LOCAL_OWNER_ID);
  const hits = z.array(z.object({ node_id: z.string() })).parse(
    database.prepare("SELECT node_id FROM graph_nodes_fts WHERE graph_nodes_fts MATCH 'vscode'").all(),
  );
  closeRuntimeDatabase();
  assert.deepEqual(hits, [{ node_id: 'node_1' }]);
});
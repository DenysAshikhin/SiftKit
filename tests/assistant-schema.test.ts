import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';
import { z } from 'zod';

import { RELATION_TYPES } from '../src/assistant/domain/relation-types.js';
import { NODE_TYPES } from '../src/assistant/domain/node-types.js';
import { JobRowSchema, ProjectionRowSchema } from '../src/assistant/storage/rows.js';
import {
  LOCAL_OWNER_ID,
} from '../src/assistant/storage/schema.js';
import {
  CURRENT_SCHEMA_VERSION,
  closeAllRuntimeDatabases,
  getRuntimeDatabase,
  getSchemaVersion,
} from '../src/state/runtime-db.js';
import { withAssistantContext } from './helpers/assistant-fixture.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const NameRowSchema = z.array(z.object({ name: z.string() }));
const CountRowSchema = z.object({ count: z.number() });
const VersionRowSchema = z.object({ version: z.number() });
const ColumnRowSchema = z.array(z.object({ name: z.string() }));

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
  'assistant_questions', 'assistant_question_feedback', 'retrieval_usage',
  'assistant_activity_events', 'assistant_activity_sessions', 'assistant_capture_queue',
  'assistant_device_nonces',
];

test('a fresh database lands on the current schema version with every assistant table', () => {
  const dbPath = tempDbPath('siftkit-assistant-schema-fresh-');
  getRuntimeDatabase(dbPath);
  closeAllRuntimeDatabases();

  const version = withReadonlyDb(dbPath, (database) => VersionRowSchema
    .parse(database.prepare('SELECT version FROM runtime_schema WHERE id = 1').get()).version);
  assert.equal(version, CURRENT_SCHEMA_VERSION);

  const tables = new Set(tableNames(dbPath));
  for (const expected of EXPECTED_ASSISTANT_TABLES) {
    assert.ok(tables.has(expected), `missing table ${expected}`);
  }
});

test('current schema contains proactive assistant fields and question constraints', () => {
  withAssistantContext(({ database, ownerId }) => {
    const appConfigColumns = ColumnRowSchema.parse(
      database.prepare("SELECT name FROM pragma_table_info('app_config')").all(),
    ).map((row) => row.name);
    const assertionColumns = ColumnRowSchema.parse(
      database.prepare("SELECT name FROM pragma_table_info('graph_assertions')").all(),
    ).map((row) => row.name);
    const candidateColumns = ColumnRowSchema.parse(
      database.prepare("SELECT name FROM pragma_table_info('candidate_assertions')").all(),
    ).map((row) => row.name);

    assert.ok(appConfigColumns.includes('assistant_json'));
    assert.ok(assertionColumns.includes('user_demoted'));
    assert.ok(candidateColumns.includes('user_notes'));
    assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);

    assert.throws(() => database.prepare(`
      INSERT INTO assistant_questions (
        id, owner_id, topic_key, question_text, question_type, candidate_ids_json,
        expected_value, interruption_cost, status, created_at_utc, updated_at_utc
      ) VALUES ('question_bad', ?, 'topic', 'Question?', 'unknown', '[]', 1, 0,
        'planned', '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z')
    `).run(ownerId), /CHECK constraint failed/);
  });
});

test('registries, the owner row, and the local device row are seeded from TypeScript', () => {
  const dbPath = tempDbPath('siftkit-assistant-schema-seed-');
  getRuntimeDatabase(dbPath);
  closeAllRuntimeDatabases();

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

test('reopening a current database does not duplicate seeded rows', () => {
  const dbPath = tempDbPath('siftkit-assistant-schema-reapply-');
  getRuntimeDatabase(dbPath);
  closeAllRuntimeDatabases();
  getRuntimeDatabase(dbPath);
  closeAllRuntimeDatabases();

  assert.equal(countRows(dbPath, 'graph_node_types'), NODE_TYPES.length);
  assert.equal(countRows(dbPath, 'graph_relation_types'), RELATION_TYPES.length);
  assert.equal(countRows(dbPath, 'assistant_owners'), 1);
  assert.equal(countRows(dbPath, 'assistant_devices'), 1);
});

test('the relation registry table matches the TypeScript descriptor exactly', () => {
  const dbPath = tempDbPath('siftkit-assistant-schema-descriptor-');
  getRuntimeDatabase(dbPath);
  closeAllRuntimeDatabases();

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
  const dbPath = tempDbPath('siftkit-assistant-schema-fts-');
  const database = getRuntimeDatabase(dbPath);
  database.prepare(`
    INSERT INTO graph_nodes_fts (node_id, owner_id, display_name, aliases, description)
    VALUES ('node_1', ?, 'Visual Studio Code', 'vscode', 'code editor')
  `).run(LOCAL_OWNER_ID);
  const hits = z.array(z.object({ node_id: z.string() })).parse(
    database.prepare("SELECT node_id FROM graph_nodes_fts WHERE graph_nodes_fts MATCH 'vscode'").all(),
  );
  closeAllRuntimeDatabases();
  assert.deepEqual(hits, [{ node_id: 'node_1' }]);
});

test('current schema contains projection, job, and projection search tables', () => {
  withAssistantContext(({ database }) => {
    const tables = z.array(z.object({ name: z.string() })).parse(
      database.prepare("SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name").all(),
    ).map((row) => row.name);
    assert.ok(tables.includes('memory_projections'), 'memory_projections missing');
    assert.ok(tables.includes('assistant_jobs'), 'assistant_jobs missing');
    assert.ok(tables.includes('memory_projections_fts'), 'memory_projections_fts missing');
    assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
  });
});

test('memory_projections is unique per owner, tier, and topic', () => {
  withAssistantContext(({ database, ownerId }) => {
    const insert = database.prepare(`
      INSERT INTO memory_projections (
        id, owner_id, tier, topic_key, relative_path, title, content, content_hash,
        token_count, tokenizer_id, graph_version, included_assertion_ids_json, sensitivity,
        generated_at_utc, last_retrieved_at_utc, retrieval_count, utility_score, status
      ) VALUES (?, ?, 2, 'siftkit', 'tier2/siftkit.md', 'SiftKit', '#', 'hash',
        1, 'estimate', 1, '[]', 'personal', '2026-08-05T09:00:00.000Z', NULL, 0, 0.0, 'active')
    `);
    insert.run('memproj_a', ownerId);
    assert.throws(() => insert.run('memproj_b', ownerId), /UNIQUE/);
  });
});

test('assistant_jobs rejects a duplicate pending idempotency key but allows it once completed', () => {
  withAssistantContext(({ database, ownerId }) => {
    const insert = database.prepare(`
      INSERT INTO assistant_jobs (
        id, owner_id, job_type, priority, payload_json, idempotency_key, status,
        attempts, max_attempts, available_at_utc, lease_owner, lease_expires_at_utc,
        last_error, created_at_utc, updated_at_utc
      ) VALUES (?, ?, 'conversation_ingestion', 800, '{}', 'evid_1', ?, 0, 3,
        '2026-08-05T09:00:00.000Z', NULL, NULL, NULL,
        '2026-08-05T09:00:00.000Z', '2026-08-05T09:00:00.000Z')
    `);
    insert.run('job_a', ownerId, 'queued');
    assert.throws(() => insert.run('job_b', ownerId, 'queued'), /UNIQUE/);
    database.prepare("UPDATE assistant_jobs SET status = 'completed' WHERE id = 'job_a'").run();
    insert.run('job_c', ownerId, 'queued');
    assert.equal(
      z.object({ count: z.number() }).parse(
        database.prepare('SELECT COUNT(*) AS count FROM assistant_jobs').get(),
      ).count,
      2,
    );
  });
});

test('projection and job row schemas parse the shapes SQLite returns', () => {
  withAssistantContext(({ database, ownerId }) => {
    database.prepare(`
      INSERT INTO memory_projections (
        id, owner_id, tier, topic_key, relative_path, title, content, content_hash,
        token_count, tokenizer_id, graph_version, included_assertion_ids_json, sensitivity,
        generated_at_utc, last_retrieved_at_utc, retrieval_count, utility_score, status
      ) VALUES ('memproj_1', ?, 1, 'profile', 'tier1/profile.md', 'Profile', '# Profile',
        'hash', 12, 'estimate', 3, '["ast_1"]', 'personal',
        '2026-08-05T09:00:00.000Z', NULL, 0, 1.5, 'active')
    `).run(ownerId);
    const projection = ProjectionRowSchema.parse(
      database.prepare('SELECT * FROM memory_projections WHERE id = ?').get('memproj_1'),
    );
    assert.equal(projection.tier, 1);
    assert.equal(projection.last_retrieved_at_utc, null);
    assert.equal(projection.utility_score, 1.5);

    database.prepare(`
      INSERT INTO assistant_jobs (
        id, owner_id, job_type, priority, payload_json, idempotency_key, status,
        attempts, max_attempts, available_at_utc, lease_owner, lease_expires_at_utc,
        last_error, created_at_utc, updated_at_utc
      ) VALUES ('job_1', ?, 'conversation_ingestion', 800, '{"evidenceId":"evid_1"}', 'evid_1',
        'queued', 0, 3, '2026-08-05T09:00:00.000Z', NULL, NULL, NULL,
        '2026-08-05T09:00:00.000Z', '2026-08-05T09:00:00.000Z')
    `).run(ownerId);
    const job = JobRowSchema.parse(
      database.prepare('SELECT * FROM assistant_jobs WHERE id = ?').get('job_1'),
    );
    assert.equal(job.job_type, 'conversation_ingestion');
    assert.equal(job.status, 'queued');
    assert.equal(job.lease_owner, null);
  });
});

test('desktop observation tables enforce current constraints and indexes', () => {
  withAssistantContext(({ database, ownerId }) => {
    assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);

    const indexes = NameRowSchema.parse(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index'",
    ).all()).map((row) => row.name);
    for (const expected of [
      'assistant_activity_events_time_idx',
      'assistant_capture_queue_state_idx',
      'assistant_capture_queue_dedupe_idx',
    ]) {
      assert.ok(indexes.includes(expected), `missing index ${expected}`);
    }

    database.prepare(`
      INSERT INTO assistant_activity_sessions (
        id, owner_id, application_id, process_name, started_at_utc, ended_at_utc, event_count
      ) VALUES ('asess_1', ?, 'app:code', 'Code.exe', '2026-08-10T09:00:00.000Z', NULL, 0)
    `).run(ownerId);
    database.prepare(`
      INSERT INTO assistant_activity_events (
        id, owner_id, captured_at_utc, application_id, process_name, normalized_title,
        fullscreen, mouse_idle_seconds, keyboard_idle_seconds, session_locked, session_id
      ) VALUES ('aevt_1', ?, '2026-08-10T09:00:00.000Z', 'app:code', 'Code.exe', 'SiftKit',
        0, 4, 9, 0, 'asess_1')
    `).run(ownerId);
    assert.throws(() => database.prepare(`
      INSERT INTO assistant_activity_events (
        id, owner_id, captured_at_utc, application_id, process_name, normalized_title,
        fullscreen, mouse_idle_seconds, keyboard_idle_seconds, session_locked, session_id
      ) VALUES ('aevt_bad', ?, '2026-08-10T09:00:00.000Z', NULL, NULL, NULL, 0, -1, 0, 0, NULL)
    `).run(ownerId), /CHECK constraint failed/);

    assert.throws(() => database.prepare(`
      INSERT INTO assistant_capture_queue (
        evidence_id, owner_id, state, foreground_context_key, pixel_sha256, perceptual_hash,
        byte_length, enqueued_at_utc, processed_at_utc, updated_at_utc
      ) VALUES ('ev_missing', ?, 'invented_state', 'app:code', 'a', 'b', 1,
        '2026-08-10T09:00:00.000Z', NULL, '2026-08-10T09:00:00.000Z')
    `).run(ownerId), /CHECK constraint failed|FOREIGN KEY constraint failed/);
  });
});

test('device nonce table enforces replay protection and device references', () => {
  withAssistantContext(({ database, ownerId }) => {
    assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);

    const columns = ColumnRowSchema.parse(
      database.prepare("SELECT name FROM pragma_table_info('assistant_device_nonces')").all(),
    ).map((row) => row.name);
    assert.deepEqual(columns, ['device_id', 'nonce', 'monotonic_ts', 'seen_at_utc']);

    const indexes = NameRowSchema.parse(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index'",
    ).all()).map((row) => row.name);
    assert.ok(indexes.includes('assistant_device_nonces_ts_idx'));

    const deviceId = z.object({ id: z.string() }).parse(
      database.prepare('SELECT id FROM assistant_devices WHERE owner_id = ? LIMIT 1').get(ownerId),
    ).id;
    const insert = database.prepare(`
      INSERT INTO assistant_device_nonces (device_id, nonce, monotonic_ts, seen_at_utc)
      VALUES (?, 'nonce-1', 1000, '2026-08-13T00:00:00.000Z')
    `);
    insert.run(deviceId);
    assert.throws(() => insert.run(deviceId), /UNIQUE/);
    assert.throws(() => database.prepare(`
      INSERT INTO assistant_device_nonces (device_id, nonce, monotonic_ts, seen_at_utc)
      VALUES ('dev_missing', 'nonce-2', 1001, '2026-08-13T00:00:00.000Z')
    `).run(), /FOREIGN KEY constraint failed/);
  });
});

test('current schema contains query indexes and FTS rowid mappings', () => {
  withAssistantContext(({ database }) => {
    const indexes = NameRowSchema.parse(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index'",
    ).all()).map((row) => row.name);
    for (const expected of [
      'assertion_evidence_evidence_idx',
      'evidence_blob_ref_idx',
      'assistant_audit_events_owner_time_idx',
      'graph_mutation_owner_time_idx',
      'assistant_activity_events_session_idx',
      'assistant_activity_sessions_open_idx',
      'assistant_capture_queue_pixel_idx',
    ]) {
      assert.ok(indexes.includes(expected), `missing index ${expected}`);
    }
    for (const table of ['graph_nodes', 'graph_assertions', 'memory_projections']) {
      const columns = ColumnRowSchema.parse(
        database.prepare(`SELECT name FROM pragma_table_info('${table}')`).all(),
      ).map((row) => row.name);
      assert.ok(columns.includes('fts_rowid'), `${table} missing fts_rowid`);
    }
  });
});

test('assistant lookups use their query indexes', () => {
  withAssistantContext(({ database }) => {
    const plans: Array<{ sql: string; index: string }> = [
      {
        sql: "SELECT DISTINCT assertion_id FROM assertion_evidence WHERE evidence_id = 'x'",
        index: 'assertion_evidence_evidence_idx',
      },
      {
        sql: "SELECT COUNT(*) FROM evidence_records WHERE blob_id = 'x' AND status NOT IN ('deleted','expired')",
        index: 'evidence_blob_ref_idx',
      },
      {
        sql: "SELECT * FROM assistant_audit_events WHERE owner_id = 'x' ORDER BY created_at_utc DESC, id DESC LIMIT 50",
        index: 'assistant_audit_events_owner_time_idx',
      },
      {
        sql: "SELECT * FROM graph_mutation_log WHERE owner_id = 'x' ORDER BY created_at_utc DESC, id DESC LIMIT 50",
        index: 'graph_mutation_owner_time_idx',
      },
      {
        sql: "SELECT captured_at_utc FROM assistant_activity_events WHERE session_id = 'x' ORDER BY captured_at_utc DESC, id DESC LIMIT 1",
        index: 'assistant_activity_events_session_idx',
      },
      {
        sql: "SELECT * FROM assistant_activity_sessions WHERE owner_id = 'x' AND ended_at_utc IS NULL ORDER BY started_at_utc DESC, id DESC LIMIT 1",
        index: 'assistant_activity_sessions_open_idx',
      },
      {
        sql: "SELECT * FROM assistant_capture_queue WHERE owner_id = 'x' AND pixel_sha256 = 'y' AND enqueued_at_utc >= 'z' ORDER BY enqueued_at_utc DESC LIMIT 1",
        index: 'assistant_capture_queue_pixel_idx',
      },
    ];
    for (const { sql, index } of plans) {
      const detail = z.array(z.object({ detail: z.string() })).parse(
        database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(),
      ).map((row) => row.detail).join(' | ');
      assert.ok(detail.includes(index), `expected ${index} in plan: ${detail}`);
    }
  });
});

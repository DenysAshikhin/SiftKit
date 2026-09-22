import assert from 'node:assert/strict';
import path from 'node:path';
import Database from 'better-sqlite3';
import test from 'node:test';

import { z } from '../src/lib/zod.js';
import { type JsonValue } from '../src/lib/json-types.js';
import { ChatJournalStore } from '../src/state/chat-journal.js';
import { digestStableJson } from '../src/lib/json-digest.js';
import { CHAT_JOURNAL_EVENT_VERSION } from '../src/state/chat-journal-schema.js';
import { closeAllRuntimeDatabases, CURRENT_SCHEMA_VERSION, getRuntimeDatabase, getSchemaVersion } from '../src/state/runtime-db.js';
import type { RuntimeDatabase } from '../src/state/runtime-db.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const AT = '2026-09-17T13:35:02.574Z';
const OPERATION_ID = '93713285-9e64-4beb-afcb-a24c6a3aedba';
const SELECT_ROWS = 'SELECT operation_id, sequence, event_id, version, recorded_at_utc, kind, body_json, payload_digest FROM chat_run_events ORDER BY operation_id, sequence';

const EventRowsSchema = z.array(z.object({
  operation_id: z.string(), sequence: z.number(), event_id: z.string(), version: z.number(),
  recorded_at_utc: z.string(), kind: z.string(), body_json: z.string(), payload_digest: z.string(),
}));
type EventRow = z.infer<typeof EventRowsSchema>[number];

function row(sequence: number, kind: string, body: JsonValue): EventRow {
  return { operation_id: OPERATION_ID, sequence, event_id: `${OPERATION_ID}:${String(sequence)}`, version: CHAT_JOURNAL_EVENT_VERSION,
    recorded_at_utc: AT, kind, body_json: JSON.stringify(body), payload_digest: digestStableJson(body) };
}

/** Exactly what the pre-delta-batching build wrote for a progress update: the whole bar text every time. */
const LEGACY_PROGRESS = { kind: 'display', event: { kind: 'progress', progress: { turn: 1, text: '\n\nConfirmed', elapsedMs: 71796 } } };
const UPGRADED_PROGRESS = { kind: 'display', event: { kind: 'progress', delta: { turn: 1, offset: 0, text: '\n\nConfirmed' } } };
const THINKING = { kind: 'display', event: { kind: 'thinking', delta: { turn: 1, offset: 5203, text: ' + fix.\n' } } };
const DELTA_PROGRESS = { kind: 'display', event: { kind: 'progress', delta: { turn: 2, offset: 4, text: 'more' } } };
/** A non-progress display row whose text merely contains the progress marker; the prefilter must not touch it. */
const NARRATION_WITH_MARKER = { kind: 'display', event: { kind: 'narration', delta: { turn: 1, offset: 0, text: '{"kind":"progress"}' } } };
const STOP = { kind: 'stop_requested', requestedAtUtc: AT };

function fixtureRows(): EventRow[] {
  return [row(1, 'display', LEGACY_PROGRESS), row(2, 'display', THINKING), row(3, 'display', DELTA_PROGRESS), row(4, 'display', NARRATION_WITH_MARKER), row(5, 'stop_requested', STOP)];
}

/** A marker-73 database whose journal rows are exactly what the pre-delta-batching build wrote. */
function seedMarker73(prefix: string, rows: EventRow[]): string {
  const dbPath = path.join(createManagedTempDir(prefix), 'runtime.sqlite');
  const database = getRuntimeDatabase(dbPath);
  database.exec(`
    INSERT INTO chat_sessions (id, title, model_preset_id, model_preset_json, thinking_enabled, web_search_enabled, preset_id, mode, plan_repo_root, created_at_utc, updated_at_utc)
      VALUES ('s1', 'Session', 'preset-a', '{}', 1, 0, 'chat', 'chat', 'C:/repo', '${AT}', '${AT}');
    INSERT INTO chat_runs (operation_id, session_id, record_kind, operation_kind, run_order, owner_epoch, created_at_utc, updated_at_utc, terminal_cause, latest_sequence)
      VALUES ('${OPERATION_ID}', 's1', 'execution', 'repo-agent', 1, 'owner:1', '${AT}', '${AT}', 'completed', ${String(rows.length)});
  `);
  const insert = database.prepare(`INSERT INTO chat_run_events (operation_id, sequence, event_id, version, recorded_at_utc, kind, body_json, payload_digest)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of rows) insert.run(r.operation_id, r.sequence, r.event_id, r.version, r.recorded_at_utc, r.kind, r.body_json, r.payload_digest);
  database.exec('UPDATE runtime_schema SET version = 73 WHERE id = 1');
  closeAllRuntimeDatabases();
  return dbPath;
}

function readRows(database: RuntimeDatabase): EventRow[] {
  return EventRowsSchema.parse(database.prepare(SELECT_ROWS).all());
}

test('the marker-73 upgrade rewrites legacy progress payloads as offset-0 deltas and leaves every other row alone', () => {
  const before = fixtureRows();
  const dbPath = seedMarker73('siftkit-runtime-schema-upgrade-73-progress-', before);
  try {
    const database = getRuntimeDatabase(dbPath);
    assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
    assert.equal(CURRENT_SCHEMA_VERSION, 75);
    const after = readRows(database);
    assert.equal(after.length, before.length);
    assert.deepEqual(JSON.parse(after[0].body_json), UPGRADED_PROGRESS);
    assert.equal(after[0].payload_digest, digestStableJson(UPGRADED_PROGRESS));
    assert.equal(after[0].version, CHAT_JOURNAL_EVENT_VERSION);
    assert.equal(after[0].kind, 'display');
    assert.equal(after[0].event_id, before[0].event_id);
    assert.equal(after[0].recorded_at_utc, before[0].recorded_at_utc);
    assert.deepEqual(after.slice(1), before.slice(1));
    const events = [...new ChatJournalStore(database).readAll(OPERATION_ID)].map(envelope => envelope.event);
    assert.deepEqual(events, [UPGRADED_PROGRESS, THINKING, DELTA_PROGRESS, NARRATION_WITH_MARKER, STOP]);
  } finally {
    closeAllRuntimeDatabases();
  }
});

test('a progress row that fits neither shape rolls the marker-73 upgrade back without touching any row', () => {
  const rows = fixtureRows().map(r => r.sequence === 1 ? row(1, 'display', { kind: 'display', event: { kind: 'progress', progress: { turn: 1 } } }) : r);
  const dbPath = seedMarker73('siftkit-runtime-schema-upgrade-73-invalid-', rows);
  try {
    assert.throws(() => getRuntimeDatabase(dbPath), /invalid progress payload/u);
    const raw = new Database(dbPath);
    try {
      assert.equal(z.object({ version: z.number() }).parse(raw.prepare('SELECT version FROM runtime_schema WHERE id = 1').get()).version, 73);
      assert.deepEqual(EventRowsSchema.parse(raw.prepare(SELECT_ROWS).all()), rows);
    } finally {
      raw.close();
    }
  } finally {
    closeAllRuntimeDatabases();
  }
});

test('a corrupt digest on a legacy progress row rejects the marker-73 upgrade', () => {
  const rows = fixtureRows().map(r => r.sequence === 1 ? { ...r, payload_digest: 'corrupt' } : r);
  const dbPath = seedMarker73('siftkit-runtime-schema-upgrade-73-corrupt-', rows);
  try {
    assert.throws(() => getRuntimeDatabase(dbPath), /corrupt payload digest/u);
  } finally {
    closeAllRuntimeDatabases();
  }
});
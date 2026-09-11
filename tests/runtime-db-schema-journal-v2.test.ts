import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import test from 'node:test';

import { z } from '../src/lib/zod.js';
import { stableStringify } from '../src/lib/json.js';
import { JsonObjectSchema, JsonValueSchema, type JsonValue } from '../src/lib/json-types.js';
import { ChatJournalStore } from '../src/state/chat-journal.js';
import { CHAT_JOURNAL_EVENT_VERSION, type ChatJournalEvent } from '../src/state/chat-journal-schema.js';
import { closeAllRuntimeDatabases, CURRENT_SCHEMA_VERSION, getRuntimeDatabase, getSchemaVersion } from '../src/state/runtime-db.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const AT = '2026-09-10T11:00:00.000Z';
const OPERATION_ID = '1a4e9b3c-6d2f-4c8a-9e1b-2f3c4d5e6f70';
const CONDENSE_ID = '2b5f0c4d-7e3a-4d9b-8f2c-3a4b5c6d7e81';

const EventRowsSchema = z.array(z.object({
  operation_id: z.string(), sequence: z.number(), event_id: z.string(), version: z.number(),
  recorded_at_utc: z.string(), kind: z.string(), body_json: z.string(), payload_digest: z.string(),
}));
type EventRow = z.infer<typeof EventRowsSchema>[number];

/** The digest algorithm the journal has always used: sha256 over a stable JSON serialization. */
function digest(body: JsonValue): string {
  return createHash('sha256').update(stableStringify(body)).digest('hex');
}

/** Historical v1 bodies: current events minus the field version 2 introduced. */
function toLegacyBody(event: ChatJournalEvent): JsonValue {
  if (event.kind !== 'context_spliced') return JsonValueSchema.parse(event);
  const { coalescedToolCallIds: _added, ...legacy } = event;
  return JsonValueSchema.parse(legacy);
}

function journalFixture(): ChatJournalEvent[] {
  const image = 'data:image/png;base64,AAAA';
  const call = { toolCallId: 'call_a', displayToolCallId: 'display_a', batchId: 'batch-1', turn: 1, indexInBatch: 0 };
  return [
    { kind: 'baseline_imported', messages: [{ id: 'legacy-1', role: 'user', kind: 'user_text', content: 'legacy', images: [image],
      inputTokensEstimate: 1, outputTokensEstimate: 0, thinkingTokens: 0, createdAtUtc: AT }],
      retainedContext: [{ role: 'user', content: 'legacy', chatMessageId: 'legacy-1' }],
      provenance: { sourceKind: 'saved_chat', sourceId: 'legacy', importerVersion: 1, sourceDigest: 'digest' } },
    { kind: 'run_started', sessionId: 's1', operationKind: 'repo-agent', runOrder: 1, userMessageId: 'user-1', content: 'question',
      images: [], imageMeta: [], retainedHistoryRevision: 0,
      settings: { operationKind: 'repo-agent', mode: 'repo-search', presetId: 'repo-agent', modelPresetId: 'preset-a', model: 'model-a',
        repoRoot: 'C:/repo', approval: 'interactive', maxTurns: 10, thinkingEnabled: true, webSearchEnabled: false, contextWindowTokens: 4096 } },
    { kind: 'context_initialized', contextRevision: 0, turnBoundary: 1, messages: [{ role: 'user', content: 'question', chatMessageId: 'user-1' }] },
    { kind: 'tool_proposed', call, toolName: 'read', arguments: { path: 'file' }, command: 'read file', activityKind: 'read',
      activitySubject: { kind: 'file', value: 'file' }, maxTurns: 10, promptTokenCount: 1, executionState: 'proposed' },
    { kind: 'context_spliced', expectedRevision: 0, contextRevision: 1, startIndex: 1, deleteCount: 0, turnBoundary: 1, reason: 'append',
      coalescedToolCallIds: [], inserted: [{ role: 'assistant', content: '', tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'read', arguments: '{}' } }] }] },
    { kind: 'context_spliced', expectedRevision: 1, contextRevision: 2, startIndex: 0, deleteCount: 2, turnBoundary: 0, reason: 'compacted',
      coalescedToolCallIds: [], compressedMessageIds: ['user-1'], queueMessageIds: ['queued-1'], inserted: [{ role: 'assistant', content: 'summary' }] },
    { kind: 'history_revised', expectedSessionRevision: 0, revision: { action: 'image_removed', messageId: 'legacy-1', imageIndex: 0,
      originalImageIndex: 0, imagePathKey: null, payloadDigest: createHash('sha256').update(image).digest('hex') } },
    { kind: 'run_finished', terminalCause: 'server_restart', detail: 'server stopped', usage: null, recoveryStatus: 'recovery_needed', finishedAtUtc: AT },
  ];
}

/** A marker-70 database whose journal rows carry version-1 bodies exactly as that build wrote them. */
function seedLegacyJournal(prefix: string, mutate: (rows: EventRow[]) => EventRow[] = rows => rows): { dbPath: string; rows: EventRow[] } {
  const dbPath = path.join(createManagedTempDir(prefix), 'runtime.sqlite');
  const database = getRuntimeDatabase(dbPath);
  database.exec(`
    INSERT INTO chat_sessions (id, title, model_preset_id, model_preset_json, thinking_enabled, web_search_enabled, preset_id, mode, plan_repo_root, created_at_utc, updated_at_utc)
      VALUES ('s1', 'Session', 'preset-a', '{}', 1, 0, 'chat', 'chat', 'C:/repo', '${AT}', '${AT}');
    INSERT INTO chat_runs (operation_id, session_id, record_kind, operation_kind, run_order, owner_epoch, created_at_utc, updated_at_utc, terminal_cause, latest_sequence)
      VALUES ('${OPERATION_ID}', 's1', 'execution', 'repo-agent', 1, 'owner:1', '${AT}', '${AT}', 'server_restart', 8),
             ('${CONDENSE_ID}', 's1', 'execution', 'condense', 2, 'owner:1', '${AT}', '${AT}', NULL, 1);
  `);
  const rows = mutate([
    ...journalFixture().map((event, index): EventRow => {
      const body = toLegacyBody(event);
      return { operation_id: OPERATION_ID, sequence: index + 1, event_id: `${OPERATION_ID}:${String(index + 1)}`, version: 1,
        recorded_at_utc: AT, kind: event.kind, body_json: JSON.stringify(body), payload_digest: digest(body) };
    }),
    { operation_id: CONDENSE_ID, sequence: 1, event_id: 'stop', version: 1, recorded_at_utc: AT, kind: 'stop_requested',
      body_json: JSON.stringify({ kind: 'stop_requested', requestedAtUtc: AT }), payload_digest: digest({ kind: 'stop_requested', requestedAtUtc: AT }) },
  ]);
  const insert = database.prepare(`INSERT INTO chat_run_events (operation_id, sequence, event_id, version, recorded_at_utc, kind, body_json, payload_digest)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of rows) insert.run(row.operation_id, row.sequence, row.event_id, row.version, row.recorded_at_utc, row.kind, row.body_json, row.payload_digest);
  database.exec('UPDATE runtime_schema SET version = 70 WHERE id = 1');
  closeAllRuntimeDatabases();
  return { dbPath, rows };
}

function readRows(dbPath: string): EventRow[] {
  return EventRowsSchema.parse(getRuntimeDatabase(dbPath).prepare(
    'SELECT operation_id, sequence, event_id, version, recorded_at_utc, kind, body_json, payload_digest FROM chat_run_events ORDER BY operation_id, sequence',
  ).all());
}

test('the marker-70 upgrade converts version-1 journal events to version 2 and adds only the coalescing list', () => {
  const { dbPath, rows: before } = seedLegacyJournal('siftkit-runtime-schema-upgrade-70-journal-');
  try {
    const database = getRuntimeDatabase(dbPath);
    assert.equal(getSchemaVersion(database), 71);
    assert.equal(CURRENT_SCHEMA_VERSION, 71);
    assert.equal(CHAT_JOURNAL_EVENT_VERSION, 2);
    assert.equal(database.prepare("SELECT name FROM sqlite_schema WHERE name='chat_context_snapshots'").get(), undefined);
    const after = readRows(dbPath);
    assert.equal(after.length, before.length);
    for (const [index, row] of after.entries()) {
      const legacy = before[index];
      assert.equal(row.version, 2);
      assert.equal(row.operation_id, legacy.operation_id);
      assert.equal(row.sequence, legacy.sequence);
      assert.equal(row.event_id, legacy.event_id);
      assert.equal(row.recorded_at_utc, legacy.recorded_at_utc);
      assert.equal(row.kind, legacy.kind);
      const body = JsonValueSchema.parse(JSON.parse(row.body_json));
      assert.equal(row.payload_digest, digest(body));
      if (row.kind === 'context_spliced') {
        assert.deepEqual(body, { ...JsonObjectSchema.parse(JSON.parse(legacy.body_json)), coalescedToolCallIds: [] });
      } else {
        assert.equal(row.body_json, legacy.body_json);
        assert.equal(row.payload_digest, legacy.payload_digest);
      }
    }
    const store = new ChatJournalStore(database);
    const events = [...store.readAll(OPERATION_ID)];
    assert.equal(events.length, journalFixture().length);
    for (const envelope of events) {
      assert.equal(envelope.version, 2);
      if (envelope.event.kind === 'context_spliced') assert.deepEqual(envelope.event.coalescedToolCallIds, []);
    }
    assert.deepEqual(events.map(envelope => envelope.event), journalFixture());
    assert.equal(store.readRun(OPERATION_ID)?.terminalCause, 'server_restart');
    assert.equal([...store.readAll(CONDENSE_ID)][0]?.event.kind, 'stop_requested');
  } finally {
    closeAllRuntimeDatabases();
  }
});

test('a corrupt version-1 digest rolls the marker-70 upgrade back without touching any row', () => {
  const { dbPath, rows } = seedLegacyJournal('siftkit-runtime-schema-upgrade-70-corrupt-', seeded => seeded.map(row => row.sequence === 5 && row.operation_id === OPERATION_ID
    ? { ...row, payload_digest: 'corrupt' } : row));
  try {
    assert.throws(() => getRuntimeDatabase(dbPath), /corrupt payload digest/u);
    const raw = new Database(dbPath);
    try {
      assert.equal(z.object({ version: z.number() }).parse(raw.prepare('SELECT version FROM runtime_schema WHERE id = 1').get()).version, 70);
      assert.deepEqual(EventRowsSchema.parse(raw.prepare(
        'SELECT operation_id, sequence, event_id, version, recorded_at_utc, kind, body_json, payload_digest FROM chat_run_events ORDER BY operation_id, sequence',
      ).all()), rows);
    } finally {
      raw.close();
    }
  } finally {
    closeAllRuntimeDatabases();
  }
});

test('an unknown journal event version rejects the marker-70 upgrade', () => {
  const { dbPath } = seedLegacyJournal('siftkit-runtime-schema-upgrade-70-unknown-', seeded => seeded.map(row => row.sequence === 1 ? { ...row, version: 7 } : row));
  try {
    assert.throws(() => getRuntimeDatabase(dbPath), /unsupported version 7/u);
  } finally {
    closeAllRuntimeDatabases();
  }
});

test('the current reader rejects version-1 rows and version-2 splices missing the coalescing list', () => {
  const dbPath = path.join(createManagedTempDir('siftkit-runtime-schema-journal-v2-reader-'), 'runtime.sqlite');
  try {
    const database = getRuntimeDatabase(dbPath);
    database.exec(`
      INSERT INTO chat_sessions (id, title, model_preset_id, model_preset_json, thinking_enabled, web_search_enabled, preset_id, mode, plan_repo_root, created_at_utc, updated_at_utc)
        VALUES ('s1', 'Session', 'preset-a', '{}', 1, 0, 'chat', 'chat', 'C:/repo', '${AT}', '${AT}');
      INSERT INTO chat_runs (operation_id, session_id, record_kind, operation_kind, run_order, owner_epoch, created_at_utc, updated_at_utc, terminal_cause, latest_sequence)
        VALUES ('${OPERATION_ID}', 's1', 'execution', 'repo-agent', 1, 'owner:1', '${AT}', '${AT}', 'completed', 2);
    `);
    const legacySplice = toLegacyBody(journalFixture()[4]);
    const stop = { kind: 'stop_requested', requestedAtUtc: AT };
    const insert = database.prepare(`INSERT INTO chat_run_events (operation_id, sequence, event_id, version, recorded_at_utc, kind, body_json, payload_digest)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run(OPERATION_ID, 1, 'e1', 1, AT, 'stop_requested', JSON.stringify(stop), digest(stop));
    insert.run(OPERATION_ID, 2, 'e2', 2, AT, 'context_spliced', JSON.stringify(legacySplice), digest(legacySplice));
    const store = new ChatJournalStore(database);
    assert.throws(() => store.readAfter(OPERATION_ID, 0, 1), /unsupported version 1/u);
    assert.throws(() => store.readAfter(OPERATION_ID, 1, 1), /malformed event payload/u);
  } finally {
    closeAllRuntimeDatabases();
  }
});

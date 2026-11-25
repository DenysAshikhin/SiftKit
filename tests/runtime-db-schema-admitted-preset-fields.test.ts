import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { parseJsonObjectText } from '../src/lib/json.ts';
import { JsonObjectSchema, type JsonObject } from '../src/lib/json-types.ts';
import { digestStableJson } from '../src/lib/json-digest.ts';
import { upgradeModelPresetRamDisk } from '../src/state/schema-upgrades/model-preset-ram-disk.ts';
import { z } from '../src/lib/zod.ts';
import { ChatJournalStore } from '../src/state/chat-journal.ts';
import { CHAT_JOURNAL_EVENT_VERSION } from '../src/state/chat-journal-schema.ts';
import { CURRENT_SCHEMA_VERSION, closeAllRuntimeDatabases, getRuntimeDatabase, getSchemaVersion } from '../src/state/runtime-db.ts';
import { withRuntimeDatabaseConnection } from './helpers/runtime-database-probe.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

const AT = '2026-09-27T18:05:20.978Z';
const OPERATION_ID = '85977ac4-1f17-4ed5-a2c5-11d72b87d174';

// Frozen as the September build wrote it. A preset field added without upgrading saved runs fails these tests.
const SEPTEMBER_PRESET = {
  id: 'exl3-next', label: 'Next', Backend: 'exl3', Model: 'Next-4.00bpw', ExternalServerEnabled: false, BaseUrl: 'http://127.0.0.1:8098',
  ModelPath: 'D:\\models\\Next-4.00bpw', NumCtx: 165_000, CompactionReserveTokens: 20_000, NcpuMoe: 408, ParallelSlots: 1, UBatchSize: 2048,
  CacheRam: 0, CacheRecurrentRam: 4096, NgramRam: false, KvCacheQuantization: 'q8_0', Temperature: 1, TopP: 0.95, TopK: 20, MinP: 0,
  PresencePenalty: 0, RepetitionPenalty: 1, Reasoning: 'on', ReasoningEffort: 'xhigh', ReasoningContent: true, PreserveThinking: true,
  MaintainPerStepThinking: true, SpeculativeEnabled: false, SpeculativeDraftMax: 1, SpeculativeDynamic: true, ReasoningBudget: 100_000,
  ReasoningBudgetMessage: 'Answer now.', StartupTimeoutMs: 600_000, HealthcheckTimeoutMs: 2000, HealthcheckIntervalMs: 1000,
  SleepIdleSeconds: 600, IdleAction: 'none', VisionEnabled: true, VisionOffload: true, VisionImageRetention: 8, VisionMaxImagePixels: 0,
} satisfies JsonObject;
/** What a run admitted before each setting existed ran with: off, at sizes that were never used. */
const ADDED_FIELDS = {
  ReviewerSlot: false, CacheAuto: false, CacheContexts: 1.1, DiskCacheDir: null, DiskCacheSizeMiB: 51_200, DiskCacheCheckpointInterval: 2048,
  RamDiskCache: false, RamDiskCacheGiB: 10, HybridDraftTokens: 0, SparseDraftHead: 0, UnlockAllSettings: false,
} satisfies JsonObject;

function admitted(modelPreset: JsonObject): JsonObject {
  return { kind: 'model_admitted', modelPreset, contextWindowTokens: 165_000 };
}

/** A schema-99 file whose one run holds these events, each with its own digest unless one is given. */
function seedSchema99(events: ReadonlyArray<{ body: JsonObject; digest?: string }>): string {
  const dbPath = path.join(createManagedTempDir('siftkit-admitted-preset-'), 'runtime.sqlite');
  const database = getRuntimeDatabase(dbPath);
  database.exec(`
    INSERT INTO chat_sessions (id, title, model_preset_id, model_preset_json, thinking_enabled, web_search_enabled, preset_id, mode, plan_repo_root, created_at_utc, updated_at_utc)
      VALUES ('s1', 'Session', 'preset-a', NULL, 1, 0, 'chat', 'chat', 'C:/repo', '${AT}', '${AT}');
    INSERT INTO chat_runs (operation_id, session_id, record_kind, operation_kind, run_order, owner_epoch, created_at_utc, updated_at_utc, terminal_cause, latest_sequence)
      VALUES ('${OPERATION_ID}', 's1', 'execution', 'repo-agent', 1, 'owner:1', '${AT}', '${AT}', 'completed', ${String(events.length)});
  `);
  const insert = database.prepare(`INSERT INTO chat_run_events (operation_id, sequence, event_id, version, recorded_at_utc, kind, body_json, payload_digest)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const [index, { body, digest }] of events.entries()) {
    insert.run(OPERATION_ID, index + 1, `${OPERATION_ID}:${String(index + 1)}`, CHAT_JOURNAL_EVENT_VERSION, AT, String(body.kind), JSON.stringify(body),
      digest ?? digestStableJson(body));
  }
  database.exec('UPDATE runtime_schema SET version = 99 WHERE id = 1');
  closeAllRuntimeDatabases();
  return dbPath;
}

test('the 99 to 100 upgrade lets a run saved by an old build be read: its preset gains the fields it lacks and keeps its own', (t) => {
  t.after(closeAllRuntimeDatabases);
  const complete = { ...SEPTEMBER_PRESET, ...ADDED_FIELDS, ReviewerSlot: true, HybridDraftTokens: 8 } satisfies JsonObject;
  const stop = { kind: 'stop_requested', requestedAtUtc: AT } satisfies JsonObject;
  const database = getRuntimeDatabase(seedSchema99([{ body: admitted(SEPTEMBER_PRESET) }, { body: stop }, { body: admitted(complete) }]));
  assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
  // Reading validates each event against the current schema and its digest.
  assert.deepEqual(new ChatJournalStore(database).readAfter(OPERATION_ID, 0, 10).map(({ event }) => event),
    [admitted({ ...SEPTEMBER_PRESET, ...ADDED_FIELDS }), stop, admitted(complete)]);
});

test('the 99 to 100 upgrade repairs saved runs only: a session snapshot keeps the values its missing fields are read with', (t) => {
  t.after(closeAllRuntimeDatabases);
  const dbPath = seedSchema99([{ body: admitted(SEPTEMBER_PRESET) }]);
  const snapshot = JSON.stringify(SEPTEMBER_PRESET);
  withRuntimeDatabaseConnection(dbPath, (database) => { database.prepare("UPDATE chat_sessions SET model_preset_json = ? WHERE id = 's1'").run(snapshot); });
  getRuntimeDatabase(dbPath);
  closeAllRuntimeDatabases();
  assert.deepEqual(withRuntimeDatabaseConnection(dbPath, (database) => database.prepare("SELECT model_preset_json FROM chat_sessions WHERE id = 's1'").get()),
    { model_preset_json: snapshot });
});

test('the 99 to 100 upgrade fails loudly on a corrupt or unreadable admission, naming it, and leaves the file at 99', (t) => {
  t.after(closeAllRuntimeDatabases);
  const cases = [
    { event: { body: admitted(SEPTEMBER_PRESET), digest: 'wrong' }, message: 'has a corrupt payload digest' },
    { event: { body: { kind: 'model_admitted', modelPreset: 'not a preset' } }, message: 'model preset is unreadable' },
  ];
  for (const { event, message } of cases) {
    const dbPath = seedSchema99([event]);
    assert.throws(() => getRuntimeDatabase(dbPath), new RegExp(`Chat journal event ${OPERATION_ID}:1 ${message}`, 'u'));
    assert.equal(withRuntimeDatabaseConnection(dbPath, (database) => getSchemaVersion(database)), 99);
  }
});

const BodyJsonRowSchema = z.object({ body_json: z.string() });
const AdmittedPresetSchema = z.object({ modelPreset: z.object({ RamDiskCache: z.boolean(), RamDiskCacheGiB: z.number() }) });

test('an upgrade that adds a preset field reaches saved runs too', () => {
  const { RamDiskCache: _ramDiskCache, RamDiskCacheGiB: _ramDiskCacheGiB, ...stored } = ADDED_FIELDS;
  const dbPath = seedSchema99([{ body: admitted({ ...SEPTEMBER_PRESET, ...stored }) }]);
  // The 94 -> 95 step alone, without the upgrade chain, must still reach the run's admission.
  withRuntimeDatabaseConnection(dbPath, (database) => upgradeModelPresetRamDisk(database));
  const row = BodyJsonRowSchema.parse(withRuntimeDatabaseConnection(dbPath, (database) => database.prepare(
    'SELECT body_json FROM chat_run_events WHERE operation_id = ? AND sequence = 1',
  ).get(OPERATION_ID)));
  assert.deepEqual(AdmittedPresetSchema.parse(JsonObjectSchema.parse(parseJsonObjectText(row.body_json))),
    { modelPreset: { RamDiskCache: false, RamDiskCacheGiB: 10 } });
});

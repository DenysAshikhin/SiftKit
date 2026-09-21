# Chat Progress Delta Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make chat journals written before commit 51a2d6f4 ("progress-update delta batching") readable again by migrating their `progress` display events to the current delta shape, and make `malformed_event` failures name the zod issue instead of a fixed string.

**Architecture:** Runtime DB schema marker 73 -> 74 adds one data migration in `src/state/schema-upgrades/chat-progress-delta.ts` that rewrites `chat_run_events` rows whose body is `{ kind:'display', event:{ kind:'progress', progress:{ turn, text, elapsedMs } } }` into `{ kind:'display', event:{ kind:'progress', delta:{ turn, offset: 0, text } } }` and recomputes `payload_digest`. Offset 0 is the reducer's replace operation (`applyChatStreamTextDelta` in `packages/contracts/src/chat-transcript-reducer.ts`), and the old writer always sent the whole bar text, so projection output is identical; `projected_*` checkpoints are left untouched. Separately, `toEnvelope` in `src/state/chat-journal.ts` builds the `malformed_event` detail from zod issue paths/codes/messages (never payload values).

**Tech Stack:** TypeScript, zod 4 (`src/lib/zod.ts` re-export), better-sqlite3 via `RuntimeDatabase`, node:test (`npm run build:test` then `node .\dist\test-runner\run-tests.js <basename>`).

**Background facts (verified):**
- Migration registry: `src/state/runtime-db.ts:25` `CURRENT_SCHEMA_VERSION = 73`; `SCHEMA_UPGRADES` array at lines 34-42 with steps `{ from, apply }`; whole chain runs inside one transaction (lines 167-181).
- Existing data-migration pattern to mirror: `upgradeChatJournalEventsToVersion2` in `src/state/schema-upgrades/chat-replay-transport.ts:146-177`.
- Digest algorithm: sha256 over `stableStringify(body)` (`digestBody` in chat-replay-transport.ts:137-139; same as `digestChatJournalEvent` in chat-journal.ts).
- Current progress variant: `packages/contracts/src/chat-transcript-reducer.ts:50` `{ kind:'progress', delta: ChatStreamTextDeltaSchema }`; `ChatStreamTextDeltaSchema` = `{ turn: int>=0, offset: int>=0, text: string }` (`packages/contracts/src/chat.ts:540-545`).
- Old variant (51a2d6f4^): `{ kind:'progress', progress: { turn: int>0, text: string, elapsedMs: number>=0 } }`.
- `tests/runtime-db-schema-journal-v2.test.ts:111` pins `CURRENT_SCHEMA_VERSION` to 73 and must move to 74.
- Rules: no `any`, no type assertions, no non-null `!`; comments 1-2 lines; do not commit.

---

### Task 1: `malformed_event` detail carries the zod issues

**Files:**
- Modify: `src/state/chat-journal.ts:143-165` (`toEnvelope`)
- Test: `tests/chat-journal.test.ts` (append a new test at the end of the file)

- [ ] **Step 1: Write the failing test**

Append to `tests/chat-journal.test.ts` (helpers `openFixture`, `runStart`, `proposalEvent`, `appendInput` already exist in that file):

```ts
test('a malformed payload names its zod issues without echoing content, and invalid JSON says so', () => {
  const { store, database } = openFixture('chat-journal-malformed-detail-');
  const run = store.begin(runStart());
  store.append(appendInput(run.operationId, 0, proposalEvent('read'), { eventId: 'event-0' }));
  store.append(appendInput(run.operationId, 1, proposalEvent('read'), { eventId: 'event-1' }));
  const legacyProgress = { kind: 'display', event: { kind: 'progress', progress: { turn: 1, text: 'Confirmed', elapsedMs: 7 } } };
  database.prepare('UPDATE chat_run_events SET body_json=? WHERE operation_id=? AND sequence=1').run(JSON.stringify(legacyProgress), run.operationId);
  assert.throws(() => [...store.readThrough(run.operationId, 0, 2)], (error) => error instanceof ChatJournalIntegrityError
    && error.code === 'malformed_event' && error.sequence === 1 && error.eventId === 'event-0'
    && /malformed event payload: /u.test(error.message)
    && /event\.delta invalid_type/u.test(error.message)
    && /event unrecognized_keys/u.test(error.message)
    && !/Confirmed/u.test(error.message));
  database.prepare('UPDATE chat_run_events SET body_json=? WHERE operation_id=? AND sequence=2').run('{"kind":', run.operationId);
  assert.throws(() => [...store.readThrough(run.operationId, 1, 2)], (error) => error instanceof ChatJournalIntegrityError
    && error.code === 'malformed_event' && error.sequence === 2 && /malformed event payload: invalid JSON\./u.test(error.message));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js chat-journal.test`
Expected: the new test FAILS (message is the fixed `malformed event payload.` so the `/event\.delta invalid_type/u` regex does not match).

- [ ] **Step 3: Write minimal implementation**

In `src/state/chat-journal.ts`, replace the body-parsing block of `toEnvelope` (currently lines 148-153):

```ts
  let decoded: JsonValue;
  try { decoded = JsonValueSchema.parse(JSON.parse(row.body_json)); }
  catch { throw new ChatJournalIntegrityError('malformed_event', row.operation_id, row.event_id, row.sequence, 'malformed event payload: invalid JSON.'); }
  const parsed = ChatJournalEventSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new ChatJournalIntegrityError('malformed_event', row.operation_id, row.event_id, row.sequence,
      `malformed event payload: ${describeSchemaIssues(parsed.error.issues)}`);
  }
  const event = parsed.data;
```

and remove the now-unused `let event: ChatJournalEvent;` declaration (the `ChatJournalEvent` type import stays; `digestChatJournalEvent(event: ChatJournalEvent)` still uses it).

Add this module-level helper above `toEnvelope`:

```ts
const MALFORMED_ISSUE_LIMIT = 3;

/** Issue paths, codes and zod messages only: the detail is logged and shown, so it never carries payload values. */
function describeSchemaIssues(issues: readonly z.core.$ZodIssue[]): string {
  const shown = issues.slice(0, MALFORMED_ISSUE_LIMIT)
    .map(issue => `${issue.path.length === 0 ? '$' : issue.path.map(String).join('.')} ${issue.code}: ${issue.message}`);
  return issues.length > MALFORMED_ISSUE_LIMIT ? `${shown.join('; ')}; +${String(issues.length - MALFORMED_ISSUE_LIMIT)} more.` : `${shown.join('; ')}.`;
}
```

If `z.core.$ZodIssue` is not exported under that name by the installed zod 4, use `z.ZodError['issues'][number]` as the element type instead. `z` is already imported from `../lib/zod.js` in this file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js chat-journal.test`
Expected: PASS. Also run `node .\dist\test-runner\run-tests.js runtime-db-schema-journal-v2` to confirm its pre-existing `/malformed event payload/u` assertion still passes.

- [ ] **Step 5: Do not commit.** Leave the tree for review.

---

### Task 2: Schema marker 73 -> 74 migrates legacy progress rows to deltas

**Files:**
- Create: `src/state/schema-upgrades/chat-progress-delta.ts`
- Modify: `src/state/runtime-db.ts:11-14` (import), `:25` (`CURRENT_SCHEMA_VERSION`), `:34-42` (`SCHEMA_UPGRADES`)
- Modify: `tests/runtime-db-schema-journal-v2.test.ts:111` (`73` -> `74`)
- Test: `tests/runtime-db-schema-chat-progress-delta.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `tests/runtime-db-schema-chat-progress-delta.test.ts`:

```ts
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import test from 'node:test';

import { z } from '../src/lib/zod.js';
import { stableStringify } from '../src/lib/json.js';
import { type JsonValue } from '../src/lib/json-types.js';
import { ChatJournalStore } from '../src/state/chat-journal.js';
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

/** The digest algorithm the journal has always used: sha256 over a stable JSON serialization. */
function digest(body: JsonValue): string {
  return createHash('sha256').update(stableStringify(body)).digest('hex');
}

function row(sequence: number, kind: string, body: JsonValue): EventRow {
  return { operation_id: OPERATION_ID, sequence, event_id: `${OPERATION_ID}:${String(sequence)}`, version: CHAT_JOURNAL_EVENT_VERSION,
    recorded_at_utc: AT, kind, body_json: JSON.stringify(body), payload_digest: digest(body) };
}

/** Exactly what the pre-delta-batching build wrote for a progress update: the whole bar text every time. */
const LEGACY_PROGRESS = { kind: 'display', event: { kind: 'progress', progress: { turn: 1, text: '\n\nConfirmed', elapsedMs: 71796 } } };
const UPGRADED_PROGRESS = { kind: 'display', event: { kind: 'progress', delta: { turn: 1, offset: 0, text: '\n\nConfirmed' } } };
const THINKING = { kind: 'display', event: { kind: 'thinking', delta: { turn: 1, offset: 5203, text: ' + fix.\n' } } };
const DELTA_PROGRESS = { kind: 'display', event: { kind: 'progress', delta: { turn: 2, offset: 4, text: 'more' } } };
/** A non-progress display row whose payload merely contains the progress marker as nested JSON. */
const TOOL_WITH_MARKER = { kind: 'display', event: { kind: 'tool', tool: { kind: 'tool_start', callId: 'call-1', displayToolCallId: 'display-1', toolName: 'read',
  activityKind: 'read', activitySubject: { kind: 'file', value: 'file' }, arguments: { probe: { kind: 'progress' } }, command: 'read file', turn: 1, indexInBatch: 0, batchId: 'batch-1' } } };
const STOP = { kind: 'stop_requested', requestedAtUtc: AT };

function fixtureRows(): EventRow[] {
  return [row(1, 'display', LEGACY_PROGRESS), row(2, 'display', THINKING), row(3, 'display', DELTA_PROGRESS), row(4, 'display', TOOL_WITH_MARKER), row(5, 'stop_requested', STOP)];
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
    assert.equal(CURRENT_SCHEMA_VERSION, 74);
    const after = readRows(database);
    assert.equal(after.length, before.length);
    assert.deepEqual(JSON.parse(after[0].body_json), UPGRADED_PROGRESS);
    assert.equal(after[0].payload_digest, digest(UPGRADED_PROGRESS));
    assert.equal(after[0].version, CHAT_JOURNAL_EVENT_VERSION);
    assert.equal(after[0].kind, 'display');
    assert.equal(after[0].event_id, before[0].event_id);
    assert.equal(after[0].recorded_at_utc, before[0].recorded_at_utc);
    assert.deepEqual(after.slice(1), before.slice(1));
    const events = [...new ChatJournalStore(database).readAll(OPERATION_ID)].map(envelope => envelope.event);
    assert.deepEqual(events, [UPGRADED_PROGRESS, THINKING, DELTA_PROGRESS, TOOL_WITH_MARKER, STOP]);
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
```

If `TOOL_WITH_MARKER` does not satisfy the current `ChatStreamToolEventSchema` `tool_start` variant (see `packages/contracts/src/chat.ts` around line 55), adjust ONLY its field set to a valid `tool_start` payload whose `arguments` still contains `{ probe: { kind: 'progress' } }`. The purpose of that row is to prove the migration ignores non-progress display rows that merely contain the substring `"kind":"progress"`.

Also change `tests/runtime-db-schema-journal-v2.test.ts:111` from `assert.equal(CURRENT_SCHEMA_VERSION, 73);` to `assert.equal(CURRENT_SCHEMA_VERSION, 74);`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js runtime-db-schema-chat-progress-delta`
Expected: FAIL. `getRuntimeDatabase` on a marker-73 file returns without upgrading (no step for 73 is needed while `CURRENT_SCHEMA_VERSION` is 73), so `assert.equal(CURRENT_SCHEMA_VERSION, 74)` fails and the legacy row is unchanged.

- [ ] **Step 3: Write the migration**

Create `src/state/schema-upgrades/chat-progress-delta.ts`:

```ts
import { createHash } from 'node:crypto';

import { z } from '../../lib/zod.js';
import { stableStringify } from '../../lib/json.js';
import { JsonObjectSchema, type JsonValue } from '../../lib/json-types.js';
import type { RuntimeDatabase } from '../database-handle.js';

/** The progress display payload before delta batching: the whole bar text on every update. Migration-only. */
const LegacyProgressBodySchema = z.strictObject({
  kind: z.literal('display'),
  event: z.strictObject({
    kind: z.literal('progress'),
    progress: z.strictObject({ turn: z.number().int().nonnegative(), text: z.string(), elapsedMs: z.number().nonnegative() }),
  }),
});

/** The shape this step writes, frozen here so a later change to the live schema cannot alter what marker 74 means. */
const DeltaProgressBodySchema = z.strictObject({
  kind: z.literal('display'),
  event: z.strictObject({
    kind: z.literal('progress'),
    delta: z.strictObject({ turn: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), text: z.string() }),
  }),
});

const DisplayKindSchema = z.object({ kind: z.literal('display'), event: z.object({ kind: z.string() }) });

const EventRowsSchema = z.array(z.object({
  operation_id: z.string(), sequence: z.number().int().positive(), event_id: z.string(), body_json: z.string(), payload_digest: z.string(),
}));

function digestBody(body: JsonValue): string {
  return createHash('sha256').update(stableStringify(body)).digest('hex');
}

/**
 * 73 -> 74. Progress display events written before delta batching carried the whole bar text; the
 * reader now wants a delta, and offset 0 is the reducer's replace, so the same text at offset 0
 * projects identically. Rows already in delta shape are left alone; a progress row that fits neither
 * shape, or whose digest is corrupt, aborts the whole transaction.
 */
export function upgradeChatProgressEventsToDeltas(database: RuntimeDatabase): void {
  const rows = EventRowsSchema.parse(database.prepare(`
    SELECT operation_id, sequence, event_id, body_json, payload_digest FROM chat_run_events
    WHERE kind = 'display' AND body_json LIKE '%"kind":"progress"%' ORDER BY operation_id, sequence
  `).all());
  const update = database.prepare('UPDATE chat_run_events SET body_json = ?, payload_digest = ? WHERE operation_id = ? AND sequence = ?');
  for (const row of rows) {
    const label = `Chat journal event ${row.event_id} in run ${row.operation_id}`;
    let body: z.infer<typeof JsonObjectSchema>;
    try { body = JsonObjectSchema.parse(JSON.parse(row.body_json)); }
    catch (error) { throw new Error(`${label} has a malformed payload.`, { cause: error }); }
    const display = DisplayKindSchema.safeParse(body);
    if (!display.success || display.data.event.kind !== 'progress') continue;
    if (digestBody(body) !== row.payload_digest) throw new Error(`${label} has a corrupt payload digest.`);
    if (DeltaProgressBodySchema.safeParse(body).success) continue;
    const legacy = LegacyProgressBodySchema.safeParse(body);
    if (!legacy.success) throw new Error(`${label} has an invalid progress payload.`, { cause: legacy.error });
    const { turn, text } = legacy.data.event.progress;
    const upgraded = JsonObjectSchema.parse(DeltaProgressBodySchema.parse({ kind: 'display', event: { kind: 'progress', delta: { turn, offset: 0, text } } }));
    update.run(stableStringify(upgraded), digestBody(upgraded), row.operation_id, row.sequence);
  }
}
```

Note on the `LIKE` prefilter: `JSON.stringify` never emits the unescaped substring `"kind":"progress"` inside a string value (inner quotes become `\"`), so the filter only narrows the scan; correctness comes from the `DisplayKindSchema` check.

Register it in `src/state/runtime-db.ts`:

```ts
// add import beside the other schema-upgrades imports (lines 11-14)
import { upgradeChatProgressEventsToDeltas } from './schema-upgrades/chat-progress-delta.js';

// line 25
export const CURRENT_SCHEMA_VERSION = 74;

// SCHEMA_UPGRADES: append after the from-72 step
  { from: 73, apply: upgradeChatProgressEventsToDeltas },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build:test` then
`node .\dist\test-runner\run-tests.js runtime-db-schema-chat-progress-delta`
`node .\dist\test-runner\run-tests.js runtime-db-schema-journal-v2`
`node .\dist\test-runner\run-tests.js runtime-db-schema`
Expected: all PASS.

- [ ] **Step 5: Do not commit.** Leave the tree for review.

---

## Acceptance criteria

1. `tests/chat-journal.test.ts` new test passes; `malformed_event` messages contain `malformed event payload: ` followed by `<path> <code>: <message>` entries (max 3) or `invalid JSON.`; messages never include payload string values.
2. `tests/runtime-db-schema-chat-progress-delta.test.ts` passes: legacy progress rows become offset-0 deltas with recomputed digests; delta-shape, non-progress, and non-display rows are byte-identical; an unparseable progress row or corrupt digest rolls the transaction back at marker 73.
3. `CURRENT_SCHEMA_VERSION` is 74; `tests/runtime-db-schema-journal-v2.test.ts` updated accordingly; every `runtime-db-schema*` test passes.
4. `npm run typecheck` (includes lint) passes.
5. No commits, no temp files left in the repo.

---

## Follow-up refactors (from the session drift review)

These are behaviour-preserving. Existing tests are the safety net: run them before and after each task; they must stay green throughout. No new behaviour, so no new failing test is required except where noted.

### Task 3: One journal digest helper

**Files:**
- Create: `src/state/chat-journal-digest.ts`
- Modify: `src/state/chat-journal.ts` (remove private `digestJsonBody` at ~108-112, import the shared one)
- Modify: `src/state/schema-upgrades/chat-replay-transport.ts` (remove `digestBody` at ~137-139, 3 call sites at ~157, 164, 169)
- Modify: `src/state/schema-upgrades/chat-progress-delta.ts` (remove `digestBody`, 2 call sites)
- Modify: `tests/runtime-db-schema-journal-v2.test.ts` (remove local `digest` at ~25-28, all call sites)
- Modify: `tests/runtime-db-schema-chat-progress-delta.test.ts` (remove local `digest` at ~26-29, all call sites)

- [ ] **Step 1: Create the shared helper**

`src/state/chat-journal-digest.ts`:

```ts
import { createHash } from 'node:crypto';

import { writeStableJson } from '../lib/json.js';
import type { JsonValue } from '../lib/json-types.js';

/** The journal's payload digest: sha256 over the stable JSON serialization of a decoded body. */
export function digestJsonBody(decoded: JsonValue): string {
  const hash = createHash('sha256');
  writeStableJson(decoded, chunk => { hash.update(chunk); });
  return hash.digest('hex');
}
```

- [ ] **Step 2: Replace every copy**

- `src/state/chat-journal.ts`: delete the private `digestJsonBody` function and its doc comment; add `import { digestJsonBody } from './chat-journal-digest.js';`. Remove the `createHash` import and `writeStableJson` import if nothing else in the file uses them.
- `src/state/schema-upgrades/chat-replay-transport.ts`: delete `digestBody`; add `import { digestJsonBody } from '../chat-journal-digest.js';`; replace the three `digestBody(` calls with `digestJsonBody(`. Remove the `createHash` import if unused.
- `src/state/schema-upgrades/chat-progress-delta.ts`: same replacement (this file is rewritten fully in Task 5; do the minimal swap here so Task 3 is green on its own).
- `tests/runtime-db-schema-journal-v2.test.ts` and `tests/runtime-db-schema-chat-progress-delta.test.ts`: delete the local `digest` function; add `import { digestJsonBody } from '../src/state/chat-journal-digest.js';`; replace every `digest(` call with `digestJsonBody(`. Remove `createHash` and `stableStringify` imports if unused. Keep `JsonValue` imports only where still used.

- [ ] **Step 3: Verify**

Run: `npm run build:test`, then `node .\dist\test-runner\run-tests.js chat-journal.test`, `node .\dist\test-runner\run-tests.js runtime-db-schema-journal-v2`, `node .\dist\test-runner\run-tests.js runtime-db-schema-chat-progress-delta`, `node .\dist\test-runner\run-tests.js chat-history`. Expected: all PASS. Then `grep -rn "createHash('sha256').update(stableStringify" src tests` must return nothing.

### Task 4: Realistic prefilter fixture

**Files:**
- Modify: `tests/runtime-db-schema-chat-progress-delta.test.ts` (fixture constants and their uses)

- [ ] **Step 1: Replace the near-duplicate constants**

Delete `USAGE_WITH_MARKER` and `USAGE_WITH_MARKER_PARSED` (and their comments). Add:

```ts
/** A non-progress display row whose text merely contains the progress marker; the prefilter must not touch it. */
const NARRATION_WITH_MARKER = { kind: 'display', event: { kind: 'narration', delta: { turn: 1, offset: 0, text: '{"kind":"progress"}' } } };
```

Update `fixtureRows()` to use `row(4, 'display', NARRATION_WITH_MARKER)` and the read-back expectation to `[UPGRADED_PROGRESS, THINKING, DELTA_PROGRESS, NARRATION_WITH_MARKER, STOP]`.

- [ ] **Step 2: Verify**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js runtime-db-schema-chat-progress-delta`. Expected: 3/3 PASS, and `after.slice(1)` still deep-equals `before.slice(1)` (the narration row is byte-identical).

### Task 5: Migration without parse-what-you-built

**Files:**
- Modify: `src/state/schema-upgrades/chat-progress-delta.ts` (full rewrite)

- [ ] **Step 1: Rewrite the file**

```ts
import { z } from '../../lib/zod.js';
import { stableStringify } from '../../lib/json.js';
import { JsonObjectSchema, type JsonObject } from '../../lib/json-types.js';
import { digestJsonBody } from '../chat-journal-digest.js';
import type { RuntimeDatabase } from '../database-handle.js';

/** Both progress shapes a marker-73 file can hold: the pre-batching whole-text payload and the delta that replaced it. Migration-only. */
const ProgressBodySchema = z.strictObject({
  kind: z.literal('display'),
  event: z.union([
    z.strictObject({ kind: z.literal('progress'), progress: z.strictObject({ turn: z.number().int().nonnegative(), text: z.string(), elapsedMs: z.number().nonnegative() }) }),
    z.strictObject({ kind: z.literal('progress'), delta: z.strictObject({ turn: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), text: z.string() }) }),
  ]),
});

const DisplayKindSchema = z.object({ kind: z.literal('display'), event: z.object({ kind: z.string() }) });

const EventRowsSchema = z.array(z.object({
  operation_id: z.string(), sequence: z.number().int().positive(), event_id: z.string(), body_json: z.string(), payload_digest: z.string(),
}));

/**
 * 73 -> 74. Progress display events written before delta batching carried the whole bar text; the
 * reader now wants a delta, and offset 0 is the reducer's replace, so the same text at offset 0
 * projects identically. Rows already in delta shape are left alone; a progress row that fits neither
 * shape, or whose digest is corrupt, aborts the whole transaction.
 */
export function upgradeChatProgressEventsToDeltas(database: RuntimeDatabase): void {
  const rows = EventRowsSchema.parse(database.prepare(`
    SELECT operation_id, sequence, event_id, body_json, payload_digest FROM chat_run_events
    WHERE kind = 'display' AND body_json LIKE '%"kind":"progress"%' ORDER BY operation_id, sequence
  `).all());
  const update = database.prepare('UPDATE chat_run_events SET body_json = ?, payload_digest = ? WHERE operation_id = ? AND sequence = ?');
  for (const row of rows) {
    const label = `Chat journal event ${row.event_id} in run ${row.operation_id}`;
    let body: JsonObject;
    try { body = JsonObjectSchema.parse(JSON.parse(row.body_json)); }
    catch (error) { throw new Error(`${label} has a malformed payload.`, { cause: error }); }
    const display = DisplayKindSchema.safeParse(body);
    if (!display.success || display.data.event.kind !== 'progress') continue;
    if (digestJsonBody(body) !== row.payload_digest) throw new Error(`${label} has a corrupt payload digest.`);
    const progress = ProgressBodySchema.safeParse(body);
    if (!progress.success) throw new Error(`${label} has an invalid progress payload.`, { cause: progress.error });
    if ('delta' in progress.data.event) continue;
    const { turn, text } = progress.data.event.progress;
    const upgraded = { kind: 'display', event: { kind: 'progress', delta: { turn, offset: 0, text } } } satisfies JsonObject;
    update.run(stableStringify(upgraded), digestJsonBody(upgraded), row.operation_id, row.sequence);
  }
}
```

If `satisfies JsonObject` is rejected by the type checker for the literal, use `const upgraded: JsonObject = { ... };` instead. No `parse` call on the constructed value.

- [ ] **Step 2: Verify**

Run: `npm run build:test`, then `node .\dist\test-runner\run-tests.js runtime-db-schema-chat-progress-delta`, `node .\dist\test-runner\run-tests.js runtime-db-schema`, and `npm run typecheck`. Expected: all PASS.

## Acceptance criteria for Tasks 3-5

1. Exactly one sha256-over-stable-JSON implementation exists: `digestJsonBody` in `src/state/chat-journal-digest.ts`. No `digestBody` or local `digest` helpers remain in src or tests.
2. `tests/runtime-db-schema-chat-progress-delta.test.ts` has no `_PARSED` fixture; the non-progress marker row is a narration delta whose text contains `{"kind":"progress"}`.
3. `chat-progress-delta.ts` has one progress schema (a union of legacy and delta), and the rewritten body is a plain literal, never re-parsed.
4. All tests listed above pass; `npm run typecheck` passes; no commits; no temp files.

---

### Task 6: One stable-JSON digest for the whole codebase

The journal-specific helper from Task 3 is really the generic "sha256 over stable JSON" primitive, and eight more inline copies exist outside the journal. Put it in the node-only module `src/lib/json-digest.ts` (json.ts itself is shared with the browser dashboard, so it cannot import node:crypto), name it `digestStableJson`, and make every site use it. `stableStringify(x)` and `digestStableJson(x)` take the same `JsonValue` parameter, so any argument that compiles for one compiles for the other.

**Files:**
- Modify: `src/lib/json-digest.ts` (create, exports `digestStableJson`)
- Delete: `src/state/chat-journal-digest.ts`
- Modify (rename import + calls `digestJsonBody` -> `digestStableJson` from `../lib/json.js` / `../../lib/json.js` / `../src/lib/json.js`): `src/state/chat-journal.ts`, `src/state/schema-upgrades/chat-progress-delta.ts`, `src/state/schema-upgrades/chat-replay-transport.ts`, `tests/chat-journal.test.ts`, `tests/runtime-db-schema-chat-progress-delta.test.ts`, `tests/runtime-db-schema-journal-v2.test.ts`, `tests/runtime-db-schema.test.ts`
- Modify (replace inline digests): `src/state/chat-submissions.ts:59`, `src/status-server/chat-history-import.ts:49`, `src/status-server/chat-history-repair.ts:114,115,116-117,118,161,192`
- Test: `tests/json-stable.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/json-stable.test.ts` (merge these imports with the file's existing ones; `createHash` from `node:crypto`, `stableStringify` and `digestStableJson` from `../src/lib/json.js`):

```ts
test('digestStableJson is sha256 over the stable serialization and ignores key order', () => {
  const digest = digestStableJson({ b: [1, { d: null, c: 'x' }], a: true });
  assert.equal(digest, createHash('sha256').update(stableStringify({ a: true, b: [1, { c: 'x', d: null }] })).digest('hex'));
  assert.equal(digest, digestStableJson({ a: true, b: [1, { c: 'x', d: null }] }));
  assert.match(digest, /^[0-9a-f]{64}$/u);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build:test` then `node .\dist\test-runner\run-tests.js json-stable`. Expected: FAIL (`digestStableJson` is not exported).

- [ ] **Step 3: Create `src/lib/json-digest.ts`**

Add `import { createHash } from 'node:crypto';` at the top, and after `writeStableJson`:

```ts
/** sha256 over the stable serialization, so equal JSON values digest equally regardless of key order. */
export function digestStableJson(value: JsonValue): string {
  const hash = createHash('sha256');
  writeStableJson(value, chunk => { hash.update(chunk); });
  return hash.digest('hex');
}
```

- [ ] **Step 4: Move every caller onto it**

1. Delete `src/state/chat-journal-digest.ts`.
2. In the seven files that import `digestJsonBody` from `chat-journal-digest`, change the import to `digestStableJson` from the lib json module and rename every call. Where a file already imports from `../lib/json.js` (or the equivalent relative path), add the name to that existing import instead of adding a second import line.
3. Replace the eight inline digests, keeping the argument expression exactly as it is:
   - `src/state/chat-submissions.ts:59` -> `return digestStableJson({ operationKind: kind, body });` and remove the now-unused `createHash` and `stableStringify` imports.
   - `src/status-server/chat-history-import.ts:49` -> `sourceDigest: digestStableJson(messages),`; keep `randomUUID`, drop `createHash` and `stableStringify` if unused.
   - `src/status-server/chat-history-repair.ts` lines 114, 115, 116-117, 118, 161, 192 -> `digestStableJson(<same argument>)`. Line 119 hashes a plain string (`${sourceDigest}:${targetDigest}`), not JSON: leave it exactly as is, so `createHash` stays imported in this file. Drop `stableStringify` from its import if no other use remains.

- [ ] **Step 5: Verify**

Run: `npm run build:test`, then `node .\dist\test-runner\run-tests.js json-stable`, `chat-journal.test`, `runtime-db-schema-journal-v2`, `runtime-db-schema-chat-progress-delta`, `runtime-db-schema`, `chat-history`, `chat-submission`, `chat-history-repair` (each as its own `node .\dist\test-runner\run-tests.js <basename>` call; skip a basename only if the runner reports no such test), then `npm run typecheck`. Expected: all PASS.

Then these greps must return nothing in `src` and `tests`: `createHash('sha256').update(stableStringify`, `digestJsonBody`, `chat-journal-digest`.

**Acceptance criteria:** exactly one stable-JSON sha256 implementation exists, `digestStableJson` in `src/lib/json-digest.ts`; `chat-journal-digest.ts` is deleted; the string hash at chat-history-repair.ts:119 is untouched; all listed tests and typecheck pass; no commits, no temp files.

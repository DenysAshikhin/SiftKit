# Prompt-cache break warnings and Engine (exl3) log section — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flag prompt-cache breaks and engine errors and exits as they happen: in the live run, on the run's Logs entry, and in a new Engine (exl3) section of the Logs tab.

**Architecture:**
- A `PromptCacheWatch` in the task loop compares each response's prefill with the prompt's growth. On a break it emits a transcript event and a progress event.
- The run's lifecycle writer stores the break in a new `engine_events` table and forwards it as the existing `context_warning`, so the chat banner and CLI show it unchanged.
- `TabbyRunRecorder` turns TabbyAPI `ERROR`/`CRITICAL` log records and unrequested exits into `engine_events` rows.
- The dashboard reads per-run break counts through `RunRecord` and lists all events from `GET /dashboard/engine-events`.

**Tech Stack:** TypeScript, zod, better-sqlite3, node:test, React with Vitest.

**Spec:** `docs/superpowers/specs/2026-11-18-cache-break-warnings-engine-errors-design.md`

**Repo rules that apply to every task:**
- No `any`, type assertions, non-null `!`, or namespace imports.
- Zod at IO boundaries; comments of 1–2 lines.
- Do not commit; the user commits.
- Run default-suite tests with `node ./src/test-runner/run-tests.ts <file-name-without-.test.ts>`.
- Run dashboard tests from **PowerShell** (Git Bash loads Vitest twice) with `npx vitest run --config .\dashboard\vitest.config.ts <filter>`.
- Edit files containing backslashes with the Edit/Write tools, not shell heredocs, which collapse `\\`.

---

## File map

| File | Responsibility |
|---|---|
| `packages/contracts/src/engine-events.ts` (new) | `EngineEventKindSchema`, `EngineEventSchema`, `EngineEventsResponseSchema`, `PromptCacheBreakSchema` |
| `packages/contracts/src/index.ts` | re-export the above |
| `packages/contracts/src/runs.ts` | `RunRecordSchema.promptCacheBreakCount` |
| `src/state/runtime-schema.ts` | `ENGINE_EVENTS_SCHEMA_SQL`, created on fresh databases |
| `src/state/schema-upgrades/engine-events.ts` (new) | the 93 → 94 step |
| `src/state/runtime-db.ts` | register step; `CURRENT_SCHEMA_VERSION = 94`; prune `engine_events` |
| `src/state/engine-events.ts` (new) | insert, list, count per run, delete |
| `src/state/inference-runs.ts` | `deleteInferenceRun` also deletes that run's engine events |
| `src/repo-search/engine/prompt-cache-watch.ts` (new) | break rule and the break's text forms |
| `src/planner-protocol/mock-response.ts`, `src/repo-search/planner-protocol.ts` | mock responses can report `promptEvalTokens`/`promptCacheTokens` |
| `src/repo-search/types.ts` | `prompt_cache_break` progress event |
| `src/repo-search/engine/progress-reporter.ts` | `promptCacheBreak()` emitter |
| `src/repo-search/engine/task-loop.ts` | feed the watch; emit on break |
| `src/repo-search/execute.ts` | lifecycle writer stores the break and forwards a `context_warning` |
| `src/status-server/tabby-run-recorder.ts` | `engine_error` and `engine_exit` rows |
| `src/status-server/dashboard-runs/run-records.ts`, `queries.ts`, `deletion.ts` | break counts on records; delete with runs |
| `src/status-server/routes/dashboard.ts` | `GET /dashboard/engine-events` |
| `dashboard/src/api.ts` | `getEngineEvents` |
| `dashboard/src/lib/engine-events.ts` (new) | grouping and labels |
| `dashboard/src/hooks/useRunsController.ts` | load events; engine selection and filter state |
| `dashboard/src/tabs/RunsTab.tsx` | Engine section, run badge, warning card |
| `dashboard/src/styles.css` | three small classes |

---

### Task 1: `engine_events` storage

**Files:**
- Create: `packages/contracts/src/engine-events.ts`, `src/state/schema-upgrades/engine-events.ts`, `src/state/engine-events.ts`, `tests/engine-events.test.ts`, `tests/runtime-db-schema-engine-events.test.ts`
- Modify: `packages/contracts/src/index.ts`, `src/state/runtime-schema.ts`, `src/state/runtime-db.ts`

- [ ] **Step 1: Write the failing tests**

`tests/engine-events.test.ts`:

```ts
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { closeAllRuntimeDatabases, getRuntimeDatabase, pruneRuntimeHistory } from '../src/state/runtime-db.ts';
import {
  countPromptCacheBreaksByRun,
  deleteEngineEventsForInferenceRun,
  deleteEngineEventsForRuns,
  ENGINE_EVENT_DETAIL_MAX_CHARS,
  insertEngineEvent,
  listEngineEvents,
  type EngineEventInput,
} from '../src/state/engine-events.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

const CACHE_BREAK: EngineEventInput = {
  kind: 'prompt_cache_break', inferenceRunId: null, runId: 'run-a', turn: 3,
  summary: 'Turn 3 re-prefilled 9,000 tokens; the prompt grew 100', detail: 'turn: 3',
};
const ENGINE_ERROR: EngineEventInput = {
  kind: 'engine_error', inferenceRunId: 'engine-1', runId: null, turn: null,
  summary: 'Exception in ASGI application', detail: `${'x'.repeat(ENGINE_EVENT_DETAIL_MAX_CHARS + 10)}TAIL`,
};

function openDatabase() {
  const dbPath = path.join(createManagedTempDir('engine-events-'), 'runtime.sqlite');
  return { dbPath, database: getRuntimeDatabase(dbPath) };
}

test('engine events list newest first, count cache breaks per run, and keep the end of a long detail', (t) => {
  t.after(closeAllRuntimeDatabases);
  const { database } = openDatabase();
  insertEngineEvent(database, CACHE_BREAK);
  insertEngineEvent(database, { ...CACHE_BREAK, turn: 5 });
  insertEngineEvent(database, ENGINE_ERROR);

  const events = listEngineEvents(database, 10);
  assert.deepEqual(events.map((event) => [event.kind, event.turn]), [['engine_error', null], ['prompt_cache_break', 5], ['prompt_cache_break', 3]]);
  assert.equal(events[0]?.detail.length, ENGINE_EVENT_DETAIL_MAX_CHARS);
  assert.ok(events[0]?.detail.endsWith('TAIL'));
  assert.equal(listEngineEvents(database, 1).length, 1);
  assert.deepEqual([...countPromptCacheBreaksByRun(database, ['run-a', 'run-b'])], [['run-a', 2]]);
  assert.deepEqual([...countPromptCacheBreaksByRun(database, [])], []);
});

test('engine events are deleted with their runs, with their engine run, and by history pruning', (t) => {
  t.after(closeAllRuntimeDatabases);
  const { dbPath, database } = openDatabase();
  insertEngineEvent(database, CACHE_BREAK);
  insertEngineEvent(database, ENGINE_ERROR);

  assert.equal(deleteEngineEventsForRuns(database, ['run-a']), 1);
  assert.equal(deleteEngineEventsForRuns(database, []), 0);
  assert.equal(deleteEngineEventsForInferenceRun(database, 'engine-1'), 1);

  insertEngineEvent(database, CACHE_BREAK);
  database.prepare("UPDATE engine_events SET occurred_at_utc = '2000-01-01T00:00:00.000Z'").run();
  pruneRuntimeHistory(1, dbPath);
  assert.deepEqual(listEngineEvents(database, 10), []);
});
```

`tests/runtime-db-schema-engine-events.test.ts`:

```ts
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';

import { closeAllRuntimeDatabases, CURRENT_SCHEMA_VERSION, getRuntimeDatabase, getSchemaVersion } from '../src/state/runtime-db.ts';
import { upgradeEngineEvents } from '../src/state/schema-upgrades/engine-events.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

const NameRowsSchema = z.array(z.object({ name: z.string() }));

test('the 93 to 94 upgrade creates engine_events and its indexes, and repeating it is harmless', (t) => {
  t.after(closeAllRuntimeDatabases);
  const dbPath = path.join(createManagedTempDir('engine-events-upgrade-'), 'runtime.sqlite');
  getRuntimeDatabase(dbPath).exec('DROP TABLE engine_events; UPDATE runtime_schema SET version = 93 WHERE id = 1');
  closeAllRuntimeDatabases();

  const database = getRuntimeDatabase(dbPath);
  assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
  const names = NameRowsSchema.parse(database.prepare(
    "SELECT name FROM sqlite_master WHERE tbl_name = 'engine_events' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all()).map((row) => row.name);
  assert.deepEqual(names, ['engine_events', 'idx_engine_events_occurred', 'idx_engine_events_run']);
  assert.doesNotThrow(() => upgradeEngineEvents(database));
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `node ./src/test-runner/run-tests.ts engine-events runtime-db-schema-engine-events`
Expected: FAIL, because the modules `src/state/engine-events.ts` and `src/state/schema-upgrades/engine-events.ts` are not found.

- [ ] **Step 3: Add the contracts**

`packages/contracts/src/engine-events.ts`:

```ts
import { z } from 'zod';

export const EngineEventKindSchema = z.enum(['prompt_cache_break', 'engine_error', 'engine_exit']);
export type EngineEventKind = z.infer<typeof EngineEventKindSchema>;

/** One engine-level problem: a prompt-cache break in an agent run, or an engine error or exit. */
export const EngineEventSchema = z.object({
  id: z.string(),
  occurredAtUtc: z.string(),
  kind: EngineEventKindSchema,
  inferenceRunId: z.string().nullable(),
  runId: z.string().nullable(),
  turn: z.number().int().nullable(),
  summary: z.string(),
  detail: z.string(),
});
export type EngineEvent = z.infer<typeof EngineEventSchema>;

export const EngineEventsResponseSchema = z.object({ events: z.array(EngineEventSchema) });
export type EngineEventsResponse = z.infer<typeof EngineEventsResponseSchema>;

/** A response whose prefill exceeded the prompt's growth since the previous response. */
export const PromptCacheBreakSchema = z.object({
  turn: z.number().int(),
  promptTokens: z.number(),
  previousPromptTokens: z.number(),
  promptEvalTokens: z.number(),
  promptCacheTokens: z.number().nullable(),
});
export type PromptCacheBreak = z.infer<typeof PromptCacheBreakSchema>;
```

In `packages/contracts/src/index.ts`, add `export * from './engine-events.ts';` after `export * from './runs.ts';`.

- [ ] **Step 4: Add the schema SQL and the upgrade step**

In `src/state/runtime-schema.ts`, after `ORCHESTRATOR_RUNS_SCHEMA_SQL`:

```ts
/** Prompt-cache breaks of agent runs and errors/exits of engine runs, shown in the Logs tab. */
export const ENGINE_EVENTS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS engine_events (
    id TEXT PRIMARY KEY,
    occurred_at_utc TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('prompt_cache_break', 'engine_error', 'engine_exit')),
    inference_run_id TEXT,
    run_id TEXT,
    turn INTEGER,
    summary TEXT NOT NULL,
    detail TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_engine_events_occurred ON engine_events(occurred_at_utc DESC);
  CREATE INDEX IF NOT EXISTS idx_engine_events_run ON engine_events(run_id);
`;
```

In `initializeRuntimeSchema`, add `database.exec(ENGINE_EVENTS_SCHEMA_SQL);` after `database.exec(ORCHESTRATOR_RUNS_SCHEMA_SQL);`.

`src/state/schema-upgrades/engine-events.ts`:

```ts
import type { RuntimeDatabase } from '../database-handle.ts';

// A literal, so later schema edits cannot change what the 93 to 94 upgrade creates.
const ENGINE_EVENTS_94_SQL = `
  CREATE TABLE IF NOT EXISTS engine_events (
    id TEXT PRIMARY KEY,
    occurred_at_utc TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('prompt_cache_break', 'engine_error', 'engine_exit')),
    inference_run_id TEXT,
    run_id TEXT,
    turn INTEGER,
    summary TEXT NOT NULL,
    detail TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_engine_events_occurred ON engine_events(occurred_at_utc DESC);
  CREATE INDEX IF NOT EXISTS idx_engine_events_run ON engine_events(run_id);
`;

/** Schema 93 -> 94: adds the engine_events table. */
export function upgradeEngineEvents(database: RuntimeDatabase): void {
  database.exec(ENGINE_EVENTS_94_SQL);
}
```

In `src/state/runtime-db.ts`:
- import `upgradeEngineEvents` from `./schema-upgrades/engine-events.ts`;
- set `CURRENT_SCHEMA_VERSION = 94`;
- append `{ from: 93, apply: upgradeEngineEvents },` to `SCHEMA_UPGRADES`;
- in `pruneRuntimeHistory`'s `deleteStatements`, add after the `runtime_error_events` entry:

```ts
    { table: 'engine_events', sql: 'DELETE FROM engine_events WHERE occurred_at_utc < ?' },
```

- [ ] **Step 5: Add the state module**

`src/state/engine-events.ts`:

```ts
import { randomUUID } from 'node:crypto';

import { EngineEventKindSchema, type EngineEvent } from '@siftkit/contracts';
import { z } from '../lib/zod.ts';
import type { RuntimeDatabase } from './database-handle.ts';

/** Detail beyond this keeps its end, where a traceback's exception line is. */
export const ENGINE_EVENT_DETAIL_MAX_CHARS = 16_000;

export type EngineEventInput = Omit<EngineEvent, 'id' | 'occurredAtUtc'>;

const EngineEventRowSchema = z.object({
  id: z.string(),
  occurred_at_utc: z.string(),
  kind: EngineEventKindSchema,
  inference_run_id: z.string().nullable(),
  run_id: z.string().nullable(),
  turn: z.number().int().nullable(),
  summary: z.string(),
  detail: z.string(),
});
const RunCountRowSchema = z.object({ run_id: z.string(), count: z.number() });

export function insertEngineEvent(database: RuntimeDatabase, input: EngineEventInput): void {
  const detail = input.detail.length > ENGINE_EVENT_DETAIL_MAX_CHARS ? input.detail.slice(-ENGINE_EVENT_DETAIL_MAX_CHARS) : input.detail;
  database.prepare(`
    INSERT INTO engine_events (id, occurred_at_utc, kind, inference_run_id, run_id, turn, summary, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), new Date().toISOString(), input.kind, input.inferenceRunId, input.runId, input.turn, input.summary, detail);
}

/** The newest `limit` events of every kind. */
export function listEngineEvents(database: RuntimeDatabase, limit: number): EngineEvent[] {
  const rows = z.array(EngineEventRowSchema).parse(database.prepare(`
    SELECT id, occurred_at_utc, kind, inference_run_id, run_id, turn, summary, detail
    FROM engine_events ORDER BY occurred_at_utc DESC, rowid DESC LIMIT ?
  `).all(limit));
  return rows.map((row) => ({
    id: row.id,
    occurredAtUtc: row.occurred_at_utc,
    kind: row.kind,
    inferenceRunId: row.inference_run_id,
    runId: row.run_id,
    turn: row.turn,
    summary: row.summary,
    detail: row.detail,
  }));
}

/** Cache-break counts of the given runs; runs without breaks are absent. */
export function countPromptCacheBreaksByRun(database: RuntimeDatabase, runIds: readonly string[]): Map<string, number> {
  if (runIds.length === 0) return new Map();
  const placeholders = runIds.map(() => '?').join(', ');
  const rows = z.array(RunCountRowSchema).parse(database.prepare(`
    SELECT run_id, COUNT(*) AS count FROM engine_events
    WHERE kind = 'prompt_cache_break' AND run_id IN (${placeholders}) GROUP BY run_id
  `).all(...runIds));
  return new Map(rows.map((row) => [row.run_id, row.count]));
}

export function deleteEngineEventsForRuns(database: RuntimeDatabase, runIds: readonly string[]): number {
  if (runIds.length === 0) return 0;
  const placeholders = runIds.map(() => '?').join(', ');
  return Number(database.prepare(`DELETE FROM engine_events WHERE run_id IN (${placeholders})`).run(...runIds).changes);
}

export function deleteEngineEventsForInferenceRun(database: RuntimeDatabase, inferenceRunId: string): number {
  return Number(database.prepare('DELETE FROM engine_events WHERE inference_run_id = ?').run(inferenceRunId).changes);
}
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `node ./src/test-runner/run-tests.ts engine-events runtime-db-schema-engine-events runtime-db-schema`
Expected: PASS. `runtime-db-schema` checks that upgraded and fresh schemas agree.

If any other test pins the schema version to 93, update the pinned number to 94: `grep -rn "93" tests/runtime-db*.test.ts`.

- [ ] **Step 7: Do not commit**

---

### Task 2: `PromptCacheWatch`

**Files:**
- Create: `src/repo-search/engine/prompt-cache-watch.ts`, `tests/prompt-cache-watch.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/prompt-cache-watch.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describePromptCacheBreak,
  formatPromptCacheBreakDetail,
  PROMPT_CACHE_BREAK_TOLERANCE_TOKENS,
  PromptCacheWatch,
  summarizePromptCacheBreak,
} from '../src/repo-search/engine/prompt-cache-watch.ts';

const observe = (watch: PromptCacheWatch, turn: number, promptTokens: number, promptEvalTokens: number | null) =>
  watch.observe({ turn, promptTokens, promptEvalTokens, promptCacheTokens: null });

test('the first response is not checked, and growth plus the tolerance is the most a cached turn prefills', () => {
  const watch = new PromptCacheWatch();
  assert.equal(observe(watch, 1, 10_000, 10_000), null);
  assert.equal(observe(watch, 2, 11_000, 1_000 + PROMPT_CACHE_BREAK_TOLERANCE_TOKENS), null);
  assert.deepEqual(observe(watch, 3, 12_000, 1_000 + PROMPT_CACHE_BREAK_TOLERANCE_TOKENS + 1), {
    turn: 3, promptTokens: 12_000, previousPromptTokens: 11_000, promptEvalTokens: 1_501, promptCacheTokens: null,
  });
});

test('the first response after a compaction is not checked, and the next one is', () => {
  const watch = new PromptCacheWatch();
  observe(watch, 1, 50_000, 50_000);
  watch.noteCompaction();
  assert.equal(observe(watch, 2, 8_000, 8_000), null);
  assert.equal(observe(watch, 3, 9_000, 9_000)?.turn, 3);
});

test('an unreported prefill is not checked but still sets the comparison point', () => {
  const watch = new PromptCacheWatch();
  observe(watch, 1, 10_000, 10_000);
  assert.equal(observe(watch, 2, 20_000, null), null);
  assert.equal(observe(watch, 3, 20_100, 600), null);
  assert.equal(observe(watch, 4, 20_200, 20_200)?.previousPromptTokens, 20_100);
});

test('a break reads the same in the run warning, the engine-event summary, and its detail', () => {
  const cacheBreak = { turn: 14, promptTokens: 190_000, previousPromptTokens: 186_790, promptEvalTokens: 182_301, promptCacheTokens: 7_699 };
  assert.equal(describePromptCacheBreak(cacheBreak), 'Prompt cache broke on turn 14: re-prefilled 182,301 tokens where the prompt grew 3,210.');
  assert.equal(summarizePromptCacheBreak(cacheBreak), 'Turn 14 re-prefilled 182,301 tokens; the prompt grew 3,210');
  assert.equal(formatPromptCacheBreakDetail(cacheBreak), [
    'turn: 14', 'prompt tokens: 190,000', 'previous prompt tokens: 186,790', 're-prefilled tokens: 182,301', 'cached tokens: 7,699',
  ].join('\n'));
});
```

The failed-request case from the spec needs no separate unit test. A failed request never reaches `observe`, so the next response is compared with the last one that succeeded, which is what the third test exercises.

- [ ] **Step 2: Run it and confirm it fails**

Run: `node ./src/test-runner/run-tests.ts prompt-cache-watch`
Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement**

`src/repo-search/engine/prompt-cache-watch.ts`:

```ts
import type { PromptCacheBreak } from '@siftkit/contracts';
import { formatInteger } from '../../lib/text-format.ts';

/** Absorbs differences between SiftKit's prompt token count and the engine's. */
export const PROMPT_CACHE_BREAK_TOLERANCE_TOKENS = 500;

export type PromptCacheObservation = {
  turn: number;
  promptTokens: number;
  promptEvalTokens: number | null;
  promptCacheTokens: number | null;
};

/** Flags a response whose prefill exceeds the prompt's growth since the previous response. */
export class PromptCacheWatch {
  private previousPromptTokens: number | null = null;

  /** The next response starts a new cache epoch, so it is not checked. */
  noteCompaction(): void {
    this.previousPromptTokens = null;
  }

  observe(observation: PromptCacheObservation): PromptCacheBreak | null {
    const previousPromptTokens = this.previousPromptTokens;
    this.previousPromptTokens = observation.promptTokens;
    if (previousPromptTokens === null || observation.promptEvalTokens === null) return null;
    const growth = observation.promptTokens - previousPromptTokens;
    if (observation.promptEvalTokens <= growth + PROMPT_CACHE_BREAK_TOLERANCE_TOKENS) return null;
    return {
      turn: observation.turn,
      promptTokens: observation.promptTokens,
      previousPromptTokens,
      promptEvalTokens: observation.promptEvalTokens,
      promptCacheTokens: observation.promptCacheTokens,
    };
  }
}

const growthOf = (cacheBreak: PromptCacheBreak): string => formatInteger(cacheBreak.promptTokens - cacheBreak.previousPromptTokens);

/** The live warning shown on the run. */
export function describePromptCacheBreak(cacheBreak: PromptCacheBreak): string {
  return `Prompt cache broke on turn ${cacheBreak.turn}: re-prefilled ${formatInteger(cacheBreak.promptEvalTokens)} tokens where the prompt grew ${growthOf(cacheBreak)}.`;
}

/** The one-line engine-event summary. */
export function summarizePromptCacheBreak(cacheBreak: PromptCacheBreak): string {
  return `Turn ${cacheBreak.turn} re-prefilled ${formatInteger(cacheBreak.promptEvalTokens)} tokens; the prompt grew ${growthOf(cacheBreak)}`;
}

export function formatPromptCacheBreakDetail(cacheBreak: PromptCacheBreak): string {
  return [
    `turn: ${cacheBreak.turn}`,
    `prompt tokens: ${formatInteger(cacheBreak.promptTokens)}`,
    `previous prompt tokens: ${formatInteger(cacheBreak.previousPromptTokens)}`,
    `re-prefilled tokens: ${formatInteger(cacheBreak.promptEvalTokens)}`,
    `cached tokens: ${formatInteger(cacheBreak.promptCacheTokens)}`,
  ].join('\n');
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `node ./src/test-runner/run-tests.ts prompt-cache-watch`
Expected: PASS. If `formatInteger` does not group with commas, the format test fails. In that case read `formatGroupedNumber` in `src/lib/text-format.ts` and change the expected strings to its real output; do not change the formatter.

- [ ] **Step 5: Do not commit**

---

### Task 3: The task loop emits cache breaks

**Files:**
- Modify: `src/planner-protocol/mock-response.ts`, `src/repo-search/planner-protocol.ts` (mock branch near line 498), `src/repo-search/types.ts` (`RepoSearchProgressEventSchema`), `src/repo-search/engine/progress-reporter.ts`, `src/repo-search/engine/task-loop.ts`
- Create: `tests/prompt-cache-break-loop.test.ts`

- [ ] **Step 1: Write the failing end-to-end test**

`tests/prompt-cache-break-loop.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import type { JsonObject, JsonSerializable } from '../src/lib/json-types.ts';
import { ProgressWriter } from '../src/lib/progress-writer.ts';
import type { MockPlannerResponseInput } from '../src/planner-protocol/mock-response.ts';
import { runTaskLoop } from '../src/repo-search/engine.ts';
import { RepoSearchRuntimeProfile } from '../src/repo-search/engine/runtime-profile.ts';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.ts';
import { parseLoggedEvent } from './helpers/logged-events.ts';
import { createMockLoopDefaults } from './helpers/mock-loop-defaults.ts';
import { TEST_THROUGHPUT_AUDIT_OPERATION } from './_test-helpers.ts';

const VERDICT = { content: '{"verdict":"pass","reason":"supported"}' };
const PATTERNS = ['planner', 'engine', 'config'];
const grepKey = (pattern: string) => `git operation="grep" path="src" pattern="${pattern}"`;

function grepCall(pattern: string, promptEvalTokens: number | null): MockPlannerResponseInput {
  return { toolCalls: [{ name: 'git', arguments: { operation: 'grep', pattern, path: 'src' } }], promptEvalTokens };
}

class CaptureWriter extends ProgressWriter<RepoSearchProgressEvent> {
  readonly events: RepoSearchProgressEvent[] = [];
  get enabled(): boolean { return true; }
  write(event: RepoSearchProgressEvent): void { this.events.push(event); }
}

async function runWithPrefills(id: string, prefills: readonly (number | null)[]) {
  const events: JsonObject[] = [];
  const progress = new CaptureWriter();
  await runTaskLoop({ id, question: 'Do the task.' }, {
    throughputAudit: TEST_THROUGHPUT_AUDIT_OPERATION,
    ...createMockLoopDefaults('siftkit-cache-break-'),
    runtimeProfile: new RepoSearchRuntimeProfile('repo-agent'),
    minToolCallsBeforeFinish: 0,
    maxTurns: 8,
    mockResponses: [...PATTERNS.map((pattern, index) => grepCall(pattern, prefills[index] ?? null)), { content: 'complete answer' }, VERDICT],
    mockCommandResults: Object.fromEntries(PATTERNS.map((pattern) => [grepKey(pattern), { exitCode: 0, stdout: `src\\a.ts:1:${pattern}`, stderr: '' }])),
    progressWriter: progress,
    logger: { path: 'memory', write(event: Record<string, JsonSerializable>) { events.push(parseLoggedEvent(event)); } },
  });
  return {
    transcriptBreaks: events.filter((event) => event.kind === 'prompt_cache_break'),
    progressBreaks: progress.events.filter((event) => event.kind === 'prompt_cache_break'),
  };
}

test('a turn that re-prefills far more than the prompt grew is logged and reported as a cache break', async () => {
  const { transcriptBreaks, progressBreaks } = await runWithPrefills('cache-break', [null, 10, 1_000_000]);

  assert.deepEqual(transcriptBreaks.map((event) => [event.turn, event.promptEvalTokens]), [[3, 1_000_000]]);
  assert.deepEqual(progressBreaks.map((event) => event.turn), [3]);
});

test('a run whose turns re-prefill only what the prompt grew reports no cache break', async () => {
  const { transcriptBreaks, progressBreaks } = await runWithPrefills('cache-intact', [null, 10, 10]);

  assert.deepEqual(transcriptBreaks, []);
  assert.deepEqual(progressBreaks, []);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node ./src/test-runner/run-tests.ts prompt-cache-break-loop`
Expected: FAIL. `MockPlannerResponseSchema` is strict, so `promptEvalTokens` is rejected as an unknown key.

- [ ] **Step 3: Let mock responses report prefill counts**

In `src/planner-protocol/mock-response.ts`, add to `MockPlannerResponseSchema` after `finishReason`:

```ts
  /** Simulates the engine's reported prefill and cached-token counts for this response. */
  promptEvalTokens: z.number().int().nonnegative().nullable().default(null),
  promptCacheTokens: z.number().int().nonnegative().nullable().default(null),
```

Then add the same two fields to `parseMockPlannerResponse`'s declared return type (`promptEvalTokens: number | null; promptCacheTokens: number | null;`) and to its returned object (`promptEvalTokens: response.promptEvalTokens, promptCacheTokens: response.promptCacheTokens,`).

In `src/repo-search/planner-protocol.ts`, in the mock branch's non-exhausted `return { ... }` (after `stop: mock.stop,`), add:

```ts
      promptEvalTokens: mock.promptEvalTokens,
      promptCacheTokens: mock.promptCacheTokens,
```

- [ ] **Step 4: Add the progress event and its emitter**

In `src/repo-search/types.ts`:
- import `PromptCacheBreakSchema` from `@siftkit/contracts`;
- add this member to `RepoSearchProgressEventSchema`'s union, after the `progress_update` entry:

```ts
  // turn comes from the break itself; the remaining task fields are the shared ones.
  PromptCacheBreakSchema.extend({
    kind: z.literal('prompt_cache_break'),
    taskId: z.string(),
    maxTurns: z.number(),
    elapsedMs: z.number(),
  }),
```

In `src/repo-search/engine/progress-reporter.ts`, import `type { PromptCacheBreak } from '@siftkit/contracts'` and add this method to `ProgressReporter`:

```ts
  promptCacheBreak(cacheBreak: PromptCacheBreak): void {
    this.emit({ kind: 'prompt_cache_break', taskId: this.taskId, maxTurns: this.maxTurns, elapsedMs: this.elapsedMs(), ...cacheBreak });
  }
```

- [ ] **Step 5: Feed the watch from the task loop**

In `src/repo-search/engine/task-loop.ts`:
- import `{ PromptCacheWatch } from './prompt-cache-watch.ts'`;
- add the field `private readonly promptCacheWatch = new PromptCacheWatch();` beside `lastCompactionSummary`;
- in `prepareTurn`, inside `if (prepared.compactionSummary !== null) { ... }`, add as its last statement:

```ts
      this.promptCacheWatch.noteCompaction();
```

In `requestModelResponse`, directly after the `this.options.logger?.write({ kind: 'turn_model_response', ... });` call, add:

```ts
    const cacheBreak = this.promptCacheWatch.observe({
      turn,
      promptTokens: prepared.promptTokenCount,
      promptEvalTokens: Number.isFinite(response.promptEvalTokens) ? Number(response.promptEvalTokens) : null,
      promptCacheTokens: Number.isFinite(response.promptCacheTokens) ? Number(response.promptCacheTokens) : null,
    });
    if (cacheBreak !== null) {
      this.options.logger?.write({ kind: 'prompt_cache_break', taskId: this.task.id, ...cacheBreak });
      this.progress.promptCacheBreak(cacheBreak);
    }
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `node ./src/test-runner/run-tests.ts prompt-cache-break-loop prompt-cache-watch repo-agent-truncated-finish mock-repo-search-loop engine-token-usage`
Expected: PASS.

- [ ] **Step 7: Do not commit**

---

### Task 4: The lifecycle writer stores the break and warns the run

**Files:**
- Modify: `src/repo-search/execute.ts` (`RepoSearchLifecycleWriter`, about line 165)
- Create: `tests/repo-search-lifecycle-writer.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/repo-search-lifecycle-writer.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { ProgressWriter } from '../src/lib/progress-writer.ts';
import { RepoSearchLifecycleWriter } from '../src/repo-search/execute.ts';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.ts';
import { listEngineEvents } from '../src/state/engine-events.ts';
import { getRuntimeDatabase } from '../src/state/runtime-db.ts';
import { withTempEnv } from './_runtime-helpers.ts';

class CaptureWriter extends ProgressWriter<RepoSearchProgressEvent> {
  readonly events: RepoSearchProgressEvent[] = [];
  get enabled(): boolean { return true; }
  write(event: RepoSearchProgressEvent): void { this.events.push(event); }
}

test('a cache break becomes an engine event of its run and reaches the run as a context warning', async () => {
  await withTempEnv(async () => {
    const target = new CaptureWriter();
    new RepoSearchLifecycleWriter('run-7', target).write({
      kind: 'prompt_cache_break', taskId: 'task', turn: 3, maxTurns: 6, elapsedMs: 42,
      promptTokens: 9_100, previousPromptTokens: 9_000, promptEvalTokens: 9_050, promptCacheTokens: 50,
    });

    assert.deepEqual(target.events, [{
      kind: 'context_warning', warningText: 'Prompt cache broke on turn 3: re-prefilled 9,050 tokens where the prompt grew 100.', elapsedMs: 42,
    }]);
    const events = listEngineEvents(getRuntimeDatabase(), 10);
    assert.deepEqual(events.map((event) => [event.kind, event.runId, event.turn, event.summary]), [
      ['prompt_cache_break', 'run-7', 3, 'Turn 3 re-prefilled 9,050 tokens; the prompt grew 100'],
    ]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node ./src/test-runner/run-tests.ts repo-search-lifecycle-writer`
Expected: FAIL, because `RepoSearchLifecycleWriter` is not exported.

- [ ] **Step 3: Implement**

In `src/repo-search/execute.ts`, add these imports:

```ts
import type { PromptCacheBreak } from '@siftkit/contracts';
import { insertEngineEvent } from '../state/engine-events.ts';
import {
  describePromptCacheBreak,
  formatPromptCacheBreakDetail,
  summarizePromptCacheBreak,
} from './engine/prompt-cache-watch.ts';
```

`getErrorMessage` and `getRuntimeDatabase` are already imported.

Add this function above the class:

```ts
/** Stores a run's cache break for the Logs tab; a failed write is logged, never thrown into the run. */
function recordPromptCacheBreak(requestId: string, cacheBreak: PromptCacheBreak): void {
  const summary = summarizePromptCacheBreak(cacheBreak);
  try {
    insertEngineEvent(getRuntimeDatabase(), {
      kind: 'prompt_cache_break', inferenceRunId: null, runId: requestId, turn: cacheBreak.turn,
      summary, detail: formatPromptCacheBreakDetail(cacheBreak),
    });
  } catch (error) {
    serverLogger.emitBody('rs', requestId, { event: 'engine_event_lost', fields: `${summary}: ${getErrorMessage(error)}`, severity: 'error' });
  }
}
```

Change `class RepoSearchLifecycleWriter` to `export class RepoSearchLifecycleWriter`, and replace its `write`:

```ts
  write(event: RepoSearchProgressEvent): void {
    if (event.kind === 'prompt_cache_break') {
      const { kind: _kind, taskId: _taskId, maxTurns: _maxTurns, elapsedMs, ...cacheBreak } = event;
      recordPromptCacheBreak(this.requestId, cacheBreak);
      // The chat banner and the CLI already show context warnings, so the break travels as one.
      const warning = { ...contextWarningEvent(describePromptCacheBreak(cacheBreak)), elapsedMs };
      logRepoSearchLifecycleEvent(this.requestId, warning);
      this.target.write(warning);
      return;
    }
    logRepoSearchLifecycleEvent(this.requestId, event);
    this.target.write(event);
  }
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node ./src/test-runner/run-tests.ts repo-search-lifecycle-writer chat-repo-operation-runner`
Expected: PASS.

- [ ] **Step 5: Do not commit**

---

### Task 5: Engine errors and unrequested exits from TabbyAPI

**Files:**
- Modify: `src/status-server/tabby-run-recorder.ts`, `tests/tabby-run-recorder.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/tabby-run-recorder.test.ts`. Add these imports at the top: `listEngineEvents` from `../src/state/engine-events.ts`, and `getRuntimeDatabase` from `../src/state/runtime-db.ts`.

```ts
const ASGI_ERROR = [
  '23:19:36.937 ERROR:    Exception in ASGI application\n',
  '  + Exception Group Traceback (most recent call last):\n',
  '  |   File "C:\\tabby\\endpoints.py", line 9, in stream\n',
  '  | RuntimeError: Cannot call write() when UVStream is closed\n',
  '  +------------------------------------\n',
  '23:19:37.002 INFO:     #1313 chat/completions (stream): 10 tokens generated\n',
].join('');

const engineEvents = () => listEngineEvents(getRuntimeDatabase(), 20);

test('an engine ERROR record split across chunks becomes one engine_error event', async () => {
  await withTabbyRecorder((recorder, { stdout }) => {
    stdout.write(ASGI_ERROR.slice(0, 70));
    stdout.write(ASGI_ERROR.slice(70));

    const events = engineEvents();
    assert.deepEqual(events.map((event) => [event.kind, event.inferenceRunId, event.summary]), [[
      'engine_error', recorder.runId, 'Exception in ASGI application — RuntimeError: Cannot call write() when UVStream is closed',
    ]]);
    assert.match(events[0]?.detail ?? '', /endpoints\.py/u);
    assert.doesNotMatch(events[0]?.detail ?? '', /tokens generated/u);
  });
});

test('INFO and WARNING records are not engine errors', async () => {
  await withTabbyRecorder((_recorder, { stdout, stderr }) => {
    stdout.write('08:53:57.716 WARNING:  No sampler overrides are configured\n08:53:58.000 INFO:     Loaded\n');
    stderr.write('08:54:18.879 WARNING:  Disabling authentication makes your instance vulnerable.\n');
    assert.deepEqual(engineEvents(), []);
  });
});

test('an ERROR record still open when its stream ends is recorded', async () => {
  await withTabbyRecorder(async (recorder, { stderr }) => {
    stderr.write('01:00:00.000 CRITICAL: Model load failed\nTraceback (most recent call last):\nOSError: [WinError 1450] Insufficient system resources exist');
    stderr.end();
    await recorder.waitForEngineStderrEnd(1_000);
    assert.deepEqual(engineEvents().map((event) => event.summary), ['Model load failed — OSError: [WinError 1450] Insufficient system resources exist']);
  });
});

test('an engine that exits on its own after becoming ready records one engine_exit event', async () => {
  await withTabbyRecorder((recorder, { stderr }) => {
    recorder.finish({ status: 'ready', baseUrl: 'http://127.0.0.1:1' });
    stderr.write(TRACEBACK);
    recorder.finish({ status: 'failed', exitCode: 1 });

    const events = engineEvents();
    assert.deepEqual(events.map((event) => [event.kind, event.summary]), [[
      'engine_exit', 'Engine exited with code 1: RuntimeError: Insufficient VRAM in split for model and cache',
    ]]);
    assert.match(events[0]?.detail ?? '', /Traceback/u);
  });
});

test('a requested stop or a failure before ready records no engine_exit', async () => {
  await withTabbyRecorder((recorder) => {
    recorder.finish({ status: 'failed', exitCode: 1 });
    recorder.finish({ status: 'ready', baseUrl: 'http://127.0.0.1:1' });
    recorder.finish({ status: 'stopped', exitCode: 0 });
    assert.deepEqual(engineEvents(), []);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `node ./src/test-runner/run-tests.ts tabby-run-recorder`
Expected: the five new tests FAIL with empty event lists. The existing tests still pass.

- [ ] **Step 3: Implement**

Replace `src/status-server/tabby-run-recorder.ts` with:

```ts
import { setTimeout as delay } from 'node:timers/promises';

import { getErrorMessage } from '../lib/errors.ts';
import { insertEngineEvent, type EngineEventInput } from '../state/engine-events.ts';
import type { InferenceRunStatus, InferenceRunStreamKind } from '../state/inference-runs.ts';
import { getRuntimeDatabase } from '../state/runtime-db.ts';
import { InferenceRunRecorder } from './inference-run-recorder.ts';
import { serverLogger } from './server-logger.ts';

const MTP_DRAFTING_MARKER = 'Using main model MTP component for drafting';
const PYTHON_EXCEPTION_LINE = /^[A-Za-z_][\w.]*(?:Error|Exception): .+/u;
// TabbyAPI starts every log record with `HH:MM:SS.mmm LEVEL:`; other lines continue the open record.
const LOG_RECORD_START = /^\d{2}:\d{2}:\d{2}\.\d{3} [A-Z]+:/u;
const ERROR_RECORD_START = /^\d{2}:\d{2}:\d{2}\.\d{3} (?:ERROR|CRITICAL):\s*(.*)$/u;
// Exception-group tracebacks prefix their lines with `|` and `+`.
const TRACEBACK_PREFIX = /^[\s|+]*/u;
const EXIT_DETAIL_LINES = 40;

type EngineStreamKind = 'engine_stdout' | 'engine_stderr';
type OpenErrorRecord = { message: string; lines: string[]; exception: string | null };

/** Tracks startup facts, engine errors, and unrequested exits directly from TabbyAPI streams. */
export class TabbyRunRecorder extends InferenceRunRecorder {
  private readonly trailingTextByStream = new Map<InferenceRunStreamKind, string>();
  private readonly partialLineByStream = new Map<EngineStreamKind, string>();
  private readonly openRecordByStream = new Map<EngineStreamKind, OpenErrorRecord>();
  private readonly recentStderrLines: string[] = [];
  private mtpDraftingMarkerSeen = false;
  private lastEngineErrorLine: string | null = null;
  private readyReached = false;
  private engineStderrEnd: Promise<void> = Promise.resolve();

  hasMtpDraftingMarker(): boolean {
    return this.mtpDraftingMarkerSeen;
  }

  /** The last Python exception line the engine wrote to stderr, e.g. `RuntimeError: ...`. */
  lastEngineError(): string | null {
    return this.lastEngineErrorLine;
  }

  override attachEngineStdout(stream: NodeJS.ReadableStream | null): void {
    super.attachEngineStdout(stream);
    stream?.once('end', () => this.endEngineStream('engine_stdout'));
  }

  override attachEngineStderr(stream: NodeJS.ReadableStream | null): void {
    super.attachEngineStderr(stream);
    if (stream === null) return;
    // A last line without a newline is observed once the stream ends.
    this.engineStderrEnd = new Promise((resolve) => {
      stream.once('end', () => {
        this.endEngineStream('engine_stderr');
        resolve();
      });
    });
  }

  /** Resolves once engine stderr has ended and its last line is observed, or after `timeoutMs`. */
  async waitForEngineStderrEnd(timeoutMs: number): Promise<void> {
    await Promise.race([this.engineStderrEnd, delay(timeoutMs, undefined, { ref: false })]);
  }

  /** An engine that was ready and then failed without being stopped is recorded as an engine exit. */
  override finish(options: { status: InferenceRunStatus; exitCode?: number | null; errorMessage?: string | null; baseUrl?: string | null }): void {
    if (options.status === 'ready') this.readyReached = true;
    if (options.status === 'failed' && this.readyReached) {
      const engineError = this.lastEngineErrorLine === null ? '' : `: ${this.lastEngineErrorLine}`;
      this.recordEngineEvent({
        kind: 'engine_exit', inferenceRunId: this.runId, runId: null, turn: null,
        summary: `Engine exited with code ${String(options.exitCode ?? null)}${engineError}`,
        detail: this.recentStderrLines.join('\n'),
      });
    }
    super.finish(options);
  }

  protected override observeRawChunk(streamKind: InferenceRunStreamKind, chunkText: string): void {
    if (streamKind === 'engine_stdout' || streamKind === 'engine_stderr') this.observeEngineText(streamKind, chunkText);
    if (this.mtpDraftingMarkerSeen) return;
    const combined = `${this.trailingTextByStream.get(streamKind) ?? ''}${chunkText}`;
    if (combined.includes(MTP_DRAFTING_MARKER)) {
      this.mtpDraftingMarkerSeen = true;
      this.trailingTextByStream.clear();
      return;
    }
    this.trailingTextByStream.set(streamKind, combined.slice(-(MTP_DRAFTING_MARKER.length - 1)));
  }

  private endEngineStream(streamKind: EngineStreamKind): void {
    this.observeEngineText(streamKind, '\n');
    this.closeErrorRecord(streamKind);
  }

  private observeEngineText(streamKind: EngineStreamKind, chunkText: string): void {
    const lines = `${this.partialLineByStream.get(streamKind) ?? ''}${chunkText}`.split('\n');
    this.partialLineByStream.set(streamKind, lines.pop() ?? '');
    for (const line of lines) this.observeEngineLine(streamKind, line.replace(/\r/gu, '').trimEnd());
  }

  private observeEngineLine(streamKind: EngineStreamKind, line: string): void {
    const exceptionCandidate = line.replace(TRACEBACK_PREFIX, '');
    const isException = PYTHON_EXCEPTION_LINE.test(exceptionCandidate);
    if (streamKind === 'engine_stderr') {
      if (isException) this.lastEngineErrorLine = exceptionCandidate;
      this.recentStderrLines.push(line);
      if (this.recentStderrLines.length > EXIT_DETAIL_LINES) this.recentStderrLines.shift();
    }
    if (LOG_RECORD_START.test(line)) {
      this.closeErrorRecord(streamKind);
      const errorStart = ERROR_RECORD_START.exec(line);
      if (errorStart !== null) this.openRecordByStream.set(streamKind, { message: (errorStart[1] ?? '').trim(), lines: [line], exception: null });
      return;
    }
    const record = this.openRecordByStream.get(streamKind);
    if (record === undefined) return;
    record.lines.push(line);
    if (isException) record.exception = exceptionCandidate;
  }

  private closeErrorRecord(streamKind: EngineStreamKind): void {
    const record = this.openRecordByStream.get(streamKind);
    if (record === undefined) return;
    this.openRecordByStream.delete(streamKind);
    this.recordEngineEvent({
      kind: 'engine_error', inferenceRunId: this.runId, runId: null, turn: null,
      summary: record.exception === null ? record.message : `${record.message} — ${record.exception}`,
      detail: record.lines.join('\n'),
    });
  }

  /** Stream handlers must not throw, so a failed write is logged with the event it lost. */
  private recordEngineEvent(input: EngineEventInput): void {
    try {
      insertEngineEvent(getRuntimeDatabase(), input);
    } catch (error) {
      serverLogger.emitBody('engine', this.runId, { event: 'engine_event_lost', fields: `${input.summary}: ${getErrorMessage(error)}`, severity: 'error' });
    }
  }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node ./src/test-runner/run-tests.ts tabby-run-recorder inference-run-recorder managed-tabby`
Expected: PASS. The existing `lastEngineError` tests keep passing, because stderr exception lines still set it.

- [ ] **Step 5: Do not commit**

---

### Task 6: Break counts on run records, deletion with runs, and the events endpoint

**Files:**
- Modify: `packages/contracts/src/runs.ts`, `src/status-server/dashboard-runs/run-records.ts`, `src/status-server/dashboard-runs/queries.ts`, `src/status-server/dashboard-runs/deletion.ts`, `src/state/inference-runs.ts`, `src/status-server/routes/dashboard.ts`, `tests/dashboard-runs-partition.test.ts`, every `RunRecord` literal in tests
- Create: `tests/dashboard-engine-events-endpoint.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/dashboard-runs-partition.test.ts`:
- import `insertEngineEvent` and `countPromptCacheBreaksByRun` from `../src/state/engine-events.ts`;
- in the test `'dashboard deletion module deletes oldest matching run logs directly'`, insert two cache breaks after the `for` loop that seeds the runs:

```ts
    for (const runId of ['repo-1', 'repo-2']) {
      insertEngineEvent(database, { kind: 'prompt_cache_break', inferenceRunId: null, runId, turn: 2, summary: 's', detail: 'd' });
    }
```

and add at its end:

```ts
    assert.deepEqual([...countPromptCacheBreaksByRun(database, ['repo-1', 'repo-2'])], [['repo-2', 1]]);
    assert.equal(remaining[0]?.promptCacheBreakCount, 1);
    assert.equal(queryDashboardRunDetailFromDb(database, 'repo-2')?.run.promptCacheBreakCount, 1);
```

Change each `normalizeRunRecordFromDbRow(buildRunLogRow(...))` call in that file to pass a second argument, `0`.

`tests/dashboard-engine-events-endpoint.test.ts`. This uses the same in-process server setup as `tests/dashboard-status-server.run-logs.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { EngineEventsResponseSchema } from '@siftkit/contracts';
import { startStatusServer } from '../src/status-server/index.ts';
import { insertEngineEvent } from '../src/state/engine-events.ts';
import { getRuntimeDatabase } from '../src/state/runtime-db.ts';
import { getAddressInfo, requestJson } from './helpers/dashboard-http.ts';
import { configureDashboardTestEnv, enterDashboardTestRepo, restoreDashboardTestRepo } from './helpers/dashboard-test-repo.ts';
import { createManagedTempDir, removeDirectoryWithRetries } from './helpers/temp-dirs.ts';

test('GET /dashboard/engine-events returns the newest events, clamps the limit, and parses as the contract', async () => {
  const tempRoot = createManagedTempDir('siftkit-engine-events-endpoint-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const runtimeRoot = path.join(tempRoot, '.siftkit');
  const envBackup = configureDashboardTestEnv(tempRoot, path.join(runtimeRoot, 'status', 'inference.txt'), path.join(runtimeRoot, 'config.json'));
  const server = startStatusServer({ disableManagedEngineStartup: true });
  await server.startupPromise;
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;
  try {
    const database = getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite'));
    for (const turn of [1, 2, 3]) {
      insertEngineEvent(database, { kind: 'prompt_cache_break', inferenceRunId: null, runId: 'run-x', turn, summary: `t${turn}`, detail: '' });
    }

    const limited = await requestJson(`${baseUrl}/dashboard/engine-events?limit=2`);
    assert.equal(limited.statusCode, 200);
    assert.deepEqual(EngineEventsResponseSchema.parse(limited.body).events.map((event) => event.turn), [3, 2]);
    const clamped = await requestJson(`${baseUrl}/dashboard/engine-events?limit=0`);
    assert.equal(EngineEventsResponseSchema.parse(clamped.body).events.length, 1);
  } finally {
    await new Promise<void>((resolve, reject) => { server.close((error) => (error ? reject(error) : resolve())); });
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `node ./src/test-runner/run-tests.ts dashboard-runs-partition dashboard-engine-events-endpoint`
Expected: FAIL. `promptCacheBreakCount` is undefined, the cache-break counts are still `[['repo-1', 1], ['repo-2', 1]]`, and the endpoint returns 404.

- [ ] **Step 3: Implement the record field**

In `packages/contracts/src/runs.ts`, add to `RunRecordSchema` after `throughput`:

```ts
  /** Prompt-cache breaks recorded for this run. */
  promptCacheBreakCount: z.number().int().nonnegative(),
```

In `src/status-server/dashboard-runs/run-records.ts`:
- in `normalizeRunRecord`, add `promptCacheBreakCount: Number.isFinite(record.promptCacheBreakCount) ? Number(record.promptCacheBreakCount) : 0,` after `throughput`;
- change the signature to `export function normalizeRunRecordFromDbRow(row: RunLogDbRow, promptCacheBreakCount: number): RunRecord`, and pass `promptCacheBreakCount,` in its object.

In `src/status-server/dashboard-runs/queries.ts`, import `countPromptCacheBreaksByRun` from `../../state/engine-events.ts`. Replace the list's return:

```ts
  const breakCounts = countPromptCacheBreaksByRun(database, rows.map((row) => String(row.run_id || '')));
  return rows.map((row) => normalizeRunRecordFromDbRow(row, breakCounts.get(String(row.run_id || '')) ?? 0));
```

In `queryDashboardRunDetailFromDb`, replace `const run = normalizeRunRecordFromDbRow(row);` with:

```ts
  const run = normalizeRunRecordFromDbRow(row, countPromptCacheBreaksByRun(database, [runId]).get(runId) ?? 0);
```

Add `promptCacheBreakCount: 0,` to every `RunRecord` literal that typecheck reports. Known ones:
- `tests/helpers/mock-run-record.ts`;
- `tests/dashboard-benchmark.test.ts`;
- `dashboard/tests/runs-tab.test.tsx` (`makeRun`);
- `dashboard/tests/dashboard-runs-controller-e2e.test.ts` (`makeRun`; a plain object, so add it by hand);
- `dashboard/tests/format.test.ts`.

Run `npm run typecheck` to list any others.

- [ ] **Step 4: Delete events with their runs and engine runs**

In `src/status-server/dashboard-runs/deletion.ts`, import `deleteEngineEventsForRuns` from `../../state/engine-events.ts`. Inside `deleteDashboardRunLogs`'s `database.transaction(() => {`, add as its first statement:

```ts
    deleteEngineEventsForRuns(database, deletedRunIds);
```

In `src/state/inference-runs.ts`, import `deleteEngineEventsForInferenceRun` from `./engine-events.ts`. In `deleteInferenceRun`, add before the `DELETE FROM inference_runs` statement:

```ts
  deleteEngineEventsForInferenceRun(database, runId);
```

- [ ] **Step 5: Add the endpoint**

In `src/status-server/routes/dashboard.ts`, import `listEngineEvents` from `../../state/engine-events.ts` and the type `EngineEventsResponse` from `@siftkit/contracts`. Then add, next to `DashboardRunDetailEndpoint`:

```ts
class DashboardEngineEventsEndpoint implements RouteEndpoint {
  async handle(ctx: ServerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const limitValue = Number(requestUrl.searchParams.get('limit') || 200);
    const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(500, Math.trunc(limitValue))) : 200;
    const database = getIdleSummaryDatabase(ctx);
    sendJson(res, 200, { events: database ? listEngineEvents(database, limit) : [] } satisfies EngineEventsResponse);
  }
}
```

Register it after the `/dashboard/runs` detail route:

```ts
  { method: 'GET', path: '/dashboard/engine-events', endpoint: new DashboardEngineEventsEndpoint() },
```

Check that the `handle` signature matches the other endpoints in the file. Keep the unused `match` parameter if the interface requires it.

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `node ./src/test-runner/run-tests.ts dashboard-runs-partition dashboard-engine-events-endpoint dashboard-run-log-admin dashboard-status-server.run-logs contracts-runs`
Then: `npm run typecheck`
Expected: PASS, and typecheck is clean.

- [ ] **Step 7: Do not commit**

---

### Task 7: Dashboard: Engine section, run badge, and warning card

**Files:**
- Create: `dashboard/src/lib/engine-events.ts`, `dashboard/tests/engine-events.test.ts`
- Modify: `dashboard/src/api.ts`, `dashboard/src/hooks/useRunsController.ts`, `dashboard/src/tabs/RunsTab.tsx`, `dashboard/src/styles.css`, `dashboard/tests/runs-tab.test.tsx`, `dashboard/tests/dashboard-runs-controller-e2e.test.ts`

- [ ] **Step 1: Write the failing tests**

`dashboard/tests/engine-events.test.ts`:

```ts
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { EngineEvent } from '@siftkit/contracts';
import { groupEngineEvents } from '../src/lib/engine-events.ts';

const event = (id: string, kind: EngineEvent['kind'], summary: string): EngineEvent => ({
  id, occurredAtUtc: `2026-11-18T10:00:0${id}Z`, kind, inferenceRunId: null, runId: null, turn: null, summary, detail: '',
});

test('engine events with the same kind and summary, digits aside, collapse into one group, newest first', () => {
  const groups = groupEngineEvents([
    event('3', 'engine_error', 'WARNING #2930 failed'),
    event('2', 'prompt_cache_break', 'Turn 4 re-prefilled 9 tokens'),
    event('1', 'engine_error', 'WARNING #2911 failed'),
  ]);
  assert.deepEqual(groups.map((group) => [group.kind, group.summary, group.events.map((item) => item.id)]), [
    ['engine_error', 'WARNING #2930 failed', ['3', '1']],
    ['prompt_cache_break', 'Turn 4 re-prefilled 9 tokens', ['2']],
  ]);
});
```

In `dashboard/tests/runs-tab.test.tsx`:
- add `promptCacheBreakCount: 0,` to `makeRun`;
- add these props to `PROPS`:

```ts
  engineGroups: [],
  engineOnly: false,
  selectedEngineGroupKey: '',
  onToggleEngineOnly: () => {},
  onSelectEngineGroup: () => {},
```

Then append:

```ts
const ENGINE_GROUPS = groupEngineEvents([
  { id: 'e2', occurredAtUtc: '2026-11-18T10:00:02Z', kind: 'engine_error', inferenceRunId: 'eng-1', runId: null, turn: null, summary: 'Exception in ASGI application', detail: 'TRACE-TEXT' },
  { id: 'e1', occurredAtUtc: '2026-11-18T10:00:01Z', kind: 'engine_error', inferenceRunId: 'eng-1', runId: null, turn: null, summary: 'Exception in ASGI application', detail: 'older' },
  { id: 'c1', occurredAtUtc: '2026-11-18T09:00:00Z', kind: 'prompt_cache_break', inferenceRunId: null, runId: 'run_2', turn: 4, summary: 'Turn 4 re-prefilled 9,000 tokens; the prompt grew 100', detail: '' },
]);

test('the Engine section lists collapsed groups above the runs and shows a selected group with its run link', () => {
  const markup = renderToStaticMarkup(<RunsTab {...PROPS} engineGroups={ENGINE_GROUPS} selectedEngineGroupKey={ENGINE_GROUPS[0]?.key ?? ''} selectedRunDetail={null} />);
  assert.match(markup, /Engine \(exl3\) · 2/u);
  assert.match(markup, /Exception in ASGI application/u);
  assert.match(markup, /×2/u);
  assert.match(markup, /TRACE-TEXT/u);
  assert.ok(markup.indexOf('Engine (exl3)') < markup.indexOf('Repo Search · 2'));

  const cacheMarkup = renderToStaticMarkup(<RunsTab {...PROPS} engineGroups={ENGINE_GROUPS} selectedEngineGroupKey={ENGINE_GROUPS[1]?.key ?? ''} selectedRunDetail={null} />);
  assert.match(cacheMarkup, /Open run run_2/u);
});

test('the Engine chip shows only the Engine section', () => {
  const markup = renderToStaticMarkup(<RunsTab {...PROPS} engineGroups={ENGINE_GROUPS} engineOnly />);
  assert.match(markup, /Engine \(exl3\) · 2/u);
  assert.doesNotMatch(markup, /Repo Search · 2/u);
});

test('a run with cache breaks shows a badge, and its detail lists each break', () => {
  const broken = makeRun({ promptCacheBreakCount: 2 });
  const detail: RunDetailResponse = { run: broken, events: [
    { kind: 'prompt_cache_break', at: null, payload: { kind: 'prompt_cache_break', turn: 4, promptTokens: 9_100, previousPromptTokens: 9_000, promptEvalTokens: 9_000, promptCacheTokens: null } },
  ] };
  const markup = renderToStaticMarkup(<RunsTab {...PROPS} groupedRuns={{ ...PROPS.groupedRuns, repo_search: [broken] }} selectedRunDetail={detail} />);
  assert.match(markup, /⚠ cache ×2/u);
  assert.match(markup, /Turn 4 re-prefilled 9,000 tokens; the prompt grew 100/u);
});
```

Add the import `import { groupEngineEvents } from '../src/lib/engine-events.ts';`.

In `dashboard/tests/dashboard-runs-controller-e2e.test.ts`:
- add `promptCacheBreakCount: 0,` to `makeRun`;
- in `fetchStub`, before the `/dashboard/runs` branch, add:

```ts
    if (url.includes('/dashboard/engine-events')) {
      engineFetchCount += 1;
      return jsonResponse({ events: [] });
    }
```

- declare `let engineFetchCount = 0;` beside `runsFetchCount`;
- after the mount assertions, add `assert.equal(engineFetchCount, 1);`.

- [ ] **Step 2: Run them and confirm they fail**

From PowerShell: `npx vitest run --config .\dashboard\vitest.config.ts engine-events runs-tab dashboard-runs-controller-e2e`
Expected: FAIL. The module `../src/lib/engine-events.ts` is missing, the new props are unknown, and the engine fetch count is 0.

- [ ] **Step 3: Grouping helper and API**

`dashboard/src/lib/engine-events.ts`:

```ts
import type { EngineEvent, EngineEventKind } from '@siftkit/contracts';

export type EngineEventGroup = { key: string; kind: EngineEventKind; summary: string; events: EngineEvent[] };

export const ENGINE_EVENT_KIND_LABELS: Record<EngineEventKind, string> = {
  prompt_cache_break: 'Cache break',
  engine_error: 'Error',
  engine_exit: 'Exit',
};

/** Collapses events whose kind and summary match once digits are ignored; input and groups stay newest first. */
export function groupEngineEvents(events: readonly EngineEvent[]): EngineEventGroup[] {
  const groups = new Map<string, EngineEventGroup>();
  for (const event of events) {
    const key = `${event.kind}:${event.summary.replace(/\d+/gu, '#')}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { key, kind: event.kind, summary: event.summary, events: [event] });
    else group.events.push(event);
  }
  return [...groups.values()];
}
```

In `dashboard/src/api.ts`, import `EngineEventsResponseSchema` and `type EngineEventsResponse` from `@siftkit/contracts` (or from wherever `RunsResponseSchema` is imported in that file), then add:

```ts
export function getEngineEvents(): Promise<EngineEventsResponse> {
  return fetchJson('/dashboard/engine-events?limit=200', EngineEventsResponseSchema);
}
```

- [ ] **Step 4: Controller state**

In `dashboard/src/hooks/useRunsController.ts`:
- import `getEngineEvents` from `../api.ts`, and `groupEngineEvents` with the type `EngineEventGroup` from `../lib/engine-events.ts`;
- add state:

```ts
  const [engineGroups, setEngineGroups] = useState<EngineEventGroup[]>([]);
  const [engineOnly, setEngineOnly] = useState(false);
  const [selectedEngineGroupKey, setSelectedEngineGroupKey] = useState('');
```

- add an effect after the runs effect:

```ts
  useEffect(() => {
    let cancelled = false;
    void getEngineEvents()
      .then((response) => { if (!cancelled) setEngineGroups(groupEngineEvents(response.events)); })
      .catch((error) => { if (!cancelled) setRunsError(`Engine events: ${error instanceof Error ? error.message : String(error)}`); });
    return () => { cancelled = true; };
  }, [deps.refreshToken]);
```

- add to `tabProps`:

```ts
    engineGroups,
    engineOnly,
    selectedEngineGroupKey,
    onToggleEngineOnly: () => setEngineOnly((previous) => !previous),
    onSelectEngineGroup: (key) => { setSelectedEngineGroupKey(key); setSelectedRunId(''); },
```

- change `onSelectRun: setSelectedRunId,` to:

```ts
    onSelectRun: (runId) => { setSelectedEngineGroupKey(''); setSelectedRunId(runId); },
```

- [ ] **Step 5: RunsTab**

In `dashboard/src/tabs/RunsTab.tsx`:
- import `PromptCacheBreakSchema` from `@siftkit/contracts`;
- import `ENGINE_EVENT_KIND_LABELS` and `type EngineEventGroup` from `../lib/engine-events.ts`;
- import `summarizePromptCacheBreak` from `../../../src/repo-search/engine/prompt-cache-watch.ts`.

Add to `RunsTabProps`:

```ts
  engineGroups: EngineEventGroup[];
  engineOnly: boolean;
  selectedEngineGroupKey: string;
  onToggleEngineOnly(): void;
  onSelectEngineGroup(key: string): void;
```

Destructure them in the component. Make three changes in the list pane:

1. Add an engine chip to `chipItems`, after the kind chips: `{ value: 'engine', label: 'Engine', active: engineOnly },`. In `onToggleChip`, handle it first: `if (value === 'engine') { onToggleEngineOnly(); return; }`.

2. Inside `<div className="runs">`, before `{RUN_GROUP_KEYS.map(...)}`, render:

```tsx
          {engineGroups.length > 0 && (
            <>
              <div className="rgroup">Engine (exl3) · {engineGroups.length}</div>
              {engineGroups.map((group) => (
                <div
                  key={group.key}
                  className={selectedEngineGroupKey === group.key ? 'run sel' : 'run'}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectEngineGroup(group.key)}
                >
                  <span className="t">{group.summary}</span>
                  <span className="m">
                    {ENGINE_EVENT_KIND_LABELS[group.kind]} · ×{group.events.length} · {formatShortTime(group.events[0]?.occurredAtUtc ?? null)}
                  </span>
                </div>
              ))}
            </>
          )}
```

   Wrap the existing `RUN_GROUP_KEYS.map(...)` in `{!engineOnly && ...}`.

3. In each run row's `<span className="m">`, after the start time, add:

```tsx
                      {run.promptCacheBreakCount > 0 ? <span className="cache-break-badge"> · ⚠ cache ×{run.promptCacheBreakCount}</span> : null}
```

Make two changes in the detail pane. Compute `const selectedEngineGroup = engineGroups.find((group) => group.key === selectedEngineGroupKey) ?? null;` before the `return`.

1. Change the detail ternary to render the engine group first:

```tsx
        {selectedEngineGroup ? (
          <>
            <h2>{selectedEngineGroup.summary}</h2>
            <div className="meta-line">
              <span>{ENGINE_EVENT_KIND_LABELS[selectedEngineGroup.kind]}</span>
              <span>×{selectedEngineGroup.events.length}</span>
              <span>latest {formatShortTime(selectedEngineGroup.events[0]?.occurredAtUtc ?? null)}</span>
              <span>first {formatShortTime(selectedEngineGroup.events.at(-1)?.occurredAtUtc ?? null)}</span>
            </div>
            {selectedEngineGroup.events[0]?.runId ? (
              <button type="button" className="chip" onClick={() => onSelectRun(selectedEngineGroup.events[0]?.runId ?? '')}>
                Open run {selectedEngineGroup.events[0]?.runId}
              </button>
            ) : null}
            <div className="card">
              <header><b>Latest</b><span>{formatDate(selectedEngineGroup.events[0]?.occurredAtUtc ?? '')}</span></header>
              <pre className="mono engine-event-detail">{selectedEngineGroup.events[0]?.detail ?? ''}</pre>
            </div>
            <div className="card">
              <header><b>Occurrences</b></header>
              <ul className="cbody">{selectedEngineGroup.events.map((event) => <li key={event.id}>{formatDate(event.occurredAtUtc)}</li>)}</ul>
            </div>
          </>
        ) : selectedRunDetail ? (
```

   Keep the existing run-detail branch and the final `: (<p className="hint">…</p>)` unchanged.

2. In the run-detail branch, right after the `meta-line` div, add the warning card:

```tsx
            {(() => {
              const breaks = selectedRunDetail.events
                .filter((event) => event.kind === 'prompt_cache_break')
                .flatMap((event) => { const parsed = PromptCacheBreakSchema.safeParse(event.payload); return parsed.success ? [parsed.data] : []; });
              if (breaks.length === 0) return null;
              return (
                <div className="card cache-break-warning">
                  <header><b>⚠ Prompt cache broke on {breaks.length} turn{breaks.length === 1 ? '' : 's'}</b></header>
                  <ul className="cbody">{breaks.map((cacheBreak) => <li key={cacheBreak.turn}>{summarizePromptCacheBreak(cacheBreak)}</li>)}</ul>
                </div>
              );
            })()}
```

Append to `dashboard/src/styles.css`:

```css
.cache-break-badge { color: var(--warn, #b7791f); }
.cache-break-warning header b { color: var(--warn, #b7791f); }
.engine-event-detail { white-space: pre-wrap; max-height: 28rem; overflow: auto; }
```

- [ ] **Step 6: Run the tests and confirm they pass**

From PowerShell: `npx vitest run --config .\dashboard\vitest.config.ts engine-events runs-tab dashboard-runs-controller-e2e`
Then: `npm run typecheck`
Expected: PASS, and typecheck is clean.

- [ ] **Step 7: Do not commit**

---

### Task 8: Full verification and live check

- [ ] **Step 1: Run every suite**
  - `node ./src/test-runner/run-tests.ts` → 0 failures.
  - From PowerShell: `npx vitest run --config .\dashboard\vitest.config.ts` → all pass.
  - `npm run typecheck` and `npm run lint` → clean.
  - Process suite, excluding the browser test `chat-overflow`: `node ./src/test-runner/run-tests.ts --process <every tests/process name except chat-overflow>`. The only allowed failure is the known `no-llama-references` one.

- [ ] **Step 2: Live check (the user's machine; the server must be restarted to load the code)**
  1. Run an orchestrator task with one worker on the active preset (Auto, 1.5 contexts). Expect no cache-break warnings, or only breaks whose numbers explain themselves.
  2. Set the preset to manual with a small `CacheRam` (for example 512 MiB), restart the engine through SiftKit, and run the same task. Expect:
     - the chat or CLI to show `Prompt cache broke on turn N…` on the orchestrator turns after a worker run;
     - the orchestrator's Logs row to show `⚠ cache ×N`;
     - the Engine (exl3) section to list the breaks, each linking to its run.
  3. Cancel a chat mid-generation. Expect an `engine_error` row for `Exception in ASGI application — RuntimeError: Cannot call write() when UVStream is closed`.
  4. Restore the preset to Auto at 1.5 and restart.

- [ ] **Step 3: Report the result, the changed files, the validation output, and any risks. Do not commit.**

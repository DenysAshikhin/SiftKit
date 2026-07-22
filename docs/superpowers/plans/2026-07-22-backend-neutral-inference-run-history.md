# Backend-Neutral Inference Run History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record managed TabbyAPI (EXL3) process runs in the runtime database with the same fidelity as managed llama.cpp runs — a run row per launch, streamed log chunks, terminal status and exit code, retention and dashboard visibility — so run history is backend-neutral instead of llama-only.

**Architecture:** Extract the run-recording concern out of `managed-llama.ts` into a reusable `InferenceRunRecorder` class that owns the run row, the stream collectors, the storage filter and the flush queue. `managed-llama.ts` keeps its llama-specific speculative-metrics scraping by subclassing the recorder and overriding one protected hook — no callbacks are passed around. `ManagedTabbyRuntime` uses the base recorder directly and drops its single truncate-on-every-spawn file log. The `managed_llama_runs` / `managed_llama_log_chunks` tables are replaced (not aliased) by `inference_runs` / `inference_run_log_chunks` carrying a `backend` discriminator.

**Tech Stack:** TypeScript (ESM, NodeNext), better-sqlite3, Zod runtime schemas, `node:test` via `dist/scripts/run-tests.js`.

---

## Background: what was verified

1. `ManagedTabbyRuntime` writes stdout and stderr with `fs.appendFileSync` to a single file — `<getManagedTabbyLogRoot()>/latest-startup.log` — which is truncated on every spawn ([managed-tabby.ts:42](../../../src/status-server/managed-tabby.ts#L42), [:176-177](../../../src/status-server/managed-tabby.ts#L176-L177), [:265-267](../../../src/status-server/managed-tabby.ts#L265-L267)). No run row, no history, no retention, no dashboard read path, and no storage filtering.
2. The only creator of run rows is `createManagedLlamaLogRun` ([managed-llama.ts:538-555](../../../src/status-server/managed-llama.ts#L538-L555)); terminal status is written at [:840](../../../src/status-server/managed-llama.ts#L840) (exit), [:860](../../../src/status-server/managed-llama.ts#L860) (spawn error), [:1238](../../../src/status-server/managed-llama.ts#L1238) (ready), [:1262](../../../src/status-server/managed-llama.ts#L1262) (startup failed).
3. Stream collection lives in the free function `attachStreamCollector` ([managed-llama.ts:577-619](../../../src/status-server/managed-llama.ts#L577-L619)), which applies `ManagedLlamaLogStorageFilter`, feeds the llama speculative scraper, buffers chunks and enqueues a flush on `ctx.managedLlamaFlushQueue`.
4. `ManagedInferenceRuntime` ([managed-inference-runtime.ts](../../../src/status-server/managed-inference-runtime.ts)) is a 33-line process/model state machine with zero persistence, so the two subclasses share nothing.
5. `ManagedLlamaRuntime` ([managed-llama-runtime.ts](../../../src/status-server/managed-llama-runtime.ts)) is a thin adapter that delegates to `managed-llama.ts` free functions via `ServerContext`. **Do not** try to move llama's spawn path into the base class — that is a rewrite of a 1510-line module for no benefit. Share the recorder, not the lifecycle.
6. The tables are llama-shaped by name and by schema: `script_path`, llama-log-derived `speculative_*`, and a `stream_kind` CHECK hard-coding `startup_script_*` / `llama_*` ([runtime-db.ts:391-434](../../../src/state/runtime-db.ts#L391-L434)).
7. `CURRENT_SCHEMA_VERSION` is `33` ([runtime-db.ts:36](../../../src/state/runtime-db.ts#L36)); migrations are a linear `if (currentVersion < N)` chain ending at [runtime-db.ts:1286-1290](../../../src/state/runtime-db.ts#L1286-L1290).
8. `managed_llama_runs` is referenced outside the state module in exactly one place: the retention sweep in [dashboard-runs/deletion.ts:206-209](../../../src/status-server/dashboard-runs/deletion.ts#L206-L209).
9. `ManagedTabbyRuntime` is constructed at [index.ts:266](../../../src/status-server/index.ts#L266) with only the EXL3 engine config; the flush queue lives on `ctx` at [index.ts:260](../../../src/status-server/index.ts#L260).

Per repo policy there is **no backward compatibility**: the old tables are dropped, not migrated. Existing llama run history is disposable local telemetry.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| [src/state/runtime-db.ts](../../../src/state/runtime-db.ts) | Schema + migrations | Rename tables, add `backend`, generalize `stream_kind`, bump to 34 |
| `src/state/inference-runs.ts` | Run row + log chunk persistence | Create (renamed from `managed-llama-runs.ts`) |
| [src/state/managed-llama-runs.ts](../../../src/state/managed-llama-runs.ts) | — | Delete |
| `src/status-server/inference-run-recorder.ts` | Reusable run lifecycle + stream capture | Create |
| `src/status-server/llama-run-recorder.ts` | Llama speculative-scrape override | Create |
| [src/status-server/managed-llama.ts](../../../src/status-server/managed-llama.ts) | llama.cpp process management | Use `LlamaRunRecorder`; drop `createManagedLlamaLogRun` / `attachStreamCollector` |
| [src/status-server/managed-tabby.ts](../../../src/status-server/managed-tabby.ts) | TabbyAPI process management | Use `InferenceRunRecorder`; drop the file log |
| [src/status-server/dashboard-runs/deletion.ts](../../../src/status-server/dashboard-runs/deletion.ts) | Retention sweep | Point at `inference_runs` |
| [src/status-server/routes/dashboard.ts](../../../src/status-server/routes/dashboard.ts) | Run-list filters | Rename the status filter schema |
| [src/status-server/index.ts](../../../src/status-server/index.ts) | Wiring | Pass the flush queue to `ManagedTabbyRuntime` |
| `tests/inference-runs.test.ts` | Backend-parametrized run persistence | Create (renamed from `managed-llama-runs.test.ts`) |
| `tests/managed-tabby-run-history.test.ts` | E2E: Tabby launch produces a run row + chunks | Create |

---

### Task 1: Schema — backend-neutral tables

**Files:**
- Modify: [src/state/runtime-db.ts:36](../../../src/state/runtime-db.ts#L36), [:389-434](../../../src/state/runtime-db.ts#L389-L434), [:1286-1296](../../../src/state/runtime-db.ts#L1286-L1296)
- Test: `tests/runtime-db-schema-v34.test.ts` (create)

- [ ] **Step 1: Write the failing schema test**

Model this on the existing [tests/runtime-db-schema-v29.test.ts](../../../tests/runtime-db-schema-v29.test.ts) — open it and copy its temp-database bootstrap exactly.

Create `tests/runtime-db-schema-v34.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CURRENT_SCHEMA_VERSION, getRuntimeDatabase, closeRuntimeDatabase } from '../src/state/runtime-db.js';

test('schema 34 exposes backend-neutral inference run tables', () => {
  const root = mkdtempSync(join(tmpdir(), 'siftkit-schema34-'));
  try {
    const database = getRuntimeDatabase(join(root, 'runtime.sqlite'));
    assert.equal(CURRENT_SCHEMA_VERSION, 34);

    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String((row as { name: string }).name));

    assert.ok(tables.includes('inference_runs'), 'inference_runs must exist');
    assert.ok(tables.includes('inference_run_log_chunks'), 'inference_run_log_chunks must exist');
    assert.ok(!tables.includes('managed_llama_runs'), 'managed_llama_runs must be gone');
    assert.ok(!tables.includes('managed_llama_log_chunks'), 'managed_llama_log_chunks must be gone');

    const columns = database
      .prepare('PRAGMA table_info(inference_runs)')
      .all()
      .map((row) => String((row as { name: string }).name));
    assert.ok(columns.includes('backend'), 'inference_runs.backend must exist');
    assert.ok(columns.includes('entrypoint_path'), 'inference_runs.entrypoint_path must exist');
    assert.ok(!columns.includes('script_path'), 'script_path must be renamed');
  } finally {
    closeRuntimeDatabase();
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run build:test
node .\dist\scripts\run-tests.js runtime-db-schema-v34
```

Expected: FAIL — `CURRENT_SCHEMA_VERSION` is `33` and `inference_runs` does not exist.

- [ ] **Step 3: Replace the table definitions**

In [runtime-db.ts](../../../src/state/runtime-db.ts), rename `ensureManagedLlamaAndBenchmarkMatrixSchema` to `ensureInferenceRunAndBenchmarkMatrixSchema` and replace its first two `CREATE TABLE` blocks ([:391-434](../../../src/state/runtime-db.ts#L391-L434)) with:

```sql
    CREATE TABLE IF NOT EXISTS inference_runs (
      id TEXT PRIMARY KEY,
      backend TEXT NOT NULL
        CHECK (backend IN ('llama', 'exl3')),
      purpose TEXT NOT NULL,
      entrypoint_path TEXT,
      base_url TEXT,
      status TEXT NOT NULL
        CHECK (status IN ('running', 'ready', 'failed', 'stopped', 'sync_completed')),
      exit_code INTEGER,
      error_message TEXT,
      started_at_utc TEXT NOT NULL,
      finished_at_utc TEXT,
      updated_at_utc TEXT NOT NULL,
      speculative_accepted_tokens INTEGER,
      speculative_generated_tokens INTEGER,
      stdout_character_count INTEGER NOT NULL DEFAULT 0,
      stderr_character_count INTEGER NOT NULL DEFAULT 0,
      metrics_updated_at_utc TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_inference_runs_started
      ON inference_runs(started_at_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_inference_runs_status_started
      ON inference_runs(status, started_at_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_inference_runs_backend_started
      ON inference_runs(backend, started_at_utc DESC);

    CREATE TABLE IF NOT EXISTS inference_run_log_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES inference_runs(id) ON DELETE CASCADE,
      stream_kind TEXT NOT NULL
        CHECK (stream_kind IN (
          'launcher_stdout',
          'launcher_stderr',
          'engine_stdout',
          'engine_stderr',
          'startup_review',
          'startup_failure'
        )),
      sequence INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      created_at_utc TEXT NOT NULL,
      UNIQUE(run_id, stream_kind, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_inference_run_log_chunks_run_stream
      ON inference_run_log_chunks(run_id, stream_kind, sequence ASC);
    CREATE INDEX IF NOT EXISTS idx_inference_run_log_chunks_created_at
      ON inference_run_log_chunks(created_at_utc);
```

The stream-kind mapping is: llama's `startup_script_stdout` → `launcher_stdout`, `startup_script_stderr` → `launcher_stderr`, `llama_stdout` → `engine_stdout`, `llama_stderr` → `engine_stderr`. `startup_review` and `startup_failure` keep their names.

- [ ] **Step 4: Update the three call sites of the renamed function**

`ensureManagedLlamaAndBenchmarkMatrixSchema` is called at [runtime-db.ts:872](../../../src/state/runtime-db.ts#L872), [:886](../../../src/state/runtime-db.ts#L886), [:1293](../../../src/state/runtime-db.ts#L1293). Rename all three to `ensureInferenceRunAndBenchmarkMatrixSchema`.

- [ ] **Step 5: Add the version-34 migration**

Insert immediately after the `currentVersion < 33` block at [runtime-db.ts:1290](../../../src/state/runtime-db.ts#L1290):

```ts
  if (currentVersion < 34) {
    // No backward compatibility: managed llama run history is disposable local telemetry
    // and its schema is llama-shaped. Drop it and let the backend-neutral tables be created.
    database.exec(`
      DROP TABLE IF EXISTS managed_llama_log_chunks;
      DROP TABLE IF EXISTS managed_llama_runs;
    `);
    setSchemaVersion(database, 34);
    currentVersion = 34;
  }
```

- [ ] **Step 6: Bump the version constant**

At [runtime-db.ts:36](../../../src/state/runtime-db.ts#L36):

```ts
export const CURRENT_SCHEMA_VERSION = 34;
```

- [ ] **Step 7: Run the test**

```bash
npm run build:test
node .\dist\scripts\run-tests.js runtime-db-schema-v34
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/state/runtime-db.ts tests/runtime-db-schema-v34.test.ts
git commit -m "feat: replace managed llama run tables with backend-neutral inference run tables"
```

---

### Task 2: Rename the persistence module

**Files:**
- Create: `src/state/inference-runs.ts`
- Delete: [src/state/managed-llama-runs.ts](../../../src/state/managed-llama-runs.ts)
- Modify: `tests/managed-llama-runs.test.ts` → `tests/inference-runs.test.ts`

Every export drops its `ManagedLlama` prefix and gains backend awareness. This is a pure rename plus two signature changes; the body logic is unchanged.

- [ ] **Step 1: Move the file**

```bash
git mv src/state/managed-llama-runs.ts src/state/inference-runs.ts
git mv tests/managed-llama-runs.test.ts tests/inference-runs.test.ts
```

- [ ] **Step 2: Rename the types and stream kinds**

In `src/state/inference-runs.ts` apply these renames throughout:

| Old | New |
|---|---|
| `ManagedLlamaRunStatusSchema` / `ManagedLlamaRunStatus` | `InferenceRunStatusSchema` / `InferenceRunStatus` |
| `ManagedLlamaStreamKindSchema` / `ManagedLlamaStreamKind` | `InferenceRunStreamKindSchema` / `InferenceRunStreamKind` |
| `ManagedLlamaRunRowSchema` / `ManagedLlamaRunRow` | `InferenceRunRowSchema` / `InferenceRunRow` |
| `ManagedLlamaRunRecord` | `InferenceRunRecord` |
| `ManagedLlamaLogTextStatsByStream` | `InferenceRunLogTextStatsByStream` |
| `ManagedLlamaPendingLogChunkStats` | `InferenceRunPendingLogChunkStats` |
| `ManagedLlamaPendingLogChunkEntry` | `InferenceRunPendingLogChunkEntry` |
| `createManagedLlamaRun` | `createInferenceRun` |
| `updateManagedLlamaRun` | `updateInferenceRun` |
| `updateManagedLlamaRunSpeculativeMetrics` | `updateInferenceRunSpeculativeMetrics` |
| `readManagedLlamaRun` | `readInferenceRun` |
| `listManagedLlamaRuns` | `listInferenceRuns` |
| `deleteManagedLlamaRun` | `deleteInferenceRun` |
| `bufferManagedLlamaLogChunk` | `bufferInferenceRunLogChunk` |
| `appendManagedLlamaLogChunk` | `appendInferenceRunLogChunk` |
| `flushManagedLlamaLogChunks` | `flushInferenceRunLogChunks` |
| `readManagedLlamaLogTextByStream` | `readInferenceRunLogTextByStream` |
| `readManagedLlamaLogTextStatsByStream` | `readInferenceRunLogTextStatsByStream` |
| `getManagedLlamaPendingLogChunkStats` | `getInferenceRunPendingLogChunkStats` |
| `consumeManagedLlamaPendingLogChunks` | `consumeInferenceRunPendingLogChunks` |
| `restoreManagedLlamaPendingLogChunks` | `restoreInferenceRunPendingLogChunks` |
| `deleteManagedLlamaLogChunksOlderThan` | `deleteInferenceRunLogChunksOlderThan` |

Replace the stream-kind enum at [managed-llama-runs.ts:8-15](../../../src/state/managed-llama-runs.ts#L8-L15) with:

```ts
const InferenceRunStreamKindSchema = z.enum([
  'launcher_stdout',
  'launcher_stderr',
  'engine_stdout',
  'engine_stderr',
  'startup_review',
  'startup_failure',
]);
export type InferenceRunStreamKind = z.infer<typeof InferenceRunStreamKindSchema>;
```

and update the four `createEmpty*ByStream` helpers ([:100-131](../../../src/state/managed-llama-runs.ts#L100-L131)) and `createEmptyStreamCharacterCounts` ([:325-334](../../../src/state/managed-llama-runs.ts#L325-L334)) to use the new keys. All five must list the same six keys; a mismatch is a compile error, which is the intended safety net.

Rename every SQL identifier: `managed_llama_runs` → `inference_runs`, `managed_llama_log_chunks` → `inference_run_log_chunks`, `script_path` → `entrypoint_path`.

Rename the log line in `logPendingChunkPeak` ([:318-322](../../../src/state/managed-llama-runs.ts#L318-L322)) from `managed_llama pending_log_peak` to `inference_run pending_log_peak`.

- [ ] **Step 3: Add the `backend` column to the record and the two write paths**

Add to `InferenceRunRowSchema`:

```ts
  backend: z.string().nullable(),
```

Add a backend enum next to the status enum:

```ts
const InferenceBackendSchema = z.enum(['llama', 'exl3']);
export type InferenceRunBackend = z.infer<typeof InferenceBackendSchema>;

function normalizeBackend(value: string | null | undefined): InferenceRunBackend {
  const result = InferenceBackendSchema.safeParse(String(value || '').trim());
  if (!result.success) {
    throw new Error(`Unsupported inference run backend: ${String(value || '')}`);
  }
  return result.data;
}
```

Add `backend: InferenceRunBackend;` to `InferenceRunRecord`, set it in `normalizeRecord` as `backend: normalizeBackend(row.backend),`, and add it to `createInferenceRun`'s options and INSERT:

```ts
export function createInferenceRun(options: {
  id?: string;
  backend: InferenceRunBackend;
  purpose: string;
  entrypointPath?: string | null;
  baseUrl?: string | null;
  status?: InferenceRunStatus;
  databasePath?: string;
}): InferenceRunRecord {
  const database = getDatabase(options.databasePath);
  const id = String(options.id || '').trim() || randomUUID();
  const nowUtc = new Date().toISOString();
  const status = normalizeStatus(options.status || 'running');
  database.prepare(`
    INSERT INTO inference_runs (
      id, backend, purpose, entrypoint_path, base_url, status,
      exit_code, error_message, started_at_utc, finished_at_utc, updated_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?)
    ON CONFLICT(id) DO UPDATE SET
      backend = excluded.backend,
      purpose = excluded.purpose,
      entrypoint_path = excluded.entrypoint_path,
      base_url = excluded.base_url,
      status = excluded.status,
      updated_at_utc = excluded.updated_at_utc
  `).run(
    id,
    normalizeBackend(options.backend),
    String(options.purpose || '').trim() || 'unknown',
    options.entrypointPath ?? null,
    options.baseUrl ?? null,
    status,
    nowUtc,
    nowUtc,
  );
  const inserted = readInferenceRun(id, options.databasePath);
  if (!inserted) {
    throw new Error(`Failed to persist inference run: ${id}`);
  }
  return inserted;
}
```

Add `backend` to every `SELECT` column list in `readInferenceRun` and both branches of `listInferenceRuns`, and add an optional `backend` filter to `listInferenceRuns`:

```ts
export function listInferenceRuns(options: {
  limit?: number;
  status?: InferenceRunStatus | '';
  backend?: InferenceRunBackend | '';
  databasePath?: string;
} = {}): InferenceRunRecord[] {
```

Build the `WHERE` from whichever of `status` / `backend` are non-empty rather than duplicating the query a third time — one `const conditions: string[]` and one `const params: Array<string | number>` collapses the existing two branches into one.

- [ ] **Step 4: Update the test file**

In `tests/inference-runs.test.ts`, apply the same renames and add `backend: 'llama'` to every `createInferenceRun` call. Then add a case proving both backends coexist:

```ts
test('inference runs are recorded per backend', () => {
  const llama = createInferenceRun({ backend: 'llama', purpose: 'startup', databasePath });
  const exl3 = createInferenceRun({ backend: 'exl3', purpose: 'startup', databasePath });

  assert.equal(readInferenceRun(llama.id, databasePath)?.backend, 'llama');
  assert.equal(readInferenceRun(exl3.id, databasePath)?.backend, 'exl3');
  assert.equal(listInferenceRuns({ backend: 'exl3', databasePath }).length, 1);
});
```

Reuse whatever `databasePath` temp-directory fixture the file already sets up; do not add a second one.

- [ ] **Step 5: Run the test**

```bash
npm run build:test
node .\dist\scripts\run-tests.js inference-runs
```

Expected: PASS. The rest of the build will still be broken — that is handled in Tasks 3-6.

- [ ] **Step 6: Commit**

```bash
git add src/state/inference-runs.ts tests/inference-runs.test.ts
git commit -m "refactor: rename managed llama run persistence to backend-neutral inference runs"
```

---

### Task 3: Extract the reusable run recorder

**Files:**
- Create: `src/status-server/inference-run-recorder.ts`
- Test: `tests/inference-run-recorder.test.ts` (create)

This class is the DRY payload of the whole plan: it owns the run row, the stream collectors, the storage filter and the flush enqueue, so both backends record identically.

- [ ] **Step 1: Write the failing test**

Create `tests/inference-run-recorder.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InferenceRunRecorder } from '../src/status-server/inference-run-recorder.js';
import { ManagedLlamaFlushQueue } from '../src/status-server/managed-llama-flush-queue.js';
import { readInferenceRun, readInferenceRunLogTextByStream } from '../src/state/inference-runs.js';
import { getRuntimeDatabase, closeRuntimeDatabase } from '../src/state/runtime-db.js';

test('the recorder captures a run row, its streams, and its terminal status', async () => {
  const root = mkdtempSync(join(tmpdir(), 'siftkit-recorder-'));
  const databasePath = join(root, 'runtime.sqlite');
  getRuntimeDatabase(databasePath);
  const flushQueue = new ManagedLlamaFlushQueue({ idleDelayMs: 0 });
  try {
    const recorder = new InferenceRunRecorder({
      backend: 'exl3',
      purpose: 'startup',
      entrypointPath: 'C:/tabby/main.py',
      baseUrl: 'http://127.0.0.1:8098',
      flushQueue,
    });

    const stdout = new PassThrough();
    recorder.attachStdout(stdout);
    stdout.write('loading model\n');
    stdout.end();
    recorder.flush();

    assert.equal(readInferenceRunLogTextByStream(recorder.runId).engine_stdout, 'loading model\n');
    assert.equal(readInferenceRun(recorder.runId)?.status, 'running');

    recorder.finish({ status: 'ready' });
    assert.equal(readInferenceRun(recorder.runId)?.status, 'ready');
    assert.equal(readInferenceRun(recorder.runId)?.backend, 'exl3');
  } finally {
    await flushQueue.close();
    closeRuntimeDatabase();
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run build:test
node .\dist\scripts\run-tests.js inference-run-recorder
```

Expected: FAIL — `src/status-server/inference-run-recorder.ts` does not exist.

- [ ] **Step 3: Write the recorder**

Create `src/status-server/inference-run-recorder.ts`:

```ts
import { ManagedLlamaLogStorageFilter } from './managed-llama-log-storage-filter.js';
import { ManagedLlamaFlushQueue } from './managed-llama-flush-queue.js';
import {
  bufferInferenceRunLogChunk,
  createInferenceRun,
  flushInferenceRunLogChunks,
  updateInferenceRun,
  type InferenceRunBackend,
  type InferenceRunStatus,
  type InferenceRunStreamKind,
} from '../state/inference-runs.js';

export type InferenceRunRecorderOptions = {
  backend: InferenceRunBackend;
  purpose: string;
  entrypointPath: string | null;
  baseUrl: string | null;
  flushQueue: ManagedLlamaFlushQueue;
};

export type InferenceRunStreamProgress = {
  stdoutCharacters: number;
  stderrCharacters: number;
};

export class InferenceRunRecorder {
  readonly runId: string;
  readonly backend: InferenceRunBackend;
  readonly purpose: string;
  readonly baseUrl: string | null;
  readonly progress: InferenceRunStreamProgress = { stdoutCharacters: 0, stderrCharacters: 0 };
  private readonly flushQueue: ManagedLlamaFlushQueue;
  private flushEnabled = false;

  constructor(options: InferenceRunRecorderOptions) {
    this.backend = options.backend;
    this.purpose = options.purpose;
    this.baseUrl = options.baseUrl;
    this.flushQueue = options.flushQueue;
    this.runId = createInferenceRun({
      backend: options.backend,
      purpose: options.purpose,
      entrypointPath: options.entrypointPath,
      baseUrl: options.baseUrl,
      status: 'running',
    }).id;
  }

  /** Chunk flushes are queued only once the server is ready to drain them. */
  enableFlushQueue(): void {
    this.flushEnabled = true;
  }

  attachStdout(stream: NodeJS.ReadableStream | null): void {
    this.attach(stream, 'engine_stdout');
  }

  attachStderr(stream: NodeJS.ReadableStream | null): void {
    this.attach(stream, 'engine_stderr');
  }

  attachLauncherStdout(stream: NodeJS.ReadableStream | null): void {
    this.attach(stream, 'launcher_stdout');
  }

  attachLauncherStderr(stream: NodeJS.ReadableStream | null): void {
    this.attach(stream, 'launcher_stderr');
  }

  /**
   * Llama.cpp scrapes speculative-decode counters out of the raw (unfiltered) stream.
   * The base recorder has nothing to scrape; LlamaRunRecorder overrides this.
   */
  protected observeRawChunk(streamKind: InferenceRunStreamKind, chunkText: string): void {
    void streamKind;
    void chunkText;
  }

  appendLine(streamKind: InferenceRunStreamKind, text: string): void {
    this.observeRawChunk(streamKind, text);
    bufferInferenceRunLogChunk({ runId: this.runId, streamKind, chunkText: text });
    this.enqueueFlush();
  }

  flush(): void {
    flushInferenceRunLogChunks(this.runId);
  }

  finish(options: {
    status: InferenceRunStatus;
    exitCode?: number | null;
    errorMessage?: string | null;
    baseUrl?: string | null;
  }): void {
    updateInferenceRun({
      id: this.runId,
      status: options.status,
      exitCode: options.exitCode ?? null,
      errorMessage: options.errorMessage ?? null,
      finishedAtUtc: new Date().toISOString(),
      baseUrl: options.baseUrl ?? this.baseUrl,
    });
  }

  private enqueueFlush(): void {
    if (!this.flushEnabled) {
      return;
    }
    this.flushQueue.enqueue(this.runId);
  }

  private countProgress(streamKind: InferenceRunStreamKind, characters: number): void {
    if (streamKind === 'engine_stdout' || streamKind === 'launcher_stdout') {
      this.progress.stdoutCharacters += characters;
      return;
    }
    this.progress.stderrCharacters += characters;
  }

  private attach(stream: NodeJS.ReadableStream | null, streamKind: InferenceRunStreamKind): void {
    if (!stream) {
      return;
    }
    const storageFilter = new ManagedLlamaLogStorageFilter();
    stream.setEncoding?.('utf8');
    stream.on('data', (chunk: string | Buffer) => {
      try {
        const chunkText = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        this.countProgress(streamKind, chunkText.length);
        this.observeRawChunk(streamKind, chunkText);
        const filteredChunkText = storageFilter.filterChunk(chunkText);
        if (filteredChunkText) {
          bufferInferenceRunLogChunk({ runId: this.runId, streamKind, chunkText: filteredChunkText });
          this.enqueueFlush();
        }
      } catch {
        // Ignore teardown races after the runtime DB has already closed.
      }
    });
    stream.on('error', (error: Error) => {
      try {
        this.appendLine(streamKind, `\n[stream-error] ${error.message}\n`);
      } catch {
        // Ignore teardown races after the runtime DB has already closed.
      }
    });
  }
}
```

Note: the test writes to `engine_stdout` without calling `enableFlushQueue`, then calls `flush()` directly — matching how `managed-llama.ts` gates flushing on `ctx.managedLlamaReady` ([managed-llama.ts:557-562](../../../src/status-server/managed-llama.ts#L557-L562)).

- [ ] **Step 4: Run the test**

```bash
npm run build:test
node .\dist\scripts\run-tests.js inference-run-recorder
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/status-server/inference-run-recorder.ts tests/inference-run-recorder.test.ts
git commit -m "feat: add reusable InferenceRunRecorder for backend-neutral run capture"
```

---

### Task 4: Point llama.cpp at the recorder

**Files:**
- Create: `src/status-server/llama-run-recorder.ts`
- Modify: [src/status-server/managed-llama.ts:535-619](../../../src/status-server/managed-llama.ts#L535-L619), [:811-873](../../../src/status-server/managed-llama.ts#L811-L873), [:1238](../../../src/status-server/managed-llama.ts#L1238), [:1262](../../../src/status-server/managed-llama.ts#L1262)

- [ ] **Step 1: Write the llama subclass**

Create `src/status-server/llama-run-recorder.ts`:

```ts
import { InferenceRunRecorder } from './inference-run-recorder.js';
import { appendManagedLlamaSpeculativeMetricsChunk } from './managed-llama-speculative-metrics.js';
import type { InferenceRunStreamKind } from '../state/inference-runs.js';

/**
 * llama.cpp reports speculative-decode acceptance only in its stdout/stderr, and only in the
 * raw stream before the storage filter drops the request echo. Scrape it on the way past.
 */
export class LlamaRunRecorder extends InferenceRunRecorder {
  protected override observeRawChunk(streamKind: InferenceRunStreamKind, chunkText: string): void {
    appendManagedLlamaSpeculativeMetricsChunk({
      runId: this.runId,
      streamKind,
      chunkText,
    });
  }
}
```

Confirm the import path and exported name of `appendManagedLlamaSpeculativeMetricsChunk` first:

```bash
node -e "const{execSync}=require('child_process');" 
```

then:

```bash
npx rg -n "export function appendManagedLlamaSpeculativeMetricsChunk" src
```

Use whatever module that reports. If the speculative-metrics tracker's `streamKind` parameter is typed as the old `ManagedLlamaStreamKind`, retype it to `InferenceRunStreamKind` in that module — do not add a translation layer.

- [ ] **Step 2: Replace `createManagedLlamaLogRun` and `attachStreamCollector`**

Delete [managed-llama.ts:535-619](../../../src/status-server/managed-llama.ts#L535-L619) — the `MANAGED_STDOUT_STREAM` / `MANAGED_STDERR_STREAM` constants, `createManagedLlamaLogRun`, `enqueueManagedLlamaLogFlush`, `appendManagedLlamaLogLine` and `attachStreamCollector` are all now the recorder's job.

- [ ] **Step 3: Rewrite `spawnManagedLlamaProcess`**

Replace [managed-llama.ts:811-873](../../../src/status-server/managed-llama.ts#L811-L873) with:

```ts
function spawnManagedLlamaProcess(
  ctx: ServerContext,
  managed: ReturnType<typeof getManagedLlamaConfig>,
  purpose: string,
): { child: ChildProcess; recorder: LlamaRunRecorder } {
  const invocation = getManagedExecutableInvocation(ctx, managed);
  const recorder = new LlamaRunRecorder({
    backend: 'llama',
    purpose,
    entrypointPath: invocation.resolvedPath,
    baseUrl: managed.BaseUrl,
    flushQueue: ctx.managedLlamaFlushQueue,
  });
  if (ctx.managedLlamaReady) {
    recorder.enableFlushQueue();
  }
  const child = spawn(invocation.filePath, invocation.args, {
    cwd: invocation.cwd,
    env: {
      ...process.env,
      SIFTKIT_LLAMA_VERBOSE_LOGGING: managed.VerboseLogging ? '1' : '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: false,
  });
  recorder.attachLauncherStdout(child.stdout);
  recorder.attachLauncherStderr(child.stderr);
  child.on('exit', (code: number | null) => {
    try {
      recorder.flush();
      flushManagedLlamaSpeculativeMetricsTracker(recorder.runId);
    } catch {
      // The runtime DB may already be gone during test/process teardown.
    }
    const successStatus: InferenceRunStatus = purpose === 'shutdown' ? 'stopped' : 'ready';
    try {
      recorder.finish({
        status: (code ?? 0) === 0 ? successStatus : 'failed',
        exitCode: Number.isFinite(code) ? Number(code) : null,
      });
    } catch {
      // The runtime DB may already be gone during test/process teardown.
    }
  });
  child.on('error', (error: Error) => {
    try {
      recorder.appendLine('launcher_stderr', `\n[spawn-error] ${error.message}\n`);
      recorder.flush();
      flushManagedLlamaSpeculativeMetricsTracker(recorder.runId);
    } catch {
      // Ignore teardown races after the test/server has already closed.
    }
    try {
      recorder.finish({ status: 'failed', errorMessage: error.message });
    } catch {
      // Ignore teardown races after the test/server has already closed.
    }
    process.stderr.write(`[siftKitStatus] llama.cpp ${purpose} executable failed to spawn (${managed.ExecutablePath}): ${error.message}\n`);
  });
  return { child, recorder };
}
```

The launcher is a script that in turn runs llama-server, so its piped stdio is `launcher_*`. `engine_*` stays reserved for TabbyAPI, whose stdio is the engine itself.

- [ ] **Step 4: Update the startup path**

At [managed-llama.ts:1231-1267](../../../src/status-server/managed-llama.ts#L1231-L1267), `launched.logRef` becomes `launched.recorder`, `launched.progress` becomes `launched.recorder.progress`, and the two `updateManagedLlamaRun({ id: launched.logRef.runId, ... })` calls become:

```ts
      launched.recorder.finish({ status: 'ready', baseUrl });
```

and

```ts
      launched.recorder.finish({ status: 'failed', errorMessage, baseUrl });
```

- [ ] **Step 5: Fix the remaining `ManagedLlamaLogRef` consumers**

```bash
npx rg -n "ManagedLlamaLogRef|logRef" src
```

Every remaining consumer (`getManagedLlamaPrimaryStreamText`, `getManagedLlamaLogCursor`, `captureManagedLlamaSpeculativeMetricsSnapshot`, `collectManagedLlamaLogEntries`, `writeManagedLlamaStartupReviewDump`, `scanManagedLlamaStartupLogsOrFail`, `ctx.managedLlamaLastStartupLogs`) only ever reads `.runId`. Retype them to accept `LlamaRunRecorder | null` and delete the `ManagedLlamaLogRef` type from [server-types.ts](../../../src/status-server/server-types.ts). Update `collectManagedLlamaLogEntries`'s source list ([managed-llama.ts:881-886](../../../src/status-server/managed-llama.ts#L881-L886)) to the new stream kinds:

```ts
  const sources: Array<[string, InferenceRunStreamKind]> = [
    ['launcher_stdout', 'launcher_stdout'],
    ['launcher_stderr', 'launcher_stderr'],
    ['engine_stdout', 'engine_stdout'],
    ['engine_stderr', 'engine_stderr'],
  ];
```

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck:test
```

Expected: exit 0 once every rename lands. Fix errors until clean — the compiler is the checklist here.

- [ ] **Step 7: Run the llama tests**

```bash
npm run build:test
node .\dist\scripts\run-tests.js managed-llama
node .\dist\scripts\run-tests.js dashboard-status-server.run-logs
```

Expected: PASS. Any test asserting on the string `startup_script_stdout` or `llama_stdout` must be updated to the new stream kind — that is an intended rename, not a regression.

- [ ] **Step 8: Commit**

```bash
git add src/status-server/llama-run-recorder.ts src/status-server/managed-llama.ts src/status-server/server-types.ts tests/
git commit -m "refactor: record managed llama runs through InferenceRunRecorder"
```

---

### Task 5: Record managed Tabby runs

**Files:**
- Modify: [src/status-server/managed-tabby.ts](../../../src/status-server/managed-tabby.ts), [src/status-server/index.ts:266](../../../src/status-server/index.ts#L266)
- Test: `tests/managed-tabby-run-history.test.ts` (create)

- [ ] **Step 1: Write the failing E2E test**

Create `tests/managed-tabby-run-history.test.ts`. Look at how existing Tabby tests stub the spawned process and `TabbyModelClient` — reuse that harness. The assertions:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { listInferenceRuns, readInferenceRunLogTextByStream } from '../src/state/inference-runs.js';

test('a managed TabbyAPI launch is recorded as an inference run with log chunks', async () => {
  // Bootstrap ManagedTabbyRuntime against a fake python entrypoint that prints a known line
  // and a stubbed TabbyModelClient that reports ready, exactly as the existing Tabby tests do.
  const { runtime, preset, flushQueue, databasePath } = await startManagedTabbyFixture();
  try {
    await runtime.ensurePresetReady(preset);

    const runs = listInferenceRuns({ backend: 'exl3', databasePath });
    assert.equal(runs.length, 1, 'exactly one exl3 run must be recorded');
    assert.equal(runs[0].status, 'ready');
    assert.equal(runs[0].purpose, 'startup');

    const streams = readInferenceRunLogTextByStream(runs[0].id, databasePath);
    assert.match(streams.engine_stdout, /Using main model MTP component for drafting/u);
  } finally {
    await flushQueue.close();
    await teardownManagedTabbyFixture();
  }
});
```

Write `startManagedTabbyFixture` / `teardownManagedTabbyFixture` inline in the test file using the existing Tabby test's setup; do not add them to `_test-helpers.ts` unless a second test needs them.

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run build:test
node .\dist\scripts\run-tests.js managed-tabby-run-history
```

Expected: FAIL — `listInferenceRuns({ backend: 'exl3' })` returns an empty array.

- [ ] **Step 3: Give `ManagedTabbyRuntime` a recorder**

In [managed-tabby.ts](../../../src/status-server/managed-tabby.ts), replace the `logPath` field and the `appendLog` method with a recorder. Change the imports:

```ts
import { InferenceRunRecorder } from './inference-run-recorder.js';
import type { ManagedLlamaFlushQueue } from './managed-llama-flush-queue.js';
import { readInferenceRunLogTextByStream } from '../state/inference-runs.js';
```

and drop `import fs from 'node:fs';`, `import path from 'node:path';` and `import { getManagedTabbyLogRoot } from './paths.js';` if nothing else in the file uses them.

Replace the field declarations at [managed-tabby.ts:27](../../../src/status-server/managed-tabby.ts#L27):

```ts
  private recorder: InferenceRunRecorder | null = null;
```

and the constructor at [:36-43](../../../src/status-server/managed-tabby.ts#L36-L43):

```ts
  constructor(
    private readonly engine: Exl3EngineConfig,
    private readonly flushQueue: ManagedLlamaFlushQueue,
    private readonly client = new TabbyModelClient(engine.AdminApiKey),
  ) {
    super('exl3');
    this.adapter = new Exl3PresetAdapter(engine.ModelRoot);
  }
```

- [ ] **Step 4: Record the spawn**

Replace `spawnProcess` at [managed-tabby.ts:173-201](../../../src/status-server/managed-tabby.ts#L173-L201):

```ts
  private spawnProcess(launchEnvironment: Exl3LaunchEnvironment): void {
    this.stopping = false;
    this.startupError = null;
    const recorder = new InferenceRunRecorder({
      backend: 'exl3',
      purpose: 'startup',
      entrypointPath: this.engine.Entrypoint,
      baseUrl: null,
      flushQueue: this.flushQueue,
    });
    recorder.enableFlushQueue();
    this.recorder = recorder;
    const child = spawn(this.engine.PythonPath, [this.engine.Entrypoint], {
      cwd: this.engine.WorkingDirectory,
      env: { ...process.env, ...launchEnvironment },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    recorder.attachStdout(child.stdout);
    recorder.attachStderr(child.stderr);
    child.once('error', (error) => {
      this.startupError = error;
      recorder.flush();
      recorder.finish({ status: 'failed', errorMessage: error.message });
      this.transitionProcessTo('failed');
    });
    child.once('exit', (code, signal) => {
      recorder.flush();
      recorder.finish({
        status: this.stopping ? 'stopped' : 'failed',
        exitCode: Number.isFinite(code) ? Number(code) : null,
        errorMessage: this.stopping
          ? null
          : `TabbyAPI exited unexpectedly (code=${String(code)}, signal=${String(signal)}).`,
      });
      if (this.stopping) return;
      this.startupError = new Error(`TabbyAPI exited unexpectedly (code=${String(code)}, signal=${String(signal)}).`);
      this.processBaseUrl = null;
      this.processManaged = null;
      this.processSignature = null;
      this.transitionModelTo('unloaded');
      this.transitionProcessTo('failed');
    });
  }
```

- [ ] **Step 5: Mark the run ready and read the startup log from the DB**

In `waitForProcess`, immediately before `this.transitionProcessTo('ready');` at [managed-tabby.ts:219](../../../src/status-server/managed-tabby.ts#L219):

```ts
          this.recorder?.finish({ status: 'ready', baseUrl });
```

Replace `assertDraftingActive` at [managed-tabby.ts:251-259](../../../src/status-server/managed-tabby.ts#L251-L259) so it reads the recorded stream instead of the file:

```ts
  private assertDraftingActive(preset: ModelRuntimePreset): void {
    const runId = this.recorder?.runId;
    const startupLog = runId ? readInferenceRunLogTextByStream(runId).engine_stdout : '';
    if (!startupLog.includes('Using main model MTP component for drafting')) {
      throw new Error(
        `Preset '${preset.id}' requires MTP drafting, but the TabbyAPI startup log never reported the MTP draft `
        + 'component loading. Decode speed would be silently halved.',
      );
    }
  }
```

`readInferenceRunLogTextByStream` already merges the in-memory pending buffer with persisted chunks ([managed-llama-runs.ts:580-586](../../../src/state/managed-llama-runs.ts#L580-L586)), so no explicit flush is needed before this read.

Clear `this.recorder = null;` alongside the other field resets in `stopProcess` ([:149-156](../../../src/status-server/managed-tabby.ts#L149-L156)) and `stopForProcessExitSync` ([:163-170](../../../src/status-server/managed-tabby.ts#L163-L170)).

- [ ] **Step 6: Wire the flush queue at construction**

At [index.ts:266](../../../src/status-server/index.ts#L266):

```ts
  const managedTabbyRuntime = new ManagedTabbyRuntime(
    initialConfig.Server.Engines.Exl3,
    ctx.managedLlamaFlushQueue,
  );
```

Then check for other construction sites:

```bash
npx rg -n "new ManagedTabbyRuntime" src tests
```

Update each one; tests that pass a stub client as the second argument now need it third.

- [ ] **Step 7: Run the tests**

```bash
npm run build:test
node .\dist\scripts\run-tests.js managed-tabby
```

Expected: PASS, including the new run-history test.

- [ ] **Step 8: Commit**

```bash
git add src/status-server/managed-tabby.ts src/status-server/index.ts tests/managed-tabby-run-history.test.ts
git commit -m "feat: record managed TabbyAPI runs in inference run history"
```

---

### Task 6: Retention and dashboard call sites

**Files:**
- Modify: [src/status-server/dashboard-runs/deletion.ts:205-209](../../../src/status-server/dashboard-runs/deletion.ts#L205-L209), [src/status-server/routes/dashboard.ts:97](../../../src/status-server/routes/dashboard.ts#L97)

- [ ] **Step 1: Repoint the retention sweep**

Replace the `managed_llama_runs` entry in `AUX_RUN_HISTORY_DELETE_STATEMENTS`:

```ts
  {
    table: 'inference_runs',
    countSql: "SELECT COUNT(*) AS count FROM inference_runs WHERE status != 'running' AND COALESCE(finished_at_utc, started_at_utc) < ?",
    deleteSql: "DELETE FROM inference_runs WHERE status != 'running' AND COALESCE(finished_at_utc, started_at_utc) < ?",
  },
```

- [ ] **Step 2: Rename the dashboard filter schema**

At [routes/dashboard.ts:97](../../../src/status-server/routes/dashboard.ts#L97):

```ts
const InferenceRunStatusFilterSchema = z.enum(['', 'running', 'ready', 'failed', 'stopped', 'sync_completed']).catch('');
```

Rename its usages:

```bash
npx rg -n "ManagedLlamaRunStatusFilterSchema" src
```

- [ ] **Step 3: Sweep for any remaining old identifier**

```bash
npx rg -n "managed_llama_runs|managed_llama_log_chunks|ManagedLlamaRunRecord|createManagedLlamaRun|startup_script_stdout|llama_stdout" src tests dashboard
```

Expected: no hits. Fix any that remain.

- [ ] **Step 4: Run the run-log tests**

```bash
npm run build:test
node .\dist\scripts\run-tests.js dashboard-status-server.run-logs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/status-server/dashboard-runs/deletion.ts src/status-server/routes/dashboard.ts
git commit -m "refactor: repoint run retention and dashboard filters at inference_runs"
```

---

### Task 7: Full verification

**Files:** none

- [ ] **Step 1: Typecheck and lint**

```bash
npm run typecheck
```

Expected: exit code 0.

- [ ] **Step 2: Full test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 3: Confirm the old Tabby log file is gone**

```bash
npx rg -n "latest-startup.log|getManagedTabbyLogRoot" src
```

Expected: no hits in `managed-tabby.ts`. If `getManagedTabbyLogRoot` in [paths.ts](../../../src/status-server/paths.ts) now has no callers, delete it.

- [ ] **Step 4: Commit any cleanup**

```bash
git add -A
git commit -m "chore: drop the superseded managed tabby startup log path"
```

---

## Deliberate non-goals

- **Speculative metrics for EXL3.** `speculative_accepted_tokens` / `speculative_generated_tokens` on `inference_runs` stay NULL for `backend='exl3'`. Those columns are populated by scraping llama.cpp's stdout counters ([managed-llama.ts:290-342](../../../src/status-server/managed-llama.ts#L290-L342)); TabbyAPI's startup log has no equivalent. Per-request speculative for EXL3 already arrives through the provider `usage` payload ([llama-cpp-client.ts:479](../../../src/llm-protocol/llama-cpp-client.ts#L479)) and reaches `runtime_metrics_totals` via the normal status path — see `2026-07-22-chat-runtime-metrics-double-count.md`.
- **Moving process lifecycle into `ManagedInferenceRuntime`.** llama's spawn path is driven by `ServerContext` free functions across a 1510-line module; the recorder is the shared unit, not the lifecycle.

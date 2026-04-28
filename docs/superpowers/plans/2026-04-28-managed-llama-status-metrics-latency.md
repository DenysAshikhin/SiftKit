# Managed Llama Status Metrics Latency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the planner iteration latency caused by `/status` rereading huge managed-llama log chunks, while preserving speculative metrics and automatically deleting managed-llama log chunks older than 3 days.

**Architecture:** Treat managed-llama logs as diagnostics and speculative metrics as maintained state. The hot `/status` path reads an in-memory tracker and persisted run metrics instead of scanning `managed_llama_log_chunks`; non-terminal planner `running=false` posts become fire-and-forget for immediate responsiveness.

**Tech Stack:** TypeScript, node:test, better-sqlite3, existing status-server runtime DB, summary planner, managed-llama lifecycle

---

## Scope And Guardrails

- Do not use a git worktree for this repo.
- Follow TDD: write or update failing tests before implementation changes.
- Keep terminal `running=false` status posts awaited.
- Only the per-iteration planner `running=false` in `src/summary/planner/mode.ts` becomes fire-and-forget.
- Do not remove managed-llama log storage. Logs remain available for diagnostics within retention.
- Delete `managed_llama_log_chunks` older than 3 days, excluding active managed-llama runs.
- Preserve `managed_llama_runs` metadata rows.
- Keep legacy log-parsing exports working for tests, diagnostics, and fallback behavior.

## File Structure

- Modify: `src/summary/planner/mode.ts`
  - Make non-terminal per-iteration planner `running=false` status notification fire-and-forget.
- Create: `src/status-server/managed-llama-speculative-tracker.ts`
  - Own incremental speculative metrics parsing and per-run in-memory tracker state.
- Modify: `src/status-server/managed-llama.ts`
  - Feed tracker on every managed-llama stdout/stderr chunk.
  - Read tracker before falling back to historical log text for snapshot and delta functions.
  - Flush tracker state next to existing managed-llama log flushes.
- Modify: `src/status-server/routes/core.ts`
  - Avoid redundant speculative snapshot recapture for terminal posts.
  - Keep final delta computation cheap through the tracker.
- Modify: `src/status-server/server-ops.ts`
  - Flush tracker metrics when releasing a model request.
- Modify: `src/state/managed-llama-runs.ts`
  - Add persisted speculative metric update/read helpers.
  - Add 3-day chunk pruning helper.
- Modify: `src/state/runtime-db.ts`
  - Add schema columns for persisted managed-llama speculative metric state.
  - Apply WAL/NORMAL pragmas when opening runtime DB connections.
- Modify: `src/status-server/index.ts`
  - Run managed-llama chunk pruning on startup and periodically while the server is running.
  - Clear the periodic cleanup timer on close.
- Modify: `src/status-server/server-types.ts`
  - Add cleanup timer field to `ServerContext`.
- Tests:
  - `tests/runtime-planner-mode.test.ts`
  - `tests/managed-llama-runs.test.ts`
  - `tests/status-server-speculative-metrics.test.ts`
  - `tests/runtime-db-config-cutover.test.ts` or `tests/runtime-status-server.lifecycle.test.ts`

---

### Task 1: Make Planner Iteration `running=false` Fire-And-Forget

**Files:**
- Modify: `src/summary/planner/mode.ts:605-628`
- Test: `tests/runtime-planner-mode.test.ts`

- [ ] **Step 1: Add failing coverage for fire-and-forget behavior**

Add a test around planner mode with a mocked/hanging `notifyStatusBackend` for `running=false`. The assertion is that the planner loop continues without awaiting that promise and no unhandled rejection is emitted.

Use this shape in `tests/runtime-planner-mode.test.ts`:

```ts
test('planner iteration running=false notification is fire-and-forget', async () => {
  const pendingNotifications: Array<Promise<void>> = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    // Use the existing planner-mode mock provider setup in this file.
    // Mock notifyStatusBackend so running=true resolves and running=false returns
    // a promise that resolves only after the planner function has returned.
    // Assert the planner call returns before resolving pendingNotifications.
    assert.equal(unhandled.length, 0);
    for (const notification of pendingNotifications) {
      await notification;
    }
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
```

The implementation must use existing test helpers in the file instead of introducing a new mocking framework.

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```powershell
npm test -- runtime-planner-mode 2>&1 | siftkit summary --question "Did the fire-and-forget planner notification test fail before implementation? Extract failing test name and assertion."
```

Expected: FAIL because `src/summary/planner/mode.ts` currently awaits the non-terminal `running=false` post.

- [ ] **Step 3: Implement fire-and-forget notification**

Replace the awaited block in `src/summary/planner/mode.ts:607-628` with:

```ts
      void notifyStatusBackend({
        running: false,
        taskKind: 'summary',
        statusBackendUrl: options.statusBackendUrl,
        requestId: options.requestId,
        promptCharacterCount: prompt.length,
        inputTokens: providerResponse.inputTokens,
        outputCharacterCount: providerResponse.outputCharacterCount,
        outputTokens: countOutputTokens ? providerResponse.outputTokens : null,
        toolTokens: countToolTokens ? providerResponse.outputTokens : null,
        thinkingTokens: providerResponse.thinkingTokens,
        toolStats: toolStatsPayload,
        promptCacheTokens: providerResponse.promptCacheTokens,
        promptEvalTokens: providerResponse.promptEvalTokens,
        requestDurationMs: providerResponse.requestDurationMs,
        providerDurationMs: providerResponse.providerDurationMs,
        statusRunningMs: providerResponse.statusRunningMs,
      }).catch(() => {
        traceSummary(`notify running=false failed phase=planner chunk=none request_id=${options.requestId}`);
      });
```

Do not change terminal posts in `src/summary/core.ts` or `src/summary/planner/provider.ts`.

- [ ] **Step 4: Run focused validation**

Run:

```powershell
npm test -- runtime-planner-mode 2>&1 | siftkit summary --question "Did runtime-planner-mode tests pass? List failures with file:line if any."
```

Expected: PASS.

---

### Task 2: Add Incremental Speculative Metrics Tracker

**Files:**
- Create: `src/status-server/managed-llama-speculative-tracker.ts`
- Test: `tests/managed-llama-runs.test.ts`

- [ ] **Step 1: Add failing tracker tests**

Add tests for:

- cumulative stats are parsed from split chunks
- snapshots and deltas are O(1) from tracker state
- non-primary streams do not affect stdout/stderr offsets
- decreases return `null` deltas

Use this import in `tests/managed-llama-runs.test.ts` after implementation exists:

```ts
import {
  ManagedLlamaSpeculativeMetricsTracker,
} from '../dist/status-server/managed-llama-speculative-tracker.js';
```

Test shape:

```ts
test('managed llama speculative tracker parses split cumulative stats', () => {
  const tracker = new ManagedLlamaSpeculativeMetricsTracker();
  tracker.appendChunk('startup_script_stderr', 'statistics ngram_mod: #gen tokens = 62');
  const before = tracker.captureSnapshot();
  assert.equal(before.latestSpeculativeGeneratedTokens, null);

  tracker.appendChunk('startup_script_stderr', '00, #acc tokens = 5841\n');
  const after = tracker.captureSnapshot();
  assert.equal(after.latestSpeculativeGeneratedTokens, 6200);
  assert.equal(after.latestSpeculativeAcceptedTokens, 5841);
});
```

```ts
test('managed llama speculative tracker computes cumulative delta from snapshot', () => {
  const tracker = new ManagedLlamaSpeculativeMetricsTracker();
  tracker.appendChunk('startup_script_stdout', 'statistics ngram_mod: #gen tokens = 6168, #acc tokens = 5837\n');
  const snapshot = tracker.captureSnapshot();

  tracker.appendChunk('llama_stderr', 'statistics ngram_mod: #gen tokens = 6426, #acc tokens = 5895\n');

  assert.deepEqual(tracker.getDelta(snapshot), {
    speculativeAcceptedTokens: 58,
    speculativeGeneratedTokens: 258,
  });
});
```

- [ ] **Step 2: Run failing tests**

Run:

```powershell
npm test -- managed-llama-runs 2>&1 | siftkit summary --question "Did managed-llama tracker tests fail before implementation? Extract missing module or assertion failures."
```

Expected: FAIL because the tracker module does not exist.

- [ ] **Step 3: Create tracker module**

Create `src/status-server/managed-llama-speculative-tracker.ts` with:

```ts
import type { ManagedLlamaStreamKind } from '../state/managed-llama-runs.js';

export type ManagedLlamaSpeculativeMetrics = {
  speculativeAcceptedTokens: number;
  speculativeGeneratedTokens: number;
};

export type ManagedLlamaSpeculativeMetricsSnapshot = {
  stdoutOffset: number;
  stderrOffset: number;
  latestSpeculativeAcceptedTokens: number | null;
  latestSpeculativeGeneratedTokens: number | null;
};

const SPECULATIVE_STATS_PATTERN = /^\s*(?:llama_decode:\s+)?statistics\s+\S+:\s+.*?#gen tokens\s*=\s*(\d+),\s+#acc tokens\s*=\s*(\d+)/iu;
const MAX_LINE_CARRY_CHARACTERS = 4096;

export class ManagedLlamaSpeculativeMetricsTracker {
  private stdoutCharacterCount = 0;
  private stderrCharacterCount = 0;
  private latestSpeculativeAcceptedTokens: number | null = null;
  private latestSpeculativeGeneratedTokens: number | null = null;
  private readonly lineCarryByStream = new Map<ManagedLlamaStreamKind, string>();

  appendChunk(streamKind: ManagedLlamaStreamKind, chunkText: string): void {
    const normalizedChunk = String(chunkText || '');
    if (!normalizedChunk) {
      return;
    }
    if (streamKind === 'startup_script_stdout' || streamKind === 'llama_stdout') {
      this.stdoutCharacterCount += normalizedChunk.length;
    } else if (streamKind === 'startup_script_stderr' || streamKind === 'llama_stderr') {
      this.stderrCharacterCount += normalizedChunk.length;
    } else {
      return;
    }
    const text = `${this.lineCarryByStream.get(streamKind) || ''}${normalizedChunk}`;
    const lines = text.split(/\r?\n/u);
    const endsWithNewline = /\r?\n$/u.test(text);
    const completeLines = endsWithNewline ? lines : lines.slice(0, -1);
    for (const line of completeLines) {
      this.consumeLine(line);
    }
    const carry = endsWithNewline ? '' : (lines.at(-1) || '');
    this.lineCarryByStream.set(streamKind, carry.slice(Math.max(0, carry.length - MAX_LINE_CARRY_CHARACTERS)));
  }

  captureSnapshot(): ManagedLlamaSpeculativeMetricsSnapshot {
    return {
      stdoutOffset: this.stdoutCharacterCount,
      stderrOffset: this.stderrCharacterCount,
      latestSpeculativeAcceptedTokens: this.latestSpeculativeAcceptedTokens,
      latestSpeculativeGeneratedTokens: this.latestSpeculativeGeneratedTokens,
    };
  }

  getDelta(snapshot: ManagedLlamaSpeculativeMetricsSnapshot | null): ManagedLlamaSpeculativeMetrics | null {
    if (!snapshot || this.latestSpeculativeAcceptedTokens === null || this.latestSpeculativeGeneratedTokens === null) {
      return null;
    }
    if (snapshot.latestSpeculativeAcceptedTokens === null || snapshot.latestSpeculativeGeneratedTokens === null) {
      return null;
    }
    if (
      this.latestSpeculativeAcceptedTokens < snapshot.latestSpeculativeAcceptedTokens
      || this.latestSpeculativeGeneratedTokens < snapshot.latestSpeculativeGeneratedTokens
    ) {
      return null;
    }
    const delta = {
      speculativeAcceptedTokens: this.latestSpeculativeAcceptedTokens - snapshot.latestSpeculativeAcceptedTokens,
      speculativeGeneratedTokens: this.latestSpeculativeGeneratedTokens - snapshot.latestSpeculativeGeneratedTokens,
    };
    return delta.speculativeGeneratedTokens > 0 ? delta : null;
  }

  private consumeLine(line: string): void {
    const match = SPECULATIVE_STATS_PATTERN.exec(line);
    if (!match) {
      return;
    }
    const generated = Number.parseInt(match[1] || '', 10);
    const accepted = Number.parseInt(match[2] || '', 10);
    if (!Number.isFinite(generated) || !Number.isFinite(accepted)) {
      return;
    }
    this.latestSpeculativeGeneratedTokens = generated;
    this.latestSpeculativeAcceptedTokens = accepted;
  }
}

const trackerByRunId = new Map<string, ManagedLlamaSpeculativeMetricsTracker>();

export function appendManagedLlamaSpeculativeMetricsChunk(options: {
  runId: string;
  streamKind: ManagedLlamaStreamKind;
  chunkText: string;
}): void {
  const runId = String(options.runId || '').trim();
  if (!runId) {
    return;
  }
  let tracker = trackerByRunId.get(runId);
  if (!tracker) {
    tracker = new ManagedLlamaSpeculativeMetricsTracker();
    trackerByRunId.set(runId, tracker);
  }
  tracker.appendChunk(options.streamKind, options.chunkText);
}

export function getManagedLlamaSpeculativeMetricsTracker(runId: string): ManagedLlamaSpeculativeMetricsTracker | null {
  return trackerByRunId.get(String(runId || '').trim()) ?? null;
}

export function deleteManagedLlamaSpeculativeMetricsTracker(runId: string): void {
  trackerByRunId.delete(String(runId || '').trim());
}
```

- [ ] **Step 4: Run tracker tests**

Run:

```powershell
npm test -- managed-llama-runs 2>&1 | siftkit summary --question "Did managed-llama-runs tests pass after adding tracker? List failing tests if any."
```

Expected: PASS.

---

### Task 3: Persist Tracker State Into Managed Llama Run Rows

**Files:**
- Modify: `src/state/runtime-db.ts`
- Modify: `src/state/managed-llama-runs.ts`
- Modify: `src/status-server/managed-llama-speculative-tracker.ts`
- Test: `tests/managed-llama-runs.test.ts`

- [ ] **Step 1: Add failing persistence tests**

Add a test that creates a run, feeds tracker metrics, flushes tracker metrics, and verifies `managed_llama_runs` contains persisted values.

Expected columns:

- `speculative_accepted_tokens`
- `speculative_generated_tokens`
- `stdout_character_count`
- `stderr_character_count`
- `metrics_updated_at_utc`

- [ ] **Step 2: Run failing test**

Run:

```powershell
npm test -- managed-llama-runs 2>&1 | siftkit summary --question "Did managed-llama tracker persistence fail before schema/helper implementation? Extract missing column or missing export errors."
```

Expected: FAIL because columns/helpers do not exist.

- [ ] **Step 3: Add schema columns and migration**

In `src/state/runtime-db.ts`, add columns to the `managed_llama_runs` create-table statement:

```sql
speculative_accepted_tokens INTEGER,
speculative_generated_tokens INTEGER,
stdout_character_count INTEGER NOT NULL DEFAULT 0,
stderr_character_count INTEGER NOT NULL DEFAULT 0,
metrics_updated_at_utc TEXT,
```

Add the next schema migration after version 14:

```ts
  if (currentVersion < 15) {
    const alterStatements: string[] = [];
    if (!tableHasColumn(database, 'managed_llama_runs', 'speculative_accepted_tokens')) {
      alterStatements.push('ALTER TABLE managed_llama_runs ADD COLUMN speculative_accepted_tokens INTEGER;');
    }
    if (!tableHasColumn(database, 'managed_llama_runs', 'speculative_generated_tokens')) {
      alterStatements.push('ALTER TABLE managed_llama_runs ADD COLUMN speculative_generated_tokens INTEGER;');
    }
    if (!tableHasColumn(database, 'managed_llama_runs', 'stdout_character_count')) {
      alterStatements.push('ALTER TABLE managed_llama_runs ADD COLUMN stdout_character_count INTEGER NOT NULL DEFAULT 0;');
    }
    if (!tableHasColumn(database, 'managed_llama_runs', 'stderr_character_count')) {
      alterStatements.push('ALTER TABLE managed_llama_runs ADD COLUMN stderr_character_count INTEGER NOT NULL DEFAULT 0;');
    }
    if (!tableHasColumn(database, 'managed_llama_runs', 'metrics_updated_at_utc')) {
      alterStatements.push('ALTER TABLE managed_llama_runs ADD COLUMN metrics_updated_at_utc TEXT;');
    }
    if (alterStatements.length > 0) {
      database.exec(alterStatements.join('\n'));
    }
    setSchemaVersion(database, 15);
    currentVersion = 15;
  }
```

- [ ] **Step 4: Add state helpers**

In `src/state/managed-llama-runs.ts`, extend `ManagedLlamaRunRecord` with:

```ts
  speculativeAcceptedTokens: number | null;
  speculativeGeneratedTokens: number | null;
  stdoutCharacterCount: number;
  stderrCharacterCount: number;
  metricsUpdatedAtUtc: string | null;
```

Add:

```ts
export function updateManagedLlamaRunSpeculativeMetrics(options: {
  runId: string;
  speculativeAcceptedTokens: number | null;
  speculativeGeneratedTokens: number | null;
  stdoutCharacterCount: number;
  stderrCharacterCount: number;
  databasePath?: string;
}): boolean {
  const runId = String(options.runId || '').trim();
  if (!runId) {
    return false;
  }
  const database = getDatabase(options.databasePath);
  const result = database.prepare(`
    UPDATE managed_llama_runs
    SET speculative_accepted_tokens = ?,
        speculative_generated_tokens = ?,
        stdout_character_count = ?,
        stderr_character_count = ?,
        metrics_updated_at_utc = ?,
        updated_at_utc = ?
    WHERE id = ?
  `).run(
    options.speculativeAcceptedTokens,
    options.speculativeGeneratedTokens,
    Math.max(0, Math.trunc(options.stdoutCharacterCount)),
    Math.max(0, Math.trunc(options.stderrCharacterCount)),
    new Date().toISOString(),
    new Date().toISOString(),
    runId,
  );
  return Number(result.changes) > 0;
}
```

- [ ] **Step 5: Add tracker flush helper**

In `src/status-server/managed-llama-speculative-tracker.ts`, add:

```ts
import { updateManagedLlamaRunSpeculativeMetrics } from '../state/managed-llama-runs.js';

export function flushManagedLlamaSpeculativeMetricsTracker(runId: string): boolean {
  const normalizedRunId = String(runId || '').trim();
  const tracker = trackerByRunId.get(normalizedRunId);
  if (!tracker) {
    return false;
  }
  const snapshot = tracker.captureSnapshot();
  return updateManagedLlamaRunSpeculativeMetrics({
    runId: normalizedRunId,
    speculativeAcceptedTokens: snapshot.latestSpeculativeAcceptedTokens,
    speculativeGeneratedTokens: snapshot.latestSpeculativeGeneratedTokens,
    stdoutCharacterCount: snapshot.stdoutOffset,
    stderrCharacterCount: snapshot.stderrOffset,
  });
}
```

- [ ] **Step 6: Run persistence tests**

Run:

```powershell
npm test -- managed-llama-runs runtime-db-config-cutover 2>&1 | siftkit summary --question "Did managed llama tracker persistence and runtime DB migration tests pass? List failures with file:line."
```

Expected: PASS.

---

### Task 4: Use Tracker In The `/status` Speculative Metrics Path

**Files:**
- Modify: `src/status-server/managed-llama.ts`
- Modify: `src/status-server/routes/core.ts`
- Test: `tests/status-server-speculative-metrics.test.ts`

- [ ] **Step 1: Add failing route behavior tests**

Add or update tests to assert:

- `running=true` snapshot comes from tracker when a tracker exists.
- non-terminal `running=false` does not perform historical log reads.
- terminal `running=false` writes final speculative delta.

Use a large persisted chunk in the test only as a sentinel; feed the tracker with current stats and ensure the route completes and persists expected delta without relying on the large persisted chunk.

- [ ] **Step 2: Run focused test and confirm failure**

Run:

```powershell
npm test -- status-server-speculative-metrics 2>&1 | siftkit summary --question "Did status-server speculative metrics tracker route tests fail before route implementation? Extract failing tests."
```

Expected: FAIL because `captureManagedLlamaSpeculativeMetricsSnapshot` and `getManagedLlamaSpeculativeMetricsDelta` still scan logs.

- [ ] **Step 3: Feed tracker from managed llama streams**

In `src/status-server/managed-llama.ts`, import:

```ts
import {
  appendManagedLlamaSpeculativeMetricsChunk,
  flushManagedLlamaSpeculativeMetricsTracker,
  getManagedLlamaSpeculativeMetricsTracker,
} from './managed-llama-speculative-tracker.js';
```

Update `appendManagedLlamaLogLine`:

```ts
function appendManagedLlamaLogLine(logRef: ManagedLlamaLogRef, streamKind: ManagedLlamaStreamKind, chunk: string): void {
  appendManagedLlamaSpeculativeMetricsChunk({
    runId: logRef.runId,
    streamKind,
    chunkText: chunk,
  });
  bufferManagedLlamaLogChunk({
    runId: logRef.runId,
    streamKind,
    chunkText: chunk,
  });
}
```

- [ ] **Step 4: Make snapshot/delta prefer tracker**

In `captureManagedLlamaSpeculativeMetricsSnapshot`, before historical log text reads:

```ts
  const tracker = getManagedLlamaSpeculativeMetricsTracker(logRef.runId);
  if (tracker) {
    return tracker.captureSnapshot();
  }
```

In `getManagedLlamaSpeculativeMetricsDelta`, before historical log text reads:

```ts
  const tracker = getManagedLlamaSpeculativeMetricsTracker(logRef.runId);
  if (tracker) {
    return tracker.getDelta(snapshot);
  }
```

This preserves fallback behavior for tests and diagnostics that use only persisted log chunks.

- [ ] **Step 5: Remove redundant terminal recapture**

In `src/status-server/routes/core.ts`, keep final delta computation, but guard the recapture at line 819:

```ts
        if (metadata.terminalState === null) {
          runState.managedLlamaSpeculativeSnapshot = captureManagedLlamaSpeculativeMetricsSnapshot(ctx.managedLlamaLastStartupLogs);
        }
```

This prevents a wasted post-terminal snapshot read or tracker call before `clearRunState`.

- [ ] **Step 6: Flush tracker next to existing managed-llama log flushes**

In `src/status-server/managed-llama.ts`, after each `flushManagedLlamaLogChunks(logRef.runId)` call, add:

```ts
      flushManagedLlamaSpeculativeMetricsTracker(logRef.runId);
```

Use exact indentation for each call site.

- [ ] **Step 7: Run focused speculative tests**

Run:

```powershell
npm test -- status-server-speculative-metrics managed-llama-runs 2>&1 | siftkit summary --question "Did speculative metrics and managed llama run tests pass after tracker integration? List failing tests if any."
```

Expected: PASS.

---

### Task 5: Flush Tracker On Model Request Release

**Files:**
- Modify: `src/status-server/server-ops.ts`
- Test: `tests/managed-llama-runs.test.ts`

- [ ] **Step 1: Add failing release flush assertion**

Extend `releaseModelRequest flushes buffered managed llama logs for the active host run` so it also verifies persisted tracker columns after release.

Feed a speculative stats line through the tracker before release:

```ts
appendManagedLlamaSpeculativeMetricsChunk({
  runId: run.id,
  streamKind: 'startup_script_stdout',
  chunkText: 'statistics ngram_mod: #gen tokens = 42, #acc tokens = 40\n',
});
```

Then assert:

```ts
const metricsRow = database.prepare(`
  SELECT speculative_accepted_tokens, speculative_generated_tokens
  FROM managed_llama_runs
  WHERE id = ?
`).get(run.id) as { speculative_accepted_tokens?: number | null; speculative_generated_tokens?: number | null };
assert.equal(metricsRow.speculative_accepted_tokens, 40);
assert.equal(metricsRow.speculative_generated_tokens, 42);
```

- [ ] **Step 2: Run failing test**

Run:

```powershell
npm test -- managed-llama-runs 2>&1 | siftkit summary --question "Did releaseModelRequest tracker flush assertion fail before server-ops implementation? Extract failure."
```

Expected: FAIL because `releaseModelRequest` only flushes chunks.

- [ ] **Step 3: Implement release flush**

In `src/status-server/server-ops.ts`, import:

```ts
import { flushManagedLlamaSpeculativeMetricsTracker } from './managed-llama-speculative-tracker.js';
```

Update `releaseModelRequest`:

```ts
  if (ctx.managedLlamaLastStartupLogs?.runId) {
    flushManagedLlamaLogChunks(ctx.managedLlamaLastStartupLogs.runId);
    flushManagedLlamaSpeculativeMetricsTracker(ctx.managedLlamaLastStartupLogs.runId);
  }
```

- [ ] **Step 4: Run focused tests**

Run:

```powershell
npm test -- managed-llama-runs 2>&1 | siftkit summary --question "Did managed-llama-runs tests pass after release flush implementation? List failures if any."
```

Expected: PASS.

---

### Task 6: Add 3-Day Managed Llama Chunk Retention

**Files:**
- Modify: `src/state/managed-llama-runs.ts`
- Modify: `src/status-server/server-types.ts`
- Modify: `src/status-server/index.ts`
- Test: `tests/managed-llama-runs.test.ts`
- Test: `tests/runtime-status-server.lifecycle.test.ts`

- [ ] **Step 1: Add failing pruning tests**

In `tests/managed-llama-runs.test.ts`, add tests for:

- old stopped/failed chunks older than 3 days are deleted
- chunks newer than 3 days are kept
- active `running` and `ready` run chunks are kept regardless of age
- `managed_llama_runs` rows are not deleted

- [ ] **Step 2: Run failing tests**

Run:

```powershell
npm test -- managed-llama-runs 2>&1 | siftkit summary --question "Did managed llama chunk pruning tests fail before implementation? Extract missing helper or assertion failures."
```

Expected: FAIL because pruning helper does not exist.

- [ ] **Step 3: Add pruning helper**

In `src/state/managed-llama-runs.ts`, add:

```ts
export function deleteManagedLlamaLogChunksOlderThan(options: {
  olderThanUtc: string;
  databasePath?: string;
}): number {
  const olderThanUtc = String(options.olderThanUtc || '').trim();
  if (!olderThanUtc) {
    return 0;
  }
  const database = getDatabase(options.databasePath);
  const result = database.prepare(`
    DELETE FROM managed_llama_log_chunks
    WHERE created_at_utc < ?
      AND run_id NOT IN (
        SELECT id
        FROM managed_llama_runs
        WHERE status IN ('running', 'ready')
      )
  `).run(olderThanUtc);
  return Number(result.changes || 0);
}
```

- [ ] **Step 4: Add server cleanup timer**

In `src/status-server/server-types.ts`, add to `ServerContext`:

```ts
  managedLlamaLogCleanupTimer: NodeJS.Timeout | null;
```

In `src/status-server/index.ts`, import:

```ts
import { deleteManagedLlamaLogChunksOlderThan } from '../state/managed-llama-runs.js';
```

Add helpers near `startStatusServer`:

```ts
const MANAGED_LLAMA_LOG_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const MANAGED_LLAMA_LOG_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

function pruneManagedLlamaLogChunks(): void {
  const cutoff = new Date(Date.now() - MANAGED_LLAMA_LOG_RETENTION_MS).toISOString();
  deleteManagedLlamaLogChunksOlderThan({ olderThanUtc: cutoff });
}
```

Initialize context:

```ts
    managedLlamaLogCleanupTimer: null,
```

After `writeMetrics(metricsPath, metrics);`, call:

```ts
  pruneManagedLlamaLogChunks();
```

After `ctx.server = server;`, schedule:

```ts
  ctx.managedLlamaLogCleanupTimer = setInterval(() => {
    try {
      pruneManagedLlamaLogChunks();
    } catch (error) {
      process.stderr.write(`[siftKitStatus] Managed llama log cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }, MANAGED_LLAMA_LOG_CLEANUP_INTERVAL_MS);
  if (typeof ctx.managedLlamaLogCleanupTimer.unref === 'function') {
    ctx.managedLlamaLogCleanupTimer.unref();
  }
```

On `server.on('close')`, clear:

```ts
    if (ctx.managedLlamaLogCleanupTimer) {
      clearInterval(ctx.managedLlamaLogCleanupTimer);
      ctx.managedLlamaLogCleanupTimer = null;
    }
```

- [ ] **Step 5: Run pruning tests**

Run:

```powershell
npm test -- managed-llama-runs runtime-status-server.lifecycle 2>&1 | siftkit summary --question "Did managed llama chunk retention tests pass? List failures with file:line."
```

Expected: PASS.

---

### Task 7: Apply Runtime DB WAL/NORMAL Pragmas

**Files:**
- Modify: `src/state/runtime-db.ts`
- Test: `tests/runtime-db-config-cutover.test.ts`

- [ ] **Step 1: Add failing DB pragma test**

Add a test that opens `getRuntimeDatabase()` and asserts:

```ts
const journalMode = database.prepare('PRAGMA journal_mode').get() as { journal_mode?: string };
const synchronous = database.prepare('PRAGMA synchronous').get() as { synchronous?: number };
assert.equal(String(journalMode.journal_mode || '').toLowerCase(), 'wal');
assert.equal(Number(synchronous.synchronous), 1);
```

SQLite `synchronous=NORMAL` reports `1`.

- [ ] **Step 2: Run failing test**

Run:

```powershell
npm test -- runtime-db-config-cutover 2>&1 | siftkit summary --question "Did runtime DB pragma test fail before implementation? Extract assertion values."
```

Expected: FAIL because runtime DB currently uses default journal/sync settings.

- [ ] **Step 3: Add pragma helper**

In `src/state/runtime-db.ts`, add:

```ts
function configureRuntimeDatabase(database: RuntimeDatabase): void {
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = NORMAL');
}
```

Call it immediately after each `new Database(resolvedPath)` in `getRuntimeDatabase`:

```ts
  let database: RuntimeDatabase = new Database(resolvedPath);
  configureRuntimeDatabase(database);
```

and after reset:

```ts
    database = new Database(resolvedPath);
    configureRuntimeDatabase(database);
```

- [ ] **Step 4: Run DB tests**

Run:

```powershell
npm test -- runtime-db-config-cutover 2>&1 | siftkit summary --question "Did runtime DB pragma tests pass after WAL/NORMAL implementation? List failures if any."
```

Expected: PASS.

---

### Task 8: Full Validation

**Files:**
- All changed files

- [ ] **Step 1: Run targeted test set**

Run:

```powershell
npm test -- runtime-planner-mode managed-llama-runs status-server-speculative-metrics runtime-db-config-cutover runtime-status-server.lifecycle 2>&1 | siftkit summary --question "Did targeted latency/metrics/retention tests pass? List failing suites, tests, and root causes."
```

Expected: PASS.

- [ ] **Step 2: Run full build**

Run:

```powershell
npm run build 2>&1 | siftkit summary --question "Did the TypeScript/dashboard build pass? Extract compiler errors and file:line anchors if any."
```

Expected: PASS.

- [ ] **Step 3: Run full test suite if targeted tests and build pass**

Run:

```powershell
npm test 2>&1 | siftkit summary --question "Did the full test suite pass? List failing suites and root causes."
```

Expected: PASS.

- [ ] **Step 4: Inspect final diff**

Run:

```powershell
git diff 2>&1 | siftkit summary --question "Summarize behavioral changes, touched files, and risk areas. Flag unintended unrelated changes."
```

Expected: only planned files changed.

---

## Self-Review

- Spec coverage: fire-and-forget planner notification, tracker-based metrics, persisted metrics, terminal-only route cleanup, 3-day chunk retention, WAL/NORMAL DB hygiene, and validation are covered.
- Placeholder scan: no placeholder tasks remain; each task names files, expected behavior, and commands.
- Type consistency: tracker snapshot keeps the existing `ManagedLlamaSpeculativeMetricsSnapshot` shape so current route/run-state types remain compatible.
- Scope check: chunk retention and WAL/NORMAL are separable from tracker work, but included because they are explicitly requested and low-coupling.

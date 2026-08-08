# Live Run Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every repo-search / repo-agent / chat run continuously overwrites a small JSON snapshot at `<repoRoot>/.siftkit/live/run-<requestId>.json` so a hung or killed run still leaves behind exactly which phase it is stuck in and the per-turn model/cache/tool numbers needed to diagnose it.

**Architecture:** The transcript logger (`JsonLogger`) already receives every event we need (`run_start`, `turn_preflight_budget`, `turn_model_request`, `provider_request_*`, `turn_model_response`, `turn_command_safety`, `turn_command_result`, `task_done`, `run_done`) but its output is only persisted to the runtime DB on clean termination, so aborted runs lose everything. We decorate that logger: a pure `LiveRunSnapshotCollector` folds each event into an in-memory snapshot object, and a `LiveRunSnapshotWriter` asynchronously writes it (temp file + rename, coalesced, plus a 5s heartbeat) to a fixed per-run path. Three new logger events (`turn_preflight_start`, `turn_command_start`, `approval_verdict`) close the blind spots where a hang could otherwise not be attributed to a phase. `executeRepoSearchRequest` owns the lifecycle and deletes the file in its `finally` block — so a file that still exists means the process died or hung.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), zod v4 via `src/lib/zod.js`, `node:test` + `node:assert/strict`, `node:fs/promises`.

**Out of scope:** `siftkit summary` runs (separate pipeline, `src/summary/`), dashboard rendering of the snapshot, and any change to the existing runtime-DB transcript persistence.

---

## File Structure

**Created:**
- `src/repo-search/live-snapshot/schemas.ts` — zod schemas for the snapshot document (types derived via `z.infer`) plus the input schemas used to parse logger events. No logic.
- `src/repo-search/live-snapshot/collector.ts` — `LiveRunSnapshotCollector`: pure event-folding, zero IO, zero timers. The heart of the feature and the only file with interesting logic.
- `src/repo-search/live-snapshot/writer.ts` — `LiveRunSnapshotWriter` (coalesced async atomic writes + heartbeat + delete), the `SIFTKIT_LIVE_SNAPSHOT` env gate, and `attachLiveRunSnapshot()` which wraps a `BufferedJsonLogger`.
- `tests/live-run-snapshot-collector.test.ts`
- `tests/live-run-snapshot-writer.test.ts`
- `tests/live-run-snapshot-execute.test.ts`

**Modified:**
- `src/lib/fs.ts` — add `saveContentAtomicallyAsync()` next to the existing sync `saveContentAtomically()`.
- `src/config/paths.ts` — add `getLiveRunsDirectory()` / `getLiveRunSnapshotPath()`.
- `src/repo-search/engine/prompt-preparer.ts` — emit `turn_preflight_start`.
- `src/repo-search/engine/tool-action-processor.ts` — emit `turn_command_start`.
- `src/repo-search/engine/llm-approval-gate.ts` — take a `logger` dependency, emit `approval_verdict`.
- `src/repo-search/engine/task-loop.ts` — pass `logger` into `LlmApprovalGate`.
- `src/repo-search/approval-verdict-probe.ts` — pass `logger: null` into `LlmApprovalGate`.
- `src/repo-search/execute.ts` — attach the snapshot to the run logger, record run errors, stop + delete on termination.
- `tests/fs-helpers.test.ts` (create if absent — see Task 1).

---

## Task 1: Async atomic file write helper

`saveContentAtomically()` in `src/lib/fs.ts` is synchronous. The snapshot writer must not block the engine's event loop, so we need the async twin with the same Windows-retry semantics.

**Files:**
- Modify: `src/lib/fs.ts:1-8` (imports), append new function after `saveContentAtomically` (currently ends at line 62)
- Test: `tests/fs-helpers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/fs-helpers.test.ts` (if the file already exists, append these two tests to it):

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { saveContentAtomicallyAsync } from '../src/lib/fs.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

test('saveContentAtomicallyAsync creates missing directories and writes the content', async () => {
  const tempRoot = createManagedTempDir('siftkit-fs-async-');
  const target = path.join(tempRoot, 'nested', 'deeper', 'file.json');

  await saveContentAtomicallyAsync(target, '{"a":1}\n');

  assert.equal(fs.readFileSync(target, 'utf8'), '{"a":1}\n');
});

test('saveContentAtomicallyAsync overwrites an existing file and leaves no temp files behind', async () => {
  const tempRoot = createManagedTempDir('siftkit-fs-async-overwrite-');
  const target = path.join(tempRoot, 'file.json');

  await saveContentAtomicallyAsync(target, 'first');
  await saveContentAtomicallyAsync(target, 'second');

  assert.equal(fs.readFileSync(target, 'utf8'), 'second');
  assert.deepEqual(fs.readdirSync(tempRoot), ['file.json']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- fs-helpers`
Expected: FAIL during `npm run typecheck:test` with `error TS2305: Module '"../src/lib/fs.js"' has no exported member 'saveContentAtomicallyAsync'.`

- [ ] **Step 3: Write minimal implementation**

In `src/lib/fs.ts`, add this import line directly below the existing `node:fs` import block (which ends at line 8):

```ts
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
```

Then append this function immediately after `saveContentAtomically` (after line 62):

```ts
/**
 * Async twin of `saveContentAtomically`. Writes to a temp file in the same
 * directory and renames it into place, so a process killed mid-write can never
 * leave a truncated target. Retries the Windows-only sharing-violation codes.
 */
export async function saveContentAtomicallyAsync(filePath: string, content: string): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const tempPath = join(
      directory,
      `${process.pid}-${Date.now()}-${attempt}-${Math.random().toString(16).slice(2)}.tmp`
    );

    try {
      await writeFile(tempPath, content, { encoding: 'utf8' });
      await rename(tempPath, filePath);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await rm(tempPath, { force: true }).catch(() => undefined);

      if (!isRetryableFsError(lastError) || attempt === 4) {
        break;
      }
    }
  }

  if (isRetryableFsError(lastError)) {
    await writeFile(filePath, content, { encoding: 'utf8' });
    return;
  }

  throw lastError ?? new Error(`Failed to save ${filePath} atomically.`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- fs-helpers`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/fs.ts tests/fs-helpers.test.ts
git commit -m "feat: add async atomic file write helper"
```

---

## Task 2: Live snapshot path helpers

The snapshot path must be derived from the **run's** `repoRoot`, not `process.cwd()`, so tests running against a temp repo land inside that temp repo.

**Files:**
- Modify: `src/config/paths.ts` (append after `getRuntimeLogsPath`, currently line 91-93)
- Test: `tests/live-run-snapshot-collector.test.ts` (created here, extended in Tasks 3-4)

- [ ] **Step 1: Write the failing test**

Create `tests/live-run-snapshot-collector.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { getLiveRunSnapshotPath, getLiveRunsDirectory } from '../src/config/paths.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

test('live run snapshot path lives under the run repo .siftkit/live directory', () => {
  const repoRoot = createManagedTempDir('siftkit-live-path-');

  const directory = getLiveRunsDirectory(repoRoot);
  const filePath = getLiveRunSnapshotPath('6f3951dc-c09c-416a-9d48-eb6a9881aeb3', repoRoot);

  assert.equal(path.basename(directory), 'live');
  assert.equal(path.dirname(filePath), directory);
  assert.equal(path.basename(filePath), 'run-6f3951dc-c09c-416a-9d48-eb6a9881aeb3.json');
});

test('live run snapshot path rejects path separators in the request id', () => {
  const repoRoot = createManagedTempDir('siftkit-live-path-unsafe-');

  const filePath = getLiveRunSnapshotPath('../../etc/passwd', repoRoot);

  assert.equal(path.dirname(filePath), getLiveRunsDirectory(repoRoot));
  assert.equal(path.basename(filePath), 'run-etc-passwd.json');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- live-run-snapshot-collector`
Expected: FAIL during `npm run typecheck:test` with `error TS2305: Module '"../src/config/paths.js"' has no exported member 'getLiveRunsDirectory'.`

- [ ] **Step 3: Write minimal implementation**

Append to `src/config/paths.ts` (after `getRuntimeLogsPath`, line 93):

```ts
// ---------- live/ ---------- //

function sanitizeRunIdForPath(requestId: string): string {
  return requestId.replace(/[^a-zA-Z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'unknown';
}

/** Directory holding one JSON snapshot per in-flight run, keyed off the run's own repo root. */
export function getLiveRunsDirectory(startPath: string): string {
  return join(getRepoRuntimeRoot(startPath), 'live');
}

export function getLiveRunSnapshotPath(requestId: string, startPath: string): string {
  return join(getLiveRunsDirectory(startPath), `run-${sanitizeRunIdForPath(requestId)}.json`);
}
```

Note: `join` and `getRepoRuntimeRoot` are already imported at the top of `src/config/paths.ts` (lines 1 and 5).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- live-run-snapshot-collector`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/config/paths.ts tests/live-run-snapshot-collector.test.ts
git commit -m "feat: add live run snapshot path helpers"
```

---

## Task 3: Snapshot schemas and collector header/phase/model tracking

**Files:**
- Create: `src/repo-search/live-snapshot/schemas.ts`
- Create: `src/repo-search/live-snapshot/collector.ts`
- Test: `tests/live-run-snapshot-collector.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/live-run-snapshot-collector.test.ts` (add the two imports to the existing import block at the top of the file):

```ts
import { LiveRunSnapshotCollector } from '../src/repo-search/live-snapshot/collector.js';
import { LiveRunSnapshotSchema } from '../src/repo-search/live-snapshot/schemas.js';

function makeCollector(): LiveRunSnapshotCollector {
  return new LiveRunSnapshotCollector({
    requestId: 'req-1',
    taskKind: 'repo-agent',
    repoRoot: 'C:/repo',
    startedAtMs: Date.now(),
  });
}

test('collector starts in the starting phase with header fields from run_start', () => {
  const collector = makeCollector();

  collector.record({ kind: 'run_start', repoRoot: 'C:/repo', requestedModel: null, configuredModel: 'model-a', baseUrl: 'http://127.0.0.1:5000' });

  const snapshot = LiveRunSnapshotSchema.parse(collector.build());
  assert.equal(snapshot.requestId, 'req-1');
  assert.equal(snapshot.taskKind, 'repo-agent');
  assert.equal(snapshot.model, 'model-a');
  assert.equal(snapshot.baseUrl, 'http://127.0.0.1:5000');
  assert.equal(snapshot.pid, process.pid);
  assert.equal(snapshot.phase.name, 'starting');
  assert.equal(snapshot.turns.length, 0);
});

test('collector tracks the in-flight phase through preflight, model request and provider stages', () => {
  const collector = makeCollector();

  collector.record({ kind: 'turn_preflight_start', taskId: 't', turn: 39, promptChars: 206300 });
  assert.equal(collector.build().phase.name, 'prompt_preflight');
  assert.equal(collector.build().phase.turn, 39);

  collector.record({ kind: 'turn_model_request', taskId: 't', turn: 39, thinkingEnabled: false });
  assert.equal(collector.build().phase.name, 'model_request');

  collector.record({ kind: 'provider_request_start', stage: 'approval_verdict', method: 'POST', url: 'u', path: '/v1/chat/completions' });
  const midFlight = collector.build();
  assert.equal(midFlight.phase.name, 'model_request');
  assert.equal(midFlight.phase.detail, 'stage=approval_verdict');
  assert.equal(midFlight.turns[0].providerRequests[0].elapsedMs, null);
  assert.ok(midFlight.phase.elapsedMs >= 0);
});

test('collector records per-turn prompt budget and model token accounting', () => {
  const collector = makeCollector();

  collector.record({ kind: 'turn_preflight_start', taskId: 't', turn: 39, promptChars: 206300 });
  collector.record({
    kind: 'turn_preflight_budget', taskId: 't', turn: 39, promptTokenCount: 64552,
    tokenizeElapsedMs: 13, tokenCountSource: 'exl3',
    maxPromptBudget: 120000, overflowTokens: 0, maxOutputTokens: 4096, ok: true, compacted: false,
  });
  collector.record({ kind: 'turn_model_request', taskId: 't', turn: 39, thinkingEnabled: false });
  collector.record({ kind: 'provider_request_start', stage: 'planner_action', method: 'POST', url: 'u', path: '/p' });
  collector.record({ kind: 'provider_request_done', stage: 'planner_action', method: 'POST', url: 'u', path: '/p', statusCode: 200, elapsedMs: 123000 });
  collector.record({
    kind: 'turn_model_response', taskId: 't', turn: 39, text: '{}', thinkingText: '', mockExhausted: false,
    promptTokens: 64552, completionTokens: 71, usageThinkingTokens: 0, promptCacheTokens: 0, promptEvalTokens: 64552,
  });

  const snapshot = LiveRunSnapshotSchema.parse(collector.build());
  const turn = snapshot.turns[0];
  assert.equal(turn.turn, 39);
  assert.equal(turn.promptChars, 206300);
  assert.equal(turn.promptTokens, 64552);
  assert.equal(turn.tokenizeMs, 13);
  assert.equal(turn.tokenSource, 'exl3');
  assert.equal(turn.maxPromptBudget, 120000);
  assert.equal(turn.maxOutputTokens, 4096);
  assert.equal(turn.promptEvalTokens, 64552);
  assert.equal(turn.promptCacheTokens, 0);
  assert.equal(turn.completionTokens, 71);
  assert.equal(turn.providerRequests.length, 1);
  assert.equal(turn.providerRequests[0].stage, 'planner_action');
  assert.equal(turn.providerRequests[0].elapsedMs, 123000);
  assert.equal(turn.providerRequests[0].statusCode, 200);
  assert.ok(turn.modelDurationMs !== null && turn.modelDurationMs >= 0);
  assert.equal(snapshot.phase.name, 'idle');
});

test('collector records provider errors without losing the turn', () => {
  const collector = makeCollector();

  collector.record({ kind: 'turn_model_request', taskId: 't', turn: 1, thinkingEnabled: false });
  collector.record({ kind: 'provider_request_start', stage: 'planner_action', method: 'POST', url: 'u', path: '/p' });
  collector.record({
    kind: 'provider_request_error', stage: 'planner_action', method: 'POST', url: 'u', path: '/p',
    elapsedMs: 900, error: { code: 'ECONNRESET', message: 'socket hang up' },
  });

  const snapshot = LiveRunSnapshotSchema.parse(collector.build());
  assert.equal(snapshot.counters.providerErrors, 1);
  assert.equal(snapshot.turns[0].providerRequests[0].elapsedMs, 900);
  assert.ok(String(snapshot.turns[0].providerRequests[0].error).includes('ECONNRESET'));
});

test('collector ignores unknown and malformed events', () => {
  const collector = makeCollector();

  collector.record({ kind: 'turn_new_messages', taskId: 't', turn: 1, messages: [] });
  collector.record({ kind: 'turn_model_request' });
  collector.record({ notAKind: true });

  const snapshot = LiveRunSnapshotSchema.parse(collector.build());
  assert.equal(snapshot.turns.length, 0);
  assert.equal(snapshot.phase.name, 'starting');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- live-run-snapshot-collector`
Expected: FAIL during `npm run typecheck:test` with `error TS2307: Cannot find module '../src/repo-search/live-snapshot/collector.js'`.

- [ ] **Step 3: Write the schemas**

Create `src/repo-search/live-snapshot/schemas.ts`:

```ts
import { z } from '../../lib/zod.js';
import { JsonValueSchema } from '../../lib/json-types.js';

/** Newest turns are kept; older ones age out so the file stays small enough to rewrite constantly. */
export const LIVE_SNAPSHOT_MAX_TURNS = 100;
export const LIVE_SNAPSHOT_OUTPUT_EDGE_CHARS = 300;
export const LIVE_SNAPSHOT_COMMAND_CHARS = 500;

// ---------------------------------------------------------------------------
// Snapshot document
// ---------------------------------------------------------------------------

export const LiveRunPhaseNameSchema = z.enum([
  'starting',
  'prompt_preflight',
  'model_request',
  'tool_execute',
  'idle',
  'done',
]);

export const LiveRunPhaseSchema = z.object({
  name: LiveRunPhaseNameSchema,
  turn: z.number().nullable(),
  startedAtUtc: z.string(),
  elapsedMs: z.number(),
  detail: z.string().nullable(),
});

export const LiveRunProviderRequestSchema = z.object({
  stage: z.string(),
  startedAtUtc: z.string(),
  elapsedMs: z.number().nullable(),
  statusCode: z.number().nullable(),
  error: z.string().nullable(),
});

export const LiveRunToolSchema = z.object({
  toolName: z.string(),
  command: z.string(),
  startedAtUtc: z.string(),
  durationMs: z.number().nullable(),
  exitCode: z.number().nullable(),
  outputChars: z.number().nullable(),
  outputTokens: z.number().nullable(),
  outputHead: z.string(),
  outputTail: z.string(),
});

export const LiveRunSafetySchema = z.object({
  safe: z.boolean(),
  reason: z.string().nullable(),
});

export const LiveRunApprovalSchema = z.object({
  verdict: z.string(),
  reason: z.string(),
});

export const LiveRunTurnSchema = z.object({
  turn: z.number(),
  promptChars: z.number().nullable(),
  promptTokens: z.number().nullable(),
  tokenizeMs: z.number().nullable(),
  tokenSource: z.string().nullable(),
  maxPromptBudget: z.number().nullable(),
  overflowTokens: z.number().nullable(),
  maxOutputTokens: z.number().nullable(),
  modelDurationMs: z.number().nullable(),
  promptEvalTokens: z.number().nullable(),
  promptCacheTokens: z.number().nullable(),
  completionTokens: z.number().nullable(),
  thinkingTokens: z.number().nullable(),
  providerRequests: z.array(LiveRunProviderRequestSchema),
  safety: LiveRunSafetySchema.nullable(),
  approval: LiveRunApprovalSchema.nullable(),
  tool: LiveRunToolSchema.nullable(),
});

export const LiveRunSnapshotSchema = z.object({
  requestId: z.string(),
  taskKind: z.string(),
  pid: z.number(),
  repoRoot: z.string(),
  model: z.string().nullable(),
  baseUrl: z.string().nullable(),
  startedAtUtc: z.string(),
  snapshotAtUtc: z.string(),
  elapsedMs: z.number(),
  phase: LiveRunPhaseSchema,
  turnsRecorded: z.number(),
  turns: z.array(LiveRunTurnSchema),
  totals: z.object({
    modelMs: z.number(),
    toolMs: z.number(),
    promptEvalTokens: z.number(),
    promptCacheTokens: z.number(),
    completionTokens: z.number(),
    toolOutputChars: z.number(),
  }),
  slowest: z.object({
    byModelMs: z.array(z.object({ turn: z.number(), ms: z.number() })),
    byToolMs: z.array(z.object({ turn: z.number(), ms: z.number() })),
  }),
  counters: z.object({
    turns: z.number(),
    providerRequests: z.number(),
    providerErrors: z.number(),
    commandFailures: z.number(),
    safetyRejects: z.number(),
    approvalDenials: z.number(),
  }),
  health: z.object({
    lastError: z.string().nullable(),
    lastSnapshotWriteError: z.string().nullable(),
    finishReason: z.string().nullable(),
  }),
});

export type LiveRunSnapshot = z.infer<typeof LiveRunSnapshotSchema>;
export type LiveRunTurn = z.infer<typeof LiveRunTurnSchema>;
export type LiveRunPhaseName = z.infer<typeof LiveRunPhaseNameSchema>;

// ---------------------------------------------------------------------------
// Logger event inputs (subset extraction; unknown keys are dropped by zod)
// ---------------------------------------------------------------------------

const OptionalNumber = z.number().nullable().optional();
const OptionalString = z.string().nullable().optional();

export const LoggerEventKindSchema = z.object({ kind: z.string() });

export const RunStartEventSchema = z.object({
  configuredModel: OptionalString,
  baseUrl: OptionalString,
});

export const TurnPreflightStartEventSchema = z.object({
  turn: z.number(),
  promptChars: OptionalNumber,
});

export const TurnPreflightBudgetEventSchema = z.object({
  turn: z.number(),
  promptTokenCount: OptionalNumber,
  tokenizeElapsedMs: OptionalNumber,
  tokenCountSource: OptionalString,
  maxPromptBudget: OptionalNumber,
  overflowTokens: OptionalNumber,
  maxOutputTokens: OptionalNumber,
});

export const TurnModelRequestEventSchema = z.object({ turn: z.number() });

export const ProviderRequestStartEventSchema = z.object({ stage: z.string() });

export const ProviderRequestDoneEventSchema = z.object({
  stage: z.string(),
  statusCode: OptionalNumber,
  elapsedMs: OptionalNumber,
});

export const ProviderRequestErrorEventSchema = z.object({
  stage: z.string(),
  elapsedMs: OptionalNumber,
  error: JsonValueSchema.optional(),
});

export const TurnModelResponseEventSchema = z.object({
  turn: z.number(),
  promptTokens: OptionalNumber,
  completionTokens: OptionalNumber,
  usageThinkingTokens: OptionalNumber,
  promptCacheTokens: OptionalNumber,
  promptEvalTokens: OptionalNumber,
});

export const TurnCommandSafetyEventSchema = z.object({
  turn: z.number(),
  safe: z.boolean(),
  reason: OptionalString,
});

export const TurnCommandStartEventSchema = z.object({
  turn: z.number(),
  toolName: z.string(),
  commandToRun: z.string(),
});

export const TurnCommandResultEventSchema = z.object({
  turn: z.number(),
  command: z.string(),
  exitCode: OptionalNumber,
  output: OptionalString,
  resultTokenCount: OptionalNumber,
});

export const ApprovalVerdictEventSchema = z.object({
  turn: z.number(),
  verdict: z.string(),
  reason: z.string(),
});

export const TaskDoneEventSchema = z.object({ reason: OptionalString });
```

- [ ] **Step 4: Write the collector**

Create `src/repo-search/live-snapshot/collector.ts`:

```ts
import type { JsonSerializable } from '../../lib/json-types.js';
import {
  ApprovalVerdictEventSchema,
  LIVE_SNAPSHOT_COMMAND_CHARS,
  LIVE_SNAPSHOT_MAX_TURNS,
  LIVE_SNAPSHOT_OUTPUT_EDGE_CHARS,
  LoggerEventKindSchema,
  ProviderRequestDoneEventSchema,
  ProviderRequestErrorEventSchema,
  ProviderRequestStartEventSchema,
  RunStartEventSchema,
  TaskDoneEventSchema,
  TurnCommandResultEventSchema,
  TurnCommandSafetyEventSchema,
  TurnCommandStartEventSchema,
  TurnModelRequestEventSchema,
  TurnModelResponseEventSchema,
  TurnPreflightBudgetEventSchema,
  TurnPreflightStartEventSchema,
  type LiveRunPhaseName,
  type LiveRunSnapshot,
  type LiveRunTurn,
} from './schemas.js';

type MutableProviderRequest = {
  stage: string;
  startedAtMs: number;
  elapsedMs: number | null;
  statusCode: number | null;
  error: string | null;
};

type MutableTool = {
  toolName: string;
  command: string;
  startedAtMs: number;
  durationMs: number | null;
  exitCode: number | null;
  outputChars: number | null;
  outputTokens: number | null;
  outputHead: string;
  outputTail: string;
};

type MutableTurn = {
  turn: number;
  promptChars: number | null;
  promptTokens: number | null;
  tokenizeMs: number | null;
  tokenSource: string | null;
  maxPromptBudget: number | null;
  overflowTokens: number | null;
  maxOutputTokens: number | null;
  modelStartedAtMs: number | null;
  modelDurationMs: number | null;
  promptEvalTokens: number | null;
  promptCacheTokens: number | null;
  completionTokens: number | null;
  thinkingTokens: number | null;
  providerRequests: MutableProviderRequest[];
  safety: { safe: boolean; reason: string | null } | null;
  approval: { verdict: string; reason: string } | null;
  tool: MutableTool | null;
};

type MutablePhase = {
  name: LiveRunPhaseName;
  turn: number | null;
  startedAtMs: number;
  detail: string | null;
};

function optionalNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function truncateCommand(command: string): string {
  return command.length > LIVE_SNAPSHOT_COMMAND_CHARS
    ? `${command.slice(0, LIVE_SNAPSHOT_COMMAND_CHARS)}…`
    : command;
}

function splitOutputEdges(output: string): { head: string; tail: string } {
  if (output.length <= LIVE_SNAPSHOT_OUTPUT_EDGE_CHARS * 2) {
    return { head: output, tail: '' };
  }
  return {
    head: output.slice(0, LIVE_SNAPSHOT_OUTPUT_EDGE_CHARS),
    tail: output.slice(-LIVE_SNAPSHOT_OUTPUT_EDGE_CHARS),
  };
}

function formatErrorValue(value: JsonSerializable | undefined): string {
  if (value === undefined || value === null) {
    return 'unknown error';
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function topBy(
  turns: readonly MutableTurn[],
  pick: (turn: MutableTurn) => number | null,
): { turn: number; ms: number }[] {
  return turns
    .map((turn) => ({ turn: turn.turn, ms: pick(turn) }))
    .filter((entry): entry is { turn: number; ms: number } => entry.ms !== null)
    .sort((left, right) => right.ms - left.ms)
    .slice(0, 5);
}

/**
 * Folds the transcript logger's event stream into a small, always-current picture
 * of the run. Pure: no IO, no timers, no clock injection beyond `Date.now()`.
 */
export class LiveRunSnapshotCollector {
  private readonly turns = new Map<number, MutableTurn>();
  private currentTurn: number | null = null;
  private model: string | null = null;
  private baseUrl: string | null = null;
  private lastError: string | null = null;
  private lastSnapshotWriteError: string | null = null;
  private finishReason: string | null = null;
  private phase: MutablePhase;
  private readonly counters = {
    providerRequests: 0,
    providerErrors: 0,
    commandFailures: 0,
    safetyRejects: 0,
    approvalDenials: 0,
  };

  constructor(private readonly meta: {
    requestId: string;
    taskKind: string;
    repoRoot: string;
    startedAtMs: number;
  }) {
    this.phase = { name: 'starting', turn: null, startedAtMs: meta.startedAtMs, detail: null };
  }

  recordWriteError(message: string): void {
    this.lastSnapshotWriteError = message;
  }

  recordRunError(message: string): void {
    this.lastError = message;
  }

  record(event: Record<string, JsonSerializable>): void {
    const parsedKind = LoggerEventKindSchema.safeParse(event);
    if (!parsedKind.success) {
      return;
    }
    switch (parsedKind.data.kind) {
      case 'run_start': return this.onRunStart(event);
      case 'turn_preflight_start': return this.onPreflightStart(event);
      case 'turn_preflight_budget': return this.onPreflightBudget(event);
      case 'turn_model_request': return this.onModelRequest(event);
      case 'provider_request_start': return this.onProviderStart(event);
      case 'provider_request_done': return this.onProviderDone(event);
      case 'provider_request_error': return this.onProviderError(event);
      case 'turn_model_response': return this.onModelResponse(event);
      case 'approval_verdict': return this.onApprovalVerdict(event);
      case 'turn_command_safety': return this.onCommandSafety(event);
      case 'turn_command_start': return this.onCommandStart(event);
      case 'turn_command_result': return this.onCommandResult(event);
      case 'task_done': return this.onTaskDone(event);
      case 'run_done': return this.setPhase('done', null, null);
      default: return undefined;
    }
  }

  build(): LiveRunSnapshot {
    const now = Date.now();
    const ordered = [...this.turns.values()].sort((left, right) => left.turn - right.turn);
    const visible = ordered.slice(-LIVE_SNAPSHOT_MAX_TURNS);
    return {
      requestId: this.meta.requestId,
      taskKind: this.meta.taskKind,
      pid: process.pid,
      repoRoot: this.meta.repoRoot,
      model: this.model,
      baseUrl: this.baseUrl,
      startedAtUtc: new Date(this.meta.startedAtMs).toISOString(),
      snapshotAtUtc: new Date(now).toISOString(),
      elapsedMs: Math.max(0, now - this.meta.startedAtMs),
      phase: {
        name: this.phase.name,
        turn: this.phase.turn,
        startedAtUtc: new Date(this.phase.startedAtMs).toISOString(),
        elapsedMs: Math.max(0, now - this.phase.startedAtMs),
        detail: this.phase.detail,
      },
      turnsRecorded: ordered.length,
      turns: visible.map((turn) => this.toSnapshotTurn(turn)),
      totals: {
        modelMs: sum(ordered.map((turn) => turn.modelDurationMs)),
        toolMs: sum(ordered.map((turn) => turn.tool?.durationMs ?? null)),
        promptEvalTokens: sum(ordered.map((turn) => turn.promptEvalTokens)),
        promptCacheTokens: sum(ordered.map((turn) => turn.promptCacheTokens)),
        completionTokens: sum(ordered.map((turn) => turn.completionTokens)),
        toolOutputChars: sum(ordered.map((turn) => turn.tool?.outputChars ?? null)),
      },
      slowest: {
        byModelMs: topBy(ordered, (turn) => turn.modelDurationMs),
        byToolMs: topBy(ordered, (turn) => turn.tool?.durationMs ?? null),
      },
      counters: {
        turns: ordered.length,
        providerRequests: this.counters.providerRequests,
        providerErrors: this.counters.providerErrors,
        commandFailures: this.counters.commandFailures,
        safetyRejects: this.counters.safetyRejects,
        approvalDenials: this.counters.approvalDenials,
      },
      health: {
        lastError: this.lastError,
        lastSnapshotWriteError: this.lastSnapshotWriteError,
        finishReason: this.finishReason,
      },
    };
  }

  private toSnapshotTurn(turn: MutableTurn): LiveRunTurn {
    return {
      turn: turn.turn,
      promptChars: turn.promptChars,
      promptTokens: turn.promptTokens,
      tokenizeMs: turn.tokenizeMs,
      tokenSource: turn.tokenSource,
      maxPromptBudget: turn.maxPromptBudget,
      overflowTokens: turn.overflowTokens,
      maxOutputTokens: turn.maxOutputTokens,
      modelDurationMs: turn.modelDurationMs,
      promptEvalTokens: turn.promptEvalTokens,
      promptCacheTokens: turn.promptCacheTokens,
      completionTokens: turn.completionTokens,
      thinkingTokens: turn.thinkingTokens,
      providerRequests: turn.providerRequests.map((request) => ({
        stage: request.stage,
        startedAtUtc: new Date(request.startedAtMs).toISOString(),
        elapsedMs: request.elapsedMs,
        statusCode: request.statusCode,
        error: request.error,
      })),
      safety: turn.safety,
      approval: turn.approval,
      tool: turn.tool === null ? null : {
        toolName: turn.tool.toolName,
        command: turn.tool.command,
        startedAtUtc: new Date(turn.tool.startedAtMs).toISOString(),
        durationMs: turn.tool.durationMs,
        exitCode: turn.tool.exitCode,
        outputChars: turn.tool.outputChars,
        outputTokens: turn.tool.outputTokens,
        outputHead: turn.tool.outputHead,
        outputTail: turn.tool.outputTail,
      },
    };
  }

  private ensureTurn(turn: number): MutableTurn {
    const existing = this.turns.get(turn);
    if (existing) {
      return existing;
    }
    const created: MutableTurn = {
      turn,
      promptChars: null,
      promptTokens: null,
      tokenizeMs: null,
      tokenSource: null,
      maxPromptBudget: null,
      overflowTokens: null,
      maxOutputTokens: null,
      modelStartedAtMs: null,
      modelDurationMs: null,
      promptEvalTokens: null,
      promptCacheTokens: null,
      completionTokens: null,
      thinkingTokens: null,
      providerRequests: [],
      safety: null,
      approval: null,
      tool: null,
    };
    this.turns.set(turn, created);
    this.currentTurn = turn;
    return created;
  }

  private setPhase(name: LiveRunPhaseName, turn: number | null, detail: string | null): void {
    this.phase = { name, turn, startedAtMs: Date.now(), detail };
  }

  private onRunStart(event: Record<string, JsonSerializable>): void {
    const parsed = RunStartEventSchema.safeParse(event);
    if (!parsed.success) {
      return;
    }
    this.model = parsed.data.configuredModel ?? null;
    this.baseUrl = parsed.data.baseUrl ?? null;
  }

  private onPreflightStart(event: Record<string, JsonSerializable>): void {
    const parsed = TurnPreflightStartEventSchema.safeParse(event);
    if (!parsed.success) {
      return;
    }
    this.currentTurn = parsed.data.turn;
    this.ensureTurn(parsed.data.turn).promptChars = optionalNumber(parsed.data.promptChars);
    this.setPhase('prompt_preflight', parsed.data.turn, null);
  }

  private onPreflightBudget(event: Record<string, JsonSerializable>): void {
    const parsed = TurnPreflightBudgetEventSchema.safeParse(event);
    if (!parsed.success) {
      return;
    }
    const turn = this.ensureTurn(parsed.data.turn);
    turn.promptTokens = optionalNumber(parsed.data.promptTokenCount);
    turn.tokenizeMs = optionalNumber(parsed.data.tokenizeElapsedMs);
    turn.tokenSource = parsed.data.tokenCountSource ?? null;
    turn.maxPromptBudget = optionalNumber(parsed.data.maxPromptBudget);
    turn.overflowTokens = optionalNumber(parsed.data.overflowTokens);
    turn.maxOutputTokens = optionalNumber(parsed.data.maxOutputTokens);
  }

  private onModelRequest(event: Record<string, JsonSerializable>): void {
    const parsed = TurnModelRequestEventSchema.safeParse(event);
    if (!parsed.success) {
      return;
    }
    this.currentTurn = parsed.data.turn;
    this.ensureTurn(parsed.data.turn).modelStartedAtMs = Date.now();
    this.setPhase('model_request', parsed.data.turn, null);
  }

  private onProviderStart(event: Record<string, JsonSerializable>): void {
    const parsed = ProviderRequestStartEventSchema.safeParse(event);
    if (!parsed.success || this.currentTurn === null) {
      return;
    }
    this.ensureTurn(this.currentTurn).providerRequests.push({
      stage: parsed.data.stage,
      startedAtMs: Date.now(),
      elapsedMs: null,
      statusCode: null,
      error: null,
    });
    this.setPhase('model_request', this.currentTurn, `stage=${parsed.data.stage}`);
  }

  private closeProviderRequest(
    stage: string,
    elapsedMs: number | null,
    statusCode: number | null,
    error: string | null,
  ): void {
    if (this.currentTurn === null) {
      return;
    }
    const requests = this.ensureTurn(this.currentTurn).providerRequests;
    const open = [...requests].reverse().find((request) => request.stage === stage && request.elapsedMs === null);
    const target = open ?? null;
    if (target === null) {
      requests.push({ stage, startedAtMs: Date.now(), elapsedMs, statusCode, error });
      return;
    }
    target.elapsedMs = elapsedMs ?? Math.max(0, Date.now() - target.startedAtMs);
    target.statusCode = statusCode;
    target.error = error;
  }

  private onProviderDone(event: Record<string, JsonSerializable>): void {
    const parsed = ProviderRequestDoneEventSchema.safeParse(event);
    if (!parsed.success) {
      return;
    }
    this.counters.providerRequests += 1;
    this.closeProviderRequest(
      parsed.data.stage,
      optionalNumber(parsed.data.elapsedMs),
      optionalNumber(parsed.data.statusCode),
      null,
    );
  }

  private onProviderError(event: Record<string, JsonSerializable>): void {
    const parsed = ProviderRequestErrorEventSchema.safeParse(event);
    if (!parsed.success) {
      return;
    }
    this.counters.providerErrors += 1;
    const message = formatErrorValue(parsed.data.error);
    this.lastError = message;
    this.closeProviderRequest(parsed.data.stage, optionalNumber(parsed.data.elapsedMs), null, message);
  }

  private onModelResponse(event: Record<string, JsonSerializable>): void {
    const parsed = TurnModelResponseEventSchema.safeParse(event);
    if (!parsed.success) {
      return;
    }
    const turn = this.ensureTurn(parsed.data.turn);
    turn.modelDurationMs = turn.modelStartedAtMs === null
      ? null
      : Math.max(0, Date.now() - turn.modelStartedAtMs);
    turn.promptTokens = optionalNumber(parsed.data.promptTokens) ?? turn.promptTokens;
    turn.completionTokens = optionalNumber(parsed.data.completionTokens);
    turn.thinkingTokens = optionalNumber(parsed.data.usageThinkingTokens);
    turn.promptCacheTokens = optionalNumber(parsed.data.promptCacheTokens);
    turn.promptEvalTokens = optionalNumber(parsed.data.promptEvalTokens);
    this.setPhase('idle', parsed.data.turn, null);
  }

  private onApprovalVerdict(event: Record<string, JsonSerializable>): void {
    const parsed = ApprovalVerdictEventSchema.safeParse(event);
    if (!parsed.success) {
      return;
    }
    this.ensureTurn(parsed.data.turn).approval = {
      verdict: parsed.data.verdict,
      reason: parsed.data.reason,
    };
    if (parsed.data.verdict === 'deny') {
      this.counters.approvalDenials += 1;
    }
  }

  private onCommandSafety(event: Record<string, JsonSerializable>): void {
    const parsed = TurnCommandSafetyEventSchema.safeParse(event);
    if (!parsed.success) {
      return;
    }
    this.ensureTurn(parsed.data.turn).safety = {
      safe: parsed.data.safe,
      reason: parsed.data.reason ?? null,
    };
    if (!parsed.data.safe) {
      this.counters.safetyRejects += 1;
    }
  }

  private onCommandStart(event: Record<string, JsonSerializable>): void {
    const parsed = TurnCommandStartEventSchema.safeParse(event);
    if (!parsed.success) {
      return;
    }
    const command = truncateCommand(parsed.data.commandToRun);
    this.ensureTurn(parsed.data.turn).tool = {
      toolName: parsed.data.toolName,
      command,
      startedAtMs: Date.now(),
      durationMs: null,
      exitCode: null,
      outputChars: null,
      outputTokens: null,
      outputHead: '',
      outputTail: '',
    };
    this.setPhase('tool_execute', parsed.data.turn, command);
  }

  private onCommandResult(event: Record<string, JsonSerializable>): void {
    const parsed = TurnCommandResultEventSchema.safeParse(event);
    if (!parsed.success) {
      return;
    }
    const turn = this.ensureTurn(parsed.data.turn);
    const output = parsed.data.output ?? '';
    const edges = splitOutputEdges(output);
    const exitCode = optionalNumber(parsed.data.exitCode);
    const existing = turn.tool;
    turn.tool = {
      toolName: existing?.toolName ?? 'unknown',
      command: existing?.command ?? truncateCommand(parsed.data.command),
      startedAtMs: existing?.startedAtMs ?? Date.now(),
      durationMs: existing === null ? null : Math.max(0, Date.now() - existing.startedAtMs),
      exitCode,
      outputChars: output.length,
      outputTokens: optionalNumber(parsed.data.resultTokenCount),
      outputHead: edges.head,
      outputTail: edges.tail,
    };
    if (exitCode !== null && exitCode !== 0) {
      this.counters.commandFailures += 1;
    }
    this.setPhase('idle', parsed.data.turn, null);
  }

  private onTaskDone(event: Record<string, JsonSerializable>): void {
    const parsed = TaskDoneEventSchema.safeParse(event);
    if (!parsed.success) {
      return;
    }
    this.finishReason = parsed.data.reason ?? null;
    this.setPhase('done', null, null);
  }
}

function sum(values: readonly (number | null)[]): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -- live-run-snapshot-collector`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add src/repo-search/live-snapshot tests/live-run-snapshot-collector.test.ts
git commit -m "feat: add live run snapshot collector with phase and model tracking"
```

---

## Task 4: Collector tool, safety, approval and aggregate coverage

Task 3 built the machinery; this task pins the remaining behaviour with tests (tool timing, output truncation, counters, turn window, totals/slowest). If a test here fails, fix `collector.ts` — do not weaken the test.

**Files:**
- Test: `tests/live-run-snapshot-collector.test.ts` (append)
- Modify (only if a test fails): `src/repo-search/live-snapshot/collector.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/live-run-snapshot-collector.test.ts`:

```ts
test('collector captures tool execution phase, exit code and truncated output edges', () => {
  const collector = makeCollector();
  const longOutput = `${'A'.repeat(500)}${'B'.repeat(500)}${'C'.repeat(500)}`;

  collector.record({ kind: 'turn_command_safety', taskId: 't', turn: 39, command: 'npm run test', safe: true, reason: null });
  collector.record({ kind: 'turn_command_start', taskId: 't', turn: 39, toolName: 'run', requestedCommand: 'npm run test', commandToRun: 'npm run test', native: false });

  const midFlight = LiveRunSnapshotSchema.parse(collector.build());
  assert.equal(midFlight.phase.name, 'tool_execute');
  assert.equal(midFlight.phase.detail, 'npm run test');
  assert.equal(midFlight.turns[0].tool?.durationMs, null);

  collector.record({
    kind: 'turn_command_result', taskId: 't', turn: 39, command: 'npm run test',
    exitCode: 1, output: longOutput, resultTokenCount: 1064,
  });

  const snapshot = LiveRunSnapshotSchema.parse(collector.build());
  const tool = snapshot.turns[0].tool;
  assert.equal(tool?.toolName, 'run');
  assert.equal(tool?.exitCode, 1);
  assert.equal(tool?.outputChars, 1500);
  assert.equal(tool?.outputTokens, 1064);
  assert.equal(tool?.outputHead.length, 300);
  assert.equal(tool?.outputTail.length, 300);
  assert.equal(tool?.outputHead.startsWith('A'), true);
  assert.equal(tool?.outputTail.endsWith('C'), true);
  assert.ok(tool !== null && tool.durationMs !== null && tool.durationMs >= 0);
  assert.equal(snapshot.turns[0].safety?.safe, true);
  assert.equal(snapshot.counters.commandFailures, 1);
  assert.equal(snapshot.phase.name, 'idle');
});

test('collector keeps short tool output whole without a tail', () => {
  const collector = makeCollector();

  collector.record({ kind: 'turn_command_start', taskId: 't', turn: 1, toolName: 'run', requestedCommand: 'git status', commandToRun: 'git status', native: false });
  collector.record({ kind: 'turn_command_result', taskId: 't', turn: 1, command: 'git status', exitCode: 0, output: 'clean', resultTokenCount: 2 });

  const snapshot = LiveRunSnapshotSchema.parse(collector.build());
  assert.equal(snapshot.turns[0].tool?.outputHead, 'clean');
  assert.equal(snapshot.turns[0].tool?.outputTail, '');
  assert.equal(snapshot.counters.commandFailures, 0);
});

test('collector counts unsafe commands and denied approvals', () => {
  const collector = makeCollector();

  collector.record({ kind: 'approval_verdict', taskId: 't', turn: 2, toolName: 'run', verdict: 'deny', reason: 'destructive' });
  collector.record({ kind: 'turn_command_safety', taskId: 't', turn: 3, command: 'rm -rf /', safe: false, reason: 'blocked by policy' });

  const snapshot = LiveRunSnapshotSchema.parse(collector.build());
  assert.equal(snapshot.counters.approvalDenials, 1);
  assert.equal(snapshot.counters.safetyRejects, 1);
  assert.equal(snapshot.turns[0].approval?.verdict, 'deny');
  assert.equal(snapshot.turns[1].safety?.reason, 'blocked by policy');
});

test('collector truncates a long command string', () => {
  const collector = makeCollector();
  const longCommand = `git log ${'x'.repeat(1000)}`;

  collector.record({ kind: 'turn_command_start', taskId: 't', turn: 1, toolName: 'run', requestedCommand: longCommand, commandToRun: longCommand, native: false });

  const snapshot = LiveRunSnapshotSchema.parse(collector.build());
  assert.equal(snapshot.turns[0].tool?.command.length, 501);
  assert.equal(snapshot.turns[0].tool?.command.endsWith('…'), true);
});

test('collector keeps only the most recent turns but reports the full count', () => {
  const collector = makeCollector();

  for (let turn = 1; turn <= 120; turn += 1) {
    collector.record({ kind: 'turn_preflight_start', taskId: 't', turn, promptChars: turn });
  }

  const snapshot = LiveRunSnapshotSchema.parse(collector.build());
  assert.equal(snapshot.turnsRecorded, 120);
  assert.equal(snapshot.turns.length, 100);
  assert.equal(snapshot.turns[0].turn, 21);
  assert.equal(snapshot.turns[99].turn, 120);
});

test('collector totals and slowest lists summarize every recorded turn', () => {
  const collector = makeCollector();

  const recordTurn = (turn: number, promptEval: number, cache: number, completion: number): void => {
    collector.record({ kind: 'turn_preflight_start', taskId: 't', turn, promptChars: 10 });
    collector.record({ kind: 'turn_model_request', taskId: 't', turn, thinkingEnabled: false });
    collector.record({
      kind: 'turn_model_response', taskId: 't', turn, text: '{}', thinkingText: '', mockExhausted: false,
      promptTokens: 100, completionTokens: completion, usageThinkingTokens: 0,
      promptCacheTokens: cache, promptEvalTokens: promptEval,
    });
  };

  recordTurn(1, 500, 0, 10);
  recordTurn(2, 200, 300, 20);

  const snapshot = LiveRunSnapshotSchema.parse(collector.build());
  assert.equal(snapshot.totals.promptEvalTokens, 700);
  assert.equal(snapshot.totals.promptCacheTokens, 300);
  assert.equal(snapshot.totals.completionTokens, 30);
  assert.equal(snapshot.slowest.byModelMs.length, 2);
  assert.equal(snapshot.slowest.byToolMs.length, 0);
  assert.equal(snapshot.counters.turns, 2);
  assert.ok(snapshot.totals.modelMs >= 0);
});

test('collector surfaces run and snapshot write errors', () => {
  const collector = makeCollector();

  collector.recordRunError('planner_preflight_overflow');
  collector.recordWriteError('EPERM: operation not permitted');
  collector.record({ kind: 'task_done', taskId: 't', reason: 'finished', turnsUsed: 3, safetyRejects: 0, invalidResponses: 0, commandFailures: 0, passed: true, missingSignals: [] });

  const snapshot = LiveRunSnapshotSchema.parse(collector.build());
  assert.equal(snapshot.health.lastError, 'planner_preflight_overflow');
  assert.equal(snapshot.health.lastSnapshotWriteError, 'EPERM: operation not permitted');
  assert.equal(snapshot.health.finishReason, 'finished');
  assert.equal(snapshot.phase.name, 'done');
});
```

- [ ] **Step 2: Run tests to verify they pass (or expose a real bug)**

Run: `npm run test -- live-run-snapshot-collector`
Expected: PASS, 14 tests. If any assertion fails, fix `src/repo-search/live-snapshot/collector.ts` so the behaviour matches the test, then re-run.

- [ ] **Step 3: Commit**

```bash
git add tests/live-run-snapshot-collector.test.ts src/repo-search/live-snapshot/collector.ts
git commit -m "test: cover live run snapshot tool, counter and aggregate folding"
```

---

## Task 5: Snapshot writer, env gate and logger attachment

**Files:**
- Create: `src/repo-search/live-snapshot/writer.ts`
- Test: `tests/live-run-snapshot-writer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/live-run-snapshot-writer.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { LiveRunSnapshotCollector } from '../src/repo-search/live-snapshot/collector.js';
import { LiveRunSnapshotSchema } from '../src/repo-search/live-snapshot/schemas.js';
import {
  attachLiveRunSnapshot,
  isLiveRunSnapshotEnabled,
  LiveRunSnapshotWriter,
} from '../src/repo-search/live-snapshot/writer.js';
import { createJsonLogger } from '../src/repo-search/logging.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

function readSnapshot(filePath: string): ReturnType<typeof LiveRunSnapshotSchema.parse> {
  return LiveRunSnapshotSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

test('writer flushes the collector state to disk as parseable json', async () => {
  const tempRoot = createManagedTempDir('siftkit-live-writer-');
  const filePath = path.join(tempRoot, 'live', 'run-req-1.json');
  const collector = new LiveRunSnapshotCollector({
    requestId: 'req-1', taskKind: 'repo-search', repoRoot: tempRoot, startedAtMs: Date.now(),
  });
  const writer = new LiveRunSnapshotWriter({ filePath, collector });

  try {
    collector.record({ kind: 'turn_model_request', taskId: 't', turn: 7, thinkingEnabled: false });
    await writer.flushNow();

    const snapshot = readSnapshot(filePath);
    assert.equal(snapshot.requestId, 'req-1');
    assert.equal(snapshot.phase.name, 'model_request');
    assert.equal(snapshot.phase.turn, 7);
  } finally {
    writer.stop();
  }
});

test('writer coalesces scheduled writes and keeps the latest state', async () => {
  const tempRoot = createManagedTempDir('siftkit-live-writer-coalesce-');
  const filePath = path.join(tempRoot, 'run.json');
  const collector = new LiveRunSnapshotCollector({
    requestId: 'req-2', taskKind: 'repo-search', repoRoot: tempRoot, startedAtMs: Date.now(),
  });
  const writer = new LiveRunSnapshotWriter({ filePath, collector, minIntervalMs: 5 });

  try {
    for (let turn = 1; turn <= 25; turn += 1) {
      collector.record({ kind: 'turn_preflight_start', taskId: 't', turn, promptChars: turn });
      writer.schedule();
    }
    await writer.flushNow();

    const snapshot = readSnapshot(filePath);
    assert.equal(snapshot.turnsRecorded, 25);
    assert.equal(fs.readdirSync(path.dirname(filePath)).length, 1);
  } finally {
    writer.stop();
  }
});

test('writer removes the snapshot file on remove', async () => {
  const tempRoot = createManagedTempDir('siftkit-live-writer-remove-');
  const filePath = path.join(tempRoot, 'run.json');
  const collector = new LiveRunSnapshotCollector({
    requestId: 'req-3', taskKind: 'repo-search', repoRoot: tempRoot, startedAtMs: Date.now(),
  });
  const writer = new LiveRunSnapshotWriter({ filePath, collector });

  await writer.flushNow();
  assert.equal(fs.existsSync(filePath), true);

  writer.stop();
  await writer.remove();
  assert.equal(fs.existsSync(filePath), false);
  await writer.remove();
});

test('attachLiveRunSnapshot forwards events to the wrapped logger and the snapshot', async () => {
  const tempRoot = createManagedTempDir('siftkit-live-attach-');
  const filePath = path.join(tempRoot, 'run.json');
  const inner = createJsonLogger('db://repo-search/request_attach.jsonl');
  const attached = attachLiveRunSnapshot({
    logger: inner,
    filePath,
    requestId: 'req-4',
    taskKind: 'repo-agent',
    repoRoot: tempRoot,
    startedAtMs: Date.now(),
  });

  try {
    attached.logger.write({ kind: 'turn_model_request', taskId: 't', turn: 3, thinkingEnabled: false });
    await attached.writer.flushNow();

    assert.equal(attached.logger.path, inner.path);
    assert.ok(inner.getText().includes('"kind":"turn_model_request"'));
    assert.equal(readSnapshot(filePath).phase.turn, 3);
  } finally {
    attached.writer.stop();
  }
});

test('live run snapshot is enabled by default and disabled by SIFTKIT_LIVE_SNAPSHOT=0', () => {
  const previous = process.env.SIFTKIT_LIVE_SNAPSHOT;
  try {
    delete process.env.SIFTKIT_LIVE_SNAPSHOT;
    assert.equal(isLiveRunSnapshotEnabled(), true);

    process.env.SIFTKIT_LIVE_SNAPSHOT = '0';
    assert.equal(isLiveRunSnapshotEnabled(), false);

    process.env.SIFTKIT_LIVE_SNAPSHOT = 'false';
    assert.equal(isLiveRunSnapshotEnabled(), false);

    process.env.SIFTKIT_LIVE_SNAPSHOT = '1';
    assert.equal(isLiveRunSnapshotEnabled(), true);
  } finally {
    if (previous === undefined) {
      delete process.env.SIFTKIT_LIVE_SNAPSHOT;
    } else {
      process.env.SIFTKIT_LIVE_SNAPSHOT = previous;
    }
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- live-run-snapshot-writer`
Expected: FAIL during `npm run typecheck:test` with `error TS2307: Cannot find module '../src/repo-search/live-snapshot/writer.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/repo-search/live-snapshot/writer.ts`:

```ts
import { rm } from 'node:fs/promises';
import { saveContentAtomicallyAsync } from '../../lib/fs.js';
import type { BufferedJsonLogger } from '../logging.js';
import { LiveRunSnapshotCollector } from './collector.js';

const DEFAULT_MIN_INTERVAL_MS = 200;
/** Rewrites the file even while nothing happens, so a wedged phase is visibly stale-free. */
const DEFAULT_HEARTBEAT_MS = 5000;

export function isLiveRunSnapshotEnabled(): boolean {
  const value = String(process.env.SIFTKIT_LIVE_SNAPSHOT ?? '').trim().toLowerCase();
  return value !== '0' && value !== 'false' && value !== 'no' && value !== 'off';
}

/**
 * Writes the collector's snapshot to one fixed path, overwriting it in place.
 * Writes are serialized through a promise chain (so `flushNow` is deterministic)
 * and coalesced behind a single pending timer (so a burst of events costs one write).
 * Never throws at the caller: write failures land in the snapshot's own health block.
 */
export class LiveRunSnapshotWriter {
  private readonly filePath: string;
  private readonly collector: LiveRunSnapshotCollector;
  private readonly minIntervalMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(options: {
    filePath: string;
    collector: LiveRunSnapshotCollector;
    minIntervalMs?: number;
    heartbeatMs?: number;
  }) {
    this.filePath = options.filePath;
    this.collector = options.collector;
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.heartbeat = setInterval(() => {
      this.schedule();
    }, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  schedule(): void {
    if (this.stopped || this.timer !== null) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.enqueueWrite();
    }, this.minIntervalMs);
    this.timer.unref();
  }

  async flushNow(): Promise<void> {
    await this.enqueueWrite();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  async remove(): Promise<void> {
    await this.queue;
    await rm(this.filePath, { force: true }).catch(() => undefined);
  }

  private enqueueWrite(): Promise<void> {
    this.queue = this.queue.then(() => this.writeOnce());
    return this.queue;
  }

  private async writeOnce(): Promise<void> {
    try {
      const text = `${JSON.stringify(this.collector.build(), null, 2)}\n`;
      await saveContentAtomicallyAsync(this.filePath, text);
    } catch (error) {
      this.collector.recordWriteError(error instanceof Error ? error.message : String(error));
    }
  }
}

/**
 * Wraps a transcript logger so every event also feeds the live snapshot. The
 * returned logger keeps the wrapped logger's identity (`path`, `getText`,
 * `persist`) — callers that persist the transcript are unaffected.
 */
export function attachLiveRunSnapshot(options: {
  logger: BufferedJsonLogger;
  filePath: string;
  requestId: string;
  taskKind: string;
  repoRoot: string;
  startedAtMs: number;
}): {
  logger: BufferedJsonLogger;
  writer: LiveRunSnapshotWriter;
  collector: LiveRunSnapshotCollector;
} {
  const collector = new LiveRunSnapshotCollector({
    requestId: options.requestId,
    taskKind: options.taskKind,
    repoRoot: options.repoRoot,
    startedAtMs: options.startedAtMs,
  });
  const writer = new LiveRunSnapshotWriter({ filePath: options.filePath, collector });
  const logger: BufferedJsonLogger = {
    path: options.logger.path,
    write(event) {
      options.logger.write(event);
      collector.record(event);
      writer.schedule();
    },
    getText: () => options.logger.getText(),
    persist: (targetPath, requestId) => options.logger.persist(targetPath, requestId),
  };
  return { logger, writer, collector };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- live-run-snapshot-writer`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/live-snapshot/writer.ts tests/live-run-snapshot-writer.test.ts
git commit -m "feat: add async coalesced live run snapshot writer"
```

---

## Task 6: Emit the three missing logger events

Without these, a hang during tokenization, during shell execution, or during an auto-approval verdict cannot be attributed to a phase, and tool duration is unknowable.

**Files:**
- Modify: `src/repo-search/engine/prompt-preparer.ts:72` (new `turn_preflight_start` write) and `:101-114` (two extra fields on `turn_preflight_budget`)
- Modify: `src/repo-search/engine/tool-action-processor.ts:665-668`
- Modify: `src/repo-search/engine/llm-approval-gate.ts:32-58`
- Modify: `src/repo-search/engine/task-loop.ts:288-293`
- Modify: `src/repo-search/approval-verdict-probe.ts:155-160`
- Test: `tests/live-run-snapshot-execute.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/live-run-snapshot-execute.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { executeRepoSearchRequest } from '../src/repo-search/index.js';
import { withTestEnvAndServer } from './_test-helpers.js';

test('transcript records preflight start and command start events for every turn', async () => {
  await withTestEnvAndServer(async ({ tempRoot: repoRoot }) => {
    const result = await executeRepoSearchRequest({
      presetId: 'repo-search',
      prompt: 'find build scripts',
      repoRoot,
      maxTurns: 2,
      mockResponses: [
        '{"action":"git","command":"git status --short"}',
        '{"action":"finish","output":"Found scripts"}',
      ],
      mockCommandResults: {
        'git status --short': { exitCode: 0, stdout: '', stderr: '' },
      },
    });
    assert.equal(result.scorecard.verdict, 'pass');
  });
});
```

Note: this test only proves the run still works end-to-end; Task 7 adds the snapshot assertions that consume the new events. Write it now so Task 6 has a regression guard for the event additions.

- [ ] **Step 2: Run test to verify the baseline passes**

Run: `npm run test -- live-run-snapshot-execute`
Expected: PASS, 1 test. (This is the pre-change baseline — the additions below must not break it.)

- [ ] **Step 3: Emit `turn_preflight_start`**

In `src/repo-search/engine/prompt-preparer.ts`, insert immediately after `progress.preflightStart(turn, prompt.length);` (line 72):

```ts
    this.options.logger?.write({ kind: 'turn_preflight_start', taskId, turn, promptChars: prompt.length });
```

- [ ] **Step 3b: Add tokenizer timing to `turn_preflight_budget`**

Tokenization is a call to the inference server and can itself stall, so the snapshot needs its cost. In `src/repo-search/engine/prompt-preparer.ts`, the existing `turn_preflight_budget` write (lines 101-114) gains two fields — replace it with:

```ts
    this.options.logger?.write({
      kind: 'turn_preflight_budget',
      taskId,
      turn,
      promptTokenCount: preflight.promptTokenCount,
      tokenizeElapsedMs: preflight.tokenizeElapsedMs ?? null,
      tokenCountSource: preflight.tokenCountSource,
      transcriptPromptTokenCount: preflight.transcriptPromptTokenCount,
      providerPromptReserveTokenCount: preflight.providerPromptReserveTokenCount,
      maxPromptBudget: preflight.maxPromptBudget,
      overflowTokens: preflight.overflowTokens,
      ok: preflight.ok,
      compacted: false,
      contextOverflowPolicy: this.options.contextOverflowPolicy,
      maxOutputTokens,
    });
```

If the typecheck reports that `tokenizeElapsedMs` or `tokenCountSource` is not on the `preflight` result type, read the return type of `preflightPlannerPromptBudget` in `src/repo-search/prompt-budget.ts` and use the actual field names — `progress.tokenizeDone(turn, prompt.length, preflight)` at line 93 already passes this same object as `TokenizeDoneInfo`, so both values are present on it.

- [ ] **Step 4: Emit `turn_command_start`**

In `src/repo-search/engine/tool-action-processor.ts`, insert immediately after `this.deps.progress.toolStart(progressToolCallId, turn, requestedCommand, promptTokenCount);` (line 667):

```ts
    this.deps.logger?.write({
      kind: 'turn_command_start',
      taskId: this.deps.task.id,
      turn,
      toolName: normalizedToolName,
      requestedCommand,
      commandToRun,
      native: isNativeTool,
    });
```

- [ ] **Step 5: Emit `approval_verdict`**

In `src/repo-search/engine/llm-approval-gate.ts`, add the import at the top (after line 7):

```ts
import type { JsonLogger } from '../types.js';
```

Add `logger` to the constructor dependency object (replacing lines 33-38):

```ts
  constructor(private readonly deps: {
    requestId: string;
    humanGate: ApprovalRequester;
    verdictRequester: ApprovalVerdictRequester;
    progressWriter: ProgressWriter<RepoSearchProgressEvent>;
    logger: JsonLogger | null;
  }) {}
```

Replace `emitVerdict` (lines 72-82) with:

```ts
  private emitVerdict(input: ApprovalRequestInput, verdict: string, reason: string): void {
    this.deps.logger?.write({
      kind: 'approval_verdict',
      turn: input.turn,
      toolName: input.toolName,
      verdict,
      reason,
    });
    this.deps.progressWriter.write({
      kind: 'approval_auto',
      requestId: this.deps.requestId,
      turn: input.turn,
      toolName: input.toolName,
      command: input.command,
      verdict,
      reason,
    });
  }
```

- [ ] **Step 6: Update both `LlmApprovalGate` construction sites**

In `src/repo-search/engine/task-loop.ts`, add to the object at line 288-293:

```ts
    return new LlmApprovalGate({
      requestId: options.approvalGate.getRequestId(),
      humanGate: options.approvalGate,
      verdictRequester: this,
      progressWriter: options.progressWriter ?? new SilentProgressWriter(),
      logger: options.logger ?? null,
    });
```

In `src/repo-search/approval-verdict-probe.ts`, add to the object at line 155-160:

```ts
    const gate = new LlmApprovalGate({
      requestId: 'auto-approval-verdict-probe',
      humanGate: new FailClosedHumanGate(),
      verdictRequester: requester,
      progressWriter,
      logger: null,
    });
```

- [ ] **Step 7: Run the affected suites**

Run: `npm run test -- live-run-snapshot-execute`
Expected: PASS, 1 test.

Run: `npm run test -- approval`
Expected: PASS. If any other test constructs `LlmApprovalGate`, the typecheck step will name the file — add `logger: null` there too.

Run: `npm run test 2>&1 | siftkit summary --question "Return pass/fail, failing test names, root errors, and file:line anchors."`
Expected: pass. Any transcript-shape assertion that now sees the extra events must be updated to accept them — the new events are additive and must not be removed to make a test pass.

- [ ] **Step 8: Commit**

```bash
git add src/repo-search/engine/prompt-preparer.ts src/repo-search/engine/tool-action-processor.ts src/repo-search/engine/llm-approval-gate.ts src/repo-search/engine/task-loop.ts src/repo-search/approval-verdict-probe.ts tests/live-run-snapshot-execute.test.ts
git commit -m "feat: log preflight start, command start and approval verdict events"
```

---

## Task 7: Wire the snapshot into the run lifecycle

**Files:**
- Modify: `src/repo-search/execute.ts:1-40` (imports), `:336-345` (logger creation), `:388` (`logger` passed to `runRepoSearch`), `:534` (success), `:541-545` (failure), `:649-660` (`finally`)
- Test: `tests/live-run-snapshot-execute.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/live-run-snapshot-execute.test.ts` (add these imports to the existing import block):

```ts
import fs from 'node:fs';

import { getLiveRunSnapshotPath } from '../src/config/paths.js';
import { LiveRunSnapshotSchema } from '../src/repo-search/live-snapshot/schemas.js';
```

Then append:

```ts
async function waitForFile(filePath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

test('a live snapshot exists while the run is in flight and is removed once it finishes', async () => {
  await withTestEnvAndServer(async ({ tempRoot: repoRoot }) => {
    const requestId = 'live-inflight-1';
    const snapshotPath = getLiveRunSnapshotPath(requestId, repoRoot);

    const pending = executeRepoSearchRequest({
      presetId: 'repo-search',
      requestId,
      prompt: 'find build scripts',
      repoRoot,
      maxTurns: 2,
      mockResponses: [
        '{"action":"git","command":"git status --short"}',
        '{"action":"finish","output":"Found scripts"}',
      ],
      mockCommandResults: {
        'git status --short': { exitCode: 0, stdout: '', stderr: '', delayMs: 1500 },
      },
    });

    const appeared = await waitForFile(snapshotPath, 3000);
    assert.equal(appeared, true, 'expected a live snapshot while the run is in flight');

    const snapshot = LiveRunSnapshotSchema.parse(JSON.parse(fs.readFileSync(snapshotPath, 'utf8')));
    assert.equal(snapshot.requestId, requestId);
    assert.equal(snapshot.pid, process.pid);
    assert.equal(snapshot.turns.length > 0, true);
    assert.ok(['prompt_preflight', 'model_request', 'tool_execute', 'idle'].includes(snapshot.phase.name));

    const result = await pending;
    assert.equal(result.scorecard.verdict, 'pass');
    assert.equal(fs.existsSync(snapshotPath), false, 'a finished run must not leave a snapshot behind');
  });
});

test('a failed run removes its live snapshot', async () => {
  await withTestEnvAndServer(async ({ tempRoot: repoRoot }) => {
    const requestId = 'live-failed-1';
    const snapshotPath = getLiveRunSnapshotPath(requestId, repoRoot);

    await assert.rejects(executeRepoSearchRequest({
      presetId: 'this-preset-does-not-exist',
      requestId,
      prompt: 'find build scripts',
      repoRoot,
      maxTurns: 1,
      mockResponses: ['{"action":"finish","output":"never runs"}'],
    }));

    assert.equal(fs.existsSync(snapshotPath), false);
  });
});

test('the live snapshot is skipped when SIFTKIT_LIVE_SNAPSHOT=0', async () => {
  const previous = process.env.SIFTKIT_LIVE_SNAPSHOT;
  process.env.SIFTKIT_LIVE_SNAPSHOT = '0';
  try {
    await withTestEnvAndServer(async ({ tempRoot: repoRoot }) => {
      const requestId = 'live-disabled-1';
      const snapshotPath = getLiveRunSnapshotPath(requestId, repoRoot);

      const result = await executeRepoSearchRequest({
        presetId: 'repo-search',
        requestId,
        prompt: 'find build scripts',
        repoRoot,
        maxTurns: 2,
        mockResponses: [
          '{"action":"git","command":"git status --short"}',
          '{"action":"finish","output":"Found scripts"}',
        ],
        mockCommandResults: {
          'git status --short': { exitCode: 0, stdout: '', stderr: '' },
        },
      });

      assert.equal(result.scorecard.verdict, 'pass');
      assert.equal(fs.existsSync(snapshotPath), false);
    });
  } finally {
    if (previous === undefined) {
      delete process.env.SIFTKIT_LIVE_SNAPSHOT;
    } else {
      process.env.SIFTKIT_LIVE_SNAPSHOT = previous;
    }
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- live-run-snapshot-execute`
Expected: FAIL on `expected a live snapshot while the run is in flight` (the first new test) — nothing writes the file yet.

- [ ] **Step 3: Wire the snapshot into `executeRepoSearchRequest`**

In `src/repo-search/execute.ts`, add to the import block near the top (after the `./logging.js` import at lines 8-12):

```ts
import { getLiveRunSnapshotPath } from '../config/paths.js';
import { attachLiveRunSnapshot, isLiveRunSnapshotEnabled } from './live-snapshot/writer.js';
```

Replace line 340 (`const logger = createJsonLogger(tempTranscriptPath);`) with:

```ts
  const logger = createJsonLogger(tempTranscriptPath);
  // Overwritten continuously and deleted on termination: a file that outlives the
  // process is, by construction, a killed or hung run.
  const liveSnapshot = isLiveRunSnapshotEnabled()
    ? attachLiveRunSnapshot({
      logger,
      filePath: getLiveRunSnapshotPath(requestId, repoRoot),
      requestId,
      taskKind,
      repoRoot,
      startedAtMs: startedAt,
    })
    : null;
  const runLogger = liveSnapshot?.logger ?? logger;
```

In the `runRepoSearch({ ... })` call, replace the `logger,` property (line 388) with:

```ts
      logger: runLogger,
```

In the `catch (error)` block, immediately after `const message = error instanceof Error ? error.message : String(error);` (line 545), add:

```ts
    liveSnapshot?.collector.recordRunError(message);
```

In the `finally` block (lines 649-660), add before the existing `if (timingRecorder)` block:

```ts
    if (liveSnapshot) {
      liveSnapshot.writer.stop();
      await liveSnapshot.writer.remove();
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- live-run-snapshot-execute`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the full verification set**

```bash
npm run test 2>&1 | siftkit summary --question "Return pass/fail, failing test names, root errors, and relevant file:line anchors."
npm run typecheck
npm run lint
```

Expected: all pass. `npm run typecheck` already runs `npm run lint` as its last step; run `lint` separately only if `typecheck` fails early.

- [ ] **Step 6: Commit**

```bash
git add src/repo-search/execute.ts tests/live-run-snapshot-execute.test.ts
git commit -m "feat: write a live run snapshot for every repo-search run"
```

---

## Manual verification

After Task 7, confirm the feature does the thing it was built for:

1. Start a repo-agent run: `siftkit repo-agent '<any small task>'`
2. While it runs: `Get-Content .siftkit\live\run-*.json | ConvertFrom-Json | Select-Object -ExpandProperty phase`
   Expect a `name`/`turn`/`elapsedMs` triple that advances between polls.
3. Kill the process (Ctrl-C or `Stop-Process`), then re-read the file: it must still exist and show the phase it died in.
4. Let a run finish normally: `.siftkit\live\` must contain no file for that request id.

---

## Notes for the implementer

- **Do not** make `LlmApprovalGate.logger` optional to avoid touching call sites. Both sites are listed in Task 6; a missed one must fail the typecheck loudly.
- The snapshot must never throw into the engine. Every write failure is swallowed into `health.lastSnapshotWriteError` — if you find yourself adding a `try/catch` at a call site, the writer is wrong.
- Timers are `unref()`ed on purpose: the snapshot must never keep a finished process alive.
- `LIVE_SNAPSHOT_MAX_TURNS`, `LIVE_SNAPSHOT_OUTPUT_EDGE_CHARS` and `LIVE_SNAPSHOT_COMMAND_CHARS` are the only knobs bounding file size. Do not add unbounded fields (full prompts, full transcripts, full tool output) — that content already reaches `run_logs.repo_search_transcript_jsonl` on clean termination.

### Deliberate omissions from the original field sketch

Three fields were dropped because no logger event carries them and adding one is disproportionate to their value. Do not add them speculatively:

- **`backend`** (`exl3` / `llama`) — `run_start` carries `configuredModel` and `baseUrl`, which identify the engine well enough.
- **`providerRequests[].retries`** — provider retries are logged by `logProviderRetry` under a separate event; the `counters.providerErrors` total plus each request's `elapsedMs` already show a retried call as a long one.
- **`counters.invalidResponses`** — only reported in the terminal `task_done` event, which by definition never lands for the hung runs this file exists to diagnose.

# Parallel Status Tracking — Drift Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every directive violation and bandaid introduced on `feature/parallel-status-tracking` (branch diff vs `main`), so the parallel-run and per-session-lease architecture is first-class rather than patched around.

**Architecture:** Three independent areas. (1) The status-server run registries stop deriving types from factory functions and start declaring discriminated unions directly; the `startOrAdvance` advance path stops clobbering captured metadata with nulls; status run logs record the real active model/backend. (2) The per-chat-session operation lease becomes structural — an abstract `ChatSessionOperationEndpoint` base class owns session lookup, body parse, lease acquire/release — replacing six hand-copied wrapper blocks. (3) The dashboard chat runtime store collapses thirteen copy-pasted copy-on-write methods into one `apply(transition)` entry point, and the seven-closure `RuntimeActions` bag is replaced by a pure `toRuntimeTransitions` async generator that yields plain data, so no functions are passed dynamically.

**Tech Stack:** TypeScript (strict), Node 22 `node:test` + `node:assert/strict`, Zod v4 contracts in `packages/contracts`, React 19 dashboard tested via `react-dom/server` `renderToStaticMarkup`, c8 for coverage.

---

## Conventions for every task

- **TDD is mandatory.** Write the failing test, run it, watch it fail for the *right* reason, then implement.
- **No back-compat.** Delete the old shape entirely. Do not leave aliases, re-exports, or dual paths.
- **Banned in all new code:** type-assertion casts (`x as T`, `<T>x`), `any`, non-null `!`, namespace imports (`import * as X`). `as const` and `satisfies` are allowed.
- **Commands** (run from repo root, PowerShell or Bash both fine):
  - Backend tests, single file: `npx tsx --test .\tests\<file>.test.ts`
  - Backend typecheck: `npm run typecheck:test`
  - Dashboard tests, single file: `npx tsx --test .\dashboard\tests\<path>.test.ts`
  - Dashboard typecheck: `npm run typecheck:dashboard-test`
  - Everything: `npm run typecheck` then `npm test`
- **Baseline is green.** `npm run typecheck:test` passes on the current tree. If it does not pass before you start a task, stop and report.

---

## File Structure

**Backend — status run tracking**

| File | Responsibility after this plan |
|---|---|
| `src/status-server/status-run-registry.ts` | Owns active/awaiting/completed run maps. Declares `ActiveRunState` and all result unions as explicit types. No factory-per-variant functions, no `c8 ignore`. |
| `src/status-server/chat-session-operation-registry.ts` | Owns the one-operation-per-chat-session lease. Declares its types explicitly. No `c8 ignore`, no `ChatSessionOperationLease` alias. |
| `src/status-server/routes/core.ts` | Imports `ActiveRunState` instead of deriving `StatusRunState` via `Extract<...>`. `persistStatusRunLog` records real model/backend and gets its title from the identity resolver. |

**Backend — chat route leases**

| File | Responsibility after this plan |
|---|---|
| `src/status-server/routes/chat-session-operation-endpoint.ts` | **New.** Abstract `ChatSessionOperationEndpoint<TParsed>`: session id capture, session lookup (404), body parse (400), request parse (400), lease acquire (409), release in `finally`. Plus the two shared request parsers and `rejectBusyChatSession`. |
| `src/status-server/routes/chat.ts` | Endpoint bodies only. Six endpoints extend the base class; the six copy-pasted acquire/try/finally blocks are gone. |
| `packages/contracts/src/chat.ts` | `ChatSessionOperationKindSchema` gains `'condense'`. |

**Dashboard — chat session runtime**

| File | Responsibility after this plan |
|---|---|
| `dashboard/src/lib/chat-session-runtime-store.ts` | `ChatSessionRuntime`, `ChatSessionActivity`, `ChatSessionRuntimeTransition` (declared unions), a pure `applyTransition(runtime, transition)`, and a store with exactly one copy-on-write path (`apply`). |
| `dashboard/src/lib/chat-stream-transitions.ts` | **New.** `toRuntimeTransitions(...)`: pure async generator turning `ChatStreamEvent`s into `ChatSessionRuntimeTransition`s. No callbacks. |
| `dashboard/src/lib/chat-composer-inputs.ts` | **New.** `parsePlanMaxTurnsOverride`, `resolveRepoRoot`, `requireSelectedSession` — pure input helpers moved out of the deleted hook. |
| `dashboard/src/hooks/useChatSessions.ts` | Owns the store *and* the send actions (`sendMessage`, `sendPlan`, `sendRepoSearch`). Single `setRuntimeStore((prev) => prev.apply(transition))` site. |
| `dashboard/src/hooks/useChatComposer.ts` | **Deleted.** |
| `dashboard/src/hooks/useChatController.ts` | Wires `chatSessionsHook` straight into `ChatTabProps`. No `runtimes` object literal. |
| `dashboard/src/lib/chat-session-state.ts` | `deriveSessionIndicator` / `isSessionBusy` typed on `ChatSessionRuntime` directly. `ChatSessionRuntimeView` alias deleted. |

---

## Task 1: Stop `startOrAdvance` clobbering captured metadata with nulls

The advance branch overwrites `rawInputCharacterCount` / `promptCharacterCount` / `promptTokenCount` / `chunk*` unconditionally. The `buildActiveRunState` it replaced only wrote non-null values. A multi-step run whose second status POST omits a field silently loses the value captured on step 1, so `copyRunStateMetadata` back-fills nothing and the run log loses prompt sizing.

**Files:**
- Modify: `src/status-server/status-run-registry.ts:124-135`
- Test: `tests/status-run-registry.test.ts`

- [x] **Step 1: Write the failing test**

Append to `tests/status-run-registry.test.ts`:

```ts
function buildSparseStart(requestId: string, nowMs: number) {
  const metadata = parseStatusMetadata(JSON.stringify({ requestId }));
  return buildStatusRunStartInput(
    requestId,
    'C:/runtime/status.txt',
    metadata,
    'chat',
    null,
    nowMs,
  );
}

test('advancing with sparse metadata preserves values captured on the first step', () => {
  const registry = new StatusRunRegistry();
  registry.startOrAdvance(buildStart('request-a', 1_000));
  const advanced = registry.startOrAdvance(buildSparseStart('request-a', 2_000));
  if (advanced.kind !== 'advanced') {
    throw new Error(`Expected advanced result, received ${advanced.kind}.`);
  }
  assert.equal(advanced.run.stepCount, 2);
  assert.equal(advanced.run.currentRequestStartedAt, 2_000);
  assert.equal(advanced.run.rawInputCharacterCount, 10);
  assert.equal(advanced.run.promptCharacterCount, 20);
  assert.equal(advanced.run.promptTokenCount, 5);
});

test('advancing with fresh prompt metadata overwrites the previous step values', () => {
  const registry = new StatusRunRegistry();
  registry.startOrAdvance(buildStart('request-a', 1_000));
  const secondMetadata = parseStatusMetadata(JSON.stringify({
    requestId: 'request-a',
    rawInputCharacterCount: 99,
    promptCharacterCount: 200,
    promptTokenCount: 50,
  }));
  const advanced = registry.startOrAdvance(buildStatusRunStartInput(
    'request-a',
    'C:/runtime/status.txt',
    secondMetadata,
    'chat',
    null,
    2_000,
  ));
  if (advanced.kind !== 'advanced') {
    throw new Error(`Expected advanced result, received ${advanced.kind}.`);
  }
  assert.equal(advanced.run.rawInputCharacterCount, 10);
  assert.equal(advanced.run.promptCharacterCount, 200);
  assert.equal(advanced.run.promptTokenCount, 50);
});
```

Note the asymmetry, which mirrors the pre-branch behaviour exactly: `rawInputCharacterCount` is captured once and only back-filled while it is still `null`; the other fields overwrite whenever the new value is non-null.

- [x] **Step 2: Run test to verify it fails**

Run: `npx tsx --test .\tests\status-run-registry.test.ts`
Expected: FAIL — `advancing with sparse metadata...` reports `Expected values to be strictly equal: null !== 10`.

- [x] **Step 3: Restore the null guards**

In `src/status-server/status-run-registry.ts`, replace the body of the `if (existing)` branch inside `startOrAdvance`:

```ts
    const existing = this.activeRuns.get(input.requestId) ?? null;
    if (existing) {
      existing.stepCount += 1;
      existing.currentRequestStartedAt = input.nowMs;
      if (existing.rawInputCharacterCount === null && input.rawInputCharacterCount !== null) {
        existing.rawInputCharacterCount = input.rawInputCharacterCount;
      }
      if (input.promptCharacterCount !== null) existing.promptCharacterCount = input.promptCharacterCount;
      if (input.promptTokenCount !== null) existing.promptTokenCount = input.promptTokenCount;
      if (input.chunkIndex !== null) existing.chunkIndex = input.chunkIndex;
      if (input.chunkTotal !== null) existing.chunkTotal = input.chunkTotal;
      if (input.chunkPath !== null) existing.chunkPath = input.chunkPath;
      if (input.managedLlamaSpeculativeSnapshot !== null) {
        existing.managedLlamaSpeculativeSnapshot = input.managedLlamaSpeculativeSnapshot;
      }
      return createAdvancedResult(existing);
    }
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test .\tests\status-run-registry.test.ts`
Expected: PASS, all tests including the two new ones.

Run: `npx tsx --test .\tests\parallel-status-server.test.ts`
Expected: PASS (no regression in the end-to-end parallel coverage).

- [x] **Step 5: Commit**

```bash
git add tests/status-run-registry.test.ts src/status-server/status-run-registry.ts
git commit -m "fix: preserve captured run metadata when a status run advances"
```

---

## Task 2: Declare `status-run-registry` types directly instead of deriving them from factories

Twelve one-line `createXResult` factories exist only so the result unions can be spelled `ReturnType<typeof …>`. `resolveTerminalRun` takes a `nowMs` it never reads. Two `/* c8 ignore next */` markers sit on an import line and a closing brace, where they suppress nothing — the file is already covered by `tests/status-run-registry.test.ts`.

**Files:**
- Modify: `src/status-server/status-run-registry.ts` (whole file)
- Modify: `src/status-server/routes/core.ts:120` (the `StatusRunState` alias), `:600` (`resolveTerminalRun` call), `:1385` (`resolveTerminalRun` call)
- Test: `tests/status-run-registry.test.ts`

- [x] **Step 1: Write the failing test**

First replace the existing import block at the top of `tests/status-run-registry.test.ts` with:

```ts
import {
  buildStatusRunStartInput,
  StatusRunRegistry,
  TERMINAL_SNAPSHOT_RETENTION_MS,
  COMPLETED_REQUEST_RETENTION_MS,
  type ActiveRunState,
  type StatusRunStartResult,
} from '../src/status-server/status-run-registry.js';
```

Then append (this pins the exported type and the new one-argument signature):

```ts
function requireAdvanced(result: StatusRunStartResult): ActiveRunState {
  if (result.kind !== 'advanced') {
    throw new Error(`Expected advanced result, received ${result.kind}.`);
  }
  return result.run;
}

test('resolveTerminalRun resolves from the request id alone', () => {
  const registry = new StatusRunRegistry();
  registry.startOrAdvance(buildStart('request-a', 1_000));
  const resolution = registry.resolveTerminalRun('request-a');
  assert.equal(resolution.kind, 'active');
});

test('exported ActiveRunState describes the advanced run', () => {
  const registry = new StatusRunRegistry();
  registry.startOrAdvance(buildStart('request-a', 1_000));
  const run = requireAdvanced(registry.startOrAdvance(buildStart('request-a', 2_000)));
  assert.equal(run.requestId, 'request-a');
  assert.equal(run.statusPath, 'C:/runtime/status.txt');
  assert.equal(run.taskKind, 'chat');
  assert.equal(run.outputTokensTotal, 0);
});
```

Update the three existing `resolveTerminalRun` call sites in this test file to drop their second argument:
- `registry.resolveTerminalRun('request-a', 2_000)` → `registry.resolveTerminalRun('request-a')`
- `registry.resolveTerminalRun('unknown-id', 1_000)` → `registry.resolveTerminalRun('unknown-id')`
- `registry.resolveTerminalRun('request-a', 4_000)` → `registry.resolveTerminalRun('request-a')`

- [x] **Step 2: Run test to verify it fails**

Run: `npx tsx --test .\tests\status-run-registry.test.ts`
Expected: FAIL — `ActiveRunState` is not exported, and `resolveTerminalRun` still requires two arguments.

- [x] **Step 3: Rewrite the type layer**

Replace `src/status-server/status-run-registry.ts` lines 1 through 95 (from the `/* c8 ignore next */` on line 1 down to and including `export type ExpiredStatusRun = ...`) with:

```ts
import type { ActiveStatusRun } from '@siftkit/contracts';
import type { ManagedLlamaSpeculativeMetricsSnapshot } from './managed-llama.js';
import type { TaskKind } from './metrics.js';
import type { StatusMetadata } from './status-file.js';

export const TERMINAL_SNAPSHOT_RETENTION_MS = 300_000;
export const COMPLETED_REQUEST_RETENTION_MS = 900_000;

export type CompletedStatusTerminalState = Exclude<StatusMetadata['terminalState'], null>;

export type StatusRunStartInput = {
  requestId: string;
  statusPath: string;
  taskKind: TaskKind | null;
  nowMs: number;
  rawInputCharacterCount: number | null;
  promptCharacterCount: number | null;
  promptTokenCount: number | null;
  chunkIndex: number | null;
  chunkTotal: number | null;
  chunkPath: string | null;
  managedLlamaSpeculativeSnapshot: ManagedLlamaSpeculativeMetricsSnapshot | null;
};

export type ActiveRunState = {
  requestId: string;
  statusPath: string;
  taskKind: TaskKind | null;
  overallStartedAt: number;
  currentRequestStartedAt: number;
  stepCount: number;
  rawInputCharacterCount: number | null;
  promptCharacterCount: number | null;
  promptTokenCount: number | null;
  outputTokensTotal: number;
  chunkIndex: number | null;
  chunkTotal: number | null;
  chunkPath: string | null;
  managedLlamaSpeculativeSnapshot: ManagedLlamaSpeculativeMetricsSnapshot | null;
};

export type TerminalRunState = {
  run: ActiveRunState | null;
  terminalState: CompletedStatusTerminalState;
  completedAtMs: number;
};

export type StatusRunStartResult =
  | { kind: 'started'; run: ActiveRunState }
  | { kind: 'advanced'; run: ActiveRunState }
  | { kind: 'late'; requestId: string };

export type StatusRunCompleteResult =
  | { kind: 'completed'; run: TerminalRunState }
  | { kind: 'completed-without-run'; run: TerminalRunState }
  | { kind: 'duplicate'; requestId: string };

export type StatusTerminalResolution =
  | { kind: 'active'; run: ActiveRunState }
  | { kind: 'awaiting'; run: TerminalRunState }
  | { kind: 'duplicate'; requestId: string }
  | { kind: 'unknown'; requestId: string };

export type StatusTerminalFinalizeResult =
  | { kind: 'finalized'; requestId: string }
  | { kind: 'duplicate'; requestId: string }
  | { kind: 'unknown'; requestId: string };

export type ExpiredStatusRun = {
  requestId: string;
  phase: 'awaiting-terminal-metadata' | 'completed';
};

export function buildStatusRunStartInput(
  requestId: string,
  statusPath: string,
  metadata: StatusMetadata,
  taskKind: TaskKind | null,
  managedLlamaSpeculativeSnapshot: ManagedLlamaSpeculativeMetricsSnapshot | null,
  nowMs: number,
): StatusRunStartInput {
  return {
    requestId,
    statusPath,
    taskKind,
    nowMs,
    rawInputCharacterCount: metadata.rawInputCharacterCount,
    promptCharacterCount: metadata.promptCharacterCount,
    promptTokenCount: metadata.promptTokenCount,
    chunkIndex: metadata.chunkIndex,
    chunkTotal: metadata.chunkTotal,
    chunkPath: metadata.chunkPath,
    managedLlamaSpeculativeSnapshot,
  };
}

function createActiveRunState(input: StatusRunStartInput): ActiveRunState {
  return {
    requestId: input.requestId,
    statusPath: input.statusPath,
    taskKind: input.taskKind,
    overallStartedAt: input.nowMs,
    currentRequestStartedAt: input.nowMs,
    stepCount: 1,
    rawInputCharacterCount: input.rawInputCharacterCount,
    promptCharacterCount: input.promptCharacterCount,
    promptTokenCount: input.promptTokenCount,
    outputTokensTotal: 0,
    chunkIndex: input.chunkIndex,
    chunkTotal: input.chunkTotal,
    chunkPath: input.chunkPath,
    managedLlamaSpeculativeSnapshot: input.managedLlamaSpeculativeSnapshot,
  };
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

function toActiveStatusRun(run: ActiveRunState): ActiveStatusRun {
  return {
    requestId: run.requestId,
    statusPath: run.statusPath,
    taskKind: run.taskKind,
    startedAtUtc: formatTimestamp(run.overallStartedAt),
    currentStepStartedAtUtc: formatTimestamp(run.currentRequestStartedAt),
    stepCount: run.stepCount,
    chunkIndex: run.chunkIndex,
    chunkTotal: run.chunkTotal,
  };
}
```

Then delete the now-duplicated `formatTimestamp` / `toActiveStatusRun` definitions further down the file (the originals at old lines 97-112).

- [x] **Step 4: Replace every factory call with an object literal**

In the `StatusRunRegistry` class body, replace each `createX(...)` call with the literal it built:

| Old call | New expression |
|---|---|
| `createLateResult(input.requestId)` | `{ kind: 'late', requestId: input.requestId }` |
| `createAdvancedResult(existing)` | `{ kind: 'advanced', run: existing }` |
| `createStartedResult(run)` | `{ kind: 'started', run }` |
| `createDuplicateResult(requestId)` | `{ kind: 'duplicate', requestId }` |
| `createTerminalRunState(run, terminalState, nowMs)` | `{ run, terminalState, completedAtMs: nowMs }` |
| `createCompletedWithoutRunResult(terminalRun)` | `{ kind: 'completed-without-run', run: terminalRun }` |
| `createCompletedResult(terminalRun)` | `{ kind: 'completed', run: terminalRun }` |
| `createAwaitingTerminalResolution(awaiting)` | `{ kind: 'awaiting', run: awaiting }` |
| `createActiveTerminalResolution(active)` | `{ kind: 'active', run: active }` |
| `createUnknownResult(requestId)` | `{ kind: 'unknown', requestId }` |
| `createFinalizedResult(requestId)` | `{ kind: 'finalized', requestId }` |
| `createExpiredStatusRun(requestId, 'awaiting-terminal-metadata')` | `{ requestId, phase: 'awaiting-terminal-metadata' }` |
| `createExpiredStatusRun(requestId, 'completed')` | `{ requestId, phase: 'completed' }` |

Then delete all thirteen `createX` function declarations (old lines 56-74).

Change the `resolveTerminalRun` signature to drop the unused parameter:

```ts
  resolveTerminalRun(requestId: string): StatusTerminalResolution {
```

Delete the `/* c8 ignore next */` on the last line of the class body (old line 224).

Simplify `getActiveRuns` — the intermediate array push loop is redundant:

```ts
  getActiveRuns(nowMs: number): ActiveStatusRun[] {
    this.pruneExpired(nowMs);
    const runs = [...this.activeRuns.values()];
    runs.sort((a, b) => {
      const timeDiff = a.overallStartedAt - b.overallStartedAt;
      if (timeDiff !== 0) return timeDiff;
      return a.requestId.localeCompare(b.requestId);
    });
    return runs.map(toActiveStatusRun);
  }
```

- [x] **Step 5: Update the two call sites in `routes/core.ts`**

Delete line 120:

```ts
type StatusRunState = Extract<StatusRunStartResult, { kind: 'started' }>['run'];
```

Replace the import block at lines 108-112 with:

```ts
import type { ActiveRunState } from '../status-run-registry.js';
import { buildStatusRunStartInput } from '../status-run-registry.js';
```

Replace every occurrence of the identifier `StatusRunState` in `routes/core.ts` with `ActiveRunState` (there are six: the `let runState` declaration in `processTerminalMetadataBody`, and the parameter types on `scheduleDeferredTerminalPost`, `finishDirectTerminalPost`, `applyRunStateToTerminalMetadata`, `copyRunStateMetadata`, and the speculative-metrics helper).

Drop the second argument from both `resolveTerminalRun` calls:
- in `processTerminalMetadataBody`: `ctx.statusRuns.resolveTerminalRun(requestId, item.capturedAtMs)` → `ctx.statusRuns.resolveTerminalRun(requestId)`
- in `finishRunState`: `this.ctx.statusRuns.resolveTerminalRun(requestId, Date.now())` → `this.ctx.statusRuns.resolveTerminalRun(requestId)`
- in `handleLateOrRunningPost`: `this.ctx.statusRuns.resolveTerminalRun(requestId, Date.now())` → `this.ctx.statusRuns.resolveTerminalRun(requestId)`

- [x] **Step 6: Run tests and typecheck to verify they pass**

Run: `npx tsx --test .\tests\status-run-registry.test.ts`
Expected: PASS.

Run: `npm run typecheck:test`
Expected: exits 0 with no output.

Run: `npx tsx --test .\tests\parallel-status-server.test.ts .\tests\dashboard-status-server.test.ts .\tests\runtime-status-server.test.ts`
Expected: PASS.

- [x] **Step 7: Verify no `c8 ignore` remains in the file**

Run: `npx rg "c8 ignore" src/status-server/status-run-registry.ts`
Expected: no output (exit code 1).

- [x] **Step 8: Commit**

```bash
git add src/status-server/status-run-registry.ts src/status-server/routes/core.ts tests/status-run-registry.test.ts
git commit -m "refactor: declare status run registry result types directly"
```

---

## Task 3: Declare `chat-session-operation-registry` types directly

Same pattern: two factories exist only to feed `ReturnType<typeof …>`, `ChatSessionOperationLease` is a pure alias of `ChatSessionOperation`, and three `/* c8 ignore next */` markers sit on import lines and a closing brace despite the file being fully covered by `tests/chat-session-operation-registry.test.ts`.

**Files:**
- Modify: `src/status-server/chat-session-operation-registry.ts` (whole file)
- Modify: `tests/chat-session-operation-registry.test.ts:4-15`
- Modify: `src/status-server/routes/chat.ts:102` (import)

- [x] **Step 1: Write the failing test**

Replace the import block and helper at the top of `tests/chat-session-operation-registry.test.ts` (lines 4-15) with:

```ts
import {
  ChatSessionOperationRegistry,
  type ChatSessionOperation,
  type ChatSessionOperationAcquireResult,
} from '../src/status-server/chat-session-operation-registry.js';

function requireAcquired(result: ChatSessionOperationAcquireResult): ChatSessionOperation {
  if (result.kind === 'conflict') {
    throw new Error(`Expected acquired lease, active session was ${result.active.sessionId}.`);
  }
  return result.lease;
}
```

- [x] **Step 2: Run the guard to verify the alias is still present**

Run: `npx rg "ChatSessionOperationLease" src/ tests/`
Expected: two hits — the `export type ChatSessionOperationLease = ChatSessionOperation;` declaration and the `release(lease: ChatSessionOperationLease)` parameter. This is the condition Step 3 removes; the command must return no hits at Step 4.

- [x] **Step 3: Rewrite the file**

Replace the entire contents of `src/status-server/chat-session-operation-registry.ts` with:

```ts
import { randomUUID } from 'node:crypto';

import type { ChatSessionOperationKind } from '@siftkit/contracts';

export type ChatSessionOperation = {
  token: string;
  sessionId: string;
  operationKind: ChatSessionOperationKind;
  startedAtMs: number;
};

export type ChatSessionOperationAcquireResult =
  | { kind: 'acquired'; lease: ChatSessionOperation }
  | { kind: 'conflict'; active: ChatSessionOperation };

function requireSessionId(sessionId: string): void {
  if (!sessionId.trim()) {
    throw new Error('Chat session ID is required.');
  }
}

export class ChatSessionOperationRegistry {
  private readonly activeBySessionId = new Map<string, ChatSessionOperation>();

  acquire(
    sessionId: string,
    operationKind: ChatSessionOperationKind,
    nowMs: number,
  ): ChatSessionOperationAcquireResult {
    requireSessionId(sessionId);
    const active = this.activeBySessionId.get(sessionId) ?? null;
    if (active !== null) {
      return { kind: 'conflict', active };
    }
    const lease: ChatSessionOperation = {
      token: randomUUID(),
      sessionId,
      operationKind,
      startedAtMs: nowMs,
    };
    this.activeBySessionId.set(sessionId, lease);
    return { kind: 'acquired', lease };
  }

  release(lease: ChatSessionOperation): boolean {
    const active = this.activeBySessionId.get(lease.sessionId) ?? null;
    if (active === null || active.token !== lease.token) {
      return false;
    }
    this.activeBySessionId.delete(lease.sessionId);
    return true;
  }

  getActiveOperation(sessionId: string): ChatSessionOperation | null {
    requireSessionId(sessionId);
    return this.activeBySessionId.get(sessionId) ?? null;
  }

  getActiveCount(): number {
    return this.activeBySessionId.size;
  }
}
```

- [x] **Step 4: Run tests and typecheck to verify they pass**

Run: `npx tsx --test .\tests\chat-session-operation-registry.test.ts`
Expected: PASS (all 5 tests).

Run: `npm run typecheck:test`
Expected: exits 0 with no output. If it reports `ChatSessionOperationLease` is missing, replace that import with `ChatSessionOperation` at the reported location.

Run: `npx rg "ChatSessionOperationLease|c8 ignore" src/`
Expected: no output (exit code 1).

- [x] **Step 5: Commit**

```bash
git add src/status-server/chat-session-operation-registry.ts tests/chat-session-operation-registry.test.ts
git commit -m "refactor: declare chat session operation registry types directly"
```

---

## Task 4: Record the real model and backend on status run logs

`persistStatusRunLog` writes `model: null, backend: null` and builds its title with an inline `${taskKind ?? 'status'}` template, while `resolveStatusRunLogIdentity` right above it already owns the `taskKind → run log` mapping (including the `'unknown'` / `'other'` fallbacks the `'status'` fallback belongs beside). The active preset is the source of truth for model and backend and is reachable from `ctx.configPath`.

`repoRoot`, `promptEvalDurationMs`, `generationDurationMs`, `requestJson` and `sourcePathsJson: '[]'` stay as they are — a generic status run genuinely has no repo root, and `sourcePathsJson: '[]'` matches the two other `upsertRunLog` call sites in the same file.

**Files:**
- Modify: `src/status-server/routes/core.ts:342-401`, `:491`
- Test: `tests/parallel-status-server.test.ts`

- [x] **Step 1: Write the failing test**

Append to `tests/parallel-status-server.test.ts`, reusing that file's existing `DashboardTestServer` fixture and its `postRunning` / `postCompleted` / `postTerminalMetadata` helpers:

```ts
function readActivePresetIdentity(): { model: string | null; backend: string } {
  const preset = getActiveModelPreset(readConfig(getConfigPath()));
  return { model: preset.Model, backend: preset.Backend };
}

test('completed status run logs record the active preset model, backend, and title', async () => {
  const server = await DashboardTestServer.start('siftkit-parallel-status-');
  try {
    await postRunning(server.baseUrl, 'identity-a');
    await postCompleted(server.baseUrl, 'identity-a');
    await postTerminalMetadata(server.baseUrl, 'identity-a');
    await server.readSettledMetrics(1);

    const expected = readActivePresetIdentity();
    const logs = queryDashboardRunsFromDb(getRuntimeDatabase());
    const matching = logs.filter((log) => log.id === 'identity-a');
    assert.equal(matching.length, 1, 'expected one persisted log for identity-a');
    assert.equal(matching[0]?.backend, expected.backend);
    assert.equal(matching[0]?.model, expected.model);
    assert.equal(matching[0]?.title, 'chat identity-a');
  } finally {
    await server.close();
  }
});

test('a status run with no task kind is titled from the status fallback', async () => {
  const server = await DashboardTestServer.start('siftkit-parallel-status-');
  try {
    await requestJson(`${server.baseUrl}/status`, {
      method: 'POST',
      body: JSON.stringify({ running: true, requestId: 'identity-b' }),
    });
    await postCompleted(server.baseUrl, 'identity-b');
    await requestJson(`${server.baseUrl}/status/terminal-metadata`, {
      method: 'POST',
      body: JSON.stringify({ running: false, requestId: 'identity-b', terminalState: 'completed', outputTokens: 1 }),
    });
    await server.readSettledMetrics(1);

    const logs = queryDashboardRunsFromDb(getRuntimeDatabase());
    const matching = logs.filter((log) => log.id === 'identity-b');
    assert.equal(matching.length, 1, 'expected one persisted log for identity-b');
    assert.equal(matching[0]?.title, 'status identity-b');
  } finally {
    await server.close();
  }
});
```

Add to that file's imports:

```ts
import { getActiveModelPreset, readConfig } from '../src/status-server/config-store.js';
import { getConfigPath } from '../src/config/index.js';
```

Confirm `server.close()` matches the fixture's real teardown method name used by the file's other tests before running.

- [x] **Step 2: Run test to verify it fails**

Run: `npx tsx --test .\tests\parallel-status-server.test.ts`
Expected: FAIL — `backend` is `null`, not the active preset backend.

- [x] **Step 3: Move the title into the identity resolver and read the active preset**

In `src/status-server/routes/core.ts`, replace `resolveStatusRunLogIdentity` and `persistStatusRunLog` with:

```ts
function resolveStatusRunLogIdentity(taskKind: TaskKind | null): {
  runKind: RunLogKind;
  runGroup: RunLogGroup;
  titlePrefix: string;
} {
  if (taskKind === 'summary') {
    return { runKind: 'summary_request', runGroup: 'summary', titlePrefix: 'summary' };
  }
  if (taskKind === 'plan') {
    return { runKind: 'plan', runGroup: 'planner', titlePrefix: 'plan' };
  }
  if (taskKind === 'repo-search') {
    return { runKind: 'repo_search', runGroup: 'repo_search', titlePrefix: 'repo-search' };
  }
  if (taskKind === 'chat') {
    return { runKind: 'chat', runGroup: 'chat', titlePrefix: 'chat' };
  }
  return { runKind: 'unknown', runGroup: 'other', titlePrefix: 'status' };
}

function persistStatusRunLog(
  ctx: ServerContext,
  job: DeferredTerminalMetadataJob,
  taskKind: TaskKind | null,
): void {
  const terminalState = job.metadata.terminalState;
  if (terminalState !== 'completed' && terminalState !== 'failed') {
    return;
  }
  const identity = resolveStatusRunLogIdentity(taskKind);
  const activePreset = getActiveModelPreset(readConfig(ctx.configPath));
  upsertRunLog(getRuntimeDatabase(), {
    runId: job.requestId,
    requestId: job.requestId,
    runKind: identity.runKind,
    runGroup: identity.runGroup,
    terminalState,
    startedAtUtc: job.startedAtUtc,
    finishedAtUtc: job.finishedAtUtc,
    title: `${identity.titlePrefix} ${job.requestId}`,
    model: activePreset.Model,
    backend: activePreset.Backend,
    repoRoot: null,
    inputTokens: job.metadata.inputTokens,
    outputTokens: job.metadata.totalOutputTokens ?? job.metadata.outputTokens,
    thinkingTokens: job.metadata.thinkingTokens,
    toolTokens: job.metadata.toolTokens,
    promptCacheTokens: job.metadata.promptCacheTokens,
    promptEvalTokens: job.metadata.promptEvalTokens,
    promptEvalDurationMs: null,
    generationDurationMs: null,
    speculativeAcceptedTokens: job.metadata.speculativeAcceptedTokens,
    speculativeGeneratedTokens: job.metadata.speculativeGeneratedTokens,
    durationMs: job.totalElapsedMs ?? job.metadata.requestDurationMs,
    providerDurationMs: job.metadata.providerDurationMs,
    wallDurationMs: job.metadata.wallDurationMs,
    requestJson: null,
    plannerDebugJson: null,
    failedRequestJson: null,
    abandonedRequestJson: null,
    repoSearchJson: null,
    repoSearchTranscriptJsonl: null,
    sourcePathsJson: '[]',
    flushedAtUtc: job.finishedAtUtc,
  });
}
```

`getActiveModelPreset` and `readConfig` are already imported in this file from `'../config-store.js'` — do not add new imports. `getActiveModelPreset` throws when the preset list is empty; that is intentional fail-loud behaviour, do not guard it.

Update the call site (old line 491) inside `applyDeferredTerminalMetadata`:

```ts
  persistStatusRunLog(ctx, job, taskKind);
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test .\tests\parallel-status-server.test.ts`
Expected: PASS, including both new tests.

Run: `npx tsx --test .\tests\dashboard-status-server.test.ts .\tests\runtime-status-server.test.ts .\tests\runtime-status-server.idle-summary.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/status-server/routes/core.ts tests/parallel-status-server.test.ts
git commit -m "feat: record active preset model and backend on status run logs"
```

---

## Task 5: Make the chat session lease structural via a base endpoint class

Six chat endpoints repeat the same session-lookup → body-parse → request-parse → acquire → `try`/`finally` sequence. Five of them have the identical acquire/`try`/`finally` block hand-pasted with the `try {` left at the wrong indentation and the body never re-indented; the sixth (`CondenseChatSessionEndpoint`) has no lease at all, so two concurrent condense calls can race on the same session file. Nothing forces a new endpoint to take a lease.

**Files:**
- Create: `src/status-server/routes/chat-session-operation-endpoint.ts`
- Modify: `packages/contracts/src/chat.ts:55`
- Modify: `src/status-server/routes/chat.ts` (six endpoint classes, the `rejectBusyChatSession` helper moves out)
- Test: `tests/dashboard-chat-concurrency.test.ts`, `tests/contracts-chat.test.ts`

- [x] **Step 1: Write the failing contract test**

In `tests/contracts-chat.test.ts`, add:

```ts
test('chat session operation kinds cover every leased chat endpoint', () => {
  assert.deepEqual(
    ChatSessionOperationKindSchema.options,
    ['message', 'plan', 'repo-search', 'condense'],
  );
});
```

Add `ChatSessionOperationKindSchema` to that file's import from `@siftkit/contracts` if it is not already imported.

- [x] **Step 2: Write the failing concurrency test**

Append to `tests/dashboard-chat-concurrency.test.ts`, reusing its existing `DashboardModelQueueHarness` exactly as the neighbouring `aborting one concurrent session releases only that session lease` test does:

```ts
test('condense is rejected while the same session is streaming and allowed once it settles', async () => {
  const harness = new DashboardModelQueueHarness('siftkit-chat-condense-', { exl3ActivePreset: true });
  await harness.start();
  try {
    const sessionA = await harness.createChatSession('A', 'model-a');
    const sessionB = await harness.createChatSession('B', 'model-a');
    const streamA = harness.startChatStream(sessionA, 'prompt-a');
    await harness.waitForActiveRequests('dashboard_chat_stream', 1);

    const busyCondense = await requestJson(
      `${harness.getBaseUrl()}/dashboard/chat/sessions/${sessionA}/condense`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    assert.equal(busyCondense.statusCode, 409);
    assert.equal(asObject(busyCondense.body).operationKind, 'message');

    const otherCondense = await requestJson(
      `${harness.getBaseUrl()}/dashboard/chat/sessions/${sessionB}/condense`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    assert.equal(otherCondense.statusCode, 200);

    harness.releaseChatResponse('answer-a');
    await streamA;

    const settledCondense = await requestJson(
      `${harness.getBaseUrl()}/dashboard/chat/sessions/${sessionA}/condense`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    assert.equal(settledCondense.statusCode, 200);
  } finally {
    await harness.close();
  }
});
```

This proves three things at once: condense now takes the lease, the lease is per-session (B is unaffected), and it is released so a later condense succeeds. There is no test for "two condense calls race each other" because condense is synchronous and cannot be held open — the lease behaviour it would prove is already covered above.

- [x] **Step 3: Run tests to verify they fail**

Run: `npx tsx --test .\tests\contracts-chat.test.ts .\tests\dashboard-chat-concurrency.test.ts`
Expected: FAIL — the enum has three options, not four, and the busy condense returns 200 instead of 409.

- [x] **Step 4: Add `condense` to the contract**

In `packages/contracts/src/chat.ts`:

```ts
export const ChatSessionOperationKindSchema = z.enum(['message', 'plan', 'repo-search', 'condense']);
```

- [x] **Step 5: Create the base endpoint**

Create `src/status-server/routes/chat-session-operation-endpoint.ts`:

```ts
import { existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ChatSessionOperationKind } from '@siftkit/contracts';

import { toError } from '../../lib/errors.js';
import type { JsonObject } from '../../lib/json-types.js';
import type { ChatSession } from '../../state/chat-sessions.js';
import { getRuntimeRoot } from '../../state/runtime-root.js';
import {
  getChatSessionPath,
  readChatSessionFromPath,
} from '../../state/chat-sessions.js';
import {
  parseChatMessageRequest,
  parseChatRepoRequest,
  type ChatMessageRequest,
} from '../chat-route-request-normalizers.js';
import type { ChatSessionOperation } from '../chat-session-operation-registry.js';
import { parseJsonBody, readBody, sendBodyReadError, sendJson } from '../http-utils.js';
import { serverLogger } from '../server-logger.js';
import type { ServerContext } from '../server-types.js';
import { type RouteEndpoint, type RouteMatch } from '../route-table.js';

export type ResolvedChatRepoRequest = {
  content: string;
  repoRoot: string;
};

export type ChatSessionOperationRequest<TParsed> = {
  sessionId: string;
  sessionPath: string;
  session: ChatSession;
  parsedBody: JsonObject;
  value: TParsed;
};

function readChatSessionIdFromMatch(routeMatch: RouteMatch): string {
  const [rawSessionId] = routeMatch.captures;
  if (!rawSessionId) {
    throw new Error(`Chat route ${routeMatch.pathname} did not capture a session id.`);
  }
  return decodeURIComponent(rawSessionId);
}

function rejectBusyChatSession(
  ctx: ServerContext,
  res: ServerResponse,
  sessionId: string,
  requestedOperationKind: ChatSessionOperationKind,
  active: ChatSessionOperation,
): void {
  serverLogger.dim({
    scope: 'chat',
    id: sessionId,
    event: 'session_busy_rejected',
    fields: `requested=${requestedOperationKind} active=${active.operationKind} `
      + `active_duration_ms=${Date.now() - active.startedAtMs} active_sessions=${ctx.chatSessionOperations.getActiveCount()}`,
  });
  sendJson(res, 409, {
    error: 'Chat session already has an active operation.',
    sessionId,
    operationKind: active.operationKind,
  });
}

/** Sends a 400 and returns null when the body is not a valid chat message request. */
export function parseChatMessageOperationRequest(
  res: ServerResponse,
  parsedBody: JsonObject,
): ChatMessageRequest | null {
  const messageRequest = parseChatMessageRequest(parsedBody);
  if (!messageRequest) {
    sendJson(res, 400, { error: 'Expected content.' });
    return null;
  }
  return messageRequest;
}

/** Sends a 400 and returns null when the body is not a valid repo operation request. */
export function parseChatRepoOperationRequest(
  res: ServerResponse,
  session: ChatSession,
  parsedBody: JsonObject,
): ResolvedChatRepoRequest | null {
  const repoRequest = parseChatRepoRequest(parsedBody);
  if (!repoRequest) {
    sendJson(res, 400, { error: 'Expected content.' });
    return null;
  }
  const repoRoot = repoRequest.repoRoot?.trim() || session.planRepoRoot || '';
  if (!repoRoot || !existsSync(repoRoot) || !statSync(repoRoot).isDirectory()) {
    sendJson(res, 400, { error: 'Expected existing repoRoot directory.' });
    return null;
  }
  return { content: repoRequest.content, repoRoot };
}

/**
 * Owns session lookup, body parsing, and the per-session operation lease so no chat
 * endpoint can run concurrently with another operation on the same session.
 */
export abstract class ChatSessionOperationEndpoint<TParsed> implements RouteEndpoint {
  protected abstract readonly operationKind: ChatSessionOperationKind;

  /** Returns null after sending its own 4xx response. */
  protected abstract parseRequest(
    res: ServerResponse,
    session: ChatSession,
    parsedBody: JsonObject,
  ): TParsed | null;

  protected abstract run(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    request: ChatSessionOperationRequest<TParsed>,
  ): Promise<void>;

  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    routeMatch: RouteMatch,
  ): Promise<void> {
    const sessionId = readChatSessionIdFromMatch(routeMatch);
    const sessionPath = getChatSessionPath(getRuntimeRoot(), sessionId);
    const session = readChatSessionFromPath(sessionPath);
    if (!session) {
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    let parsedBody: JsonObject;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch (error) {
      sendBodyReadError(res, toError(error), { error: 'Expected valid JSON object.' });
      return;
    }
    const value = this.parseRequest(res, session, parsedBody);
    if (value === null) {
      return;
    }
    const acquisition = ctx.chatSessionOperations.acquire(sessionId, this.operationKind, Date.now());
    if (acquisition.kind === 'conflict') {
      rejectBusyChatSession(ctx, res, sessionId, this.operationKind, acquisition.active);
      return;
    }
    try {
      await this.run(ctx, req, res, { sessionId, sessionPath, session, parsedBody, value });
    } finally {
      ctx.chatSessionOperations.release(acquisition.lease);
    }
  }
}
```

Verify the import specifiers for `ChatSession`, `getChatSessionPath`, `readChatSessionFromPath`, `getRuntimeRoot`, and `JsonObject` against how `src/status-server/routes/chat.ts` currently imports them, and match them exactly. Do not invent module paths.

- [x] **Step 6: Convert `CondenseChatSessionEndpoint` (the smallest, do it first)**

`null` is the base class's "already responded" sentinel, so an endpoint with no request body must return a non-null unit value from `parseRequest`. Replace the class in `src/status-server/routes/chat.ts` with:

```ts
class CondenseChatSessionEndpoint extends ChatSessionOperationEndpoint<'condense'> {
  protected readonly operationKind = 'condense' as const;

  protected parseRequest(): 'condense' {
    return 'condense';
  }

  protected async run(
    ctx: ServerContext,
    _req: IncomingMessage,
    res: ServerResponse,
    request: ChatSessionOperationRequest<'condense'>,
  ): Promise<void> {
    const updatedSession = condenseChatSession(getRuntimeRoot(), request.session);
    sendJson(res, 200, buildChatSessionResponse(readConfig(ctx.configPath), updatedSession));
  }
}
```

- [x] **Step 7: Convert `CreateChatMessageEndpoint`**

Replace the whole class with the form below. The `run` body is the existing body from `const modelRequestLock = ...` through the inner `finally { releaseModelRequest(...) }`, moved verbatim and re-indented one level; the outer lease `try`/`finally` and the acquire block are gone because the base class owns them.

```ts
class CreateChatMessageEndpoint extends ChatSessionOperationEndpoint<ChatMessageRequest> {
  protected readonly operationKind = 'message' as const;

  protected parseRequest(
    res: ServerResponse,
    _session: ChatSession,
    parsedBody: JsonObject,
  ): ChatMessageRequest | null {
    return parseChatMessageOperationRequest(res, parsedBody);
  }

  protected async run(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    request: ChatSessionOperationRequest<ChatMessageRequest>,
  ): Promise<void> {
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const messageRequest = request.value;
    const providedAssistantContent = messageRequest.assistantContent || '';
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_chat', req, res);
    if (!modelRequestLock) {
      return;
    }
    const activeSession = readChatSessionFromPath(request.sessionPath);
    if (!activeSession) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    if (!providedAssistantContent) {
      try {
        await ensureActivePresetReadyForModelRequest(ctx);
      } catch (error) {
        releaseModelRequest(ctx, modelRequestLock.token);
        sendJson(res, 503, { error: error instanceof Error ? error.message : String(error) });
        return;
      }
    }
    try {
      const config = readConfig(configPath);
      let selected: SelectedChatOperationPreset;
      try {
        selected = new ChatOperationPresetSelector(config.Presets).select(activeSession, 'chat');
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        return;
      }
      assertPresetAcceptsImages(getActiveModelPreset(config), messageRequest.images);
      const turn = new ChatMessageTurn(
        ctx,
        res,
        runtimeRoot,
        selected.session,
        config,
        selected.preset,
        messageRequest.content,
        messageRequest.images,
        readRouteStringArray(new JsonRecordReader(request.parsedBody), 'mockResponses'),
      );
      if (providedAssistantContent) {
        await turn.runProvidedAssistantTurn(providedAssistantContent);
      } else {
        await turn.runEngineTurn();
      }
    } finally {
      releaseModelRequest(ctx, modelRequestLock.token);
    }
  }
}
```

- [x] **Step 8: Convert the remaining four endpoints the same way**

Apply the identical mechanical conversion to `StreamChatMessageEndpoint`, `CreateChatPlanEndpoint`, `StreamChatPlanEndpoint`, `CreateRepoSearchEndpoint`, and `StreamRepoSearchEndpoint`. For each:

1. Change `class X implements RouteEndpoint` to `class X extends ChatSessionOperationEndpoint<T>` where `T` is `ChatMessageRequest` for the two message endpoints and `ResolvedChatRepoRequest` for the four plan / repo-search endpoints.
2. Add `protected readonly operationKind = '<kind>' as const;` — `'message'` for the message endpoints, `'plan'` for the two plan endpoints, `'repo-search'` for the two repo-search endpoints.
3. Add `protected parseRequest(...)` delegating in one line to `parseChatMessageOperationRequest(res, parsedBody)` or `parseChatRepoOperationRequest(res, session, parsedBody)`.
4. Rename `handle` to `run`, change its fourth parameter to `request: ChatSessionOperationRequest<T>`.
5. **Delete** from the old body: the `pathname` / `sessionId` / `sessionPath` / `session` derivation, the 404 check, the `parseJsonBody` block, the `parseChatMessageRequest` / `parseChatRepoRequest` block, the `resolveChatRepoRoot` + `existsSync` / `statSync` repoRoot check, the `acquire` + `rejectBusyChatSession` block, the outer lease `try {` and its `finally { ctx.chatSessionOperations.release(...) }`, and the trailing bare `return;`.
6. **Keep** everything else verbatim, re-indented to sit directly inside `run`. Substitute `request.sessionPath` for `sessionPath`, `request.parsedBody` for `parsedBody`, `request.value` for the old `messageRequest` / `repoRequest` variable, and `request.value.repoRoot` for the old `resolvedRepoRoot`.

Delete from `chat.ts`: the local `rejectBusyChatSession` function (now in the base module), the `import type { ChatSessionOperation }` line, and the `ChatSessionOperationKind` entry in the `@siftkit/contracts` import if nothing else in the file uses it. Add the import of the base class and the two parse helpers from `'./chat-session-operation-endpoint.js'`.

Leave the `CHAT_ROUTES` table unchanged — the route definitions and regexes are already correct.

- [x] **Step 9: Run tests and typecheck to verify they pass**

Run: `npm run typecheck:test`
Expected: exits 0 with no output.

Run: `npx tsx --test .\tests\contracts-chat.test.ts .\tests\dashboard-chat-concurrency.test.ts`
Expected: PASS, including the two new condense tests.

Run: `npx tsx --test .\tests\dashboard-status-server.test.ts .\tests\parallel-status-server.test.ts`
Expected: PASS.

- [x] **Step 10: Verify the copy-paste is gone**

Run: `npx rg -c "chatSessionOperations.acquire" src/status-server/`
Expected: `src/status-server/routes/chat-session-operation-endpoint.ts:1` — exactly one occurrence, in the base class.

- [x] **Step 11: Commit**

```bash
git add src/status-server/routes/chat-session-operation-endpoint.ts src/status-server/routes/chat.ts packages/contracts/src/chat.ts tests/contracts-chat.test.ts tests/dashboard-chat-concurrency.test.ts
git commit -m "refactor: own the chat session operation lease in a base endpoint"
```

---

## Task 6: Collapse `ChatSessionRuntimeStore` onto a single transition entry point

Eleven of the store's methods repeat the same six-line lookup-throw-clone-set-return preamble; the string `ChatSessionRuntimeStore: unknown session` appears twelve times. `createChatSessionRuntime` declares eleven positional defaulted parameters but is only ever called with one argument. `cloneRuntime` restates the field list a third time. `ChatSessionActivity` is derived from two factory functions.

**Files:**
- Modify: `dashboard/src/lib/chat-session-runtime-store.ts` (whole file)
- Modify: `dashboard/src/hooks/useChatSessions.ts` (call sites)
- Test: `dashboard/tests/chat-session-runtime-store.test.ts`

- [x] **Step 1: Write the failing test**

Add to `dashboard/tests/chat-session-runtime-store.test.ts`:

```ts
test('apply routes every transition through one copy-on-write path', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('session-a')
    .ensureSession('session-b');
  const next = store
    .apply({ kind: 'begin', sessionId: 'session-a', operationKind: 'message' })
    .apply({ kind: 'draft', sessionId: 'session-a', draft: 'hello' })
    .apply({ kind: 'answer', sessionId: 'session-a', text: 'hi there' })
    .apply({ kind: 'warning', sessionId: 'session-a', text: 'careful' });

  assert.deepEqual(next.get('session-a').activity, { kind: 'active', operationKind: 'message' });
  assert.equal(next.get('session-a').draft, 'hello');
  assert.equal(next.get('session-a').liveMessages[0]?.content, 'hi there');
  assert.deepEqual(next.get('session-a').warnings, ['careful']);

  assert.deepEqual(store.get('session-a').activity, { kind: 'idle' });
  assert.equal(store.get('session-a').draft, '');
  assert.deepEqual(next.get('session-b'), store.get('session-b'));
});

test('apply creates a runtime for a session that has not been seeded', () => {
  const next = new ChatSessionRuntimeStore()
    .apply({ kind: 'draft', sessionId: 'fresh', draft: 'typed' });
  assert.equal(next.get('fresh').draft, 'typed');
  assert.deepEqual(next.get('fresh').activity, { kind: 'idle' });
});

test('get still throws for a session that was never touched', () => {
  assert.throws(
    () => new ChatSessionRuntimeStore().get('ghost'),
    /unknown session "ghost"/,
  );
});

test('plan input and image transitions replace only their own fields', () => {
  const next = new ChatSessionRuntimeStore()
    .apply({ kind: 'images', sessionId: 's', images: ['data:image/png;base64,AA'] })
    .apply({ kind: 'plan-inputs', sessionId: 's', planRepoRootInput: 'C:/repo', planMaxTurnsInput: '12' });
  assert.deepEqual(next.get('s').pendingImages, ['data:image/png;base64,AA']);
  assert.equal(next.get('s').planRepoRootInput, 'C:/repo');
  assert.equal(next.get('s').planMaxTurnsInput, '12');
  assert.equal(next.get('s').draft, '');
});
```

Then rewrite the file's existing tests to call `apply({ kind: ... })` instead of the removed named methods, keeping every existing assertion. The method-to-transition mapping is:

| Removed method | Transition |
|---|---|
| `begin(id, kind)` | `{ kind: 'begin', sessionId: id, operationKind: kind }` |
| `appendThinking(id, text)` | `{ kind: 'thinking', sessionId: id, text }` |
| `applyToolEvent(id, e)` | `{ kind: 'tool', sessionId: id, toolEvent: e }` |
| `applyAnswer(id, text)` | `{ kind: 'answer', sessionId: id, text }` |
| `applyWarning(id, text)` | `{ kind: 'warning', sessionId: id, text }` |
| `applyDone(id, response)` | `{ kind: 'done', sessionId: id, response }` |
| `applyFailure(id, message)` | `{ kind: 'failure', sessionId: id, message }` |
| `setContextUsage(id, usage)` | `{ kind: 'context-usage', sessionId: id, contextUsage: usage }` |
| `setDraft(id, draft)` | `{ kind: 'draft', sessionId: id, draft }` |
| `setImages(id, images)` | `{ kind: 'images', sessionId: id, images }` |
| `setPlanInputs(id, root, turns)` | `{ kind: 'plan-inputs', sessionId: id, planRepoRootInput: root, planMaxTurnsInput: turns }` |

`get`, `getAll`, `ensureSession`, and `removeSession` are unchanged.

- [x] **Step 2: Run test to verify it fails**

Run: `npx tsx --test .\dashboard\tests\chat-session-runtime-store.test.ts`
Expected: FAIL — `next.apply is not a function`.

- [x] **Step 3: Rewrite the store**

Replace the entire contents of `dashboard/src/lib/chat-session-runtime-store.ts` with:

```ts
import { appendLiveThinkingMessage } from './live-thinking-message';
import {
  buildAppendedLiveToolMessage,
  buildCompletedLiveToolMessage,
  createLiveMessage,
  upsertLiveMessageInto,
} from './chat-live-messages';
import type { ChatStreamToolEvent } from './chat-stream-parser';
import type { ChatMessage, ChatSessionResponse, ChatSessionOperationKind, ContextUsage } from '../types';

export type ChatSessionActivity =
  | { kind: 'idle' }
  | { kind: 'active'; operationKind: ChatSessionOperationKind };

export type ChatSessionRuntime = {
  sessionId: string;
  activity: ChatSessionActivity;
  liveMessages: ChatMessage[];
  error: string | null;
  warnings: string[];
  contextUsage: ContextUsage | null;
  liveToolPromptTokenCount: number | null;
  draft: string;
  pendingImages: string[];
  planRepoRootInput: string;
  planMaxTurnsInput: string;
};

export type ChatSessionRuntimeTransition =
  | { kind: 'begin'; sessionId: string; operationKind: ChatSessionOperationKind }
  | { kind: 'thinking'; sessionId: string; text: string }
  | { kind: 'tool'; sessionId: string; toolEvent: ChatStreamToolEvent }
  | { kind: 'answer'; sessionId: string; text: string }
  | { kind: 'warning'; sessionId: string; text: string }
  | { kind: 'done'; sessionId: string; response: ChatSessionResponse }
  | { kind: 'failure'; sessionId: string; message: string }
  | { kind: 'context-usage'; sessionId: string; contextUsage: ContextUsage }
  | { kind: 'draft'; sessionId: string; draft: string }
  | { kind: 'images'; sessionId: string; images: string[] }
  | { kind: 'plan-inputs'; sessionId: string; planRepoRootInput: string; planMaxTurnsInput: string };

function createChatSessionRuntime(sessionId: string): ChatSessionRuntime {
  return {
    sessionId,
    activity: { kind: 'idle' },
    liveMessages: [],
    error: null,
    warnings: [],
    contextUsage: null,
    liveToolPromptTokenCount: null,
    draft: '',
    pendingImages: [],
    planRepoRootInput: '',
    planMaxTurnsInput: '',
  };
}

function applyToolEvent(runtime: ChatSessionRuntime, toolEvent: ChatStreamToolEvent): ChatSessionRuntime {
  const toolMessage = toolEvent.kind === 'tool_start'
    ? buildAppendedLiveToolMessage(toolEvent)
    : buildCompletedLiveToolMessage(toolEvent);
  return {
    ...runtime,
    liveMessages: upsertLiveMessageInto(runtime.liveMessages, toolMessage),
    liveToolPromptTokenCount: typeof toolEvent.promptTokenCount === 'number'
      ? toolEvent.promptTokenCount
      : runtime.liveToolPromptTokenCount,
  };
}

function applyAnswer(runtime: ChatSessionRuntime, text: string): ChatSessionRuntime {
  const answerMessage = createLiveMessage('live-answer', 'assistant_answer', 'assistant', text);
  answerMessage.outputTokensEstimate = Math.max(1, Math.ceil(text.length / 4));
  return { ...runtime, liveMessages: upsertLiveMessageInto(runtime.liveMessages, answerMessage) };
}

function applyTransition(
  runtime: ChatSessionRuntime,
  transition: ChatSessionRuntimeTransition,
): ChatSessionRuntime {
  switch (transition.kind) {
    case 'begin':
      return { ...runtime, activity: { kind: 'active', operationKind: transition.operationKind } };
    case 'thinking':
      return {
        ...runtime,
        liveMessages: appendLiveThinkingMessage(runtime.liveMessages, transition.text, true),
      };
    case 'tool':
      return applyToolEvent(runtime, transition.toolEvent);
    case 'answer':
      return applyAnswer(runtime, transition.text);
    case 'warning':
      return { ...runtime, warnings: [...runtime.warnings, transition.text] };
    case 'done':
      return {
        ...runtime,
        activity: { kind: 'idle' },
        contextUsage: transition.response.contextUsage,
        liveMessages: [],
        error: null,
        draft: '',
        pendingImages: [],
      };
    case 'failure':
      return { ...runtime, activity: { kind: 'idle' }, error: transition.message, liveMessages: [] };
    case 'context-usage':
      return { ...runtime, contextUsage: transition.contextUsage };
    case 'draft':
      return { ...runtime, draft: transition.draft };
    case 'images':
      return { ...runtime, pendingImages: transition.images };
    case 'plan-inputs':
      return {
        ...runtime,
        planRepoRootInput: transition.planRepoRootInput,
        planMaxTurnsInput: transition.planMaxTurnsInput,
      };
  }
}

export class ChatSessionRuntimeStore {
  private readonly runtimesBySessionId: Map<string, ChatSessionRuntime>;

  constructor(runtimesBySessionId: Map<string, ChatSessionRuntime> = new Map()) {
    this.runtimesBySessionId = runtimesBySessionId;
  }

  /** Readers must name a session that exists; a miss is a bug, not a default. */
  get(sessionId: string): ChatSessionRuntime {
    const runtime = this.runtimesBySessionId.get(sessionId);
    if (!runtime) {
      throw new Error(`ChatSessionRuntimeStore: unknown session "${sessionId}"`);
    }
    return runtime;
  }

  getAll(): ChatSessionRuntime[] {
    return [...this.runtimesBySessionId.values()];
  }

  ensureSession(sessionId: string): ChatSessionRuntimeStore {
    if (this.runtimesBySessionId.has(sessionId)) {
      return this;
    }
    const next = new Map(this.runtimesBySessionId);
    next.set(sessionId, createChatSessionRuntime(sessionId));
    return new ChatSessionRuntimeStore(next);
  }

  /** The single copy-on-write path. Writers create the runtime if it is absent. */
  apply(transition: ChatSessionRuntimeTransition): ChatSessionRuntimeStore {
    const existing = this.runtimesBySessionId.get(transition.sessionId)
      ?? createChatSessionRuntime(transition.sessionId);
    const next = new Map(this.runtimesBySessionId);
    next.set(transition.sessionId, applyTransition(existing, transition));
    return new ChatSessionRuntimeStore(next);
  }

  removeSession(sessionId: string): ChatSessionRuntimeStore {
    const next = new Map(this.runtimesBySessionId);
    next.delete(sessionId);
    return new ChatSessionRuntimeStore(next);
  }
}
```

Two deliberate behaviour changes, both required by the findings:
- `apply` creates the runtime when absent instead of throwing; `get` keeps throwing. Writers create, readers must find.
- `applyDone` no longer takes `response.session.id` — it uses `transition.sessionId`, so a mismatched payload can no longer write to the wrong session. Task 7 turns that mismatch into an explicit failure.

- [x] **Step 4: Update the call sites in `useChatSessions.ts`**

Rewrite the eleven forwarders in `dashboard/src/hooks/useChatSessions.ts` to go through `apply`. For now keep their names and signatures — Task 7 deletes most of them:

```ts
  function recordSessionError(sessionId: string, error: Error): void {
    if (!sessionId) {
      return;
    }
    setRuntimeStore((prev) => prev.apply({ kind: 'failure', sessionId, message: error.message }));
  }
```

```ts
  function applySessionResponse(response: ChatSessionResponse): void {
    setSessions((previous) => upsertSession(previous, response.session));
    setRuntimeStore((previous) => previous.apply({
      kind: 'context-usage',
      sessionId: response.session.id,
      contextUsage: response.contextUsage,
    }));
  }
```

Apply the same substitution to `beginSessionOperation`, `appendSessionThinking`, `applySessionToolEvent`, `applySessionAnswer`, `applySessionWarning`, `completeSessionOperation`, `failSessionOperation`, `setSessionDraft`, `setSessionImages`, and `setSessionPlanInputs`, using the mapping table from Step 1. The `getChatSession` effect at line 103 becomes:

```ts
          setRuntimeStore((previous) => previous.apply({
            kind: 'context-usage',
            sessionId: response.session.id,
            contextUsage: response.contextUsage,
          }));
```

The two `ensureSession` loops (in the list effect and in `refreshSessions`) and the `removeSession` call in `deleteSession` are unchanged.

- [x] **Step 5: Run tests and typecheck to verify they pass**

Run: `npx tsx --test .\dashboard\tests\chat-session-runtime-store.test.ts`
Expected: PASS.

Run: `npm run typecheck:dashboard-test`
Expected: exits 0 with no output.

Run: `npm run test:dashboard`
Expected: PASS. `dashboard/tests/hooks/useChatComposer.test.tsx` will still pass here because `RuntimeRecorder` calls the store — update its `store = this.store.X(...)` lines to `store = this.store.apply({...})` if they fail, since Task 7 rewrites that file anyway.

- [x] **Step 6: Verify the duplication is gone**

Run: `npx rg -c "unknown session" dashboard/src/lib/chat-session-runtime-store.ts`
Expected: `1`.

- [x] **Step 7: Commit**

```bash
git add dashboard/src/lib/chat-session-runtime-store.ts dashboard/src/hooks/useChatSessions.ts dashboard/tests/chat-session-runtime-store.test.ts dashboard/tests/hooks/useChatComposer.test.tsx
git commit -m "refactor: route chat session runtime updates through one transition path"
```

---

## Task 7: Replace the `RuntimeActions` callback bag with a pure transition generator

`RuntimeActions` is a seven-function type built as an object literal of closures in `useChatController` and threaded through `useChatComposer` into `consumeChatStream` — dynamically-passed functions, with every target a one-line forwarder that adds no behaviour. Replacing it with an async generator that yields plain transition data removes the bag, the forwarders, and the whole `useChatComposer` hook, while keeping the stream logic testable as a pure function.

**Files:**
- Create: `dashboard/src/lib/chat-stream-transitions.ts`
- Create: `dashboard/src/lib/chat-composer-inputs.ts`
- Delete: `dashboard/src/hooks/useChatComposer.ts`
- Modify: `dashboard/src/hooks/useChatSessions.ts`, `dashboard/src/hooks/useChatController.ts`
- Test: rename `dashboard/tests/hooks/useChatComposer.test.tsx` → `dashboard/tests/chat-stream-transitions.test.ts`

- [x] **Step 1: Write the failing test**

Create `dashboard/tests/chat-stream-transitions.test.ts` with the content below. It keeps the existing out-of-order and premature-close coverage, expressed against the generator.

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { toRuntimeTransitions } from '../src/lib/chat-stream-transitions';
import { ChatSessionRuntimeStore } from '../src/lib/chat-session-runtime-store';
import type { ChatStreamEvent } from '../src/lib/chat-stream-parser';
import type { ChatSession, ChatSessionResponse } from '../src/types';

const SESSION: ChatSession = {
  id: 's1',
  title: 'Session',
  model: null,
  contextWindowTokens: 100,
  condensedSummary: '',
  createdAtUtc: '2026-06-03T12:00:00.000Z',
  updatedAtUtc: '2026-06-03T12:00:00.000Z',
  messages: [],
};

function response(sessionId: string): ChatSessionResponse {
  return {
    session: { ...SESSION, id: sessionId },
    contextUsage: {
      contextWindowTokens: 100,
      usedTokens: 0,
      chatUsedTokens: 0,
      thinkingUsedTokens: 0,
      toolUsedTokens: 0,
      totalUsedTokens: 0,
      remainingTokens: 100,
      warnThresholdTokens: 80,
      shouldCondense: false,
      estimatedTokenFallbackTokens: 0,
      providerOverheadTokens: 0,
    },
  };
}

class Gate {
  private releaseGate: (() => void) | null = null;
  private announceWaiting: (() => void) | null = null;
  readonly promise = new Promise<void>((resolve) => { this.releaseGate = resolve; });
  readonly waiting = new Promise<void>((resolve) => { this.announceWaiting = resolve; });

  markWaiting(): void {
    const announceWaiting = this.announceWaiting;
    if (!announceWaiting) {
      throw new Error('Gate already marked waiting');
    }
    this.announceWaiting = null;
    announceWaiting();
  }

  open(): void {
    const releaseGate = this.releaseGate;
    if (!releaseGate) {
      throw new Error('Gate already opened');
    }
    this.releaseGate = null;
    releaseGate();
  }
}

/** Mirrors how useChatSessions drains the generator into the store. */
class StoreDrain {
  store = new ChatSessionRuntimeStore().ensureSession('session-a').ensureSession('session-b');
  readonly completions: string[] = [];

  async drain(stream: AsyncGenerator<ChatStreamEvent>, sessionId: string, thinking: boolean): Promise<void> {
    for await (const transition of toRuntimeTransitions(sessionId, 'message', stream, thinking)) {
      this.store = this.store.apply(transition);
      if (transition.kind === 'done') {
        this.completions.push(transition.sessionId);
      }
    }
  }
}

async function* controlledStream(sessionId: string, gate: Gate): AsyncGenerator<ChatStreamEvent> {
  yield { kind: 'answer', text: `answer-${sessionId}` };
  gate.markWaiting();
  await gate.promise;
  yield { kind: 'done', payload: response(sessionId) };
}

async function* prematureStream(): AsyncGenerator<ChatStreamEvent> {
  yield { kind: 'answer', text: 'partial' };
}

async function* mismatchedStream(): AsyncGenerator<ChatStreamEvent> {
  yield { kind: 'done', payload: response('session-b') };
}

async function collect(stream: AsyncGenerator<ChatStreamEvent>, thinking: boolean): Promise<string[]> {
  const kinds: string[] = [];
  for await (const transition of toRuntimeTransitions('session-a', 'plan', stream, thinking)) {
    kinds.push(transition.kind);
  }
  return kinds;
}

test('the first transition begins the operation for the requested session', async () => {
  async function* empty(): AsyncGenerator<ChatStreamEvent> {
    yield { kind: 'done', payload: response('session-a') };
  }
  assert.deepEqual(await collect(empty(), true), ['begin', 'done']);
});

test('thinking events are dropped when thinking is disabled', async () => {
  async function* thinkingStream(): AsyncGenerator<ChatStreamEvent> {
    yield { kind: 'thinking', text: 'pondering' };
    yield { kind: 'done', payload: response('session-a') };
  }
  assert.deepEqual(await collect(thinkingStream(), false), ['begin', 'done']);
  assert.deepEqual(await collect(thinkingStream(), true), ['begin', 'thinking', 'done']);
});

test('two streams complete out of order without crossing session state', async () => {
  const drain = new StoreDrain();
  const gateA = new Gate();
  const gateB = new Gate();
  const runA = drain.drain(controlledStream('session-a', gateA), 'session-a', true);
  const runB = drain.drain(controlledStream('session-b', gateB), 'session-b', true);

  await Promise.all([gateA.waiting, gateB.waiting]);
  assert.equal(drain.store.get('session-a').activity.kind, 'active');
  assert.equal(drain.store.get('session-b').activity.kind, 'active');
  assert.equal(drain.store.get('session-a').liveMessages[0]?.content, 'answer-session-a');
  assert.equal(drain.store.get('session-b').liveMessages[0]?.content, 'answer-session-b');

  gateB.open();
  await runB;
  assert.deepEqual(drain.completions, ['session-b']);
  assert.equal(drain.store.get('session-a').activity.kind, 'active');
  assert.equal(drain.store.get('session-b').activity.kind, 'idle');

  gateA.open();
  await runA;
  assert.deepEqual(drain.completions, ['session-b', 'session-a']);
  assert.equal(drain.store.get('session-a').activity.kind, 'idle');
});

test('premature stream close fails only the initiating session and preserves its draft', async () => {
  const drain = new StoreDrain();
  drain.store = drain.store.apply({ kind: 'draft', sessionId: 'session-a', draft: 'retry me' });
  await drain.drain(prematureStream(), 'session-a', true);
  assert.equal(drain.store.get('session-a').error, 'Chat stream ended before the done event');
  assert.equal(drain.store.get('session-a').draft, 'retry me');
  assert.equal(drain.store.get('session-b').error, null);
});

test('a done payload for another session fails the initiating session', async () => {
  const drain = new StoreDrain();
  await drain.drain(mismatchedStream(), 'session-a', true);
  assert.match(drain.store.get('session-a').error ?? '', /session mismatch/);
  assert.equal(drain.store.get('session-b').activity.kind, 'idle');
  assert.deepEqual(drain.completions, []);
});
```

Also create `dashboard/tests/chat-composer-inputs.test.ts` holding the four pure-helper tests moved verbatim out of `useChatComposer.test.tsx` (`parsePlanMaxTurnsOverride` × 2, `resolveRepoRoot`, `requireSelectedSession`), importing from `'../src/lib/chat-composer-inputs'`.

Delete `dashboard/tests/hooks/useChatComposer.test.tsx`.

- [x] **Step 2: Run test to verify it fails**

Run: `npx tsx --test .\dashboard\tests\chat-stream-transitions.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/chat-stream-transitions'`.

- [x] **Step 3: Create the transition generator**

Create `dashboard/src/lib/chat-stream-transitions.ts`:

```ts
import { getErrorMessage } from '../../../src/lib/errors.js';
import type { ChatSessionRuntimeTransition } from './chat-session-runtime-store';
import type { ChatStreamEvent } from './chat-stream-parser';
import type { ChatSessionOperationKind } from '../types';

/**
 * Turns one chat stream into the runtime transitions it implies. Yields data only, so the
 * caller owns how state is published and two streams can be drained concurrently.
 */
export async function* toRuntimeTransitions(
  sessionId: string,
  operationKind: ChatSessionOperationKind,
  stream: AsyncGenerator<ChatStreamEvent>,
  thinkingEnabled: boolean,
): AsyncGenerator<ChatSessionRuntimeTransition> {
  yield { kind: 'begin', sessionId, operationKind };
  let completed = false;
  try {
    for await (const event of stream) {
      if (event.kind === 'thinking') {
        if (thinkingEnabled) {
          yield { kind: 'thinking', sessionId, text: event.text };
        }
      } else if (event.kind === 'warning') {
        yield { kind: 'warning', sessionId, text: event.text };
      } else if (event.kind === 'tool') {
        yield { kind: 'tool', sessionId, toolEvent: event.tool };
      } else if (event.kind === 'answer') {
        yield { kind: 'answer', sessionId, text: event.text };
      } else if (event.kind === 'done') {
        if (event.payload.session.id !== sessionId) {
          throw new Error(
            `Chat stream session mismatch: expected "${sessionId}", received "${event.payload.session.id}"`,
          );
        }
        yield { kind: 'done', sessionId, response: event.payload };
        completed = true;
      }
    }
    if (!completed) {
      throw new Error('Chat stream ended before the done event');
    }
  } catch (error) {
    yield { kind: 'failure', sessionId, message: getErrorMessage(error) };
  }
}
```

- [x] **Step 4: Move the pure input helpers**

Create `dashboard/src/lib/chat-composer-inputs.ts` with `ParsedMaxTurnsOverride`, `parsePlanMaxTurnsOverride`, `resolveRepoRoot`, and `requireSelectedSession` copied verbatim from `useChatComposer.ts:20-43`, changing only the error message in `requireSelectedSession` to `'chat composer: selectedSession is required'` and its `ChatSession` import to `import type { ChatSession } from '../types';`. Update the moved test's regex accordingly (`/selectedSession is required/` still matches).

- [x] **Step 5: Move the send actions into `useChatSessions`**

Delete `dashboard/src/hooks/useChatComposer.ts`.

In `dashboard/src/hooks/useChatSessions.ts`:

Add to the imports:

```ts
import {
  condenseChatSession,
  createChatSession,
  deleteChatMessage,
  deleteChatSession,
  getChatSession,
  getChatSessions,
  streamChatMessage,
  streamPlanMessage,
  streamRepoSearchMessage,
  updateChatSession,
} from '../api';
import {
  parsePlanMaxTurnsOverride,
  requireSelectedSession,
  resolveRepoRoot,
} from '../lib/chat-composer-inputs';
import { toRuntimeTransitions } from '../lib/chat-stream-transitions';
import type { ChatStreamEvent } from '../lib/chat-stream-parser';
```

Delete these six now-unused forwarders: `beginSessionOperation`, `appendSessionThinking`, `applySessionToolEvent`, `applySessionAnswer`, `applySessionWarning`, `completeSessionOperation` — and delete their entries from the returned object. Keep `failSessionOperation` (the controller calls it in `refreshAfterChatMessageMutation`), `setSessionDraft`, `setSessionImages`, `setSessionPlanInputs`, `applySessionResponse`, and `recordSessionError`.

Add the drain plus the three send actions. The thinking flag is derived here, from the `selectedSession` this hook already owns — do not thread it in as a dep:

```ts
  async function runChatStream(
    sessionId: string,
    operationKind: ChatSessionOperationKind,
    stream: AsyncGenerator<ChatStreamEvent>,
  ): Promise<void> {
    const thinkingEnabled = selectedSession?.thinkingEnabled !== false;
    for await (const transition of toRuntimeTransitions(sessionId, operationKind, stream, thinkingEnabled)) {
      setRuntimeStore((previous) => previous.apply(transition));
      if (transition.kind === 'done') {
        setSessions((previous) => upsertSession(previous, transition.response.session));
      }
    }
  }

  function readRuntimeInputs(sessionId: string): {
    draft: string;
    pendingImages: string[];
    planRepoRootInput: string;
    planMaxTurnsInput: string;
  } {
    const runtime = runtimeStore.get(sessionId);
    return {
      draft: runtime.draft.trim(),
      pendingImages: runtime.pendingImages,
      planRepoRootInput: runtime.planRepoRootInput,
      planMaxTurnsInput: runtime.planMaxTurnsInput,
    };
  }

  async function sendMessage(): Promise<void> {
    if (!selectedSession) {
      return;
    }
    const inputs = readRuntimeInputs(selectedSession.id);
    if (!inputs.draft && inputs.pendingImages.length === 0) {
      return;
    }
    await runChatStream(
      selectedSession.id,
      'message',
      streamChatMessage(selectedSession.id, { content: inputs.draft, images: inputs.pendingImages }),
    );
  }

  async function sendPlan(): Promise<void> {
    const session = requireSelectedSession(selectedSession);
    const inputs = readRuntimeInputs(session.id);
    if (!inputs.draft) {
      return;
    }
    await runChatStream(session.id, 'plan', streamPlanMessage(session.id, {
      content: inputs.draft,
      repoRoot: resolveRepoRoot(inputs.planRepoRootInput, session.planRepoRoot || ''),
      ...parsePlanMaxTurnsOverride(inputs.planMaxTurnsInput),
    }));
  }

  async function sendRepoSearch(): Promise<void> {
    const session = requireSelectedSession(selectedSession);
    const inputs = readRuntimeInputs(session.id);
    if (!inputs.draft) {
      return;
    }
    await runChatStream(session.id, 'repo-search', streamRepoSearchMessage(session.id, {
      content: inputs.draft,
      repoRoot: resolveRepoRoot(inputs.planRepoRootInput, session.planRepoRoot || ''),
      ...parsePlanMaxTurnsOverride(inputs.planMaxTurnsInput),
    }));
  }
```

`readRuntimeInputs` calls `runtimeStore.get`, which throws for an unseeded session. Every send path runs against `selectedSession`, which is only non-null once the session list has loaded and `ensureSession` has run, so a throw here is a real bug and should stay loud.

Add `sendMessage`, `sendPlan`, `sendRepoSearch` to the returned object.

- [x] **Step 6: Simplify `useChatController`**

In `dashboard/src/hooks/useChatController.ts`:

Delete the `import { useChatComposer } from './useChatComposer';` line and the entire `const composer = useChatComposer({ ... });` block (lines 55-71). The `useChatSessions` call and the `isThinkingEnabledForCurrentSession` local are unchanged — the local stays because `ChatTabProps` still carries it; the send actions read the flag from `selectedSession` inside the hook.

Point the three send props at the hook:

```ts
    onSendPlan: chatSessionsHook.sendPlan,
    onSendRepoSearch: chatSessionsHook.sendRepoSearch,
    onSendMessage: chatSessionsHook.sendMessage,
```

- [x] **Step 7: Run tests and typecheck to verify they pass**

Run: `npx tsx --test .\dashboard\tests\chat-stream-transitions.test.ts .\dashboard\tests\chat-composer-inputs.test.ts`
Expected: PASS.

Run: `npm run typecheck:dashboard-test`
Expected: exits 0 with no output.

Run: `npm run test:dashboard`
Expected: PASS.

- [x] **Step 8: Verify the callback bag is gone**

Run: `npx rg "RuntimeActions|useChatComposer" dashboard/`
Expected: no output (exit code 1).

- [x] **Step 9: Commit**

```bash
git add dashboard/src dashboard/tests
git commit -m "refactor: drive chat stream state with transitions instead of callbacks"
```

---

## Task 8: Delete the `ChatSessionRuntimeView` alias

`export type ChatSessionRuntimeView = ChatSessionRuntime` is a pure re-export alias — a shim by any other name — consumed by `ChatTab.tsx` in three places.

**Files:**
- Modify: `dashboard/src/lib/chat-session-state.ts:1-10`, `:27`
- Modify: `dashboard/src/tabs/ChatTab.tsx:18`, `:88`, `:89`, `:158`
- Test: `dashboard/tests/chat-session-state.test.ts`

- [x] **Step 1: Write the failing test**

In `dashboard/tests/chat-session-state.test.ts`, change the import to name the real type and add an assertion that pins the signatures:

```ts
import { deriveSessionIndicator, isSessionBusy } from '../src/lib/chat-session-state';
import type { ChatSessionRuntime } from '../src/lib/chat-session-runtime-store';
```

```ts
test('isSessionBusy is true only while an operation is active', () => {
  const idle: ChatSessionRuntime = new ChatSessionRuntimeStore()
    .ensureSession('s')
    .get('s');
  assert.equal(isSessionBusy(null), false);
  assert.equal(isSessionBusy(idle), false);
  const active = new ChatSessionRuntimeStore()
    .apply({ kind: 'begin', sessionId: 's', operationKind: 'message' })
    .get('s');
  assert.equal(isSessionBusy(active), true);
});
```

Add `import { ChatSessionRuntimeStore } from '../src/lib/chat-session-runtime-store';` to that file if it is not already imported.

- [x] **Step 2: Run the guard to verify the alias is still present**

Run: `npx rg -c "ChatSessionRuntimeView" dashboard/`
Expected: `dashboard/src/lib/chat-session-state.ts:3` and `dashboard/src/tabs/ChatTab.tsx:4`. This is the condition Step 3 removes.

Run: `npx tsx --test .\dashboard\tests\chat-session-state.test.ts`
Expected: PASS — the new `isSessionBusy` test locks in current behaviour so the alias removal in Step 3 is provably behaviour-preserving. This is a refactor with no behaviour change; the test is the regression net, not a red-first driver.

- [x] **Step 3: Delete the alias**

In `dashboard/src/lib/chat-session-state.ts`, delete line 6 and use `ChatSessionRuntime` in both signatures:

```ts
import type { ChatSession } from '../types';
import type { ChatSessionRuntime } from './chat-session-runtime-store';

export type SessionIndicator = 'streaming' | 'tool' | 'failed' | 'completed';

export function deriveSessionIndicator(
  session: ChatSession,
  runtime: ChatSessionRuntime | null,
): SessionIndicator {
```

```ts
export function isSessionBusy(runtime: ChatSessionRuntime | null): boolean {
  return runtime !== null && runtime.activity.kind === 'active';
}
```

In `dashboard/src/tabs/ChatTab.tsx`:

```ts
import { deriveSessionIndicator, isSessionBusy, type SessionIndicator } from '../lib/chat-session-state';
import type { ChatSessionRuntime } from '../lib/chat-session-runtime-store';
```

and replace the three `ChatSessionRuntimeView` annotations at lines 88, 89, and 158 with `ChatSessionRuntime`.

- [x] **Step 4: Run tests and typecheck to verify they pass**

Run: `npx rg "ChatSessionRuntimeView" dashboard/`
Expected: no output (exit code 1).

Run: `npm run typecheck:dashboard-test`
Expected: exits 0 with no output.

Run: `npm run test:dashboard`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add dashboard/src/lib/chat-session-state.ts dashboard/src/tabs/ChatTab.tsx dashboard/tests/chat-session-state.test.ts
git commit -m "refactor: drop the ChatSessionRuntimeView alias"
```

---

## Task 9: Full verification

- [x] **Step 1: Confirm every banned pattern is absent from the branch diff**

Run each; all must produce no output (exit code 1):

```bash
git diff main...HEAD -- src packages dashboard/src scripts | rg "^\+.*\bc8 ignore\b"
git diff main...HEAD -- src packages dashboard/src scripts | rg "^\+.*\bas [A-Z]"
git diff main...HEAD -- src packages dashboard/src scripts | rg "^\+.*: any\b|<any>|\bas any\b"
git diff main...HEAD -- src packages dashboard/src scripts | rg "^\+.*import \* as "
git diff main...HEAD -- src packages dashboard/src scripts | rg "^\+.*ReturnType<typeof (create|build)"
```

`as const` matches the second pattern; confirm every hit is `as const` and nothing else.

- [x] **Step 2: Run the whole typecheck**

Run: `npm run typecheck`
Expected: exits 0. This covers contracts, src, scripts, dashboard, bench, tests, dashboard tests, analysis, and eslint.

- [x] **Step 3: Run the whole backend suite**

Run: `npm test`
Expected: all tests pass.

- [x] **Step 4: Run the whole dashboard suite**

Run: `npm run test:dashboard`
Expected: all tests pass.

- [x] **Step 5: Confirm coverage did not regress on the two registries**

Run: `npm run test:coverage`
Expected: `status-run-registry.ts` and `chat-session-operation-registry.ts` each report 100% branch coverage now that the `c8 ignore` markers are gone. If either is below 100%, add a test for the specific uncovered branch reported — do not re-add a suppression comment.

- [x] **Step 6: Commit any coverage tests added**

```bash
git add tests
git commit -m "test: cover remaining status and chat session registry branches"
```

---

## Findings-to-task coverage

| Finding | Task |
|---|---|
| 1. `runtimes` callback bag threaded through three layers | 7 |
| 2. `ChatSessionRuntimeStore` twelve copy-pasted preambles | 6 |
| 3. Lease wrapper bolted onto 5 endpoints, condense unguarded | 5 |
| 4. `/* c8 ignore next */` in the two new registries | 2, 3, 9 |
| 5. `startOrAdvance` null clobber | 1 |
| Cut: `createXResult` factories + `ReturnType<typeof …>` | 2, 3 |
| Cut: `resolveTerminalRun` unused `nowMs` | 2 |
| Cut: `persistStatusRunLog` hardcoded `model` / `backend` / title | 4 |
| Cut: `ChatSessionRuntimeView` alias | 8 |
| Cut: `Parameters<ChatSessionRuntimeStore['applyToolEvent']>[1]` | 7 (the forwarder is deleted) |

# Repo-Agent Server-Owned Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move repo-agent run ownership from a detached client worker into the status server, so the CLI streams progress, exits cleanly at every boundary (approval or terminal), and a parked run keeps its full conversation context and prefix-cache warm server-side until `decide` resumes it.

**Architecture:** A new `RepoAgentSessionManager` in the status server owns each run: it acquires the model lock, executes the engine with a session-owned abort signal, mirrors run state into the file-based `RepoAgentRunStore` (server is the sole writer while alive), and fans progress out to at most one attached SSE subscriber. The `/repo-agent` and new `/repo-agent/decide` routes attach to a session, stream progress, and end with a `RepoAgentRunResult` result frame. The CLI becomes a thin foreground client: one code path for TTY and non-TTY, progress rendered to stderr, boundary JSON flushed to stdout, exit code mapped from the boundary status. The detached worker, its launcher, the store-polling boundary waiter, and the decision-file machinery are deleted.

**Tech Stack:** TypeScript (strict, zod-validated IO), node:test, SSE over node:http, existing status-server route/lock machinery.

---

## Spec

### Behavior contract

1. `siftkit repo-agent "<task>"` (any stdin, TTY or not):
   - Streams progress events to stderr while running (`--progress` renders per-turn lines; without it only warnings/activity summaries render — existing `CliProgressRenderer.forCli` gating).
   - `--approval auto` (default) / `off`: when the run completes, fails, aborts, or needs a human approval, the server ends the SSE stream with a `RepoAgentRunResult` result frame. The CLI prints the approval banner to stderr (approval_required only), prints the result JSON to stdout, **flushes both writes via write callbacks**, and exits with the mapped code (`completed 0`, `approval_required 3`, everything else 1). No child processes remain.
   - `--approval interactive` (requires TTY): approvals are prompted in-stream exactly as today via `/repo-search/approval`; the stream ends only at a terminal result frame.
2. The server keeps the parked run alive in memory: the engine coroutine is suspended inside `ApprovalGate.request()`, the transcript `ChatMessage[]` is intact, and the inference backend's prefix cache stays warm, so resume pays no prompt reprocessing.
3. `siftkit repo-agent decide <runId> approve|deny|abort [--reason] [--progress]` POSTs `/repo-agent/decide`, attaches to the session's stream, resumes the engine, and ends at the **next** boundary (another approval_required, or terminal) with the same result-frame protocol and exit codes.
4. Client disconnect never aborts a run. A run ends only via: completion, engine failure, an `abort` decision, or the approval decision timeout (600s, unchanged; a timed-out park becomes terminal `approval_timeout`).
5. The run store (`<runtimeRoot>/repo-agent/runs/<runId>/`) is written only by the server while it is alive; `pid` in state files is the **server** pid. `status` still reads the store directly and reconciles: an active state whose pid is dead becomes `failed` (covers server crash).
6. `decide` for a run the server no longer has a session for:
   - store state terminal → the stored result is returned as a result frame (idempotent, loud, exit code mapped);
   - store state active (server restarted mid-run) → the store is transitioned to `failed` with an explicit "not resumable: the status server restarted" message and that result is returned. No hang, no silent denial.
7. Transcripts keep persisting to the runtime DB exactly as today (success and failure paths in `execute.ts`, including timeout/abort settles). **Out of scope:** rehydrating a parked conversation across a server restart; the recorded transcript makes that possible later, and `decide` fails loudly until then.

### Protocol change

`POST /repo-agent` and `POST /repo-agent/decide` SSE streams end with `event: result` whose payload is `RepoAgentRunResult` (was `RepoSearchExecutionResult` for `/repo-agent`). `completed.output` carries the formatted final output (server-side `formatRepoTaskOutput`). `approval_request` progress frames are only forwarded to interactive streams; non-interactive callers get the boundary result frame instead. `event: error` frames remain for infrastructure failures (bad request, lock queue timeout, no pending approval).

### Deletions (complete replacement, no shims)

`src/repo-agent/worker.ts`, `worker-main.ts`, `worker-launcher.ts`, `run-approval-prompter.ts`, `boundary-waiter.ts`, `src/cli/run-repo-agent-foreground.ts`, `src/cli/repo-task-output.ts` (moves to `src/repo-agent/run-output.ts`), the store's decision-file machinery (`submitDecision`, `consumeDecision`, claim files), and the tests that exercised them.

---

## File map

| File | Change |
|---|---|
| `src/repo-search/engine/approval-gate.ts` | Add optional `ApprovalGateObserver` (onDecision/onTimeout) |
| `src/repo-agent/run-schemas.ts` | Rename `RepoAgentWorkerRequestSchema`→`RepoAgentRunRequestSchema` (drop `progress`); add `repoAgentStateToResult` + decide-command builder |
| `src/repo-agent/run-store.ts` | Add `markNotResumable`, `reconcile`; (Task 6) delete decision machinery |
| `src/repo-agent/run-output.ts` | New: `formatRepoTaskOutput` (moved from `src/cli/repo-task-output.ts`) |
| `src/status-server/repo-search-admissions.ts` | New: admission record type + create/upsert/markFailed (moved out of `routes/core.ts`) |
| `src/status-server/repo-agent-sessions.ts` | New: `RepoAgentSession`, `RepoAgentSessionManager`, lock adapter type |
| `src/status-server/repo-agent-lock-adapter.ts` | New: `ServerModelLockAdapter` over server-ops lock functions |
| `src/status-server/server-types.ts` | Add `repoAgentRunStore`, `repoAgentSessions` to `ServerContext` |
| `src/status-server/index.ts` | Wire store + session manager into ctx |
| `src/status-server/routes/core.ts` | Replace `RepoAgentEndpoint` with session-based start endpoint; add decide endpoint; collapse `RepoTaskEndpoint` to search-only |
| `src/cli/status-server-api-client.ts` | `requestRepoAgent` returns `RepoAgentRunResult`; add `requestRepoAgentDecide` |
| `src/cli/repo-agent-command.ts` | Full rewrite: foreground streaming, flushed boundary writes, store-only `status` |
| `src/cli/run-repo-agent.ts` | Rewire (no launcher/worker) |
| `src/cli/repo-agent-args.ts` | `decide` gains `--progress` |
| `src/cli/repo-agent-help.ts` | Text updates (flow, `--progress` wording, decide flag) |
| Tests | See per-task lists |

Run a single test file: `npm run test -- <file-name-fragment>` (e.g. `npm run test -- repo-agent-sessions`). Full gate: `npm run test`, `npm run typecheck`, `npm run lint`.

---

### Task 1: ApprovalGate observer hooks

**Files:**
- Modify: `src/repo-search/engine/approval-gate.ts`
- Test: `tests/approval-gate.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/approval-gate.test.ts`. The file already captures `approval_request` events through a recording `ProgressWriter` to learn the `approvalId` — reuse that recording-writer class (referred to as `RecordingWriter` below; use whatever name the file already declares). Add:

```ts
import { ApprovalGate, type ApprovalDecision } from '../src/repo-search/engine/approval-gate.js';

class RecordingObserver {
  decisions: ApprovalDecision[] = [];
  timeouts = 0;
  onDecision(decision: ApprovalDecision): void { this.decisions.push(decision); }
  onTimeout(): void { this.timeouts += 1; }
}
```

```ts
test('observer.onDecision fires with the submitted decision', async () => {
  const writer = new RecordingWriter();          // existing pattern in this file
  const observer = new RecordingObserver();
  const controller = new AbortController();
  const gate = new ApprovalGate({
    requestId: 'req-observer-1',
    progressWriter: writer,
    abortSignal: controller.signal,
    bypassReadOnlyTools: false,
    observer,
  });
  const pending = gate.request({ turn: 1, toolName: 'run', command: 'echo hi', reviewPayload: null });
  const approvalId = String(writer.events.find((e) => e.kind === 'approval_request')?.approvalId ?? '');
  assert.ok(approvalId);
  assert.equal(gate.submit(approvalId, { kind: 'deny', reason: 'nope' }), true);
  assert.deepEqual(await pending, { kind: 'deny', reason: 'nope' });
  assert.deepEqual(observer.decisions, [{ kind: 'deny', reason: 'nope' }]);
  assert.equal(observer.timeouts, 0);
});

test('observer.onTimeout fires when the decision timer expires', async () => {
  const writer = new RecordingWriter();
  const observer = new RecordingObserver();
  const controller = new AbortController();
  const gate = new ApprovalGate({
    requestId: 'req-observer-2',
    progressWriter: writer,
    abortSignal: controller.signal,
    bypassReadOnlyTools: false,
    decisionTimeoutMs: 25,
    observer,
  });
  const decision = await gate.request({ turn: 1, toolName: 'run', command: 'echo hi', reviewPayload: null });
  assert.equal(decision.kind, 'abort');
  assert.equal(observer.timeouts, 1);
  assert.deepEqual(observer.decisions, []);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- approval-gate`
Expected: FAIL — `observer` is not a known option (TS compile error via `typecheck:test`).

- [ ] **Step 3: Implement**

In `src/repo-search/engine/approval-gate.ts`:

```ts
/** Observes gate lifecycle so a run owner can mirror decisions into durable state. */
export type ApprovalGateObserver = {
  onDecision(decision: ApprovalDecision): void;
  onTimeout(): void;
};
```

Add to the constructor options and store as `private readonly observer: ApprovalGateObserver | undefined;`. In the timeout handler (inside `setTimeout`, after `clearPending` and the error log, before `resolve`):

```ts
this.observer?.onTimeout();
resolve({ kind: 'abort', reason: buildApprovalTimeoutMessage(this.decisionTimeoutMs) });
```

In `submit()` (after `clearPending` and the decision log, before `entry.resolve(decision)`):

```ts
this.observer?.onDecision(decision);
entry.resolve(decision);
```

- [ ] **Step 4: Run to verify pass** — `npm run test -- approval-gate` → PASS
- [ ] **Step 5: Commit** — `git add -A; git commit -m "feat: add ApprovalGate observer hooks for run owners"`

---

### Task 2: Run schemas + store groundwork

**Files:**
- Modify: `src/repo-agent/run-schemas.ts`, `src/repo-agent/run-store.ts`
- Modify (mechanical import/rename fixes): `src/repo-agent/boundary-waiter.ts`, `src/repo-agent/worker.ts`, `src/repo-agent/worker-main.ts`, `src/cli/repo-agent-command.ts`, `src/status-server/index.ts` (only if they reference renamed symbols)
- Test: `tests/repo-agent-run-store.test.ts`

- [ ] **Step 1: Write failing tests** for the two new store methods in `tests/repo-agent-run-store.test.ts` (follow the file's existing temp-dir store setup):

```ts
test('markNotResumable fails an active run with a restart message and is a no-op on terminal runs', () => {
  const store = makeStore();                       // existing helper/pattern in this file
  const request = makeRequest();                   // existing pattern; uses RepoAgentRunRequestSchema now
  store.create(request);
  store.transition(request.runId, 0, {
    runId: request.runId, revision: 1, updatedAtUtc: new Date().toISOString(),
    status: 'running', pid: process.pid,
  });
  const failed = store.markNotResumable(request.runId);
  assert.equal(failed.status, 'failed');
  if (failed.status === 'failed') {
    assert.match(failed.error, /not resumable/u);
    assert.match(failed.error, /restarted/u);
  }
  const again = store.markNotResumable(request.runId);
  assert.deepEqual(again, failed);
});

test('reconcile marks an active run with a dead pid as failed and leaves live/terminal runs alone', () => {
  const store = makeStore();
  const request = makeRequest();
  store.create(request);
  store.transition(request.runId, 0, {
    runId: request.runId, revision: 1, updatedAtUtc: new Date().toISOString(),
    status: 'running', pid: process.pid,
  });
  const deadInspector = { isAlive: () => false };
  const liveInspector = { isAlive: () => true };
  assert.equal(store.reconcile(request.runId, liveInspector).status, 'running');
  const reconciled = store.reconcile(request.runId, deadInspector);
  assert.equal(reconciled.status, 'failed');
  assert.equal(store.reconcile(request.runId, deadInspector).status, 'failed');
});
```

- [ ] **Step 2: Run to verify failure** — `npm run test -- repo-agent-run-store` → FAIL (methods missing).

- [ ] **Step 3: Implement schema changes** in `src/repo-agent/run-schemas.ts`:

1. Rename `RepoAgentWorkerRequestSchema` → `RepoAgentRunRequestSchema` and `RepoAgentWorkerRequest` → `RepoAgentRunRequest`; **delete the `progress` field** (progress rendering is now purely a client concern).
2. Move the state→result mapper here from `boundary-waiter.ts` (it is pure):

```ts
export function buildRepoAgentDecideCommands(runId: string): {
  approve: string; deny: string; abort: string;
} {
  return {
    approve: `siftkit repo-agent decide ${runId} approve`,
    deny: `siftkit repo-agent decide ${runId} deny --reason "<why>"`,
    abort: `siftkit repo-agent decide ${runId} abort`,
  };
}

export function repoAgentStateToResult(state: RepoAgentRunState): RepoAgentRunResult {
  switch (state.status) {
    case 'completed':
      return RepoAgentRunResultSchema.parse({ status: 'completed', runId: state.runId, output: state.output });
    case 'approval_required':
      return RepoAgentRunResultSchema.parse({
        status: 'approval_required', runId: state.runId, approval: state.approval,
        decide: buildRepoAgentDecideCommands(state.runId),
      });
    case 'approval_timeout':
      return RepoAgentRunResultSchema.parse({ status: 'approval_timeout', runId: state.runId, approval: state.approval });
    case 'failed':
      return RepoAgentRunResultSchema.parse({ status: 'failed', runId: state.runId, error: state.error });
    case 'aborted':
      return RepoAgentRunResultSchema.parse({ status: 'aborted', runId: state.runId });
    default:
      throw new Error(`Cannot convert ${state.status} to a public result.`);
  }
}
```

3. Update `boundary-waiter.ts` to import `repoAgentStateToResult` from `run-schemas.js` and delete its local copy (keep its `waitForBoundary`/`reconcileOnce` for now — the worker still uses them until Task 6). Fix the renamed request type in `run-store.ts`, `worker.ts`, `worker-main.ts`, `src/cli/repo-agent-command.ts` (drop the `progress: invocation.progress` line from the request it builds), and any other compile errors `npm run typecheck:test` reports. The CLI still passes `--progress` to its own renderer; it just no longer ships it to the store.

- [ ] **Step 4: Implement store additions** in `src/repo-agent/run-store.ts`:

```ts
import { NodeProcessInspector, type ProcessInspector } from '../lib/process-inspector.js';
```

```ts
  /** Terminalizes a run the server can no longer resume (restart lost the in-memory conversation). */
  markNotResumable(runId: string): RepoAgentRunState {
    const validatedRunId = this.validRunId(runId);
    const lease = this.stateLease(validatedRunId);
    lease.acquire();
    try {
      const current = this.readStateFile(validatedRunId);
      if (isTerminalStatus(current.status)) {
        return current;
      }
      const pid = workerPid(current);
      const next = RepoAgentRunStateSchema.parse({
        runId: validatedRunId,
        revision: current.revision + 1,
        updatedAtUtc: new Date().toISOString(),
        status: 'failed',
        ...(pid === undefined ? {} : { pid }),
        error: 'Run is not resumable: the status server restarted while the run was active and the in-memory conversation was lost. Start a new run.',
      });
      this.writeState(next);
      return next;
    } finally {
      lease.release();
    }
  }

  /** Reads state; if the recorded server pid is dead on an active state, records the failure first. */
  reconcile(
    runId: string,
    inspector: ProcessInspector = new NodeProcessInspector(),
  ): RepoAgentRunState {
    const state = this.readState(runId);
    if (!isActiveStatus(state.status)) {
      return state;
    }
    const pid = workerPid(state);
    if (pid === undefined || inspector.isAlive(pid)) {
      return state;
    }
    try {
      this.transition(runId, state.revision, {
        runId,
        revision: state.revision + 1,
        updatedAtUtc: new Date().toISOString(),
        status: 'failed',
        pid,
        error: `Owning server process ${pid} died while the run was active.`,
      });
    } catch {
      // Another writer advanced the state first; the fresh read below wins.
    }
    return this.readState(runId);
  }
```

(Import `isActiveStatus` from `run-schemas.js`; `workerPid` already exists in this file. Check `src/lib/process-inspector.ts` exports `ProcessInspector` with `isAlive(pid: number): boolean` — `boundary-waiter.ts` imported exactly that.)

- [ ] **Step 5: Verify** — `npm run test -- repo-agent-run-store` → PASS, then `npm run typecheck:test` clean, then `npm run test -- repo-agent` (all repo-agent files still green — worker flow untouched).
- [ ] **Step 6: Commit** — `git commit -am "refactor: run-request schema rename, shared state-to-result mapper, store reconcile/markNotResumable"`

---

### Task 3: Extract admissions module and move output formatter

**Files:**
- Create: `src/status-server/repo-search-admissions.ts`
- Create: `src/repo-agent/run-output.ts`
- Modify: `src/status-server/routes/core.ts`, `src/cli/repo-agent-command.ts` (imports only), delete `src/cli/repo-task-output.ts`
- Modify: every importer of `repo-task-output.js` (grep: `src/repo-agent/worker.ts`, `src/cli/run-repo-agent-foreground.ts`, plus whatever `Grep repo-task-output` finds)

Pure mechanical moves — no behavior change, existing tests are the safety net.

- [ ] **Step 1:** Create `src/status-server/repo-search-admissions.ts` and move `RepoSearchAdmissionRecord`, `createRepoSearchAdmissionRecord`, `upsertRepoSearchAdmission`, `markRepoSearchAdmissionFailed` verbatim from `routes/core.ts` (lines ~126–243), exporting all four. Bring their imports (`randomUUID`, `getActiveInferenceBackend`, `upsertRunLog`, `getRuntimeDatabase`, `RepoSearchRouteRequest`, `SiftConfig`, `InferenceBackendId`). Update `core.ts` to import from the new module and delete the moved code.
- [ ] **Step 2:** Create `src/repo-agent/run-output.ts` with the exact content of `src/cli/repo-task-output.ts` (`formatRepoTaskOutput`); delete the old file; update all importers to `../repo-agent/run-output.js` (from `src/cli`) / `../repo-agent/run-output.js` equivalents.
- [ ] **Step 3: Verify** — `npm run typecheck:test` clean; `npm run test -- repo-agent`; `npm run test -- streamed-repo-agent` → all PASS (no behavior change).
- [ ] **Step 4: Commit** — `git commit -am "refactor: extract repo-search admissions module; move repo task output formatter"`

---

### Task 4: RepoAgentSession + manager + lock adapter

**Files:**
- Create: `src/status-server/repo-agent-sessions.ts`
- Create: `src/status-server/repo-agent-lock-adapter.ts`
- Test: `tests/repo-agent-sessions.test.ts` (new)

- [ ] **Step 1: Write the session module** (implementation-first is fine here for the types the tests need; the tests in Step 2 are the acceptance gate — run them before trusting anything).

`src/status-server/repo-agent-sessions.ts`:

```ts
import { toError } from '../lib/errors.js';
import { ProgressWriter } from '../lib/progress-writer.js';
import { formatRepoTaskOutput } from '../repo-agent/run-output.js';
import {
  isTerminalStatus,
  repoAgentStateToResult,
  type RepoAgentRunResult,
  type RepoAgentRunState,
} from '../repo-agent/run-schemas.js';
import type { RepoAgentRunStore } from '../repo-agent/run-store.js';
import {
  ApprovalGate,
  CLIENT_ABORT_MESSAGE,
  type ApprovalDecision,
  type ApprovalGateObserver,
  type ApprovalMode,
} from '../repo-search/engine/approval-gate.js';
import { RepoSearchResponseSanityChecker } from '../repo-search/response-sanity.js';
import type {
  RepoSearchExecutionRequest,
  RepoSearchExecutionResult,
  RepoSearchProgressEvent,
} from '../repo-search/types.js';
import { buildRepoSearchProgressLogBody } from './dashboard-runs.js';
import {
  markRepoSearchAdmissionFailed,
  type RepoSearchAdmissionRecord,
} from './repo-search-admissions.js';
import { serverLogger } from './server-logger.js';

const LOCK_WAIT_EMIT_INTERVAL_MS = 2_000;

export type RepoAgentSessionSubscriber = {
  writeProgress(event: RepoSearchProgressEvent): void;
};

export type RepoAgentEngine = {
  executeRepoSearch(request: RepoSearchExecutionRequest): Promise<RepoSearchExecutionResult>;
};

export type RepoAgentModelLockAdapter = {
  /** Resolves once the model lock is held and the preset is ready; null on queue timeout. */
  acquire(runId: string): Promise<{ release(): void } | null>;
  queueLength(): number;
};

export type RepoAgentEngineRequest = Omit<
  RepoSearchExecutionRequest,
  'progressWriter' | 'approvalGate' | 'approvalMode' | 'abortSignal'
>;

type BoundaryWaiter = {
  sinceRevision: number;
  resolve(result: RepoAgentRunResult): void;
};

/** Routes engine progress into the session: approval parks become store state, the rest fans out. */
class SessionProgressWriter extends ProgressWriter<RepoSearchProgressEvent> {
  constructor(private readonly session: RepoAgentSession) {
    super();
  }

  get enabled(): boolean {
    return true;
  }

  override get wantsLiveText(): boolean {
    return false;
  }

  write(event: RepoSearchProgressEvent): void {
    this.session.handleProgressEvent(event);
  }
}

export type RepoAgentSessionOptions = {
  runId: string;
  requestId: string;
  admission: RepoSearchAdmissionRecord;
  approvalMode: ApprovalMode;
  store: RepoAgentRunStore;
  engine: RepoAgentEngine;
  locks: RepoAgentModelLockAdapter;
  approvalGates: Map<string, ApprovalGate>;
  engineRequest: RepoAgentEngineRequest;
  decisionTimeoutMs?: number;
};

/**
 * Owns one repo-agent run end to end: model lock, engine execution, approval parks,
 * and every run-store transition. Client connections only attach/detach; they never
 * affect the run's lifetime.
 */
export class RepoAgentSession implements ApprovalGateObserver {
  readonly runId: string;
  private readonly requestId: string;
  private readonly admission: RepoSearchAdmissionRecord;
  private readonly approvalMode: ApprovalMode;
  private readonly store: RepoAgentRunStore;
  private readonly engine: RepoAgentEngine;
  private readonly locks: RepoAgentModelLockAdapter;
  private readonly approvalGates: Map<string, ApprovalGate>;
  private readonly engineRequest: RepoAgentEngineRequest;
  private readonly abortController = new AbortController();
  private readonly progressWriter = new SessionProgressWriter(this);
  private readonly gate: ApprovalGate | undefined;
  private readonly waiters: BoundaryWaiter[] = [];
  private subscriber: RepoAgentSessionSubscriber | null = null;
  private state: RepoAgentRunState;
  private settledPromise: Promise<void> | null = null;

  constructor(options: RepoAgentSessionOptions) {
    this.runId = options.runId;
    this.requestId = options.requestId;
    this.admission = options.admission;
    this.approvalMode = options.approvalMode;
    this.store = options.store;
    this.engine = options.engine;
    this.locks = options.locks;
    this.approvalGates = options.approvalGates;
    this.engineRequest = options.engineRequest;
    this.state = this.store.readState(this.runId);
    this.gate = options.approvalMode === 'off'
      ? undefined
      : new ApprovalGate({
        requestId: options.requestId,
        progressWriter: this.progressWriter,
        abortSignal: this.abortController.signal,
        bypassReadOnlyTools: true,
        observer: this,
        ...(options.decisionTimeoutMs === undefined
          ? {}
          : { decisionTimeoutMs: options.decisionTimeoutMs }),
      });
  }

  get settled(): Promise<void> {
    if (!this.settledPromise) {
      throw new Error('Session has not been started.');
    }
    return this.settledPromise;
  }

  start(): void {
    if (this.settledPromise) {
      throw new Error('Session already started.');
    }
    this.settledPromise = this.run();
  }

  currentRevision(): number {
    return this.state.revision;
  }

  attach(subscriber: RepoAgentSessionSubscriber): () => void {
    this.subscriber = subscriber;
    return () => {
      if (this.subscriber === subscriber) {
        this.subscriber = null;
      }
    };
  }

  /** Resolves the parked approval via the shared gate. False when nothing is parked. */
  submitDecision(input: { decision: 'approve' | 'deny' | 'abort'; reason?: string }): boolean {
    if (!this.gate || this.state.status !== 'approval_required') {
      return false;
    }
    const decision: ApprovalDecision = input.decision === 'approve'
      ? { kind: 'approve' }
      : input.decision === 'deny'
        ? { kind: 'deny', reason: (input.reason ?? '').trim() }
        : { kind: 'abort', reason: CLIENT_ABORT_MESSAGE };
    return this.gate.submit(this.state.approval.approvalId, decision);
  }

  waitForBoundary(sinceRevision: number): Promise<RepoAgentRunResult> {
    const immediate = this.boundaryResultFor(sinceRevision);
    if (immediate) {
      return Promise.resolve(immediate);
    }
    return new Promise((resolve) => {
      this.waiters.push({ sinceRevision, resolve });
    });
  }

  // ---- ApprovalGateObserver ----

  onDecision(decision: ApprovalDecision): void {
    if (this.state.status !== 'approval_required') {
      return;
    }
    this.applyState(this.store.clearPendingApproval(
      this.runId,
      this.state.revision,
      decision.kind === 'abort' ? 'aborted' : 'running',
    ));
  }

  onTimeout(): void {
    if (this.state.status !== 'approval_required') {
      return;
    }
    this.applyState(this.store.clearPendingApproval(
      this.runId,
      this.state.revision,
      'approval_timeout',
    ));
  }

  // ---- progress routing ----

  handleProgressEvent(event: RepoSearchProgressEvent): void {
    if (event.kind === 'approval_request') {
      this.publishApproval(event);
      if (this.approvalMode !== 'interactive') {
        return;
      }
    }
    if (event.kind === 'tool_start' || event.kind === 'context_warning') {
      const body = buildRepoSearchProgressLogBody(event);
      if (body) {
        serverLogger.emitBody('rs', this.requestId, body);
      }
    }
    if (event.kind === 'thinking' || event.kind === 'answer') {
      return;
    }
    this.subscriber?.writeProgress(event);
  }

  // ---- internals ----

  private async run(): Promise<void> {
    if (this.gate) {
      this.approvalGates.set(this.requestId, this.gate);
    }
    let lock: { release(): void } | null = null;
    const lockWaitStartedAt = Date.now();
    const lockWaitTimer = setInterval(() => {
      this.subscriber?.writeProgress({
        kind: 'lock_wait',
        elapsedMs: Date.now() - lockWaitStartedAt,
      });
    }, LOCK_WAIT_EMIT_INTERVAL_MS);
    lockWaitTimer.unref();
    try {
      try {
        lock = await this.locks.acquire(this.runId);
      } finally {
        clearInterval(lockWaitTimer);
      }
      if (!lock) {
        this.settleFailure('Timed out waiting for model request queue.');
        return;
      }
      this.applyState(this.store.transition(this.runId, this.state.revision, {
        runId: this.runId,
        revision: this.state.revision + 1,
        updatedAtUtc: new Date().toISOString(),
        status: 'running',
        pid: process.pid,
      }));
      const result = await this.engine.executeRepoSearch({
        ...this.engineRequest,
        abortSignal: this.abortController.signal,
        progressWriter: this.progressWriter,
        ...(this.gate ? { approvalGate: this.gate } : {}),
        approvalMode: this.approvalMode,
      });
      RepoSearchResponseSanityChecker.assertSafeToSend(result);
      if (!isTerminalStatus(this.state.status)) {
        this.applyState(this.store.transition(this.runId, this.state.revision, {
          runId: this.runId,
          revision: this.state.revision + 1,
          updatedAtUtc: new Date().toISOString(),
          status: 'completed',
          pid: process.pid,
          output: formatRepoTaskOutput(result),
        }));
      }
    } catch (error) {
      this.settleFailure(toError(error).message);
    } finally {
      lock?.release();
      if (this.gate) {
        this.approvalGates.delete(this.requestId);
      }
    }
  }

  private settleFailure(message: string): void {
    markRepoSearchAdmissionFailed(this.admission, message);
    if (isTerminalStatus(this.state.status)) {
      return;
    }
    const pid = this.state.status === 'starting' ? undefined : this.state.pid;
    this.applyState(this.store.transition(this.runId, this.state.revision, {
      runId: this.runId,
      revision: this.state.revision + 1,
      updatedAtUtc: new Date().toISOString(),
      status: 'failed',
      ...(pid === undefined ? {} : { pid }),
      error: message,
    }));
  }

  private publishApproval(event: RepoSearchProgressEvent): void {
    const approvalId = event.approvalId;
    const toolName = event.toolName;
    const command = event.command;
    if (!approvalId || !toolName || !command) {
      throw new Error('approval_request progress event is missing approvalId, toolName, or command.');
    }
    if (this.state.status !== 'running') {
      throw new Error(`Approval requested while run ${this.runId} is ${this.state.status}.`);
    }
    this.applyState(this.store.publishApproval(this.runId, this.state.revision, {
      approvalId,
      toolName,
      command,
      reviewPayload: event.reviewPayload ?? null,
    }));
  }

  private boundaryResultFor(sinceRevision: number): RepoAgentRunResult | null {
    if (this.state.revision <= sinceRevision) {
      return null;
    }
    if (isTerminalStatus(this.state.status)) {
      return repoAgentStateToResult(this.state);
    }
    if (this.state.status === 'approval_required' && this.approvalMode !== 'interactive') {
      return repoAgentStateToResult(this.state);
    }
    return null;
  }

  private applyState(next: RepoAgentRunState): void {
    this.state = next;
    const remaining: BoundaryWaiter[] = [];
    for (const waiter of this.waiters) {
      const result = this.boundaryResultFor(waiter.sinceRevision);
      if (result) {
        waiter.resolve(result);
      } else {
        remaining.push(waiter);
      }
    }
    this.waiters.splice(0, this.waiters.length, ...remaining);
  }
}

export class RepoAgentSessionManager {
  private readonly sessions = new Map<string, RepoAgentSession>();
  private readonly store: RepoAgentRunStore;
  private readonly engine: RepoAgentEngine;

  constructor(deps: { store: RepoAgentRunStore; engine: RepoAgentEngine }) {
    this.store = deps.store;
    this.engine = deps.engine;
  }

  start(options: Omit<RepoAgentSessionOptions, 'store' | 'engine'>): RepoAgentSession {
    const session = new RepoAgentSession({
      ...options,
      store: this.store,
      engine: this.engine,
    });
    this.sessions.set(options.runId, session);
    session.start();
    void session.settled.finally(() => {
      this.sessions.delete(options.runId);
    });
    return session;
  }

  get(runId: string): RepoAgentSession | undefined {
    return this.sessions.get(runId);
  }
}
```

`src/status-server/repo-agent-lock-adapter.ts`:

```ts
import {
  acquireModelRequestWithWait,
  ensureActivePresetReadyForModelRequest,
  getModelRequestQueueDiagnostics,
  releaseModelRequest,
} from './server-ops.js';
import type { ServerContext } from './server-types.js';
import type { RepoAgentModelLockAdapter } from './repo-agent-sessions.js';

/** Session-owned model lock: acquired without an HTTP request, released when the run settles. */
export class ServerModelLockAdapter implements RepoAgentModelLockAdapter {
  constructor(private readonly ctx: ServerContext) {}

  async acquire(runId: string): Promise<{ release(): void } | null> {
    const lock = await acquireModelRequestWithWait(this.ctx, 'repo_search', undefined, undefined, {
      ownerRunId: runId,
    });
    if (!lock) {
      return null;
    }
    try {
      await ensureActivePresetReadyForModelRequest(this.ctx);
    } catch (error) {
      releaseModelRequest(this.ctx, lock.token);
      throw error;
    }
    return {
      release: () => {
        releaseModelRequest(this.ctx, lock.token);
      },
    };
  }

  queueLength(): number {
    return getModelRequestQueueDiagnostics(this.ctx).queueLength;
  }
}
```

- [ ] **Step 2: Write session unit tests** — `tests/repo-agent-sessions.test.ts`. Setup per test: managed temp dir + `process.chdir` (copy the pattern from `tests/helpers/streamed-op-harness.ts` including `closeRuntimeDatabase()` and cwd restore in `t.after`), a `RepoAgentRunStore` rooted in the temp dir, `parseRepoSearchRequest` + `createRepoSearchAdmissionRecord(routeRequest, mockOfflineSiftConfig())` for the admission, and these fakes:

```ts
import { buildMockScorecard } from './_test-helpers.js';

function makeEngineResult(finalOutput: string): RepoSearchExecutionResult {
  return {
    requestId: 'request-session-test',
    transcriptPath: 'db://repo-search/request_test.jsonl',
    artifactPath: 'db://repo-search/request_test.json',
    scorecard: buildMockScorecard(finalOutput),
  };
}

class ImmediateLockAdapter implements RepoAgentModelLockAdapter {
  releases = 0;
  acquire(): Promise<{ release(): void } | null> {
    return Promise.resolve({ release: () => { this.releases += 1; } });
  }
  queueLength(): number { return 0; }
}

/** Parks on the gate once, then finishes with an output describing the decision it got. */
class ParkingEngine implements RepoAgentEngine {
  async executeRepoSearch(request: RepoSearchExecutionRequest): Promise<RepoSearchExecutionResult> {
    const gate = request.approvalGate;
    if (!gate) {
      throw new Error('ParkingEngine requires an approval gate.');
    }
    const decision = await gate.request({
      turn: 1, toolName: 'run', command: 'npm install left-pad', reviewPayload: null,
    });
    if (decision.kind === 'abort') {
      throw new Error(decision.reason);
    }
    if (decision.kind === 'deny') {
      return makeEngineResult(`denied: ${decision.reason}`);
    }
    return makeEngineResult('installed');
  }
}
```

Cover (one test each; drive via `manager.start(...)` with `approvalMode: 'auto'` unless noted, then `waitForBoundary`/`submitDecision`):

1. **Completion:** engine returns immediately (a `CompletingEngine` that just returns `makeEngineResult('done')`, `approvalMode: 'off'`) → `waitForBoundary(0)` resolves `{status:'completed', output contains 'done'}`; store state `completed`; lock released once.
2. **Park boundary:** `ParkingEngine` → `waitForBoundary(0)` resolves `approval_required` with `toolName 'run'` and populated `decide` commands; store state `approval_required` with server pid.
3. **Approve resume:** after the park boundary, `submitDecision({decision:'approve'})` returns true → `waitForBoundary(parkRevision)` resolves `completed` with output `'installed'`; store terminal `completed`.
4. **Deny resume:** `submitDecision({decision:'deny', reason:'not now'})` → completed with output containing `'denied: not now'`.
5. **Abort:** `submitDecision({decision:'abort'})` → boundary resolves `{status:'aborted'}` (store `aborted`), and `settled` resolves without leaving a `failed` state behind.
6. **Timeout:** `decisionTimeoutMs: 25`, never decide → `waitForBoundary(parkRevision)` resolves `{status:'approval_timeout'}`; store `approval_timeout`; engine's abort error did not overwrite it.
7. **Interactive park is not a boundary:** `approvalMode:'interactive'`, `ParkingEngine`; attach a recording subscriber; assert the subscriber received the `approval_request` progress event, `waitForBoundary(0)` is still pending (use a raced `setTimeout` of ~50ms), then submit approve via the gate in `approvalGates` map and assert the boundary resolves `completed`.
8. **Suppression:** `approvalMode:'auto'` with a recording subscriber → subscriber never sees `kind==='approval_request'`.
9. **Engine failure:** engine rejects → boundary `{status:'failed'}`; store `failed`; lock released.
10. **Lock timeout:** adapter returning `null` → boundary `{status:'failed', error contains 'model request queue'}`.

- [ ] **Step 3: Run** — `npm run test -- repo-agent-sessions` → PASS. Fix compile/sanity issues (e.g. if `RepoSearchResponseSanityChecker.assertSafeToSend` rejects the mock scorecard, extend `makeEngineResult` to satisfy it rather than weakening the checker).
- [ ] **Step 4: Commit** — `git commit -am "feat: server-owned repo-agent sessions with boundary waiting and lock adapter"`

---

### Task 5: Server routes — session-based start, decide endpoint, context wiring

**Files:**
- Modify: `src/status-server/server-types.ts`, `src/status-server/index.ts`, `src/status-server/routes/core.ts`
- Test: `tests/streamed-repo-agent-endpoint.test.ts` (rewrite/extend)

- [ ] **Step 1: Write/adjust failing endpoint tests** in `tests/streamed-repo-agent-endpoint.test.ts`:

Update the three existing interactive tests: the result frame is now `RepoAgentRunResult` —
- approve test: `RepoAgentRunResultSchema.parse(response.result)` → `status==='completed'`, `output` contains `'wrote it'`; file assertion unchanged.
- deny test: `status==='completed'`, output contains `'gave up'`.
- abort test: **result** frame (no longer an error frame) with `status==='aborted'`; file still absent.

Add new tests:

```ts
const NON_VERDICT_RESPONSE = '{"action":"git","command":"git grep -n \\"x\\" src2"}';

function runsRoot(): string {
  return path.join(process.cwd(), '.siftkit', 'repo-agent', 'runs');
}

test('POST /repo-agent (auto): an escalated approval parks the run and ends the stream with approval_required', async (t) => {
  const harness = await startHarness('siftkit-repo-agent-park-', t);
  const response = await requestSse(`${harness.baseUrl}/repo-agent`, {
    body: {
      prompt: 'write a file', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 4,
      approval: 'auto', availableModels: ['mock-model'],
      mockResponses: [
        '{"action":"write","path":"parked.txt","content":"needs approval"}',
        NON_VERDICT_RESPONSE,
        '{"action":"finish","output":"done after approval"}',
      ],
      mockCommandResults: {},
    },
    timeoutMs: 20_000,
  });
  const boundary = RepoAgentRunResultSchema.parse(response.result);
  assert.equal(boundary.status, 'approval_required');
  if (boundary.status !== 'approval_required') return;
  assert.equal(boundary.approval.toolName, 'write');
  assert.match(boundary.decide.approve, new RegExp(`decide ${boundary.runId} approve`, 'u'));
  // Non-interactive streams never carry the raw approval_request frame.
  assert.equal(response.progress.some((event) => event.kind === 'approval_request'), false);
  // The run store parked server-side.
  const state = RepoAgentRunStateSchema.parse(
    parseJsonValueText(fs.readFileSync(path.join(runsRoot(), boundary.runId, 'state.json'), 'utf8')),
  );
  assert.equal(state.status, 'approval_required');
  // The park is still resumable: approve and stream to completion.
  const decideResponse = await requestSse(`${harness.baseUrl}/repo-agent/decide`, {
    body: { runId: boundary.runId, decision: 'approve' },
    timeoutMs: 20_000,
  });
  const final = RepoAgentRunResultSchema.parse(decideResponse.result);
  assert.equal(final.status, 'completed');
  if (final.status === 'completed') {
    assert.match(final.output, /done after approval/u);
  }
  assert.equal(
    fs.readFileSync(path.join(process.cwd(), 'parked.txt'), 'utf8'),
    'needs approval',
  );
  fs.rmSync(path.join(process.cwd(), 'parked.txt'), { force: true });
});

test('POST /repo-agent: a client disconnect does not abort the run; it still parks', async (t) => {
  const harness = await startHarness('siftkit-repo-agent-detach-', t);
  const body = JSON.stringify({
    prompt: 'write a file', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 4,
    approval: 'auto', availableModels: ['mock-model'],
    mockResponses: [
      '{"action":"write","path":"detached.txt","content":"still parked"}',
      NON_VERDICT_RESPONSE,
      '{"action":"finish","output":"finished later"}',
    ],
    mockCommandResults: {},
  });
  await new Promise<void>((resolve, reject) => {
    const request = http.request(`${harness.baseUrl}/repo-agent`, {
      method: 'POST', agent: testHttpAgent,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body, 'utf8') },
    }, (response) => {
      response.once('data', () => {
        request.destroy();
        resolve();
      });
      response.on('error', () => {});
    });
    request.on('error', (error: Error & { code?: string }) => {
      if (error.message.includes('destroyed') || error.code === 'ECONNRESET') return;
      reject(error);
    });
    request.write(body);
    request.end();
  });
  // Poll the store: the run must reach approval_required despite the dead client.
  const deadline = Date.now() + 15_000;
  let parkedRunId = '';
  while (Date.now() < deadline && !parkedRunId) {
    const entries = fs.existsSync(runsRoot()) ? fs.readdirSync(runsRoot()) : [];
    for (const entry of entries) {
      const statePath = path.join(runsRoot(), entry, 'state.json');
      if (!fs.existsSync(statePath)) continue;
      const state = RepoAgentRunStateSchema.parse(parseJsonValueText(fs.readFileSync(statePath, 'utf8')));
      if (state.status === 'approval_required') parkedRunId = state.runId;
    }
    if (!parkedRunId) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(parkedRunId, 'run never parked after client disconnect');
  const decideResponse = await requestSse(`${harness.baseUrl}/repo-agent/decide`, {
    body: { runId: parkedRunId, decision: 'approve' }, timeoutMs: 20_000,
  });
  assert.equal(RepoAgentRunResultSchema.parse(decideResponse.result).status, 'completed');
  fs.rmSync(path.join(process.cwd(), 'detached.txt'), { force: true });
});

test('POST /repo-agent/decide: unknown run 404s; a session-less active run fails loudly as not resumable', async (t) => {
  const harness = await startHarness('siftkit-repo-agent-resume-', t);
  const missing = await requestSse(`${harness.baseUrl}/repo-agent/decide`, {
    body: { runId: randomUUID(), decision: 'approve' }, timeoutMs: 10_000,
  });
  assert.equal(missing.statusCode, 404);
  // Simulate a server restart: hand-write an active store record with no live session.
  const runId = randomUUID();
  const store = new RepoAgentRunStore(runsRoot());
  store.create(RepoAgentRunRequestSchema.parse({
    runId, task: 'orphaned task', repoRoot: process.cwd(), approval: 'auto', images: [],
  }));
  const orphaned = await requestSse(`${harness.baseUrl}/repo-agent/decide`, {
    body: { runId, decision: 'approve' }, timeoutMs: 10_000,
  });
  const result = RepoAgentRunResultSchema.parse(orphaned.result);
  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.match(result.error, /not resumable/u);
  }
});
```

(Add imports: `randomUUID` from `node:crypto`, `RepoAgentRunResultSchema`, `RepoAgentRunStateSchema`, `RepoAgentRunRequestSchema`, `RepoAgentRunStore`.)

- [ ] **Step 2: Run to verify failure** — `npm run test -- streamed-repo-agent` → FAIL (old protocol, no decide route).

- [ ] **Step 3: Wire the context.** In `server-types.ts` add to `ServerContext`:

```ts
repoAgentRunStore: RepoAgentRunStore;
repoAgentSessions: RepoAgentSessionManager;
```

In `index.ts`: extract `const engineService = new StatusEngineService();` above the ctx literal; in the literal use `engineService,` and add:

```ts
repoAgentRunStore,
repoAgentSessions: new RepoAgentSessionManager({ store: repoAgentRunStore, engine: engineService }),
```

- [ ] **Step 4: Rewrite the routes** in `routes/core.ts`:

1. Collapse `RepoTaskEndpoint`: make `RepoSearchEndpoint` extend `StreamedOperationEndpoint<ParsedRepoSearchRoute>` directly with the search-only behavior (approval mode `interactive`/`off` from the `interactive` flag, `sanitizeNonInteractiveAllowedTools` path, `bypassReadOnlyTools: false`, presetId/taskKind `repo-search`). Delete the abstract class and `RepoAgentEndpoint`.
2. Add the start endpoint:

```ts
class RepoAgentStartEndpoint implements RouteEndpoint {
  async handle(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, _match: RouteMatch): Promise<void> {
    let parsedBody: JsonObject;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch (error) {
      sendBodyReadError(res, toError(error), { error: 'Expected valid JSON object.' });
      return;
    }
    const nestedRunId = String(req.headers[AGENT_RUN_ID_HEADER] || '').trim();
    const ownedActiveLock = nestedRunId
      ? [...ctx.activeModelRequests.values()].find((lock) => lock.ownerRunId === nestedRunId)
      : undefined;
    if (ownedActiveLock) {
      const message = `Rejected self-call from agent run ${nestedRunId}: it holds the model lock, so this request would deadlock behind its own run.`;
      const payload = recordServerError(req, 409, new Error(message), { taskKind: 'repo-search' });
      sendJson(res, 409, { ...payload, modelRequests: getModelRequestQueueDiagnostics(ctx) });
      return;
    }
    const repoSearchRequest = parseRepoSearchRequest(parsedBody);
    if (!repoSearchRequest) {
      sendJson(res, 400, { error: 'Expected prompt.' });
      return;
    }
    const approvalParsed = ApprovalModeSchema.safeParse(parsedBody.approval ?? 'auto');
    if (!approvalParsed.success) {
      sendJson(res, 400, { error: 'approval must be one of: interactive, auto, off.' });
      return;
    }
    const config = readConfig(ctx.configPath);
    const admission = createRepoSearchAdmissionRecord(repoSearchRequest, config);
    upsertRepoSearchAdmission(admission);
    const reader = new JsonRecordReader(parsedBody);
    const runId = randomUUID();
    ctx.repoAgentRunStore.create(RepoAgentRunRequestSchema.parse({
      runId,
      task: repoSearchRequest.prompt,
      repoRoot: admission.repoRoot,
      approval: approvalParsed.data,
      ...(repoSearchRequest.model === null ? {} : { model: repoSearchRequest.model }),
      ...(reader.optionalString('logFile') === undefined ? {} : { logFile: reader.optionalString('logFile') }),
      images: repoSearchRequest.images,
    }));
    const session = ctx.repoAgentSessions.start({
      runId,
      requestId: admission.requestId,
      admission,
      approvalMode: approvalParsed.data,
      locks: new ServerModelLockAdapter(ctx),
      approvalGates: ctx.approvalGates,
      engineRequest: {
        presetId: 'repo-agent',
        taskKind: 'repo-agent',
        prompt: repoSearchRequest.prompt,
        requestId: admission.requestId,
        startedAtUtc: admission.startedAtUtc,
        additionalPromptPrefix: reader.optionalString('promptPrefix'),
        repoRoot: admission.repoRoot,
        statusBackendUrl: `${ctx.getServiceBaseUrl()}/status`,
        config,
        allowedTools: [...INTERACTIVE_REPO_TOOL_NAMES],
        model: reader.optionalString('model'),
        maxTurns: reader.number('maxTurns') ?? undefined,
        logFile: reader.optionalString('logFile'),
        availableModels: Array.isArray(parsedBody.availableModels)
          ? parsedBody.availableModels.map((value) => String(value))
          : undefined,
        mockResponses: Array.isArray(parsedBody.mockResponses)
          ? parsedBody.mockResponses.map((value) => String(value))
          : undefined,
        mockCommandResults: normalizeRepoSearchMockCommandResults(parsedBody.mockCommandResults),
        initialUserImages: repoSearchRequest.images.length > 0 ? repoSearchRequest.images : undefined,
      },
    });
    await streamSessionBoundary(session, req, res, 0);
  }
}
```

3. Add the shared boundary streamer and decide endpoint:

```ts
async function streamSessionBoundary(
  session: RepoAgentSession,
  req: IncomingMessage,
  res: ServerResponse,
  sinceRevision: number,
): Promise<void> {
  const writer = new SseResponseWriter(req, res);
  writer.open();
  const detach = session.attach({
    writeProgress: (event) => writer.writeEvent(OPERATION_STREAM_EVENTS.progress, event),
  });
  res.on('close', detach);
  const result = await session.waitForBoundary(sinceRevision);
  detach();
  writer.writeEvent(OPERATION_STREAM_EVENTS.result, result);
  writer.end();
}

const RepoAgentDecideBodySchema = z.strictObject({
  runId: z.string().uuid(),
  decision: z.enum(['approve', 'deny', 'abort']),
  reason: z.string().trim().min(1).optional(),
});

class RepoAgentDecideEndpoint implements RouteEndpoint {
  async handle(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, _match: RouteMatch): Promise<void> {
    let parsedBody: JsonObject;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch (error) {
      sendBodyReadError(res, toError(error), { error: 'Expected valid JSON object.' });
      return;
    }
    const parsed = RepoAgentDecideBodySchema.safeParse(parsedBody);
    if (!parsed.success) {
      sendJson(res, 400, { error: 'Expected runId, decision (approve|deny|abort), and an optional reason.' });
      return;
    }
    if (parsed.data.decision === 'deny' && parsed.data.reason === undefined) {
      sendJson(res, 400, { error: 'deny requires a non-empty reason.' });
      return;
    }
    const { runId } = parsed.data;
    const session = ctx.repoAgentSessions.get(runId);
    if (!session) {
      let state: RepoAgentRunState;
      try {
        state = ctx.repoAgentRunStore.readState(runId);
      } catch {
        sendJson(res, 404, { error: `Unknown repo-agent run ${runId}.` });
        return;
      }
      const finalState = isTerminalStatus(state.status)
        ? state
        : ctx.repoAgentRunStore.markNotResumable(runId);
      const writer = new SseResponseWriter(req, res);
      writer.open();
      writer.writeEvent(OPERATION_STREAM_EVENTS.result, repoAgentStateToResult(finalState));
      writer.end();
      return;
    }
    const observedRevision = session.currentRevision();
    if (!session.submitDecision(parsed.data)) {
      const payload = recordServerError(req, 409, new Error(`Run ${runId} has no pending approval.`), { taskKind: 'repo-search' });
      sendJson(res, 409, payload);
      return;
    }
    await streamSessionBoundary(session, req, res, observedRevision);
  }
}
```

4. Route table (~line 1862): replace the `/repo-agent` entry and add decide:

```ts
{ method: 'POST', path: '/repo-agent', endpoint: new RepoAgentStartEndpoint() },
{ method: 'POST', path: '/repo-agent/decide', endpoint: new RepoAgentDecideEndpoint() },
```

Imports to add in `core.ts`: `AGENT_RUN_ID_HEADER` (`../../lib/agent-run-marker.js`), `recordServerError` (`../error-response.js`), `SseResponseWriter` (`../sse-response-writer.js`), `OPERATION_STREAM_EVENTS` (`../../lib/operation-stream.js`), `RepoAgentRunRequestSchema`, `RepoAgentRunState`, `isTerminalStatus`, `repoAgentStateToResult` (`../../repo-agent/run-schemas.js`), `RepoAgentSession` type + `ServerModelLockAdapter`, and the admissions module symbols.

- [ ] **Step 5: Verify** — `npm run test -- streamed-repo-agent` → PASS; then `npm run test -- streamed` (other endpoints untouched) and `npm run typecheck:test`. Note `tests/repo-agent-cli.test.ts` and worker tests still pass because they never hit real routes.
- [ ] **Step 6: Commit** — `git commit -am "feat: session-based /repo-agent with boundary result frames and /repo-agent/decide"`

---### Task 6: CLI flip and worker deletion

**Files:**
- Modify: `src/cli/status-server-api-client.ts`, `src/cli/repo-agent-command.ts` (rewrite), `src/cli/run-repo-agent.ts` (rewrite), `src/cli/repo-agent-args.ts`
- Delete: `src/repo-agent/worker.ts`, `src/repo-agent/worker-main.ts`, `src/repo-agent/worker-launcher.ts`, `src/repo-agent/run-approval-prompter.ts`, `src/repo-agent/boundary-waiter.ts`, `src/cli/run-repo-agent-foreground.ts`
- Modify: `src/repo-agent/run-store.ts` (delete decision machinery)
- Tests: rewrite `tests/repo-agent-cli.test.ts`, `tests/repo-agent-command.test.ts`; update `tests/repo-agent-args.test.ts`, `tests/repo-agent-run-store.test.ts`; delete `tests/repo-agent-worker.test.ts`, `tests/repo-agent-worker-launcher.test.ts`, `tests/repo-agent-boundary-waiter.test.ts`, `tests/repo-agent-run-approval-prompter.test.ts`, `tests/repo-agent-foreground.test.ts`

- [ ] **Step 1: args first (TDD).** In `tests/repo-agent-args.test.ts` add:

```ts
test('decide accepts --progress', () => {
  const invocation = parseRepoAgentInvocation(['decide', RUN_ID, 'approve', '--progress']);
  assert.equal(invocation.kind, 'decide');
  if (invocation.kind === 'decide') assert.equal(invocation.progress, true);
});
```

(`RUN_ID` = any fixture UUID already used in the file.) Run `npm run test -- repo-agent-args` → FAIL. Implement: add `progress: z.boolean()` to `RepoAgentDecideInvocationSchema`; in `parseDecideInvocation` initialize `let progress = false;`, handle the `--progress` token in the loop, and include `progress` in the built invocation. Re-run → PASS.

- [ ] **Step 2: API client.** In `status-server-api-client.ts`:

```ts
import { RepoAgentRunResultSchema, type RepoAgentRunResult } from '../repo-agent/run-schemas.js';

export type RepoAgentDecideRequest = {
  runId: string;
  decision: 'approve' | 'deny' | 'abort';
  reason?: string;
};
```

Change `requestRepoAgent` to return `Promise<RepoAgentRunResult>` using `RepoAgentRunResultSchema`, and add:

```ts
  requestRepoAgentDecide(
    request: RepoAgentDecideRequest,
    renderer: CliProgressRenderer,
  ): Promise<RepoAgentRunResult> {
    return this.requestStreamedOperation(
      '/repo-agent/decide',
      JSON.stringify(request),
      RepoAgentRunResultSchema,
      renderer,
      'repo-agent',
      undefined,
      this.repoAgentIdleTimeoutMs,
    );
  }
```

- [ ] **Step 3: Command unit tests (failing).** Rewrite `tests/repo-agent-command.test.ts` around a fake API port:

```ts
type RepoAgentApi = Pick<StatusServerApiClient, 'requestRepoAgent' | 'requestRepoAgentDecide'>;
```

Define the port in `repo-agent-command.ts` (Step 4) and fake it in tests:

```ts
class FakeApi {
  startCalls: Record<string, JsonSerializable>[] = [];
  decideCalls: RepoAgentDecideRequest[] = [];
  constructor(private readonly result: RepoAgentRunResult) {}
  requestRepoAgent(request: Record<string, JsonSerializable>): Promise<RepoAgentRunResult> {
    this.startCalls.push(request);
    return Promise.resolve(this.result);
  }
  requestRepoAgentDecide(request: RepoAgentDecideRequest): Promise<RepoAgentRunResult> {
    this.decideCalls.push(request);
    return Promise.resolve(this.result);
  }
}
```

Cover: start→completed exits 0 with the result JSON on stdout; start→approval_required exits 3 with stderr banner (matches `/Exiting: approval required/`, the three decide commands) and JSON on stdout; decide→completed exits 0 and passed `{runId, decision}` through; status reads a store fixture (reuse a temp-dir store, write `running` with a dead pid → command output shows `failed`); `--approval interactive` without TTY stdin throws. Instantiate the command with the fake and capture streams via `makeCaptureStream()`.

- [ ] **Step 4: Rewrite `repo-agent-command.ts`:**

```ts
import { ensureStatusServerReachable } from '../config/index.js';
import type { JsonSerializable } from '../lib/json-types.js';
import {
  RepoAgentRunResultSchema,
  type RepoAgentRunResult,
} from '../repo-agent/run-schemas.js';
import type { RepoAgentRunStore } from '../repo-agent/run-store.js';
import { CliApprovalPrompter, type ApprovalPrompter } from './approval-prompter.js';
import { CliProgressRenderer } from './progress-renderer.js';
import type { RepoAgentInvocation } from './repo-agent-args.js';
import { REPO_AGENT_EXIT_CODES } from './repo-agent-help.js';
import { buildRepoAgentServerRequest } from './repo-agent-request.js';
import type { RepoAgentDecideRequest, StatusServerApiClient } from './status-server-api-client.js';
import { assertStdinIsTty } from './tty.js';

export type RepoAgentApi = Pick<StatusServerApiClient, 'requestRepoAgent' | 'requestRepoAgentDecide'>;

export type RepoAgentCommandStreams = {
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

function buildApprovalRequiredNotice(
  result: Extract<RepoAgentRunResult, { status: 'approval_required' }>,
): string {
  const lines = [
    'Exiting: approval required before the agent may continue.',
    `Run: ${result.runId}`,
    `Tool: ${result.approval.toolName}`,
    `Command: ${result.approval.command}`,
  ];
  if (result.approval.reviewPayload !== null) {
    lines.push('Review payload:', result.approval.reviewPayload);
  }
  lines.push(
    'Respond with one of:',
    `  ${result.decide.approve}`,
    `  ${result.decide.deny}`,
    `  ${result.decide.abort}`,
  );
  return `${lines.join('\n')}\n`;
}

/** Write + wait for the chunk to reach the OS pipe, so process.exit cannot truncate it. */
function writeFlushed(stream: NodeJS.WritableStream, text: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    stream.write(text, (error) => (error ? rejectPromise(error) : resolvePromise()));
  });
}

export class RepoAgentCommand {
  private readonly api: RepoAgentApi;
  private readonly store: RepoAgentRunStore;

  constructor(options: { api: RepoAgentApi; store: RepoAgentRunStore }) {
    this.api = options.api;
    this.store = options.store;
  }

  async run(invocation: RepoAgentInvocation, streams: RepoAgentCommandStreams): Promise<number> {
    switch (invocation.kind) {
      case 'start':
        return this.runStart(invocation, streams);
      case 'decide':
        return this.runDecide(invocation, streams);
      case 'status':
        return this.runStatus(invocation, streams);
    }
  }

  private async runStart(
    invocation: Extract<RepoAgentInvocation, { kind: 'start' }>,
    streams: RepoAgentCommandStreams,
  ): Promise<number> {
    await ensureStatusServerReachable();
    const interactive = invocation.approval === 'interactive';
    assertStdinIsTty(interactive, streams.stdin, 'repo-agent interactive approval');
    const prompter: ApprovalPrompter | undefined = interactive && streams.stdin
      ? new CliApprovalPrompter({ input: streams.stdin, output: streams.stderr })
      : undefined;
    const renderer = CliProgressRenderer.forCli(streams.stderr, 'repo-agent', invocation.progress);
    const request: Record<string, JsonSerializable> = buildRepoAgentServerRequest({
      task: invocation.task,
      repoRoot: process.cwd(),
      approval: invocation.approval,
      images: invocation.images,
      ...(invocation.model === undefined ? {} : { model: invocation.model }),
      ...(invocation.logFile === undefined ? {} : { logFile: invocation.logFile }),
    });
    const result = await this.api.requestRepoAgent(request, renderer, prompter);
    return this.writeResult(result, streams);
  }

  private async runDecide(
    invocation: Extract<RepoAgentInvocation, { kind: 'decide' }>,
    streams: RepoAgentCommandStreams,
  ): Promise<number> {
    await ensureStatusServerReachable();
    const renderer = CliProgressRenderer.forCli(streams.stderr, 'repo-agent', invocation.progress);
    const request: RepoAgentDecideRequest = {
      runId: invocation.runId,
      decision: invocation.decision,
      ...(invocation.reason === undefined ? {} : { reason: invocation.reason }),
    };
    const result = await this.api.requestRepoAgentDecide(request, renderer);
    return this.writeResult(result, streams);
  }

  private async runStatus(
    invocation: Extract<RepoAgentInvocation, { kind: 'status' }>,
    streams: RepoAgentCommandStreams,
  ): Promise<number> {
    const state = this.store.reconcile(invocation.runId);
    await writeFlushed(streams.stdout, `${JSON.stringify(state)}\n`);
    return 0;
  }

  private async writeResult(
    input: RepoAgentRunResult,
    streams: RepoAgentCommandStreams,
  ): Promise<number> {
    const result = RepoAgentRunResultSchema.parse(input);
    if (result.status === 'approval_required') {
      await writeFlushed(streams.stderr, buildApprovalRequiredNotice(result));
    }
    await writeFlushed(streams.stdout, `${JSON.stringify(result)}\n`);
    return REPO_AGENT_EXIT_CODES[result.status];
  }
}
```

Rewrite `run-repo-agent.ts`:

```ts
import { join } from 'node:path';
import { getRuntimeRoot } from '../config/index.js';
import { RepoAgentRunStore } from '../repo-agent/run-store.js';
import type { RepoAgentInvocation } from './repo-agent-args.js';
import { RepoAgentCommand } from './repo-agent-command.js';
import { StatusServerApiClient } from './status-server-api-client.js';

export async function runRepoAgentCli(options: {
  invocation: RepoAgentInvocation;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
}): Promise<number> {
  const command = new RepoAgentCommand({
    api: new StatusServerApiClient(),
    store: new RepoAgentRunStore(join(getRuntimeRoot(), 'repo-agent', 'runs')),
  });
  return command.run(options.invocation, options);
}
```

Check `assertStdinIsTty`'s signature in `src/cli/tty.ts` and adjust the call if its message argument differs.

- [ ] **Step 5: Delete the worker flow.** Remove the six source files listed above and the five test files. In `run-store.ts` delete `submitDecision`, `consumeDecision`, `readDecisionFile`, `decisionPath`, `decisionClaimPath`, the decision-existence check in `publishApproval`, and the two decision `rmSync` lines in `clearPendingApproval`; delete their tests from `tests/repo-agent-run-store.test.ts`. Grep for stragglers and fix every hit: `Grep "worker-launcher|worker-main|boundary-waiter|run-approval-prompter|run-repo-agent-foreground|repo-task-output|RepoAgentWorker"` across `src/`, `tests/`, `scripts/` (the dist-sync script may list worker-main as a runtime entrypoint — remove it there too).

- [ ] **Step 6: CLI e2e tests.** Rewrite `tests/repo-agent-cli.test.ts` against the new protocol. Keep the spawned-binary harness; the mock server now:
  - `/repo-agent` (`approval` mode): streams two progress frames (`{kind:'llm_start', turn:1, maxTurns:4, promptTokenCount:100}`, `{kind:'tool_start', turn:1, maxTurns:4, command:'npm install left-pad'}`) then a result frame `{status:'approval_required', runId, approval:{approvalId, toolName:'run', command:'npm install left-pad', reviewPayload:null}, decide:{approve:..., deny:..., abort:...}}` (build with `buildRepoAgentDecideCommands(runId)`).
  - `/repo-agent` (`complete` mode): result frame `{status:'completed', runId, output:'foreground complete'}`.
  - `/repo-agent/decide`: result frame `{status:'completed', runId, output:'resumed and finished'}`.

  Assertions:
  1. Non-TTY start against `approval` server, with `--progress`: exit code 3; stdout parses as `RepoAgentRunResultSchema` with `status==='approval_required'`; stderr contains the banner and both progress lines (`npm install left-pad`).
  2. Same without `--progress`: stderr contains the banner but no `tool_start` line.
  3. Start against `complete` server: exit 0, stdout result JSON `status==='completed'`.
  4. `decide <runId> approve` against the mock: exit 0, `status==='completed'`, and the mock recorded body `{runId, decision:'approve'}`.
  5. The stdout JSON must be complete/parseable (this is the flush regression guard — it runs through the real spawned process and `process.exit`).

- [ ] **Step 7: Full verify** — `npm run test -- repo-agent` (all files), then the whole suite `npm run test`, `npm run typecheck`, `npm run lint`.
- [ ] **Step 8: Commit** — `git commit -am "feat: foreground repo-agent CLI with boundary exits; delete detached worker flow"`

---

### Task 7: Help text, docs, and final gate

**Files:**
- Modify: `src/cli/repo-agent-help.ts`, `tests/cli-help.test.ts`

- [ ] **Step 1:** Update `repo-agent-help.ts`:
  - `--progress` description → `'Stream progress lines to stderr.'`
  - Add a decide-flag mention: extend the decide example list with `'siftkit repo-agent decide <run-id> approve --progress'`.
  - Update any prose describing the detached worker/status polling flow to describe the new contract: the command streams progress and exits at a boundary; `approval_required` (exit 3) parks the run server-side; `decide` resumes it and streams to the next boundary; a server restart makes parked runs fail loudly as not resumable.
- [ ] **Step 2:** Run `npm run test -- cli-help`; update the assertion strings in `tests/cli-help.test.ts` to match the new wording exactly (the test failures show the diffs). No behavioral changes.
- [ ] **Step 3: Final gate** — `npm run test`, `npm run typecheck`, `npm run lint` all clean.
- [ ] **Step 4: Commit** — `git commit -am "docs: repo-agent help reflects server-owned run flow"`

---

## Self-review checklist (done during planning)

- Spec §1/§3 (streaming + boundary exit + flush) → Tasks 5, 6. Spec §2 (server keeps context) → Task 4 session owns engine + gate; abort signal never tied to a connection. Spec §4 (disconnect never aborts) → Task 5 `res.on('close', detach)` + disconnect test. Spec §5 (server-pid store, status reconcile) → Tasks 2, 4, 6. Spec §6 (restart handling) → Task 2 `markNotResumable` + Task 5 decide fallback + test. Spec §7 (transcripts) → unchanged engine persistence; restart-resume explicitly out of scope.
- Type consistency: `RepoAgentRunRequestSchema` (T2) used in T5/T6; `repoAgentStateToResult`/`buildRepoAgentDecideCommands` (T2) used in T5/T6 tests; `ApprovalGateObserver` (T1) implemented by `RepoAgentSession` (T4); `RepoAgentApi` port (T6) satisfied by `StatusServerApiClient` after its return-type change (T6 Step 2 precedes Step 3/4).
- Known verification points for the executor (compile-guided, not placeholders): `ApprovalGateHarness` constructor shape (T1), `assertStdinIsTty` signature (T6), dist-sync script worker-main reference (T6 Step 5), sanity-checker acceptance of the mock scorecard (T4 Step 3).

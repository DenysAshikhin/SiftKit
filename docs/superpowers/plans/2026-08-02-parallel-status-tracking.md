# Parallel Status Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track arbitrary simultaneous requests independently, allow different chat sessions and CLI/CMD work to run or queue concurrently, and reject a second mutation of the same chat session until its active operation finishes.

**Architecture:** Replace status-path ownership maps with a `StatusRunRegistry` keyed only by `requestId`, with explicit active, awaiting-metadata, and completed phases. Add a `ChatSessionOperationRegistry` keyed by `sessionId`, then replace global dashboard stream state and callback-driven stream consumption with session-keyed runtime state and typed async event iteration.

**Tech Stack:** TypeScript 5.9, Node.js HTTP/SSE, React 19, Zod 4, Node test runner, tsx, c8.

**Design spec:** `docs/superpowers/specs/2026-08-02-parallel-status-tracking-design.md`

## Global Constraints

- Use TDD exclusively: every production behavior begins with a failing test.
- Prefer real HTTP/SSE E2E coverage over unit tests; use unit tests only for deterministic registry branches.
- Use TypeScript throughout.
- Do not use type assertions, `any`, non-null assertions, or namespace imports.
- Derive IO-boundary types from Zod schemas with `z.infer`.
- Use explicit class methods and explicit event switches; do not pass behavior through dynamic callbacks.
- Reuse existing HTTP, SSE, server-fixture, and live-message helpers.
- Remove replaced status-path ownership and callback-streaming APIs completely; do not retain compatibility shims.
- Keep the implementation direct and DRY; do not add a generic lock wrapper that accepts functions.
- Do not use a git worktree.
- Status tracking adds no concurrency limit. Existing EXL3 and llama.cpp admission policies remain authoritative.
- One chat session permits one active message, plan, or repo-search operation. Same-session conflicts return `409` and never queue.
- Different chat sessions and CLI/CMD requests remain independent.
- `TERMINAL_SNAPSHOT_RETENTION_MS` is 300,000 ms; `COMPLETED_REQUEST_RETENTION_MS` is 900,000 ms.
- New registry classes and every changed concurrency/error branch require 100% branch coverage; repository-wide coverage must not decrease.
- Use `siftkit` first for discovery, diffs, logs, and test-output interpretation, with specific extraction prompts and 15-minute command timeouts.

---

## File Structure

### New files

- `src/status-server/status-run-registry.ts` — owns active, awaiting-terminal-metadata, and completed request lifecycle state.
- `src/status-server/chat-session-operation-registry.ts` — owns one lease per chat session.
- `tests/status-run-registry.test.ts` — deterministic lifecycle and expiry branch coverage.
- `tests/parallel-status-server.test.ts` — real HTTP status lifecycle and metrics idempotency E2E coverage.
- `tests/chat-session-operation-registry.test.ts` — deterministic lease acquisition/release coverage.
- `tests/dashboard-chat-concurrency.test.ts` — real HTTP/SSE same-session rejection and different-session concurrency coverage.
- `dashboard/src/lib/chat-session-runtime-store.ts` — immutable per-session dashboard runtime state.
- `dashboard/tests/chat-session-runtime-store.test.ts` — session isolation and state transition coverage.

### Renamed files

- `dashboard/src/hooks/useLiveMessages.ts` -> `dashboard/src/lib/chat-live-messages.ts` — retain only pure message builders/updaters; remove the global hook.
- `dashboard/tests/hooks/useLiveMessages.test.tsx` -> `dashboard/tests/chat-live-messages.test.ts` — preserve helper coverage without the removed hook.

### Modified files

- `packages/contracts/src/system.ts` — public active-status-run schema.
- `packages/contracts/src/chat.ts` — typed same-session conflict response schema.
- `tests/contracts-system.test.ts` — status response schema coverage.
- `tests/contracts-chat.test.ts` — conflict response schema coverage.
- `src/config/status-backend.ts` — parse `activeRuns` in `GET /status` responses.
- `src/status-server/server-types.ts` — replace raw lifecycle maps with registry instances.
- `src/status-server/index.ts` — instantiate both registries.
- `src/status-server/server-ops.ts` — derive aggregate activity from `StatusRunRegistry`; remove obsolete path-keyed helpers.
- `src/status-server/routes/core.ts` — require request IDs, route all lifecycle transitions through the registry, expose `activeRuns`, and preserve terminal idempotency.
- `src/status-server/routes/chat.ts` — acquire and release session leases in all six generation endpoints.
- `scripts/test-targets.ts` — add deterministic recursive dashboard-test target resolution.
- `tests/test-targets.test.ts` — cover dashboard target discovery and option removal.
- `tests/helpers/server-context-fixture.ts` — construct both registries.
- `tests/helpers/dashboard-model-queue-harness.ts` — expose controlled concurrent-chat helpers.
- `tests/model-request-queue.test.ts` — remove obsolete completed-status-path tests while retaining model queue tests.
- `tests/summary-status-server.test.ts` — assert concurrent request identity rather than path replacement.
- `tests/dashboard-status-server.test.ts` — change same-session FIFO acceptance to immediate conflict.
- `tests/runtime-cli.test.ts` — prove simultaneous CLI request IDs remain independently visible.
- `dashboard/src/api.ts` — return typed async SSE event iterators and parse `409` payloads.
- `package.json` — add an explicit dashboard test command that executes all `.test.ts` and `.test.tsx` files without shell glob assumptions.
- `dashboard/src/hooks/useChatSessions.ts` — remove global busy state and apply responses by session ID.
- `dashboard/src/hooks/useChatComposer.ts` — capture the initiating session and explicitly consume its event iterator.
- `dashboard/src/hooks/useChatController.ts` — compose selected and per-session runtime state.
- `dashboard/src/tabs/ChatTab.tsx` — render per-session indicators and selected-session controls.
- `dashboard/tests/api-stream.test.ts` — iterator, missing-terminal-event, and conflict coverage.
- `dashboard/tests/hooks/useChatComposer.test.tsx` — captured-session streaming behavior.
- `dashboard/tests/hooks/useChatSessions.test.tsx` — response application to non-selected sessions.
- `dashboard/tests/chat-session-state.test.ts` — per-session indicator behavior.
- `dashboard/tests/chat-tab.test.tsx` — selected-session disabling and cross-session availability.
- `README.md` — document `GET /status.activeRuns` and per-session chat exclusion.
- `docs/exl3-backend-setup.md` — align status/concurrency wording with backend-aware admission.

### Removed files

- `dashboard/src/hooks/useContextUsage.ts` — state moves into `ChatSessionRuntimeStore`.
- `dashboard/src/hooks/usePlanInputs.ts` — per-session inputs move into `ChatSessionRuntimeStore`.
- `dashboard/tests/hooks/useContextUsage.test.tsx` — replaced by runtime-store coverage.
- `dashboard/tests/hooks/usePlanInputs.test.tsx` — replaced by runtime-store coverage.

---

### Task 1: Define public status/conflict contracts and the request registry

**Files:**
- Modify: `packages/contracts/src/system.ts`
- Modify: `packages/contracts/src/chat.ts`
- Modify: `tests/contracts-system.test.ts`
- Modify: `tests/contracts-chat.test.ts`
- Create: `src/status-server/status-run-registry.ts`
- Create: `tests/status-run-registry.test.ts`

**Interfaces:**
- Produces: `ActiveStatusRunSchema`, `ActiveStatusRun`, `ChatSessionBusyResponseSchema`, `ChatSessionBusyResponse`.
- Produces: `StatusRunRegistry.startOrAdvance()`, `.markComplete()`, `.resolveTerminalRun()`, `.finalizeTerminal()`, `.getActiveRuns()`, `.hasActiveRuns()`, `.pruneExpired()`.
- Consumes: `TaskMetricKindSchema`, current run timing/progress fields, and explicit `nowMs` values.

- [ ] **Step 1: Add failing contract tests**

Add schema tests that parse a complete active-run payload and same-session conflict, then reject missing identity fields:

```ts
test('ActiveStatusRunSchema requires request identity and operational timing', () => {
  const parsed = ActiveStatusRunSchema.parse({
    requestId: 'request-a',
    statusPath: 'C:/runtime/status.txt',
    taskKind: 'chat',
    startedAtUtc: '2026-08-02T18:52:53.000Z',
    currentStepStartedAtUtc: '2026-08-02T18:52:54.000Z',
    stepCount: 2,
    chunkIndex: null,
    chunkTotal: null,
  });
  assert.equal(parsed.requestId, 'request-a');
  assert.throws(() => ActiveStatusRunSchema.parse({ statusPath: 'x' }));
});

test('ChatSessionBusyResponseSchema preserves the conflicting session', () => {
  const parsed = ChatSessionBusyResponseSchema.parse({
    error: 'Chat session already has an active operation.',
    sessionId: 'session-a',
    operationKind: 'message',
  });
  assert.equal(parsed.sessionId, 'session-a');
});
```

- [ ] **Step 2: Run the contract tests and verify RED**

Run:

```powershell
npm test -- contracts-system contracts-chat
```

Expected: FAIL because the new schemas are not exported.

- [ ] **Step 3: Add the contract schemas**

Add schemas derived from existing task-kind contracts:

```ts
export const ActiveStatusRunSchema = z.object({
  requestId: z.string().min(1),
  statusPath: z.string().min(1),
  taskKind: TaskMetricKindSchema.nullable(),
  startedAtUtc: z.string().min(1),
  currentStepStartedAtUtc: z.string().min(1),
  stepCount: z.number().int().positive(),
  chunkIndex: z.number().int().nonnegative().nullable(),
  chunkTotal: z.number().int().positive().nullable(),
});
export type ActiveStatusRun = z.infer<typeof ActiveStatusRunSchema>;

export const ChatSessionOperationKindSchema = z.enum(['message', 'plan', 'repo-search']);
export const ChatSessionBusyResponseSchema = z.object({
  error: z.literal('Chat session already has an active operation.'),
  sessionId: z.string().min(1),
  operationKind: ChatSessionOperationKindSchema,
});
export type ChatSessionBusyResponse = z.infer<typeof ChatSessionBusyResponseSchema>;
```

Import `TaskMetricKindSchema` into `system.ts`; keep all types inferred from the schemas.

- [ ] **Step 4: Add failing `StatusRunRegistry` lifecycle tests**

Cover these independent branches with explicit timestamps:

```ts
function buildStart(requestId: string, nowMs: number) {
  return {
    requestId,
    statusPath: 'C:/runtime/status.txt',
    taskKind: 'chat' as const,
    nowMs,
    rawInputCharacterCount: 10,
    promptCharacterCount: 20,
    promptTokenCount: 5,
    chunkIndex: null,
    chunkTotal: null,
    chunkPath: null,
    managedLlamaSpeculativeSnapshot: null,
  };
}

test('parallel requests sharing a status path remain independently active', () => {
  const registry = new StatusRunRegistry();
  registry.startOrAdvance(buildStart('request-a', 1_000));
  registry.startOrAdvance(buildStart('request-b', 2_000));
  assert.deepEqual(
    registry.getActiveRuns(2_000).map((run) => run.requestId),
    ['request-a', 'request-b'],
  );
});

test('completion moves only the matching request out of active reporting', () => {
  const registry = new StatusRunRegistry();
  registry.startOrAdvance(buildStart('request-a', 1_000));
  registry.startOrAdvance(buildStart('request-b', 2_000));
  assert.equal(registry.markComplete('request-b', 'completed', 3_000).kind, 'completed');
  assert.deepEqual(registry.getActiveRuns(3_000).map((run) => run.requestId), ['request-a']);
});
```

Also cover advance, duplicate completion, metadata-before-completion, metadata-after-completion, unknown metadata, five-minute terminal expiry, fifteen-minute tombstone expiry, deterministic ordering, and failed completion.

- [ ] **Step 5: Run the registry tests and verify RED**

Run:

```powershell
npm test -- status-run-registry
```

Expected: FAIL because `StatusRunRegistry` does not exist.

- [ ] **Step 6: Implement the minimal registry**

Use a class with private maps and explicit time inputs:

```ts
export const TERMINAL_SNAPSHOT_RETENTION_MS = 300_000;
export const COMPLETED_REQUEST_RETENTION_MS = 900_000;

export class StatusRunRegistry {
  private readonly activeRuns = new Map<string, ActiveRunState>();
  private readonly awaitingTerminalMetadata = new Map<string, TerminalRunState>();
  private readonly completedAtByRequestId = new Map<string, number>();

  startOrAdvance(input: StatusRunStartInput): StatusRunStartResult;
  markComplete(requestId: string, terminalState: CompletedStatusTerminalState, nowMs: number): StatusRunCompleteResult;
  resolveTerminalRun(requestId: string, nowMs: number): StatusTerminalResolution;
  finalizeTerminal(requestId: string, nowMs: number): StatusTerminalFinalizeResult;
  getActiveRuns(nowMs: number): ActiveStatusRun[];
  hasActiveRuns(nowMs: number): boolean;
  pruneExpired(nowMs: number): ExpiredStatusRun[];
}
```

Derive internal run-state aliases with `ReturnType` from explicit builders. Never expose the maps or accept a callback.

Define every lifecycle type from explicit builders:

```ts
function buildStatusRunStartInput(
  requestId: string,
  statusPath: string,
  metadata: StatusMetadata,
  taskKind: TaskKind | null,
  managedLlamaSpeculativeSnapshot: ManagedLlamaSpeculativeMetricsSnapshot | null,
  nowMs: number,
) {
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

type StatusRunStartInput = ReturnType<typeof buildStatusRunStartInput>;
type CompletedStatusTerminalState = Exclude<StatusMetadata['terminalState'], null>;

function createActiveRunState(input: StatusRunStartInput) {
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

function createTerminalRunState(run: ActiveRunState | null, terminalState: CompletedStatusTerminalState, completedAtMs: number) {
  return { run, terminalState, completedAtMs };
}

function createStartedResult(run: ActiveRunState) { return { kind: 'started' as const, run }; }
function createAdvancedResult(run: ActiveRunState) { return { kind: 'advanced' as const, run }; }
function createLateResult(requestId: string) { return { kind: 'late' as const, requestId }; }
function createCompletedResult(run: TerminalRunState) { return { kind: 'completed' as const, run }; }
function createCompletedWithoutRunResult(run: TerminalRunState) {
  return { kind: 'completed-without-run' as const, run };
}
function createDuplicateResult(requestId: string) { return { kind: 'duplicate' as const, requestId }; }
function createUnknownResult(requestId: string) { return { kind: 'unknown' as const, requestId }; }
function createActiveTerminalResolution(run: ActiveRunState) { return { kind: 'active' as const, run }; }
function createAwaitingTerminalResolution(run: TerminalRunState) { return { kind: 'awaiting' as const, run }; }
function createFinalizedResult(requestId: string) { return { kind: 'finalized' as const, requestId }; }
function createExpiredStatusRun(requestId: string, phase: 'awaiting-terminal-metadata' | 'completed') {
  return { requestId, phase };
}

type ActiveRunState = ReturnType<typeof createActiveRunState>;
type TerminalRunState = ReturnType<typeof createTerminalRunState>;
type StatusRunStartResult =
  | ReturnType<typeof createStartedResult>
  | ReturnType<typeof createAdvancedResult>
  | ReturnType<typeof createLateResult>;
type StatusRunCompleteResult =
  | ReturnType<typeof createCompletedResult>
  | ReturnType<typeof createCompletedWithoutRunResult>
  | ReturnType<typeof createDuplicateResult>;
type StatusTerminalResolution =
  | ReturnType<typeof createActiveTerminalResolution>
  | ReturnType<typeof createAwaitingTerminalResolution>
  | ReturnType<typeof createDuplicateResult>
  | ReturnType<typeof createUnknownResult>;
type StatusTerminalFinalizeResult =
  | ReturnType<typeof createFinalizedResult>
  | ReturnType<typeof createDuplicateResult>
  | ReturnType<typeof createUnknownResult>;
type ExpiredStatusRun = ReturnType<typeof createExpiredStatusRun>;
```

`StatusRunStartInput` is inferred from the existing parsed status metadata builder plus required `requestId`, normalized task kind, captured speculative snapshot, and `nowMs`; do not duplicate the HTTP schema as a handwritten boundary type.

- [ ] **Step 7: Run focused tests and coverage**

Run:

```powershell
npm test -- contracts-system contracts-chat status-run-registry
npm run build:test
npx c8 --include="src/status-server/status-run-registry.ts" --reporter=text node --import tsx --test tests/status-run-registry.test.ts
```

Expected: PASS; `status-run-registry.ts` reports 100% branch coverage.

- [ ] **Step 8: Commit Task 1**

```powershell
git add packages/contracts/src/system.ts packages/contracts/src/chat.ts tests/contracts-system.test.ts tests/contracts-chat.test.ts src/status-server/status-run-registry.ts tests/status-run-registry.test.ts
git commit -m "feat: add request keyed status registry"
```

---

### Task 2: Integrate request-keyed lifecycle into the status server

**Files:**
- Modify: `src/config/status-backend.ts`
- Modify: `src/status-server/server-types.ts`
- Modify: `src/status-server/index.ts`
- Modify: `src/status-server/server-ops.ts`
- Modify: `src/status-server/routes/core.ts`
- Modify: `tests/helpers/server-context-fixture.ts`
- Modify: `tests/model-request-queue.test.ts`
- Modify: `tests/summary-status-server.test.ts`
- Create: `tests/parallel-status-server.test.ts`

**Interfaces:**
- Consumes: `StatusRunRegistry` and `ActiveStatusRunSchema` from Task 1.
- Produces: `ServerContext.statusRuns: StatusRunRegistry`.
- Produces: `GET /status.activeRuns: ActiveStatusRun[]`.
- Removes: raw run maps, status-path completion helpers, legacy request ID fallback, and abandonment logging.

- [ ] **Step 1: Add failing real-HTTP parallel lifecycle tests**

Use `DashboardTestServer` and `requestJson` to post two running statuses with the same path:

```ts
function postRunning(baseUrl: string, requestId: string) {
  return requestJson(`${baseUrl}/status`, {
    method: 'POST',
    body: JSON.stringify({
      running: true,
      requestId,
      taskKind: 'chat',
      rawInputCharacterCount: 10,
      promptCharacterCount: 20,
      promptTokenCount: 5,
    }),
  });
}

test('status endpoint tracks concurrent request ids sharing one path', async () => {
  const server = await DashboardTestServer.start('siftkit-parallel-status-');
  try {
    await postRunning(server.baseUrl, 'request-a');
    await postRunning(server.baseUrl, 'request-b');
    const status = await requestJson(`${server.baseUrl}/status`);
    assert.deepEqual(
      asObjectArray(status.body.activeRuns).map((run) => run.requestId),
      ['request-a', 'request-b'],
    );
    assert.equal(status.body.running, true);
  } finally {
    await server.close();
  }
});
```

Add cases for out-of-order completion, completion-before-running creating a tombstone, missing `requestId` returning `400`, exact-request late-update suppression, metadata-before-completion, metadata-after-completion, duplicate terminal metadata, and aggregate `running=false` only after the last request finishes.

- [ ] **Step 2: Run the status E2E and verify RED**

Run:

```powershell
npm test -- parallel-status-server
```

Expected: FAIL because the second request replaces the first and `activeRuns` is absent.

- [ ] **Step 3: Replace raw context maps with the registry**

Change the context shape and initialization:

```ts
export type ServerContext = {
  // existing fields
  statusRuns: StatusRunRegistry;
};
```

Task 2 initializes only `statusRuns`. Task 3 independently adds `chatSessionOperations` after its class exists.

Remove `ActiveRunState`, `activeRunsByRequestId`, `activeRequestIdByStatusPath`, and `completedRequestIdByStatusPath` from `server-types.ts`.

- [ ] **Step 4: Route status reads and lifecycle transitions through explicit methods**

Update aggregate activity:

```ts
export function hasActiveRuns(ctx: ServerContext): boolean {
  return ctx.statusRuns.hasActiveRuns(Date.now());
}
```

Update `StatusReadEndpoint`:

```ts
const nowMs = Date.now();
sendJson(res, 200, {
  running: currentStatus === STATUS_TRUE,
  status: currentStatus,
  statusPath,
  configPath,
  metrics: ctx.metrics,
  idleSummarySnapshotsPath: ctx.idleSummarySnapshotsPath,
  modelRequests: getModelRequestQueueDiagnostics(ctx),
  activeRuns: ctx.statusRuns.getActiveRuns(nowMs),
});
```

The E2E asserts that serialized `activeRuns` entries contain none of the submitted prompt, generated answer, image, credential, or raw-input fields.

At both status POST routes, reject `metadata.requestId === null` with `400`. Replace direct map reads/writes in `StatusPostRequestHandler`, `StatusCompleteEndpoint`, and terminal metadata processing with registry results and explicit `switch` statements.

Call `pruneExpired(nowMs)` from status lifecycle operations and `GET /status`. Log each returned awaiting-metadata expiry as `terminal_snapshot_expired`; tombstone expiry is silent. Expiry never changes an active run.

- [ ] **Step 5: Remove the superseded implementation completely**

Delete these identifiers and their tests:

```text
MAX_COMPLETED_STATUS_PATH_ENTRIES
rememberCompletedStatusRequestId
clearCompletedStatusRequestIdForDifferentRequest
getResolvedRequestId
clearRunState
logAbandonedRun
stale_status_abandoned
```

Move the relevant completed-ID coverage from `model-request-queue.test.ts` into `status-run-registry.test.ts`. Do not leave aliases or forwarding helpers.

- [ ] **Step 6: Parse `activeRuns` at the status client boundary**

Extend the existing local response schema:

```ts
const StatusSnapshotResponseSchema = z.object({
  metrics: StatusMetricsSnapshotSchema.optional(),
  activeRuns: z.array(ActiveStatusRunSchema),
}).loose();
```

Keep `StatusSnapshotResponse` inferred from this schema.

- [ ] **Step 7: Verify status lifecycle and metrics idempotency**

Run:

```powershell
npm test -- status-run-registry parallel-status-server summary-status-server model-request-queue config
npm run typecheck
```

Expected: PASS; two requests on one path remain visible, terminal permutations count all runtime and per-task metrics once, and the abandonment event no longer exists.

- [ ] **Step 8: Commit Task 2**

```powershell
git add src/config/status-backend.ts src/status-server/server-types.ts src/status-server/index.ts src/status-server/server-ops.ts src/status-server/routes/core.ts tests/helpers/server-context-fixture.ts tests/model-request-queue.test.ts tests/summary-status-server.test.ts tests/parallel-status-server.test.ts
git commit -m "refactor: track status runs by request id"
```

---

### Task 3: Enforce one active generation per chat session

**Files:**
- Create: `src/status-server/chat-session-operation-registry.ts`
- Create: `tests/chat-session-operation-registry.test.ts`
- Modify: `src/status-server/server-types.ts`
- Modify: `src/status-server/index.ts`
- Modify: `src/status-server/routes/chat.ts`
- Modify: `tests/helpers/server-context-fixture.ts`
- Modify: `tests/dashboard-status-server.test.ts`

**Interfaces:**
- Consumes: `ChatSessionOperationKind` inferred from Task 1's contract schema.
- Produces: `ChatSessionOperationRegistry.acquire()`, `.release()`, `.getActiveOperation()`, `.getActiveCount()`.
- Produces: `ServerContext.chatSessionOperations`.
- Produces: HTTP `409` for same-session generation conflicts.

- [ ] **Step 1: Add failing lease tests**

```ts
function requireAcquired(result: ChatSessionOperationAcquireResult): ChatSessionOperationLease {
  if (result.kind === 'conflict') {
    throw new Error(`Expected acquired lease, active session was ${result.active.sessionId}.`);
  }
  return result.lease;
}

test('one session rejects a second lease while another session remains available', () => {
  const registry = new ChatSessionOperationRegistry();
  const first = registry.acquire('session-a', 'message', 1_000);
  assert.equal(first.kind, 'acquired');
  assert.equal(registry.acquire('session-a', 'plan', 1_100).kind, 'conflict');
  assert.equal(registry.acquire('session-b', 'repo-search', 1_200).kind, 'acquired');
});

test('a stale lease cannot release a newer operation', () => {
  const registry = new ChatSessionOperationRegistry();
  const first = requireAcquired(registry.acquire('session-a', 'message', 1_000));
  assert.equal(registry.release(first.lease), true);
  const second = requireAcquired(registry.acquire('session-a', 'plan', 2_000));
  assert.equal(registry.release(first.lease), false);
  assert.equal(registry.getActiveOperation('session-a')?.token, second.lease.token);
});
```

Cover empty session IDs, all operation kinds, exact-token release, conflict metadata, and active-count branches.

- [ ] **Step 2: Run registry tests and verify RED**

```powershell
npm test -- chat-session-operation-registry
```

Expected: FAIL because the class does not exist.

- [ ] **Step 3: Implement the explicit lease registry**

```ts
export class ChatSessionOperationRegistry {
  private readonly activeBySessionId = new Map<string, ChatSessionOperation>();

  acquire(
    sessionId: string,
    operationKind: ChatSessionOperationKind,
    nowMs: number,
  ): ChatSessionOperationAcquireResult;

  release(lease: ChatSessionOperationLease): boolean;
  getActiveOperation(sessionId: string): ChatSessionOperation | null;
  getActiveCount(): number;
}
```

Generate lease tokens with `randomUUID()`. Return discriminated acquired/conflict objects; never return a loosely typed object or accept a callback.

Derive operation and result types from builders:

```ts
function createChatSessionOperation(
  sessionId: string,
  operationKind: ChatSessionOperationKind,
  startedAtMs: number,
) {
  return { token: randomUUID(), sessionId, operationKind, startedAtMs };
}

function createAcquiredResult(lease: ChatSessionOperation) {
  return { kind: 'acquired' as const, lease };
}

function createConflictResult(active: ChatSessionOperation) {
  return { kind: 'conflict' as const, active };
}

type ChatSessionOperation = ReturnType<typeof createChatSessionOperation>;
type ChatSessionOperationLease = ChatSessionOperation;
type ChatSessionOperationAcquireResult =
  | ReturnType<typeof createAcquiredResult>
  | ReturnType<typeof createConflictResult>;
```

- [ ] **Step 4: Add failing endpoint conflict tests**

Change the existing mixed FIFO test so the first queued request owns the session and the second same-session request receives `409` immediately:

```ts
assert.equal(firstSessionRequest.statusCode, 200);
assert.equal(conflictingRequest.statusCode, 409);
assert.equal(conflictingRequest.body.sessionId, sessionId);
assert.equal(conflictingRequest.body.operationKind, 'message');
```

Add a table-driven E2E covering conflicts between message, plan, and repo-search across both streamed and non-streamed routes.

- [ ] **Step 5: Run the endpoint tests and verify RED**

```powershell
npm test -- dashboard-status-server --test-name-pattern "same session"
```

Expected: FAIL because requests still queue through the global model lock.

- [ ] **Step 6: Gate all six generation endpoints**

For each endpoint, validate first, then acquire the session lease before model capacity. Use explicit acquisition and `try/finally` in each endpoint:

```ts
const acquisition = ctx.chatSessionOperations.acquire(sessionId, 'message', Date.now());
if (acquisition.kind === 'conflict') {
  sendJson(res, 409, {
    error: 'Chat session already has an active operation.',
    sessionId,
    operationKind: acquisition.active.operationKind,
  });
  return;
}
try {
  // existing model admission, execution, persistence, and response lifecycle
} finally {
  ctx.chatSessionOperations.release(acquisition.lease);
}
```

Use `'message'`, `'plan'`, or `'repo-search'` explicitly in the matching route. Ensure response/SSE closure and model-lock release occur before session-lease release.

Emit `session_busy_rejected` with `sessionId`, requested operation, active operation, active duration, and current active-session count. Do not emit a failed status run because rejection occurs before status creation.

- [ ] **Step 7: Verify success, failure, disconnect, and queued-wait cleanup**

Run:

```powershell
npm test -- chat-session-operation-registry dashboard-status-server model-request-queue
```

Expected: PASS; a request waiting for llama.cpp capacity still owns its session, and all terminal paths permit a later request.

- [ ] **Step 8: Commit Task 3**

```powershell
git add src/status-server/chat-session-operation-registry.ts src/status-server/server-types.ts src/status-server/index.ts src/status-server/routes/chat.ts tests/chat-session-operation-registry.test.ts tests/helpers/server-context-fixture.ts tests/dashboard-status-server.test.ts
git commit -m "feat: block concurrent operations within chat sessions"
```

---

### Task 4: Prove different-session and CLI/CMD concurrency end to end

**Files:**
- Modify: `tests/helpers/dashboard-model-queue-harness.ts`
- Create: `tests/dashboard-chat-concurrency.test.ts`
- Modify: `tests/runtime-cli.test.ts`
- Modify: `tests/parallel-status-server.test.ts`

**Interfaces:**
- Consumes: both registries integrated in Tasks 2 and 3.
- Produces: controlled test barriers for multiple active chat sessions.
- Verifies: EXL3 concurrent admission, llama.cpp FIFO admission, independent SSE, and CLI status coexistence.

- [ ] **Step 1: Add a controlled concurrent-chat test harness API**

Extend `DashboardModelQueueHarness` with explicit methods instead of function parameters:

```ts
createChatSession(title: string, model: string): Promise<string>;
startChatStream(sessionId: string, content: string): Promise<SseResponse>;
waitForActiveRequests(kind: string, count: number): Promise<void>;
releaseChatResponse(content: string): void;
```

The fake EXL3 server records each request and holds its SSE completion until `releaseChatResponse()` is called.

- [ ] **Step 2: Add failing different-session SSE tests**

```ts
function readDoneSessionId(response: SseResponse): string {
  for (const event of response.events) {
    if (event.event !== 'done') {
      continue;
    }
    const session = asObject(asObject(event.payload).session);
    if (typeof session.id === 'string' && session.id) {
      return session.id;
    }
  }
  throw new Error('Expected SSE done event containing a session id.');
}

test('exl3 streams different chat sessions concurrently without mixing results', async () => {
  const harness = new DashboardModelQueueHarness('siftkit-chat-parallel-', { exl3ActivePreset: true });
  await harness.start();
  try {
    const sessionA = await harness.createChatSession('A', 'model-a');
    const sessionB = await harness.createChatSession('B', 'model-a');
    const streamA = harness.startChatStream(sessionA, 'prompt-a');
    const streamB = harness.startChatStream(sessionB, 'prompt-b');
    await harness.waitForActiveRequests('dashboard_chat_stream', 2);
    harness.releaseChatResponse('answer-a');
    harness.releaseChatResponse('answer-b');
    const [resultA, resultB] = await Promise.all([streamA, streamB]);
    assert.equal(readDoneSessionId(resultA), sessionA);
    assert.equal(readDoneSessionId(resultB), sessionB);
  } finally {
    await harness.close();
  }
});
```

Add a llama.cpp case proving session A and B have independent status while one waits in FIFO, plus an abort case proving only the aborted session lease releases.

- [ ] **Step 3: Run the chat concurrency E2E and verify RED**

```powershell
npm test -- dashboard-chat-concurrency
```

Expected: FAIL until the fake backend barriers and endpoint integration support two simultaneous streams.

- [ ] **Step 4: Add CLI/CMD coexistence assertions**

Extend `concurrent oversized CLI summary requests are serialized until the first request fully completes` to poll `GET /status` while both child processes are alive and assert two distinct summary request IDs. Add a simultaneous dashboard status POST and prove it remains a third independent entry.

Use the existing real `bin/siftkit.js`, `spawnProcess`, `withSummaryTestServer`, and temporary-file helpers. Do not replace the CLI process with direct function calls.

- [ ] **Step 5: Run CLI and combined concurrency tests**

```powershell
npm test -- runtime-cli dashboard-chat-concurrency parallel-status-server
```

Expected: PASS; backend serialization or concurrency matches the active preset, while status identity never collides.

- [ ] **Step 6: Commit Task 4**

```powershell
git add tests/helpers/dashboard-model-queue-harness.ts tests/dashboard-chat-concurrency.test.ts tests/runtime-cli.test.ts tests/parallel-status-server.test.ts
git commit -m "test: cover parallel chats and cli status"
```

---

### Task 5: Refactor dashboard streaming and runtime state atomically by session

**Files:**
- Modify: `package.json`
- Modify: `scripts/test-targets.ts`
- Modify: `tests/test-targets.test.ts`
- Modify: `packages/contracts/src/chat.ts`
- Modify: `dashboard/src/api.ts`
- Modify: `dashboard/tests/api-stream.test.ts`
- Rename: `dashboard/src/hooks/useLiveMessages.ts` -> `dashboard/src/lib/chat-live-messages.ts`
- Rename: `dashboard/tests/hooks/useLiveMessages.test.tsx` -> `dashboard/tests/chat-live-messages.test.ts`
- Create: `dashboard/src/lib/chat-session-runtime-store.ts`
- Create: `dashboard/tests/chat-session-runtime-store.test.ts`
- Remove: `dashboard/src/hooks/useContextUsage.ts`
- Remove: `dashboard/src/hooks/usePlanInputs.ts`
- Remove: `dashboard/tests/hooks/useContextUsage.test.tsx`
- Remove: `dashboard/tests/hooks/usePlanInputs.test.tsx`
- Modify: `dashboard/src/hooks/useChatSessions.ts`
- Modify: `dashboard/src/hooks/useChatComposer.ts`
- Modify: `dashboard/src/hooks/useChatController.ts`
- Modify: `dashboard/src/tabs/ChatTab.tsx`
- Modify: `dashboard/src/lib/chat-session-state.ts`
- Modify: `dashboard/tests/hooks/useChatComposer.test.tsx`
- Modify: `dashboard/tests/hooks/useChatSessions.test.tsx`
- Modify: `dashboard/tests/chat-session-state.test.ts`
- Modify: `dashboard/tests/chat-tab.test.tsx`

**Interfaces:**
- Consumes: `ChatStreamEvent` from `dashboard/src/lib/chat-stream-parser.ts` and `ChatSessionBusyResponseSchema` from Task 1.
- Produces: `streamChatMessage()`, `streamPlanMessage()`, and `streamRepoSearchMessage()` returning `AsyncGenerator<ChatStreamEvent>`.
- Produces: `ChatSessionBusyError` with schema-validated `sessionId` and `operationKind`.
- Produces: immutable `ChatSessionRuntimeStore` and inferred runtime snapshot types.
- Produces: response application by `response.session.id`, captured-session event routing, per-session indicators, and selected-session control state.
- Removes: `ChatStreamResult` and all `onThinking`, `onToolEvent`, and `onAnswer` parameters.
- Removes: global `chatBusy`, global `liveMessages`, global composer draft/images/warnings, and callback-based stream consumers.

#### Phase A: Typed stream iteration

- [ ] **Step 1: Replace callback assertions with failing iterator assertions**

```ts
test('streamPlanMessage yields typed tool and done events in order', async () => {
  const restoreFetch = mockFetchOnce([
    'event: tool_start\ndata: {"toolCallId":"tc_0","turn":1,"maxTurns":1,"command":"x"}\n\n',
    `event: done\ndata: ${JSON.stringify(SAMPLE_DONE)}\n\n`,
  ]);
  try {
    const eventKinds: string[] = [];
    for await (const event of streamPlanMessage('sess', { content: 'go' })) {
      eventKinds.push(event.kind);
    }
    assert.deepEqual(eventKinds, ['tool', 'done']);
  } finally {
    restoreFetch();
  }
});
```

Add tests for warnings, answers, server `error` events, missing `done`, empty body, malformed `409`, and valid `409` producing `ChatSessionBusyError`.

- [ ] **Step 2: Run dashboard API tests and verify RED**

```powershell
npx tsx --test dashboard/tests/api-stream.test.ts
```

Expected: FAIL because the stream functions still require callbacks and return a final aggregate.

- [ ] **Step 3: Implement the async iterator**

```ts
async function* consumeChatStream(
  url: string,
  payload: Record<string, JsonSerializable>,
): AsyncGenerator<ChatStreamEvent> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw await buildChatStreamHttpError(response);
  }
  if (!response.body) {
    throw new Error('Streaming response body was empty.');
  }
  let completed = false;
  const reader = new ChatStreamReader(response.body.getReader());
  for await (const event of reader.events()) {
    if (event.kind === 'error') {
      throw new Error(event.message);
    }
    if (event.kind === 'done') {
      completed = true;
    }
    yield event;
  }
  if (!completed) {
    throw new Error('Missing final streaming payload.');
  }
}
```

Parse `409` JSON with `ChatSessionBusyResponseSchema.safeParse()`. Remove the callback overloads completely.

The typed error is explicit:

```ts
export class ChatSessionBusyError extends Error {
  constructor(readonly response: ChatSessionBusyResponse) {
    super(response.error);
    this.name = 'ChatSessionBusyError';
  }
}
```

- [ ] **Step 4: Run API tests and dashboard typecheck**

```powershell
npx tsx --test dashboard/tests/api-stream.test.ts dashboard/tests/chat-stream-parser.test.ts
```

Expected: API and parser tests PASS. Continue immediately to Phase B without adding callback overloads or committing an intermediate broken consumer state.

#### Phase B: Immutable per-session runtime state

The store consumes pure live-message builders, `ChatMessage`, `ContextUsage`, and chat operation kinds. It produces explicit methods `.ensureSession()`, `.begin()`, `.appendThinking()`, `.applyToolEvent()`, `.applyAnswer()`, `.applyWarning()`, `.applyDone()`, `.applyFailure()`, `.setDraft()`, `.setImages()`, `.setPlanInputs()`, `.removeSession()`, `.get()`, and `.getAll()`.

- [ ] **Step 1: Preserve pure live-message tests during the rename**

Move only `createLiveMessage`, `upsertLiveMessageInto`, `buildAppendedLiveToolMessage`, and `buildCompletedLiveToolMessage` into `chat-live-messages.ts`. Delete `UseLiveMessagesResult` and `useLiveMessages()` rather than retaining a global-state facade.

Run:

```powershell
npx tsx --test dashboard/tests/chat-live-messages.test.ts dashboard/tests/live-thinking-message.test.ts dashboard/tests/live-tool-message.test.ts
```

Expected: PASS after imports are updated.

- [ ] **Step 2: Add failing store-isolation tests**

```ts
test('session B cannot clear session A streaming state or draft', () => {
  const initial = new ChatSessionRuntimeStore()
    .ensureSession('session-a')
    .ensureSession('session-b')
    .setDraft('session-a', 'draft-a')
    .begin('session-a', 'message')
    .applyAnswer('session-a', 'answer-a')
    .begin('session-b', 'plan');

  assert.equal(initial.get('session-a').draft, 'draft-a');
  assert.equal(initial.get('session-a').liveMessages[0]?.content, 'answer-a');
  assert.equal(initial.get('session-a').activity.kind, 'active');
  assert.equal(initial.get('session-b').activity.kind, 'active');
});
```

Cover errors, warnings, context usage, tool tokens, attachments, plan inputs, completion order, unknown-session rejection, session removal, and immutable previous snapshots.

Add a plan-input test proving preset/session defaults initialize a new runtime once but do not overwrite a dirty draft when another session loads or the selected session changes.

- [ ] **Step 3: Run store tests and verify RED**

```powershell
npx tsx --test dashboard/tests/chat-session-runtime-store.test.ts
```

Expected: FAIL because the store does not exist.

- [ ] **Step 4: Implement the immutable class**

```ts
function createIdleActivity() { return { kind: 'idle' as const }; }
function createActiveActivity(operationKind: ChatSessionOperationKind) {
  return { kind: 'active' as const, operationKind };
}

type ChatSessionActivity =
  | ReturnType<typeof createIdleActivity>
  | ReturnType<typeof createActiveActivity>;

function createChatSessionRuntime(
  sessionId: string,
  activity: ChatSessionActivity = createIdleActivity(),
  liveMessages: ChatMessage[] = [],
  error: string | null = null,
  warnings: string[] = [],
  contextUsage: ContextUsage | null = null,
  liveToolPromptTokenCount: number | null = null,
  draft: string = '',
  pendingImages: string[] = [],
  planRepoRootInput: string = '',
  planMaxTurnsInput: string = '',
) {
  return {
    sessionId,
    activity,
    liveMessages,
    error,
    warnings,
    contextUsage,
    liveToolPromptTokenCount,
    draft,
    pendingImages,
    planRepoRootInput,
    planMaxTurnsInput,
  };
}

type ChatSessionRuntime = ReturnType<typeof createChatSessionRuntime>;

export class ChatSessionRuntimeStore {
  private readonly runtimesBySessionId: Map<string, ChatSessionRuntime>;

  constructor(runtimesBySessionId: Map<string, ChatSessionRuntime> = new Map()) {
    this.runtimesBySessionId = runtimesBySessionId;
  }

  get(sessionId: string): ChatSessionRuntime;
  getAll(): ChatSessionRuntime[];
  ensureSession(sessionId: string): ChatSessionRuntimeStore;
  begin(sessionId: string, operationKind: ChatSessionOperationKind): ChatSessionRuntimeStore;
  applyFailure(sessionId: string, message: string): ChatSessionRuntimeStore;
  applyDone(sessionId: string, response: ChatSessionResponse): ChatSessionRuntimeStore;
}
```

Every mutator copies the map and the targeted runtime, leaving all other session objects unchanged. Derive runtime type aliases with `ReturnType` from explicit builders; use `as const` only for safe activity discriminants.

- [ ] **Step 5: Run focused dashboard coverage**

```powershell
npx c8 --include="dashboard/src/lib/chat-session-runtime-store.ts" --reporter=text node --import tsx --test dashboard/tests/chat-session-runtime-store.test.ts
```

Expected: PASS with 100% branch coverage for the store.

Continue directly to Phase C; removed hooks are not replaced with compatibility facades.

#### Phase C: React integration and per-session controls

- [ ] **Step 1: Add failing session-response isolation tests**

Test pure helpers extracted from `useChatSessions`:

```ts
test('upsertSessionResponse updates A without replacing selected B', () => {
  const updated = upsertSession([SESSION_A, SESSION_B], { ...SESSION_A, title: 'A updated' });
  assert.equal(findSessionByIdStrict(updated, 'session-a').title, 'A updated');
  assert.equal(findSessionByIdStrict(updated, 'session-b'), SESSION_B);
});
```

Remove `setChatBusy` and `chatBusy` assertions. Add coverage that creating a new session remains independent of any streaming session.

- [ ] **Step 2: Add failing composer routing tests**

Use two controlled fetch streams. Start A, change the selected session to B, start B, then release B before A. Assert each event and final response updates only its captured session ID.

The composer loop must be structurally explicit:

```ts
for await (const event of streamChatMessage(session.id, payload)) {
  if (event.kind === 'thinking') {
    runtimes.appendThinking(session.id, event.text);
  } else if (event.kind === 'warning') {
    runtimes.applyWarning(session.id, event.text);
  } else if (event.kind === 'tool') {
    runtimes.applyToolEvent(session.id, event.tool);
  } else if (event.kind === 'answer') {
    runtimes.applyAnswer(session.id, event.text);
  } else if (event.kind === 'done') {
    runtimes.applyDone(session.id, event.payload);
  }
}
```

Implement `runtimes` as the explicit named runtime actions returned by `useChatSessions`; it applies immutable `ChatSessionRuntimeStore` transitions and never accepts a behavior callback.

- [ ] **Step 3: Add failing UI rendering tests**

Update `ChatTab` fixtures to include runtime views for A and B. Assert:

```ts
const store = new ChatSessionRuntimeStore()
  .ensureSession('session-a')
  .ensureSession('session-b')
  .begin('session-a', 'message');
const busyA = render({
  selectedSessionId: 'session-a',
  selectedRuntime: store.get('session-a'),
  sessionRuntimes: store.getAll(),
});
const idleB = render({
  selectedSessionId: 'session-b',
  selectedRuntime: store.get('session-b'),
  sessionRuntimes: store.getAll(),
});
assert.match(busyA, /class="send"[^>]*disabled/u);
assert.doesNotMatch(idleB, /class="send"[^>]*disabled/u);
assert.doesNotMatch(idleB, /New session[^<]*disabled/u);
```

Also assert A retains a streaming indicator while B is selected, delete is disabled only for the busy selected session, and errors/warnings render only for the selected session.

- [ ] **Step 4: Run dashboard tests and verify RED**

```powershell
npx tsx --test dashboard/tests/api-stream.test.ts dashboard/tests/chat-session-runtime-store.test.ts dashboard/tests/hooks/useChatSessions.test.tsx dashboard/tests/hooks/useChatComposer.test.tsx dashboard/tests/chat-session-state.test.ts dashboard/tests/chat-tab.test.tsx
```

Expected: FAIL against global state and callback consumers.

- [ ] **Step 5: Refactor session/controller state without compatibility layers**

In `useChatSessions`:

- Remove `chatBusy` and `setChatBusy`.
- Own `ChatSessionRuntimeStore` in React state and expose explicit methods `beginSessionOperation`, `appendSessionThinking`, `applySessionToolEvent`, `applySessionAnswer`, `applySessionWarning`, `completeSessionOperation`, and `failSessionOperation`.
- Apply fetched and completed sessions by ID into `sessions`.
- Derive the selected session from `sessions` and `selectedSessionId`; do not let completion of A select A while B is selected.
- Keep session creation available during other sessions' streams.
- Derive `UseChatSessionsResult` with `ReturnType<typeof useChatSessions>` after the function so the store/actions cannot drift from the implementation.

In `useChatController`:

- Consume the `ChatSessionRuntimeStore` snapshot owned by `useChatSessions`.
- Ensure `useChatSessions` creates runtime entries for every loaded session and applies fetched context usage to the matching session ID.
- Pass selected runtime data and a list of session indicators to `ChatTab`.
- Remove global `chatError`, `useLiveMessages`, `useContextUsage`, and `usePlanInputs` ownership.
- Keep `showSettings` global because it is UI chrome rather than request state.

In `useChatComposer`:

- Capture `session`, input, images, plan inputs, and thinking settings before awaiting.
- Mark only that session active.
- Consume the typed iterator with explicit event branches.
- On `done`, update the matching session and runtime.
- On error or premature close, fail and unlock only that session.
- Clear the initiating session's draft/images only after successful completion.

- [ ] **Step 6: Update `ChatTab` to render per-session state**

Use data props, not a function that computes state dynamically:

```ts
export type ChatSessionIndicatorView = {
  sessionId: string;
  indicator: SessionIndicator;
};
```

Find the indicator by session ID when rendering the lane. Drive composer, delete, error, warning, usage, live-message, draft, and attachment UI from the selected runtime entry.

- [ ] **Step 7: Add failing dashboard test-target discovery tests**

Extend `tests/test-targets.test.ts` against the repository's existing root and nested dashboard tests:

```ts
test('dashboard option resolves every nested dashboard test and is not forwarded to node', () => {
  const args = buildNodeTestArgs(process.cwd(), ['--dashboard']);
  assert.equal(args.includes(path.join('dashboard', 'tests', 'api-stream.test.ts')), true);
  assert.equal(args.includes(path.join('dashboard', 'tests', 'hooks', 'useChatComposer.test.tsx')), true);
  assert.equal(args.includes('--dashboard'), false);
});
```

Run:

```powershell
npm test -- test-targets
```

Expected: FAIL because `--dashboard` is still forwarded as an unknown Node option.

- [ ] **Step 8: Implement dashboard test discovery, then run the dashboard matrix**

```powershell
npm run test:dashboard
npm run typecheck:dashboard-test
npm run typecheck
npm run build
```

Expected: PASS with no callback stream signatures or global chat runtime hooks remaining.

Add this explicit script to `package.json`, backed by existing PowerShell-safe test target enumeration in `scripts/test-targets.ts` extended with a dashboard-root option rather than relying on shell glob expansion:

```json
"test:dashboard": "npm run build:test && node .\\dist\\scripts\\run-tests.js --dashboard"
```

Extend `scripts/test-targets.ts` so `--dashboard` resolves every `dashboard/tests/**/*.test.ts` and `dashboard/tests/**/*.test.tsx` file and removes the custom flag before invoking Node.

Use explicit recursive collection:

```ts
const DASHBOARD_TESTS_OPTION = '--dashboard';

function collectDashboardTestTargets(repoRoot: string, directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return collectDashboardTestTargets(repoRoot, entryPath);
      }
      return /\.test\.tsx?$/u.test(entry.name) ? [path.relative(repoRoot, entryPath)] : [];
    })
    .sort((left, right) => left.localeCompare(right));
}
```

`resolveTestTargets()` detects and removes `--dashboard`, appends these collected paths, and preserves all standard Node test options. Tests assert nested `.test.tsx` discovery, deterministic ordering, coexistence with `--test-name-pattern`, and absence of `--dashboard` in the final Node arguments.

- [ ] **Step 9: Scan for removed APIs and banned patterns**

Run narrow searches and require zero matches in changed files for:

```text
UseLiveMessagesResult
useLiveMessages(
useContextUsage(
usePlanInputs(
setChatBusy
onThinking
onToolEvent
onAnswer
import * as
```

Also inspect changed TypeScript for assertion casts, `any`, and non-null assertions.

- [ ] **Step 10: Commit Task 5 as one green dashboard refactor**

```powershell
git add package.json scripts/test-targets.ts tests/test-targets.test.ts packages/contracts/src/chat.ts dashboard/src/api.ts dashboard/src/lib/chat-stream-parser.ts dashboard/src/lib/chat-live-messages.ts dashboard/src/lib/chat-session-runtime-store.ts dashboard/src/hooks/useChatSessions.ts dashboard/src/hooks/useChatComposer.ts dashboard/src/hooks/useChatController.ts dashboard/src/tabs/ChatTab.tsx dashboard/src/lib/chat-session-state.ts dashboard/tests
git rm dashboard/src/hooks/useContextUsage.ts dashboard/src/hooks/usePlanInputs.ts dashboard/tests/hooks/useContextUsage.test.tsx dashboard/tests/hooks/usePlanInputs.test.tsx
git commit -m "refactor: isolate dashboard streams by chat session"
```

---

### Task 6: Complete cross-layer regression coverage and documentation

**Files:**
- Modify if the new matrix exposes a defect: `src/status-server/status-run-registry.ts`
- Modify if the new matrix exposes a defect: `src/status-server/chat-session-operation-registry.ts`
- Modify if the new matrix exposes a defect: `src/status-server/routes/core.ts`
- Modify if the new matrix exposes a defect: `src/status-server/routes/chat.ts`
- Modify if the new matrix exposes a defect: `dashboard/src/lib/chat-session-runtime-store.ts`
- Modify if the new matrix exposes a defect: `dashboard/src/hooks/useChatComposer.ts`
- Modify: `tests/parallel-status-server.test.ts`
- Modify: `tests/dashboard-chat-concurrency.test.ts`
- Modify: `tests/summary-status-server.test.ts`
- Modify: `tests/chat-status-metrics.test.ts`
- Modify: `README.md`
- Modify: `docs/exl3-backend-setup.md`

**Interfaces:**
- Consumes: final status, session-gating, SSE, and frontend interfaces.
- Produces: regression proof for terminal permutations, metric uniqueness, backend policies, and documented operator behavior.

- [ ] **Step 1: Add the final failing cross-layer matrix**

Cover these permutations with real HTTP/SSE:

```text
complete(A), metadata(A), complete(B), metadata(B)
complete(B), complete(A), metadata(A), metadata(B)
metadata(A), complete(A), duplicate metadata(A)
failure(A), success(B)
disconnect(A), retry(A), concurrent success(B)
```

Assert active-run membership after every transition, final aggregate idle state, exact per-request persisted logs, and exactly-once runtime metrics.

- [ ] **Step 2: Run the cross-layer tests and verify RED if a branch remains**

```powershell
npm test -- parallel-status-server dashboard-chat-concurrency summary-status-server chat-status-metrics
```

Expected before final adjustments: any uncovered lifecycle branch fails with the exact transition that is still incorrect.

- [ ] **Step 3: Make only the minimal lifecycle corrections exposed by the matrix**

Change the owning registry or explicit route branch. Do not add retries, path-based fallback, status aliases, or duplicate state outside the registries.

- [ ] **Step 4: Update operator documentation**

Document:

- `GET /status.activeRuns` fields and privacy boundary.
- `running` as an aggregate value.
- Same-session `409` behavior and lack of per-session queueing.
- Different-session and CLI/CMD independence.
- EXL3 concurrent admission versus llama.cpp FIFO execution.
- No stream resume after browser reload.

Correct any statement in `docs/exl3-backend-setup.md` that claims the status server serializes all EXL3 calls when current backend-aware capacity delegates concurrency to EXL3.

- [ ] **Step 5: Run full verification**

```powershell
npm test
npm run test:dashboard
npm run typecheck
npm run build
npm run test:coverage
```

Expected: every command passes; new registries and changed concurrency/error branches have 100% branch coverage; repository-wide coverage does not decrease.

- [ ] **Step 6: Review the complete diff**

Verify:

- Only files declared in this plan changed.
- No `activeRequestIdByStatusPath`, `completedRequestIdByStatusPath`, `stale_status_abandoned`, or legacy request-ID fallback remains.
- No callback-based chat streaming API remains.
- No global dashboard chat runtime state remains.
- Same-session work is rejected, never queued.
- Different sessions and CLI/CMD remain independent.
- No temporary files remain.

- [ ] **Step 7: Commit Task 6**

```powershell
git add src/status-server/status-run-registry.ts src/status-server/chat-session-operation-registry.ts src/status-server/routes/core.ts src/status-server/routes/chat.ts dashboard/src/lib/chat-session-runtime-store.ts dashboard/src/hooks/useChatComposer.ts tests/parallel-status-server.test.ts tests/dashboard-chat-concurrency.test.ts tests/summary-status-server.test.ts tests/chat-status-metrics.test.ts README.md docs/exl3-backend-setup.md
git commit -m "test: finalize parallel request coverage"
```

---

## Completion Criteria

- Multiple request IDs sharing the same status path remain independently active.
- Terminal delivery order and duplication cannot cross-contaminate runs or metrics.
- A chat session owns at most one active generation lease and returns immediate `409` conflicts.
- Different sessions preserve separate SSE streams, histories, errors, warnings, usage, drafts, and attachments.
- CLI/CMD requests coexist with dashboard work under the selected backend's admission policy.
- The old path-keyed and global-dashboard state models are removed completely.
- Full tests, typecheck, build, coverage, diff review, and banned-pattern scans pass.

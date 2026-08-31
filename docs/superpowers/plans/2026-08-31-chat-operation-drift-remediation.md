# Chat Operation Drift Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the chat approval/Stop implementation's ownership, lifecycle, persistence, duplication, and type-boundary drift with authoritative typed flows.

**Architecture:** Public request/response schemas live in `@siftkit/contracts`; the server registry owns operation identity and status; dashboard runtime activity explicitly distinguishes local and remote ownership. Chat turn construction becomes pure so repo-agent transcript persistence writes once, and shared helpers own repeated terminal behavior.

**Tech Stack:** TypeScript, Zod, React, Node HTTP/SSE, SQLite, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-31-chat-operation-drift-remediation-design.md`

## Global Constraints

- Do not use SiftKit, worktrees, compatibility shims, fallback paths, new dependencies, or commits.
- Use TDD for every behavior change: focused failing test, minimal implementation, passing focused suite, then refactor.
- All public IO must use runtime schemas with `z.infer`; no `any`, assertions, non-null assertions, namespace imports, or generic-JSON laundering.
- Client disconnects must not abort runs.
- A queued Stop remains pending until the non-abortable model-lock wait grants execution.
- Preserve unrelated changes.

---

### Task 1: Shared operation and approval contracts

**Files:**
- Modify: `packages/contracts/src/chat.ts`
- Modify: `src/repo-agent/api-schemas.ts`
- Modify: `dashboard/src/api.ts`
- Modify: `tests/contracts-chat-repo-agent.test.ts`
- Modify: `dashboard/tests/api-stream.test.ts`

**Interfaces:**
- Produces: `RepoAgentDecisionSchema`, `ChatRepoAgentStreamRequestSchema`, `ActiveChatRepoAgentResponseSchema`, `ChatOperationStatusResponseSchema`, `StopChatOperationRequestSchema`, and `StopChatOperationResponseSchema` from `@siftkit/contracts`.
- Produces inferred `RepoAgentDecision`, `ActiveChatRepoAgentResponse`, `ChatOperationStatusResponse`, and Stop request/response types.

- [ ] **Step 1: Write failing contract tests**

Add tests proving:

```ts
assert.deepEqual(RepoAgentDecisionSchema.parse({ decision: 'approve' }), { decision: 'approve' });
assert.throws(() => RepoAgentDecisionSchema.parse({ decision: 'deny' }));
assert.equal(StopChatOperationRequestSchema.parse({
  operationId: '4f9c1f9a-0000-4000-8000-000000000000',
}).operationId, '4f9c1f9a-0000-4000-8000-000000000000');
assert.throws(() => ActiveChatRepoAgentResponseSchema.parse({
  runId: '4f9c1f9a-0000-4000-8000-000000000000',
  status: 'approval_timeout',
}));
```

Update the API test to require `stopChatOperation(sessionId, operationId)` to POST the validated JSON body.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm run build:test && npm test -- contracts-chat-repo-agent api-stream`

Expected: missing shared schema exports and wrong Stop function signature/body.

- [ ] **Step 3: Implement canonical schemas**

In contracts, define strict schemas:

```ts
export const RepoAgentDecisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve') }).strict(),
  z.object({ decision: z.literal('deny'), reason: z.string().trim().min(1) }).strict(),
  z.object({ decision: z.literal('abort') }).strict(),
]);

export const ActiveChatRepoAgentResponseSchema = z.discriminatedUnion('status', [
  z.object({ runId: z.string().uuid(), status: z.literal('running') }).strict(),
  z.object({
    runId: z.string().uuid(),
    status: z.literal('approval_required'),
    approval: ChatStreamApprovalSchema.omit({ runId: true }),
  }).strict(),
]);

export const ChatOperationStatusResponseSchema = z.object({
  operationKind: ChatSessionOperationKindSchema,
  startedAtUtc: z.string().datetime(),
}).strict();

export const StopChatOperationRequestSchema = z.object({ operationId: z.string().uuid() }).strict();
export const StopChatOperationResponseSchema = z.object({
  ok: z.literal(true),
  operationKind: ChatSessionOperationKindSchema,
}).strict();
```

Define `ChatRepoAgentStreamRequestSchema` for public fields: `content`, `images`, `repoRoot`, `approval`, `maxTurns`, and `operationId`. Re-export/import `RepoAgentDecisionSchema` in the server instead of maintaining a second definition. Replace dashboard-local schemas and handwritten decision types with contract imports and `z.infer` types.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm run build:test && npm test -- contracts-chat-repo-agent api-stream && npm run typecheck`

Expected: PASS.

---

### Task 2: Server-enforced operation ownership and status

**Files:**
- Modify: `src/status-server/chat-session-operation-registry.ts`
- Modify: `src/status-server/routes/chat-session-operation-endpoint.ts`
- Modify: `src/status-server/routes/chat.ts`
- Modify: `src/status-server/routes/chat-repo-agent.ts`
- Modify: `tests/status-server-chat-stop.test.ts`
- Modify: `tests/chat-session-operation-registry.test.ts`

**Interfaces:**
- Consumes: `operationId` and Stop/status schemas from Task 1.
- Produces: leases with `operationId`; `GET /dashboard/chat/sessions/:id/operation`; ownership-checked `POST /stop`.

- [ ] **Step 1: Write failing ownership and status tests**

Add registry tests showing `acquire(sessionId, kind, operationId, nowMs)` preserves the ID. Add HTTP tests proving:

1. matching `{ operationId }` stops a queued/generating operation;
2. a different valid UUID returns 409 and does not abort;
3. malformed/missing IDs return 400;
4. operation status is 200 while leased, omits `operationId`, and becomes 404 after release.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm run build:test && npm test -- chat-session-operation-registry status-server-chat-stop`

Expected: acquire signature, status route, and Stop ownership assertions fail.

- [ ] **Step 3: Implement ownership**

Add `operationId` to `ChatSessionOperation`. Parse it before acquiring the lease in `ChatSessionOperationEndpoint`; reject invalid request bodies before lease acquisition. Pass it into registry `acquire`.

Make Stop parse its body with `StopChatOperationRequestSchema` and require equality:

```ts
if (!active?.abort || active.operationId !== parsed.operationId) {
  sendJson(res, 409, { error: 'No matching stoppable operation is active for this session.' });
  return;
}
```

Add the GET operation endpoint using `new Date(active.startedAtMs).toISOString()` and the shared response schema shape. Never return `operationId`.

- [ ] **Step 4: Update every streaming request parser**

Require `operationId` for message, plan, repo-search, and repo-agent streaming requests. Non-streaming JSON endpoints remain unchanged and acquire a server-generated internal UUID because they do not expose Stop UI ownership.

- [ ] **Step 5: Run focused server tests**

Run: `npm run build:test && npm test -- chat-session-operation-registry status-server-chat-stop status-server-chat-repo-agent`

Expected: PASS.

---

### Task 3: Explicit local/remote dashboard activity lifecycle

**Files:**
- Modify: `dashboard/src/api.ts`
- Modify: `dashboard/src/lib/chat-session-runtime-store.ts`
- Modify: `dashboard/src/lib/chat-session-state.ts`
- Modify: `dashboard/src/lib/chat-stream-transitions.ts`
- Modify: `dashboard/src/hooks/useChatSessions.ts`
- Modify: `dashboard/src/tabs/ChatTab.tsx`
- Modify: `dashboard/tests/chat-session-runtime-store.test.ts`
- Modify: `dashboard/tests/chat-session-state.test.ts`
- Modify: `dashboard/tests/chat-stream-transitions.test.ts`
- Modify: `dashboard/tests/hooks/useChatSessions.test.tsx`
- Modify: `dashboard/tests/chat-tab.test.tsx`

**Interfaces:**
- Consumes: ownership/status contracts and endpoints from Tasks 1-2.
- Produces: `idle | local | remote` activity; nonterminal `control-error`; remote-operation polling and terminal refresh.

- [ ] **Step 1: Write failing runtime tests**

Specify the new state:

```ts
type ChatSessionActivity =
  | { kind: 'idle' }
  | { kind: 'local'; operationKind: ChatSessionOperationKind; operationId: string }
  | { kind: 'remote'; operationKind: ChatSessionOperationKind };
```

Tests must prove:

- a local begin stores the operation ID;
- 409 transitions local to remote using the busy response's operation kind;
- `control-error` preserves local activity, live messages, submitted input, and pending approval;
- remote completion transitions to idle only after authoritative 404 plus session refresh;
- recovered approval is remote-owned, keeps the composer disabled, and does not show Stop.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm run build:test && npm test -- chat-session-runtime-store chat-session-state chat-stream-transitions useChatSessions chat-tab`

Expected: old `active`/`remoteBusy` state and terminal Stop-error behavior fail assertions.

- [ ] **Step 3: Replace runtime activity completely**

Remove `remoteBusy`. Change `begin` to carry `operationId`, add `remote-begin`, `remote-clear`, and `control-error` transitions, and update `isSessionBusy` to check `activity.kind !== 'idle'` or a pending approval.

Change stream transition construction to receive `operationId`. When catching `ChatSessionBusyError`, yield `remote-begin` with `error.response.operationKind`, then a nonterminal error message rather than a terminal `failure`.

- [ ] **Step 4: Generate and propagate operation IDs**

Each send method calls `crypto.randomUUID()`, includes it in the request body, and passes it into `runChatStream`. `stopOperation` reads the selected runtime's local `operationId`; if activity is not local, it returns without calling the API.

On Stop failure, apply `control-error`; do not call `recordSessionError`.

- [ ] **Step 5: Implement authoritative remote polling**

Add `getChatOperationStatus(sessionId)`. During selection recovery fetch session, active repo-agent state, and operation status together. Represent an existing lease as remote. Apply an approval only when active repo-agent status is `approval_required`.

Add a named polling interval constant and an effect active only for the selected remote runtime. On status 404, refetch the session, apply `remote-clear`, and install the authoritative transcript. On 200, retain remote state. Cancel timers and requests on selection/unmount.

- [ ] **Step 6: Run dashboard tests**

Run: `npm run build:test && npm test -- api-stream chat-session-runtime-store chat-session-state chat-stream-transitions useChatSessions chat-tab`

Expected: PASS.

---

### Task 4: Typed active repo-agent state and neutral server domain types

**Files:**
- Create: `src/status-server/chat-repo-agent-types.ts`
- Modify: `src/status-server/routes/chat-repo-agent.ts`
- Modify: `src/status-server/chat.ts`
- Modify: `src/status-server/server-types.ts`
- Modify: `tests/status-server-chat-repo-agent.test.ts`

**Interfaces:**
- Consumes: shared decision and active response schemas from Task 1.
- Produces: neutral `ChatRepoAgentDecisionRecord` and `ChatRepoAgentRunBinding`; active endpoint exposes only running/approval-required states.

- [ ] **Step 1: Write failing active-state tests**

Extend endpoint tests to assert:

- running returns `{ runId, status: 'running' }`;
- approval-required returns the flattened validated approval response;
- terminal `approval_timeout`, `aborted`, `failed`, and `completed` states return 404;
- the active response never contains the backend run-store state object.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm run build:test && npm test -- status-server-chat-repo-agent`

Expected: current `{ runId, state }` responses fail.

- [ ] **Step 3: Move domain types and derive request extras**

Create the neutral module with:

```ts
export type ChatRepoAgentDecisionRecord = {
  decision: RepoAgentDecision;
  approval: RepoAgentApproval;
  decidedAtUtc: string;
};

export type ChatRepoAgentRunBinding = {
  runId: string;
  decisions: ChatRepoAgentDecisionRecord[];
};
```

Define a local Zod extras schema for approval, max turns, mock responses, and mock command results; infer its type and combine it with the already-validated base request. Remove handwritten duplicated unions/fields. Update chat persistence to read `record.decision.decision` and the deny reason from the decision object.

- [ ] **Step 4: Normalize active endpoint output**

Map backend state to the shared active response. Return 404 for terminal states. Remove dashboard `JsonValueSchema` parsing and all `approval_timeout` recovery handling.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `npm run build:test && npm test -- status-server-chat-repo-agent contracts-chat-repo-agent useChatSessions && npm run typecheck`

Expected: PASS with no core import from `routes/chat-repo-agent.ts`.

---

### Task 5: Single-write repo-agent transcript persistence

**Files:**
- Modify: `src/status-server/chat.ts`
- Modify: `tests/status-server-chat-repo-agent.test.ts`
- Modify: `tests/chat-sessions-db.test.ts`

**Interfaces:**
- Produces: pure `buildChatSessionWithAppendedTurn(...)`; existing `appendChatMessagesWithUsage(...)` remains the one-save public wrapper.

- [ ] **Step 1: Write a failing single-write regression test**

Add a test around repo-agent persistence that observes the session save boundary and asserts the first authoritative write already contains:

1. the user prompt;
2. every approval row in order;
3. the final assistant result.

The test must fail against the current two-save implementation by detecting the intermediate transcript without approvals.

- [ ] **Step 2: Run test and verify RED**

Run: `npm run build:test && npm test -- status-server-chat-repo-agent chat-sessions-db`

Expected: observed save count/content assertion fails.

- [ ] **Step 3: Separate building from saving**

Extract the current construction body into a pure function:

```ts
export function buildChatSessionWithAppendedTurn(
  session: ChatSession,
  content: string,
  assistantContent: string,
  usage?: Partial<ChatUsage>,
  options?: AppendChatOptions,
): ChatSession & { messages: PersistedChatMessage[] };
```

Make `appendChatMessagesWithUsage` call it and then `saveChatSession` exactly once. Make `appendChatRepoAgentMessages` call the builder, splice approval rows before the assistant result, and save exactly once. Delete the two-write path completely.

- [ ] **Step 4: Run persistence suites**

Run: `npm run build:test && npm test -- status-server-chat-repo-agent chat-sessions-db chat-repo-operation-runner`

Expected: PASS.

---

### Task 6: Consolidated aborted-stream completion and neutral attribution

**Files:**
- Modify: `src/status-server/routes/chat.ts`
- Modify: `dashboard/src/components/RepoAgentApprovalCard.tsx`
- Modify: `tests/status-server-chat-stop.test.ts`
- Modify: `dashboard/tests/chat-tab.test.tsx`

**Interfaces:**
- Produces: one `finishStoppedChatStream(...)` helper used by message, plan, and repo-search catches.

- [ ] **Step 1: Write failing regression tests**

Add parameterized Stop tests for message, plan, and repo-search proving identical normal-`done` behavior, marker persistence, and lease release. Update the approval-row UI test to require `User` and reject `You`.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm run build:test && npm test -- status-server-chat-stop chat-tab`

Expected: the new actor assertion fails. The parameterized Stop tests characterize existing behavior and protect the subsequent duplication-only refactor.

- [ ] **Step 3: Extract the terminal helper**

Create a helper accepting the signal, session/input/partial-answer values, config path, and SSE writer. It returns `false` without side effects for non-abort errors; for aborts it persists the stopped turn, writes `done`, and returns `true`. Replace all three repeated bodies with calls to this helper and keep only endpoint-specific non-abort formatting.

- [ ] **Step 4: Make actor attribution neutral**

Change persisted and optimistic approval rows from `You` to `User`. Do not add synthetic client identity.

- [ ] **Step 5: Run focused tests**

Run: `npm run build:test && npm test -- status-server-chat-stop chat-tab`

Expected: PASS.

---

### Task 7: Full validation and drift audit

**Files:**
- No planned file changes; any validation failure returns to the task that introduced it.

**Interfaces:**
- Verifies every prior task together.

- [ ] **Step 1: Run all feature suites**

Run:

```text
npm run build:test
npm test -- contracts-chat-repo-agent api-stream chat-session-operation-registry status-server-chat-stop status-server-chat-repo-agent chat-session-runtime-store chat-session-state chat-stream-transitions useChatSessions chat-tab chat-sessions-db chat-repo-operation-runner
```

Expected: PASS.

- [ ] **Step 2: Run static validation**

Run: `npm run typecheck`

Run: `npm run lint`

Expected: both PASS independently.

- [ ] **Step 3: Run the complete suite**

Run: `npm test`

Expected: zero failures; report pass/skip counts.

- [ ] **Step 4: Re-scan the remediation diff**

Confirm:

- no handwritten public IO types duplicate schemas;
- no import from core chat into a route-owned type or the reverse dependency;
- no `remoteBusy` field remains;
- repo-agent persistence has one save;
- only one aborted-stream completion implementation remains;
- Stop validates operation ownership server-side;
- no `You` actor label remains for persisted approvals;
- no temporary artifacts remain.

- [ ] **Step 5: Leave the verified tree uncommitted**

Report changed files, tests, residual risks, and the unchanged queued-lock limitation. Do not commit.

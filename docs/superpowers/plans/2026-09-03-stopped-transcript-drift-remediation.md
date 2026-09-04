# Stopped Transcript Drift Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Stop a durable transcript boundary while replacing the duplicated reducer, compatibility fallbacks, fake-turn splice, stale running-tool state, and global test monkey-patches introduced by the initial implementation.

**Architecture:** A Node-free shared transcript reducer in `@siftkit/contracts` becomes the only owner of live assistant message transitions. Explicit canonical, persisted, and replayable schemas define message lifecycle; stopped turns are built directly and saved once; operation leases expose durable completion awaited by Stop.

**Tech Stack:** TypeScript 5.9, zod 4, Node HTTP/SSE, SQLite via better-sqlite3, React dashboard, node:test.

**Spec:** `docs/superpowers/specs/2026-09-03-stopped-transcript-drift-remediation-design.md`

## Global Constraints

- Preserve every streamed thinking, narration/progress, tool, and answer segment in canonical order.
- Stop `200` means the stopped transcript is already durable.
- No compatibility aliases, schema fallbacks, parallel reducers, prototype mutation, `any`, type assertions, non-null assertions, namespace imports, unknown laundering, or dynamically-passed implementation functions.
- Runtime IO is parsed with zod; types derive from schemas with `z.infer`.
- Use TDD for every task: focused failing test, minimum implementation, passing focused test, then refactor.
- Do not use a worktree and do not commit.
- Preserve unrelated user changes.

---

### Task 1: Canonical transcript lifecycle contracts

**Files:**
- Modify: `packages/contracts/src/chat.ts`
- Modify: `dashboard/src/types.ts`
- Modify: `src/state/chat-sessions.ts`
- Modify: `src/status-server/chat.ts`
- Modify: `src/status-server/routes/chat.ts`
- Modify: `src/thinking-retention-policy.ts`
- Modify: `tests/contracts-chat.test.ts`
- Modify: `tests/contracts-chat-repo-agent.test.ts`
- Modify: `tests/chat-sessions-db.test.ts`

**Interfaces:**
- Consumes: existing `ChatMessageBaseSchema`, `ChatToolCallMessageSchema`, and chat session schemas.
- Produces: `ChatTranscriptMessageSchema`, `ChatTranscriptMessage`, `PersistedChatTranscriptMessageSchema`, `PersistedChatTranscriptMessage`, `ReplayableChatMessageSchema`, `ReplayableChatMessage`, and `isReplayableChatMessage(message)`.

- [x] **Step 1: Write failing contract tests**

Add literal fixtures proving the lifecycle boundaries:

```ts
assert.equal(ChatTranscriptMessageSchema.safeParse(runningTool).success, true);
assert.equal(PersistedChatTranscriptMessageSchema.safeParse(runningTool).success, false);
assert.equal(PersistedChatTranscriptMessageSchema.safeParse({ ...runningTool, toolCallStatus: 'stopped' }).success, true);
assert.equal(ReplayableChatMessageSchema.safeParse({ ...runningTool, toolCallStatus: 'done' }).success, true);
assert.equal(ReplayableChatMessageSchema.safeParse({ ...runningTool, toolCallStatus: 'stopped' }).success, false);
assert.equal(ReplayableChatMessageSchema.safeParse(narration).success, false);
```

Also change the tool-status fixture to require `running | done | stopped` and remove imports of `LiveChatMessageSchema` and `PersistedChatMessageSchema` from the changed contract tests.

- [x] **Step 2: Verify the contract tests fail for missing canonical symbols and stopped status**

Run:

```powershell
npm run build:test
npm test -- contracts-chat contracts-chat-repo-agent
```

Expected: build or tests fail because the canonical schemas do not exist and `stopped` is rejected.

- [x] **Step 3: Implement the canonical and derived schemas**

In `packages/contracts/src/chat.ts`, define the tool variants from one base:

```ts
export const ToolCallStatusSchema = z.enum(['running', 'done', 'stopped']);

const ChatToolCallFields = {
  role: z.literal('assistant'),
  kind: z.literal('assistant_tool_call'),
  toolCallCommand: z.string().trim().min(1),
  toolCallActivityKind: ToolActivityKindSchema,
  toolCallActivitySubject: ToolActivitySubjectSchema,
  toolCallTurn: z.number().int().positive(),
  toolCallMaxTurns: z.number().int().positive(),
  toolCallExitCode: z.number().int().nullable(),
} as const;

export const ChatTranscriptToolCallMessageSchema = ChatMessageBaseSchema.extend({
  ...ChatToolCallFields,
  toolCallStatus: ToolCallStatusSchema,
});
const PersistedToolCallMessageSchema = ChatTranscriptToolCallMessageSchema.extend({
  toolCallStatus: z.enum(['done', 'stopped']),
});
const ReplayableToolCallMessageSchema = ChatTranscriptToolCallMessageSchema.extend({
  toolCallStatus: z.literal('done'),
});
```

Build the three discriminated unions from the existing non-tool branches. Export `isReplayableChatMessage` as a valid type guard implemented by `ReplayableChatMessageSchema.safeParse(message).success`.

- [x] **Step 4: Complete the symbol migration without aliases**

Replace every repository use of `LiveChatMessage*` and `PersistedChatMessage*` with the appropriate canonical lifecycle symbol. `ChatSessionSchema.messages` uses `PersistedChatTranscriptMessageSchema`; dashboard runtime messages use `ChatTranscriptMessage`; SQLite and server responses use `PersistedChatTranscriptMessage`.

Delete the old schema/type exports entirely. Do not leave deprecated re-exports.

- [x] **Step 5: Verify contracts and existing persistence tests pass**

Run:

```powershell
npm run build:test
npm test -- contracts-chat contracts-chat-repo-agent chat-sessions-db
npm run typecheck
```

Expected: all selected tests and typecheck pass with no reference to removed aliases.

- [x] **Step 6: Review checkpoint**

Run `git diff --check` and inspect only Task 1 files. Confirm there is one canonical transcript type family and no compatibility export.

---

### Task 2: Shared transcript reducer for server and dashboard

**Files:**
- Create: `packages/contracts/src/chat-transcript-reducer.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `tests/chat-transcript-reducer.test.ts`
- Modify: `src/status-server/routes/chat.ts`
- Modify: `dashboard/src/lib/chat-session-runtime-store.ts`
- Delete: `dashboard/src/lib/live-narration-message.ts`
- Delete: `dashboard/src/lib/live-thinking-message.ts`
- Modify: `dashboard/tests/chat-session-runtime-store.test.ts`
- Delete or migrate: `dashboard/tests/live-thinking-message.test.ts`
- Delete or migrate: `dashboard/tests/live-narration-message.test.ts`

**Interfaces:**
- Consumes: Task 1 `ChatTranscriptMessage` and existing `ChatStreamTextDelta`, `ChatStreamProgress`, and `ChatStreamToolEvent` contracts.
- Produces: `ChatTranscriptEventSchema`, `ChatTranscriptEvent`, `ChatTranscriptMetadata`, `reduceChatTranscript(messages, event, metadata)`, and `finalizeStoppedChatTranscript(messages, marker, metadata)`.

- [x] **Step 1: Write failing reducer tests using hand-derived ordered fixtures**

Cover cumulative keyframes, append deltas, narration demotion/promotion, one replaceable progress row, tool start/result upsert, empty snapshots, two thinking turns, and Stop finalization:

```ts
const stopped = finalizeStoppedChatTranscript(messages, '*Stopped by user.*', metadata);
assert.deepEqual(stopped.map((message) => message.kind), [
  'assistant_thinking',
  'assistant_progress',
  'assistant_tool_call',
  'assistant_answer',
]);
assert.equal(stopped.find((message) => message.kind === 'assistant_tool_call')?.toolCallStatus, 'stopped');
assert.equal(stopped.at(-1)?.content, 'partial answer\n\n*Stopped by user.*');
```

Add a failure test proving two answer rows cause `finalizeStoppedChatTranscript` to throw.

- [x] **Step 2: Verify reducer tests fail because the module is absent**

Run:

```powershell
npm run build:test
npm test -- chat-transcript-reducer
```

Expected: build fails on the missing reducer exports.

- [x] **Step 3: Implement the pure reducer**

Use only explicit data:

```ts
export const ChatTranscriptMetadataSchema = z.strictObject({
  messageIdPrefix: z.string().min(1),
  sourceRunId: z.string().nullable(),
  createdAtUtc: z.string().min(1),
});
export type ChatTranscriptMetadata = z.infer<typeof ChatTranscriptMetadataSchema>;

export function reduceChatTranscript(
  messages: readonly ChatTranscriptMessage[],
  event: ChatTranscriptEvent,
  metadata: ChatTranscriptMetadata,
): ChatTranscriptMessage[];

export function finalizeStoppedChatTranscript(
  messages: readonly ChatTranscriptMessage[],
  marker: string,
  metadata: ChatTranscriptMetadata,
): PersistedChatTranscriptMessage[];
```

Use deterministic IDs derived from `messageIdPrefix`, event kind, turn, and tool-call ID. Reuse one internal upsert function; do not expose maps, callbacks, or mutable reducer state.

- [x] **Step 4: Replace the server accumulator with reducer calls**

`ChatStreamProgressWriter` retains only `transcriptMessages` and metadata. Convert cumulative server snapshots into offset-zero `thinking`, `narration`, or `answer` transcript events. Convert tool progress once into the existing `ChatStreamToolEvent` shape and pass that same value to both the reducer and SSE writer.

Delete `stoppedMessageIndexes`, `buildStoppedMessageBase`, `buildStoppedTextMessage`, `upsertStoppedMessage`, and `demoteStoppedNarration`.

- [x] **Step 5: Replace dashboard message transitions with the same reducer**

Route thinking, narration, answer, progress, and tool transitions through `reduceChatTranscript`. Keep operation activity, drafts, approvals, warnings, and submitted inputs in `ChatSessionRuntimeStore`.

Delete the superseded narration/thinking reducer files and migrate their behavioral assertions into `chat-transcript-reducer.test.ts` or `chat-session-runtime-store.test.ts`.

- [x] **Step 6: Verify reducer parity and Stop behavior**

Run:

```powershell
npm run build:test
npm test -- chat-transcript-reducer chat-session-runtime-store status-server-chat-stop useChatSessions
npm run typecheck
```

Expected: all tests pass; server and dashboard contain no duplicate narration promotion/demotion logic.

- [x] **Step 7: Review checkpoint**

Run `git diff --check`. Search the changed tree for `demoteNarrationForTurn`, `promoteNarrationToAnswer`, and `stoppedMessageIndexes`; expect no matches.

---

### Task 3: Strict migration, replay boundary, and terminal tool rendering

**Files:**
- Modify: `src/state/migrations/registry.ts`
- Modify: `src/state/runtime-db.ts`
- Modify: `src/state/chat-sessions.ts`
- Modify: `src/status-server/chat.ts`
- Modify: `dashboard/src/lib/tool-activity-ring.ts`
- Modify: `dashboard/src/components/ToolCallCard.tsx`
- Modify: `tests/runtime-db-schema-v60.test.ts`
- Modify: `tests/runtime-db-schema-v33.test.ts`
- Modify: `tests/runtime-db-schema-v51.test.ts`
- Modify: `tests/runtime-db-schema-v59.test.ts`
- Modify: `tests/assistant-migration.test.ts`
- Modify: `tests/status-server-chat.test.ts`
- Modify: `dashboard/tests/tool-call-card.test.tsx`

**Interfaces:**
- Consumes: Task 1 persisted/replayable schemas and `isReplayableChatMessage`.
- Produces: strict v60 migration, `MessageRowSchema.kind: z.string()`, and tool display states `active | completed | failed | stopped`.

- [x] **Step 1: Write failing strict-migration tests**

Extend `runtime-db-schema-v60.test.ts` with three independent behaviors:

```ts
assert.throws(() => migrateDatabaseFile(dbMissingKind), /requires chat_messages\.kind/u);
assert.deepEqual(migratedKinds, [
  { id: 'legacy-user', kind: 'user_text' },
  { id: 'legacy-assistant', kind: 'assistant_answer' },
]);
assert.deepEqual(migratedTools, [
  { id: 'historical-tool', tool_call_status: 'done' },
]);
```

Update the v33 fixture DDL to include every chat-message column introduced through v32, especially `kind`, rather than relying on v60 to tolerate an invalid v32 schema.

- [x] **Step 2: Write failing replay and rendering tests**

Assert that narration, progress, running tools, and stopped tools are excluded by the shared replay guard; done tools remain replayable. Assert `ToolCallCard` renders stopped text without an active ellipsis and completed tools use a completed label.

- [x] **Step 3: Verify migration, replay, and rendering tests fail**

Run:

```powershell
npm run build:test
npm test -- runtime-db-schema-v60 runtime-db-schema-v33 status-server-chat tool-call-card
```

Expected: missing-kind migration does not fail at the required boundary, stopped status is unsupported by SQLite, and tool rendering lacks stopped/completed states.

- [x] **Step 4: Implement the complete v60 migration**

Require `chat_messages` and `kind` before mutation. Backfill null `kind` explicitly from validated role values, then add `tool_call_status` constrained to `running | done | stopped` and backfill historical tool rows as `done`. Remove the conditional skip around the status backfill.

Change `MessageRowSchema.kind` to `z.string()`. Remove `normalizeMessageKind` and `normalizeRole`; parse both fields with exported transcript kind/role schemas. Do not infer a role or kind during reads or writes. Add a database read test proving an invalid role fails at the boundary.

- [x] **Step 5: Centralize replay selection**

Replace local narration/progress/running-tool exclusions with `isReplayableChatMessage`. Use the same guard in history building, retained web-tool extraction, and context-usage accounting.

- [x] **Step 6: Render terminal tool states**

Derive `ToolActivityGroup.state` from `toolCallStatus` and exit code. Use literal expected labels:

```ts
running  -> 'Reading file src/a.ts…'
done     -> 'Read file src/a.ts'
stopped  -> 'Reading file src/a.ts — stopped'
failed   -> 'Reading file src/a.ts — failed'
```

- [x] **Step 7: Remove schema-version change detectors**

Keep `assert.equal(CURRENT_SCHEMA_VERSION, 60)` only in `runtime-db-schema-v60.test.ts`. In unrelated migration tests, assert their own migrated behavior and compare final stored version to `CURRENT_SCHEMA_VERSION` without repeating the literal.

- [x] **Step 8: Verify Task 3**

Run:

```powershell
npm run build:test
npm test -- runtime-db-schema-v33 runtime-db-schema-v51 runtime-db-schema-v59 runtime-db-schema-v60 assistant-migration status-server-chat tool-call-card chat-sessions-db
npm run typecheck
```

Expected: all selected tests and typecheck pass; malformed predecessor schemas fail loudly.

- [x] **Step 9: Review checkpoint**

Run `git diff --check`. Confirm no kind fallback, v60 missing-column skip, or unrelated literal current-version assertion remains.

---

### Task 4: Direct stopped-turn construction and single-save persistence

**Files:**
- Modify: `src/status-server/chat.ts`
- Modify: `src/status-server/routes/chat.ts`
- Modify: `src/status-server/routes/chat-repo-agent.ts`
- Modify: `tests/status-server-chat.test.ts`
- Modify: `tests/status-server-chat-stop.test.ts`
- Modify: `tests/chat-sessions-db.test.ts`

**Interfaces:**
- Consumes: Task 2 `finalizeStoppedChatTranscript` and Task 1 `PersistedChatTranscriptMessage`.
- Produces: `buildChatUserMessage(content, images, imageMeta, createdAtUtc)`, `buildChatSessionWithStoppedTurn(session, input)`, and `appendChatStoppedTurn(runtimeRoot, session, input)`.

- [x] **Step 1: Write failing stopped-builder tests**

Exercise the real builder with literal messages and assert one ordered turn:

```ts
const updated = buildChatSessionWithStoppedTurn(session, {
  content: 'inspect it',
  images: [],
  imageMeta: [],
  transcriptMessages: [thinking, stoppedTool, stoppedAnswer],
  approvalMessages: [],
});
assert.deepEqual(updated.messages.slice(-4).map((message) => message.kind), [
  'user_text', 'assistant_thinking', 'assistant_tool_call', 'assistant_answer',
]);
```

Add repo-agent coverage with an approval row between the user row and assistant transcript. Add a save-spy-free database test that reloads the session and proves exactly one final ordered turn exists.

- [x] **Step 2: Verify tests fail because the stopped builder does not exist**

Run:

```powershell
npm run build:test
npm test -- status-server-chat chat-sessions-db
```

Expected: build fails on missing stopped-builder exports.

- [x] **Step 3: Extract and reuse user-row construction**

Move the current user-message literal from `buildChatSessionWithAppendedTurn` into `buildChatUserMessage`. Both completed and stopped builders call it; neither copies its token, image, timestamp, or source metadata logic.

- [x] **Step 4: Implement the stopped-turn builder and writer**

`buildChatSessionWithStoppedTurn` validates `transcriptMessages` with `PersistedChatTranscriptMessageSchema`, rejects running tools and more than one answer, appends the user row plus optional approvals plus assistant transcript directly, and updates `updatedAtUtc`.

`appendChatStoppedTurn` calls the pure builder, invokes `saveChatSession` once, and returns the updated session.

- [x] **Step 5: Replace both route paths and delete the splice**

Direct chat/plan/repo-search catches finalize the reducer with `*Stopped by user.*` and call `appendChatStoppedTurn`. Repo-agent abort finalizes with `Repo-agent run stopped by user.` and uses the same writer with its approval rows.

Delete `attachStoppedTranscript`, the route-local `appendStoppedChatTurn`, the fake marker-only `buildChatSessionWithAppendedTurn` call, and the `input.result.status === 'aborted'` post-build splice.

- [x] **Step 6: Verify Task 4**

Run:

```powershell
npm run build:test
npm test -- status-server-chat status-server-chat-stop chat-sessions-db
npm run typecheck
```

Expected: all selected tests pass and no stopped path constructs then removes a normal assistant answer.

- [x] **Step 7: Review checkpoint**

Run `git diff --check`. Search for `attachStoppedTranscript`; expect no matches.

---

### Task 5: Typed test-engine injection

**Files:**
- Modify: `src/status-server/server-types.ts`
- Modify: `src/status-server/index.ts`
- Create: `tests/helpers/stopped-chat-engine-service.ts`
- Modify: `tests/helpers/dashboard-model-queue-harness.ts`
- Modify: `tests/helpers/streamed-op-harness.ts`
- Modify: `tests/status-server-chat-stop.test.ts`
- Modify: `tests/status-server-chat-routes.test.ts`
- Modify: `tests/repo-agent-sessions.test.ts`

**Interfaces:**
- Consumes: `StatusEngineService`, `RepoSearchExecutionRequest`, `RepoSearchExecutionResult`, and existing harness options.
- Produces: `StartStatusServerOptions.engineService?: StatusEngineService`, matching harness options, and a stateful `StoppedChatEngineService` test double with explicit scenario methods.

- [x] **Step 1: Write the failing injection test**

Create a `StatusEngineService` subclass that records one request and returns a literal valid `RepoSearchExecutionResult`. Start the real status server with `{ engineService }`, issue a chat request, and assert the HTTP result reflects that engine output. Do not assert only that the fake was called.

- [x] **Step 2: Verify the injection test fails because the option is unsupported**

Run:

```powershell
npm run build:test
npm test -- status-server-chat-routes
```

Expected: TypeScript rejects `StartStatusServerOptions.engineService`.

- [x] **Step 3: Add explicit server and harness injection**

Add `engineService?: StatusEngineService` to `StartStatusServerOptions` and construct with:

```ts
const engineService = options.engineService ?? new StatusEngineService();
```

Thread the same explicit option through `DashboardModelQueueHarnessOptions` and a new `StreamedOperationHarnessOptions` object. The injected instance must also be passed to `RepoAgentSessionManager` so direct chat and repo-agent use the same engine.

- [x] **Step 4: Implement the stateful stopped-chat test engine**

Use a class because it owns scenario state, entry notification, abort notification, post-abort release, and configured progress events. Give it explicit methods `waitUntilEntered()`, `waitUntilAborted()`, and `releaseAfterAbort()`. Its `executeRepoSearch` method emits configured typed progress events and throws immediately if an abort signal is required but absent.

Do not accept a function-valued handler in its constructor.

- [x] **Step 5: Migrate Stop tests and remove unsafe helpers**

Replace all three `StatusEngineService.prototype.executeRepoSearch` assignments in `status-server-chat-stop.test.ts` with independently injected engine instances. Delete `waitForAbort`; abort waiting belongs to the test engine and throws on a missing signal.

Keep non-live repo-agent subscribers from receiving answer events and keep live subscribers receiving them for transcript capture.

- [x] **Step 6: Run focused tests**

Run:

```powershell
npm run build:test
npm test -- status-server-chat-stop status-server-chat-routes repo-agent-sessions
npm run typecheck
```

Expected: all selected tests pass with no production-prototype mutation in the Stop test.

- [x] **Step 7: Review checkpoint**

Run `git diff --check`. Search `tests/status-server-chat-stop.test.ts` for `StatusEngineService.prototype` and `new Promise<void>(() =>`; expect no matches.

---

### Task 6: Durable operation completion and final verification

**Files:**
- Modify: `src/status-server/chat-session-operation-registry.ts`
- Modify: `src/status-server/routes/chat-session-operation-endpoint.ts`
- Modify: `src/status-server/routes/chat.ts`
- Modify: `tests/chat-session-operation-registry.test.ts`
- Modify: `tests/status-server-chat-stop.test.ts`

**Interfaces:**
- Consumes: Task 5 `StoppedChatEngineService` and existing `ChatSessionOperation` lease identity and abort registration.
- Produces: `ChatSessionOperationCompletion`, atomic `finish(lease, completion)`, and `waitForCompletion(lease)`.

- [x] **Step 1: Write failing registry completion tests**

Prove completion remains pending until explicitly settled, resolves once, rejects foreign leases, and preserves a failed error:

```ts
const waiting = registry.waitForCompletion(lease);
assert.equal(await remainsPending(waiting), true);
assert.equal(registry.finish(lease, { kind: 'completed' }), true);
assert.deepEqual(await waiting, { kind: 'completed' });
assert.equal(registry.finish(lease, { kind: 'failed', error: 'late' }), false);
```

- [x] **Step 2: Write failing HTTP durability tests**

Configure `StoppedChatEngineService` to pause after observing abort. Start Stop without awaiting it, wait for `waitUntilAborted()`, and prove the Stop request remains pending. Release the engine, await Stop, immediately GET the session, and assert the full transcript is present.

For the failure branch, drop `chat_messages` only inside the test's managed temporary database after abort is observed and before releasing the engine. Assert Stop returns `500` rather than `200`; teardown removes the entire temporary repository.

- [x] **Step 3: Verify tests fail because Stop returns before completion**

Run:

```powershell
npm run build:test
npm test -- chat-session-operation-registry status-server-chat-stop
```

Expected: Stop resolves while the post-abort engine gate is still held, and persistence failure still reports success.

- [x] **Step 4: Implement registry-owned completion state**

Store one deferred completion record per acquired lease inside `ChatSessionOperationRegistry`. Expose explicit `finish` and `waitForCompletion` methods; do not put resolver callbacks on the public lease.

`finish` atomically verifies the active lease, removes it from the active registry, and resolves its completion exactly once. `ChatSessionOperationEndpoint.handle` passes `{ kind: 'completed' }` after `run()` returns or `{ kind: 'failed', error }` when it throws, then rethrows failures after settlement so existing route error handling remains authoritative.

- [x] **Step 5: Await completion in Stop**

Make `StopChatOperationEndpoint.handle` async. After ownership validation, capture `waitForCompletion(active)` before requesting abort, then await it. Return `200` for completed finalization and `500` with the captured error for failed finalization.

- [x] **Step 6: Verify durable completion**

Run:

```powershell
npm run build:test
npm test -- chat-session-operation-registry status-server-chat-stop dashboard-chat-concurrency
npm run typecheck
```

Expected: Stop does not resolve before durable completion; existing queue release and ownership behavior remains green.

- [x] **Step 7: Run complete verification**

Run each command freshly and preserve its exit code:

```powershell
npm test
npm run typecheck
npm run lint
npm run build
git diff --check
git status --short
```

Expected: full suite, typecheck, lint, build, and diff check pass. Only scoped source, tests, spec, and plan files are modified. Report any skipped tests and build warnings explicitly.

- [x] **Step 8: Final requirements audit**

Re-read the design acceptance criteria and verify each against code or a named test. Confirm no `LiveChatMessage`, `PersistedChatMessage`, `attachStoppedTranscript`, `stoppedMessageIndexes`, Stop-test prototype assignment, missing-kind fallback, or unrelated hardcoded schema-version assertion remains.

- [x] **Step 9: Review checkpoint**

Inspect the complete diff for scope drift and preserve all unrelated user changes. Do not commit.

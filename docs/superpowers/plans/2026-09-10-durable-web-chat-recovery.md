# Durable Web Chat Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan sequentially after implementation is authorized. Use checkbox steps to track progress. This document authorizes no implementation or production-data changes. The session instruction **do not use SiftKit** remains in effect; implement directly, without delegation, worktrees, or commits unless the user changes those instructions.

**Goal:** Preserve Web UI conversations across refresh, Stop, approval timeout, provider failure, persistence failure, and server restart, and reconstruct complete continuation context from durable evidence without repeating completed actions.

**Architecture:** A versioned, append-only chat journal becomes the authoritative record for Web UI conversation and execution history. SQLite chat rows and browser state are projections of that journal; typed engine transcript mutations preserve model context independently of display rows. Persist before publishing visible progress or crossing execution boundaries, then reconcile projections at startup, read, attach, and continuation.

**Tech Stack:** TypeScript, existing Zod and better-sqlite3 dependencies, Node HTTP/SSE, shared contracts/reducer, React, existing compiled Node and dashboard test runners.

**Spec:** The requirements, architecture, data contracts, lifecycle rules, and acceptance matrix in this document are the implementation specification. No separate speculative design or alternate implementation is required.

## Global constraints

- Keep implementations succinct, explicit, and straightforward. Prefer the smallest complete solution. Reuse code; keep logic DRY.
- All code and tests must be TypeScript and inferred end-to-end. Parse IO with runtime schemas and derive types with `z.infer`.
- No `any`, type assertions, non-null assertions, namespace imports, unknown-laundering, schema-duplicating types, or unvalidated IO. `as const`, `satisfies`, named aliases, and valid type guards are allowed.
- Use classes only for shared state/behavior. Use explicit dependencies; do not introduce callback-dispatch frameworks or dynamically passed functions except where external APIs require them.
- Refactors replace the old Web UI path completely. No dual persistence authorities, silent legacy readers, runtime compatibility shims, heuristic associations, or preview-output fallbacks.
- Explicit one-time data migrations are required, including migration of existing chat history. They are not a permanent alternative execution path.
- No SiftKit commands, worktrees, subagents, or commits under the present session instructions.
- Preserve existing unrelated edits, especially the in-progress token/queue work in `routes/chat.ts`, the shared reducer, dashboard runtime store, and `ChatTab.tsx`.
- TDD per task: failing behavioral test, minimum implementation, passing tests, then refactor. Never weaken valid tests.
- Keep task scratch output under `.scratch/web-chat-recovery`; tests use the existing managed temporary-directory utilities. Clean only task-owned artifacts at completion.
- Do not run tests against the production database or model server. Production repair is a separately gated rollout action after a concrete dry-run report and backup exist.

## 1. Evidence and scope

### Confirmed incident

- Engine request/log ID: `706f2e52-01ec-4e62-9dc0-b7ced282e27e`.
- Repo-agent session ID: `074bbeb7-88aa-4412-8e38-94ad8bf1cf80`.
- Web chat ID: `3e3b5cf7-39ce-438b-8d6c-1031056e471d`.
- Approval ID: `e08682f5-9b0d-49ab-b4ef-cc0f027089ff`.
- Started `2026-09-10T11:04:54.755Z`; failed `2026-09-10T12:19:37.005Z`; 103 model turns, 116 command starts/results, 61 approval verdicts.
- Saved repo-agent state records `approval_timeout` at `12:19:36.905Z`, awaiting a command beginning `Remove-Item research/brawl_sim/physics.py`.
- The live database has schema marker 67 and a `chat_messages.tool_call_status` CHECK accepting only `running` and `done`. Current source also accepts `stopped`.
- The affected chat has zero persisted message rows. A delivered queue row links the chat to the engine request at turn 41. The run's JSONL exists identically in `run_logs` and `runtime_artifacts` (`9d5ca37a-45d6-4c61-bf28-6044e9da93da`).
- A memory-only copy of the actual table definition rejects `stopped` with the reported CHECK failure. The historical HTTP 500 console line was not independently found; do not present that line as observed evidence.

### Current code that must change

| Area | Current implementation and consequence |
| --- | --- |
| Schema | `src/state/runtime-db.ts`: version 67; only upgrade is 66→67. `runtime-schema.ts` uses `CREATE TABLE IF NOT EXISTS`; it cannot repair an existing CHECK. |
| Engine archive | `src/repo-search/logging.ts:createJsonLogger` accumulates `lines` in memory. `execute.ts` persists on completed/failed exit. A hard process crash can lose this archive too. |
| Web repo-agent | `routes/chat-repo-agent.ts:runChatRepoAgentTurn` waits for settlement before `appendChatRepoAgentMessages`. |
| Other Web operations | `routes/chat.ts`, `chat-repo-operation-runner.ts` also have separate completed/stopped terminal writers. Plain message, plan, repo-search, and condense must be included. |
| Current persistence | `chat.ts` appends terminal evidence; `state/chat-sessions.ts` rewrites session messages. A failed transaction does not create the missing turn. |
| Progress | `routes/chat.ts:ChatStreamProgressWriter` keeps an in-memory transcript. Streamed tool results contain previews; complete results are hydrated from the terminal engine archive. |
| Context | `chat.ts:buildChatHistoryMessages` builds provider history from saved rows; only completed tool rows replay. `TranscriptManager` holds richer live message structure and mutations in memory. |
| Browser attach | `chat-operation-broadcast.ts` retains only 8 MiB in memory. `routes/chat-operation-attach.ts` uses active in-memory operation and approval registries. |
| Queue recovery | `chat-queue-recovery.ts` recovers delivered user messages, inserts an evidence-unavailable marker, deletes incorporated deliveries, and pauses the queue. It does not reconstruct execution. |
| Existing repair | `repo-agent-history-repair.ts` repairs output on existing rows; it cannot recreate an empty chat. |
| Approvals | `approval-gate.ts` has a 600,000ms timer and an in-memory pending map. Repo-agent state files retain some terminal approval information, but not a restorable engine stack. |

### In scope

All Web UI operations: message, plan, repo-search, repo-agent, manual condense, queued/forced continuations, approval decisions, edits/deletions of conversation evidence, and image retention/removal. Both streaming and non-streaming HTTP routes must use the same durable lifecycle. Existing archive consumers and standalone CLI behavior must remain correct.

### Recovery guarantee

1. Every accepted submission and every frame displayed as authoritative is durable before its acknowledgement/publication.
2. Each tool proposal, authorization, execution-start boundary, complete result, finalized model-visible result, and context mutation is durable before its dependent action.
3. After interruption, the UI reconstructs the committed conversation, ordering, text, tool status/results, approval history, queued messages, images, compaction boundaries, and measured usage. Configuration-controlled thinking/image retention remains intentional and explicit.
4. Continue loads this reconstructed history. It does not start with an empty chat, replay output previews, or silently discard incomplete actions.
5. Successful tools are not automatically executed again by recovery. Recovery of history is separate from restarting computation.
6. A process crash after an external side effect but before a durable result cannot provide exactly-once execution for arbitrary shell commands. Such an action is recorded as **outcome uncertain** and the next run must verify effects before retrying. Do not fabricate a result or exit code.
7. A crash before bytes reach SiftKit cannot preserve those bytes. Published frames and committed engine evidence must survive; unpublished provider fragments have no stronger guarantee.
8. SQLite cannot recover a destroyed/unavailable storage device. Surface a storage/recovery error; never show a fabricated empty successful conversation.

## 2. Design decisions

### One journal, two deterministic projections

Use `chat_runs` and `chat_run_events` in the existing runtime database. Keep `chat_messages` as a replaceable display projection, and a per-run context projection for the engine. Do not use saved display previews to recreate tool protocol messages.

Store two explicitly different kinds of evidence in the same ordered journal:

- **Conversation events:** submitted/queued user messages, typed text deltas, tool lifecycle/full results, approvals, progress, usage, context metadata, images, compaction, terminal outcome, and user-directed history edits.
- **Engine context events:** validated mutations to the exact planner message sequence. Preserve native tool-call IDs/arguments, assistant batch grouping, reasoning permitted by policy, image content/references, rejection messages, output finalization, and compaction replacement.

The existing shared reducer remains the basis for display projection. Extend it rather than implementing a second competing message reducer. Extract context replay from the large `chat.ts` module and make it consume journal-derived context plus an imported legacy baseline.

The old JSONL remains a diagnostic archive and a one-time migration input. It is not an alternate live Web UI recovery authority. New full tool results must reach the journal directly from the engine; a Web run must never wait for `logger.persist()` to reconstruct itself. Existing diagnostic logger APIs may remain for CLI/observability; remove their use as the mandatory Web persistence dependency.

### Durable ordering and write failures

Allocate event sequence numbers within a transaction scoped to the run. Require an operation identity and expected revision for writes. Identical event-ID retries are idempotent; a different payload under the same event ID is corruption and fails explicitly.

Commit the source event before applying/publishing its projection. A projection exception must not roll back the source event. Track projected sequence separately; rebuilding retries from that checkpoint. Never acknowledge an approval or launch a tool after its journal write failed.

Text may be coalesced using the existing live-text cadence, but commit each emitted delta before SSE transmission. Commit full completed model text/context before another model/tool step. Do not write full accumulated text on every token. Append-only deltas and transcript mutations avoid quadratic growth; a full context replacement is reserved for actual compaction/retention or an initial snapshot.

Use WAL with `synchronous=FULL` on the connection performing journal commits. Audit connection reuse in `runtime-db.ts` so no later initializer quietly resets it to NORMAL. This is a deliberate durability change; measure its cost with batched text publication. Use existing SQLite backup support, not filesystem copying of a live WAL database.

### Context mutation ownership

`TranscriptManager` becomes the only owner of mutable planner history. Its externally exposed message view is readonly. Move callers that currently modify `getMessages()` results to explicit mutation methods.

Each mutation describes a splice against an expected context revision: initial snapshot, append, insert, replace tool message, trailing-user replacement, thinking/image retention, and whole-context compaction. Commit first, then apply the same mutation in memory. Do not infer mutation deltas by polling serialized prompts or parse native arguments back out of rendered shell command strings.

Continuation takes the previous retained conversation/context, applies configured retention and current system instructions through the existing prompt builder, then appends the new submission once. It does not copy an old system prompt as an extra user/assistant message. Store the original effective execution settings for audit; an explicit change in model/mode uses the currently selected validated settings. Provider caches and token-level generation state are not restored.

Tool proposals and individual results are recorded before a batch is appended to live model history. If the server dies halfway through a batch, context reconstruction closes outstanding calls with explicit interruption results while retaining completed full results. This produces protocol-valid history without running the unfinished batch. Record the synthetic interruption result as recovery metadata, distinguish it from real tool output, and tell the next model whether execution never started or its outcome is uncertain.

Partial assistant text can be committed for display before the engine appends a completed assistant message. During recovery, include that retained partial narration/answer in continuation history exactly once, tagged as interrupted; do not discard it merely because no context splice was reached. Reconcile by stable message/turn identity against the context already present. Reasoning is included only under the existing reasoning-retention policy. Preserve completed assistant/tool batch grouping; do not insert partial text between a tool call and its required results.

### Approval and continuation semantics

- Keep **600,000ms per approval**. Persist `requestedAtUtc` and `expiresAtUtc`; refresh never extends the deadline.
- Browser detachment does not abort a live operation. Reattach presents the current approval, not a replayed historical approval card.
- On server restart, preserve the old approval as evidence, but mark its live execution binding interrupted. A dead Promise is not a restorable approval target. Do not expose a button that sends a decision to a nonexistent run.
- Continue starts a new operation with recovered context. An unexecuted proposed action is visible to the model; if proposed again it goes through a fresh approval request. Do not inherit a previous approval as blanket permission for newly generated commands.
- If the original engine is still alive, approving its pending request continues that same run; no recovery or duplicate model request occurs.
- Terminal causes remain distinct: completed, user_stop, approval_timeout, provider_failure, execution_failure, storage_failure, server_restart. Stop never automatically resumes. Queued pending messages remain available but do not automatically execute after an interrupted run.

### Read, attach, and continuation

Before returning a chat or accepting a continuation, reconcile its pending journal events. An unrepairable event causes a typed recovery error naming run/event IDs without leaking tool payloads. Preserve the readable prefix and display an explicit recovery failure; block model execution until integrity is resolved.

Attach uses a consistent database snapshot plus sequence cursor, followed by newer events. Subscribe and capture the high-water sequence atomically relative to in-process publication, buffer during snapshot transmission, discard duplicates at/below the cursor, and catch up from the journal. Reconnect supports completed/interrupted operations as well as active ones. An old browser cursor must not make history disappear.

Replace the 8 MiB in-memory replay authority. The broadcast can remain a bounded live fan-out queue; if a subscriber falls behind, close it with a resumable cursor rather than discarding history. Page journal reads and bound the network queue. Do not send a multi-megabyte unbounded synchronous preamble.

### Retention, edits, and deletion

User edits, message deletion, image removal, condense, and session deletion must update the journal/projection coherently. Recovery must never resurrect a deleted message/image or un-condense history.

Record typed conversation revisions/tombstones and durable image payloads or pinned content references. Remove superseded sensitive payloads in journal/context snapshots when the existing delete operation promises removal; a tombstone alone must not leave a supposedly deleted image replayable. Archive pruning must not delete the only evidence needed by an existing chat. Chat deletion cascades its journal/projections and releases owned blobs; shared artifacts remain until no references exist.

### Migration and recovery policy

- Add an explicit 67→68 migration, retaining the existing 66→67 chain. If the schema version advances before execution, allocate the next version and update every fixture/step consistently; never overwrite another upgrade.
- Rebuild `chat_messages` with the canonical definition and explicit column copy. Preserve all columns, primary keys, indexes, ordering, foreign-key relationships, and existing values. Test both stale and already-current CHECK definitions under marker 67.
- Import existing complete chats as deterministic baseline events before routing them through the new projector. Preserve message IDs as opaque values; do not rename all historical `stopped-...` IDs merely for aesthetics.
- Import archived runs only when an exact chat/run association exists: existing `source_run_id`, delivered queue request ID, or an explicit validated repair mapping. Titles, timestamps, repository names, and model names are not sufficient joins.
- The historical importer is versioned and invoked explicitly during migration/recovery; it is never a fallback in normal model replay. After import, ordinary reads consult the journal only.
- Modern `identified-v1` archives use call IDs. Historical unidentified archives may be imported only when complete unambiguous pairing can be established; otherwise return an unresolved report, never guess based on equal commands.
- Preserve an immutable import provenance record and source digest. Re-importing identical evidence is a no-op; changed/conflicting evidence fails loudly. Do not destroy original archives as part of migration.
- Already completed unrelated chats stay unchanged. Recovery of a missing run inserts it at a proven position, not at an arbitrary end of a chat that may have continued later.

## 3. File and responsibility map

New modules are proposed names, not existing files. Keep their responsibilities narrow and reuse existing schemas/helpers where possible.

| Module | Responsibility |
| --- | --- |
| `packages/contracts/src/chat-recovery.ts` (new) | Recovery/operation states, event cursor, snapshot response, durable approval fields and error schemas shared with dashboard. |
| `packages/contracts/src/chat-transcript-reducer.ts` | One display reducer for live, loaded, completed, stopped and reconstructed evidence. |
| `src/repo-search/planner-chat-message.ts` (new) | Runtime schema for the existing planner message shape and inferred type; replace the hand-authored declaration in `planner-protocol.ts`. |
| `src/state/chat-journal-schema.ts` (new) | Strict event bodies/envelopes, context mutation schemas, stored-run schema, inferred types. |
| `src/state/chat-journal.ts` (new) | Durable run/event insertion, idempotency, sequence/CAS, cursor reads, projection checkpoints. |
| `src/state/schema-upgrades/chat-recovery.ts` (new) | Explicit migration and table rebuild using canonical schema definitions. |
| `src/status-server/chat-run-recorder.ts` (new) | Concrete owner of one Web operation's journal writes and post-commit publication. |
| `src/status-server/chat-run-projection.ts` (new) | Incremental/rebuild projection using the shared reducer; full result hydration from journal events. |
| `src/status-server/chat-context-replay.ts` (new) | Context mutation replay, batch closure, retained history for continuation. |
| `src/status-server/chat-run-recovery.ts` (new) | Startup/read/continue reconciliation and orphaned run classification. |
| `src/status-server/chat-history-import.ts` (new) | Explicit legacy baseline/archive importer and integrity report. |
| `src/status-server/chat-stream-progress-writer.ts` (new) | Extracted progress conversion/text coalescing; delegates durable ownership to recorder, no private authoritative transcript. |
| `src/status-server/chat-operation-broadcast.ts` | Bounded fan-out only; journal-backed catch-up replaces retained-frame authority. |
| `scripts/recover-web-chat.ts` (new) | Exact-ID dry-run/apply repair command, backup verification, structured report; no automatic production execution. |
| `tests/helpers/chat-recovery-process.ts` (new) | Controlled child-process HTTP test harness with deterministic barriers and isolated database. |

Existing integration files include `runtime-db.ts`, `runtime-schema.ts`, `chat-sessions.ts`, `chat-message-queue.ts`, `TranscriptManager`, `tool-action-processor.ts`, `approval-gate.ts`, `repo-agent-sessions.ts`, `routes/chat*.ts`, `chat-repo-operation-runner.ts`, `server-types.ts`, `index.ts`, dashboard runtime/parser/transitions/hooks/components, and archive cleanup/restore code named in the tasks below.

## 4. Data and interface contracts

### Tables

| Table | Required fields and constraints |
| --- | --- |
| `chat_runs` | `operation_id TEXT PRIMARY KEY`, `session_id` FK, `record_kind` (`execution`, `baseline`, `history_revision`), operation kind (required for execution, null otherwise), nullable bound engine `request_id` and repo-agent session ID with unique non-null identities, monotonic run order within session, `owner_epoch`, creation/update times, terminal cause, latest sequence, projected sequence, context revision, validated effective-settings JSON (execution only), migration/source provenance. One unfinished owned execution per session via a partial unique index. Baselines/revisions are committed records, never fake model runs. |
| `chat_run_events` | `(operation_id, sequence)` PK; `event_id` unique within operation; version; time; validated event body JSON; stable payload digest. FK to `chat_runs`; index supporting ordered cursor reads. Sequence begins at 1. No arbitrary permissive payload cast. |
| `chat_context_snapshots` | operation ID PK/FK; applied sequence; context revision; validated retained model messages; recovery batch state. Rebuildable cache, never independent authority. |
| `chat_session_recovery` | session ID PK/FK; baseline/import version; last reconciled run order; typed status/error; owner epoch where needed. Do not put opaque recovery state in unrelated metadata keys. |
| `chat_runtime_owner` | singleton row for Web runtime ownership: owner ID, monotonic fencing epoch, heartbeat time and lease expiry. Acquired/renewed with compare-and-swap in SQLite. It is separate from individual run/projection records. |

`chat_messages` remains the display projection. Its runtime schema must support visible in-progress rows as well as done/stopped rows; replace the misleading distinction that a persisted row can never be running. Model replay remains separately validated and does not permit orphan protocol calls.

Add a schema-derived `executionState` to projected tool evidence: `proposed`, `pending_approval`, `executing`, `completed`, `rejected`, `not_started`, or `uncertain`. Keep `toolCallStatus` as the existing display lifecycle (`running`, `done`, `stopped`) and derive it from that state in one reducer. Completed/rejected map to done; proposed/pending/executing map to running while owned; interrupted never-started/uncertain map to stopped. Do not persist an invented exit code for rejected or interrupted actions. Import old stopped rows as uncertain unless stronger archive evidence proves execution never started.

### Canonical event families

Define `ChatJournalEventSchema` as a strict discriminated union. Reuse `ChatTranscriptEventSchema`, queue schemas, approval schemas, content schemas, usage schemas and message schemas rather than restating their fields.

| Kind | Durable content |
| --- | --- |
| `run_started` | initial user ID/content/images, operation kind, session ID, ordering, validated effective settings, retained history revision |
| `engine_bound` | engine request ID, nullable repo-agent session ID; binding cannot later change |
| `display` | existing typed transcript event; complete coalesced delta committed before sending |
| `context_initialized` | initial validated planner sequence and current-turn boundary |
| `context_spliced` | expected revision, start index, delete count, inserted messages, resulting turn boundary, reason enum |
| `tool_proposed` | call/batch identity, turn/index, tool name, structured arguments, requested command, execution classification |
| `tool_started` | call identity and start time, after approval/authorization commit |
| `tool_result` | call identity, executed/rejected classification, exit code or null, complete result including empty string, image payload/references, measured counts |
| `tool_result_finalized` | call identity, exact replacement text actually inserted into planner history, finalization revision |
| `approval_requested` | call ID, approval ID, exact proposal/review payload, requested time, expiry, mode |
| `approval_resolved` | original approval identity, decision/outcome, reason, decision time; outcome includes timeout/interrupted |
| `queue_delivered` | original queue message identity, content/images, operation/request, turn/boundary; atomic with delivery claim |
| `run_finished` | terminal cause, detail, final measured usage, recovery status; no second fabricated assistant answer |
| `history_revised` | validated edit/delete/image-removal/condense action with expected session revision |
| `baseline_imported` | existing saved messages and validated legacy retained context, source digest/version |

New event formats reject unknown versions. Importers explicitly recognize only documented historical kinds; malformed context-affecting events block import. Diagnostic events may be excluded only by a documented allowlist, not a catch-all silent skip.

### Interfaces to establish before wiring callers

All named input/output types below are derived from runtime schemas in the module map. Methods return inferred schema values; no parallel interface declarations duplicating their fields.

```ts
// src/state/chat-journal.ts
class ChatJournalStore {
  begin(input: ChatRunStart): ChatRun;
  bindEngine(input: ChatEngineBinding): ChatRun;
  append(input: ChatJournalAppend): ChatJournalEnvelope;
  readAfter(operationId: string, afterSequence: number, limit: number): ChatJournalEnvelope[];
  readRun(operationId: string): ChatRun | null;
  listSessionRuns(sessionId: string): ChatRun[];
}

// src/status-server/chat-run-projection.ts
function reconcileChatRun(database: RuntimeDatabase, operationId: string): ChatRecoveryReport;
function rebuildChatRun(database: RuntimeDatabase, operationId: string): ChatRecoveryReport;

// src/status-server/chat-context-replay.ts
function replayChatContext(events: readonly ChatJournalEnvelope[]): ChatRecoveredContext;
function buildRecoveredChatHistory(database: RuntimeDatabase, sessionId: string): ChatRecoveredHistory;

// src/status-server/chat-run-recovery.ts
function recoverInterruptedChatRuns(database: RuntimeDatabase, ownerEpoch: string): ChatRecoveryReport[];
function reconcileChatSession(database: RuntimeDatabase, sessionId: string): ChatRecoveryReport;

// src/status-server/chat-history-import.ts
function inspectChatHistoryImport(database: RuntimeDatabase, input: ChatHistoryImportRequest): ChatHistoryImportReport;
function applyChatHistoryImport(database: RuntimeDatabase, input: ChatHistoryImportRequest): ChatHistoryImportReport;
```

`ChatJournalAppend` contains operation ID, owner epoch, expected sequence, event ID, timestamp, and a validated `ChatJournalEvent`. Read methods validate every row. `ChatRecoveryReport` includes session/operation IDs, applied sequence, event/message/tool counts, outcome, and issues containing IDs/reason codes. `ChatRecoveredHistory` contains protocol-valid messages and interruption notices, with no provider-specific caches. `ChatHistoryImportRequest` contains explicit session/request identities, optional repo-agent state evidence, expected source digest, and dry-run/apply scope; source evidence is parsed before entering mutation code.

## 5. Sequential implementation tasks

Run `npm run build:test` before each focused runner invocation after changing tests/source. Commands below use the repository's compiled runner, not direct `tsx --test` imports. Review each task's diff and tests before moving on. Tests may start red because a named production API does not exist, but the first behavioral red assertion must be observed once the module loads.

### Task 1: Reproduce and repair the schema defect

**Files:** Modify `src/state/runtime-db.ts`, `src/state/runtime-schema.ts`, `tests/runtime-db-schema.test.ts`, `tests/chat-sessions-db.test.ts`; create `src/state/schema-upgrades/chat-recovery.ts`.

**Consumes:** Existing version 66/67 schemas and production CHECK definition. **Produces:** a tested next-version migration with canonical `chat_messages` constraints; migration module extended by Task 2 before rollout.

- [x] Add a fixture database at marker 67 with the actual `running/done` CHECK and representative messages in every column, indexes, and related session/queue rows. Include a second marker-67 fixture already accepting `stopped`.
- [x] Add a regression that opens the stale fixture through `getRuntimeDatabase`, saves a stopped tool row using the normal store, closes/reopens it, and checks every original row/column survives.
- [x] Assert the initial failure is the stale CHECK, not a missing fixture/import. Test rollback on injected copy failure and verify the schema marker does not advance.
- [x] Extract the canonical chat-table DDL/column list so fresh creation and the rebuild cannot drift. Rebuild with explicit column names; recreate indexes and check foreign keys. Do not use `SELECT *`, `writable_schema`, or a `tableHasColumn` guard as constraint migration.
- [x] Keep migration atomic, support 66→67→new version, and verify stale/already-correct definitions converge. Validate expected object/column layout; reject unsupported drift rather than discarding extra data.
- [x] Run focused tests and inspect the copied DB definitions and row equality.

```ts
assert.match(tableDefinition, /'stopped'/u);
assert.deepEqual(rowsAfterUpgrade, rowsBeforeUpgrade);
assert.equal(reopenedStoppedMessage.toolCallStatus, 'stopped');
assert.deepEqual(foreignKeyFailures, []);
```

**Validation:** `node dist/test-runner/run-tests.js runtime-db-schema chat-sessions-db`.

**Acceptance:** No data loss, transactional marker advance, stopped writes succeed on both old CHECK variants. Do not run the production migration yet.

### Task 2: Add typed durable journal storage

**Files:** Create `packages/contracts/src/chat-recovery.ts`, `src/state/chat-journal-schema.ts`, `src/state/chat-journal.ts`, `src/repo-search/planner-chat-message.ts`; modify `src/repo-search/planner-protocol.ts` and consumers of its old hand-authored message type, contract exports, runtime schema/upgrade and configuration; create `tests/chat-journal.test.ts`, `tests/contracts-chat-recovery.test.ts`.

**Consumes:** Task 1 migration and existing runtime schemas. **Produces:** the store and event/row contracts in section 4.

- [x] Write storage regressions: begin/bind, append and reopen, identical retry, conflicting same-ID retry, stale sequence/owner, wrong-session binding, unknown version, and missing run.
- [x] Define a runtime schema for the existing planner message shape using reusable protocol content/tool schemas, derive `ChatMessage`, and migrate its type imports. This schema must exist before the journal's context event union references it; remove the old hand-maintained declaration without a compatibility re-export.
- [x] Add journal/context/recovery tables to the same unreleased upgrade. Add required FK/unique indexes; keep event and binding insertion transactional.
- [x] Implement strict event IO, sequence allocation and payload digest comparison. Generate operation binding before engine dispatch, never by later log search.
- [x] Enable FULL durability for journal writes and test the effective connection setting after repeated runtime DB access.
- [x] Commit source evidence separately from projection. Test a projection callback failure indirectly through the later projector boundary; store APIs must not require a function argument for projection.
- [x] Verify memory grows with the current pending write/page, not the lifetime of the conversation; use paged `readAfter`.

```ts
assert.equal(first.sequence, 1);
assert.equal(retry.sequence, first.sequence);
assert.equal(store.readAfter(operationId, 0, 100).length, 1);
assert.throws(() => store.append(conflictingRetry), /conflicting event/u);
assert.throws(() => store.append(staleOwnerWrite), /owner/u);
```

**Validation:** `node dist/test-runner/run-tests.js chat-journal contracts-chat-recovery runtime-db-schema`.

**Acceptance:** A committed event survives reopen; replay cannot duplicate or silently change it; schema validation rejects malformed evidence.

### Task 3: Make planner context schema-derived and mutation-owned

**Files:** Modify `src/repo-search/planner-chat-message.ts`, `src/repo-search/planner-protocol.ts`, `src/repo-search/engine/transcript-manager.ts`, `src/tool-call-messages.ts`, retention policies and all callers that mutate returned history; extend `tests/engine-transcript-manager.test.ts`, `tests/engine-transcript-compactor.test.ts`; create `tests/chat-context-replay.test.ts` and `src/status-server/chat-context-replay.ts`.

**Consumes:** Journal context events. **Produces:** schema-derived `ChatMessage`, validated context splices, `replayChatContext`, `buildRecoveredChatHistory`.

- [x] Reuse Task 2's planner schema and inferred type throughout mutation/replay boundaries; add semantic role/tool-pair validation without creating another message type.
- [x] Add failing context round-trip tests for tool batches, rejected calls, finalized output replacement, empty output, multimodal content, inserted images, queued user steering, trailing-message replacement, thinking pruning, and compaction that preserves an unfinished turn.
- [x] Make all planner-history mutations explicit methods. Return a readonly view; eliminate caller-side array/object mutation. Serialize each validated splice with an expected context revision.
- [x] Implement replay of initial context and splices with revision/index/boundary validation. A gap or invalid mutation returns a recovery integrity error instead of partial silent context.
- [x] Reuse current system-prompt and retention policy behavior when building a new run, but source retained conversation history from the journal projection. Keep the current display reducer independent of provider message grouping.
- [x] Handle an interrupted batch by preserving complete results and producing explicit protocol-closing interruption messages for remaining calls. Distinguish never-started from uncertain execution in both context and display.

```ts
assert.deepEqual(replayChatContext(recordedEvents).messages, liveTranscript.getMessages());
assert.equal(recoveredToolResult.content, finalizedModelVisibleText);
assert.equal(recoveredAssistant.tool_calls?.length, 2);
assert.equal(uncertainResult.content.includes('Outcome uncertain'), true);
assert.equal(toolExecutionCountAfterReplay, toolExecutionCountBeforeReplay);
```

**Validation:** `node dist/test-runner/run-tests.js engine-transcript-manager engine-transcript-compactor chat-context-replay chat-tool-results`.

**Acceptance:** Native message grouping and exact finalized full output survive replay; context mutation cannot bypass recording when a Web operation is bound.

### Task 4: Record Web engine evidence before dependent execution

**Files:** Create `src/status-server/chat-run-recorder.ts`; modify `src/repo-search/engine.ts`, `src/repo-search/execute.ts`, `src/repo-search/engine/tool-action-processor.ts`, `progress-reporter.ts`, `transcript-manager.ts`, `pending-tool-call-message.ts`, `src/status-server/repo-agent-sessions.ts`, `src/status-server/engine-service.ts` and request schemas; create `tests/chat-run-recorder.test.ts`; extend `tests/tool-action-approval.test.ts`, `tests/rejected-command-transcript.test.ts`.

**Consumes:** Store and context mutation contracts. **Produces:** a concrete recorder bound to each Web engine request, complete lifecycle events, and commit-before-action ordering.

- [x] Add a test that fails the journal write before tool start and verifies the external command never runs. Add a second case where full result recording fails: no next model turn may consume an unrecorded result.
- [x] Record operation/request/repo-agent IDs separately and immutably. Bind before issuing model requests or exposing run identifiers.
- [x] Record typed tool proposals before approval, starts after durable authorization, and complete results before the next dependent operation. Reuse stable tool IDs assigned before review; store structured arguments directly.
- [x] Capture the exact `turn_command_result_finalized` replacement before it mutates command output/context. Preserve rejected calls and empty successful outputs. Include images and measured usage.
- [x] Attach recording at context mutation and semantic progress boundaries, not by reparsing terminal JSONL or SSE snippets. Make storage failure fatal to further work and separately reportable from provider failure.
- [x] Keep diagnostic logger behavior available to existing non-Web consumers, but remove the Web recorder's dependency on terminal `getText/persist`. Diagnostic events are not a second recovery path.
- [x] Add source-level caller checks/tests to ensure every Web engine entrypoint supplies the recorder. Do not silently accept a missing recorder for a Web request.

```ts
assert.deepEqual(observedOrder, ['proposal_committed', 'approval_committed', 'start_committed', 'execute', 'result_committed', 'next_model']);
assert.equal(executionsWhenStartCommitFails, 0);
assert.equal(modelCallsAfterResultCommitFails, 0);
```

**Validation:** `node dist/test-runner/run-tests.js chat-run-recorder tool-action-approval rejected-command-transcript engine-transcript-manager`.

**Acceptance:** Context and all Web tool evidence survive hard exit without terminal archive persistence; no uncertain action is automatically replayed.

### Task 5: Replace terminal-only chat projection

**Files:** Create `src/status-server/chat-run-projection.ts`, `src/status-server/chat-stream-progress-writer.ts`; modify `packages/contracts/src/chat.ts`, the shared reducer, `src/state/chat-sessions.ts`, `src/status-server/chat.ts`, `routes/chat.ts`, `routes/chat-repo-agent.ts`; create `tests/chat-run-projection.test.ts`; extend reducer, persistence and token-parity tests.

**Consumes:** Recorded display/context/tool events. **Produces:** deterministic incremental/rebuild display projection and extracted progress writer.

- [x] Write a regression that commits events, forces the message projection to throw, reopens storage, rebuilds, and compares all message content/IDs/order to a fault-free run.
- [x] Update persisted/display schemas to represent in-progress rows; remove the old rule that persistence implies terminal tool status. Keep model replay validation distinct.
- [x] Extend the shared reducer with full-result and lifecycle state support. Preserve current token-counter fixes, segment identity and retention behavior; never overwrite measured usage with a later text delta.
- [x] Extract `ChatStreamProgressWriter` from the route file. Delete its independent authoritative `transcriptMessages`/`getStoppedMessages` path. Coalesce text, commit, project, then publish.
- [x] Replace completed/stopped builders with `run_finished` plus reconciliation. Remove Web calls to terminal `hydrateTerminalChatMessages` and full-session reconstruction from telemetry scorecards.
- [x] Update projection rows incrementally by stable identity; advance checkpoint atomically with projection writes. Rebuild an affected run from zero without replacing unrelated session rows. Terminal replay is idempotent and does not generate a second answer or double usage.
- [x] Keep journal evidence committed if SQL projection fails. Return a recovery-needed status; continuation retries reconciliation before dispatch.

```ts
assert.deepEqual(rebuilt.messages, uninterrupted.messages);
assert.equal(journalEventsAfterProjectionFailure.length, committedEventCount);
assert.equal(secondRebuild.changed, false);
assert.equal(rebuilt.messages.filter(message => message.kind === 'assistant_answer').length, 1);
```

**Validation:** `node dist/test-runner/run-tests.js chat-run-projection chat-transcript-reducer chat-persist-token-parity chat-usage-stream-frame chat-sessions-db`.

**Acceptance:** A single failed projection cannot erase the turn; live and reconstructed display match through partial text and tools.

### Task 6: Unify all Web operation admission, queueing, and completion

**Files:** Modify `routes/chat-session-operation-endpoint.ts`, `chat-session-operation-registry.ts`, `chat-repo-operation-runner.ts`, `chat-queue-successor.ts`, `chat-message-queue.ts`, `src/state/chat-message-queue.ts`, `routes/chat.ts`, `routes/chat-repo-agent.ts`, `server-types.ts`; extend `tests/chat-message-queue-delivery.test.ts`, `tests/chat-message-queue-force.test.ts`, `tests/chat-repo-operation-runner.test.ts`, `tests/status-server-chat-stop.test.ts`.

**Consumes:** Recorder/projector. **Produces:** one durable admission/terminal contract for all Web modes, atomic queue delivery.

- [x] Test that a submission is durable before HTTP acknowledgement/SSE `submitted`, including a run still waiting for the model lock.
- [x] Persist a run in admission before engine dispatch, enforce one active run per session in SQLite, and keep in-memory registry only for live process handles/subscribers.
- [x] Route message, plan, repo-search, repo-agent and non-streaming variants through the same recorder/projector. Move terminal ownership out of individual route-specific append functions; preserve their mode-specific execution/configuration behavior.
- [x] Couple queue claim and `queue_delivered` event in one database transaction. Preserve message IDs and exact delivery order/boundary; deduplicate initial forced delivery against submitted events.
- [x] Incorporate/delete delivered queue entries only after the journal proves delivery is durable. Separate retained pending messages from delivered history. Preserve force-request identity and pause semantics across failure.
- [x] Stop commits a terminal cause only after observing the execution boundary; if a tool cannot be conclusively joined, mark uncertain instead of inventing completion. Persist terminal state before releasing the session for a successor.
- [x] Ensure duplicate request/finish calls, simultaneous Stop/finish/Force, and two tabs cannot create duplicate turns or launch two active engines.

```ts
assert.equal(savedUserMessages.filter(message => message.id === queuedId).length, 1);
assert.equal(activeRunCountForSession, 1);
assert.equal(restartedQueue.pending.length, originalPendingCount);
assert.equal(successorLaunchesAfterUserStop, 0);
```

**Validation:** `node dist/test-runner/run-tests.js chat-message-queue chat-repo-operation-runner chat-session-operation-registry status-server-chat-stop status-server-chat-repo-agent status-server-chat-routes`.

**Acceptance:** All Web entrypoints have the same recovery guarantees; queue recovery no longer creates an independent partial history.

### Task 7: Persist approval lifecycle and deadlines

**Files:** Modify `src/repo-search/engine/approval-gate.ts`, `llm-approval-gate.ts`, `src/status-server/repo-agent-sessions.ts`, `chat-repo-agent-types.ts`, `routes/chat-repo-agent.ts`, shared approval contracts; create `tests/chat-approval-recovery.test.ts`; extend `tests/approval-gate.test.ts`, `tests/contracts-chat-repo-agent.test.ts`.

**Consumes:** Run recorder, tool identities, durable operation owner. **Produces:** durable approval state/deadlines and safe terminal/restart behavior.

- [x] Use a controlled clock/test timer to prove expiry is exactly request time plus 600,000ms, unaffected by page attach or process reload.
- [x] Persist exact proposed action/review payload before emitting approval; persist the decision before unblocking execution. Use CAS so decision/timeout races have one winner.
- [x] Include requested/expiry times in shared response schemas. Separate displayed historical approval from actionable live binding.
- [x] On a stale run/approval decision, return a typed conflict containing current state. Never return success when no live engine can receive it.
- [x] Mark interrupted approvals when their owning process is dead; preserve their original deadline and decision history. A new continuation's new action requires a new approval identity.
- [x] Keep the current 10-minute limit; do not add a configurable/unlimited timeout as scope drift.

```ts
assert.equal(Date.parse(approval.expiresAtUtc) - Date.parse(approval.requestedAtUtc), 600_000);
assert.equal(reloadedApproval.expiresAtUtc, approval.expiresAtUtc);
assert.equal(successfulDecisionTransitions, 1);
assert.equal(executionsAfterStaleApprovalSubmission, 0);
```

**Validation:** `node dist/test-runner/run-tests.js chat-approval-recovery approval-gate llm-auto-approval contracts-chat-repo-agent status-server-chat-repo-agent`.

**Acceptance:** An unanswered approval can end execution but cannot erase history; refresh does not reset timeout or resurrect decided cards.

### Task 8: Recover orphaned runs and guard continuation

**Files:** Create `src/status-server/chat-run-recovery.ts`; modify `src/status-server/index.ts`, `routes/chat.ts`, `routes/chat-session-operation-endpoint.ts`, `routes/chat-repo-agent.ts`, `chat-queue-successor.ts`; replace/delete `src/status-server/chat-queue-recovery.ts`; create `tests/chat-run-recovery.test.ts`.

**Consumes:** Journal/projector/context/approval lifecycle. **Produces:** startup, read and pre-continuation reconciliation.

- [x] Add reopen tests at each boundary: accepted submission, text committed, proposal awaiting review, start without result, result without display projection, terminal without final response.
- [x] Establish a unique server owner epoch and startup ordering after schema initialization/import and before requests/queue execution. Add a runtime-database owner lease with a fenced epoch, heartbeat and expiry; PID/port alone is insufficient because two servers can use different ports against the same database. Only its current owner may admit Web runs or classify them as orphaned. A takeover increments the epoch, and every old writer/tool authorization checks it before proceeding. Use a named 30-second lease and 5-second heartbeat with controlled-clock tests; wait for verified expiry before takeover rather than classifying a live owner's work as crashed.
- [x] Recover only orphaned runs. Reconcile events, mark interruption, close context batches, invalidate dead approval bindings, pause queued successors, and release stale active-run constraints. If storage is unavailable, fail readiness instead of marking evidence recovered.
- [x] Call `reconcileChatSession` for chat reads and before selecting model history. A malformed event leaves a visible recovery error and blocks continuation; missing projection rows alone trigger rebuilding.
- [x] Delete the old queue-only recovery path and evidence-unavailable synthetic message. Queue recovery becomes one part of journal reconciliation.
- [x] Ensure repeated startup/read/continue reconciliation changes neither message counts nor usage. Continue after interruption creates a new operation, retains the old terminal outcome, and appends the new user message once.

```ts
assert.equal(recoveredRun.terminalCause, 'server_restart');
assert.equal(recoveredTool.executionState, 'uncertain');
assert.deepEqual(secondStartupReport, noChangeReport);
assert.equal(providerCallsWhenRecoveryIsCorrupt, 0);
```

**Validation:** `node dist/test-runner/run-tests.js chat-run-recovery chat-message-queue-http chat-message-queue-force status-server-chat-stop`.

**Acceptance:** Server restart and continuation use committed evidence, preserve pending steering and never blindly resume old commands.

### Task 9: Replace memory replay with journal-backed attach

**Files:** Modify `chat-operation-broadcast.ts`, `chat-operation-sse-subscriber.ts`, `sse-response-writer.ts`, `routes/chat-operation-attach.ts`, shared contracts, dashboard stream parser and snapshot application in its runtime store; extend `tests/chat-operation-broadcast.test.ts`, `tests/status-server-chat-operation-attach.test.ts`, `tests/contracts-chat-attach.test.ts`, dashboard parser/attach fixtures; create `tests/chat-journal-attach.test.ts`.

**Consumes:** Journal cursor/snapshot contracts and reconciliation. **Produces:** bounded, lossless reconnect protocol with sequence identities.

- [x] Test a transcript larger than 8 MiB and a disconnect between snapshot capture and subscriber attachment. All messages must arrive exactly once after reconnect.
- [x] Replace retained-frame preamble with a paged consistent projected snapshot carrying operation ID/high-water sequence, then events after the cursor. Reuse SSE event IDs or a typed equivalent parsed by the client.
- [x] Buffer committed publications during snapshot sending; filter duplicates and catch gaps from the journal. Add slow-reader backpressure with a reconnect cursor, not silent truncation.
- [x] Make attach return durable terminal/interrupted state for finished operations. It must not require an in-memory registry entry to show their conversation.
- [x] Read approval state from durable evidence plus live binding. Remove approval-history replay suppression as the authority for current state; historical approval rows and the actionable card are distinct.
- [x] Update dashboard protocol parsers, snapshot application and affected fixtures in this task so the protocol change is complete and existing suites stay green. Remove `CHAT_OPERATION_REPLAY_MAX_BYTES`, `replayTruncated`, and old fallback/replay branches together. Task 10 builds user-facing interruption handling on this new protocol; it does not supply a missing compatibility branch.

```ts
assert.deepEqual(reconnectedMessageIds, uninterruptedMessageIds);
assert.equal(new Set(receivedSequences).size, receivedSequences.length);
assert.equal(lastAppliedSequence, journalHighWater);
assert.equal(replayStartedProviderRequests, 0);
```

**Validation:** `node dist/test-runner/run-tests.js chat-journal-attach chat-operation-broadcast status-server-chat-operation-attach contracts-chat-attach operation-stream`.

**Acceptance:** Reconnect handles long and finished runs without losing history or creating model/tool work. Server and dashboard speak only the new protocol, and affected existing tests pass before Task 10.

### Task 10: Make dashboard state a recoverable projection

**Files:** Modify `dashboard/src/lib/chat-session-runtime-store.ts`, `chat-stream-parser.ts`, `chat-stream-transitions.ts`, `chat-live-messages.ts`, `dashboard/src/hooks/useChatSessions.ts`, `dashboard/src/tabs/ChatTab.tsx`, relevant API types/components; extend dashboard attach/runtime/stream/parser/queue/tab tests.

**Consumes:** Snapshot plus sequenced events. **Produces:** UI state that survives refresh/errors without duplicate rendering or context loss.

- [x] Add DOM/runtime tests where partial text/tool rows remain visible after error, then are replaced by an identical authoritative recovered snapshot. Test two tabs and stale frames from an earlier operation.
- [x] Track last applied sequence per operation. Replace snapshot state atomically; apply newer events once and refetch on gaps. Do not merge cumulative text by concatenating duplicate replay frames.
- [x] Remove terminal/error transitions that clear the only available transcript before a durable replacement arrives. Network error changes connection status; it is not evidence that the conversation is empty.
- [x] Present interrupted/uncertain tools accurately. Show the normal continuation composer with recovered history; disable only while reconciliation reports an integrity error. Preserve the original stopped/failed outcome.
- [x] Show the durable approval deadline and disable stale approvals whose execution binding ended. Refresh adopts live approval state without changing its expiry.
- [x] Preserve current token estimation/measurement and queued-message grouping changes. Keep presentation-only state such as scroll/collapse separate; do not serialize it into model context.
- [x] Verify Task 9 left no old replayTruncated handling or memory-only adoption paths. Extend the new strict parser/fixtures for recovery-error and uncertain-action presentation without retaining the old protocol.

```ts
assert.equal(runtime.messages.find(message => message.id === partialId)?.content, 'partial answer');
assert.equal(afterReplay.messages.filter(message => message.id === partialId).length, 1);
assert.equal(afterTerminal.activity.kind, 'idle');
assert.equal(recoveredUsage, uninterruptedMeasuredUsage);
```

**Validation:** `node dist/test-runner/run-tests.js --dashboard chat-session-runtime-store chat-attach-transitions chat-stream-transitions chat-stream-parser chat-pending-queue chat-tab chat-live-token-display`.

**Acceptance:** Page reload and transport failure do not blank the conversation. The UI agrees with the provider history source and shows no actionable dead approval.

### Task 11: Migrate legacy history and recover the affected chat

**Files:** Create `src/status-server/chat-history-import.ts`, `scripts/recover-web-chat.ts`, `tests/chat-history-import.test.ts`; modify `repo-agent-history-repair.ts`, `chat-tool-results.ts`, startup migration integration; remove obsolete repair route hooks/metadata after migration.

**Consumes:** Journal, current saved chats, exact archived run associations, existing tool-outcome parsers. **Produces:** deterministic import plus an inspectable repair tool.

- [x] Build a sanitized fixture structurally matching this incident: empty chat, delivered turn-41 steering, identified archive, compaction, final partial response, and separate repo-agent state with pending deletion. Do not check private transcript content into the repository.
- [x] Import saved chat baselines once, preserving existing IDs, images, compaction markers and measured usage. Treat already-projected complete runs as baselines, not additional turns to append again.
- [x] Reconstruct missing runs from validated request/archive evidence: initial submission, model text/reasoning according to policy, complete tool outcomes and finalization, queued messages at their actual boundaries, images, compaction and terminal outcome. Preserve native context grouping from `turn_new_messages`; reconcile the final response/results that have not yet appeared in the next turn's message log.
- [x] Import pending approval/state evidence only with verified identity/provenance. Distinguish the engine request ID from repo-agent session ID; never join by short prefixes alone.
- [x] Fail on duplicate/conflicting source text, mismatched call identity, malformed context, uncertain chronology, missing required image evidence, or ambiguous historical tool pairing. Report recoverable display prefix separately from model-continuation readiness.
- [x] Implement `--session-id`, `--request-id`, `--repo-agent-state`, `--dry-run`, `--apply`, and `--expected-digest`. Dry run is default and read-only. Apply uses validated unchanged evidence and an exclusive repair lease. Provide a machine-readable report with counts, known gaps, source hashes, target order and planned writes.
- [x] Move existing legacy tool-output parsing into the explicit importer as needed; remove `migrateRepoAgentHistory` from ordinary request paths. Delete the `repo-agent-history-v1:*` markers once their responsibility is replaced. Keep an explicit importer for historical data, with no automatic runtime fallback.
- [x] Validate the exact incident on a consistent backup/copy before any production apply. Compare 103 turns and 116 completed outcomes; the pending final command is an additional proposal, not a 117th executed result. Do not equate 61 automated verdicts with 61 human decisions.
- [x] Verify importing twice is a no-op and queue delivery is incorporated once. If any legacy evidence cannot be reconstructed exactly, state that in the report; do not invent missing pre-crash fragments.

```ts
assert.equal(report.completedToolResults, 116);
assert.equal(report.pendingProposals, 1);
assert.equal(report.terminalCause, 'approval_timeout');
assert.equal(report.executedToolsDuringImport, 0);
assert.equal(secondImport.changed, false);
```

**Validation:** `node dist/test-runner/run-tests.js chat-history-import chat-tool-results repo-agent-history-repair chat-run-recovery` (remove the obsolete repair target only after its meaningful assertions migrate).

**Acceptance:** Exact-ID recovery restores the missing turn without replaying commands, duplicating steering, or silently accepting corrupt evidence. Production apply remains outside plan execution until its report/backup are reviewed.

### Task 12: Integrate history mutations, retention, backup and cleanup

**Files:** Modify `src/state/chat-sessions.ts`, `src/status-server/routes/chat.ts`, `src/status-server/chat.ts`, `src/status-server/dashboard-runs/deletion.ts`, `src/assistant/control/restore-service.ts`, existing image/retention stores; create `tests/chat-journal-retention.test.ts`; extend deletion, condense and restore tests.

**Consumes:** Journal history-revision events and recovery. **Produces:** deletion/retention semantics that reconstruction cannot undo.

- [x] Add failing tests that delete a message/image or condense a chat, erase its derived projection in an isolated DB, then rebuild. Removed content must remain removed and compressed history must not re-enter model context.
- [x] Route all history-mutating Web endpoints through validated revision events/transactions. Preserve current user-visible deletion semantics, including whether deleting a message removes descendants; journal the same scope.
- [x] Pin or own image evidence while referenced by retained chat/context. Enforce current image-removal and thinking-retention policies in both durable history and continuation, including purging payloads when required.
- [x] Separate diagnostic run-log retention from conversation retention. Run-log deletion cannot destroy journal evidence needed by a chat; session deletion releases its journal/context/image references without harming other sessions.
- [x] Extend backup/restore to cover the new tables and schema version. Restore must perform migrations and owner-epoch recovery before accepting requests. Use the existing SQLite-aware backup mechanisms.
- [x] Remove obsolete Web terminal writer helpers, imports, tests that assert terminal-only durability, and queue-only startup recovery. Preserve assertions by moving them to the unified implementation; do not preserve wrappers forwarding to old code.

```ts
assert.equal(rebuilt.messages.some(message => message.id === deletedId), false);
assert.equal(serializedRecoveredContext.includes(deletedImagePayload), false);
assert.deepEqual(restoredConversation, expectedRetainedConversation);
assert.equal(unrelatedSessionAfterDelete.id, unrelatedSessionBeforeDelete.id);
```

**Validation:** `node dist/test-runner/run-tests.js chat-journal-retention chat-sessions-db status-server-chat-routes status-server-chat assistant-backup-restore dashboard-run-log-admin`.

**Acceptance:** Rebuild respects edits, privacy/removal actions, compaction and retention. No parallel Web history authority remains.

### Task 13: Exercise hard crashes and continuation end to end

**Files:** Create `tests/helpers/chat-recovery-process.ts`, `tests/status-server-chat-crash-recovery.test.ts`, `tests/chat-recovery-performance.test.ts`; extend existing HTTP/dashboard harnesses narrowly.

**Consumes:** Completed implementation. **Produces:** independent crash-boundary evidence and bounded replay/performance measurements.

- [x] Spawn an isolated status-server child and controlled fake provider on ephemeral ports. Use explicit IPC barriers for committed events; kill only that test-owned child using the existing process-tree helper. Do not rely on cleanup/finally paths as the crash test.
- [x] Test hard termination after submission, partial text publication, tool proposal, approval commit, execution start, external side effect, full result commit, projection commit, terminal commit, and queue claim. Reopen the same isolated DB in a new child.
- [x] Submit Continue and capture the provider request. Assert original instructions, steering order, full tool outputs, image evidence, compaction summary and interruption notices are present exactly once and protocol tool pairs are valid.
- [x] Use a test-owned file/counter as the side effect. Verify recovery alone never increments it. A crash after the effect but before result commit must produce uncertain state and must not silently retry.
- [x] Cover normal message, plan, repo-search, repo-agent, condense and forced queue transitions with the same harness. Parameterize the mode/fault cases; do not invent a separate recovery implementation for tests.
- [x] Test browser disconnect without killing the server: the same operation continues and reconnects. Test actual server restart: a new continuation operation is required and the old approval is no longer actionable.
- [x] Run a synthetic 103-turn trace with 116 full results and a >8 MiB display history. Measure append latency, replay time, rows/bytes written and resident memory. Assert no per-token full-transcript rewrites, no lifetime SSE buffer, and indexed/paged reads. Record timing as measurements rather than flaky machine-specific wall-clock assertions.
- [x] Exercise simulated SQLITE_BUSY/FULL and projection exceptions using isolated DB/test harness controls; prove no uncommitted tool authorization or lost published prefix. Never fill the real disk to simulate SQLITE_FULL.

```ts
assert.equal(sideEffectCountAfterRecovery, 1);
assert.equal(recoveredRun.tools.find(tool => tool.id === crashedCallId)?.executionState, 'uncertain');
assert.equal(continuedUserContents.filter(content => content === originalPrompt).length, 1);
assert.equal(recoveredFullOutput, originalFullOutput);
assert.deepEqual(refreshedTranscript, uninterruptedCommittedTranscript);
```

**Validation:** `node dist/test-runner/run-tests.js status-server-chat-crash-recovery chat-recovery-performance` and the full acceptance matrix below.

**Acceptance:** Crash recovery is proven using process termination and captured continuation requests, not only reducer mocks or clean shutdown.

### Task 14: Final audit, documentation, and rollout evidence

**Files:** This plan; create `docs/web-chat-recovery.md`; update existing operational docs that describe terminal-only persistence/attach/approval recovery.

**Consumes:** Tasks 1–13. **Produces:** verified release, migration/repair reports, and documented limits.

- [x] Run the relevant focused tests after final edits, then the broader applicable suites and static checks below. Record exact command status; typecheck invokes lint internally, but still run the explicitly required lint command.
- [x] Audit every Web operation path and all chat message writes. Prove there is no direct route-specific authoritative terminal writer, preview-to-model fallback, memory-only pending approval, or recovery that deletes queue provenance before journal import.
- [x] Verify deletion and retention tests, source schema validation, strict protocol migration, and no callback framework/type assertions introduced by the refactor.
- [x] Review legacy restructuring against section 7. Remove dead files/imports/constants/tests only after replacements cover their behavior. Preserve unrelated uncommitted changes.
- [x] Write operational instructions: what refresh does, what Continue restores, interrupted/uncertain command semantics, 10-minute approval deadline, retention, backup, exact-ID recovery, and explicit repair errors.
- [x] Produce a dry-run repair report for the affected chat using a consistent copy, including source identities/hashes, reconstructable counts, any gaps and expected inserted rows. Do not claim perfect historical reproduction if missing evidence prevents it.
- [ ] Before a production deployment/apply, stop new admissions, let active runs settle or explicitly stop them, take and verify a SQLite-aware backup, migrate, reconcile/import, then verify chat and continuation on the copy. Do not restore an older database over newer accepted writes as a casual rollback.
- [ ] Only after separate deployment/data-write authorization, apply the reviewed migration/import to production and verify reads, cursor attach and a controlled continuation. Until then, deliver code/test evidence and the ready repair command; do not silently alter this user's real chat.
- [x] Clean only task-owned scratch artifacts and report changed files, checks, unresolved limitations, and whether production repair was performed.

## 6. Acceptance matrix and validation commands

| Scenario | Required display/recovery | Required continuation/action behavior |
| --- | --- | --- |
| Refresh during live generation | All committed rows, current usage and approval, no duplicate text | Same live operation; no additional provider request |
| Browser disconnect >8 MiB into run | Complete journal snapshot/catch-up | No truncated history or repeated tool |
| User Stop during text | Partial published text remains; user_stop outcome | New run gets retained context and new submission once |
| Approval timeout | Exact proposed command and timeout remain | No command execution; new run receives interruption evidence |
| Provider error before first response | Original submitted user message remains | Continue can see original request |
| Provider error after tools | Complete finalized full outputs remain | No output previews substituted |
| Server kill before tool starts | Proposed/not-executed state | No automatic execution; new approval for new proposal |
| Server kill after external effect but before result | Outcome uncertain | Verify before retry; recovery performs no side effect |
| Server kill after durable result | Completed result survives | Completed call not rerun by recovery |
| Projection CHECK/error after event commit | Recovery-needed state then successful rebuild | Block dispatch until reconciliation; source event survives |
| Queue claim/Force interruption | Original IDs/order, pending entries retained | No lost or duplicate steering and no surprise successor |
| Compaction/retention interruption | Original display history with valid retained-context boundary | Correct summary plus retained tail, no doubled history |
| Deleted message/image then rebuild | Deleted content stays removed | Deleted content never re-enters prompt |
| Malformed/ambiguous legacy evidence | Visible explicit recovery error/report | No silently fabricated context or execution |
| Duplicate finish/attach/decision/import | Same rows/counts/outcome | At most one transition/execution authorization |
| Old marker-67 stale CHECK | Complete atomic migration preserving existing values | Stopped/in-progress projections write successfully |
| Affected real run import on copy | 116 completed results, pending deletion separate, turn-41 steering once | Full reconstructable context; no deletion command executed |

Final commands, run independently and record each exit status:

```powershell
npm run build
npm run build:test
node dist/test-runner/run-tests.js chat- runtime-db-schema approval-gate status-server-chat repo-agent-history-repair
node dist/test-runner/run-tests.js --dashboard
npm test
npm run typecheck
npm run lint
npm --prefix dashboard run build
```

Remove `repo-agent-history-repair` from the focused command only after its tests have been migrated and the old file deleted. Some target substrings overlap; use the runner's resolved target list to avoid accidental duplicate work. The repository test runner already has a 900,000ms watchdog. Under the current no-SiftKit instruction, capture verbose outputs in the task scratch directory and inspect narrowed failures/pass totals. Do not route output through SiftKit. A planning-only turn does not run these commands or claim they pass.

## 7. Required legacy replacement checklist

- [x] Replace guarded CHECK addition/idempotent bootstrap as the repair mechanism with a real versioned table rebuild.
- [x] Replace terminal-only Web `appendChatRepoAgentMessages` / stopped-turn / scorecard reconstruction with journal projection; delete obsolete Web-only helpers after all callers migrate.
- [x] Replace `ChatStreamProgressWriter`'s in-memory authoritative transcript with recorder-backed events; extract it from the route file.
- [x] Replace display-row-to-native-tool-context reconstruction for new Web runs with exact typed context mutation replay. Move the current row reader into explicit legacy import where still needed.
- [x] Replace mutable externally owned planner arrays with `TranscriptManager` mutation ownership and a schema-derived planner message type.
- [x] Replace in-memory SSE replay as authority, its 8 MiB truncation contract, and associated browser branches with snapshot/cursor catch-up.
- [x] Replace in-memory run/approval state as the recovery authority; keep process handles only as liveness bindings.
- [x] Replace `recoverInterruptedChatQueue` and its evidence-unavailable insertion with unified journal recovery.
- [x] Replace automatic `repo-agent-history-v1` output-only repair with explicit baseline/archive migration and durable import provenance.
- [x] Remove dependence on terminal JSONL hydration for new Web tool results. Retain diagnostic archives as diagnostic exports/import evidence, not an alternate continuation source.
- [x] Migrate every chat edit/delete/image/condense writer so recovery cannot resurrect older content.
- [x] Make retention/backup/restore aware of journal ownership and referenced evidence; no deletion of the only chat source.
- [x] Preserve opaque legacy IDs and intentional retention rules; avoid unrelated renaming, model-policy changes, or CLI refactoring.

## 8. Self-review and delivery boundaries

Coverage mapping: schema defect → Task 1; durable evidence → Tasks 2–4; complete display/context reconstruction → Tasks 3–5; all Web modes and queues → Task 6; approvals → Task 7; restart/continue → Task 8; refresh → Tasks 9–10; existing damaged chat → Task 11; deletion/retention → Task 12; real crash validation → Task 13; rollout/audit → Task 14.

Task 9 includes the server/dashboard protocol cutover; Task 10 adds recovery UX behavior on that protocol. Task 1's migration is extended by Task 2 before first release; do not deploy an intermediate schema version with a conflicting definition. Stage implementation in this order but deploy only after the integrated acceptance matrix passes.

Current production recovery remains unperformed. This plan changes neither the approval timeout nor the affected chat by itself. The historical transcript cannot prove fragments it never recorded; the repair report must distinguish exact reconstruction from known missing evidence. Future runs obtain the stronger commit-before-publish/execute guarantee implemented above.

# Chat message queue and Force now implementation plan

> **For execution:** Use `superpowers:executing-plans`, task by task. Do not use SiftKit, create worktrees, or commit. Implementation is now requested; do not alter production data during validation.

**Goal:** Let users queue follow-up messages during generation, deliver them after the next safe tool-result boundary, or force an orderly stop followed by immediate continuation with complete context.

**Architecture:** A server-owned, session-scoped FIFO queue survives browser reloads. The active engine consumes queued user messages at a defined transcript boundary before its next model request. Force now reuses orderly cancellation, durable terminal persistence, and the existing operation lease; it never starts a replacement while the previous operation is still saving evidence.

**Tech stack:** Existing TypeScript, Zod contracts, SQLite, HTTP/SSE, React, and Node test harnesses. No external queue system or new dependencies.

**Spec and prerequisites:** This document defines the queue behavior. First complete the full-context persistence work in `2026-09-09-shared-tool-history-boundaries.md`, especially shared hydration and strict replay. The earlier `2026-09-09-repo-agent-continuation-and-console-logging.md` introduced the stop/settlement and one-time repair fixes; the shared-boundary plan completes them across chat modes.

## Implementation status

Q1–Q4 are implemented inline. The [13-finding drift review](2026-09-09-chat-queue-session-drift.md) was saved before remediation; its fixes are included. No SiftKit, worktree, commit, or production-history repair was used for this continuation.

- Schema 67 upgrades schema 66 without resetting chats/logs. Queue rows and force receipts survive reconnect/restart; incorporated delivery rows are removed transactionally with canonical chat persistence.
- Limits: 50 pending messages, 200,000 content characters and 8 images per message, 200-character previews, and at most 50 delivered previews. Selected-message editing fetches full text separately. Status frames contain image counts, not image bodies.
- All four streamed modes support normal queue delivery and Force now: message, plan, repo-search, and repo-agent. The provider request retains the original task and complete tool batch, followed by separate FIFO users. Initial successors claim only at the admitted engine boundary and log stable delivery identities.
- Ordinary Stop cancels a pending force continuation and pauses the queue. Provider errors, terminal exhaustion, HTTP failures, and persistence errors do not authorize an automatic successor. A normally completed operation can start pending work, including a busy enqueue arriving just after completion with its observed `afterOperationId`.
- Restart recovery preserves delivered users once and explicitly marks missing active execution evidence. It pauses pending work and does not replay interrupted tools. An incomplete force intent becomes a durable failure requiring review and explicit continuation.
- Pending snapshots cannot be edited/removed during force settlement. Empty force, conflicting operation identity, missing/duplicate claim IDs, stale force, and duplicate retries are checked before side effects. Server admission prevents another send from overtaking pending users.
- The composer remains editable while busy. Queue previews, edit/remove, Force now phases, cross-tab status, successor attachment, and cancellation-aware status reconnection are wired. Connection retry timers never control delivery.

Final validation results are recorded in the drift review. The companion plan's broader browser-memory work remains explicitly incomplete: lazy disclosure mounting and strict replay byte bounds are implemented, but a connected renderer is still needed for profiling and the subsequent retained-history/window design.

## User-visible behavior

- Keep the composer editable while a run is active.
- While idle, the primary action remains **Send**. While active, submitting adds the message to **Queue** instead of returning busy or disabling input.
- Show pending messages immediately above the composer at the bottom of the chat. Each row has a bounded preview, position, edit, and remove controls. Pending text is not yet part of the model conversation.
- Show **Force now** when pending messages exist. It sends the current pending FIFO batch as soon as the current operation has been stopped and saved. The UI shows `Stopping…` and then `Sending…`; it does not claim delivery at click time.
- Do not concatenate queued messages into one ambiguous blob. Preserve each as its own user message with a stable ID and submission order.
- Edit/remove operate only on still-pending rows. If the engine already claimed a row, return its current state instead of silently changing an in-flight request.
- Keep the ordinary **Stop** action. Stop pauses automatic queue delivery and retains pending messages; it must not unexpectedly restart a run. **Force now** explicitly authorizes stop-and-continue.
- All attached browser tabs see the same queue and delivery state. Reloading or switching sessions must not lose messages or send them twice.
- Use existing attachment validation and references if the composer queues attachments. Do not duplicate base64 images in every queue-status frame.

## Delivery semantics

### Normal queue

1. During model generation or a running tool, accept pending messages without modifying the request already executing.
2. After the next tool result is committed to the engine transcript, consume the pending FIFO snapshot before prompt sizing, compaction, and the next model request.
3. If the model already issued several tool calls in one batch, settle all of that batch's tool-result associations first. Do not interleave a user message into an incomplete assistant-tool batch. In this case “after the next tool call” means the next safe batch boundary.
4. Append every message in that claimed snapshot as `role: user`, in FIFO order. Messages arriving after the claim remain queued for the next boundary.
5. The new request retains the original task, previous tool results, and queued steering. Prompt sizing and normal compaction run after insertion; never send an over-budget request or replace the old task with only the latest queued message.
6. If generation finishes normally without another tool call, complete persistence and start one follow-up operation containing the pending batch.
7. If the run fails, pauses for approval, or is explicitly stopped, retain pending messages and show why they are waiting. Do not approve a tool or restart failed work implicitly. Force now remains an explicit alternative.

### Force now

1. Atomically record force intent for the session, active operation ID, and a snapshot of pending message IDs. Duplicate clicks/retries use the same idempotency key.
2. Cancel the active operation using the existing abort path. A queued tool awaiting approval must not execute because of Force now.
3. Await engine settlement and canonical terminal persistence, including completed results and the correct status for an unfinished call. Initial Stop acknowledgment is not sufficient.
4. Only after successful persistence and release of the old lease, acquire exactly one successor operation and deliver the claimed FIFO messages from authoritative persisted history.
5. If cancellation or persistence fails, do not start the successor. Retain the messages and show the error. A mutation may already have happened; never replay the interrupted tool automatically.
6. If the old operation completed while the force request was arriving, use that completed context without sending a stale abort to its successor.
7. Messages queued after the force snapshot remain pending. This preserves ordering and avoids racing a newly typed message into an already-started request.

## Data and ownership

Use one SQLite table, `chat_pending_messages`, for durable queue entries:

- Session ID, unique message ID/idempotency key, FIFO sequence, content, existing attachment metadata, revision, and created timestamp.
- Delivery state `pending` or `delivered`, with the owning engine request ID and delivery boundary for delivered rows.
- A uniqueness constraint on session/message identity prevents duplicate enqueue on network retry. Reusing an ID with different content is a conflict, not an overwrite.

Delivered records are a durable ledger of injected user messages until canonical chat persistence incorporates them. Record claim/delivery and its boundary transactionally; the in-memory engine appends that exact claimed batch. On orderly completion, merge by stable IDs, not text equality, and clean up incorporated delivery records transactionally. Do not leave a second permanent chat-history store.

If the server crashes between delivery bookkeeping and a model request, recover the queued user message once from its delivery ID/boundary. Do not automatically replay tools or pretend missing active-run evidence survived a process crash. Pending queue entries survive; incomplete execution evidence remains explicit.

The server owns delivery. The browser submits/edit/removes entries and renders queue state; it must not implement a race-prone `Stop -> sleep -> Send` timer chain.

The current runtime DB rejects schema-version mismatches. Add the table through an explicit, non-destructive versioned upgrade with tests preserving existing chat/log data. Do not reset the database or quietly create parallel legacy/new queue paths. No migration is executed while preparing this plan.

## Important existing assumptions to replace

- `dashboard/src/tabs/ChatTab.tsx` currently disables the textarea while busy. Queue mode replaces that restriction.
- `dashboard/src/lib/chat-live-messages.ts` uses one `LIVE_USER_MESSAGE_ID`. Queued user messages need their own stable IDs; repeated delivery must not overwrite an earlier user bubble.
- Shared stopped-turn persistence currently assumes one initial user message plus assistant-only generated rows. Multi-message steering requires a chronological turn transcript that can contain delivered user messages. Remove the assistant-only restriction at the validated transcript boundary and migrate its callers; do not merely inject messages into the engine and forget them at stop/restart.
- Queue insertion belongs after canonical tool-result insertion, not the UI's `tool_result` progress event. Progress can be emitted before all transcript bookkeeping is complete.
- The operation lease remains exclusive through cancellation and persistence. Queue requests do not acquire a competing generation lease.

## Task Q1: Durable queue contracts and endpoints

**Files:** `packages/contracts/src/chat.ts` and existing exports; `src/state/runtime-schema.ts`, `src/state/runtime-db.ts`; new `src/state/chat-message-queue.ts`; new `src/status-server/routes/chat-message-queue.ts`; existing route registration and chat operation registry.

**Interfaces:** schema-validated enqueue, list, edit, delete, and force requests. Queue responses contain revision, ordered bounded previews, and delivery states. Claiming a batch returns full validated entries to the server engine only.

- [ ] Write failing storage/HTTP tests for FIFO, duplicate enqueue, conflicting reuse, concurrent edit versus claim, deletion, attachments, session isolation, reload, and preservation through schema upgrade.
- [ ] Implement a small concrete queue store with transactions. No generic job framework.
- [ ] Require an active-operation ID for force intent so a delayed request cannot abort a newer operation.
- [ ] Publish queue revisions through the existing broadcast/status channel and include current queue state on attach.
- [ ] Set explicit count/content limits using existing message/image limits where available; reject an overflowing enqueue without losing the draft or existing queue. Bound previews separately from full contents.

Core assertions:

```ts
assert.deepEqual(pending.map((message) => message.id), ['first', 'second']);
assert.equal(retriedEnqueue.id, originalEnqueue.id);
assert.equal(otherSessionQueue.length, 0);
assert.equal(conflictingEdit.statusCode, 409);
```

## Task Q2: Inject queued messages at safe engine boundaries

**Files:** `src/repo-search/engine/task-loop.ts`, `src/repo-search/engine/transcript-manager.ts`, `src/status-server/repo-agent-sessions.ts`, shared chat persistence and transcript contracts/reducer, `dashboard/src/lib/chat-live-messages.ts` identity handling.

- [ ] Write an engine/HTTP regression with a held tool: enqueue two messages while it runs, release it, and inspect the next actual model request.
- [ ] Assert order is original task, issued tool call and result, queued user message one, queued user message two, then the next generation. Assert the running request itself did not change.
- [ ] Claim and append at the safe post-tool-batch boundary before preflight. Use an explicit queue dependency, not arbitrary callback injection throughout the loop.
- [ ] Record delivery IDs and boundaries in canonical transcript events and preserve them through compaction and terminal persistence.
- [ ] Support several user messages within one live operation; reconcile UI and final persisted messages by stable IDs. Remove the single-live-user overwrite behavior for deliveries.
- [ ] Cover a batch of tool calls, new arrivals during claim, normal finish without another tool, approval wait, explicit Stop, and failure.
- [ ] Verify replay after restart contains each delivered message once and every preceding completed tool result in full.

## Task Q3: Force stop-and-continue orchestration

**Files:** `src/status-server/chat-session-operation-registry.ts`, `src/status-server/repo-agent-sessions.ts`, Stop/queue endpoints, and the shared operation-start/persistence paths.

- [ ] Add a regression that acknowledges cancellation but deliberately holds engine settlement/persistence. Assert zero successor requests until release.
- [ ] Reuse server-owned cancellation and lease completion. Atomically claim force intent and start one successor after durable context is available.
- [ ] Cover double clicks, two tabs, network retry, stale operation ID, normal completion racing force, failed persistence, approval cancellation, and a tool that finished during cancellation.
- [ ] Assert queued messages remain recoverable on failure and no mutation is executed twice.
- [ ] Verify the successor model request contains full pre-force results and the forced FIFO messages, rather than browser previews or a freshly reconstructed task with missing evidence.

Core assertions:

```ts
assert.equal(successorRequestsBeforePersistence, 0);
assert.equal(successorRequestsAfterPersistence, 1);
assert.equal(successorHistoryTool.content, completeOriginalToolResult);
assert.deepEqual(deliveredIds, forcedSnapshotIds);
```

## Task Q4: Queue UI and integrated validation

**Files:** `dashboard/src/tabs/ChatTab.tsx`, `dashboard/src/hooks/useChatSessions.ts`, `dashboard/src/hooks/useChatController.ts`, chat runtime store/transitions, API client and shared queue contracts. Add a small pending-queue component only if it keeps the existing tab manageable.

- [ ] Add UI tests for typing while busy, Queue submission, FIFO display above the composer, edit/remove conflicts, Force now, stopping/sending states, and synchronization across attach/reload.
- [ ] Keep queue previews bounded and large hidden bodies out of the DOM. This feature must not worsen the long-chat memory issue in the companion plan.
- [ ] Run HTTP/SSE end-to-end tests for queue and Force now across supported chat modes; do not expose the feature in a mode until its engine/persistence path supports it.
- [ ] Run relevant storage, registry, transcript, replay, chat UI, and full applicable suites; then `npm run typecheck`, `npm run lint`, and production build.
- [ ] Verify no browser polling timer controls delivery and no competing run starts before the old lease releases.
- [ ] Document schema upgrade, queue limits, failure recovery, and safe tool-batch semantics. Remove scratch artifacts. Report results without committing or modifying production data during tests.

## Acceptance

The pending queue is visible at the bottom, normal queued steering reaches the next safe model request after tool completion, and Force now performs one orderly stop-and-continue with full context. Reloads, concurrent clients, cancellation races, and missing evidence cannot silently drop or duplicate user messages or tool executions.

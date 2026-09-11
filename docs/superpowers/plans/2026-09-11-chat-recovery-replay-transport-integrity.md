# Chat Recovery Replay, Transport, and Integrity Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to execute tasks sequentially only after implementation is explicitly requested. Track steps with the checkboxes below. Do not use SiftKit, worktrees, subagents, or commits unless the user changes those instructions. This document authorizes planning only.

**Goal:** Implement findings **8, 9, 10, 11, 14, 15, and 16 only**: bounded replay overhead, efficient live text updates, byte-bounded projection transport, stable database ownership, deletion-safe context writes, correct duplicate-call replay, and recoverable invalid tool calls.

**Architecture:** Keep the journal authoritative. Give each runtime database a stable connection lifecycle, enforce surviving image evidence at context writes, and carry original tool identities through rejection and context mutation. Fold journal iterators without retaining event history; transmit typed projection records in bounded frames and commit complete batches atomically in the dashboard.

**Tech Stack:** TypeScript, Zod, better-sqlite3, Node HTTP/SSE, React, existing Node/dashboard test runners. No new dependencies.

**Spec:** Sections 1–3 below specify this plan. The earlier [durable web chat recovery plan](2026-09-10-durable-web-chat-recovery.md) supplies existing durability/continuation invariants, not additional implementation scope.

**Prepared:** 2026-09-11, initially against commit `701188f0`, then refreshed against concurrent working-tree changes introducing runtime schema **70**. Journal event version remains **1**. This plan reserves schema **71** and preserves the other work's 69→70 projection-checkpoint migration. Resolve references by symbol when lines move.

## Global constraints

- Scope is exactly the seven findings above. Do not implement findings 1–7, 12, or 13 as separate work: preset selection, auto-approval policy, recovery-status policy, preference saving, revision checkpoint policy, and projection-digest placement remain outside this plan.
- Shared files may already contain those fixes. Reconcile with their current interfaces and preserve unrelated changes.
- Keep implementations succinct, explicit, and straightforward. Reuse existing schemas, reducers, lifecycle owners, and test helpers.
- TypeScript throughout. No `any`, type assertions, non-null assertions, namespace imports, unvalidated IO, or schema-duplicating types. Derive DTO types from runtime schemas; `as const`, `satisfies`, named aliases, and valid type guards are allowed.
- Do not pass functions dynamically except where an external API requires callbacks. Iterators and concrete objects with methods suffice here.
- Refactors replace old runtime paths. No compatibility flags, dual live readers, retained-frame fallback, preview-to-context fallback, or guessed identities.
- Explicit historical readers belong inside the migration module only. They must not become alternative runtime readers.
- TDD per task: behavioral failure → minimum implementation → passing regression → refactor. Never weaken valid assertions.
- Tests use isolated databases and mocked/local gated inference. Set `SIFTKIT_GUARD_RUNTIME_DATABASE` to the real repository database path before testing. No production migration, repair, restore, or data writes.
- Keep task-created scratch artifacts in `.scratch/chat-recovery-replay-transport`; remove them at closeout. Preserve existing incident evidence elsewhere.
- Do not edit source during a compiled broad suite. Rebuild its manifest after source/test edits.
- No commits, worktrees, implementation dispatch, rollout, or production repair is authorized by this plan.

## 1. Scope and observed failures

| Finding | Current evidence | Required outcome |
| --- | --- | --- |
| **8** | Replay/projection/recovery/snapshot modules spread `readAll()` into arrays. `chat_context_snapshots` has no writer/reader. | Replay overhead follows a bounded page and required retained state, not the complete journal. Remove the unused cache table. |
| **9** | `diffChatOperationSnapshots()` sends entire changed messages and the full ID order. | Text growth sends suffixes plus bounded metadata; unchanged bodies, images, token history, and full order are not resent per delta. |
| **10** | Snapshot pages limit rows, then serialize each entire page. | Projection frames fit 64 KiB including SSE framing, even for one huge result/image/approval. No truncation. |
| **11** | Opening database B closes A; recorder/subscriber reacquisition works around this. | Opening/closing B cannot invalidate A. Chat dependencies and shutdown are scoped to their database. |
| **14** | A deletion sweeps existing events; later pruning/compaction can persist stale pixels again. | No later context write can reintroduce a deleted attachment; live history applies the exact sanitized mutation. |
| **15** | Finalization uses `batchOutcomes.length - 1`; collapsing changes that index. Replay also reopens deliberately collapsed calls. | Original identity survives collapsing; completed duplicate sequences replay exactly without extra exchanges or recovery failure. |
| **16** | Invalid native calls append rejection exchanges without durable display identities. | Invalid calls are durably rejected and can be corrected; no tool executes and no missing-identity exception ends the run. |

Reproductions: deleted pixels returning after thinking pruning; `read({})` ending with `A recorded tool result requires its display identity.`; three repeated `ls` calls receiving a false interruption; and a collapsed duplicate plus a fresh call producing `completed` execution with invalid recovered context.

### Exclusions

- CLI/web history unification, approval/model/preset policy changes, UI virtualization, or a new database/blob service.
- REST session-list/detail pagination. Existing REST refresh remains outside the projection-frame budget.
- Automatic historical incident repair. Preserve and report already-corrupt/ambiguous evidence; do not guess old coalescing associations.
- A general event bus, serializer framework, plugin system, or persistent replay cache.
- A constant-total-memory promise: retained model/display state, compact identity metadata, and one large logical message necessarily occupy memory.

## 2. Design decisions

### 2.1 Stable database lifecycle [11]

Replace the singleton with a map keyed by canonical absolute database path. Keep `getRuntimeDatabase(path)` as the opening/access API; it never closes another path. Introduce `closeRuntimeDatabase(path)` and `closeAllRuntimeDatabases()`; remove the no-argument single-database close contract and migrate every caller.

- Canonicalize parent real paths where available and normalize Windows case for registry keys. Use the same canonicalization for the protected-database guard. Preserve the usable filename on the handle.
- Register only after configuration/schema initialization succeeds. Failed B initialization closes B only.
- Preserve per-connection `foreign_keys=ON`, WAL, and `synchronous=FULL`. Closing B does not checkpoint or change A's journal mode.
- Add captured `runtimeDatabasePath` and `runtimeDatabase` to `ServerContext`. Pass the stable handle to recorder, owner lease, queue, recovery, and subscriber capture.
- `ChatRunRecorder.begin(database, input)` and `.resume(database, operationId, ownerEpoch)` take that handle. Keep one `ChatJournalStore`; remove the per-access getter workaround.
- `ChatRuntimeOwner` keeps the stable handle too. The SQLite owner lease still coordinates separate processes; the registry does not replace it.
- Shutdown stops admissions/heartbeats, drains requests and deferred writers, releases the owner while its handle is open, then closes its database. Expose `ExtendedServer.waitForShutdown(): Promise<void>` so fixtures await actual completion.
- Close-all is for process exit/test-file teardown only. Normal shutdown and fixtures close their captured path.
- A recorder used after its own owner shuts down fails loudly; opening the path again is a new lifetime for new consumers.

This is a lifecycle refactor, not a rewrite of every state API. State functions with explicit path arguments may keep obtaining that path's stable connection.

### 2.2 Deletion-safe context commit boundary [14]

Do not add reconciliation before just one pruning call. Enforce the invariant at both context commit methods, inside the append transaction.

Create `src/state/chat-context-images.ts` with `sanitizeChatContextImages(database, sessionId, messages)`, returning validated planner messages. For owners with committed image-removal revisions:

1. Resolve surviving attachments from the owning `run_started`, `queue_delivered`, `tool_result`, or baseline message using message identity.
2. Match supplied image parts against the surviving admitted payloads as an ordered occurrence inventory. Identical duplicate attachments retain their correct surviving count; a digest set is insufficient. Forced delivery may repeat the same user identity in admission and queue evidence: verify those copies agree and count their one attachment inventory once.
3. Remove parts absent from that inventory. Preserve text, retention replacement text, other owners/fields, and surviving image order.
4. Fail explicitly when an affected native image has no attributable display owner. Never guess ownership from equal content/timestamps.
5. Filter supplied messages only. Do not restore attachments already aged out by retention.

Using surviving occurrences also handles retention removing an earlier image, where applying a historical visible index would remove the wrong sibling.

Change `ChatContextRecorder` to return the exact committed value:

```ts
recordContextInitialized(init: ChatContextInit): ChatContextInit;
recordContextSpliced(splice: ChatContextSplice): ChatContextSplice;
```

`TranscriptManager` validates its proposal, calls the recorder, and applies the returned value. Without a chat recorder it applies the validated proposal directly. Constructor initialization, pruning, replacement/compaction, and recovery synthesis obey the same contract. Image guards follow the committed result.

Transaction ordering guarantees: if the context write wins first, deletion sweeps it; if deletion wins first, the writer filters against current survivors. No unsanitized append can commit between inventory read and append.

Already-published client/provider bytes cannot be recalled. This guarantees future durable writes and continuation context; private context never enters projection transport.

### 2.3 Durable identities and deliberate coalescing [15, 16]

Allocate one `ChatToolCallIdentity` before any processed/rejected exchange is appended. Replace the parallel progress-ID adornment on batch outcomes with its original identity:

```ts
type RecordedBatchOutcome = ToolBatchOutcome & { call: ChatToolCallIdentity };
```

Use `outcome.call` for finalization and display/result association. Never reconstruct `indexInBatch` from a filtered array. Positions may place an image after its retained result, but positions are not journal identities.

Add required `coalescedToolCallIds: string[]` to v2 `context_spliced` events. These are current proposal **display IDs** deliberately represented by replacement of an earlier tool result. Ordinary splices carry `[]`.

- `replaceToolResult()` accepts these IDs as explicit data and includes them in its splice.
- Replay marks these calls represented only when that splice commits. A crash after rejection but before replacement still reconstructs the unanswered current exchange.
- Every ID must name an existing proposal with a committed rejected result. Duplicate/future IDs, executing calls, and unproven results fail integrity checks.
- Coalescing metadata is valid only on `tool_result_replaced`, replacing one existing tool-result message. Validate the target against prior context and the inserted identity.
- Keep the current call's rejected outcome in journal/display; metadata explains its model-context representation only.

Add concrete `ToolActionProcessor.recordInvalidResponse(...)` using the same identity/rejected-result path as processor validation. `TaskLoop.handleInvalidParse()` calls it for `NativePlannerToolCallError` instead of directly appending an exchange.

Preserve parsing policy: a response rejected during parsing executes no valid-looking siblings. Record the exchange the existing recovery policy appends, increment the invalid-response count once, and allow the next turn to correct it. Preserve validated error arguments/native ID. Malformed raw argument text is diagnostic evidence, never fabricated executable instructions.

Both rejection entrypoints commit proposal → rejected result → context splice. Unknown/disallowed names are evidence labels, never executable registrations. Rejected invalid calls do not request approval.

### 2.4 Version migration [8, 15]

Reserve runtime schema **71** and journal event version **2**. Preserve the concurrent 69→70 `upgradeChatProjectionCheckpoints` migration. If another change reserves 71 first, update this document, registration, and fixtures to the next unused version before implementation. Never overwrite another migration.

Create `src/state/schema-upgrades/chat-replay-transport.ts`:

- Parse v1 events through a frozen explicit v1 schema confined to this migration. Verify old digests before modifying anything.
- Add `coalescedToolCallIds: []` to historical splices; preserve all other body fields, IDs, sequences, timestamps, provenance, and terminal causes. Update envelope version and body digest.
- Do not infer old coalescing from equal text, adjacent times, or absent declarations. Already-corrupt runs remain explicitly unresolved pending separate reviewed repair.
- Drop unused `chat_context_snapshots`; remove its fresh-schema definition and image-deletion cleanup reference.
- Change the runtime marker only after successful conversion. Unknown versions, malformed payloads, and corrupt digests roll back the transaction.
- Post-migration runtime readers accept v2 only. New splices missing the field fail; there is no dual live reader.

Test on isolated copies. Production application is not authorized.

### 2.5 Iterator-based replay [8]

Add `ChatJournalStore.readThrough(operationId, afterSequence, throughSequence)`. `readAll()` captures a committed head and delegates.

- Retain the 500-row maximum; add a **1 MiB decoded-body page target**, allowing one individually oversized event. Select bounded row metadata first, then fetch the chosen bodies. Do not fetch 500 huge bodies before deciding they exceed the target.
- Validate cursors, exact contiguous sequence, event version, and digest; exclude rows newer than the captured head. Preserve `readAfter()`'s caller-supplied limit semantics.
- Folds accept a single-use iterable; arrays are naturally valid callers, not a compatibility mode.

Refactor context replay into `ChatContextReplay.apply(envelope)` / `.finish()`. It owns context revision/bounds, native messages, tool identity/state, represented/coalesced IDs, pending queue deliveries, partial text, and declared display IDs.

`apply(envelope: ChatJournalEnvelope): void`; `finish(): ChatRecoveredContext`; readonly `rawContextLength: number`; readonly `partialAssistantMessages: readonly ChatMessage[]`. The existing `replayChatContext(events: Iterable<ChatJournalEnvelope>)` returns the completed context. History reconstruction additionally consumes the accumulator's partial-message view; it does not traverse the iterable again. `ChatRunProjection.finish()` preserves the existing `ProjectedRun` result shape.

Fold partial narration during the same pass; remove the separate complete-event traversal. Discard redundant result/finalization strings after their exact contents are represented in retained context. Keep compact identity facts through compaction; retain full recovery payloads only for unrepresented calls.

Refactor display folding into `ChatRunProjection.apply()` / `.finish()`, retaining the shared reducer. Requests encountered before approval decisions populate its map; incremental projection may seed it from the existing validated request query.

Convert `buildRecoveredChatHistory`, projection, startup recovery, and snapshot capture to iterators. Startup may replay a newly captured head after synthetic writes, but must not retain complete old/new event arrays. Expose raw context length from the accumulator for interruption closure instead of rescanning splices.

Fetch pages with bounded `.all()` calls, releasing each statement before mutations. Do not yield from an active SQLite `.iterate()` statement while mutating that connection. Synchronous capture uses a consistent transaction; no transaction spans awaited network writes.

Memory model: **one bounded decoded page or oversized event, required model/display state, and compact call/revision metadata**. No full event array or serialized whole transcript alongside it. Finding 7's separate revision-checkpoint policy remains outside scope.

### 2.6 Typed projection records and bounded frames [9, 10]

Replace row-count pages and whole-message update envelopes with one typed record protocol. Keep `ChatOperationSnapshot` as the assembled application view; it is no longer an SSE payload. At cutover remove its obsolete `messageOffset` and `complete` fields and migrate their constructors/tests; completeness belongs to the transfer commit.

Create `packages/contracts/src/chat-projection.ts` and export it from `packages/contracts/src/index.ts`. Compose existing message, tool, approval, token, queue, and recovery schemas rather than restating them.

**Cursor:** `ChatProjectionCursor = { operationId, sequence, historyRevision }`. The revision-event count lets deletion advance the view without an execution event. Validate both monotonic components and identity; an unchanged sequence does not imply an unchanged projection.

Derive `ChatProjectionCursorSchema` by extending `ChatEventCursorSchema` with `historyRevision: z.number().int().nonnegative()`. Define `ChatProjectionCaptureSchema` from `{ snapshot: ChatOperationSnapshotSchema, cursor: ChatProjectionCursorSchema, queue: ChatMessageQueueStateSchema }` and infer its type. `ChatOperationSnapshotReader.capture()` returns this capture: read the view, revision count, and queue in the same synchronous database transaction. Require matching operation/sequence identities between its snapshot and cursor. The dashboard retains the full projection cursor separately from the assembled view's event cursor.

**Logical records:**

| Kind | Fields and semantics |
| --- | --- |
| `begin` | `mode: 'snapshot' | 'update'`, `sessionId`, `operationId`, `after: ChatProjectionCursor | null`, `cursor`, and `state`. Derive state from `ChatOperationSnapshotSchema`, omitting separately carried identities, collections, approval, and event cursor. |
| `message` | Full validated message and `afterMessageId: string | null`; insert/replace and position one row. Used for initial snapshots, rewrites, attachment changes, and structural changes. |
| `append_text` | `messageId`, UTF-16 `offset`, suffix `text`, and schema-derived text-row metadata. Only streamed assistant text kinds qualify. Preserve unchanged large/nontext fields already held by the receiver. |
| `remove_message` | `messageId`; remove row and associated tool entry. |
| `move_message` | `messageId`, `afterMessageId`; move without resending body. |
| `tool` | One `ChatRecoveredTool`, keyed by message ID. |
| `token_turn` | One `ChatSnapshotTokenTurn`, keyed by turn. |
| `warning` / `issue` | Existing validated value and its array index; preserve committed order. |
| `approval` | `DurableChatApprovalSchema.nullable()`; updates emit only actual changes. |
| `queue` | `ChatMessageQueueStateSchema`; operation-stream queue payloads use the same bounded codec. |
| `commit` | Counts for messages/tools/token turns/warnings/issues and matching cursor; makes staged state visible. |
| `terminal` | Small notification after the final committed projection, with existing terminal cause and optional recovery issue; no full session response. |
| `error` | Existing `ChatStreamErrorSchema` in a typed record; may arrive before a first snapshot, discards pending state, and closes the failed stream. |

A snapshot builds collections from empty staged state and includes the captured queue. An update stages changes over the last committed view and includes queue only when it changed. A revision/compaction or collection shrink not expressible by the incremental records starts an explicit fresh **snapshot** batch. Snapshot replacement is a first-class protocol operation, not a legacy fallback.

Derive `ChatTextRowMetadataSchema` in `chat.ts` from existing text/base message schemas. Omit `content` and attachment/output bodies; retain fields changed by text/usage projection. A suffix update is allowed only when omitted preserved fields are unchanged. Validate the fully merged message before publishing it. A non-prefix rewrite uses a complete replacement record.

**Wire frame:** every `chat_projection` SSE event contains:

```ts
export const CHAT_PROJECTION_PROTOCOL_VERSION = 2;
export const CHAT_PROJECTION_MAX_FRAME_BYTES = 64 * 1024;
export const ChatProjectionFrameSchema = z.strictObject({
  version: z.literal(CHAT_PROJECTION_PROTOCOL_VERSION),
  transferId: z.string().uuid(),
  recordIndex: z.number().int().nonnegative(),
  chunkIndex: z.number().int().nonnegative(),
  finalChunk: z.boolean(),
  data: z.string().max(CHAT_PROJECTION_MAX_FRAME_BYTES),
});
export type ChatProjectionFrame = z.infer<typeof ChatProjectionFrameSchema>;
```

`data` fragments one logical record's JSON. A transfer contains begin/body/commit; a terminal record follows commit when execution settles. Assemble at most one incomplete logical record in addition to staged/committed application views. Never buffer a serialized whole snapshot.

The string-length schema bound is only an early guard; the encoded UTF-8 frame budget is still mandatory. Fresh transfers may have the same before/after cursor when only queue or live-control state changed. Apply them normally. Reject duplicate/out-of-order fragments or reuse of a committed transfer ID; reconnect uses a fresh transfer ID and snapshot. Never deduplicate by execution sequence alone.

Define the terminal/error records and decoder delivery explicitly:

```ts
export const ChatProjectionTerminalRecordSchema = z.strictObject({
  kind: z.literal('terminal'), cursor: ChatProjectionCursorSchema,
  terminalCause: ChatRunTerminalCauseSchema, issue: ChatRecoveryIssueSchema.nullable(),
});
export const ChatProjectionErrorRecordSchema = z.strictObject({
  kind: z.literal('error'), failure: ChatStreamErrorSchema,
});
export const ChatProjectionDeliverySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('view'), snapshot: ChatOperationSnapshotSchema,
    queue: ChatMessageQueueStateSchema.nullable() }),
  z.strictObject({ kind: z.literal('terminal'), terminal: ChatProjectionTerminalRecordSchema }),
  z.strictObject({ kind: z.literal('failure'), failure: ChatStreamErrorSchema }),
]);
export type ChatProjectionDelivery = z.infer<typeof ChatProjectionDeliverySchema>;
```

`acceptFrame(frame: ChatProjectionFrame): ChatProjectionDelivery | null` returns null while incomplete. A view delivery carries its queue update in the same result; null queue means unchanged. A terminal is legal only after a commit. An error at a logical-record boundary may precede begin, discards staging, and produces a failure delivery. If writing fails mid-record, close the connection rather than interleaving an error record with incomplete JSON.

Implement a chat record encoder over `JsonSerializable` with an explicit traversal stack. Emit JSON punctuation and bounded escaped string segments. Do not `JSON.stringify()` an entire snapshot, giant record/string/image/result, then slice it. Stringifying bounded scalar/string segments and the final bounded frame is permitted. Match JSON behavior for omitted object properties, array `undefined` as `null`, finite numbers, control characters, surrogate pairs, and lone surrogates.

Budget the actual UTF-8 bytes of `event: chat_projection\ndata: <encoded frame>\n\n`, including inner-fragment escaping. Split oversized logical records across frames without truncation or a new message-size limit.

Updates emit only changed token turns, appended warnings/issues, changed approval/queue state, and actual row changes. Never send full ID order or token history per text delta. Use positional insert/move/remove records, preserving ordering and unchanged object identity.

Add `SseResponseWriter.writeBoundedSerializedEventAndDrain(eventName, data, maxFrameBytes): Promise<boolean>`. It validates the complete framed byte count, submits the complete bounded frame in one synchronous `res.write()`, then awaits drain if necessary using the existing timeout/disconnect handling. Existing unbounded standalone callers keep their current chunked method. Socket chunking alone does not satisfy this protocol's frame-size bound.

The dashboard validates version, transfer/record/chunk order, schemas, cursor continuity, message identity, text offset, positioning anchors, and commit counts. Decode incoming UTF-8 with a fatal streaming `TextDecoder` and flush it at EOF so invalid/truncated byte sequences fail explicitly. Incomplete batches never replace readable state. Malformed, oversized, truncated, reordered, or conflicting data fails the stream and triggers reattach.

Subscribe before capturing the source view/cursor. Publications during draining only set a dirty flag; catch up after committing the capture. If a history/image revision changes while an old capture drains, end the transfer before its commit and reconnect from a fresh capture. Check revision immediately before the commit frame's synchronous write, with no intervening await; that write is the publication boundary. The receiver discards incomplete staging. No database transaction spans `await`.

Switch every Web operation stream together. Remove old Web snapshot/projection decoding and full-session `done` forwarding. New terminal handling refreshes session metadata through existing REST when needed. Standalone operation streams and the independent queue subscription endpoint keep their existing contracts.

## 3. File and responsibility map

| Files | Responsibility |
| --- | --- |
| `src/state/runtime-db.ts` | Stable path registry, scoped close, explicit close-all, migration registration. |
| `src/status-server/index.ts`, `server-types.ts` | Captured dependency; drain/release/close ordering and awaitable shutdown. |
| `src/state/chat-runtime-owner.ts`, `src/status-server/chat-run-recorder.ts` | Stable stores; committed-return context API. |
| New `src/state/chat-context-images.ts`; `chat-history-revisions.ts` | Surviving inventory, transactional sanitation, existing deletion sweep. |
| `src/repo-search/planner-chat-message.ts`, `engine/chat-run-evidence.ts`, `engine/transcript-manager.ts` | Sanitized mutations and coalesced-call metadata. |
| `engine/tool-action-processor.ts`, `engine/task-loop.ts` | Original call identity and complete rejection paths. |
| New `src/state/schema-upgrades/chat-replay-transport.ts`; `runtime-schema.ts`, `chat-journal-schema.ts` | Version conversion; remove unused context cache. |
| `src/state/chat-journal.ts` | Captured-head iterator with row/byte targets. |
| `src/status-server/chat-context-replay.ts`, `chat-run-projection.ts`, `chat-run-recovery.ts` | Single-pass folds and bounded recovery reads. |
| New `packages/contracts/src/chat-projection.ts`; `packages/contracts/src/index.ts`, `chat.ts`, `chat-recovery.ts` | Record/frame/cursor schemas and derived metadata. |
| New `src/status-server/chat-projection-encoder.ts`; `src/status-server/sse-response-writer.ts` | Bounded JSON encoding/frame packing and atomic bounded-frame writes with drain. |
| `chat-operation-snapshot.ts`, `chat-operation-sse-subscriber.ts`, `chat-operation-broadcast.ts` | Capture, incremental records, drain/catch-up, small notifications. |
| `src/status-server/routes/chat*.ts`, `routes/repo-agent.ts`, `chat-queue-successor.ts` | Required dependency and Web protocol migrations only. |
| `dashboard/src/lib/chat-operation-projection.ts`, `chat-stream-parser.ts`, `chat-stream-transitions.ts`, `chat-session-runtime-store.ts`, `hooks/useChatSessions.ts` | Record assembly, staging, commits, terminal/reconnect handling. |
| Existing `tests/helpers/chat-*`, `streamed-op-harness.ts`, database/server fixtures | Isolated dependencies and protocol test readers. |
| New tests named below | Behavioral, HTTP, crash, memory, and wire-size proofs. |
| `docs/web-chat-recovery.md` | Final behavior, limits, migration, historical limitations. |

## 4. Sequential implementation tasks

Complete each task's focused tests before proceeding. Tasks 8–11 prepare then atomically switch one protocol; never deploy an intermediate server/dashboard mismatch.

### Task 1 — Replace singleton eviction with scoped database ownership [11]

**Files:** `src/state/runtime-db.ts`; new `tests/runtime-db-lifecycle.test.ts`; every discovered no-argument close caller in source/tests.

**Interfaces:** Keep `getRuntimeDatabase(databasePath?)`; produce `closeRuntimeDatabase(databasePath: string): void` and `closeAllRuntimeDatabases(): void`.

- [ ] Add a failing test: open A, create a row, open B, then read/write through A's original handle.
- [ ] Cover same-path handle identity, normalized Windows aliases, closing B without affecting A, reopening explicitly closed B, and failed B initialization leaving A usable.
- [ ] Test guard canonicalization and simultaneous A/B transactions with rollback isolated to the intended database.
- [ ] Replace cached globals with the path map; preserve configuration and schema transactions; remove automatic cross-path close.
- [ ] Migrate close callers: captured path for scoped owners; explicit close-all for process/test-file teardown. No old default-close alias.
- [ ] Run focused tests and review every close caller's intended lifetime.

Behavioral core (the test creates `firstPath`/`secondPath` in its isolated directory):

```ts
const first = getRuntimeDatabase(firstPath);
first.exec("CREATE TABLE audit_value(value TEXT); INSERT INTO audit_value VALUES ('A')");
const second = getRuntimeDatabase(secondPath);
assert.notEqual(first, second);
closeRuntimeDatabase(secondPath);
assert.equal(first.open, true);
assert.deepEqual(first.prepare('SELECT value FROM audit_value').all(), [{ value: 'A' }]);
```

**Run:** `npm run build:test`, then `node dist/test-runner/run-tests.js runtime-db-lifecycle runtime-db-schema runtime-db-schema-stores`.

**Acceptance:** One path's opening/closing never changes another handle or transaction.

### Task 2 — Pin chat dependencies and shutdown to their database [11]

**Files:** `src/status-server/index.ts`, `server-types.ts`, `chat-run-recorder.ts`, `chat-operation-sse-subscriber.ts`; `src/state/chat-runtime-owner.ts`; chat constructor callers; `tests/helpers/server-context-fixture.ts`, `streamed-op-harness.ts`, `chat-run-recorder.ts`, isolated-runtime helpers.

**Consumes:** Task 1 lifecycle. **Produces:** stable recorder/owner/subscriber dependencies and `ExtendedServer.waitForShutdown(): Promise<void>`.

- [ ] Add tests with recorder/queue on A, access B between awaited operations, then verify A's append/projection/approval/claim still target A.
- [ ] Add a two-server HTTP shutdown test: closing B leaves A functional; shutdown completion waits for B's deferred writers only.
- [ ] Capture the path/handle in `ServerContext`; pass it through admission, successor, attach, recovery, and recorder construction.
- [ ] Change recorder begin/resume and owner construction to the stable handle. Keep one store; remove per-access reacquisition and associated workaround comments.
- [ ] Expose and await shutdown completion. Drain writers before owner release/close; preserve other paths.
- [ ] Replace the test treating unrelated-root eviction as normal with stable-handle assertions. Preserve real storage-failure tests.

```ts
const recorder = ChatRunRecorder.begin(databaseA, start);
getRuntimeDatabase(databaseBPath);
recorder.recordDisplay({ kind: 'answer', delta: { turn: 1, offset: 0, text: 'still on A' } });
assert.equal(new ChatJournalStore(databaseA).readRun(recorder.operationId)?.latestSequence, 2);
await serverB.waitForShutdown();
assert.equal(databaseA.open, true);
```

**Run:** after test rebuild, `node dist/test-runner/run-tests.js chat-run-recorder chat-runtime-owner chat-message-queue status-server-chat-operation-attach dashboard-server-fixture-cleanup`.

**Acceptance:** Chat never swaps runtime accidentally; own shutdown is explicit/awaitable.

### Task 3 — Enforce image deletion on every context commit [14]

**Files:** new `src/state/chat-context-images.ts`; `chat-run-recorder.ts`, `chat-history-revisions.ts`, `engine/chat-run-evidence.ts`, `engine/transcript-manager.ts`, `engine/prompt-preparer.ts`, `src/status-server/chat.ts`; retention/recorder tests.

**Consumes:** Stable handle. **Produces:** section 2.2 sanitizer and exact committed-return context methods.

- [ ] Reproduce deletion during a live image/thinking transcript, then append newer thinking and call `pruneThinking(false)`; inspect journal/recovered context before and after reconciliation.
- [ ] Gate compaction: capture input, delete while it waits, release output; require sanitized replacement and journal.
- [ ] Cover first/middle/last deletion, identical duplicate images with one survivor, retention removing an earlier part, tool images, imported ownership, and unrelated owners.
- [ ] Implement survivor occurrence matching and sanitation in the context append transaction. No positional-only/digest-set-only filtering.
- [ ] Return the committed schema value; apply that exact value live. Preserve revision/bounds/message count and queue/compaction metadata.
- [ ] Inject append/projection failures and retain existing deletion rollback assertions.

Using the existing image fixture's recorder/transcript/database:

```ts
recorder.readSession();
deleteChatMessageImage(root, session.id, recorder.userMessageId, 0);
transcript.beginTurn(2);
transcript.pushAssistant({ role: 'assistant', content: 'next', reasoning_content: 'new thinking' });
transcript.pruneThinking(false);
assert.equal(JSON.stringify([...store.readAll(recorder.operationId)]).includes(removed), false);
assert.equal(JSON.stringify(buildRecoveredChatHistory(database, session.id)).includes(removed), false);
```

**Run:** after rebuild, `node dist/test-runner/run-tests.js chat-journal-retention chat-run-recorder image-retention engine-tool-action-processor`.

**Acceptance:** No later mutation or stale asynchronous result restores deleted bytes; surviving siblings remain.

### Task 4 — Version coalescing metadata and retire the unused cache [8, 15]

**Files:** `src/repo-search/planner-chat-message.ts`; `src/state/chat-journal-schema.ts`, `runtime-schema.ts`, `runtime-db.ts`, new `schema-upgrades/chat-replay-transport.ts`; schema/contract/journal tests.

**Consumes:** Current v1 shape and schema 70, including concurrent fixes. **Produces:** event v2/schema 71, required splice coalescing list, no context-cache table.

- [ ] Add v1 migration fixtures with initialization/splices, image revisions, baselines, completed/interrupted runs, and a corrupt digest.
- [ ] Assert unchanged row counts, IDs/sequences, message content, terminal causes, and provenance; only new field/version/digest change.
- [ ] Assert corrupt/unknown input retains old payloads/marker through full rollback.
- [ ] Implement section 2.4 conversion and remove cache schema/cleanup. Migrate new splice producers to explicit `[]` until coalescing is supplied in Task 5.
- [ ] Reject normal v1 reads after migration and v2 splices missing the field. Keep old parsing private to migration.
- [ ] Update fixtures for 66/67/68/69/70→71 and fresh bootstrap; preserve the existing 69→70 migration and its assertions.

```ts
assert.equal(getSchemaVersion(database), 71);
assert.equal(database.prepare("SELECT name FROM sqlite_schema WHERE name='chat_context_snapshots'").get(), undefined);
for (const envelope of new ChatJournalStore(database).readAll(operationId)) {
  assert.equal(envelope.version, 2);
  if (envelope.event.kind === 'context_spliced') assert.deepEqual(envelope.event.coalescedToolCallIds, []);
}
```

**Run:** after rebuild, `node dist/test-runner/run-tests.js runtime-db-schema chat-journal contracts-chat-recovery assistant-backup-restore`.

**Acceptance:** One current runtime format, atomic explicit historical conversion, no unused cache artifact.

### Task 5 — Preserve identity through duplicate collapsing [15]

**Files:** `src/repo-search/engine/tool-action-processor.ts`, `src/repo-search/engine/transcript-manager.ts`, `src/status-server/chat-context-replay.ts`, local batch-outcome adapters; `tests/engine-tool-action-processor.test.ts`, `tests/chat-context-replay.test.ts`, `tests/status-server-chat-repo-agent.test.ts`.

**Consumes:** v2 coalescing metadata. **Produces:** original identity on outcomes and explicit represented-call accounting.

- [ ] Add HTTP regressions for three repeated `ls('.')` calls and two repetitions followed by mixed `[ls('.'), ls('subdir')]` with `maxTurns: 5`. Require completed execution and valid unchanged recovered context.
- [ ] Cover collapse first/middle/last, multiple collapses, reused native IDs, accepted/rejected outcomes, budget finalization, and image-bearing fresh calls after collapse.
- [ ] Carry the original identity on each outcome; use `lastOutcome.call` in finalization. Remove redundant local progress-ID adornment.
- [ ] Include collapsed current display IDs in the replacement splice; validate rejected evidence before marking represented in replay.
- [ ] Test crashes after rejection/before replacement and after replacement. Only the former may reconstruct the missing exchange.
- [ ] Preserve duplicate/stagnation policy, tool budgets, and actual side-effect count.

```ts
recorder.recordToolResultFinalized({
  call: lastOutcome.call,
  modelVisibleText: finalized.insertedResultText,
  contextRevision: transcript.contextRevision,
});
```

```ts
assert.equal(run.terminalCause, 'completed');
assert.equal(replay.status, 'ok');
assert.equal(findPlannerContextViolation(replay.messages), null);
assert.deepEqual(replay.messages, liveMessages);
assert.equal(sideEffectCount, 1);
```

**Run:** after rebuild, `node dist/test-runner/run-tests.js engine-tool-action-processor chat-context-replay status-server-chat-repo-agent`.

**Acceptance:** Filtering never changes identity; replay neither reopens collapsed calls nor masks interrupted exchanges.

### Task 6 — Journal invalid-response rejection before context insertion [16]

**Files:** `src/repo-search/engine/tool-action-processor.ts`, `src/repo-search/engine/task-loop.ts`, `src/repo-search/engine/transcript-manager.ts`; `src/planner-protocol/native-actions.ts` only for necessary typed error evidence; `tests/engine-tool-action-processor.test.ts`, `tests/repo-search-chat-loop.test.ts`, `tests/status-server-chat-repo-agent.test.ts`.

**Consumes:** Original identity allocation/rejected-result writer. **Produces:** concrete `ToolActionProcessor.recordInvalidResponse` with schema-derived input.

- [ ] Add HTTP regression: model emits `read({})`, then a valid finish; require the final answer and durable rejected exchange without missing-identity failure.
- [ ] Cover unknown/disallowed names, malformed JSON, processor-level invalid args, parsing-rejected mixed batches, invalid-response ceiling, and correction followed by an approved real tool.
- [ ] Allocate identity and commit proposal/result through the concrete rejection method before appending context.
- [ ] Replace parser-level direct exchange insertion; align processor-level `recordInvalidToolCall` with the same evidence ordering.
- [ ] Increment the invalid-response counter once per existing policy. Never execute the invalid call/siblings or request approval for it.
- [ ] Inject failures at proposal/result/context writes. No dependent step runs afterward; preserve separately maintained storage-error classification.

```ts
const mockResponses = [
  { toolCalls: [{ name: 'read', arguments: {} }] },
  ...repoAgentFinishResponses('Recovered successfully'),
];
```

```ts
assert.equal(run.terminalCause, 'completed');
assert.equal(executedInvalidCalls, 0);
assert.equal(approvalRequestsForInvalidCalls, 0);
assert.equal(findPlannerContextViolation(history.messages), null);
assert.equal(history.messages.some(message => message.role === 'tool'), true);
```

**Run:** after rebuild, `node dist/test-runner/run-tests.js engine-tool-action-processor repo-search-chat-loop status-server-chat-repo-agent chat-context-replay`.

**Acceptance:** Model mistakes become recorded correction opportunities; existing limits still terminate repeated invalid responses.

### Task 7 — Replace materialized replay with single-pass folds [8]

**Files:** `src/state/chat-journal.ts`; `src/status-server/chat-context-replay.ts`, `chat-run-projection.ts`, `chat-run-recovery.ts`, `chat-operation-snapshot.ts`; existing journal/context/projection/recovery/performance tests; new `tests/helpers/chat-replay-memory-process.ts`.

**Consumes:** Correct v2 tool/context semantics. **Produces:** `readThrough`, `ChatContextReplay`, `ChatRunProjection`, iterable replay APIs.

- [ ] Add a single-use iterable fixture with context/display parity across every splice reason, compaction, deletion, queues, reused IDs, partial narration, coalescing, and invalid rejection.
- [ ] Test captured heads: exclude newer rows; reject missing middle/tail, backwards cursor, unknown version, and corrupt digest with exact anchors.
- [ ] Test row/byte paging with many small events and one oversized event. Observe fetched body bytes through the test database adapter; enforce the budget before payload `.all()` returns.
- [ ] Implement accumulators and remove complete event arrays/repeated scans from production callers. Seed only compact incremental state.
- [ ] Release redundant result strings when context represents them; retain identity through compaction and payloads for unrepresented calls.
- [ ] Use accumulator context length for startup closure and fresh bounded replay after recovery writes. Preserve unrelated recovery/owner/queue policy.
- [ ] Add a replay memory subprocess that opens an already-generated database. Generate the fixture in a separate process so creation does not inflate replay measurements.

```ts
let iterations = 0;
const once = {
  *[Symbol.iterator]() {
    assert.equal(++iterations, 1);
    yield* fixture.events;
  },
};
assert.deepEqual(replayChatContext(once).messages, fixture.expectedMessages);
```

**Budgets:** ≤500 rows and ≤1 MiB decoded bodies per page, or one oversized event; no full event arrays. Existing ~28 MB incident fixture replay peak RSS increase must be **≤192 MiB** in a clean child process. Record baseline/peak, Node version, and journal/retained sizes. Do not silently loosen a failure; investigate and document any necessary budget revision before accepting it.

**Run:** after rebuild, `node dist/test-runner/run-tests.js chat-journal chat-context-replay chat-run-projection chat-run-recovery chat-recovery-performance chat-journal-retention status-server-chat-crash-recovery`.

**Acceptance:** Semantic parity and measured memory reduction from the previous roughly 0.5 GiB increase.

### Task 8 — Define the bounded projection protocol [9, 10]

**Files:** new `packages/contracts/src/chat-projection.ts`; `packages/contracts/src/index.ts`, `chat.ts`, `chat-recovery.ts`; new `tests/contracts-chat-projection.test.ts`; `dashboard/tests/chat-snapshot-fixture.ts`.

**Consumes:** Existing assembled-view schemas. **Produces:** cursor/record/frame/text-metadata schemas and 64 KiB constant from section 2.6.

- [ ] Define every logical record by composing existing schemas. Derive text metadata; no parallel message interface.
- [ ] Test each variant and malformed identity/cursor/offset/index/terminal values. Reject unknown versions/kinds.
- [ ] Define placement: null anchor means first; named anchor must already exist in staged state. Self/missing anchors and duplicate snapshot IDs fail.
- [ ] Validate begin/commit counts and same-sequence revision or queue/control updates. Both cursor components are monotonic. Reject reused transfer IDs and duplicated/conflicting fragments without applying them twice; reconnect supplies a fresh snapshot.
- [ ] Keep old schemas only until Task 11 removes their runtime callers. No selectable old/new branch and no intermediate deployment.

```ts
assert.equal(ChatProjectionFrameSchema.safeParse({
  version: 2, transferId, recordIndex: 0, chunkIndex: 0,
  finalChunk: true, data: '{"kind":"commit"}',
}).success, true);
assert.equal(ChatProjectionFrameSchema.safeParse({
  version: 1, transferId, recordIndex: 0, chunkIndex: 0,
  finalChunk: true, data: '{}',
}).success, false);
```

**Run:** after rebuild, `node dist/test-runner/run-tests.js contracts-chat-projection contracts-chat-recovery`.

**Acceptance:** Every collection and operation terminal/queue payload has a typed representation.

### Task 9 — Encode bounded records and generate true deltas [9, 10]

**Files:** new `src/status-server/chat-projection-encoder.ts`; `src/status-server/chat-operation-snapshot.ts`, `src/status-server/sse-response-writer.ts`; new `tests/chat-projection-encoder.test.ts`, `tests/chat-projection-updates.test.ts`; extend `tests/chat-journal-attach.test.ts`, `tests/sse-response-writer.test.ts`.

**Consumes:** Task 8 contracts and Task 7 captures. **Produces:**

```ts
function encodeChatProjectionRecords(
  records: Iterable<ChatProjectionRecord>, transferId: string,
): Generator<ChatProjectionFrame>;
function createChatSnapshotRecords(
  capture: ChatProjectionCapture,
): Generator<ChatProjectionRecord>;
function createChatUpdateRecords(
  before: ChatProjectionCapture, after: ChatProjectionCapture,
): Generator<ChatProjectionRecord>;
```

- [ ] Test round trips for quotes/backslashes/newlines, multibyte text, emoji boundaries, lone surrogates, nested arrays, images, approval payloads, and empty results.
- [ ] Test one message/result larger than 8 MiB. Every frame fits; reconstructed records exactly match originals.
- [ ] Implement bounded JSON token/string segments and real SSE UTF-8 accounting, plus the bounded single-write/drain method. No whole-record serialization then slicing. Test a commit whose socket write applies backpressure: its complete frame must be submitted before awaiting drain.
- [ ] Return the schema-derived capture containing snapshot/cursor/queue from one transaction. Generate suffixes/metadata for eligible prefix growth; replacements for rewrites/attachment changes; moves only for changed order; changed auxiliary entries only.
- [ ] Build lookup maps once per comparison, avoiding repeated whole-transcript searches and full ID-order transmission.
- [ ] Measure 1 MiB versus 2 MiB answers delivered in equal 4 KiB deltas with interleaved usage. Require linear traffic and no repeated unchanged image data/token history.

```ts
for (const frame of frames) {
  const wire = `event: chat_projection\ndata: ${JSON.stringify(frame)}\n\n`;
  assert.ok(Buffer.byteLength(wire, 'utf8') <= CHAT_PROJECTION_MAX_FRAME_BYTES);
}
assert.deepEqual(decodedRecords, inputRecords);
assert.ok(bytesForTwoMiB <= bytesForOneMiB * 2.2);
```

Also inspect decoded append records: only suffix text, correct offsets, no accumulated prefix. Use the real encoder for byte measurements, not object-size estimates.

**Run:** after rebuild, `node dist/test-runner/run-tests.js chat-projection-encoder chat-projection-updates chat-journal-attach sse-response-writer`.

**Acceptance:** Strict frame cap and linear ordinary text traffic, including metadata.

### Task 10 — Assemble and apply transfers atomically in the dashboard [9, 10]

**Files:** dashboard `chat-stream-parser.ts`, `chat-operation-projection.ts`, `chat-stream-transitions.ts`, `chat-session-runtime-store.ts`; their corresponding tests.

**Consumes:** Task 8 records/frames. **Produces:** `ChatOperationProjection.acceptFrame(frame: ChatProjectionFrame): ChatProjectionDelivery | null`, using the exact delivery schema in section 2.6. A committed view includes its optional queue update; terminal and failure have distinct delivery variants.

- [ ] Feed every split of multibyte/escaped content across network chunks, SSE packets, and record fragments.
- [ ] Keep one partial logical record; validate at its final chunk and stage the result. Accumulate fragments in an array joined once per record, never a serialized growing snapshot.
- [ ] Enforce packet byte limits while buffering. Process large network chunks containing many valid packets incrementally instead of counting the chunk as one frame.
- [ ] Apply placement/removal/text using identity maps and staged order; validate offsets and merged messages. Preserve unchanged object identity where practical.
- [ ] Publish only on matching commit counts/cursor. Disconnect, missing chunks, invalid order/IDs, and cursor gaps discard pending state and retain readable state.
- [ ] Test rejection of repeated transfers/fragments, valid fresh same-cursor queue/control transfers, same-sequence history changes, incomplete initial snapshot, terminal before commit, and independent simultaneous sessions.

```ts
const readable = projection.snapshot;
for (const frame of framesBeforeCommit) {
  assert.equal(projection.acceptFrame(frame), null);
  assert.equal(projection.snapshot, readable);
}
const delivery = projection.acceptFrame(commitFrame);
assert.equal(delivery?.kind, 'view');
if (delivery?.kind !== 'view') throw new Error('Expected committed view');
assert.deepEqual(delivery.snapshot.messages, expectedMessages);
```

**Run:** rebuilt dashboard tests using exact test paths for focused iteration, then `node dist/test-runner/run-tests.js --dashboard`.

**Acceptance:** Exact reconstruction, no partial view publication, reliable reattach after interruption.

### Task 11 — Cut over Web streams and remove obsolete paths [9, 10, 11, 14]

**Files:** `chat-operation-sse-subscriber.ts`, `chat-operation-broadcast.ts`, `routes/chat-operation-attach.ts`, `routes/chat.ts`, `routes/chat-repo-agent.ts`, `routes/chat-session-operation-endpoint.ts`, `chat-queue-successor.ts`; dashboard parser/transitions/hooks; `tests/helpers/chat-stream-views.ts`; HTTP route/attach/queue tests.

**Consumes:** Stable dependencies, record encoder, dashboard assembler. **Produces:** one Web operation projection protocol.

- [ ] Add HTTP coverage for owned submission, active/finished/restarted attach, queued successor, Stop, approval wait/resolution, and slow reader beyond the old 8 MiB prefix.
- [ ] Replace subscriber page/diff serialization with record encoding and the bounded write/drain method. Keep last committed view, one frozen capture, and a dirty wake flag; no frame history.
- [ ] Change chat broadcast usage to notifications and small terminal state. Remove serialization/retention of discarded full `done` payloads; preserve legitimate standalone/queue-only consumers.
- [ ] Carry operation queue/approval/error/terminal through the bounded codec. Terminal follows final projection commit.
- [ ] Gate transmission between image-bearing fragments, delete the image, then require the stale transfer to end without commit and reconnect to the revised capture.
- [ ] Switch dashboard and HTTP readers together. Remove `pageChatOperationSnapshot`, `ChatOperationUpdateSchema`, old update wire use, old page assembly, obsolete snapshot `messageOffset`/`complete` fields, and full-session terminal forwarding from Web streams. Remove old decoding branches with no remaining legitimate caller.
- [ ] Audit owned/attached/forced paths for the same codec and explicit database. No route may bypass bounds with a full-session completion event.
- [ ] Keep REST refresh as the existing API; no new UI controls or transport implementation details in product copy.

**Run:** rebuilt `node dist/test-runner/run-tests.js status-server-chat chat-journal-attach chat-message-queue contracts-chat sse-response-writer`, then dashboard suite.

**Acceptance:** One coordinated protocol, frozen capture plus contiguous catch-up, correct terminal/deletion behavior under backpressure.

### Task 12 — Integrated crash, resource, and release validation [all seven]

**Files:** existing `status-server-chat-crash-recovery.test.ts`, `helpers/chat-recovery-process.ts`, `chat-recovery-performance.test.ts`; new memory helper; `docs/web-chat-recovery.md`; this plan.

- [ ] Extend process barriers for deletion followed by replacement, invalid-call rejection, coalescing before/after replacement, and mixed-batch finalization.
- [ ] Kill at each barrier, restart the isolated database, and verify display/native continuation/queue/identity/side-effect counts. Recovery alone issues no tool command or provider request.
- [ ] Run large text/image/result attachment over a slow socket through the dashboard assembler; assert frame maxima, total traffic, incomplete-transfer rejection, and terminal order.
- [ ] Run clean-child replay memory measurement with an assertion, not diagnostics alone. Save compact metrics in task scratch.
- [ ] Audit removal of singleton eviction/getter workarounds, full event arrays, unused cache, reconstructed batch indices, invalid-response append bypass, row-count pages, whole-message/order per-delta transport, and obsolete Web decoders.
- [ ] Run section 5 validation. Record exact failures; report out-of-scope regressions without silently fixing or weakening them.
- [ ] Update operational docs with lifetime, memory model, 64 KiB framing, version conversion, deletion barrier, rejection correction, and coalescing. Remove superseded descriptions.
- [ ] Review final diff against seven scope entries, remove task scratch only, and report changed files, verification, historical repair limitations, and production untouched.

**Acceptance:** Every section 6 row passes; no implementation requirement is hidden in a limitation or follow-up.

## 5. Validation and execution discipline

Before focused tests after edits:

```powershell
$env:SIFTKIT_GUARD_RUNTIME_DATABASE = Join-Path (Get-Location) '.siftkit/runtime.sqlite'
npm run build:test
```

Run commands separately so each exit status is retained. Redirect potentially large output into the one task scratch directory and inspect bounded summaries/failure extracts. Do not use SiftKit.

Final focused/backend and dashboard coverage:

```text
node dist/test-runner/run-tests.js chat- runtime-db- approval-gate status-server-chat image-retention operation-stream assistant-backup-restore dashboard-run-log-admin image-input-surfaces engine-tool-action-processor repo-agent sse-response-writer
node dist/test-runner/run-tests.js --dashboard
```

Broader/static/build coverage:

```text
npm test
npm run typecheck
npm run lint
npm run build
npm --prefix dashboard run build
```

Typecheck invokes lint internally; still run the explicitly requested lint command. Rebuild the test manifest when a build changes tracked inputs. Do not edit source during a broad runner invocation.

Earlier audit failures outside scope were a terminal-metadata regex missing `direct=0` and a model-memory summary expectation missing compaction reserve. Recheck current source; concurrent work may fix them. This plan does not authorize their implementation.

Use completion-aware sessions and tool waits of at most 60 seconds so meaningful progress can be communicated. Do not repeatedly launch or poll SiftKit; it is excluded entirely.

## 6. Final acceptance matrix

| Scenario | Required proof |
| --- | --- |
| A open/use, B open/close | Original A handle/recorder/queue/owner remain valid; no cross-root write. |
| Shutdown with deferred writes | Own writers drain, owner releases while handle open, only own database closes, awaitable teardown finishes. |
| Replay/compaction/queue/partial narration | Correct retained messages/order/IDs/notices; no extra event-history allocation. |
| Large journal | Bounded fetched page, single-pass folds, full results, asserted clean-child memory budget. |
| Growing answer/thinking | Suffixes and correct metadata, linear wire totals, no unchanged blobs/full order per delta. |
| Huge message/result/image/approval | Full round trip; every projection SSE frame ≤65,536 UTF-8 bytes. |
| Unicode/escaping/fragmentation | Exact content, no surrogate corruption, malformed UTF-8 rejected. |
| Interrupted/slow snapshot | No partial committed view, bounded buffering, reconnect catches up without omissions/duplicates. |
| Delete during thinking/compaction | Deleted payload absent from later journal/context, including crash before next model boundary; surviving duplicates stay. |
| Delete while capture drains | Old staged transfer cannot commit; revised snapshot replaces it after reconnect. |
| Collapsed duplicate only | No invented interrupted exchange; replay matches live context. |
| Collapse plus fresh tool | Original indices preserved; completed run replayable and continuation admitted. |
| Crash around coalescing splice | Before splice reconstruct missing exchange; after splice respect deliberate representation; no repeated effect. |
| Invalid native args/name | Durable rejection, no tool/approval execution, correction possible, invalid ceiling unchanged. |
| Schema/event upgrade | Preserve 69→70, then atomic 70→71/v1→v2; corrupt/unknown rollback; no normal v1 reader or unused cache table. |
| Historical ambiguous/corrupt run | Preserve evidence and explicit failure; no guessed association or implicit repair. |
| Scope | Only 8–11 and 14–16 plus necessary callers/contracts/tests; preserve concurrent fixes. |

## 7. Review and rollout boundary

This document is a full implementation plan, not implementation/deployment approval. Related storage, replay, and protocol work stays together so migrations, server, dashboard, and crash semantics agree.

Before execution, refresh source/schema because other fixes are in progress. Update concrete signatures/version numbers if necessary without expanding scope. Deliver tested code and migration evidence from isolated copies. Production rollout, historical incident repair, and database restore require a separate explicit instruction.

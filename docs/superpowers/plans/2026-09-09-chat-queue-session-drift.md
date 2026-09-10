# Chat queue and shared history: session drift review

Scope: this session's queue, operation lifecycle, canonical persistence, transcript reducer, dashboard queue/stream changes, and their tests. Shared result hydration and provenance repair were also reviewed. Unrelated existing changes are excluded. Directives: the session's AGENTS.md and `C:/Users/denys/.claude/CLAUDE.md`. Review performed inline, without SiftKit or subagents. The user requested the top **13**, a saved report, and subsequent fixes.

These are pre-fix findings, ranked by data/lifecycle risk. Anchors identify the reviewed revision and may move during fixes. The synthetic disclosure improvement does **not** complete the companion plan's renderer profiling or bounded retained-history work; no browser is connected.

### 1. Obsolete ledger release/deletion paths remain callable

- **What it is:** `src/state/chat-message-queue.ts:386–415` still exposes unconditional deletion and return-to-pending recovery.
- **Purpose:** Early queue bookkeeping before canonical incorporation and crash recovery existed.
- **Why it's an issue:** Violates complete replacement. Releasing already injected users can replay them; deleting without canonical incorporation can lose them. Tests still endorse the obsolete recovery behavior.
- **The fix:** Remove these APIs and migrate callers/tests to atomic canonical incorporation and explicit interrupted recovery. Scope: store and store tests.
- **Context:** `releaseAllDelivered()` delegates to `releaseDelivered(...)`; `deleteDelivered(...)` deletes without checking saved history.

### 2. Persistence retains parallel caller-supplied queue/history paths

- **What it is:** `src/status-server/chat.ts:666,875,1004` falls back to caller queue arrays; `chat-repo-operation-runner.ts:72–75,185–207` carries obsolete queue stores, content IDs, and history overrides.
- **Purpose:** Integrate a multi-message successor into formerly single-message persistence.
- **Why it's an issue:** Violates DRY and complete replacement. Persistence already owns the authoritative ledger transaction; callers can now bypass it or apply a second identity policy.
- **The fix:** Keep delivery arrays only in pure builders; durable writers always read SQLite. Remove redundant request fields, queue filtering, and unused history overrides. Scope: runner, routes, persistence and tests.
- **Context:** `queuedMessages: deliveries.length > 0 ? deliveries : options.queuedMessages`.

### 3. Model terminal failures can look like successful lifecycle completion

- **What it is:** `src/status-server/routes/chat.ts:731–774` returns a saved session without its terminal outcome; the operation endpoint then reports completion.
- **Purpose:** Reuse existing chat persistence for automatic queue successors.
- **Why it's an issue:** A bounded run ending from exhaustion/overflow is not normal completion. The new automatic successor can restart failed work. This is a lifecycle patch around a result that should carry its outcome explicitly.
- **The fix:** Propagate the engine terminal outcome through the shared execution result and lease. Start automatic successors only after normal finish. Scope: shared message/repo runners and lifecycle regressions.
- **Context:** `return updatedSession;` followed by `finish(lease, { kind: 'completed' })`.

### 4. Successor claim precedes complete admission

- **What it is:** `src/status-server/routes/chat-repo-agent.ts:234` claims before `startRepoAgentRun`; plan/search claim at the call site before their runner admits images.
- **Purpose:** Give initial queued users stable delivery IDs before execution.
- **Why it's an issue:** Rejected startup can strand delivered rows although no request started. Only the first queued message follows normal admission, while later images are injected separately. This violates the explicit claim/admission boundary.
- **The fix:** Validate the entire snapshot against the current session/preset and startup requirements before claiming; keep claim tied to the admitted request identity. Scope: successor and shared start boundary, with rejection tests.
- **Context:** `const initialFollowupMessages = ... claimQueuedStart(...);` before `startRepoAgentRun(...)`.

### 5. Empty Force now can stop useful work

- **What it is:** `src/status-server/routes/chat-message-queue.ts:112–136` records force intent and aborts before discovering its snapshot is empty in the successor runner.
- **Purpose:** Serialize force intent and cancellation.
- **Why it's an issue:** The empty-queue boundary is handled too late. A stale tab can stop a run without any continuation to deliver.
- **The fix:** Reject an empty snapshot transactionally before cancellation. Scope: store/endpoint and held-run HTTP test.
- **Context:** `beginForce(...)` → `active.abort()` → runner rejects missing first message.

### 6. Force idempotency has two conflicting failure paths

- **What it is:** `src/state/chat-message-queue.ts:179` compares only force ID for an in-progress retry; route failure branches use `updateForce` instead of durable `failForce`.
- **Purpose:** Retain UI force state and allow retries.
- **Why it's an issue:** Reusing an ID with another expected operation can be called a duplicate; failed attempts without a receipt can be replaced and retried. Identity and failure outcomes must have one durable definition.
- **The fix:** Compare both IDs; route every terminal failure through durable receipt creation and pause. Scope: store, endpoint, retry tests.
- **Context:** `kind: state.force.id === request.id ? 'duplicate' : 'conflict'`.

### 7. Partial snapshot claims commit before reporting missing IDs

- **What it is:** `src/state/chat-message-queue.ts:353` filters to available IDs and commits those rows; `claimQueuedStart` checks the count afterward.
- **Purpose:** Claim a specified FIFO batch.
- **Why it's an issue:** A failed fixed-snapshot claim can mutate part of the ledger. Validation belongs in the same transaction as the claim, not afterward.
- **The fix:** Validate unique requested IDs and complete availability before any update. Scope: store and atomic-claim tests.
- **Context:** `listPending(sessionId).filter(...)` followed by per-row updates.

### 8. Force transport failure discards the retry key

- **What it is:** `dashboard/src/hooks/useChatSessions.ts:735` deletes the force request after every caught error.
- **Purpose:** Permit another Force now attempt after an error.
- **Why it's an issue:** A lost response does not prove the server rejected the action. A fresh key can initiate a second cancellation/continuation. Transport ambiguity and confirmed server rejection must be distinct.
- **The fix:** Retain the request for ambiguous transport failures; release it only on success or a validated terminal rejection. Scope: API error contract, hook and retry test.
- **Context:** `catch (...) { ... forceSubmissions.current.delete(sessionId); }`.

### 9. Queue subscription stops permanently on a dropped connection

- **What it is:** `dashboard/src/hooks/useChatSessions.ts:211` drains one queue stream and only reports a failure when it ends.
- **Purpose:** Synchronize pending state and attach to server-owned successors.
- **Why it's an issue:** This new synchronization path has no reconnection lifecycle. A background tab can remain stale and miss a successor until reload. The stream is a first-class dependency, not a one-shot fetch.
- **The fix:** Reconnect the status stream with cancellation-aware cleanup and an authoritative state snapshot. Reconnection must never schedule message delivery. Scope: queue API/hook and connection test.
- **Context:** `for await (const queue of streamChatQueue(...))` occurs once per selected session.

### 10. FIFO protection exists only in the composer

- **What it is:** `useChatSessions.ts:682` decides whether to queue; the normal operation endpoint can still admit an independent send while durable pending messages exist.
- **Purpose:** Keep idle Send behavior while busy submissions enter the queue.
- **Why it's an issue:** A stale/second client can overtake earlier pending users. The server owns FIFO, so client-local state cannot be its only admission guard. A busy submission arriving just after normal completion also needs an explicit policy.
- **The fix:** Enforce pending-queue admission on the server and carry the observed operation identity on automatic busy enqueues, so a settled normal operation can start its successor without treating deliberate idle queueing as automatic. Scope: contract, endpoint, hook and race tests.
- **Context:** `if (shouldQueue(session.id)) ...` is the only admission switch.

### 11. Initial successor deliveries lack canonical delivery events

- **What it is:** `routes/chat.ts:574` emits initial delivery frames; only post-tool delivery is logged by `engine/task-loop.ts`.
- **Purpose:** Render forced users immediately and preserve their canonical IDs.
- **Why it's an issue:** The initial boundary has a parallel SSE-only identity path. Canonical engine events cannot independently establish those delivery IDs, unlike normal steering.
- **The fix:** Log the admitted initial delivery identities at the engine's initial transcript boundary using the concrete queue dependency. Scope: queue delivery interface, engine and transcript tests.
- **Context:** `progress.write({ kind: 'queued_user_message', ... boundary: 'successor_start' })` has no corresponding initial engine event.

### 12. Queued images lose normal persisted metadata

- **What it is:** `src/status-server/chat.ts:591` rebuilds queued user rows with `imageMeta: []`; crash recovery does the same.
- **Purpose:** Merge queued images by stable user ID.
- **Why it's an issue:** It preserves bytes but bypasses the existing image metadata/token accounting path. Multi-message input should use the same attachment representation as ordinary input.
- **The fix:** Derive/preserve admitted metadata for each delivered user's images through canonical persistence and recovery, without adding base64 bodies to queue status frames. Scope: merge/recovery and image tests.
- **Context:** `buildChatUserMessage(delivery.content, delivery.images, [], ...)`.

### 13. Replay ceiling permits an oversized final frame

- **What it is:** `src/status-server/chat-operation-broadcast.ts:101` trims only while more than one frame remains and counts UTF-16 characters as bytes.
- **Purpose:** Bound retained operation replay; the queue adds another broadcast using a zero-sized buffer.
- **Why it's an issue:** The new queue path inherits a nominal ceiling that is not enforced, and zero-buffer channels still retain a frame. Large done/image frames can exceed the claimed memory budget.
- **The fix:** Enforce the byte ceiling including a single oversized frame; still deliver live frames, mark truncated replay, and retain no frames for zero capacity. Scope: broadcast and oversized/multibyte tests.
- **Context:** `while (this.bufferedBytes > this.maxBufferedBytes && this.frames.length > 1)`.

## Fix and verification record

All 13 findings were addressed after this report was saved:

| Finding | Disposition and regression evidence |
|---|---|
| 1 | Removed all blind release/delete APIs. Recovery preserves users canonically; partial ledger cleanup also rolls back atomically. Store and persistence transaction tests cover both failure paths. |
| 2 | Durable writers read only their own authoritative ledger. Removed caller queue stores/arrays, content IDs, history overrides, and the redundant filtering method. Pure builders retain explicit data inputs for deterministic tests. |
| 3 | Shared execution returns a terminal failure outcome. Streamed and nonstream HTTP failures pause automatic continuation. Held terminal-result tests distinguish normal completion, exhaustion, and thrown HTTP failure. |
| 4 | Every snapshot image is admitted before successor acquisition. Claiming moved into the engine's initial boundary, after startup admission. A rejected second image leaves both entries pending and invokes no engine. |
| 5 | `beginForce` returns `empty` before any cancellation. Store boundary tests cover empty snapshots. |
| 6 | Both operation and force IDs define a retry. Endpoint terminal failures write durable failed receipts. Retry, stale ID, concurrent duplicate, and Stop-supersession tests cover the lifecycle. |
| 7 | Missing or duplicate snapshot IDs throw before updates, within the claim transaction. Tests verify every entry remains pending. |
| 8 | Ambiguous transport failures retain the original force request. Only success or a schema-validated server rejection releases its key. A lost-response hook test verifies identical retry bodies. |
| 9 | Queue status reconnects after EOF/network failure and cancels its retry on session change/unmount. The API test observes two snapshots and no connection after abort. Delivery remains server-owned. |
| 10 | The server rejects sends that overtake pending users. Busy enqueue carries its observed operation identity; a just-completed normal operation starts one successor. Both HTTP races are tested. |
| 11 | Initial engine delivery emits both canonical events and live progress, with stable IDs and boundary zero. The held-force test reads the saved transcript and verifies the FIFO event IDs. |
| 12 | HTTP admission normalizes queued attachments, and canonical/recovery user construction derives their admitted image metadata. Dimensions and token metadata are covered by an image regression. |
| 13 | Replay counts UTF-8 bytes and drops even a single oversized frame; zero-capacity channels retain none. Live delivery continues and replay is explicitly marked truncated. Multibyte/oversized tests cover the boundary. |

Additional cleanup removed a dynamically passed test-observer callback. No compatibility path or obsolete queue-release method remains.

Final validation:

- `npm run build:test`: passed.
- `npm test`: **3,725 passed, 5 skipped, 0 failed** (3,730 total).
- `npm test -- --dashboard`: **477 passed, 1 failed** (478 total). The sole failure is the documented, unrelated `model-preset-groups` memory-summary expectation at `dashboard/tests/model-preset-groups.test.ts:38`: it expects no compaction-reserve label while the existing implementation includes one. That test and its implementation are unchanged, as the shared plan explicitly requires.
- `npm run typecheck`: passed, including backend, contracts, scripts, benchmark, test, dashboard-test, analysis, and its lint stage.
- Separate `npm run lint`: passed.
- `npm run build`: passed, including the dashboard production build; final confirmation exited 0. Vite's existing large-chunk advisory remains.
- `git diff --check`: passed. Obsolete queue-release and operation-specific reader symbols were absent in the final source scan. Presentation preview fields remain separate from full result fields.
- Focused coverage includes actual provider request ordering across a two-tool batch, stopped/restarted full-result replay, provider failure after delivery, atomic save/cleanup rollback, late automatic enqueue, blocked FIFO overtaking, snapshot admission failure, concurrent force retries, stale force identity, and ordinary Stop superseding Force now.

The last added Stop-supersession test initially deadlocked because its fixture waited for Stop's persistence-aware response before releasing persistence. The corrected fixture observes the cancelled force state, releases settlement, then checks both responses. Production Stop behavior was preserved.

The companion memory task remains partial for the reasons documented there: no renderer is connected, and the retained live transcript is not yet bounded. This is an explicit outstanding task, not a claim that the browser OOM is fixed. Scratch artifacts were removed after retaining these results. No commit, worktree, SiftKit invocation, or production-history repair was performed during this continuation.

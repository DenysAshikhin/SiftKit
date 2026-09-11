# Durable web chat recovery

How a Web chat run is recorded, what a refresh or restart restores, and how a damaged legacy chat is repaired. Implementation plan: [2026-09-10-durable-web-chat-recovery.md](superpowers/plans/2026-09-10-durable-web-chat-recovery.md).

## Journal model

Every Web operation (message, plan, repo-search, repo-agent, condense, queued successor) is one **run** in `chat_runs`, owned by the server process that admitted it (`owner_epoch`) and written as an append-only sequence of events in `chat_run_events`. The connection runs `journal_mode = WAL`, `synchronous = FULL`.

- **Commit before act.** A tool proposal, its automatic-reviewer verdict (`approval_reviewed`), its start, its full result, and every planner-history splice are committed before the engine proceeds. A write the database cannot take (`SQLITE_BUSY`, `SQLITE_FULL`, I/O or corruption errors) fences the run: the throw reaches the engine, nothing after it runs, nothing already committed is lost, and the run closes as `storage_failure`. A write the journal refuses by design (a conflicting duplicate event, a fenced epoch) throws without that classification.
- **Admission settings are captured once.** `run_started` carries the preset, model preset, turn limit, approval mode, web-search decision and context window the run executes under. Execution reads `recorder.settings` (the engine is dispatched with the admitted `presetId`); it never re-reads the request body. Invalid `maxTurns` / `webSearchOverride` values are rejected with 400 at admission.
- **Text is journaled as deltas.** Narration, thinking and answer text are `display` events carrying one delta each; the transcript is never rewritten per token. A 103-turn / 116-result run writes ~1k rows and ~28 MB (`tests/chat-recovery-performance.test.ts`).
- **Reads are bounded and paged** (`CHAT_JOURNAL_READ_PAGE_SIZE = 500`, with a 1 MiB UTF-8 decoded-body target) and indexed by `(operation_id, sequence)`; `readAll` refuses gaps, altered bodies (payload digest) and unknown event versions.
- **Queue deliveries** are journaled as `queue_delivered` inside the claim transaction; queued images are admitted against the run's model preset there, so a refused image leaves the message pending rather than half-delivered.

Journal schema 70→71 atomically converts v1 rows to event version 2. Historical queue image metadata is moved into the queued message and historical context splices receive an explicit empty coalescing list. The migration validates the complete frozen v1 event shape and each old digest before changing a row; corrupt or unknown evidence leaves the marker unchanged. Runtime readers accept v2 only.

## Display and context are projections

Two readers derive everything shown or sent from the journal:

- `rebuildChatRun` / `reconcileChatRun` → display rows in `chat_messages` via the shared `reduceChatTranscript` reducer (the same reducer the dashboard uses for live frames). Narration that precedes a tool start in its turn is shown as progress; tool rows carry full outputs from `tool_result`, never previews. The checkpoint (`projected_sequence`, `projected_digest`, `projected_history_revision`) lives on the `chat_runs` row; a run is replayed from event one only when its rows were altered, compacted, or a history revision landed since the checkpoint.
- `buildRecoveredChatHistory` → the planner context a continuation starts from: replayed `context_initialized` + `context_spliced` events, with interrupted tool batches closed by explicit interruption results and any partial narration folded back once with a notice.

Projection failures never roll back the source event. A run whose projection is inconsistent reports `recovery_failed` and blocks new admissions on that session until repaired.

## What refresh and Continue restore

| Situation | Display | Continuation |
| --- | --- | --- |
| Refresh during a live run | Journal snapshot plus bounded catch-up frames from the cursor | Same operation; no new provider request |
| Browser disconnect | As above on reattach | Same operation continues server-side |
| Stop during text | Partial text stays; `user_stop` outcome | Next run gets the retained context |
| Approval timeout (10 min, `DEFAULT_DECISION_TIMEOUT_MS`) | Proposed command and timeout remain | Command is not executed; the next run sees it as interruption evidence |
| Server kill before a tool started | `not_started` | Never auto-executed; a new proposal needs a new approval |
| Server kill after the side effect, before the result commit | `uncertain` | Verify the repository before retrying; recovery performs no side effect |
| Server kill after the result commit | `completed` with full output | Not re-run |
| Server restart | Orphaned runs are re-owned and closed on startup (`recoverInterruptedChatRuns`) | A **new** continuation operation is required; old approvals are no longer actionable |

Runs are owned by a process lease (`chat_runtime_owner`). Losing the lease fences every writer: further evidence is refused and the run closes with `storage_failure`.

Runtime databases are registered by canonical absolute path. A server or fixture closes only the path it owns; opening another runtime database cannot evict the first connection. Shutdown drains deferred writers, releases the owner while its handle is open, and then closes that handle.

## Revisions and retention

User edits are **history revisions** (`history_revised` events in `history_revision` records): message deletion, image removal, caption edits and condense. They are applied on top of projections, so deleted content never re-enters the display or the prompt. Image removal purges the payload bytes from every journal copy in the same transaction. The session's revision count is recorded on each new run (`retainedHistoryRevision`).

Deleting a session cascades through `chat_sessions → chat_runs → chat_run_events`. There is no time-based journal retention.

## Backup and restore

`BackupService` snapshots the whole runtime database with SQLite's online backup, so the chat journal, projections, revisions and owner table travel with it. `RestoreService` rewrites **only** assistant-owned tables; chat data present at restore time is left as-is (`tests/assistant-backup-restore.test.ts`). To restore chat data, restore the whole database file while the server is stopped — never over newer accepted writes.

## Repairing a legacy chat

Runs recorded before the journal existed are imported once as a **baseline** (`importChatSessionBaseline`) from the saved session rows. A damaged repo-agent chat is repaired from its archived run log:

```
node --import tsx scripts/recover-web-chat.ts --database <runtime.sqlite> --session-id <chat id> \
  --request-id <request id> --repo-agent-state <state.json> [--max-turns N]            # dry run: prints the report
node --import tsx scripts/recover-web-chat.ts ... --apply --expected-digest <report.expectedDigest> --backup <new file>
```

- The dry run reports source digests, reconstructable counts, known gaps and the exact rows an apply would insert.
- `--apply` requires the dry-run digest and a **new** backup path; a stale digest, an existing backup path or a schema mismatch is refused before anything is written. Applying twice is a no-op.
- The importer never executes tools (`executedToolsDuringImport` is asserted 0) and never fabricates evidence: fragments the archive did not record are listed under `knownGaps`, not invented.
- Deleted image occurrences are filtered at the context commit boundary as well as swept from existing evidence. A stale in-flight projection is discarded when a deletion revision commits, and the next capture starts from the revised view.
- Invalid native calls receive a durable proposal and rejected result with their original call identity, so a later model turn can correct them without executing the invalid call or requesting approval. Deliberate duplicate coalescing is recorded explicitly and replayed only after its replacement splice commits.

Recommended rollout: stop new admissions, let active runs settle, take a SQLite-aware backup, migrate, run the dry run, apply on a copy and verify chat/continuation there, then apply to production under separate authorization.

## Projection transport

The Web operation stream uses typed projection records and 64 KiB UTF-8-bounded SSE frames. A snapshot begins from empty staged state; an update carries only changed rows, suffix text plus row metadata, moves/removals, and changed auxiliary state. Large records are fragmented at JSON boundaries and published atomically at `commit`; a partial or stale transfer never replaces the last readable view. Terminal state is sent only for the exact cursor that was committed.

## Limitations

- **Legacy archives** carry no image admission metadata (`imageMeta: []`) and record completed model responses, not every streamed fragment.
- **Replay memory.** Replay folds a single-use iterable through one bounded page (or one oversized event), required model/display state, and compact identity metadata. Full tool arguments and result payloads are released once a call is represented in retained context; unresolved calls retain the evidence needed for interruption closure.
- **Live transport.** Structural or attachment rewrites still send a complete message row; ordinary streamed growth sends only a suffix and metadata. REST session refresh remains outside the projection-frame budget.
- **Concurrency.** A second process holding the write lock surfaces as `SQLITE_BUSY` after the 5 s busy timeout; the run stops with `storage_failure` rather than waiting indefinitely.

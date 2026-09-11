# Durable web chat recovery

How a Web chat run is recorded, what a refresh or restart restores, and how a damaged legacy chat is repaired. Implementation plan: [2026-09-10-durable-web-chat-recovery.md](superpowers/plans/2026-09-10-durable-web-chat-recovery.md).

## Journal model

Every Web operation (message, plan, repo-search, repo-agent, condense, queued successor) is one **run** in `chat_runs`, owned by the server process that admitted it (`owner_epoch`) and written as an append-only sequence of events in `chat_run_events`. The connection runs `journal_mode = WAL`, `synchronous = FULL`.

- **Commit before act.** A tool proposal, its automatic-reviewer verdict (`approval_reviewed`), its start, its full result, and every planner-history splice are committed before the engine proceeds. A write the database cannot take (`SQLITE_BUSY`, `SQLITE_FULL`, I/O or corruption errors) fences the run: the throw reaches the engine, nothing after it runs, nothing already committed is lost, and the run closes as `storage_failure`. A write the journal refuses by design (a conflicting duplicate event, a fenced epoch) throws without that classification.
- **Admission settings are captured once.** `run_started` carries the preset, model preset, turn limit, approval mode, web-search decision and context window the run executes under. Execution reads `recorder.settings` (the engine is dispatched with the admitted `presetId`); it never re-reads the request body. Invalid `maxTurns` / `webSearchOverride` values are rejected with 400 at admission.
- **Text is journaled as deltas.** Narration, thinking and answer text are `display` events carrying one delta each; the transcript is never rewritten per token. A 103-turn / 116-result run writes ~1k rows and ~28 MB (`tests/chat-recovery-performance.test.ts`).
- **Reads are paged** (`CHAT_JOURNAL_READ_PAGE_SIZE = 500`) and indexed by `(operation_id, sequence)`; `readAll` refuses gaps, altered bodies (payload digest) and unknown event versions.
- **Queue deliveries** are journaled as `queue_delivered` inside the claim transaction; queued images are admitted against the run's model preset there, so a refused image leaves the message pending rather than half-delivered.

## Display and context are projections

Two readers derive everything shown or sent from the journal:

- `rebuildChatRun` / `reconcileChatRun` → display rows in `chat_messages` via the shared `reduceChatTranscript` reducer (the same reducer the dashboard uses for live frames). Narration that precedes a tool start in its turn is shown as progress; tool rows carry full outputs from `tool_result`, never previews. The checkpoint (`projected_sequence`, `projected_digest`, `projected_history_revision`) lives on the `chat_runs` row; a run is replayed from event one only when its rows were altered, compacted, or a history revision landed since the checkpoint.
- `buildRecoveredChatHistory` → the planner context a continuation starts from: replayed `context_initialized` + `context_spliced` events, with interrupted tool batches closed by explicit interruption results and any partial narration folded back once with a notice.

Projection failures never roll back the source event. A run whose projection is inconsistent reports `recovery_failed` and blocks new admissions on that session until repaired.

## What refresh and Continue restore

| Situation | Display | Continuation |
| --- | --- | --- |
| Refresh during a live run | Journal snapshot (paged, ≤100 rows per page) plus catch-up frames from the cursor | Same operation; no new provider request |
| Browser disconnect | As above on reattach | Same operation continues server-side |
| Stop during text | Partial text stays; `user_stop` outcome | Next run gets the retained context |
| Approval timeout (10 min, `DEFAULT_DECISION_TIMEOUT_MS`) | Proposed command and timeout remain | Command is not executed; the next run sees it as interruption evidence |
| Server kill before a tool started | `not_started` | Never auto-executed; a new proposal needs a new approval |
| Server kill after the side effect, before the result commit | `uncertain` | Verify the repository before retrying; recovery performs no side effect |
| Server kill after the result commit | `completed` with full output | Not re-run |
| Server restart | Orphaned runs are re-owned and closed on startup (`recoverInterruptedChatRuns`) | A **new** continuation operation is required; old approvals are no longer actionable |

Runs are owned by a process lease (`chat_runtime_owner`). Losing the lease fences every writer: further evidence is refused and the run closes with `storage_failure`.

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

Recommended rollout: stop new admissions, let active runs settle, take a SQLite-aware backup, migrate, run the dry run, apply on a copy and verify chat/continuation there, then apply to production under separate authorization.

## Limitations

- **Legacy archives** carry no image admission metadata (`imageMeta: []`) and record completed model responses, not every streamed fragment.
- **Replay memory.** Rebuild and context replay materialise a run's events in memory; the incident-scale test shows ~0.5 GiB RSS growth for a 28 MB journal. Acceptable for current sizes, not streaming.
- **Live transport.** Catch-up frames resend each changed display row whole rather than as text patches, and snapshot pages are bounded by row count, not bytes.
- **Concurrency.** A second process holding the write lock surfaces as `SQLITE_BUSY` after the 5 s busy timeout; the run stops with `storage_failure` rather than waiting indefinitely.

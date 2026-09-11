# Durable web chat recovery — handoff (session 2)

Date: 2026-09-10. Implementation is **nearly complete; final validation and documentation are outstanding.**

Plan: [2026-09-10-durable-web-chat-recovery.md](../plans/2026-09-10-durable-web-chat-recovery.md).

Base checkpoint: `8bdf83ec` (implementation) + `b045722e` (previous handoff). Everything below is **uncommitted working-tree state** (56 modified/deleted tracked files + 1 new test). Do not commit unless asked. `docs/superpowers/plans/2026-09-10-exl3-pinned-arena-windows-and-prod-resync.md` is an unrelated untracked file; leave it alone.

## Resume constraints

- No SiftKit, no worktrees, no commits without request. Preserve unrelated work. Comments 1–2 lines max.
- Repository TypeScript rules: runtime-validated IO, `z.infer` types, no `any`/assertions/non-null/namespace imports; complete replacements, no shims.
- TDD; never weaken valid tests.
- Scratch lives only in `.scratch/web-chat-recovery/` (447 files). Private incident evidence there must survive until closeout (see bottom). Never run tests against the real `.siftkit/runtime.sqlite` (`SIFTKIT_GUARD_RUNTIME_DATABASE` deny guard). Never restore an older copy over newer writes. Production repair is a separately authorized action and has **not** been performed.
- Do not edit source while a full Node run is in progress (manifest-freshness checks).

## Completed this session (all uncommitted)

### Crash harness (Task 13, part)
- `tests/status-server-chat-crash-recovery.test.ts` compiles: null native content handled via `messageText` helper (line 22).
- `tests/helpers/chat-recovery-process.ts`: `BaseUrl: config.providerUrl` (was double `/v1` → 404 on `/v1/models`).
- All 15 hard-crash cases pass (~2 s each).

### Admission settings captured once (Task 6)
- `ChatRunEffectiveSettingsSchema` gained `presetId`. `ChatWebSearchOverrideSchema` added in `packages/contracts/src/chat.ts`.
- `chat-route-request-normalizers.ts`: `ChatMessageRequest.maxTurns/webSearchOverride`, `ChatRepoRequest.maxTurns`, `optionalMaxTurns`.
- `chat-run-recorder.ts`: `buildChatRunSettings(...)` takes presetId/maxTurns/webSearchEnabled; `get settings()` throws if absent. `claimQueuedMessages` reads the session and admits images inside the claim transaction; `queue_delivered` carries `imageMeta` (schema, projection, revision purge updated).
- `routes/chat.ts`: `describeChatMessageRun(session, value, config, webToolsAllowed)`; Create endpoint passes `false`, Stream `true`; condense uses `session.presetId`; `runChatEngineTurn` consumes `recorder.settings`; `readRouteNumber` removed.
- `routes/chat-repo-agent.ts`: `selectRepoAgentPreset`; runner and endpoint read `recorder.settings` for `maxTurns`/`webToolsEnabled`.
- `chat-session-operation-endpoint.ts`: `retainedHistoryRevision` = count of `readChatHistoryRevisions(...)` (no longer hardcoded 0). `chat-queue-successor.ts` forwards `maxTurns`/`webSearchOverride`.
- Approval audit outcome: `approval_auto` verdicts are progress-only, not journaled approval events — documented limitation, diagnostic-only.

### Live history mutation wake-ups
- `ChatOperationSubscriber.onHistoryRevised()`; `ChatOperationBroadcast.notifyHistoryRevised()`; SSE subscriber marks dirty and pumps; delete-message, delete-image, and caption endpoints notify. Tests in `status-server-chat-stop.test.ts` ("deleting a projected message wakes attached readers") and `chat-operation-broadcast.test.ts`.

### Task 11 CLI E2Es
- `tests/chat-history-import.test.ts`: `runRecoveryCommand` + apply / repeat / stale-input / failure cases pass.

### Task 12 cleanup
- Deleted: `src/status-server/repo-agent-history-repair.ts`, `tests/repo-agent-history-repair.test.ts`, `scripts/analysis/repair-repo-agent-history.ts`.
- `src/status-server/chat.ts`: obsolete terminal writers removed; exports `trimText`, `shouldPreserveThinking`, `selectReplayableChatMessages`. Pre-cleanup copy at `.scratch/web-chat-recovery/chat.ts.before-cleanup`.
- Baseline reader `buildChatHistoryMessages` moved into `chat-history-import.ts` (import ownership).
- `chat-tool-results.ts`: `hydrateChatToolMessages`/`hydrateTerminalChatMessages` removed. `chat-turn-telemetry.ts`: dead helpers removed.
- Schema **68→69**: `retireRepoAgentHistoryRepairMarkers` deletes `runtime_metadata` keys `repo-agent-history-v1:%`; `CURRENT_SCHEMA_VERSION = 69`; upgrade test added in `runtime-db-schema.test.ts`.
- 27 legacy tests removed across `chat-sessions-db`, `status-server-chat`, queue-delivery, image-retention, tool-results (they exercised deleted writers); fixtures updated with `presetId`/`webSearchEnabled`.
- Dashboard grep found no remaining `replayTruncated`/raw-event branches.

### Validation evidence (`.scratch/web-chat-recovery/`)
- `cleanup-green3.log`: targets `chat- runtime-db-schema status-server-chat approval-gate image-retention operation-stream assistant-backup-restore dashboard-run-log-admin` → **858 pass / 0 fail** after cleanup.
- `resume-typecheck1.log`: typecheck + lint clean **before** cleanup; main-project `tsc` and eslint on touched modules clean **after** cleanup. Full `npm run typecheck` / `npm run lint` not rerun since.

## Immediate next step

`tests/chat-recovery-performance.test.ts` was just written (Task 13 measurement test) and **has not been built or run**. Run:

```
npm run build:test 2>&1 | tail -40
node dist/test-runner/run-tests.js chat-recovery-performance
```

Expected fix-ups: `recordContextSpliced` inserted-message shape for `tool_calls`, `recordToolProposed`/`recordToolResult` field names, `rebuildChatRun` return shape (`status`), `ChatOperationSnapshotReader.capture` signature, `pageChatOperationSnapshot` page fields (`messages`, `complete`), `mockModelPreset` overrides. Adjust the test to the real APIs — do not add shims. Assertions: rows == `latestSequence`, bytes > 8 MiB, 309 narration events each carrying exactly one delta, 116 `tool_result` rows, `readAfter` page == `CHAT_JOURNAL_READ_PAGE_SIZE`, contiguous `readAll`, indexed `EXPLAIN QUERY PLAN`, replay yields 116 full tool messages, snapshot pages ≤100 messages and >1 page, `t.diagnostic` timing/rss (no timing thresholds).

## Remaining work, in order

1. **Fault coverage (Task 13).** SQLITE_BUSY (hold a write lock from a second connection while the recorder commits; expect a structured failure, no partial publish) and SQLITE_FULL (isolated: e.g. `PRAGMA max_page_count` on a temp DB — never fill the real disk); projection failure, authorization failure, and published-prefix preservation on recovery error. Consider adding a timeout to the kill path in `tests/helpers/chat-recovery-process.ts` (currently awaits exit unbounded).
2. **Incident revalidation (Task 11).** Copy `.scratch/web-chat-recovery/incident-copy.sqlite` to a fresh file, run the current importer against the copy only (see `apply-incident-copy.ts`; rebuild its `.mjs` bundle first), regenerate a sanitized `incident-repair-report.json`, record the exact reviewed command. No production apply.
3. **Backup/restore audit (Task 12).** `assistant-backup-restore` passed in the broad run; confirm the full runtime DB backup/restore path carries `chat_runs`/`chat_run_events`/recovery/owner-lease tables and that assistant-only `RestoreService` does not become a full chat restore.
4. **Task 14.** Write `docs/web-chat-recovery.md` (journal model, recovery/attach flow, revision/purge semantics, CLI repair, limitations incl. auto-approval provenance). Reconcile plan checkboxes against code. Then run independently and record status:
   - `npm run build`, `npm run build:test`
   - `node dist/test-runner/run-tests.js chat- runtime-db-schema approval-gate status-server-chat`
   - `node dist/test-runner/run-tests.js --dashboard` (known pre-existing failure: `memory summary reports context, chunk size and KV cache mode` — do not weaken)
   - `npm test`, `npm run typecheck`, `npm run lint`, `npm --prefix dashboard run build`
5. **Closeout.** Delete task-owned scratch logs/scripts; keep private incident evidence listed below unless the user says otherwise. Final report: changed files, checks run with results, limitations, and that production repair was not performed.

## Gotchas learned this session

- `python` is unavailable in Git Bash; use node/perl or the Edit tool. Multi-line bash heredocs containing `'` fail in this shell — use the Write tool for new files.
- Admission `retainedHistoryRevision` test expects `[0, 2]`: image purge and message deletion each record a revision.
- Live-wake partial text can arrive in a `projection` frame rather than `snapshot`; read from either.
- Stop detail lives in `runTerminalDetail`, not `content` (`chat-usage-stream-frame.test.ts`).
- `readChatRunMessages` rows are empty until `recorder.readSession()` (projection) runs.
- Compaction replay rows carry stable `chatMessageId` (e.g. `'s0'`).
- `git stash` to compare against baseline is unsafe: baseline does not compile (crash harness). Working tree was restored intact.

## Private evidence to preserve (do not commit)

- `.scratch/web-chat-recovery/incident-copy.sqlite` (schema-68 consistent copy, not imported), `incident-repair-report.json` (historical; regenerate), `apply-incident-copy.ts/.mjs`, `incident-database-comparison.json`, `native-pairing-diagnostics.json`, `incident-shape.json`, `archive-context-shape.json`, `HANDOFF.md`.
- `incident-repair-validation-563ffea0-….sqlite` is obsolete (pre-`repairDigest`); create a fresh validation copy.
- Incident identity: request `706f2e52-01ec-4e62-9dc0-b7ced282e27e`, repo-agent session `074bbeb7-88aa-4412-8e38-94ad8bf1cf80`, chat `3e3b5cf7-39ce-438b-8d6c-1031056e471d`, artifact `9d5ca37a-45d6-4c61-bf28-6044e9da93da`; payload 1,919,450 bytes, SHA-256 `6d7ea62c4e83fa6ba443082aa2df919798a2119dbe2d33026519953677b91de4`. 103 turns / 116 outcomes = 115 executed + 1 duplicate-rejected. Earlier copy-only repair: 231 display messages, idempotent, clean integrity/FK.
- The real `.siftkit/runtime.sqlite` was migrated 67→68 by an earlier inadvertent open; it will migrate to 69 on next legitimate open. No intentional production import/repair has been applied.

## Feedback verdicts to preserve

- JSON message handling already ingests memory via `ChatMessageTurn.respond()`; consolidation keeps one ingestion.
- `getRuntimeDatabasePath(runtimeRoot)` may append `.siftkit` to an already-resolved root; do not mechanically replace explicit joins.
- Internal queue rows vs public editable DTOs are distinct shapes.
- Stream chunk limits are UTF-16 code units; journal page limits and display snapshot page limits are different concerns.
- Strict tool replay accepts a completed result without a start when the result itself is positive evidence.

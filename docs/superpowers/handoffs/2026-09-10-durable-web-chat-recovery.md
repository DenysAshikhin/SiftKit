# Durable web chat recovery — handoff (session 3)

Date: 2026-09-10. Implementation, validation and documentation are **complete**; only the production repair/apply remains, and it is a separately authorized action that has **not** been performed.

Plan: [2026-09-10-durable-web-chat-recovery.md](../plans/2026-09-10-durable-web-chat-recovery.md) — every checkbox is reconciled against code; the two unchecked items are the production rollout/apply steps. Operational doc: [web-chat-recovery.md](../../web-chat-recovery.md).

Base checkpoint: `3b300bd9` (session-2 work, committed by the user). Everything below is uncommitted working-tree state. Do not commit unless asked. `docs/superpowers/plans/2026-09-10-exl3-pinned-arena-windows-and-prod-resync.md` is unrelated; leave it alone.

## Resume constraints

- No SiftKit, no worktrees, no commits without request. Comments 1–2 lines max. Preserve unrelated work.
- Never run tests against the real `.siftkit/runtime.sqlite` (`SIFTKIT_GUARD_RUNTIME_DATABASE`). Never restore an older copy over newer writes. Production repair needs separate authorization.
- Do not edit source while a full Node run is in progress (manifest-freshness checks).

## Completed this session

### Task 13 closure
- `tests/chat-recovery-performance.test.ts` runs green: 996 rows / 28 MB journal, one delta per narration event, 116 `tool_result` rows, paged/indexed reads, replay reproduces 116 full results, 3 snapshot pages. Corrected expectations: rebuild status is `ok` (all tools completed), context replay is `recovery_needed` with exactly the partial-narration notice, narration before a tool start projects as `assistant_progress`. Diagnostic: append ≈2 s, replay ≈1.8 s, RSS +≈0.5 GiB (documented limitation).
- New `tests/chat-recovery-storage-faults.test.ts`: `SQLITE_BUSY` (second connection holds `BEGIN IMMEDIATE`, busy timeout lowered on the test handle) and `SQLITE_FULL` (`PRAGMA max_page_count` on the temp DB). Both prove: the failing commit writes nothing, the published prefix is intact, the recorder's head does not drift, and the retried write lands at head+1. The "finish under pressure" assertion was dropped: `run_finished` is small enough to fit page headroom, so it is not deterministic.

### Review findings (13 raised; 11 fixed, 2 declined with rationale)
1. Repo-agent preset selection now goes through `ChatOperationPresetSelector` (`ChatPresetOperation` gained `'repo-agent'`); `selectRepoAgentPreset` deleted. A chat-preset session now records the built-in repo-agent limit (100) explicitly; `status-server-chat-repo-agent` test updated accordingly.
2. `imageMeta` flows through the reducer: `ChatSubmittedUserMessageSchema` and `ChatStreamQueuedUserMessageSchema` carry it, `reduceUserMessageEvent` sets it, the `queue_delivered` journal event holds it inside `message` (sibling field removed), task-loop emits it live, projection `.map` patches for user rows removed (tool-result patch stays — different event). Legacy archive paths pass `imageMeta: []`. `ChatDeliveredMessage` type in `queue-delivery.ts`.
3. `chat-tool-results.ts`: unused imports trimmed (lint was red), `readChatToolResults` removed; tests use `tests/helpers/chat-tool-results.ts`.
4. `maxTurns` / `webSearchOverride` are validated at admission (`ChatRunLimitsSchema`); invalid values → 400 (`ChatRequestRejection`). Repo-agent's duplicate `maxTurns` parse removed. Route test added.
5. `readChatHistoryRevisionCount` (counts `history_revised` events — counting `chat_runs` was off by one inside the revision transaction); used by the writer and `beginRun`, which now opens one database handle.
6. `admitChatImages(preset, images)` shared by admission and queue claim; `claimQueuedMessages(sessionId, input, modelPreset, forceId?)` takes the run's preset from the caller (`QueueDeliveryOptions.modelPreset`; `StartRepoAgentRunInput.queue = { owner, sessionId, modelPreset, forceId }`). The recorder no longer reads the session file inside the transaction.
8. `allowedTools` derives from `settings.webSearchEnabled`; `webToolsAllowed` removed from `runChatEngineTurn` (equivalent under `applyWebToolPolicy`).
9. `ChatTurnTelemetry` collapsed to `countChatInputTokens(tokenConfig, content)`.
10. Recorder `settings` is a readonly constructor field (`begin` from input, `resume` from the run row; a settings-less record cannot be resumed).
12. `chat-history-import.ts`: stray docblock moved, dead `typeof` guard and forwarding wrapper removed.
13. Successor `parsedBody` carries only mock/test fields; limits go through `value` alone.
- **Declined 7** (history-revision wake-up placement): the durable write lives in the state layer with no broadcast access; a callback hook is forbidden; the subscriber interface is the single wake channel.
- **Declined 11** (condense via selector): condense deliberately runs under the session's own preset; `webSearchEnabled: false` is a fact of condense, not a fallback.

### Task 11 incident revalidation (copy only)
Rebuilt `.scratch/web-chat-recovery/apply-incident-copy.mjs` (`npx esbuild … --bundle --format=esm --platform=node --target=node24 --packages=external`) and ran `node .scratch/web-chat-recovery/apply-incident-copy.mjs` with the production guard set. Fresh copy `incident-repair-validation-5b774eb3-….sqlite`: 231 messages (229 inserted + 2 saved), second apply `changed: false`, integrity/FK clean, native context `ok`, 0 delivered queue rows, `executedToolsDuringImport: 0`, `continuationReady: true`, terminal `approval_timeout`, payload SHA-256 `6d7ea62c…` matches. Regenerated `incident-repair-report.json`. Production `.siftkit/runtime.sqlite` mtime unchanged.

### Task 12 backup/restore audit
Pinned by a new test in `tests/assistant-backup-restore.test.ts`: the online snapshot carries every `chat_%` table with journal rows; an assistant restore leaves later chat runs untouched.

### Task 14
- `docs/web-chat-recovery.md` written (journal model, projections, refresh/Continue matrix, revisions/retention, backup, CLI repair, limitations incl. auto-approval provenance and replay memory).
- Plan checkboxes reconciled (95 checked; production steps open).

## Validation (this session, independent runs)

| Command | Result |
| --- | --- |
| `npm run build` | exit 0 |
| `npm run build:test` | exit 0 |
| `node dist/test-runner/run-tests.js chat- runtime-db-schema approval-gate status-server-chat` | 820 pass / 0 fail |
| broad set (`… image-retention operation-stream assistant-backup-restore dashboard-run-log-admin image-input-surfaces engine-tool-action-processor repo-agent`) | 1103 pass / 0 fail (`review-fixes-run2.log`) |
| `status-server-chat-crash-recovery chat-recovery-performance chat-recovery-storage-faults …` | 42 pass / 0 fail |
| `assistant-backup-restore` | 24 pass / 0 fail |
| `node dist/test-runner/run-tests.js --dashboard` | 519 pass / 1 fail — pre-existing `memory summary reports context, chunk size and KV cache mode` |
| `npm run typecheck` (includes lint) | exit 0 |
| `npm run lint` | exit 0 |
| `npm test` | 3874 pass / 2 fail: `chat route request normalizers return typed values` (stale expectation from session 2, fixed; file now 7/0) and `terminal metadata idle wait reports stuck queue state at its ceiling` (pre-existing at HEAD — regex predates the `direct=0` field from `8062cf9e`; unrelated, left alone) |
| `npm --prefix dashboard run build` | exit 0 |

## Gotchas learned

- `readAfter` honours the caller's limit; only `readAll` clamps to `CHAT_JOURNAL_READ_PAGE_SIZE`.
- A run interrupted after narration but before the assistant text reached planner history replays as `recovery_needed` with the partial-answer notice, even when every tool completed.
- `assert.throws` validator callbacks typed `unknown` trip the lint ban; use object matchers (`{ code: 'SQLITE_BUSY' }`).
- perl `s{}{}` edits break on unbalanced braces/backticks in TypeScript; use `#` delimiters or the Edit tool.
- Counting revisions from `chat_runs` inside `recordChatHistoryRevision` is off by one (the run row is begun before the event is appended).
- `StartRepoAgentRunInput.modelPreset` is optional; the queue linkage requires it, hence the grouped `queue` object.

## Private evidence to preserve (do not commit)

`.scratch/web-chat-recovery/`: `incident-copy.sqlite`, `incident-repair-validation-5b774eb3-890f-4083-a554-84997a7faf30.sqlite` (fresh, current importer), `incident-repair-report.json` (regenerated), `apply-incident-copy.ts/.mjs`, `incident-database-comparison.json`, `native-pairing-diagnostics.json`, `incident-shape.json`, `archive-context-shape.json`, `HANDOFF.md`, `incident-copy-apply-session3.log`, plus the small inspection scripts that produced the evidence (`inspect-*.ts/.mjs`, `compare-incident-databases.ts`, `prepare-incident-repair.*`, `validate-incident-migration.*`). All other scratch logs/scripts were deleted at closeout. Incident identity: request `706f2e52-01ec-4e62-9dc0-b7ced282e27e`, repo-agent session `074bbeb7-88aa-4412-8e38-94ad8bf1cf80`, chat `3e3b5cf7-39ce-438b-8d6c-1031056e471d`, artifact `9d5ca37a-45d6-4c61-bf28-6044e9da93da`.

## Remaining

Production repair only, under separate authorization: stop admissions, back up, migrate (67/68→69 on open), run the dry run with the exact incident arguments, apply with `--expected-digest` + new `--backup`, verify reads/attach/continuation.

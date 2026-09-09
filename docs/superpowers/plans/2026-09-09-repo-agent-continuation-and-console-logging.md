# Repo-agent continuation and console logging implementation plan

> **For agentic workers:** Use `superpowers:executing-plans` to execute the tasks sequentially. Follow the user's instruction not to use SiftKit. Do not commit or create a worktree. This document is a plan, not authorization to start implementation.

**Goal:** Preserve the complete model-visible tool evidence across web UI repo-agent stop/continue, and print each server command-start line exactly once.

**Architecture:** The durable run transcript is authoritative for repo-agent tool results. Persisted chat history contains a faithful projection of those results; the browser's preview is never a source for model history. The repo-agent session owns its server logs; chat stream writers forward presentation events without logging them again.

**Tech stack:** TypeScript, Zod, SQLite/better-sqlite3, the existing Node test runner, shared chat contracts, SSE.

**Spec:** The design and acceptance criteria below are the design specification for this plan.

**Review correction (implemented):** Historical repair is a one-time per-session migration, recorded in `runtime_metadata` as `repo-agent-history-v1:<sessionId> = complete`. Read the session after migration, preserve completed tool evidence on provider failures, and continue from the canonical chat snapshot without reloading archived runs. A full result missing from a migrated chat is an integrity error; the preview is never a substitute.

## Constraints and scope

- Plan and implement only the two confirmed application bugs. Do not change read numbering, read overlap behavior, model prompts, line counting, or tool execution scheduling.
- Preserve unrelated changes, user chat edits/deletions, compaction boundaries, approvals, image retention, and token accounting.
- No SiftKit invocations, worktrees, commits, new dependencies, background live-agent runs, or production database edits during tests.
- All implementation and test code is TypeScript. Validate database rows and transcript events with Zod; derive types rather than duplicating schemas. No `any`, assertions, non-null assertions, or unchecked JSON.
- Use the existing runtime schema and chat columns. This fix does not require a new database schema version or resetting the database.
- Use one scratch directory for validation artifacts and remove it at completion. The plan itself is permanent documentation.
- Every task starts with a failing regression test and ends with relevant passing tests. The primary agent reviews each diff and verifies the result independently.

## Evidence and current flow

Affected runs in `.siftkit/runtime.sqlite`:

- `6b83ac9e-a068-4746-80a8-d3132cf41f58`: original web UI repo-agent run.
- `1d1977b6-90e5-42b7-a9d8-0ae8608acfd1`: subsequent `continue`.
- The original handoff reads contain 18,366, 13,687, and 14,083 characters in `run_logs.repo_search_transcript_jsonl`. Each saved chat tool result contains only 203 characters.

Relevant paths:

1. `src/repo-search/engine/tool-action-processor.ts` creates a preview from `resultText.slice(0, 200)` for progress and records the fitted model-visible result in `turn_command_result.insertedResultText`/`output`.
2. `src/status-server/routes/chat.ts::toChatStreamToolEvent` forwards that preview to the chat transcript reducer.
3. `packages/contracts/src/chat-transcript-reducer.ts::reduceTool` currently assigns `outputSnippet` to both `toolCallOutputSnippet` and `toolCallOutput`.
4. `src/status-server/chat.ts::appendChatRepoAgentMessages` uses the live transcript projection when a run is aborted. Successful-run persistence uses scorecard-derived tool messages instead.
5. `src/status-server/chat.ts::appendReplayToolMessages` uses `toolCallOutput`, then falls back to the snippet.
6. `src/repo-search/execute.ts` durably persists a `repo_search_transcript` runtime artifact before returning/throwing, but schedules the `run_logs` projection separately. Reading only `run_logs` immediately after stop can race that projection.
7. `RepoAgentSession.handleProgressEvent` logs a start, then forwards it to `ChatStreamProgressWriter.write`, which logs the same start again.

The investigation reproduced two console lines from one start and one streamed event. Results generated no additional console line. This is not an execution duplication bug.

## Design decisions

### 1. Preserve the model-visible result, not unbounded raw stdout

The authoritative replay payload is the fitted result inserted into the model conversation, including legitimate truncation notices, rejection text, and empty results. It is not the browser preview, raw command stdout, or a reread of the current repository file.

Use `insertedResultText` for executed transcript outcomes. Validate the existing rejected-result shape separately: its `output` is the model-visible rejection outcome. Historical executed events that lack `insertedResultText` may be converted during the explicit repair task only after validating the historical event format; do not make missing fields silently fall back to previews.

Do not use truthiness to select output: an empty string is valid evidence. Preserve embedded newlines, Unicode, line numbers, and legitimate trailing `...` exactly.

### 2. Separate live presentation from durable history

The shared reducer continues to build a live presentation transcript from previews. Remove its claim that a preview is a full result: leave `toolCallOutput` absent for streamed preview-only tool rows.

Before the server persists a terminal repo-agent turn, hydrate completed tool rows from the durable run transcript. Retain their existing message IDs, ordering, reasoning, activity metadata, and approvals. Save the hydrated projection through the existing chat persistence path. The browser may still display `toolCallOutputSnippet`.

Validate/repair existing repo-agent tool rows once before their first continuation under the fixed writer, and mark successful migration durably. Load the session after that repair. This is a projection of retained chat rows, not a reconstruction of the whole chat: never resurrect deleted messages or replay rows already replaced by a compaction summary.

For repo-agent-backed completed tool rows, remove the snippet fallback from replay. A missing authoritative result is an explicit history-integrity error, not a normal 203-character result.

### 3. Identity and exact matching

Add the existing progress `toolCallId` to the corresponding accepted `turn_command_start` and `turn_command_result` transcript events and scorecard command records. Allocate an ID for rejected calls too, without emitting a false execution start. The stopped chat row already has the deterministic ID `stopped-${requestId}-tool-${toolCallId}`; centralize that construction in a shared helper and use exact equality, not suffix parsing. Use this identity for successful repo-agent persistence too, replacing its random tool-message IDs. Keep unrelated ordinary-chat message IDs unchanged.

Join by request/source-run ID and tool-call ID for new streamed repo-agent rows. Run IDs and session IDs are distinct and must not be substituted. Preserve effective commands: an adjusted read must remain associated with its returned range.

For historical rows whose transcript predates the ID field, the repair operation may match only a unique `(sourceRunId, turn, effective command)` result, with exit-code and preview-prefix validation. For rejected events use their requested command. If multiple outcomes could match, stop with an ambiguity error listing the run/message IDs; do not choose the first, deduplicate by command, or guess by timestamp.

Keep historical conversion isolated in the repair operation. Normal new-run hydration must require the new identity; do not retain a permanent dual matching algorithm for new writes. The repair operation runs before continuation for old rows and is idempotent. For a historical outcome without a progress ID, retain its chat message ID and validate its unique canonical match in the repair layer; do not rewrite original audit events to fabricate an ID. Existing successful full-result rows must validate without truncation or reordering.

### 4. Durable source and termination ordering

Add a focused repository function that retrieves exactly one run's transcript, not the dashboard's broad mixed-event detail loader.

- For terminal writes, read the durable runtime artifact of kind `repo_search_transcript` for the exact request ID. This is the immediate canonical source and avoids the deferred `run_logs` race.
- For archived runs with no runtime artifact, the retained `run_logs.repo_search_transcript_jsonl` is the archive source. This is an explicit storage lifecycle transition, not a preview fallback.
- Parse every selected outcome. Missing, malformed, conflicting, or ambiguous transcripts produce a typed error. Do not silently skip malformed result events.
- Await the session's engine settlement before terminal hydration, including an abort received while awaiting approval. Keep Stop responsive; persistence/continuation readiness must wait for settlement, not the user's initial Stop acknowledgement.
- If a tool started but has no result, keep it `stopped`; do not replay it as completed or automatically run it again.
- If an execution completed but output persistence failed, report an unavailable result. Never infer that a mutation did not happen.
- Do not clear a chat operation lease or announce continuation readiness before terminal history is durably saved. Do not poll indefinitely for `run_logs` to fill.

Read each source run once per terminal hydration or historical migration. Normal continuation reads the migrated chat snapshot and does not read old transcripts. Do not load the entire run-log corpus or hold a SQLite transaction while awaiting an engine or network operation.

### 5. Existing chats, deletion, and missing evidence

The repair task must cover both investigated runs. Write changes only to retained affected tool rows, transactionally per chat turn/run. Preserve all unrelated columns and messages. Produce counts and run/message IDs, never full tool payloads, in its report.

Dry-run is the default for a repair command. Applying repairs to the user's real database is a separate, explicit execution step after reviewing the dry-run report; no repairs occur while writing or testing this plan.

Unmigrated historical evidence needs a canonical source for repair. If those sources are missing or ambiguous, keep the chat readable and block migration without marking it complete. After successful migration, the full chat snapshot is authoritative: archive cleanup does not block continuation. Explicit repair `--apply` records the same migration marker. Dry-run and unsuccessful repairs never establish trust. New terminal writes must preserve full outputs, including after provider failure; migrated rows with missing full output fail explicitly before engine dispatch.

Do not use `length === 203`, an ellipsis, or equality with a snippet alone as proof of truncation. Short results and outputs ending in ellipses can be valid. Validate against the transcript during repair; then normal persistence/replay uses the complete output field with no preview substitution.

### 6. One owner for console logging

Make `ChatStreamProgressWriter` presentation-only. Remove its call to `serverLogger.emitBody`; it should not decide whether its caller already logged an event.

- `RepoAgentSession` remains the logger for repo-agent starts, warnings, and automatic approvals, whether attached, detached, or reattached.
- Standalone chat repo-search/plan streaming routes compose the existing `RepoSearchToolLogProgressWriter` with the presentation writer at their operation boundary. Move that logger into `src/status-server/operation-progress-writers.ts` and export it so there is one implementation.
- Migrate every constructor/call site. Do not add a boolean `suppressDuplicateLogs`, a command-text dedupe cache, or a second guarded logger inside the chat writer.
- Retain current log-level filtering. A real repeated command with a different invocation must still print once per invocation.

## Alternatives considered

1. **Send full outputs through every browser SSE frame.** Smaller local change, but makes UI transport the source of durable history and increases broadcast payloads. Does not repair existing sessions or solve stop/persist races. Rejected.
2. **Always reconstruct the entire chat from run logs.** Preserves tool results, but can resurrect deleted/compacted messages and distort conversation ordering. Rejected.
3. **Hydrate the retained chat projection from canonical run results at terminal persistence and repair boundaries.** Preserves current UI behavior, supports existing chats, and gives continuation a durable full-result snapshot. Selected.

## Task 1: Canonical transcript outcome reader and identity

**Files**

- Create `src/status-server/repo-agent-tool-results.ts`.
- Modify `src/repo-search/engine/tool-action-processor.ts`, `src/repo-search/prompts.ts::TaskCommandSchema`, `src/status-server/repo-search-scorecard-types.ts`, and the existing event schemas in `src/repo-search/live-snapshot/schemas.ts`.
- Modify `packages/contracts/src/chat-transcript-reducer.ts`; export the deterministic tool-message ID helper through the existing contracts entrypoint.
- Create `tests/repo-agent-tool-results.test.ts`; extend `tests/engine-tool-action-processor.test.ts`.

**Interfaces**

- `readRepoAgentToolResults(database, requestId)` reads and validates one run's canonical model-visible outcomes. Its result type is derived from the outcome schemas and includes identity, turn, effective/requested command, exit code, and full model-visible output.
- `buildChatToolMessageId(messageIdPrefix, toolCallId)` owns the existing message-ID construction; no ID format change.
- Reader failures distinguish unavailable transcript, malformed outcome, duplicate identity, and conflicting source artifacts. Include identifiers, not output contents.

- [ ] Add failing tests for exact full output after character 200; empty output; Unicode/blank lines; legitimate tool truncation; adjusted read command; two calls in one turn; identical command text under different IDs; rejected result; start without result.
- [ ] Add a fixture with a durable runtime artifact and an empty `run_logs` transcript. Assert the full result is available immediately. Add an archived-only fixture and conflicting-artifact failure.
- [ ] Assert actual engine start/result events share the existing progress ID. No second execution or extra start is permitted.
- [ ] Implement strict parsing and the focused source query. Select only the required run; never select recent runs by timestamp.
- [ ] Carry the identity through start/result logging, rejected outcomes, and scorecard normalization; centralize chat message ID construction. Preserve event ordering and effective command updates. Accepted calls must not receive a second ID during result fitting. Rejected calls have identities but no fabricated execution start.
- [ ] Run `npm run build:test`, then `npm test -- repo-agent-tool-results engine-tool-action-processor chat-transcript-reducer`.

Core assertion shape:

```ts
assert.equal(outcome.output, expectedModelVisibleText);
assert.equal(outcome.output.includes('sentinel-after-character-200'), true);
assert.equal(start.toolCallId, result.toolCallId);
assert.notEqual(firstResult.toolCallId, secondResult.toolCallId);
```

**Acceptance:** canonical results are read without a finished scorecard or a populated `run_logs` projection; identity prevents cross-call attachment.

## Task 2: Full terminal persistence and strict continuation

**Files**

- Modify `src/status-server/repo-agent-tool-results.ts`, `src/status-server/routes/chat-repo-agent.ts`, and `src/status-server/chat.ts`.
- Modify `packages/contracts/src/chat-transcript-reducer.ts` and `packages/contracts/src/chat.ts` only where needed to distinguish a live preview from a persisted completed result.
- Modify `src/status-server/repo-agent-sessions.ts` only for settlement/continuation readiness ordering proven necessary by tests.
- Extend `tests/status-server-chat-repo-agent.test.ts`, `tests/status-server-chat-stop.test.ts`, `tests/chat-transcript-reducer.test.ts`, `tests/chat-sessions-db.test.ts`, and `tests/helpers/stopped-chat-engine-service.ts`.

**Interfaces**

- `hydrateRepoAgentToolMessages(messages, canonicalResults)` returns a validated projection with the original message IDs/order and complete outputs. New-run hydration uses exact call identity.
- Terminal repo-agent persistence receives hydrated messages. `buildChatHistoryMessages` continues consuming canonical persisted chat rows; it does not read browser state.
- A completed persisted repo-agent result must have a full output string, including `''`. A live preview need not. Stopped tool rows remain excluded from completed tool replay.

- [ ] Add an HTTP/SSE regression: read a document with a unique sentinel beyond character 200, stop during the next model call, wait for terminal persistence, restart the test server, send `continue`, and capture the actual next engine request's tool history.
- [ ] Assert the persisted row and replayed tool message contain the exact full result. Assert the UI snippet stays short and the tool appears once.
- [ ] Cover completed, failed, aborted, and approval-timeout terminal states; stop during a tool; stop during approval; an empty successful result; a rejected call; multiple tools per turn.
- [ ] Pause the mock engine after abort acknowledgement. Assert a new continuation cannot start while canonical persistence is unfinished; release it and assert eventual completion without polling the run-log projection.
- [ ] Remove `outputSnippet -> toolCallOutput` from the live reducer. Hydrate before terminal persistence and remove snippet fallback from completed repo-agent replay and its persistence constructors.
- [ ] Preserve exact output strings; do not trim, refit, or retokenize historical tool payloads as part of hydration. Retain existing token counters and normal prompt-budget/compaction processing.
- [ ] Check successful scorecard persistence against the same model-visible-output contract; remove any preview substitution there. Keep non-repo-agent chat behavior covered by its existing tests.
- [ ] Run `npm run build:test`, then `npm test -- status-server-chat-repo-agent status-server-chat-stop chat-transcript-reducer chat-sessions-db chat-persist-token-parity`.

Core regression assertions:

```ts
assert.equal(savedTool.toolCallOutput, originalToolResult);
assert.equal(replayedTool.content, originalToolResult);
assert.equal(replayedTool.content.includes('sentinel-after-character-200'), true);
assert.equal(savedTool.toolCallOutputSnippet.length <= 203, true);
assert.equal(replayedCompletedCalls.length, completedExecutionCount);
```

**Acceptance:** stop/restart/continue preserves full evidence and cannot mistake an unfinished tool for a completed one. No browser preview is replayed as a full result.

## Task 3: Repair existing affected history

**Files**

- Create `src/status-server/repo-agent-history-repair.ts` and `scripts/analysis/repair-repo-agent-history.ts`.
- Integrate the repair boundary with `src/status-server/routes/chat-repo-agent.ts` before starting an engine request for affected historical rows.
- Create `tests/repo-agent-history-repair.test.ts`; extend `tests/status-server-chat-repo-agent.test.ts`.
- Add operating instructions to this plan when the repair command's final interface is implemented.

**Interfaces**

- `repairRepoAgentHistory(database, sessionId, mode)` supports `dry-run` and `apply`; mode is parsed from a runtime schema.
- Return a schema-derived report containing matched, changed, unchanged, unavailable, and ambiguous counts plus affected run/message IDs. No tool payloads in the report.
- Normal continuation must not run while unresolved completed results remain. Repair uses the same canonical reader as Task 1; no second transcript parser.

- [ ] Seed a fixture equivalent to the reported bug: three 203-character chat outputs and the three complete transcript outcomes. Assert dry-run reports three recoverable rows without writing; apply restores exact outputs.
- [ ] Validate historical matches by unique run/turn/effective-command, exit code, and prefix. Reject ambiguous repeated commands and mismatched previews. New calls use the ID path from Task 1.
- [ ] Cover genuine short output, exactly 203 characters, empty output, a legitimate trailing ellipsis, missing logs, malformed logs, two source runs in one chat, and an unrelated ordinary chat tool row.
- [ ] Apply updates transactionally only after validating every selected row. On failure leave that repair unit unchanged. Preserve IDs, order, reasoning, usage, user edits, approvals, images, deleted rows, and compaction markers.
- [ ] Assert a second apply is a no-op. Assert migrated history survives removal of all canonical archives and server restart. Assert unmigrated history without a source fails explicitly and can retry migration when evidence is restored. Do not infer provenance from output length.
- [ ] Before real-data execution, run the dry-run report for `6b83ac9e-a068-4746-80a8-d3132cf41f58` and `1d1977b6-90e5-42b7-a9d8-0ae8608acfd1` through their owning session. Review it before any apply action. Do not hardcode these IDs in production logic or tests.
- [ ] Run `npm run build:test`, then `npm test -- repo-agent-history-repair status-server-chat-repo-agent chat-sessions-db`.

**Acceptance:** existing recoverable chats regain their full evidence without recreating deleted history; unrecoverable evidence fails explicitly. Historical conversion is isolated from new-run hydration.

### Operating the repair command

`scripts/analysis/repair-repo-agent-history.ts` repairs one chat session and prints a JSON report of counts plus per-row run/message IDs. It writes nothing unless `--apply` is passed.

```powershell
npx tsx scripts/analysis/repair-repo-agent-history.ts --session <chat session id>
npx tsx scripts/analysis/repair-repo-agent-history.ts --session <chat session id> --apply
```

`--runtime-root <path>` targets a database other than `./.siftkit`. Read the dry-run report first: `changed` counts rows whose stored output differs from the canonical outcome, `unchanged` counts rows already whole, and `unavailable`/`ambiguous` name rows the repair refuses to touch. A run with any unresolved row is left entirely unchanged, and `--apply` is idempotent.

The same repair runs automatically at the repo-agent continuation boundary. A session that still has `unavailable` or `ambiguous` rows there is refused with `409` naming the affected runs; the chat itself stays readable.

## Task 4: Remove duplicate console ownership

**Files**

- Modify `src/status-server/routes/chat.ts`, `src/status-server/routes/chat-repo-agent.ts`, and `src/status-server/operation-progress-writers.ts`.
- Review `src/status-server/repo-agent-sessions.ts` and `src/status-server/routes/repo-search.ts` for ownership consistency.
- Extend `tests/status-server-chat-repo-agent.test.ts`, `tests/repo-agent-sessions.test.ts`, `tests/repo-search-status-server.test.ts`, and `tests/status-server-chat-routes.test.ts`.

- [ ] Add the exact regression through the real session/subscriber composition: one start currently emits two identical `serverLogger.emitBody` calls. Verify that failure before changing ownership.
- [ ] Assert one start -> one console command line; one result -> no extra command line; one automatic approval -> one approval line; one start/result pair -> one pair of streamed events.
- [ ] Assert two invocations with identical command text -> two command lines, not one. Also cover distinct calls in the same turn, detached session, reattachment, and two browser subscribers.
- [ ] Remove all server logging from `ChatStreamProgressWriter`. Move/export the existing standalone logger to `operation-progress-writers.ts` and compose it explicitly in standalone streaming repo-search/plan routes. The repo-agent route attaches the presentation writer only.
- [ ] Update every caller and remove the old route-local logger declaration. Preserve warning/approval visibility and normal/debug/quiet filtering.
- [ ] Run `npm run build:test`, then `npm test -- repo-agent-sessions status-server-chat-repo-agent repo-search-status-server status-server-chat-routes`.

Core assertions:

```ts
assert.equal(commandLogCalls.length, 1);
assert.equal(streamStarts.length, 1);
assert.equal(streamResults.length, 1);
assert.equal(approvalLogCalls.length, 1);
```

**Acceptance:** log cardinality follows actual invocations, independent of subscriber count; standalone operations remain visible.

## Task 5: Integrated verification and closeout

**Files:** tests touched above; this plan's execution checklist. No unrelated refactors.

- [ ] Run the integrated stop/restart/continue scenario with both fixes: one command line, one execution, one persisted full output, and exact replay on continuation.
- [ ] Verify compaction uses the repaired full history under existing token-budget rules. Do not bypass context limits merely to retain tool output; a normal compaction summary is different from accidental UI truncation.
- [ ] Verify ordinary chat, web UI repo-search, CLI repo-agent, approvals, failed tools, stopped tools, multiple calls per turn, and attach/reconnect behavior using the applicable existing suites.
- [ ] Run the required checks sequentially:

```powershell
npm run build:test
npm test -- repo-agent-tool-results repo-agent-history-repair status-server-chat-repo-agent status-server-chat-stop chat-transcript-reducer chat-sessions-db chat-persist-token-parity repo-agent-sessions repo-search-status-server status-server-chat-routes
npm test
npm run typecheck
npm run lint
```

- [ ] Capture high-volume validation output in the single scratch directory, inspect failures and final summaries directly, and report nonzero exits/timeouts as failures. Do not pipe into SiftKit.
- [ ] Rebuild production output with `npm run build` before a manual web UI smoke check. Do not restart an active server or interrupt an unrelated run without checking its state.
- [ ] Run the manual smoke against an isolated test database/repository with a document exceeding 200 characters. Stop after the result, continue, and verify the captured engine request contains the sentinel. Confirm one console line per invocation.
- [ ] Independently inspect the final diff for remaining preview-to-full assignments in durable repo-agent paths, fallback replay, duplicate logger ownership, unsafe repair matching, and unrelated changes.
- [ ] Remove scratch artifacts. Do not commit. Report changed files, tests/checks, repair dry-run results, whether real history repair was applied, and any unavailable historical evidence.

## Final acceptance checklist

- [ ] Full model-visible tool results survive completion, failure, Stop, server restart, and Continue.
- [ ] The UI preview is never substituted for authoritative completed-tool evidence.
- [ ] Empty output and legitimate output truncation remain exact.
- [ ] Effective read calls still match returned ranges; read behavior is unchanged.
- [ ] A stopped tool without a result is not replayed as completed or automatically rerun.
- [ ] Existing affected rows can be repaired safely from retained transcripts; missing or ambiguous evidence is explicit.
- [ ] Deleted and compacted history stays deleted/compacted.
- [ ] Each actual tool start prints once, with no suppression of real repeated calls.
- [ ] Standalone streaming operations, warnings, and approval logs remain visible.
- [ ] Relevant tests, broader suite, typecheck, lint, production build, and isolated smoke pass, or failures are explicitly reported.

## Risks and review points

- Restoring full history increases continuation prompt size to what the agent actually read; existing compaction must handle this, not a new preview cap.
- Stop acknowledgement and engine settlement are different moments. Canonical persistence must not depend on deferred dashboard projection timing.
- Historical events lack modern call identity. Unique validated matches are repairable; ambiguous matches must not be guessed.
- Migration requires canonical evidence only once. Missing sources block unrepaired historical rows; repaired snapshots remain independent of log retention. Do not remove the migration marker during ordinary archive cleanup.
- The runtime database deliberately rejects schema-version mismatches. Avoid a schema bump for this fix; use the existing message IDs and output columns.
- A terminal persistence error must remain visible and prevent a misleading successful continuation, while keeping the user's chat readable.

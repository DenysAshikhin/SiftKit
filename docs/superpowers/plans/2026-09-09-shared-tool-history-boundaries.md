# Shared tool-history boundaries implementation plan

> **For execution:** Use `superpowers:executing-plans` and complete the tasks sequentially. Do not use SiftKit, create worktrees, or commit. Implementation is now requested; production-history repair still requires a separate instruction.

**Goal:** Finish the shared full-result persistence refactor, restrict historical repo-agent repair to its actual scope, and prevent modern identity failures from entering historical matching.

**Architecture:** Live tool cards retain previews. Shared terminal persistence hydrates newly completed tool rows from canonical run results, and shared replay accepts only full results. Historical repair is a separate, one-time conversion with explicit operation provenance and transcript-format classification.

**Tech stack:** Existing TypeScript, Zod, SQLite, shared chat contracts, Node tests, and HTTP/SSE test harnesses. No new dependencies.

**Spec:** The design decisions and acceptance matrix in this document are the specification. This plan supersedes the corresponding persistence/matching sections of `2026-09-09-repo-agent-continuation-and-console-logging.md`; its completed logging and collapsed-DOM behavior remain unchanged.

**Queued steering follow-on:** See `2026-09-09-chat-message-queue.md` for a bottom-of-chat FIFO queue, delivery after the next safe tool-result boundary, and **Force now**. Force depends on this plan's shared full-context persistence and the existing Stop/settlement fixes; it must never send a replacement request from UI previews or before the old run is durably saved.

## Implementation status

Tasks 1–3 and the available verification work are implemented. Tasks 5–6 produced the evidence recorded below, with no speculative task-loss or carriage-return normalization patch. The queue companion and the [saved 13-finding review](2026-09-09-chat-queue-session-drift.md) include the subsequent lifecycle, recovery, and UI fixes.

Task 7 is **partial**. Closed Internal Logic, compacted history, and Thinking contents now unmount. Replay enforces its actual UTF-8 byte ceiling, including a single oversized frame and zero-capacity queue channels. A repeated React/jsdom workload mounted **100 nodes** at 100, 500, and 1,000 live turns while collapsed, versus 2,799/13,599/27,099 before. Expand/collapse and session-switch checks still work; tool output remains lazy. Measured render/update times were 40/9, 14/9, and 18/15 ms, respectively, in that Node workload.

These DOM measurements do not establish a renderer-memory plateau: the runtime still retains the full live transcript. Browser discovery returned no connected browser, including a final retry. Renderer heap/retainer profiling, a bounded live window backed by on-demand durable retrieval, historical pagination, and a verified browser-memory budget remain outstanding. Do not call this an OOM fix or mark the entire plan complete. No production repair was executed.

## Scope and constraints

- Address the three findings from the reflection of commit `2f893e58`.
- No new service, strategy registry, callback framework, database reset, or general migration framework.
- Preserve full model-visible text, including empty strings, Unicode, line numbers, and intentional context-limit truncation. Do not substitute raw stdout or reread repository files.
- Preserve existing tool invocation identity, chat message order, edits/deletions, compaction, approvals, images, reasoning retention, and measured usage.
- Keep historical repair one-time. Do not restore per-request archive validation after a session is migrated.
- Do not change UI transport, lazy DOM mounting, read-window behavior, or console logging.
- All code/tests are TypeScript. Parse IO with runtime schemas and derive types; no assertions, `any`, namespace imports, or dynamic callbacks outside API requirements.
- Remove replaced files, symbols, and compatibility re-exports. Historical conversion is allowed only in the explicit historical repair path.
- Keep test artifacts and any local npm cache in one scratch directory; remove them at completion. Never apply a repair to the user's database during tests.

## Current gaps

1. `ChatStreamProgressWriter` now produces preview-only tool rows, but `finishStoppedChatStream` still passes them directly to `appendChatStoppedTurn` for ordinary chat, plan, and repo-search. Only repo-agent performs canonical hydration. Shared replay and the appended-turn builder still contain preview fallbacks.
2. `readRepairableToolRows` selects every completed tool with a non-null `source_run_id`. Ordinary chat and repo-search also set that field. A source-run reference is not proof of repo-agent origin.
3. `findOutcomeForRow` tries historical command matching whenever exact identity lookup fails. It does not establish that the source transcript predates identities. The current historical fixture even supplies a modern `toolCallId`.

## Design decisions

### A. One shared durable-result contract

Keep live presentation rows distinct from completed evidence without making old sessions unreadable:

- A live row may have only `toolCallOutputSnippet`.
- A newly persisted completed row must have `toolCallOutput: string`; `''` is valid.
- A stopped call without an outcome remains stopped and is excluded from completed-tool replay.
- Historical rows may still be loaded for display and explicit repair. Do not enforce the new result requirement on the general session-read schema, which would make repair impossible.
- Enforce the requirement when authoring a new durable turn and when selecting completed tool rows for model replay. Remove the preview fallback at those boundaries.

Rename `src/status-server/repo-agent-tool-results.ts` to `src/status-server/chat-tool-results.ts` and its exported reader/hydration/error symbols to operation-neutral names. Update all consumers and tests; leave no old re-export file. This is the existing reader serving its actual callers, not another parallel implementation.

The shared stopped-turn persistence entrypoint will receive the exact engine `requestId` and hydrate the incoming turn before saving it. It must not inspect or reconstruct the session's earlier messages. Repo-agent aborted turns use this same entrypoint; repo-agent failure persistence uses the same hydration function before combining partial evidence with its terminal answer. Remove the earlier route-level hydration to avoid reading a transcript twice.

Successful paths may continue using their already complete scorecard projection, but their common builder must validate full output and must not substitute a snippet. Keep the existing provider-failure, usage-estimation, and reasoning-retention fixes.

### B. Format is established before matching

Use one schema-derived transcript classification:

```ts
z.enum(['identified-v1', 'historical-unidentified'])
```

New `run_start` events include `toolResultFormat: 'identified-v1'` and the normalized `operationType` already known to the engine. Reuse `RunOperationTypeSchema` for the latter. This is an event-format discriminator, not a database schema migration.

Handle existing transcripts deliberately:

| Transcript evidence | Classification/action |
|---|---|
| Explicit `identified-v1` marker | Require valid IDs on relevant starts/results. |
| No marker, but any relevant event has an ID field | Identified format; require valid IDs consistently. |
| No marker and all relevant events omit the ID field | Historical unidentified format. |
| Unknown marker, explicit null/empty ID, duplicate ID, or mixed identified/unidentified outcomes | Integrity error; never historical fallback. |

Do not infer the format from timestamps, preview length, or chat message ID spelling. Parse historical events only in the historical conversion path; normal terminal hydration requires identified outcomes.

For identified transcripts, match by exact source request and call identity. Validate turn, effective command, and exit code as consistency checks. A failed identity match stays unmatched even if another outcome has the same command and preview.

For historical unidentified transcripts only, allow a unique run/turn/effective-command match validated by exit code and preview prefix. Ambiguous matches remain blocked. Do not fabricate IDs in old audit events.

### C. Automatic migration requires positive repo-agent provenance

Determine origin before loading a tool transcript for repair:

- Use the retained run identity keyed by the exact engine request ID, parsing `run_logs.operation_type` with the existing operation schema.
- When retained run metadata is absent but a transcript artifact remains, its new `run_start.operationType` can establish origin. Avoid repeatedly parsing it: share that parsed source with outcome reading for the same repair operation.
- Conflicting provenance is an integrity error for that source, not permission to choose one value.
- Known `repo-agent`: eligible for automatic historical repair.
- Known other operation: excluded. Never require its archived tool outputs merely because the user selects repo-agent next.
- Unknown origin: excluded from automatic rewriting and reported as unclassified. Do not label it verified or infer repo-agent from `source_run_id`, session mode, or a `stopped-` prefix.

The migration marker means that eligible repo-agent history has been converted, not that every message from every operation was reverified. Retain existing successful markers; do not force migrated chats to reload old logs. An incomplete row of any origin still fails the shared replay contract if its full output is absent. Historical data with a string-valued preview masquerading as full output cannot be safely diagnosed from string length alone; report that recovery limitation rather than expanding automatic repair to all operations.

Extend the dry-run report with explicit excluded-other-operation and unclassified-origin counts/identifiers. Neither category is silently rewritten. Keep blocked eligible rows distinct from excluded rows, and do not mark migration complete when eligible rows are unresolved.

## Task 1: Make transcript format and provenance explicit

**Files**

- Modify `src/repo-search/engine.ts` and `src/repo-search/live-snapshot/schemas.ts`.
- Move `src/status-server/repo-agent-tool-results.ts` to `src/status-server/chat-tool-results.ts`.
- Move `tests/repo-agent-tool-results.test.ts` to `tests/chat-tool-results.test.ts`.
- Update imports in `src/status-server/repo-agent-history-repair.ts`, `src/status-server/routes/chat-repo-agent.ts`, and existing reader tests.
- Extend `tests/engine-tool-action-processor.test.ts` and `tests/live-run-snapshot-collector.test.ts` for event identity consistency.

**Interfaces after replacement**

- `readChatToolResults(database, requestId)` returns the existing canonical outcome collection plus the schema-derived format and available operation provenance.
- `hydrateChatToolMessages(messages, results)` requires identified outcomes for new writes.
- `hydrateTerminalChatMessages(database, requestId, messages)` reads a source only if the incoming turn contains completed tools.
- `ChatToolResultsError` retains identifier-only diagnostics; never include tool contents in an error report.

- [ ] Add failing tests for explicit modern format, pre-marker identified format, truly historical omitted IDs, mixed IDs, empty/null IDs, duplicate IDs, and an unsupported marker.
- [ ] Add a modern wrong-ID fixture whose command, turn, exit code, and preview otherwise match. It must remain unmatched.
- [ ] Correct historical fixtures to omit IDs in their source events. Keep separate tests for pre-marker modern events with valid IDs.
- [ ] Implement the classification table and emit the new header fields. Preserve the durable-artifact-before-deferred-archive source selection.
- [ ] Complete the neutral rename and update all references, error labels, and test imports. Do not keep the old optional-identity parser on the modern path.
- [ ] Run the focused tests and inspect the diff for retained legacy fallback.

Core assertions:

```ts
assert.equal(results.format, 'identified-v1');
assert.throws(() => hydrateChatToolMessages(wrongIdentityRows, results));
assert.equal(historicalResults.format, 'historical-unidentified');
assert.equal(results.outcomes[0]?.output, exactModelVisibleOutput);
```

**Acceptance:** malformed modern identity cannot be reinterpreted as historical data; existing valid transcripts remain readable under their correct format.

## Task 2: Restrict and simplify historical repair

**Files**

- Modify `src/status-server/repo-agent-history-repair.ts`.
- Update `scripts/analysis/repair-repo-agent-history.ts` report handling if required.
- Extend `tests/repo-agent-history-repair.test.ts` and `tests/status-server-chat-repo-agent.test.ts`.

**Report contract:** Extend `RepoAgentHistoryRepairReportSchema` with nonnegative integer row counts `excludedOtherOperation` and `unclassifiedOrigin`, and matching per-row statuses `excluded_other_operation` and `unclassified_origin`. Existing `matched`, `changed`, `unchanged`, `unavailable`, and `ambiguous` counts apply only to eligible repo-agent rows. A marker confirms completion only for that eligible scope; excluded rows are not reported as matched or verified.

- [ ] Seed one session containing positively identified repo-agent, ordinary chat, and repo-search runs. Give every tool row a non-null source-run ID.
- [ ] Remove archives for the known non-repo-agent runs. Assert migration repairs only repo-agent rows and neither rewrites nor blocks the others.
- [ ] Add unknown-origin and conflicting-origin fixtures. Unknown origin is reported/excluded; conflicting metadata is reported explicitly, never guessed.
- [ ] Refactor selection to classify source runs before selecting eligible repair work. Load each selected transcript at most once per operation.
- [ ] Dispatch matching from `results.format`. Delete the unconditional `findHistoricalMatch` fallback after an exact identity miss.
- [ ] Preserve transactional eligible-run updates, idempotent apply, dry-run behavior, and the existing one-time marker. No recurring archive scan after successful migration.
- [ ] Add a route regression proving a mixed session can switch to repo-agent after unrelated run-log cleanup, while unresolved eligible repo-agent history remains blocked.
- [ ] Run focused repair and route tests.

Core assertions:

```ts
assert.equal(report.changed, affectedRepoAgentRows);
assert.equal(report.excludedOtherOperation, 2);
assert.equal(report.unclassifiedOrigin, 1);
assert.equal(storedOrdinaryOutput, originalOrdinaryOutput);
assert.equal(modernWrongIdentityReport.changed, 0);
assert.equal(modernWrongIdentityReport.unavailable, 1);
```

**Acceptance:** migration eligibility and historical-format matching are independent explicit decisions; a source-run pointer alone satisfies neither.

## Task 3: Finish the shared persistence/replay replacement

**Files**

- Modify `src/status-server/chat.ts` and `src/status-server/chat-tool-results.ts`.
- Modify `src/status-server/routes/chat.ts` and `src/status-server/routes/chat-repo-agent.ts`.
- Review `src/status-server/chat-repo-operation-runner.ts` successful persistence against the shared contract.
- Extend `tests/status-server-chat-stop.test.ts`, `tests/status-server-chat.test.ts`, `tests/status-server-chat-repo-agent.test.ts`, `tests/chat-sessions-db.test.ts`, and `tests/chat-repo-operation-runner.test.ts`.
- Update `tests/helpers/stopped-chat-engine-service.ts` to persist realistic canonical evidence for completed mock tools.

**Interfaces**

- Add the exact engine `requestId` to the shared stopped-turn input. Thread it from ordinary chat, plan, repo-search, and repo-agent callers.
- `appendChatStoppedTurn` performs canonical hydration of the incoming turn before calling the pure stopped-turn builder and saving it.
- The pure stopped-turn builder and appended-turn builder validate every newly authored completed tool result as a string. Reuse one small schema-backed result validator.
- `resolveReplayToolOutput` uses that same contract and throws an identifier-only missing-result error. Remove both snippet substitution and output trimming.

- [ ] Add HTTP/SSE regressions for ordinary chat, plan, and repo-search: read a document with a sentinel beyond 200 characters, stop after its result, restart, and capture the next engine request. Assert the sentinel and exact full result survive.
- [ ] Add direct writer/replay tests: preview-only completed rows fail; empty full output succeeds; stopped rows are not replayed; compacted/deleted rows remain excluded.
- [ ] Move hydration into the shared stopped-turn persistence entrypoint. Remove repo-agent route-level hydration and retain one hydration for its failed-run partial evidence path.
- [ ] Validate successful scorecard-derived tool outputs in the common appended-turn builder. Remove its `toolCallOutputSnippet` and empty-string fallbacks for missing full output.
- [ ] Remove the repo-agent-only full-output guard once shared replay enforces the same invariant. Route error handling should translate the shared error into an actionable response before engine dispatch, not duplicate validation logic.
- [ ] Keep session loading available for viewing incomplete historical records. Do not make a global schema change that prevents users from opening or repairing such sessions.
- [ ] Preserve engine settlement before hydration, final-answer estimates, reasoning retention, approvals, and stopped-call semantics. Failure to hydrate must not claim successful persistence or rerun a command.
- [ ] Run shared persistence, stopped-stream, replay, migration, and usage tests.

Core assertions:

```ts
assert.equal(savedCompletedTool.toolCallOutput, exactModelVisibleOutput);
assert.equal(nextRequestToolMessage.content, exactModelVisibleOutput);
assert.equal(nextRequestToolMessage.content.includes('sentinel-after-character-200'), true);
assert.throws(() => buildChatHistoryMessages(config, previewOnlySession));
assert.equal(emptyOutputReplay.content, '');
```

**Acceptance:** no route can author or replay a preview as a complete result; ordinary stopped chat no longer relies on the repo-agent route to protect it.

Continuation status: Tasks 1–3 and their review fixes passed 267 focused tests, the test TypeScript project, and lint on changed files. An independent run of 187 reader/repair/engine/snapshot/stop/replay tests also passed. A new exact-ID `turn_command_result_finalized` event preserves post-batch budget notices without overwriting the per-call evidence needed when a later tool is cancelled. Full validation remains under Task 4.

## Task 4: Verification and closeout

- [ ] Run the new regressions red before their respective implementation tasks, then green after each change. Do not weaken existing valid assertions to accommodate missing evidence.
- [ ] Run final validation with output captured in one scratch directory:

```powershell
npm run build:test
npm test -- chat-tool-results repo-agent-history-repair status-server-chat-stop status-server-chat-repo-agent status-server-chat.test.ts chat-sessions-db chat-repo-operation-runner chat-persist-token-parity
npm test
npm test -- --dashboard
npm run typecheck
npm run lint
npm run build
```

- [ ] Verify the HTTP/SSE tests exercise all shared stopped-stream routes, modern identity rejection, a real historical format, and mixed-operation history with missing unrelated archives.
- [ ] Confirm the existing command-log cardinality and collapsed-tool DOM tests still pass. Do not add UI/network features.
- [ ] Search source for obsolete `RepoAgentToolResults*` reader symbols, unconditional historical fallback, and preview-to-full assignment in authoring/replay paths. Presentation preview selection is permitted.
- [ ] Review migration reports for identifiers/counts only; prove dry-run makes no writes and blocked eligible groups receive no completion marker.
- [ ] Update the earlier plan's obsolete route-specific hydration and matching descriptions. Remove scratch artifacts; do not commit or repair real databases without a separate instruction.
- [ ] Report changed files, verified scenarios, test/check results, and unrecoverable historical evidence.

Known baseline: the previous dashboard run passed 469 tests and failed the unrelated `model-preset-groups` memory-summary expectation. Recheck it; do not silently attribute it to this work or alter it as part of these fixes.

## Additional incident investigations: carriage returns and apparent task loss

These are investigation tasks, not confirmed implementation defects. Do not add a speculative fix to Tasks 1–3 or interrupt the active run to obtain logs.

**Observed run:** `fcf9b633-6246-4473-a400-1409b90ddc48`, web UI repo-agent against `C:\Users\denys\Documents\GitHub\brawlhalla`. The admitted task is `Fast Brawlhalla-Like Simulator — Environment Implementation Handoff.md -> implement this. Keep it all python/C++`. The run was active during inspection; its full terminal transcript was not yet available.

### Task 5: Establish why the agent keeps worrying about `\r`

**Confirmed observations**

- Live snapshot turn 43 records three successful config edits. Turn 44 runs a Python `Path.read_text()` carriage-return check. Turn 45 records three successful state edits.
- Raw-byte inspection at that time found zero CR, CRLF, standalone CR, or literal backslash-r sequences in config, state, physics, and events. This describes those snapshots, not every earlier file version.
- Python text-mode newline normalization makes `read_text().count(chr(13))` an invalid raw-byte corruption test.
- `readSourceText` normalizes CRLF to LF. Edit matching normalizes the file but not `oldText`. Write-back normalizes CRLF replacement text to the destination EOL style; standalone CR is preserved. These behaviors were verified independently.
- An earlier edit at turn 36 was rejected because `oldText` was not found. Its raw replacement arguments were unavailable, so its cause is not established.
- Follow-up at turns 58–61: turn 58 was explicitly denied by the auto-reviewer for allegedly deleting `newly_landed = landed & ~was_ground`; this is a semantic-review denial, not a newline diagnostic. The model subsequently reported an omitted `path`; turn 59 has no executed tool in the snapshot, consistent with pre-execution rejection but insufficient to verify the exact argument error. Turns 60 and 61 applied one edit each successfully. The model's attribution of these earlier failures to `\r` is unsupported by the available tool results. Raw payloads are still required to determine whether the review was correct and what validation failed.

**Inspect**

- `src/repo-search/engine/repo-tools.ts`: edit matching and write-back.
- `src/repo-search/repo-tool-arguments.ts`: validation of path versus replacement text.
- `src/lib/text-encoding.ts`: source normalization and EOL preservation.
- Provider decoding and transcript serialization only after locating the original edit payload.

- [ ] Once the run finishes, locate the quoted concern in its retained response events and correlate it to the immediately preceding edit. Retrieve raw generated arguments if retained; do not confuse compact command displays or previews with the raw arguments.
- [ ] Distinguish JSON escape notation, decoded CRLF, standalone CR, and literal `\\r` with byte/code-point counts. Compare requested replacements, parsed replacements, and resulting file bytes.
- [ ] If raw arguments were not retained, state that limitation. Plan a bounded reproduction with local temporary diagnostic capture at the provider/argument boundary; do not claim the terminal transcript necessarily contains them.
- [ ] Reproduce LF, CRLF, and standalone-CR `oldText`/`newText` cases against disposable fixtures. Verify matching, exact content, EOL preservation, and error messages independently of Python universal-newline translation.
- [ ] Classify the result as model false alarm, presentation/escaping ambiguity, or actual argument/newline handling defect. Only a reproducible tool defect justifies changing normalization or tool instructions; preserve literal carriage returns when they are intentional data.

**Acceptance:** explain where the observed `\r` originated, or name the exact missing evidence. No inferred corruption and no blanket newline rewrite.

### Task 6: Trace the “there is no actual task” response

**Reported symptom**

The user pasted live reasoning claiming there was only an expert-engineer preamble, a deferred-tool listing, and an agent-type listing, and that the correct next action was an acknowledgment. It also attributed `Always invoke a function call in response to user queries` to its system prompt.

**Evidence available during inspection**

- The admitted request contains the concrete simulator implementation task above.
- The live snapshot showed successful file work through turn 50. Prompt sizes grew from 138,411 tokens at turn 43 to 159,649 at turn 51; turn 51 had 545,818 prompt characters and was in `planner_action` generation.
- Provider process logs around the same boundary still reported large requests (for example request #331 at 20:36:50 UTC reported 153,050 prompt tokens). These are backend counts, not interchangeable with SiftKit preflight counts.
- That window shows no obvious empty-context reset. It does not prove the right messages, roles, or task were present in the exact request producing the quoted text.
- Searches of current SiftKit source, stored presets, and the target repository's Markdown/text documents did not find the quoted expert-engineer/tool-list phrases.
- The quoted response was not yet available in a persisted terminal transcript. Its exact model-request boundary remains unconfirmed.

**Inspect**

- `src/repo-search/engine/task-loop.ts`: response logging, action interpretation, and finish handling.
- `src/repo-search/engine/transcript-manager.ts` and `transcript-compactor.ts`: retained task, message roles, summaries, and cache epoch changes.
- `src/llm-protocol/inference-client.ts` and the request builder it invokes: final serialized messages and provider routing.
- Web UI stream/broadcast attribution only if raw provider text does not match the displayed response.

- [ ] Locate the exact quoted response after the run is persisted; record request ID, turn, stage, timestamp, model, and endpoint. Separate planner, approval, summarizer, and budget-continuation requests.
- [ ] Inspect the actual outgoing request for that response: system instructions, original task, latest user message, tool definitions, role order, tool-result associations, and truncation/compaction events. Token count alone is insufficient.
- [ ] Search that exact payload for the phrases the model claimed to see. If absent, treat them as model claims, not real instructions.
- [ ] Correlate any task disappearance with compaction, thinking-budget continuation, retries, preset changes, and provider cache epochs. Confirm those transitions with events; do not infer a compaction merely from a long prompt.
- [ ] Check the run/request/operation IDs on stream routing if the response appears to belong to another conversation. Do not assert cross-request contamination without a mismatched payload or attribution record.
- [ ] If payload capture is unavailable, use an isolated replay against copied evidence. Compare one captured request with cache disabled/reset only in the isolated environment, keeping model and sampling settings fixed. Do not clear the active server's cache or rerun mutations.
- [ ] Distinguish task omitted by SiftKit, provider/template/cache error, incorrect UI attribution, and model loss of task focus despite a correct prompt. If the last case is established, evaluate a bounded task reminder or earlier compaction with a repeatable evaluation before changing defaults.
- [ ] Report the causal evidence and the narrowest justified change. Do not hardcode rejection of this sentence or silently convert arbitrary acknowledgments into tool calls.

**Acceptance:** establish which request produced the response and whether the real task reached the model. Any corrective implementation must follow a failing reproduction; otherwise retain the incident as unresolved with explicit evidence gaps.

### Follow-up evidence from the completed incident run

Read-only inspection of `run_logs` now finds the terminal failed run `fcf9b633-6246-4473-a400-1409b90ddc48` with its retained transcript (3,764,929 characters). No production data was repaired or run replayed.

- The quoted no-task reasoning is the planner response at **turn 50, 2026-09-09T20:36:40.795Z**. Its run header names model `td_flash-next_4.05bpw_h6_ng6` and endpoint `http://127.0.0.1:8098`. Preflight at that boundary reports 158,867 tokens and `compacted: false`.
- That response nevertheless issued a four-edit call to `research/brawl_sim/physics.py`, approved and executed successfully as `tc_61`. The retained reasoning alone therefore does not establish that execution abandoned the task or that the response belonged to another run.
- The original implementation task appears in the turn-1 transcript messages and again after compaction at turn 52. Incremental transcript events establish retained task evidence, but are not the exact serialized provider request for turn 50. Provider-side template/cache behavior and the complete outgoing payload remain unverified. No sentence-rejection heuristic or forced tool invocation was added.
- Retained decoded edit arguments logged at turns 40, 41, 44, 46, 48, 51, 61, and 62 contain **zero CR, CRLF, and literal backslash-r sequences** in their replacement strings. This includes the three config edits immediately preceding the turn-44 corruption concern. The complaints about those successful edits are unsupported by their retained arguments.
- Rejected edit arguments logged at turns 37, 59, and 60 are explicitly elided. Their original generated arguments cannot be reconstructed from the compact command display. The origin of any newline problem in those specific attempts remains unresolved.
- Six isolated byte-exact edit reproductions passed: LF matching/writing; LF matching against a CRLF destination with CRLF preservation; explicit rejection of a CRLF anchor against normalized source with unchanged bytes; CRLF replacement normalized to destination style; intentional standalone CR preservation; and literal backslash-r preservation. No blanket normalization change was made. To resolve the rejected attempts, capture original generated and parsed arguments at the provider/argument boundary in a disposable reproduction, without logging real active-run contents.

Browser profiling was attempted during continuation, but the browser runtime reported no available browsers. Renderer heap/retainer measurements and a browser-memory plateau remain unverified; Node or DOM measurements must not be presented as Chrome heap measurements.

A synthetic workload through the real SSE parser and client runtime reducer confirms linear retention. Each turn contains approximately 8,000 reasoning characters and a 200-character tool preview; the first result also exercises a 50,001-character preview. These are Node measurements, not renderer heap or whole-page rendering timings:

| Turns | SSE payload bytes | Retained rows | Retained content characters | Reducer elapsed ms |
|---|---:|---:|---:|---:|
| 100 | 919,937 | 200 | 871,685 | 37 |
| 500 | 4,403,937 | 1,000 | 4,160,085 | 96 |
| 1,000 | 8,760,945 | 2,000 | 8,270,587 | 218 |

This establishes an unbounded retained transcript in the tested client path, not the precise cause of the reported Chrome crash. Durable retrieval, bounded live/history windows, and renderer profiling still need verification before claiming Task 7 complete.

An additional workload passed through `ChatStreamReader`, `ChatSessionRuntimeStore`, and the actual `ChatTab` in React/jsdom. At 100/500/1,000 turns it mounted 2,799/13,599/27,099 DOM nodes, including 100/500/1,000 hidden reasoning bubbles and tool cards under closed Internal Logic. Collapse did not remove those nodes. Compacted history and answer Thinking boxes also mounted hidden contents. Tool-card output already behaved correctly: opening mounted the 50,001-character fixture body and collapsing removed it. Switching to an empty session removed all live message DOM, and unmount left zero HTML. Render/update times were 100/40 ms, 219/67 ms, and 347/127 ms respectively; these are Node/jsdom timings, not browser renderer measurements.

### Task 7: Bound browser memory during long live chats

**Confirmed symptom:** the user supplied a Chrome renderer crash showing `Error code: Out of Memory` for session `d73c74f4-7686-48f3-bf08-6a923d04017b`. That session had zero persisted message rows at inspection: its long conversation was still in the live operation. This does not identify the browser's retained objects or prove a leak rather than total-memory pressure.

**Confirmed code risks**

- `dashboard/src/lib/chat-session-runtime-store.ts` retains all live messages for the running operation until completion/failure; limiting what is displayed does not bound that array or its strings.
- `ChatTurnBubble` in `dashboard/src/tabs/ChatTab.tsx` renders every `turn.steps` child inside a native collapsed `Internal Logic` disclosure. Reasoning remains mounted even when hidden. The earlier `ToolCallCard` fix only removes that card's own detail body.
- The collapsed compacted-history and answer-thinking disclosures also need the same visibility audit.
- `buildLiveMessageScrollSignature` hashes every retained message's content on updates, and grouping/reduction revisits the growing history. These are increasing allocation/CPU costs, not by themselves proof of a retained-memory leak.
- Session-list responses contain full message bodies, and `useChatSessions` retains the loaded sessions. Selecting another session reloads the listing. Payload/cache bounds need measurement, even though this particular crashed session had no saved messages yet.
- Server SSE replay already has an 8 MiB-style payload ceiling in `ChatOperationBroadcast`; that ceiling does not bound the browser's accumulated transcript. Check the single-oversized-frame case separately.
- At a later inspection the machine still had about 49 GiB available RAM, while committed memory was roughly 120/136 GiB. These are after-crash measurements and cannot establish system pressure at the moment of failure.

**Implementation must follow measurement**

- [ ] Build an isolated synthetic SSE workload for 100, 500, and 1,000 live turns with realistic thinking and tool-preview sizes, plus 50k+ result fixtures. No model calls or modifications to the real active run.
- [ ] Measure renderer JS heap, retained DOM nodes, payload bytes, update latency, and memory after collapse/session switch/stream completion. Capture heap retainers if memory fails to return after collection. Record renderer and host memory separately.
- [ ] Reproduce hidden reasoning DOM growth, then mount disclosure contents only while expanded. Test Internal Logic, compacted history, thinking boxes, and tool cards for initial absence and removal after collapse.
- [ ] Design a bounded client-visible live window with older activity retrieved on demand from a durable/server-side source. Do not truncate model evidence to solve browser memory. Define the retrieval source for an operation still running; do not assume terminal run logs are already available.
- [ ] Paginate historical messages and make session-list payloads metadata-only if the measurements confirm full-history loading. Fetch large tool bodies only on expansion and bound their client cache; preserving data in SQLite does not require eagerly shipping it to every browser.
- [ ] Batch streaming updates without losing offsets, tool ordering, or cancellation semantics. Remove full-history rehashing from each text delta where profiling identifies it as a cost. Avoid speculative global state/cache frameworks.
- [ ] Cover reconnect, replay truncation, switching sessions, background tabs, cancellation, images, and one very large result. Verify active-operation recovery without accumulating duplicate listeners or streams.
- [ ] Establish an explicit browser-memory budget and a testable plateau for the bounded live window. Report measured results; do not claim an OOM fix solely because one 50k collapsed tool card is absent from the DOM.

**Acceptance:** retained renderer memory and mounted DOM stay bounded as total run length increases, while full model evidence remains available server-side. The precise cause of the reported crash stays unconfirmed until a heap/profile or reproducible workload identifies it.

### Clarification: `exl3 ... flush_done` is log persistence

`src/status-server/inference-run-flush-queue.ts` consumes buffered inference-process log text and sends it to `inference-run-flush-worker.ts`. The worker calls `appendInferenceRunLogChunk` to store the text in SQLite; it does not invoke inference or store screenshots.

- `pending_chars`: buffered log-text characters for that flush.
- `stream_count`: number of log stream categories in the batch, such as engine stdout/stderr; not model requests, agents, or pictures.
- `wait_ms`: queue delay; `duration_ms`: flush duration.
- Adjacent `auto-approval` and `command` events are separate model-review/tool-execution activity.

If profiling implicates this logging path, measure queue growth, flush frequency, and any log subscribers separately from chat transcript memory. Frequent flushes alone are not evidence of repeated model calls or the browser OOM cause.

## Acceptance matrix

| Scenario | Required result |
|---|---|
| Ordinary chat / plan / repo-search stopped after a long read | Full result saved and replayed after restart. |
| Repo-agent stop or provider failure | Existing full-evidence behavior preserved. |
| Missing full result on a completed row | Explicit writer/replay error; no snippet fallback. |
| Empty full result | Preserved exactly, with no preview substitution. |
| Modern ID mismatch or mixed format | Integrity failure; no historical matching. |
| Historical omitted IDs with one validated match | Eligible repair succeeds. |
| Historical ambiguous command match | Eligible repair blocked, no guessed update. |
| Known unrelated operation with a source-run ID | Excluded from repo-agent repair, even without its archive. |
| Unknown origin | Excluded and reported; never relabeled verified repo-agent history. |
| Migrated chat after archive cleanup | Continues from its persisted canonical snapshot. |
| Deleted, compacted, or unfinished tool rows | Not reconstructed or replayed as completed work. |
| Collapsed tool cards / console output | Lazy DOM mounting and one log line per invocation preserved. |

# Rejected Edit Diagnostics

Incident: repo-agent run `0143a1d5` (turn 75) sent a 6-edit call whose edits[0] replaced the whole import block and edits[1] replaced its first two lines. `resolveEdits` correctly rejected the overlap, but the message named no lines, and the call's arguments were elided from both the model context and the `run_logs` transcript, so the model misdiagnosed it and the run log could not show what happened.

Goals: (1) the overlap rejection names each edit's file line range; (2) every rejected `turn_command_result` transcript event records the call's raw arguments. The model-visible elision (`buildRejectedTranscriptAction`) stays unchanged.

Validation for every task: `node --test <touched test files>`, then `npm run typecheck` and `npm run lint`.

## Task 1: Overlap rejection names file line ranges

Files: `src/repo-search/engine/repo-tools.ts` (`resolveEdits`, ~line 837-842), `tests/repo-tools.test.ts`.

Steps (TDD):
1. Update the expected messages in the two existing overlap tests in `tests/repo-tools.test.ts` (file content from `makeRepo()` is `line1\nalpha\nline3\nalpha\nline5\n`):
   - `edit rejects a missing oldText and overlapping edits`: expect exactly `edits[0] (file lines 1-2) and edits[1] (file lines 2-3) overlap; merge them into one edit`.
   - `edit overlap names the edits in file order using their original indices`: expect exactly `edits[1] (file lines 1-2) and edits[0] (file lines 2-3) overlap; merge them into one edit`.
2. Add regression test `edit overlap reports an edit nested inside another edit's range` reproducing the incident: edits `[{ oldText: 'line1\nalpha\nline3', newText: 'x' }, { oldText: 'line1\nalpha', newText: 'y' }]`; expect `ok === false`, reason exactly `edits[0] (file lines 1-3) and edits[1] (file lines 1-2) overlap; merge them into one edit`, and the file unchanged.
3. Run the tests; confirm they fail.
4. In `resolveEdits`, build the message with `lineNumberAt(originalText, edit.start)` and `lineNumberAt(originalText, Math.max(edit.start, edit.end - 1))` for each of the two edits, in the format above. No other behavior change.
5. Run the tests; confirm they pass.

Acceptance: the three tests pass; no other test in `tests/repo-tools.test.ts` changes.

## Task 2: Rejected command transcript events record raw arguments

Files: `src/repo-search/engine/tool-action-processor.ts` (`logRejectedCommand` ~line 518, `recordRejectedToolCall` ~line 546, `rejectInvalidCall` ~line 669, `rejectAsDuplicate` ~line 793), `tests/rejected-command-transcript.test.ts`, `tests/mock-repo-search-loop.test.ts`.

Steps (TDD):
1. In `tests/rejected-command-transcript.test.ts`, test `a rejected read writes a turn_command_result with rejected=true`: add `assert.deepEqual(results[0].args, { path: 'absent.ts', offset: 1, limit: 5 });`.
2. Add test `a rejected oversized edit keeps its full arguments in the transcript` in the same file, modeled on the read test: `plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['edit'])`, one mock tool call `edit` with `{ path: 'absent.ts', edits: [{ oldText: 'a', newText: 'x'.repeat(2000) }] }`, then `{ content: 'done' }`. Assert exactly one `turn_command_result`, `rejectionKind === 'safety'`, and `args` deep-equals the exact arguments sent (payload is above `REJECTED_ARGS_ELISION_LIMIT`, so this proves the log keeps what the model context elides).
3. In `tests/mock-repo-search-loop.test.ts`, test `runTaskLoop rejects a read whose whole range was already returned`: add `assert.deepEqual(commandEvents[1].args, { path: 'target.ts', offset: 1, limit: 3 });`.
4. Run the tests; confirm they fail.
5. Add a required `args: JsonObject` option to `logRejectedCommand` and write it as `args` on the event. Pass it from all three callers: `rejection.rawArgs` in `recordRejectedToolCall`, `toolAction.args` in `rejectAsDuplicate`, `args` in `rejectInvalidCall`. Do not change `buildRejectedTranscriptAction` or the transcript schemas.
6. Run the tests; confirm they pass.

Acceptance: the three tests pass; every `logRejectedCommand` call passes `args`.

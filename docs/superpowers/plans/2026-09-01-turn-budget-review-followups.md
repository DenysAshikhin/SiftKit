# Turn-Budget Review Follow-Ups

Fixes for the drift review of the turn-based tool budget. Follows
`2026-09-01-turn-based-tool-budget.md`.

Rules for every task: TDD (failing test first), no `any` / type assertions / non-null assertions,
no compatibility shims or parallel paths, no temp files, no commits.

---

## Task 1: Make the enforcement turn an explicit parameter

**Problem.** `TaskLoop.validateActions` reads the mutable field `this.turnsUsed`, which
`prepareTurn` sets as a side effect. Correctness rests on a call-ordering invariant defended only
by a comment; a reorder or a second caller silently gates on a stale turn, and the failure mode is
permissive. Separately, `enforceToolCallLimit(actions, turn, limit)` takes "the turn about to run"
and subtracts 1 internally, while `buildToolBudgetNotice(usedTurns, limit)` takes "turns already
used" — the same parameter name and value, one apart. And `Math.min(turn - 1, limit) >= limit` is
identical to `turn - 1 >= limit`, so the clamp is inert as a predicate and exists only to make the
message read `45/45` during the post-limit answer slack.

**Steps.**

1. `src/agent-loop/types.ts`: change `AgentLoopActionAdapter.parseActions` to
   `parseActions(context: AgentLoopResponseContext): AgentLoopAction[]`. Drop the standalone
   `response` parameter — `context.response` already carries it, matching the sibling methods.
2. `src/agent-loop/agent-loop.ts:77`: call `this.options.actionAdapter.parseActions(responseContext)`.
3. `src/summary/planner/agent-loop-adapter.ts:48`: take `context`, parse `context.response`.
4. `src/repo-search/agent-loop-adapter.ts`:
   - `RepoSearchLoopController.validateActions` becomes
     `validateActions(actions: AgentLoopAction[], turnNumber: number): AgentLoopAction[]`.
   - `parseActions(context)` parses `context.response` and passes `context.turnNumber`.
5. `src/repo-search/engine/task-loop.ts`:
   - `enforceToolCallLimit(actions: AgentLoopAction[], usedTurns: number, toolCallLimit: number)`.
     Body: `if (requestsTools && usedTurns >= toolCallLimit)`; the message uses
     `buildToolLimitReachedSummary(toolCallLimit, toolCallLimit)` — inside the branch the reported
     value is always the budget. Delete the `Math.min`. Rewrite the doc comment: the parameter is
     turns already consumed, and the reported value is the cap because the post-limit answer slack
     lets `usedTurns` exceed it.
   - `validateActions(actions, turnNumber)` returns
     `enforceToolCallLimit(actions, turnNumber - 1, this.maxTurns)`. Delete the ordering comment.
   - Keep the `this.turnsUsed = turn` assignment in `prepareTurn` — it still feeds the task result
     and logging — but it must no longer be read by `validateActions`.

**Tests.** In `tests/tool-call-limit.test.ts`, update `enforceToolCallLimit` call sites to pass
used-turn counts. Add a boundary case: `usedTurns === limit - 1` permits tools, `usedTurns ===
limit` rejects, and a slack turn (`usedTurns === limit + 2`) still reports `limit/limit`.

**Acceptance.** No method on `TaskLoop` reads `this.turnsUsed` to make a budget decision; grepping
`this.turnsUsed` in `src/repo-search/engine/task-loop.ts` shows only the assignment and the
result/logging reads. `npm run typecheck` and `npm run lint` clean.

---

## Task 2: Collapse `toolCallLimit` into `maxTurns` in the engine and on the wire

**Problem.** `this.toolCallLimit = this.maxTurns` makes the two definitionally the same quantity,
then carries it under two names through the reporter, the processor deps, and the progress events —
which already carry `maxTurns` via `turnScopedFields`. Two names for one number, six layers deep.

**Steps.**

1. `src/repo-search/engine/task-loop.ts`: delete the `toolCallLimit` field and its assignment. Pass
   `this.maxTurns` at the `ProgressReporter` and `ToolActionProcessorDeps` construction sites.
2. `src/repo-search/engine/progress-reporter.ts`: delete the `toolCallLimit` field and constructor
   option; remove it from the `tool_start` and `tool_result` payloads (`maxTurns` stays).
3. `src/repo-search/engine/tool-action-processor.ts`: rename the deps field `toolCallLimit` to
   `maxTurns`; call `buildToolBudgetNotice(turn, this.deps.maxTurns)`.
4. `src/repo-search/types.ts`: remove `toolCallLimit` from the `tool_start` schema and from
   `ToolResultProgressEventSchema`.
5. `src/status-server/routes/chat.ts`: remove `toolCallLimit` from both SSE payloads.
6. `dashboard/src/lib/chat-live-messages.ts`: source the field from `toolEvent.maxTurns`.

**Tests.** Update the fixtures that construct these events/deps: `tests/helpers/tool-action-processor.ts`,
`tests/engine-progress-reporter.test.ts`, `tests/progress-reporter-live-text.test.ts`,
`tests/cli-progress-renderer.test.ts`, `tests/engine-prompt-preparer.test.ts`,
`tests/engine-terminal-synthesizer.test.ts`, `tests/image-retention.test.ts`,
`tests/live-repo-agent-compaction-replay.test.ts`, `tests/repo-search-status-server.test.ts`,
`dashboard/tests/chat-stream-parser.test.ts`, `dashboard/tests/chat-session-runtime-store.test.ts`,
`dashboard/tests/chat-session-state.test.ts`, `dashboard/tests/chat-tab.test.tsx`,
`dashboard/tests/api-stream.test.ts`.

**Acceptance.** Grepping `toolCallLimit` under `src/repo-search`, `src/status-server/routes`, and
`dashboard/src` returns nothing. Repo-search and dashboard suites pass.

---

## Task 3: Persist the turn cap under an honest name

**Problem.** `src/status-server/chat.ts:1017` persists `toolCallLimit: turnsUsed` — the DB column
`chat_messages.tool_call_limit` does not hold a limit. The live SSE path fills the same field with
the cap, so `ChatTab`'s `${toolMessages.length}/${toolCallLimit}` means one thing while streaming
and another after reload. Decision: the denominator is the turn cap in both paths.

**Steps.**

1. `src/repo-search/engine/task-loop-support.ts`: add `maxTurns: z.number().int().positive()` to
   `TaskResultSchema`.
2. `src/repo-search/engine/task-loop.ts`: include `maxTurns: this.maxTurns` in the built task result.
3. `src/status-server/repo-search-scorecard-types.ts`: add `maxTurns: z.number().int().positive()`
   to `RepoSearchTaskResultSchema` and read it in the task normalizer. Non-nullable on purpose:
   `buildPersistTurnsFromRepoSearchResult` only ever sees fresh engine results, so a missing value
   is a missed migration and must fail loudly.
4. `packages/contracts/src/chat.ts`: rename `toolCallLimit` to `toolCallMaxTurns` at all three sites.
5. `src/status-server/chat.ts`: rename `PersistToolMessage.toolCallLimit` to `toolCallMaxTurns`;
   update the parse near line 647; change `buildToolMessageFromCommand(command, maxTurns)` to take
   and persist the cap. In `buildPersistTurnsFromRepoSearchResult`, pass `task.maxTurns` and delete
   the now-dead `maxCommandTurn` / `rawTurnsUsed` fallback block and its comment.
6. `src/state/chat-sessions.ts`: rename the row-schema key, the row mapping, the insert column list,
   and the bind to `tool_call_max_turns` / `toolCallMaxTurns`.
7. `src/state/runtime-db.ts`: rename the column in the `chat_messages` CREATE TABLE.
8. `src/state/migrations/schema-helpers.ts`: rename the ensured-column entry.
9. `src/state/migrations/registry.ts`: append version 55 — rename `tool_call_limit` to
   `tool_call_max_turns`, guarded the way v53 is (no-op when already renamed, coalesce then drop if
   both exist, ADD COLUMN if neither). Bump `CURRENT_SCHEMA_VERSION`.
10. `dashboard/src/tabs/ChatTab.tsx:838` and `dashboard/src/lib/chat-live-messages.ts`: use
    `toolCallMaxTurns`.

**Tests.** Replace `tests/runtime-db-schema-v53.test.ts` with `tests/runtime-db-schema-v55.test.ts`:
seed a DB carrying `tool_call_limit` with a value, set `runtime_schema.version = 54`, reopen, and
assert the column is `tool_call_max_turns`, the value survived, `tool_call_limit` is gone, and the
version equals `CURRENT_SCHEMA_VERSION`. The v53 test's assertion is false by design after v55 — do
not keep both. Update `tests/contracts-chat.test.ts`, `tests/chat-sessions-db.test.ts`,
`tests/status-server-chat.test.ts`, `tests/chat-repo-operation-runner.test.ts`,
`tests/repo-agent-sessions.test.ts`, and any repo-search result fixtures that must now carry
`maxTurns`.

**Acceptance.** Grepping `tool_call_limit` and `toolCallLimit` (case-insensitive) over `src/`,
`packages/contracts/src`, `dashboard/src`, and `tests/` returns nothing. A live tool bubble and the
same bubble after reload show the same denominator. Full suite, typecheck, and lint clean.

---

## Task 4: Retire the batch-era plans and fix the untyped assertion

**Steps.**

1. Add a superseded banner as the first line of each of
   `docs/superpowers/plans/2026-08-29-tool-batch-budget-and-notices.md`,
   `docs/superpowers/plans/2026-08-30-budget-drift-fixes.md`, and
   `docs/superpowers/plans/2026-08-30-tool-budget-drift-fixes.md`, reading: SUPERSEDED by
   `docs/superpowers/plans/2026-09-01-turn-based-tool-budget.md` — the batch basis
   (`executedToolBatches`) described below no longer exists; the tool budget is counted in turns.
2. `tests/repo-search-loop.core.test.ts:1691`: replace
   `result.commands.some((command) => JSON.stringify(command).includes('gamma'))` with an assertion
   on the typed field — assert the executed command strings directly, e.g. comparing
   `result.commands.map((command) => command.command)` against the expected alpha and beta commands.
   `JSON.stringify` matches any field containing the substring, so it does not check what it claims.

**Acceptance.** Grepping `executedToolBatches` under `docs/` hits only banner-carrying files.
Grepping `JSON.stringify` in `tests/repo-search-loop.core.test.ts` returns nothing for this test.

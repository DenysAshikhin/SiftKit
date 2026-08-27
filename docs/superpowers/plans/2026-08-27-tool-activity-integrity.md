# Tool Activity Integrity Implementation Plan

> **For agentic workers:** Execute inline only. Do not use subagents, SiftKit, worktrees, or commits.

**Goal:** Replace the tool-activity UI's semantic and validation shortcuts with one schema-validated, structured activity path from engine execution to rendering.

**Architecture:** The repo engine derives a `ToolActivityKind` from the validated native tool call and emits it on typed progress events. The status server forwards that typed event, the dashboard validates the SSE payload with the shared schema, and live/persisted tool messages carry required activity metadata and explicit status. The UI renders labels from `{ activityKind, lifecycle }` and reports the existing budget accurately as `Turn x / y`.

**Tech Stack:** TypeScript, Zod, React, Node test runner, SQLite migrations.

**Spec:** User-approved top-five `reflect-session-drift` findings in the current thread.

## Global Constraints

- Keep the current thinking-stream smoothing logic unchanged.
- Tool activity shows only the latest three live tool rows.
- Running rows never expose raw command or output; completed rows remain collapsed.
- No `any`, type assertions, non-null assertions, namespace imports, schema-duplicating IO types, compatibility runtime paths, or dynamic function injection.
- Preserve unrelated changes. Do not commit.

---

### Task 1: Shared wire contract and strict SSE parsing

**Files:**
- Modify: `packages/contracts/src/chat.ts`
- Modify: `dashboard/src/lib/chat-stream-parser.ts`
- Test: `dashboard/tests/chat-stream-parser.test.ts`

**Interfaces:**
- Produces: `ToolActivityKindSchema`, `ToolActivityKind`, `ChatStreamToolEventSchema`, and `ChatStreamToolEvent` from `@siftkit/contracts`.
- Consumes: existing SSE packets emitted as `tool_start` and `tool_result`.

- [ ] Add failing parser tests proving malformed/missing `toolCallId`, turn bounds, command, activity kind, and result fields are rejected instead of coerced.
- [ ] Run `npm run build:test` and `npm test -- chat-stream-parser`; confirm failures are caused by current coercion and missing exports.
- [ ] Define strict shared Zod schemas. Require positive integer `turn/maxTurns`, non-empty IDs/commands, and a typed activity kind.
- [ ] Replace the dashboard's handwritten event type and `Number`/`String` coercion with `ChatStreamToolEventSchema.safeParse`.
- [ ] Rebuild and rerun the focused parser tests to green.

### Task 2: Structured activity at execution and persistence

**Files:**
- Modify: `src/repo-search/types.ts`
- Modify: `src/repo-search/prompts.ts`
- Modify: `src/repo-search/engine/progress-reporter.ts`
- Modify: `src/repo-search/engine/tool-action-processor.ts`
- Modify: `src/repo-search/engine/validation-command-output-policy.ts`
- Modify: `src/status-server/routes/chat.ts`
- Modify: `src/status-server/chat.ts`
- Modify: `src/state/runtime-db.ts`
- Modify: `src/state/migrations/registry.ts`
- Modify: `src/state/chat-sessions.ts`
- Test: `tests/validation-command-output-policy.test.ts`
- Test: `tests/chat-repo-operation-runner.test.ts`
- Test: `tests/chat-sessions-db.test.ts`
- Test: `tests/status-server-chat.test.ts`

**Interfaces:**
- Consumes: `ToolActivityKind` from contracts and the validated `RepoNativeToolCall`.
- Produces: progress events, persisted command records, database rows, and wire messages with required `toolCallActivityKind`.

- [ ] Add failing tests that map native tool names to activity kinds, carry the kind through progress/SSE, persist it, migrate old tool rows to explicit `command`, and reject missing activity metadata on new tool records.
- [ ] Run the focused server/state tests and confirm the expected failures.
- [ ] Add one pure `getToolActivityKind(RepoNativeToolCall)` classifier: read; search for grep/find/ls/git; edit for write/edit; validate for recognized run validations; web search/fetch; otherwise command.
- [ ] Reuse the existing validation-command recognizer rather than duplicate its regex list.
- [ ] Add `activityKind` to repo progress schemas, reporter calls, task commands, persisted tool messages, and SSE bodies.
- [ ] Add schema migration 51 and database column `tool_call_activity_kind`; backfill historical tool rows to explicit `command`, then require the field for every loaded/saved tool row.
- [ ] Rerun focused server/state tests to green.

### Task 3: Required tool-message state and label rendering

**Files:**
- Modify: `packages/contracts/src/chat.ts`
- Modify: `src/status-server/routes/chat.ts`
- Modify: `dashboard/src/lib/chat-live-messages.ts`
- Modify: `dashboard/src/lib/chatTurns.ts`
- Modify: `dashboard/src/lib/tool-status.ts`
- Modify: `dashboard/src/components/ToolCallCard.tsx`
- Modify: `dashboard/src/tabs/ChatTab.tsx`
- Test: `dashboard/tests/chat-live-messages.test.ts`
- Test: `dashboard/tests/lib/chatTurns.test.ts`
- Test: `dashboard/tests/lib/tool-status.test.ts`
- Test: `dashboard/tests/tool-call-card.test.tsx`
- Test: `dashboard/tests/chat-tab.test.tsx`

**Interfaces:**
- Consumes: validated `ChatStreamToolEvent` and persisted activity kind.
- Produces: `ChatToolCallMessage` with required command, activity kind, lifecycle status, turn, and max turns.

- [ ] Add failing contract/UI tests proving a tool message without command, activity kind, status, or valid turn data is rejected; persisted tools arrive explicitly as `done`; and progress renders `Turn x / y`.
- [ ] Add failing label tests that use activity kind plus lifecycle and do not derive state from rendered strings.
- [ ] Run focused dashboard tests and confirm expected failures.
- [ ] Define `ChatToolCallMessageSchema` and make `ChatMessageSchema` require `kind`; require all tool state in the tool branch.
- [ ] Make live builders produce typed tool messages and make the server wire mapper mark persisted tools `done`.
- [ ] Replace raw-command regex classification and three lifecycle functions with one typed activity-label function over `{ activityKind, state, command }`.
- [ ] Narrow tool messages by their discriminant before passing them to `ToolCallCard`; remove silent command/status fallbacks.
- [ ] Change the progress caption from `Tools` to `Turn` while preserving `x / y`.
- [ ] Rerun focused dashboard tests to green.

### Task 4: Complete verification

**Files:**
- Review every file changed by Tasks 1-3.

**Interfaces:**
- Consumes: completed typed execution-to-UI path.
- Produces: verified build with no compatibility or duplicate paths.

- [ ] Run `git diff --check` and inspect the complete diff for obsolete fields, duplicate classifiers, casts, `any`, non-null assertions, and thinking-smoothing changes.
- [ ] Run all focused tests from Tasks 1-3.
- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run lint`.
- [ ] Run `npm run build`.
- [ ] Report any unrelated or environment-dependent failures separately; do not weaken tests.

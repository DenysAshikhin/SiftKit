# Repo-Agent Thinking / Live-Text Traces in Chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Per repo policy, dispatch `siftkit repo-agent` with 1-3 tasks at a time.

**Status:** DRAFT 2026-08-31 — traced against the codebase; both scope decisions answered by the user (full live-text parity + persist the trace). Do not re-open those two decisions during execution.

**Symptom (`Screenshot 2026-08-31 194754.png`):** a chat session running the **Repo Agent** preset renders only the `RECENT ACTIVITY` tool ring and approval rows. No `think` blocks, no narration, no progress line — during the run or after it. The repo-search chat preset shows all of them.

**Root cause (verified, two independent breaks, both in `src/status-server/repo-agent-sessions.ts`):**

1. `SessionProgressWriter.wantsLiveText` returns `false` (`repo-agent-sessions.ts:80-82`). That makes `ProgressReporter.liveTextEnabled` false (`src/repo-search/engine/progress-reporter.ts:43-45`), so the engine never wires `onThinkingDelta`/`onContentDelta` into the planner request (`src/repo-search/engine/task-loop.ts:705-715`) and never emits the end-of-turn `thinking` event (`task-loop.ts:542-544`). **No live-text event is ever produced for a repo-agent run.**
2. `handleProgressEvent` drops `thinking` and `answer` before fan-out (`repo-agent-sessions.ts:275-277`). Even a produced event would die there.

**Second-order gap:** on `done` the dashboard clears `liveMessages` entirely (`dashboard/src/lib/chat-session-runtime-store.ts:200-212`) and re-renders from the persisted transcript. `appendChatRepoAgentMessages` persists `turns: []` (`src/status-server/chat.ts:781-787`), so a finished repo-agent turn has **no** `assistant_thinking` and **no** `assistant_tool_call` rows — the whole trace, including the tool ring already visible today, disappears at completion and after reload.

**Everything downstream already works and needs no change:** `ChatStreamProgressWriter` handles `thinking`/`narration`/`progress_update` (`src/status-server/routes/chat.ts:343-372`), the SSE parser (`dashboard/src/lib/chat-stream-parser.ts:52-55`), transitions (`dashboard/src/lib/chat-stream-transitions.ts:21-32`), the runtime store (`chat-session-runtime-store.ts:153-172`), turn grouping (`dashboard/src/lib/chatTurns.ts:62-94`), and rendering (`dashboard/src/tabs/ChatTab.tsx:725-728, 873-885`).

## Why live text cannot simply be switched on globally

`RepoAgentSession` has **two** kinds of consumer and only one subscriber slot (`repo-agent-sessions.ts:177-184`):

| Consumer | Attach site | Wants live text |
| --- | --- | --- |
| Chat SSE (dashboard) | `src/status-server/routes/chat-repo-agent.ts:128-144` | **yes** |
| CLI / API operation stream | `streamSessionBoundary`, `src/status-server/routes/repo-search.ts:141-142` | **no** — it forwards every event raw as one `progress` frame and the CLI renderer discards live text anyway (`src/cli/progress-renderer.ts:12`) |

Flipping `wantsLiveText` to a constant `true` would push cumulative per-token snapshots down the CLI stream for every `siftkit repo-agent` invocation. So live text must be **subscriber-scoped**: the attached subscriber declares what it wants, and `SessionProgressWriter.wantsLiveText` delegates to it. The engine re-reads `liveTextEnabled` when building each turn's request (`task-loop.ts:705`), so a subscriber that attaches or detaches mid-run takes effect from the next turn — acceptable and desirable (a disconnected browser stops paying for live text).

**Tech stack:** TypeScript, zod (`@siftkit/contracts`), `node:test`, React dashboard.

## Locked design decisions

- **Live-text scope = full parity with repo-search chat:** `thinking`, `narration`, and `progress_update` reach the chat subscriber. `answer` stays dropped — the repo-agent answer is the run-result markdown built at the terminal boundary (`buildRepoAgentResultMarkdown`), and the chat writer is constructed with `streamAnswer=false` anyway (`chat-repo-agent.ts:127`). This also matches the repo-search chat stream (`routes/chat.ts:1491`).
- **Live-text kinds are never server-logged by the session.** `progress_update` is in `SERVER_LOGGED_PROGRESS_KINDS` (`src/status-server/dashboard-runs.ts:197-202`) and `handleProgressEvent` logs every server-logged kind (`repo-agent-sessions.ts:269-274`). Since repo-agent emits zero `progress_update` today, excluding live-text kinds from the session log preserves current log output exactly while preventing one log line per content delta. `tool_start` / `context_warning` / `approval_auto` logging is unchanged.
- **Persisted trace reuses the existing repo-search machinery.** `buildPersistTurnsFromRepoSearchResult` (`chat.ts:1027`) already turns a `RepoSearchExecutionResult` scorecard into `PersistTurn[]`, and `task.turnThinking` is recorded **regardless** of `liveTextEnabled` (`task-loop.ts:535-538`, surfaced at `task-loop.ts:873`). No new persistence format, no schema change.
- **Per-step thinking retention is shared.** Pass `maintainPerStepThinking` from `ChatTurnTelemetry.shouldMaintainPerStepThinking(session)` (`src/status-server/chat-turn-telemetry.ts:51-56`) so `ThinkingRetentionPolicy` prunes repo-agent thinking exactly like chat/repo-search thinking (`chat.ts:722`).
- **Accepted edge:** an aborted or engine-thrown run has no `RepoSearchExecutionResult`, so it persists no trace (`turns: []`). Same as today; not a regression.
- **Accepted cost:** persisted `assistant_thinking` rows count toward session context and replay into later turns when `PreserveThinking` is on (`chat.ts:322-340`). Identical to repo-search chat behavior.

---

### Task 1: Subscriber-scoped live text on `RepoAgentSession`

**Files:**
- Modify: `src/status-server/repo-agent-sessions.ts` (`RepoAgentSessionSubscriber` at `:42-44`, `SessionProgressWriter` at `:69-87`, `handleProgressEvent` at `:262-279`)
- Modify: `src/status-server/routes/repo-search.ts` (`streamSessionBoundary` attach at `:141-142`)
- Modify: `src/status-server/routes/chat-repo-agent.ts` (attach at `:128-144`)
- Test: `tests/repo-agent-sessions.test.ts`

- [ ] **Step 1: Write the failing tests** in `tests/repo-agent-sessions.test.ts`, using the file's existing session-construction helpers and a fake engine whose `executeRepoSearch` drives `request.progressWriter` directly:
  - `session progress writer reports wantsLiveText from the attached subscriber` — no subscriber → `false`; subscriber with `wantsLiveText: true` → `true`; after `detach()` → `false`. Assert through the writer the fake engine receives (`request.progressWriter.wantsLiveText`), not a private field.
  - `live-text events reach only a live-text subscriber` — engine writes `thinking`, `narration`, `progress_update`, `tool_start`; a `wantsLiveText: false` subscriber receives only `tool_start`, a `wantsLiveText: true` subscriber receives all four in order.
  - `answer events are never fanned out` — engine writes `answer`; neither subscriber kind receives it.
  - `live-text events are not server-logged` — capture `serverLogger` output (mirror the capture already used by the logging assertions in this suite, or `tests/helpers/logged-events.ts`) and assert a `progress_update` produces no log body while `tool_start` still does.
- [ ] **Step 2: Implement**
  - `RepoAgentSessionSubscriber` gains `readonly wantsLiveText: boolean`.
  - `RepoAgentSession` exposes `subscriberWantsLiveText(): boolean { return this.subscriber?.wantsLiveText === true; }`.
  - `SessionProgressWriter.wantsLiveText` returns `this.session.subscriberWantsLiveText()` (remove the constant `false`).
  - Add a module-level `const LIVE_TEXT_KINDS = new Set<RepoSearchProgressEvent['kind']>(['thinking', 'narration', 'progress_update'])` with a one-line comment stating these are derived from token deltas and are subscriber-scoped, never logged.
  - In `handleProgressEvent`, after the `approval_request` branch: if `event.kind === 'answer'` return; if `LIVE_TEXT_KINDS.has(event.kind)` then `if (this.subscriber?.wantsLiveText) this.subscriber.writeProgress(event); return;` — placed **before** the `isServerLoggedProgressEvent` block. Leave the rest of the method untouched.
  - `streamSessionBoundary` attaches with `wantsLiveText: false`; `chat-repo-agent.ts` attaches with `wantsLiveText: true`.
- [ ] **Step 3: Verify** — `node .\dist\test-runner\run-tests.js tests/repo-agent-sessions.test.ts tests/streamed-repo-agent-endpoint.test.ts tests/repo-agent-cli.test.ts` (build first with `npm run build:test`). All pass.

**Acceptance criteria:** the session fans live-text events out to a live-text subscriber only, never logs them, never fans out `answer`, and the CLI stream path (`streamSessionBoundary`) is byte-identical to today.

---

### Task 2: Chat repo-agent stream carries thinking / narration / progress

**Files:**
- Test: `tests/status-server-chat-repo-agent.test.ts` (extend; reuse `startHarness`, `requestSse`, `repoAgentFinishResponses`)
- Modify (only if the test proves it necessary): `src/status-server/routes/chat-repo-agent.ts`

- [ ] **Step 1: Write the failing E2E test** `chat repo-agent streams thinking deltas`:
  - POST `/dashboard/chat/sessions/:id/repo-agent/stream` with `approval: 'auto'` and `mockResponses` whose first entry carries `thinking: 'inspecting the cipher'` plus a `write` tool call, followed by `repoAgentFinishResponses('done')`. The mock planner path invokes `onThinkingDelta` (`src/repo-search/planner-protocol.ts:516`) and sets `response.thinkingText`, so both the streaming and end-of-turn emitters fire.
  - Assert the SSE response contains ≥1 `event: thinking` frame whose payload parses with `ChatStreamTextDeltaSchema` and whose reassembled text (offset 0 = keyframe, per `dashboard/src/lib/stream-text-delta.ts:4-15`) contains `inspecting the cipher`.
  - Assert `tool_start` frames still arrive and the terminal `done` payload still parses with `ChatSessionResponseSchema`.
- [ ] **Step 2: Write the failing regression test** `repo-agent operation stream omits thinking` — start a run through `POST /repo-agent/start` (the CLI-facing endpoint, see `tests/streamed-repo-agent-endpoint.test.ts` for the request shape) with the same mock responses and assert no forwarded `progress` frame has `kind: 'thinking'`, `'narration'`, or `'progress_update'`.
- [ ] **Step 3: Implement** — expected to be a no-op beyond Task 1; if the tests fail, fix only the forwarding in `chat-repo-agent.ts:128-144` (it must keep swallowing `lock_wait` and translating `approval_request`, and pass everything else to `progressWriter.write`).
- [ ] **Step 4: Verify** — `node .\dist\test-runner\run-tests.js tests/status-server-chat-repo-agent.test.ts tests/streamed-repo-agent-endpoint.test.ts`.

**Acceptance criteria:** the chat repo-agent SSE stream emits `thinking` (and `narration`/`progress` when the model produces them); the CLI operation stream emits none of them.

---

### Task 3: `RepoAgentSession` exposes its execution result

**Files:**
- Modify: `src/status-server/repo-agent-sessions.ts` (`run()` at `:311-330`)
- Test: `tests/repo-agent-sessions.test.ts`

- [ ] **Step 1: Write the failing test** `session exposes the engine execution result after a completed run` — fake engine returns a scorecard with one task carrying `turnThinking` and `commands`; after `waitForBoundary` resolves `completed`, `session.getExecutionResult()` returns that same result. Add `returns null for an aborted run` (abort before the engine resolves → `null`).
- [ ] **Step 2: Implement** — add `private executionResult: RepoSearchExecutionResult | null = null;`, assign it immediately after `RepoSearchResponseSanityChecker.assertSafeToSend(result)` in `run()`, and add `getExecutionResult(): RepoSearchExecutionResult | null { return this.executionResult; }`. No state-schema or run-store change: this is in-memory only, deliberately, so large thinking text never lands in the persisted run state.
- [ ] **Step 3: Verify** — `node .\dist\test-runner\run-tests.js tests/repo-agent-sessions.test.ts`.

**Acceptance criteria:** the scorecard survives the boundary for the chat route to consume; run-store state is unchanged.

---

### Task 4: Persist the repo-agent per-turn thinking + tool trace

**Files:**
- Modify: `src/status-server/chat.ts` (`appendChatRepoAgentMessages` at `:766-827`)
- Modify: `src/status-server/routes/chat.ts` (export `getMockTokenConfig` at `:228-230`, currently module-private)
- Modify: `src/status-server/routes/chat-repo-agent.ts` (persistence call at `:146-152`)
- Test: `tests/status-server-chat.test.ts` (unit, next to the existing `appendChatMessagesWithUsage persists interleaved per-turn thinking and tools` case at `:276`) and `tests/status-server-chat-repo-agent.test.ts` (E2E)

- [ ] **Step 1: Write the failing unit test** in `tests/status-server-chat.test.ts`: `appendChatRepoAgentMessages persists per-turn thinking and tools ahead of approval rows` — call it with two `PersistTurn`s and one decision record; assert the persisted `kind` sequence is `['user_text', 'assistant_thinking', 'assistant_tool_call', 'assistant_thinking', 'repo_agent_approval', 'assistant_answer']` and that every appended row carries `sourceRunId === result.runId`. Add `prunes older thinking when maintainPerStepThinking is false` mirroring the existing prune case at `:315`.
- [ ] **Step 2: Write the failing E2E test** in `tests/status-server-chat-repo-agent.test.ts`: `chat repo-agent persists its thinking trace` — run the Task 2 mock scenario, then read the session back (`GET /dashboard/chat/sessions/:id` or the `done` payload) and assert the transcript contains an `assistant_thinking` row containing `inspecting the cipher` and at least one `assistant_tool_call` row, both before the `assistant_answer`.
- [ ] **Step 3: Implement**
  - `appendChatRepoAgentMessages` input gains `turns: PersistTurn[]` and `maintainPerStepThinking: boolean`; pass them straight into `buildChatSessionWithAppendedTurn`'s options alongside the existing `{ sourceRunId, images }`. The existing `slice(0, -1)` splice keeps working: it preserves every generated row except the answer, inserts approval rows, then re-appends the answer.
  - In `chat-repo-agent.ts`, after `waitForBoundary` resolves: build `const telemetry = new ChatTurnTelemetry(effectiveConfig, getMockTokenConfig(config, request.value.mockResponses))`, then
    `const turns = await telemetry.countThinkingTokens(buildPersistTurnsFromRepoSearchResult(started.session.getExecutionResult()))`
    and pass `turns` + `maintainPerStepThinking: telemetry.shouldMaintainPerStepThinking(activeSession)` into `appendChatRepoAgentMessages`. `buildPersistTurnsFromRepoSearchResult` already returns `[]` for a null result, so aborted/failed runs need no branch.
  - Export `getMockTokenConfig` from `routes/chat.ts` (`chat-repo-agent.ts` already imports from that module).
- [ ] **Step 4: Verify** — `node .\dist\test-runner\run-tests.js tests/status-server-chat.test.ts tests/status-server-chat-repo-agent.test.ts tests/contracts-chat-repo-agent.test.ts`.

**Acceptance criteria:** a finished repo-agent turn renders `Internal Logic (N)` with its thinking and tool steps, survives a reload, and honours the per-step thinking retention policy.

---

### Task 5: Dashboard regression coverage

**Files:**
- Test: `dashboard/tests/chat-stream-transitions.test.ts`, `dashboard/tests/chat-live-messages.test.ts`

No dashboard source change is expected — nothing in the client branches on `operationKind` for thinking. These tests lock that in.

- [ ] **Step 1: Write the tests**
  - In `chat-stream-transitions.test.ts`: `repo-agent streams yield thinking transitions` — drive `toRuntimeTransitions(sessionId, 'repo-agent', opId, stream, true)` with a `thinking` event and assert a `thinking` transition is yielded; with `thinkingEnabled: false` assert it is dropped (mirrors `chat-stream-transitions.ts:21-25`).
  - In `chat-live-messages.test.ts`: a live repo-agent turn carrying thinking deltas **and** tool events renders the thinking stack (capped at `LIVE_THINKING_STACK_DEPTH = 3`, `chatTurns.ts:5`) above the recent-activity ring, and `showRecentActivity` stays true.
- [ ] **Step 2: Verify** — run the dashboard suite through the repo test runner.

**Acceptance criteria:** client-side thinking rendering for `repo-agent` is covered and cannot silently regress.

---

### Task 6: Full verification

- [ ] `npm run typecheck` (includes lint) — pipe through `siftkit summary --question "Return pass/fail, failing files, and error categories."`
- [ ] `npm run build:test` then the full suite `node .\dist\test-runner\run-tests.js` — pipe through `siftkit summary --question "Return pass/fail, failing test names, root errors, and file:line anchors."`
- [ ] Manual smoke in the dashboard: Repo Agent preset, a prompt that forces several tool calls. Confirm (a) `think` blocks stream above `RECENT ACTIVITY` during the run, (b) the finished turn shows `Internal Logic (N)`, (c) reload preserves it, (d) `siftkit repo-agent '<task>'` on the CLI prints the same stderr lines as before with no thinking spam.

**Acceptance criteria:** typecheck, lint, and the full suite are green; the screenshot's symptom is gone in both the live and settled states.

---

## Risks

| Risk | Mitigation |
| --- | --- |
| Live text raises SSE volume on repo-agent runs (100-tool-call runs are long) | Rate is identical to repo-search chat today: 100 ms delta throttle (`src/status-server/live-text-delta.ts:4`), `{turn, offset, text}` deltas, not full snapshots. |
| `progress_update` log spam | Live-text kinds are excluded from the session's server log (Task 1). `tool_start`/`context_warning`/`approval_auto` logging unchanged. |
| Persisted thinking inflates session context and replays into later turns | Same policy as repo-search chat: `ThinkingRetentionPolicy` + `maintainPerStepThinking` from the active model preset, wired in Task 4. |
| Subscriber detaches mid-run (browser closed) | `wantsLiveText` is re-read per turn, so the run silently stops producing live text and continues. No error path. |
| Approval flow regression | `handleProgressEvent`'s `approval_request` branch is untouched and stays first; `tests/status-server-chat-repo-agent.test.ts` approval cases must stay green. |

## Out of scope

- Streaming the repo-agent `answer` (the terminal run-result markdown remains the answer).
- Applying the chat session's `thinkingEnabled` toggle to the engine for repo-agent (`src/repo-search/execute.ts:409` sets `thinkingEnabledOverride` for `taskKind === 'chat'` only). The dashboard already hides thinking client-side when the toggle is off; changing the engine override is a separate decision.
- Reattach/replay of missed live text for a subscriber that connects mid-run.

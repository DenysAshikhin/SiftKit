# Streamed Web Direct-Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. TDD is mandatory (CLAUDE.md): write the failing test first, then implement.

**Goal:** Make web-on direct chat fully streamed. Eliminate the buffered `runDirectChatWebLoop` path entirely. Thinking, tool bubbles, and the final answer all stream token-by-token over SSE exactly like web-off chat. Also fix the data-loss bug where a prose answer that failed JSON parsing was replaced by an error string.

**Architecture:** Split orchestration from answering.
- **Decision turn** (streamed thinking, internal JSON action buffered): model picks `web_search` | `web_fetch` | `answer`. Reasoning streams live as `thinking`; the small JSON action is buffered and parsed; its `content` is never surfaced as `answer`.
- **Tool turns:** execute `web_search`/`web_fetch`, emit `tool_start` + `tool_result` SSE events (UI already renders these bubbles), append the result as evidence, loop.
- **Final answer turn:** a normal streamed completion with evidence injected and **no** JSON wrapping — streams `thinking` + `answer` as plain prose.

The streaming SSE endpoint already carries `thinking` / `tool_start` / `tool_result` / `answer` / `done` / `error` events (used today by plan and repo-search streaming). The direct-chat stream endpoint and client just need to forward tool events and run the multi-phase loop. The model-request lock is held across the whole loop (already the pattern for plan/repo-search streaming).

**No legacy (CLAUDE.md):** delete `runDirectChatWebLoop`, `buildWebToolBubble`, `WEB_CHAT_JSON_ACTION_PROMPT`, the buffered web branch in `POST /messages`, and their tests. Replace with the streamed orchestrator. Forged/disabled-gate enforcement is unchanged (web tools still excluded from the default parse-name set; route still gates on effective web state).

**Tech Stack:** TypeScript (strict, explicit types), Node http SSE, React dashboard, existing SiftKit chat/session/tool-bubble infrastructure, `WebResearchTools`.

---

## Current State (verified)

- `POST /dashboard/chat/sessions/:id/messages` (buffered): web-on → `runDirectChatWebLoop` (`stream:false`, JSON-`finish` answer, parse failure → error string replaces answer). Source of both bugs.
- `POST /dashboard/chat/sessions/:id/messages/stream` (SSE): web-agnostic; single `streamChatAssistantMessage` call; emits only `thinking` + `answer`; persists one turn with empty `toolMessages`.
- `streamChatAssistantMessage(config, session, userContent, onProgress, { promptPrefix })`: streams `delta.reasoning_content` → thinking, `delta.content` → answer; returns `{ assistantContent, thinkingContent, usage }`. Builds request via `buildChatCompletionRequest`, which **already** accepts `webActionInstruction` and `evidenceMessages` — `streamChatAssistantMessage` just doesn't forward them yet.
- `buildChatSystemContent(config, session, { promptPrefix, webActionInstruction })`: appends `webActionInstruction` to the **end of the system message**.
- SSE tool events: `forwardRepoSearchToolEvent` emits `tool_start` `{ toolCallId, turn, maxTurns, command, promptTokenCount }` and `tool_result` `{ toolCallId, turn, maxTurns, command, exitCode, outputSnippet, outputTokens, promptTokenCount }`.
- Dashboard `consumeChatStream` already decodes `thinking` / `tool` (start+result) / `answer` / `done` / `error`. `streamChatMessage` passes a no-op `onToolEvent` (`() => {}`) — needs to forward it.
- `useChatComposer.resolveDirectChatSend` routes web-on direct chat to **buffered** `appendChatMessage`; web-off to `streamChatMessage`. Must become: direct chat always streams.
- `appendChatMessagesWithUsage(..., { turns: [{ thinkingText, toolMessages }], ... })` persists multiple thinking bubbles + tool bubbles + one final answer (repo-search uses this exact shape via `buildPersistTurnsFromRepoSearchResult`).

---

## Target Design

### Prompts (`src/status-server/chat.ts`)

Replace `WEB_CHAT_JSON_ACTION_PROMPT` with two constants:

```ts
// Decision-turn system instruction (web-on). Drives tool selection; the model
// must emit exactly one tiny JSON action and NOT write the answer here.
export const WEB_CHAT_DECISION_PROMPT = [
  'You have live web access via tools. Decide the single next step and respond with exactly one JSON object, no markdown, no prose:',
  'To search the web: {"action":"web_search","query":"...","timeFilter":"week"}',
  'To fetch a public URL: {"action":"web_fetch","url":"https://example.com/page"}',
  'To answer the user now: {"action":"answer"}',
  'Any value that can change over time MUST be verified with web_search before answering — for example: live or Grand Exchange / market item prices, currency and crypto exchange rates, stock quotes, breaking news and current events, weather, sports scores and standings, release dates, and the latest version of software or libraries.',
  'Use stable, well-known static facts directly via {"action":"answer"} without searching.',
  'Private, local, and internal URLs are blocked.',
].join('\n');

// Final-answer-turn system instruction (web-on). Plain prose answer, streamed.
export const WEB_CHAT_ANSWER_PROMPT = [
  'You have web access and may have already gathered web evidence (shown as prior tool results).',
  'Answer the user directly in normal prose/markdown. Base any fluctuating data (prices, rates, versions, news) on the gathered web evidence and cite source URLs where relevant.',
].join('\n');
```

> The `WEB_CHAT_ANSWER_PROMPT` is appended via the existing `promptPrefix`/`webActionInstruction` channel for the final turn so the answer reflects gathered evidence and the fluctuating-data policy.

### Decision parsing (reuse, tolerant fallback)

Reuse `ModelJson.parseRepoSearchPlannerAction(text, { allowedToolNames: ['web_search', 'web_fetch'] })`:
- returns `action:'tool'` with `tool_name` `web_search`/`web_fetch` → execute that tool.
- returns `finish` / `tool_batch`, **or throws** → treat as **answer now** (never surface an error). This is the data-loss fix: a non-tool / unparseable decision turn falls through to the streamed prose answer instead of erroring.

No new parser needed.

### Streamed orchestrator (`src/status-server/chat.ts`)

```ts
export type WebStreamPhase = 'decision' | 'answer';

export type WebStreamProgress =
  | { kind: 'thinking'; phase: WebStreamPhase; thinking: string }   // cumulative for the active turn
  | { kind: 'answer'; answer: string }                              // cumulative, final turn only
  | { kind: 'tool_start'; toolCallId: string; turn: number; maxTurns: number; command: string }
  | { kind: 'tool_result'; toolCallId: string; turn: number; maxTurns: number; command: string; outputSnippet: string; outputTokens: number | null };

export type WebStreamTurn = { thinkingText: string; toolMessages: PersistToolMessage[] };

export type WebStreamResult = {
  assistantContent: string;
  turns: WebStreamTurn[];     // one per decision/tool iteration + final answer turn (each → its own thinking bubble)
  usage: ChatUsage;           // aggregated across turns
};

export async function streamDirectChatWebTurn(
  config: Dict,
  session: ChatSession,
  userContent: string,
  webTools: WebResearchTools,
  onProgress: (progress: WebStreamProgress) => void,
  options: { promptPrefix?: string; maxTurns?: number; mockResponses?: string[] },
): Promise<WebStreamResult>;
```

Loop (max `WEB_CHAT_MAX_TOOL_CALLS = 4`):
1. **Decision turn:** `streamChatAssistantMessage(config, session, userContent, p => onProgress({kind:'thinking', phase:'decision', thinking:p.thinkingContent}), { promptPrefix: <preset prefix>, webActionInstruction: WEB_CHAT_DECISION_PROMPT, evidenceMessages })`. Stream **thinking only** (ignore `p.assistantContent`; that channel holds the JSON action). The returned `assistantContent` is the buffered JSON action text.
2. Parse with `parseRepoSearchPlannerAction`. If tool action & under the limit:
   - `onProgress({kind:'tool_start', toolCallId, turn, maxTurns, command})`.
   - `webTools.search|fetch(args)`; build `PersistToolMessage` bubble (reuse the existing tool-bubble builder shape, turn = iteration index).
   - `onProgress({kind:'tool_result', ...})`.
   - push turn `{ thinkingText: decisionThinking, toolMessages: [bubble] }`; append `evidenceMessages` (`assistant`: action JSON, `user`: `Tool <command> output:\n<output>`).
   - continue loop.
   - On tool execution error: emit a `tool_result` bubble with the error text (exitCode ≠ 0), append the error as evidence, and continue to the **answer** turn (don't hard-fail the whole turn).
3. Otherwise (answer / finish / parse failure / limit reached): push the decision turn's thinking as a turn (no tool messages), then run the **answer turn**:
   - `streamChatAssistantMessage(config, session, userContent, p => { onProgress({kind:'thinking', phase:'answer', thinking:p.thinkingContent}); onProgress({kind:'answer', answer:p.assistantContent}); }, { promptPrefix: <WEB_CHAT_ANSWER_PROMPT merged with preset prefix>, evidenceMessages })`.
   - `assistantContent` = streamed answer; push final turn `{ thinkingText: answerThinking, toolMessages: [] }`; aggregate usage; return.

Mock support for tests: `mockResponses` supplies successive decision-turn JSON + final answer text without hitting the network (mirrors `runDirectChatWebLoop`'s old `mockResponses`). Implementation detail: a `mockResponses`-aware variant that returns canned `{assistantContent, thinkingContent}` per turn so tests stay offline.

### `streamChatAssistantMessage` options extension

Extend its `options` to `{ promptPrefix?, webActionInstruction?, evidenceMessages? }` and forward all three to `buildChatCompletionRequest` (already supported). No behavior change for existing callers.

### Route: `POST /messages/stream` (`src/status-server/routes/chat.ts`)

After resolving `config`/`preset`, compute `webEnabled = resolveEffectiveWebSearchEnabled(activeSession.webSearchEnabled === true, getWebSearchOverride(parsedBody.webSearchOverride))`.

- **web on:** run `streamDirectChatWebTurn(...)` with an `onProgress` that maps:
  - `thinking` → `writeSse('thinking', { thinking })` + `phaseTracker.observeThinking`.
  - `tool_start` → `writeSse('tool_start', {...})`.
  - `tool_result` → `writeSse('tool_result', {...})`.
  - `answer` → `writeSse('answer', { answer })` + `phaseTracker.observeAnswer`.
  Persist with `appendChatMessagesWithUsage(..., { turns: result.turns, ... })` (multi-turn thinking + tool bubbles + final answer). `writeSse('done', buildChatSessionResponse(...))`.
- **web off:** unchanged single `streamChatAssistantMessage` path.

`mockResponses` passthrough from `parsedBody` for tests (same convention as repo-search stream).

### Route: `POST /messages` (buffered) — remove web branch

Delete the `if (webEnabled) { runDirectChatWebLoop(...) }` branch (lines ~637-648). The buffered endpoint keeps only `usesProvidedAssistantContent` and the plain `generateChatAssistantMessage` path. Remove now-unused imports (`runDirectChatWebLoop`, `buildWebResearchTools` if unused elsewhere, `PersistToolMessage` if unused).

### Dashboard

- `api.ts` `streamChatMessage`: add `onToolEvent: (event: ChatStreamToolEvent) => void` param; pass it to `consumeChatStream` instead of `() => {}`. Signature becomes `(sessionId, payload, onThinking, onToolEvent, onAnswer)`.
- `useChatComposer.ts`: delete the buffered direct-chat branch / `resolveDirectChatSend.useBuffered`. Direct chat **always** calls `streamChatMessage` with `webSearchOverride` in payload and an `onToolEvent` that appends/updates tool bubbles (reuse the same tool-bubble handler used by plan/repo-search streaming). Keep the post-send `webSearchOverride → 'default'` reset.
- No change needed in `ChatStreamReader`/`consumeChatStream` (already decode all event kinds).

### Delete

- `src/status-server/chat.ts`: `runDirectChatWebLoop`, `buildWebToolBubble` (replace with the orchestrator's bubble construction — extract a shared `buildWebToolBubble` kept only if reused), `WEB_CHAT_JSON_ACTION_PROMPT`, `WebChatLoopResult`.
- `tests/status-server-chat.test.ts`: tests asserting buffered loop behavior → rewrite against `streamDirectChatWebTurn`.

---

## File Map

- Modify `src/status-server/chat.ts`: add `WEB_CHAT_DECISION_PROMPT`, `WEB_CHAT_ANSWER_PROMPT`, `streamDirectChatWebTurn`, extend `streamChatAssistantMessage` options; remove buffered loop + old prompt.
- Modify `src/status-server/routes/chat.ts`: streamed web branch in `/messages/stream`; remove web branch from `/messages`; clean imports.
- Modify `dashboard/src/api.ts`: `streamChatMessage` forwards tool events.
- Modify `dashboard/src/hooks/useChatComposer.ts`: direct chat always streams; tool-bubble handler.
- Tests: `tests/status-server-chat.test.ts` (orchestrator), `tests/dashboard-status-server.test.ts` (SSE web stream e2e against mock), `dashboard/tests/hooks/useChatComposer.test.tsx` (routing), plus any `streamChatMessage` unit test.

---

## Task 1: Extend `streamChatAssistantMessage` options

**Files:** `src/status-server/chat.ts`, `tests/status-server-chat.test.ts`

- [ ] **Step 1 (test):** assert `streamChatAssistantMessage` injects `webActionInstruction` + `evidenceMessages` into the request system content / messages (use a mock transport or assert via `buildChatCompletionRequest` already covered; here assert the option is forwarded). Failing first.
- [ ] **Step 2 (impl):** widen `options` to `{ promptPrefix?, webActionInstruction?, evidenceMessages? }`; forward to `buildChatCompletionRequest`.
- [ ] **Step 3:** run `tests/status-server-chat.test.ts` green; `tsc -p` clean.

## Task 2: Streamed orchestrator `streamDirectChatWebTurn`

**Files:** `src/status-server/chat.ts`, `tests/status-server-chat.test.ts`

- [ ] **Step 1 (test, mock-driven):** `mockResponses` = [decision `{"action":"web_search","query":"osrs iron bar"}`, decision `{"action":"answer"}`, answer `"Iron bars ..."]`. Stub `WebResearchTools` (inject a fetch impl returning canned SearXNG JSON). Assert: progress sequence emits `thinking`(decision) → `tool_start` → `tool_result` → `thinking`(answer) → `answer`; result `assistantContent === "Iron bars ..."`; `turns.length === 2` (tool turn + answer turn); tool turn has one `PersistToolMessage`.
- [ ] **Step 2 (test):** decision returns `{"action":"answer"}` immediately → no tool calls, one answer turn, prose preserved.
- [ ] **Step 3 (test, the bug):** decision turn returns invalid/prose JSON → treated as answer; final answer streams; **no** "Web research could not be completed" string ever produced.
- [ ] **Step 4 (test):** tool-call limit (`maxTurns`) reached → forced answer turn, no error.
- [ ] **Step 5 (test):** `web_fetch` execution throws → `tool_result` bubble with non-zero exit + error text; loop proceeds to answer turn.
- [ ] **Step 6 (impl):** implement orchestrator + prompts per Target Design. Reuse `parseRepoSearchPlannerAction`; tolerant fallback to answer.
- [ ] **Step 7:** all Task 2 tests green; branch coverage on every loop branch (tool, answer, parse-fail, limit, tool-error).

## Task 3: Remove buffered web path

**Files:** `src/status-server/chat.ts`, `src/status-server/routes/chat.ts`, `tests/status-server-chat.test.ts`

- [ ] **Step 1:** delete `runDirectChatWebLoop`, `buildWebToolBubble` (or fold into orchestrator), `WEB_CHAT_JSON_ACTION_PROMPT`, `WebChatLoopResult`; remove buffered web branch in `POST /messages`; remove dead imports.
- [ ] **Step 2:** delete/rewrite buffered-loop tests. Confirm no remaining references (`tsc` fails loud on any leftover).
- [ ] **Step 3:** `npm run build:test` clean.

## Task 4: Wire streamed web into `/messages/stream`

**Files:** `src/status-server/routes/chat.ts`, `tests/dashboard-status-server.test.ts`

- [ ] **Step 1 (test, e2e):** `withTestEnvAndServer`, web-enabled session, POST `/messages/stream` with `mockResponses`. Parse the SSE byte stream; assert event order `thinking` … `tool_start` `tool_result` … `thinking` `answer` … `done`; `done` payload session has tool-call bubble + final answer message; assert the persisted session in SQLite has the tool bubble and the streamed answer (not an error). Failing first.
- [ ] **Step 2 (test):** web-off session over the same endpoint still uses the single-completion path (regression).
- [ ] **Step 3 (impl):** add the `webEnabled` branch calling `streamDirectChatWebTurn`, mapping progress → `writeSse`, persisting `turns`; thread `mockResponses`.
- [ ] **Step 4:** tests green.

## Task 5: Dashboard streaming client + routing

**Files:** `dashboard/src/api.ts`, `dashboard/src/hooks/useChatComposer.ts`, `dashboard/tests/hooks/useChatComposer.test.tsx`

- [ ] **Step 1 (test):** `useChatComposer` direct-chat send (web on AND web off) calls `streamChatMessage` (never `appendChatMessage`); `webSearchOverride` resets to `default` after send; tool events from the stream append tool bubbles. Failing first.
- [ ] **Step 2 (impl):** `streamChatMessage` gains `onToolEvent`; `useChatComposer` always streams direct chat and renders tool bubbles via the shared handler; remove `useBuffered`.
- [ ] **Step 3:** `$env:TSX_TSCONFIG_PATH='dashboard/tsconfig.json'` dashboard tests green; `tsc -p dashboard/tsconfig.json --noEmit` clean.

## Task 6: Full verification

- [ ] `npm run build:test` (tsc) clean.
- [ ] `npm test` — full root suite green (no buffered-loop tests remain; new orchestrator + e2e green).
- [ ] Dashboard suite green.
- [ ] Manual/live smoke (optional, off-by-default network): web-on "What do you know about osrs iron bars?" streams thinking live, no JSON leak, prose answer preserved; a fluctuating-data question (e.g. "current GE price of an iron bar") triggers a `web_search` tool bubble then a streamed answer.

---

## Test Plan (coverage targets)

- `streamDirectChatWebTurn`: tool path, immediate-answer path, parse-failure→answer (bug fix), limit-reached→answer, tool-execution-error→answer, evidence accumulation, multi-tool (search then fetch). Each branch asserted.
- `/messages/stream`: web-on SSE event ordering + persistence; web-off regression; disabled-gate (override `off` on an enabled session → web-off path, no tool events).
- Dashboard: routing always-stream; override reset; tool-bubble rendering from stream.
- Security regression: forged `web_search` decision while gate disabled is impossible because the route only runs the web branch when `webEnabled`; the parser still excludes web tools from the default name set.

## Risks / Notes

- **Double thinking:** decision turn + answer turn each stream reasoning → two thinking bubbles per answered turn (plus one per tool turn). This matches the approved design ("decision turn reasoning streams live" + "final answer turn streams"). Acceptable; mirrors repo-search per-turn thinking bubbles. If too noisy later, decision turns can be switched to `enable_thinking:false` (separate change).
- **Extra round-trips:** no-web questions now cost 2 model calls (decision + answer) vs 1. Inherent to the split. Decision turns are short.
- **Prompt cache:** web-on system prompt differs from web-off (decision prompt appended), so toggling still re-prefills once; steady-state web-on reuses cache. Unchanged from current behavior.
- **Fluctuating-data prompt:** lives in `WEB_CHAT_DECISION_PROMPT` (drives the search decision) and is reinforced in `WEB_CHAT_ANSWER_PROMPT`. Examples included: live/GE/market prices, currency & crypto rates, stock quotes, breaking news/current events, weather, sports scores/standings, release dates, latest software/library versions.
- **No worktrees** (CLAUDE.md). Single branch, complete refactor, fail-loud on any leftover reference.

## Out of Scope

- Streaming for plan/repo-search web (already streamed via their engines).
- Changing web provider/search/fetch internals (`src/web-search/*` unchanged except as consumers).
- Persisted-summary/condense interactions beyond existing behavior.

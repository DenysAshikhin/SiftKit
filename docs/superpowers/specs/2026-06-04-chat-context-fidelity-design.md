# Chat persistence 1:1 with LLM context (per-turn thinking bubbles)

Date: 2026-06-04

## Problem

After a dashboard repo-search (and plan) run completes, the live thinking bubbles
disappear. They are streamed live, then `resetLive()` clears them, and the
persisted session contains no thinking message, so nothing re-renders.

The deeper requirement: **the persisted dashboard chat must be 1:1 with the
conversation context the LLM sees** for every UI conversation type (chat, plan,
repo-search), except for injected execution flags (e.g. `rg` flags) where the
model-visible command is shown, not the executed command.

## Root cause

`/repo-search/stream` (`src/status-server/routes/chat.ts:1264`) and `/plan/stream`
(`src/status-server/routes/chat.ts:1050`) call
`appendChatMessagesWithUsage(..., thinkingContent='')`. Thinking is streamed live
as per-turn bubbles but persisted as nothing. On completion the dashboard
`finally` block calls `resetLive()` (`dashboard/src/hooks/useChatComposer.ts:214`),
clearing the live thinking, and the persisted session has no thinking to replace
it.

Regular single-turn chat is unaffected: it persists its real thinking
(`src/status-server/routes/chat.ts:763`) and already conforms.

## Governing principle

The persisted `session.messages` array **is** the context.
`buildChatCompletionRequest` (`src/status-server/chat.ts:260-312`) maps every
persisted message 1:1 into the model request:

- tool-call messages use the model-visible command (`toolCallCommand`), formatted
  as `Tool call: <cmd>\n\nResult:\n<output>`;
- `assistant_thinking` messages replay as plain assistant content;
- ordering is preserved verbatim.

The frontend (`dashboard/src/tabs/ChatTab.tsx`) renders persisted messages in
array order. Therefore "UI = context" reduces to: **persist exactly the bubbles,
in execution order.** No frontend change is required.

## Decisions

1. **Fidelity: per-turn interleaved.** A planner run is a multi-turn loop
   (thinking → tool calls → thinking → … → final answer). Each turn's thinking is
   persisted as its own `assistant_thinking` bubble placed immediately before that
   turn's tool-call messages, in real execution order. The final turn's thinking
   (the reasoning before the answer markdown) is persisted as its own bubble
   immediately before the `assistant_answer`.

2. **Persistence refactor (complete, no legacy).** `appendChatMessagesWithUsage`
   replaces its single `thinkingContent: string` argument and flat
   `options.toolMessages` with an ordered, typed `turns` input:

   ```ts
   type PersistToolMessage = {
     id: string; content: string; toolCallCommand: string;
     toolCallTurn: number; toolCallMaxTurns: number; toolCallExitCode: number | null;
     toolCallPromptTokenCount?: number | null;
     toolCallOutputSnippet: string; toolCallOutput: string; outputTokens: number | null;
   };
   type PersistTurn = { thinkingText: string; toolMessages: PersistToolMessage[] };
   // ...append(..., answerContent, usage, { turns: PersistTurn[], ...telemetry })
   ```

   The builder fails loud (throws) on a command missing a positive `turn` — no
   silent `0`/`null` fallback. **Intentional behavior change:** `toolCallMaxTurns`
   moves from the old per-task command count to `task.turnsUsed` (validated to a
   positive integer ≥ the max command turn), the correct "turn X of Y"
   denominator.

   For each turn in order: emit an `assistant_thinking` message when
   `thinkingText` is non-empty, then that turn's tool-call messages. After all
   turns, emit the single `assistant_answer` (carrying run telemetry). Regular
   chat passes a single turn `[{ thinkingText, toolMessages: [] }]` and produces
   the same result as today.

3. **Per-turn thinking data source: thread real turn through the engine result.**
   The result's current `toolCallTurn` is a fake per-task command index
   (`buildToolMessagesFromRepoSearchResult` sets `index + 1`,
   `src/status-server/chat.ts:929`), not the planner's real turn, so streamed
   thinking (keyed by the real `turn`) cannot be reliably joined to result tool
   messages. Therefore:
   - Add `turn: number` to `TaskCommand` (`src/repo-search/prompts.ts:334`), set
     at all six `commands.push` sites in the per-task loop
     (`src/repo-search/engine.ts`, loop var at `:892`).
   - Add `turnThinking: Record<number, string>` to `TaskResult`
     (`src/repo-search/engine.ts:703`), populated once per turn from
     `response.thinkingText` (the native `reasoning_content`) right after the
     model response is obtained — covers normal, invalid-parse, and finish turns.
     `buildScorecard` passes `tasks` through untouched (`:2094`), so it reaches
     the route.
   - Persist from the result uniformly across all three planner endpoints
     (streaming `/plan/stream`, streaming `/repo-search/stream`, and
     **non-streaming `/plan`** which today observes no thinking at all).

   Using `response.thinkingText` (native reasoning) — not scraped streamed deltas
   — is exactly the `reasoning_content` the planner's own context carries, so the
   persisted bubbles are truly 1:1 with context. (The live stream additionally
   shows content-JSON deltas as "thinking"; that is a live artifact, not context.)

   Mock-mode thinking: the mock planner path returns `thinkingText: ''`
   (`src/repo-search/planner-protocol.ts:450-456`). Add inline-`<think>`
   extraction to the mock path (reusing existing `extractInlineThinking`,
   `:105-114`) so tests can drive per-turn thinking deterministically. Mock-only;
   no production effect.

   Considered and rejected: reconstructing interleaving from the live stream by
   execution ordinal. Fragile when streamed tool count != result command count,
   and it cannot serve the non-streaming `/plan` endpoint.

## Scope

In scope:
- `TaskCommand.turn` + `TaskResult.turnThinking` recording in the engine
  (`src/repo-search/engine.ts`, `src/repo-search/prompts.ts`).
- Mock-mode inline-`<think>` extraction (`src/repo-search/planner-protocol.ts`).
- `appendChatMessagesWithUsage` turns-based refactor + new
  `buildPersistTurnsFromRepoSearchResult` builder (`src/status-server/chat.ts`);
  remove the superseded flat `buildToolMessagesFromRepoSearchResult`.
- All five `appendChatMessagesWithUsage` call sites updated
  (`src/status-server/routes/chat.ts:629,763,884,1040,1254`): regular chat passes
  a single turn; planner endpoints pass `buildPersistTurnsFromRepoSearchResult`.

Out of scope:
- `preserve_thinking` / chat-template-level think dropping: a server-side prompt
  rendering detail below the message abstraction; not changed.
- CLI repo-search (`src/cli/run-repo-search.ts`): does not persist to chat
  sessions.
- Any frontend change: the UI already renders persisted messages verbatim.

## Prompt-caching safety

The user requires that these changes not break prompt caching.

- **Planner in-loop prompt unchanged.** Engine edits only *record* `turn` and
  `turnThinking` onto the returned result object; they do not touch the `messages`
  array or `batchOutcomes` sent to the model during the loop. The planner's own
  cache prefix is byte-identical.
- **Replay prefix is append-only and written once.** Per-turn thinking is
  persisted atomically when the turn completes and is never retro-inserted into an
  already-sent prefix; later user messages append after the answer. So the cached
  prefix through the answer stays stable across a growing conversation.
- **Regular chat persistence is byte-identical.** The single-turn refactor must
  reproduce today's persisted messages exactly (guarded by existing tests +
  a determinism test).
- **Determinism.** `buildChatCompletionRequest` on a fixed session is
  deterministic (asserted: two calls deepEqual).
- Pre-existing on-disk sessions are not migrated (no retroactive prefix mutation).

## Testing (TDD, branch coverage)

Failing tests first, then implement:

1. **Mock thinking (engine).** A mock response prefixed with
   `<think>…</think>` yields non-empty `response.thinkingText`; the `<think>`
   block is stripped from `response.text`.

2. **Engine turn recording.** A mock multi-turn run records `command.turn` equal
   to the real planner turn for each command, and `result.turnThinking[turn]`
   equal to that turn's thinking (including the finish turn). Plus branch
   coverage: a duplicate-rejected command push carries its `turn`, and an
   invalid-parse (command-less) turn still records `turnThinking`.

3. **Turn builder (unit, `buildPersistTurnsFromRepoSearchResult`).** A synthetic
   scorecard (commands with `turn`, `turnThinking` map) produces ordered turns:
   thinking-then-tools per turn, ascending; a thinking-only final turn emits a
   trailing bubble; a turn with tools but no thinking emits no bubble; flattened
   tool order equals `buildToolContextFromRepoSearchResult` order;
   `toolCallMaxTurns` equals `task.turnsUsed`; a command missing `turn` throws.

4. **Persistence shape (unit, `appendChatMessagesWithUsage`).** Given ordered
   `turns`, asserts persisted `session.messages` order is `user, think_t1,
   tool_t1.a, tool_t1.b, think_t2, tool_t2, …, think_final, assistant_answer`.
   Empty `thinkingText` omits that bubble. Single-turn input reproduces today's
   output exactly. `hiddenToolContexts` align by index with the persisted tool
   message ids (two tools / two contexts).

5. **Replay fidelity + determinism (`buildChatCompletionRequest`).** A session
   persisted from a multi-turn run replays each turn's thinking as assistant
   content and each tool call with the model-visible command, in order; two calls
   on the same session deepEqual (caching determinism). A second end-to-end test
   runs the real path `buildPersistTurnsFromRepoSearchResult(result)` →
   `appendChatMessagesWithUsage` → `buildChatCompletionRequest`.

6. **Regression.** Existing `tests/status-server-chat.test.ts` and repo-search
   engine tests continue to pass.

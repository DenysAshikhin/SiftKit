# SiftKit Architecture Review

Remaining work items only. Resolved findings are deleted or narrowed as they are fixed, so finding numbers (F-series) and LLM-behavior items (L-series) have gaps. Re-verify every item against current code before acting.

Original audit date: 2026-06-09.
Last pruned: 2026-06-18.

---

## Findings

### F11. Replace execution lease/lock during the server/workspace split

`src/execution-lock.ts` still wraps summary/eval/install execution, and `src/config/execution-lease.ts:36` still acquires a server-side lease. The lock remains live through `src/summary/request-runner.ts:117`, `src/eval.ts:6`, `src/install.ts:6`, `src/command-output/analyzer.ts:179`, `src/status-server/preset-runner.ts:171`, and `src/status-server/routes/core.ts:1056`.

Remaining work: when the server/workspace split lands, replace this cross-process single-slot lease with the new ownership model. Do not delete it as dead code before that split.

### F15. Repackage benchmark/eval code and dedupe bench harness modules

`src/eval.ts:6` and `src/benchmark-spec-settings.ts:1` remain in the shipping `src/` graph. `bench/benchmark/` and `bench/benchmark-matrix/` still carry parallel `args.ts`, `interrupt.ts`, `runner.ts`, and `types.ts` roles.

Remaining work: move eval/benchmark runtime code to the server/workspace package boundary, then factor duplicated bench harness pieces into common bench utilities.

### F16. Split the dashboard monolith and replace mirrored contracts

`dashboard/src/App.tsx` is 1,418 lines, `dashboard/src/styles.css` is 1,763 lines, and `dashboard/src/types.ts` is 471 lines. Config types are shared, but dashboard session/run/preset payloads are still hand-mirrored and consumed directly by tests such as `tests/dashboard-presets.test.ts:5`, `tests/dashboard-metrics-view.test.ts:12`, `tests/dashboard-managed-presets.test.ts:11`, and `tests/preset-editor.test.ts:8`.

Remaining work: split `App.tsx` and `styles.css` into cohesive feature modules, then replace dashboard-local server payload mirrors with a shared typed server contract.

### F17. Split the remaining summary planner god method

`SummaryPlannerLoopRuntime.requestProviderAction` remains in `src/summary/planner/mode.ts:468` and is not covered by `tests/god-function-regression.test.ts:14-19`.

Remaining work: split `requestProviderAction` below the 90-line guard threshold and add it to the regression guard.

---

# Part 2 - LLM-behavior analysis

## L1. Sampling/config ownership remains split across launch args and per-request overrides

`buildManagedLlamaArgs` still launches `llama-server` from the active managed preset in `src/status-server/managed-llama.ts:653`, while request paths can override sampling per call, such as repo-search planner requests using `temperature: 0.1` and `extraBody: { top_p: 0.95 }` in `src/repo-search/planner-protocol.ts:430-448`.

Remaining work: make sampling ownership explicit by request class. The operator-facing managed preset and the actual request-level values must reconcile clearly, especially for JSON/planner, validation, chat, and synthesis workloads.

## L2. Repo-search finish policy still contradicts the prompt

The repo-search prompt still says "Minimum 5 tool-call turns before finish" in `src/repo-search/prompts.ts:247`, but `evaluateFinishAttempt` in `src/tool-loop-governor.ts:195` has no turn-count input and only gates anchored answers with fewer than two evidence-bearing calls.

Remaining work: either remove the fixed 5-turn prompt rule or implement the same rule in code. Prefer evidence sufficiency over fixed call counts so easy, well-supported searches can finish without filler calls.

## L3. Fixed call-count rules still manufacture duplicate/stagnation pressure

The prompt still requires at least 3 `rg` calls among the first 5 calls and at least 5 tool-call turns before finish (`src/repo-search/prompts.ts:239-247`). Duplicate detection still returns "duplicate command requested xN" via `src/tool-loop-governor.ts:188`, and forced-finish state is still managed in the repo-search loop.

Remaining work: scale required search effort to task complexity and evidence sufficiency. Do not force low-complexity lookups to pad with duplicate or irrelevant commands.

## L4. Planner transcripts are still mutated in place

`upsertTrailingUserMessage` replaces an existing trailing user message in `src/tool-call-messages.ts:92`, and repo-search still calls it from `src/repo-search/engine/transcript-manager.ts:91`. Summary planner forced-finish state still calls the same helper in `src/summary/planner/mode.ts:776`.

Remaining work: make harness interventions append-only. Do not overwrite earlier model-visible transcript messages.

## L5. Repo-search compaction can still produce invalid or misleading history

`compactPlannerMessagesOnce` still greedily keeps messages by newest-first token fit in `src/repo-search/prompt-budget.ts:200` without preserving assistant tool-call/tool-response pairs. It also injects `[COMPRESSED HISTORICAL EVIDENCE]` as an assistant message in `src/repo-search/prompt-budget.ts:167`.

Remaining work: compact by protocol-valid message groups and put harness summaries in system/user role or out-of-band metadata, not assistant speech.

## L6. Planner JSON parsing still repairs invalid model output

Repo-search now requests structured JSON output in `src/repo-search/planner-protocol.ts:430-448`, but the shared parser still falls back to `jsonrepair` in `src/lib/model-json.ts:132-143`.

Remaining work: decide where repair is acceptable. For schema-constrained planner actions, invalid JSON should fail loudly enough to measure and fix root causes instead of silently normalizing malformed output.

## L7. Stream-guard narration is still stored as assistant content

When a streamed planner response stops early, `src/repo-search/planner-protocol.ts:518` still prefixes assistant text with `SiftKit stopped the planner stream early: ...`.

Remaining work: store stream-guard intervention text as harness metadata or a system/user message, not assistant-authored content replayed to the model.

## L8. Default chat system prompt remains too weak

`DEFAULT_CHAT_SYSTEM_PROMPT = 'general, coder friendly assistant'` remains in `src/status-server/chat.ts:26`.

Remaining work: replace it with a concise, explicit chat contract covering role, tool-use expectations, output style, grounding behavior, and refusal/error handling.

## L9. Cross-turn tool replay can still substitute truncated snippets for full outputs

Chat replay still uses `trimText(message.toolCallOutput) || trimText(message.toolCallOutputSnippet)` in `src/status-server/chat.ts:69`, `src/status-server/chat.ts:267`, and `src/status-server/chat.ts:303`. Snippets are still capped at 200 characters in `src/status-server/chat.ts:696`.

Remaining work: replay full tool outputs when available, and when only snippets exist, label them as truncated so the model knows to re-fetch instead of treating them as complete evidence.

## L10. Chat condense is still cosmetic for model input

`condenseChatSession` still marks `compressedIntoSummary` and stores a `condensedSummary` in `src/status-server/chat.ts:541`, but `buildChatHistoryMessages` iterates session messages directly from `src/status-server/chat.ts:191` and does not inject `condensedSummary` or skip compressed messages. Context accounting still uses estimates in `ContextUsageBuilder` starting at `src/status-server/chat.ts:77`.

Remaining work: make condense affect the prompt the model sees, preserve tool-call pairs, retain evidence intentionally, and make the context meter reflect rendered prompt tokens as closely as practical.

## L11. Web grounding is still session-wide instead of claim-sensitive

`CHAT_GROUNDING_FINAL_ANSWER_INSTRUCTION` still requires web search before answering in `src/repo-search/chat-grounding-policy.ts:31`, and the chat loop appends it whenever web grounding is enabled in `src/repo-search/engine/task-loop.ts:217`.

Remaining work: require web grounding only when the answer makes external/current factual claims. Formatting, follow-up, and transformation turns should not be forced through web search.

---

## Priority order

1. Split the dashboard monolith and replace dashboard-local server payload mirrors with shared contracts (F16).
2. Split `SummaryPlannerLoopRuntime.requestProviderAction` and add it to the god-function regression guard (F17).
3. Repackage eval/benchmark code and dedupe bench harness modules during the server/workspace split (F15).
4. Fix repo-search/chat LLM behavior in this order: append-only/non-assistant harness messages (L4, L5, L7), finish policy and duplicate pressure (L2, L3), parser repair boundaries (L6), real chat condense and prompt accounting (L10), sampling ownership by request class (L1), default prompt and web-grounding scope (L8, L11), tool replay truncation labeling (L9).

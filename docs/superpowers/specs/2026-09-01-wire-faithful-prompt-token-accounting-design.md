# Wire-Faithful Prompt Token Accounting — Design

**Status:** approved (design), pending implementation plan
**Date:** 2026-09-01
**Backend focus:** exl3 (TabbyAPI). llama.cpp is being deprecated and is not the design target, but must keep working.

## Problem

The `prompt=<N>tok` figure printed on the repo-search progress line does not describe the prompt the model actually receives.

It is produced by counting `renderTaskTranscript` output (`src/repo-search/planner-protocol.ts:840-867`) — a `[role]`-header prose rendering — and deliberately excludes the serialized tool schemas. Three distinct errors, largest first:

1. **Tool schemas excluded.** `providerPromptReserveText` (`src/repo-search/planner-protocol.ts:293-324`) holds the serialized `tools` array, `response_format`, and sampler defaults. It is added to `promptTokenCount` but subtracted from the displayed figure by design — see the comment at `src/repo-search/engine/prompt-preparer.ts:38-41` ("Progress shows the prompt the model receives, so the request reserve is dropped here too"). That rationale is inverted: the model does receive the tool definitions.
2. **Counted text is not wire text.** The tokenizer sees transcript prose; the server receives JSON messages rendered through the model's chat template. Concrete divergences:
   - `tool_call_id=call_1` (transcript) vs `"tool_call_id": "call_1"` (wire).
   - `[reasoning]\n...` section (transcript) vs a `reasoning_content` field (wire).
   - Transcript-only fallback defaults in `tool_calls` rendering — `id || null`, `type || 'function'`, `name || ''`, `arguments || {}` — that never appear on the wire (`toProtocolChatMessages`, `src/repo-search/planner-protocol.ts:389-403`).
   - `extractContentText` (`src/llm-protocol/image-attachments.ts:127-134`) drops image parts and joins text parts with a single space; the wire keeps the parts array.
3. **Template scaffolding approximated.** The reserve models it as a fixed per-role string `<|im_start|>role\ncontent<|im_end|>\n` (`src/repo-search/planner-protocol.ts:321`).

## Constraints

- **Provider counts are off-limits.** `docs/superpowers/plans/2026-08-17-token-reporting-and-exl3-thinking-budget.md` records a user-approved decision never to trust provider `prompt_tokens` on the agent-loop reporting path: exllamav3 1.3.0 inflates prompt counts on requeued jobs. `usage.prompt_tokens` is parsed (`src/lib/provider-helpers.ts:265`) but must not feed this number.
- **No template access.** exl3 tokenization is `POST /v1/token/encode` with `{ text }` — raw text only (`src/llm-protocol/llama-cpp-client.ts:155-161`). No apply-template endpoint exists in the codebase, and no TabbyAPI endpoint retrieves or renders the active chat template. Tabby loads the model folder's `chat_template.jinja` (`docs/exl3-backend-setup.md:19`); rendering it locally was considered and rejected (see Rejected alternatives).
- **Exactness ceiling.** Because the template is applied server-side and invisible, the template scaffolding cannot be measured, only modelled. This design closes errors 1 and 2 exactly and leaves error 3 as a bounded approximation.
- **Pre-existing caveat.** `IncrementalTokenCounter` accumulates per-tail delta sums and flags them `approximate: true` (`src/repo-search/incremental-token-counter.ts:43-56`). The displayed number is therefore a sum of tail tokenizations, not a single full tokenize. Unchanged by this work.

## Decision

Replace the two-pass `transcript + reserve` computation with a **single wire-faithful count**.

`reported` and `budgeted` collapse into one number. `buildPlannerRequestPromptReserveText` and `reserveTokenCounter` are deleted outright — complete replacement, no parallel path, no compatibility shim.

This changes the input to overflow/compaction checks and `getDynamicMaxOutputTokens` (`src/repo-search/engine/prompt-preparer.ts:172-176`). The semantics are identical (both figures mean "tokens the request will occupy"); only the accuracy improves. Accepted deliberately in preference to adding a third counter and a third tokenization pass.

## Architecture

### New component

`renderWirePrompt(messages, tools, responseFormat)` in `src/repo-search/planner-protocol.ts`, emitting ChatML-shaped text:

```
<|im_start|>system\n{system content}\n\n{tools JSON}\n{response_format JSON}<|im_end|>\n
<|im_start|>user\n{content}<|im_end|>\n
<|im_start|>assistant\n{reasoning_content}{content}{tool_calls JSON, wire shape}<|im_end|>\n
<|im_start|>tool\n{content}<|im_end|>\n
```

Message bodies are serialized by the existing wire path (`toProtocolChatMessages`, `src/repo-search/planner-protocol.ts:389-403`) — not by transcript rendering. Roles use the canonical four-role coercion already in `toLlamaChatRole` (`:385-387`).

Tool schemas and `response_format` go in the **leading system block**, matching where ChatML templates place them and keeping the string a growing prefix as messages append.

`renderTaskTranscript` is retained for its display/transcript role and is no longer used for counting.

### Data flow

`PromptPreparer.prepareTurn` (`src/repo-search/engine/prompt-preparer.ts:124-315`) builds the wire text instead of `transcript.render(...)` at `:139`, and passes a single counter to `preflightPlannerPromptBudget`. In `src/repo-search/prompt-budget.ts:108-192`, `providerPromptReserveText` / `reserveTokenCount` / `providerPromptReserveTokenCount` are removed; `promptTokenCount = wireTokenCount + imageTokenCount` (image allowance logic at `:134-137` is unchanged). `prepareTurn` returns a single `promptTokenCount` rather than `{ reported, budgeted }` (`:305-310`).

The post-compaction re-preflight path (`:248-263`) collapses the same way.

### Display sites — unchanged

All three read the value off the progress event, so none require edits:

- CLI progress line — `src/cli/progress-renderer.ts:68-72` via `formatPromptTokensField` (`src/lib/text-format.ts:64-66`).
- Status-server log body — `src/status-server/dashboard-runs.ts:266-273`.
- Preflight log — `src/repo-search/execute.ts:75` and `:124`.

Progress event schemas (`src/repo-search/types.ts:55-62`) and `ProgressReporter.llmStart/llmEnd` (`src/repo-search/engine/progress-reporter.ts:85-91`) keep their existing `promptTokenCount` field. Call sites in `TaskLoop` (`src/repo-search/engine/task-loop.ts:494`, `:519`) pass the single number instead of `prepared.promptTokens.reported`.

The dashboard front-end is out of scope and untouched.

### Counter lifetime

`PromptPreparer` holds one `IncrementalTokenCounter` instead of two (`src/repo-search/engine/prompt-preparer.ts:79-80`), constructed per task via `TaskLoop` (`src/repo-search/engine/task-loop.ts:285`). Prefix violations (e.g. a changed tool set mid-task) degrade to a full re-tokenize — a cost, not a correctness risk (`src/repo-search/incremental-token-counter.ts:66-73`).

## Error handling

Unchanged. Tokenize failure or a zero count falls through to `estimateTokenCount` with `source: 'estimate'` (`src/repo-search/prompt-budget.ts:47-51`; `src/lib/token-estimate.ts:18-20`). The `oneShotTokenCounter` fallback for callers that pass no counter (`src/repo-search/prompt-budget.ts:81-85`, used at `:139-140`) is retained. No new failure modes.

## Testing

TDD: failing test, minimum implementation, passing test.

- **Unit — `renderWirePrompt` shape.** Hand-built message set covering system, user, assistant with `reasoning_content`, assistant with `tool_calls`, tool result with `tool_call_id`, and content-parts arrays including images. Assert exact output.
- **Regression — transcript markers absent.** Counted text contains tool schema names and contains no `[reasoning]` or `tool_call_id=` markers.
- **Integration — the actual bug.** Extend the fake-tokenize-server harness (pattern in `tests/engine-token-usage.test.ts`) to assert the reported count *rises* when a tool is added to an otherwise identical turn. Under today's code it does not.
- **Prefix behavior.** Appending a message deltas; changing the tool set forces a full re-tokenize and still yields the correct total.
- **Existing suites to update:** `tests/repo-search-prompt-accounting.test.ts`, `tests/engine-prompt-preparer.test.ts`, `tests/incremental-token-counter.test.ts`, `tests/repo-search-request-normalizers.test.ts`, `tests/mock-repo-search-loop.test.ts`. Their current assertions have not yet been read; the implementation plan must inspect each and update only those asserting the replaced behavior. Do not weaken valid tests.

Gates: `npm run typecheck`, `npm run lint`, and the broader suite.

## Rejected alternatives

- **Render `chat_template.jinja` locally.** Exact by construction, but requires a Jinja2-compatible TS engine, model-folder path resolution, and introduces silent-divergence risk: a renderer that drifts from Tabby's produces a confidently wrong number in a display path. Rejected as disproportionate.
- **Use provider `usage.prompt_tokens`.** Ruled out by the prior user-approved decision above; also unavailable before the request, so it cannot serve `llm_start` or budgeting.
- **Display the existing `budgeted` figure.** One-line change fixing only error 1, leaving the transcript-vs-wire mismatch intact.

## Out of scope

- Dashboard front-end rendering.
- Chat-session telemetry (`src/status-server/chat-turn-telemetry.ts`).
- The `approximate: true` delta-sum caveat in `IncrementalTokenCounter`.
- llama.cpp-specific tuning beyond keeping the backend functional.

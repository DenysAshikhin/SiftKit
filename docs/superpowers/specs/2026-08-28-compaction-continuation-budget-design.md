# Thinking-budget continuation: spend the real remainder

## Problem

When the context-compaction summarizer exhausts its thinking budget, the client
cuts the stream and issues a second request to write the summary. That second
request is handed a static token allowance computed up front — one third of the
generation reserve — rather than whatever the generation budget actually has
left. Thinking spend is also never measured; it is inferred from a character
count.

Two consequences:

1. When the provider reports a real thinking spend below the character estimate,
   the summary is written under a smaller allowance than the budget can afford.
2. Callers that do not pass a continuation allowance (every caller except
   compaction) get a *full re-grant* of `maxTokens` for the continuation,
   double-spending the generation budget.

Note what is **not** broken: on the path where thinking finishes under budget,
no second request happens and the answer already draws on
`maxTokens - actualThinking`. The static allowance only binds after an
early stop.

## Approach

Derive the continuation allowance from measured thinking spend, and reinterpret
the caller-supplied number as a floor rather than a cap.

### Resolving thinking spend

A single rule, shared by the streaming gate and the continuation:

```
resolveSpentThinkingTokens(config, reportedThinkingTokens, reasoningText)
  = reportedThinkingTokens > 0
      ? reportedThinkingTokens
      : estimateTokenCountFromCharacters(config, reasoningText.length)
```

Reported counts are trusted only when positive. Some backends stream
`reasoning_tokens: 0` on every frame and emit the real figure only in the final
usage payload; reading that as "nothing spent" would keep the gate from ever
firing and let `max_tokens` truncate the model mid-thought. The estimate
fallback preserves current behaviour for those backends.

### Continuation allowance

```
spent = resolveSpentThinkingTokens(config, streamed.usage.thinkingTokens, streamed.reasoningText)
cap   = max(1, continuationMinTokens ?? 0, maxTokens - spent)
```

`continuationMinTokens` replaces `continuationMaxTokens`. Compaction passes the
one-third share it already computes, so today's allocation becomes the
guaranteed minimum and any measured headroom is added on top. Callers that pass
nothing get the true remainder instead of a second full budget.

## Changes

| File | Change |
| --- | --- |
| `src/lib/token-estimate.ts` | Add `resolveSpentThinkingTokens`. |
| `src/llm-protocol/llama-cpp-client.ts` | Gate compares resolved spend against the budget; `continuationMaxTokens` option becomes `continuationMinTokens`; `continueAfterThinkingBudget` derives the allowance. |
| `src/repo-search/planner-protocol.ts` | Rename the option on `PlannerProtocolOptions` and `requestContextCompactionSummary`, and both pass-throughs. |
| `src/repo-search/engine/transcript-compactor.ts` | Pass `continuationMinTokens: generationTokens.outputTokens`; correct the doc comment describing the split. |
| `src/repo-search/engine/turn-budget.ts` | Correct the comment on `splitCompactionGenerationTokens`: the output share is a floor and a prompt-reserve input, not an output cap. |

`splitCompactionGenerationTokens`, `COMPACTION_SUMMARY_MIN_OUTPUT_TOKENS`, the
`compactionReserveTokens` sizing, and the `planner_compaction_prompt_overflow`
failure are unchanged. The rename is a complete replacement: no alias for the
old option name is kept.

## Behaviour

Compaction with a 15,000-token reserve and a 10,000-token thinking gate:

| Thinking spend | Today | After |
| --- | --- | --- |
| 4,000, gate never fires | 11,000 | 11,000 (unchanged) |
| 10,000 reported | 5,000 | 5,000 (floor holds) |
| 6,200 reported | 5,000 | 8,800 |
| No provider counts | 5,000 | ~5,000 (estimate approximates the gate) |

Planner turns, which pass no floor, drop from a full `maxTokens` re-grant to
`maxTokens - spent`.

## Testing

Extend `tests/llama-cpp-client-thinking-budget.test.ts`; its fake SSE server
gains the ability to emit `completion_tokens_details.reasoning_tokens`.

- Provider reports a spend below the gate: the continuation request carries
  `max_tokens == maxTokens - reported`, above the floor.
- Remainder falls below the floor: the floor is used.
- No floor supplied: the continuation carries `maxTokens - spent`, not
  `maxTokens`.
- A positive reported count trips the budget before the character estimate
  would: the gate fires on the reported count.
- Every frame reports `reasoning_tokens: 0`: the estimate fallback applies and
  the gate still fires.

The existing assertion that a compaction continuation carries `max_tokens == 4`
stays valid: spend resolves to roughly 9 of 12, leaving a remainder of 3, so the
floor of 4 wins.

## Risks

- Backends that report thinking tokens now stop at the true budget rather than
  at the character estimate, so the early stop can fire earlier or later than it
  does today. This is the intended correction, but it changes where thinking is
  cut on those backends.
- Planner-turn continuations get a smaller allowance than today. That allowance
  was previously an over-grant, so a continuation that relied on it could now
  run shorter.

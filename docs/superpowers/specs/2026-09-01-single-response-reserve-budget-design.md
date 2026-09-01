# Single Response Reserve Budget Design

**Date:** 2026-09-01
**Status:** Approved

## Goal

Make the configured response reserve the only context-capacity reservation in SiftKit. For the active 155,000-token preset with a 15,000-token response reserve, every ordinary planner operation gets one 140,000-token prompt limit. Compaction receives no additional fixed prompt carve-out.

## Approved invariant

Every context-aware operation derives the same three values from one resolver:

```text
totalContextTokens = configured NumCtx
responseReserveTokens = min(RESPONSE_RESERVE_TOKENS, preset MaxTokens, floor(totalContextTokens / 2))
maxPromptTokens = totalContextTokens - responseReserveTokens
```

For the active preset:

```text
totalContextTokens = 155,000
responseReserveTokens = 15,000
maxPromptTokens = 140,000
```

The response reserve covers all generated tokens for one request: reasoning plus visible output. Compaction may continue to allocate that response reserve internally as two-thirds reasoning and a one-third visible-summary floor, with unused reasoning flowing to visible output. That allocation does not reduce `maxPromptTokens`.

## Current defect

`TurnBudget` currently subtracts two additional values from the prompt capacity:

```text
summaryOutputTokens = floor(responseReserveTokens / 3)
compactionPromptHeadroomTokens = 6,000
usablePromptTokens = maxPromptTokens - summaryOutputTokens - compactionPromptHeadroomTokens
```

With a 15,000-token response reserve, this creates an 11,000-token hidden carve-out and lowers tool-result capacity from 140,000 to 129,000 tokens. Planner preflight still compacts only after 140,000 tokens. The mismatch creates a blind zone where tools execute but their results receive zero insertion allowance.

The observed run `3a756f6b-a2c9-4f8c-a425-c8b059d5c6ac` entered that zone at turn 44. Tool execution continued through turn 55 while every result was replaced by a truncation marker. Compaction finally occurred at turn 57.

## Architecture

### One context-budget resolver

`src/lib/response-reserve.ts` will own a single `resolveContextTokenBudget` function returning:

```ts
export type ContextTokenBudget = {
  totalContextTokens: number;
  responseReserveTokens: number;
  maxPromptTokens: number;
};

export function resolveContextTokenBudget(options: {
  totalContextTokens: number;
  config: SiftConfig | null | undefined;
}): ContextTokenBudget;
```

`computeResponseReserveTokens` will be removed. Consumers that need one field must resolve the complete budget and select that field. This prevents consumers from independently reconstructing prompt capacity.

Operation-specific output ceilings such as approval verdict limits and assistant response limits may remain below `responseReserveTokens`. They are output-product limits, not context reservations, and must never reduce `maxPromptTokens`.

### Turn budgeting

`TurnBudget` will expose:

```ts
readonly totalContextTokens: number;
readonly responseReserveTokens: number;
readonly maxPromptTokens: number;
```

It will no longer expose `compactionReserveTokens` or `usablePromptTokens`. Both `perToolCapTokens` and `remainingToolAllowance` will derive from `maxPromptTokens`.

The growing per-turn tool-result share, batch division, and failed-command tail cap remain unchanged. They control how much of the available prompt budget one result may consume; they do not create another global reservation.

### Planner preflight

Ordinary planner preflight receives `maxPromptTokens` from `TurnBudget`; it does not recompute the limit from total context and reserve values. Repo-search, repo-agent, and chat therefore use the identical threshold.

Prompt token measurement will remain reusable separately from prompt policy. Compaction and terminal synthesis need to measure their actual rendered prompts so they can dynamically fit generation into the remaining physical context. That measurement is not a second budget and introduces no static reserve.

### Compaction

Compaction keeps one generation ceiling: `responseReserveTokens`. Its internal reasoning/output split remains derived from that ceiling.

The following are removed from compaction admission:

- The fixed 6,000-token prompt headroom.
- The prompt-side subtraction of the one-third summary output allocation.
- Tests asserting a worst-case transcript based on either removed value.

The compactor renders and tokenizes its actual request, computes `totalContextTokens - actualPromptTokenCount`, and clamps its generation allocation to the smaller of that physical remainder and `responseReserveTokens`. If fewer than `COMPACTION_SUMMARY_MIN_OUTPUT_TOKENS` remain, it retains the current explicit overflow failure.

### Tool execution at zero allowance

A tool must never execute when its result cannot be represented in the transcript.

Before approval and before `turn_command_start`, `ToolActionProcessor` resolves the current tool-result budget. When `remainingTokenAllowance === 0`:

- The native tool is not executed.
- The approval gate is not invoked.
- A rejected command result is recorded with `exitCode: null` and `rejectionKind: 'budget'`.
- The model-visible result states that context capacity was exhausted, the tool was not executed, and the action must be reissued after compaction.
- Remaining actions in the same batch receive the same non-executed budget rejection.

On the next turn, the rejection exchange makes the prompt cross the shared boundary. Repo-agent and chat compact through their existing `contextOverflowPolicy: 'compact'`; repo-search follows its existing `force_answer` policy. No new compaction pathway is introduced.

`ToolResultBudgeter` will reject a zero or invalid allowance as an internal invariant violation. It will no longer convert zero into a one-token budget and emit a larger truncation marker.

## Telemetry

Existing telemetry names remain stable where their meaning is already correct:

- `maxPromptBudget` continues to report the resolved `maxPromptTokens` value.
- `remainingTokenAllowance` continues to report the current capacity for tool results.
- Budget-rejected tools remain `turn_command_result` events with `rejectionKind: 'budget'`.

The budget rejection message must include `prompt_tokens`, `max_prompt_tokens`, and `remaining_tool_tokens=0` so a transcript audit can prove why execution was blocked.

Removed fields and concepts must not survive in code, tests, comments, or current documentation:

- `COMPACTION_PROMPT_HEADROOM_TOKENS`
- `compactionReserveTokens`
- `usablePromptTokens`
- “compaction reserve” as a second prompt reservation

Historical plans and handoffs remain historical records and are not rewritten.

## Error handling

- Invalid configured context or preset output limits continue to fail through the existing runtime-schema and preset validation paths.
- A zero tool-result allowance is an expected budget rejection before side effects, not a tool failure.
- Reaching `ToolResultBudgeter` with zero allowance is a programming error and throws with the task, turn, tool, prompt, and maximum-prompt values.
- Compaction with insufficient physical generation room continues to fail with `planner_compaction_prompt_overflow`.
- Repo-search retains `force_answer`; repo-agent and chat retain `compact`.

## Testing strategy

Tests must prove the invariant at four levels:

1. Unit arithmetic: one resolver and one prompt limit across large, small, preset-clamped, and invalid inputs.
2. Turn budgeting: tool caps and remaining allowance use `maxPromptTokens` with no hidden subtraction.
3. Side-effect safety: zero allowance blocks execution and approval before any command starts.
4. Loop behavior: compacting modes recover and can reissue work; repo-search stops without executing the blocked action.

Regression coverage must include the active-preset arithmetic:

```text
155,000 total - 15,000 response = 140,000 prompt
```

and must prove there is no token interval where planner preflight is healthy while tool-result allowance is already zero.

## Non-goals

- Changing the configured `RESPONSE_RESERVE_TOKENS = 15_000` value.
- Changing the active preset `NumCtx` or `MaxTokens`.
- Removing compaction’s internal reasoning/output allocation.
- Changing validation-output line shaping, duplicate-command detection, or raw-output persistence.
- Adding rollback or transactions for successful mutations; this design prevents only zero-capacity execution.
- Removing purpose-specific output caps that are less than the shared response reserve.

## Acceptance criteria

- `resolveContextTokenBudget({ totalContextTokens: 155_000, config })` returns `{ totalContextTokens: 155_000, responseReserveTokens: 15_000, maxPromptTokens: 140_000 }` for a preset with `MaxTokens >= 15_000`.
- No current source or test references `COMPACTION_PROMPT_HEADROOM_TOKENS`, `compactionReserveTokens`, or `usablePromptTokens`.
- Ordinary planner preflight and tool-result allowance use the same `maxPromptTokens` value.
- A tool at zero remaining allowance produces no approval request, no `turn_command_start`, and no side effect.
- Compaction generation remains bounded by the same response reserve and the physical context remainder.
- Repo-search, repo-agent, chat, manual condense, idle summary, dynamic output caps, and line-read guidance all resolve context capacity from the shared resolver or from a `TurnBudget` created from it.
- Relevant focused tests, broader tests, `npm run typecheck`, and `npm run lint` pass.


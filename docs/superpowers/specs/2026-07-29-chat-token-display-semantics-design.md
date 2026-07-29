# Chat Token Display Semantics

Date: 2026-07-29
Status: approved

## Problem

The chat UI shows two token figures that measure different quantities without saying so, and a
reader naturally tries to reconcile them.

A live repo-search turn renders a turn header reading `44,423 known tokens` while a tool card
inside that same turn reads `✓ 66k tok loaded`. Both numbers are correct for what they measure;
neither label says what that is.

- The tool card renders `toolCallPromptTokenCount`
  (`dashboard/src/components/ToolCallCard.tsx:10-22`). That value originates in the agent-loop
  preflight as `transcriptPromptTokenCount + providerPromptReserveTokenCount`
  (`src/repo-search/prompt-budget.ts:100-115`) — the **absolute, cumulative prompt** sent to the
  model at that turn, including the system prompt and tool schemas.
- The turn header sums per-message deltas and keeps only components whose `*Estimated` flag is
  `false` (`dashboard/src/tabs/ChatTab.tsx:48-66`, `dashboard/src/lib/format.ts:93-97`) — a
  **filtered partial sum of deltas**.

So one site shows an absolute where a delta belongs, and the other silently drops components from
a sum. The `known tokens` wording signals that something was dropped but never says how much.

## The rule

> A token figure attached to an element states how many tokens **that element added to the
> context**. Figures nest additively: a parent's figure equals the sum of its children's.
> Context-window fullness is a separate figure, styled distinctly, that never participates in a
> sum.

Everything below follows from that single rule.

## Design

### Tool call card

`ToolCallCard` renders the tool result's own token contribution instead of the prompt size:

```
✓ 66k tok loaded    →    ✓ +3,120 tok
```

The source becomes `message.associatedToolTokens`, already populated live
(`dashboard/src/hooks/useLiveMessages.ts:66`) and on replay (`src/status-server/chat.ts:487`).
`toolCallPromptTokenCount` stops rendering on the card; it stays on the message and feeds the turn
header's context slot.

A running tool call has produced nothing yet and keeps its existing spinner branch with no figure.

### Turn header

`ChatTurnBubble` renders two slots:

1. **Delta** — a plain sum of every child message's tokens, all components included, no
   `*Estimated` filtering: `+12,480 tok`.
2. **Context** — `max(toolCallPromptTokenCount)` across the turn's step messages, rendered against
   the session window as `66k/128k` in its own CSS class so it does not read as a contribution.
   Omitted when no step reported a prompt token count.

The session already owns `contextWindowTokens`, so the denominator is threaded from
`selectedSession` into `ChatTurnBubble`.

A per-turn context figure duplicates the live composer bar (`dashboard/src/tabs/ChatTab.tsx:350-354`)
while a turn streams. It is kept anyway because it is the only place a **completed** turn's context
size remains visible after the stream ends.

### Per-step header

`MessageHeader` (`dashboard/src/tabs/ChatTab.tsx:463`) already renders a delta. Its formatter
changes to the shared `+N tok` form so all sites read identically.

It also stops rendering a figure for `assistant_tool_call`. A tool-call step draws both
`MessageHeader` and `ToolCallCard`; once both show a delta, the same number would appear twice on
one step. Today this is invisible because the two show different quantities. The figure lives on
the innermost element that owns it, so the card keeps it and the step header omits it.

### Estimated components

Estimates are folded into the sums with no marker. Every component of a live turn already carries a
real number:

- live thinking → `Math.max(1, Math.ceil(len / 4))` (`dashboard/src/lib/live-thinking-message.ts:13`)
- live answer → same (`dashboard/src/hooks/useChatComposer.ts:109`, `:163`)
- completed tool call → backend-exact `outputTokens` (`dashboard/src/hooks/useLiveMessages.ts:61-65`)

`inputTokensEstimate: 0` on live messages is not an unestimated value. `createLiveMessage` is only
ever called with `role: 'assistant'`, and assistant messages have no input component. There is no
live user message; the user's prompt enters the list through `applySessionResponse` with a
backend-computed count. The turn delta therefore reconciles with its children exactly.

## Deletions

No compatibility shims. In `dashboard/src/lib/format.ts`:

- `getMessageKnownTokenCount`, `hasExactTokenComponent`, `getKnownTokenComponent` — deleted
- `getReplayDisplayTokenCount` — deleted; it was a pass-through alias for `getMessageTokenCount`
- `getMessageTokenCount` returns `number`, never `null`, and ignores the `*Estimated` flags
- `formatTokenLabel` — deleted; its `'tokens unavailable'` branch has no remaining caller

In `dashboard/src/tabs/ChatTab.tsx`:

- `TurnTokenDisplay` and `getTurnTokenDisplay`'s `exact` flag — deleted
- the `'known tokens'`, `'context tokens'`, and `'tokens unavailable'` label strings — deleted

The `*Estimated` flags stay in `packages/contracts/src/chat.ts`. They are load-bearing for
`src/status-server/metrics.ts`, `src/status-server/chat-turn-telemetry.ts`, and the
`estimatedTokenFallbackTokens` path behind the composer bar. Only the chat message display stops
reading them.

## Testing

End-to-end through the rendered markup, matching the existing dashboard test style
(`renderToStaticMarkup` over real components):

- a completed tool call renders its own contribution, not the prompt size
- a turn header's delta equals the sum of the figures on its children
- a turn header renders the context slot from the largest step prompt count, and omits it when no
  step reported one
- a turn containing an estimated component still reconciles, with no marker
- a running tool call renders no token figure

# Unified Token Accounting — Design

Date: 2026-09-04
Status: Approved, pending implementation plan

## Problem

The chat UI shows two token counters that disagree and drift apart during a run
(observed: badge 53,153 vs composer 66k/155k at 12 tool steps; badge 68,317 vs
composer 111k/155k at 20 steps).

Investigation confirmed four independent token computations:

1. **Persist-layer numeric fields** — `thinkingTokens` per row, `associatedToolTokens`
   denormalized onto the answer row, `outputTokensEstimate` per tool row.
2. **`ContextUsageBuilder`** — ignores the stored fields and re-derives from text via
   `estimateTokenCount(message.content)` (`src/status-server/chat.ts:61-75`).
3. **Dashboard live bubbles** — `ceil(len / 4)` (`dashboard/src/lib/chat-live-messages.ts:11`)
   and `estimatePromptTokens`.
4. **Engine preflight `promptTokenCount`** — the real tokenizer.

These are not four legitimate measurements. They are reconstructions of a number the
engine already knows.

### Confirmed defects

**D1 — Badge label contradicts its own tooltip.** `ChatTab.tsx:851` renders
`formatTokenLabel(count, 'context tokens')` while the tooltip two lines down says
"unique run tokens". The label also collides with the composer's genuine context readout.

**D2 — Finalized turns drop per-step thinking, path-dependently.** The settled branch of
`getTurnTokenDisplay` reads `components.thinking.tokenCount` from `main` only
(`dashboard/src/lib/format.ts:183-185`). Whether thinking survives depends on which
persist path produced the turn (see D3), so the badge drops on live → settled for
repo-operation turns and not for direct-chat turns.

**D3 — The persist call sites disagree.** Four call sites of `appendChatMessagesWithUsage`:

| Call site | `usage.thinkingTokens` | Answer row result |
| --- | --- | --- |
| `chat-repo-operation-runner.ts:284` | not passed | `thinkingTokens = 0`; thinking lives only in step rows |
| `routes/chat.ts:901` | `getScorecardTotal(scorecard, 'thinkingTokens')` | run-wide aggregate, duplicating the step rows |
| `routes/chat.ts:1203` | `getScorecardTotal(scorecard, 'thinkingTokens')` | same as above |
| `routes/chat.ts:938` | `{}` (provided assistant turn) | no thinking; benign |

`getScorecardTotal` reads `normalized.totals[key]` (`src/status-server/chat.ts:1071-1075`),
the run-wide aggregate. Both routes paths also emit per-step thinking rows via
`ChatTurnTelemetry.countThinkingTokens`. The result is a genuine duplication that blocks the
obvious fix: summing step rows would be correct for the runner path and double-count on the
routes paths.

## Key insight

`TokenUsageTracker.recordModelResponse()` (`src/repo-search/engine/token-usage.ts:60-95`)
already returns per-turn `{ completionTokens, thinkingTokens, completionTokensEstimated,
thinkingTokensEstimated }` from the real tokenizer, then accumulates them into run totals.
That per-turn return value is the per-row truth everything downstream re-derives.

It is already emitted on every tool event as `thinkingTokenCount`
(`tool-action-processor.ts:1066` → `progress-reporter.ts:112-135`), and the chat route
**drops it** (`routes/chat.ts:165, 181, 197` forward `promptTokenCount` and nothing else).
That discard is why the dashboard falls back to `ceil(len / 4)`.

The single source already exists. It is not published.

## Decisions

- **One source, two views.** Every message row owns its own token count, computed once.
  The badge and the context bar derive from those per-row numbers through different
  selectors. They are not merged into one number: the badge asks "what did this turn
  generate?" (tool *output*, thinking, answer), the context bar asks "what will be replayed
  into the next prompt?" (tool *command* text, post-compaction, post-image-removal). A tool
  call correctly contributes different amounts to each.
- **Real-time accuracy is a hard requirement.** Live values must equal settled values.
- **In-flight tail: calibrated estimate.** Publish the tracker snapshot at turn boundaries;
  estimate only the in-flight tail using the previous turn's measured chars-per-token ratio,
  snapping exact at each boundary. No per-flush tokenization.
- **Historical data: backfill migration.**

## Architecture

### 1. Engine — `TokenUsageTracker` is the sole producer

Retains a `TurnTokenRecord[]`: per turn, `{ turn, thinkingTokens, outputTokens, toolTokens[],
promptTokens }` plus the corresponding `Estimated` flags. `snapshot()` becomes a fold over
those records rather than independent field accumulation, so run totals cannot drift from
per-row values.

### 2. Contract — new `usage` stream frame

`ChatStreamUsageEventSchema` in `packages/contracts/src/chat.ts`, carrying the latest turn
record, the running totals, and a `charsPerToken` calibration ratio. Emitted at `llm_end`,
`tool_start`, and `tool_result` — the points where the engine already holds exact numbers.

### 3. Route — stop dropping fields

`routes/chat.ts:155-200` forwards the usage frame. The existing discard of
`thinkingTokenCount` is removed.

### 4. Dashboard runtime store

`chat-session-runtime-store` holds `latestUsage`. `createLiveMessage` loses its
`ceil(len / 4)`; `getLiveMessageTokenDisplay` loses its `estimatePromptTokens` fallbacks.
The in-flight tail is `deltaChars / charsPerToken`, rendered with `~`, snapping exact at each
turn boundary.

### 5. Persist layer

All four `appendChatMessagesWithUsage` call sites pass the same `TurnTokenRecord[]`.
`associatedToolTokens` and the `usage.thinkingTokens` aggregate path are deleted. The D3
disagreement becomes unrepresentable rather than merely corrected.

### 6. `ContextUsageBuilder`

Reads the stored numeric fields. `getMessageContextTokenEstimate`'s text re-estimation is
removed. It keeps its own selector — replayable messages, prompt formatting, compaction —
because it answers a different question from the same source.

### 7. `format.ts`

`getTurnTokenDisplay` sums per-row counts over `turn.messages` through **one code path for
live and settled**. That structural collapse is what makes the live → settled jump
impossible, rather than fixing it arithmetically. Fixes D2.

The badge is relabeled `run tokens` to match its own tooltip. Fixes D1.

## Data flow

```
engine turn completes
  -> TokenUsageTracker records the turn
  -> usage frame on the chat stream
  -> dashboard runtime store
  -> badge and context bar read the same numbers through different selectors
  -> persist writes the same numbers per row
  -> reload renders identical values
```

## Invariant

```
badge(live) == badge(settled) == sum of per-row counts == persisted rows
```

Directly testable. It fails today on the repo-operation path.

## Error handling

- Exactness flags propagate per row. `~` is shown iff any contributing row is estimated.
- A missing usage frame is a schema parse error, not a silent fallback to estimation. A stale
  engine or a missed migration fails loudly.
- `charsPerToken` has no prior-turn data on turn 1. Seed from the model preset's known ratio;
  where unavailable, mark turn 1's tail estimated using the coarse ratio.

## Migration

Versioned migration in `src/state/migrations/registry.ts`:

- **Drop `associated_tool_tokens`.** Fully recoverable — tool rows carry their own
  `output_tokens_estimate` and are never pruned (`ThinkingRetentionPolicy` prunes only
  `assistant_thinking` rows).
- **Thinking.** Where step rows survive, zero the answer row's aggregate; the step rows
  already hold the truth. Where retention pruned them, keep the aggregate on the last
  surviving thinking row.

Lossless except for per-step detail that was already pruned before the migration ran.

## Testing (TDD)

1. **Headline regression:** badge value is identical across the live → settled transition.
2. All four `appendChatMessagesWithUsage` call sites produce identical row-level attribution
   for one shared scorecard fixture.
3. Context bar computed from stored fields vs. the prior text estimate on a fixture session.
4. Migration: an old-shape session backfills to the totals it previously displayed.
5. Calibration: the in-flight estimate converges to the exact count at the turn boundary.

Existing assertions in `dashboard/tests/chat-tab.test.tsx` reference the `context tokens`
label and will need updating for the rename.

## Out of scope

- Merging the badge and the context bar into a single number.
- Per-flush server-side tokenization.

## Risks

1. Switching `ContextUsageBuilder` from text estimates to stored fields **will shift the
   displayed context number on existing sessions**. Intended, but immediately user-visible.
2. `charsPerToken` seeding on turn 1 (see Error handling).

## Open question deferred to implementation

Whether the provider streams one chunk per token. If it does, counting chunks would make the
in-flight count exact for free and remove the need for the calibrated estimate. Worth checking
during implementation; does not block this design, since the calibrated path is correct either
way.

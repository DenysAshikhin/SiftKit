# Chat Compaction Boundary Design

## Purpose

Make chat compaction a single, explicit context boundary. Everything before the latest boundary is represented to the model only by one summary. The original messages remain persisted solely so the user can expand and inspect them in the chat timeline.

## Goals

- Summarize the entire conversation represented before the triggering turn.
- Replace all pre-boundary model context with one latest compaction summary.
- Keep original pre-boundary messages out of every later model request.
- Show those original messages in one collapsed history fold.
- Show the latest summary as an ordinary assistant bubble immediately below the fold.
- Continue the live conversation below the summary.
- Make the context meter describe the context actually replayed to the model.
- Preserve the same semantics across automatic, manual, and repeated compaction.
- Preserve the active transcript as an exact prompt prefix for the summary request wherever the inference backend supports prefix caching.

## Non-goals

- Do not delete original messages or move them to a second archive table.
- Do not expose one nested fold per compaction event.
- Do not retain multiple active summaries.
- Do not add a compatibility path for the incorrect context-usage calculation.
- Do not change the public chat-session schema unless implementation proves an existing field cannot express the invariant.

## Current State

The persistence and replay paths already encode most of the desired boundary:

- Compaction marks pre-existing messages with `compressedIntoSummary: true` and appends an uncompressed `compaction_summary` row.
- Model replay skips compressed messages and includes the active summary.
- A later compaction marks the earlier summary and subsequent live messages compressed, then appends a new active summary.
- The dashboard already has a collapsed-history disclosure followed by a summary bubble.

The confirmed correctness gap is context accounting: `ContextUsageBuilder` totals every persisted message, including messages excluded from replay. This leaves the context meter above the threshold after successful compaction and makes compaction appear not to have happened. The live dashboard flow also lacks an end-to-end assertion that the completed streamed response immediately renders the new boundary.

## Core Invariants

For every chat session:

1. Zero or one uncompressed `compaction_summary` row exists.
2. Every message before the active summary is marked `compressedIntoSummary: true`.
3. The active summary and every message after it are uncompressed.
4. Model replay contains no compressed message.
5. If an active summary exists, it is the only representation of the earlier conversation in model context.
6. Context usage is calculated from exactly the replayable message set, plus the system prompt and existing provider overhead rules.
7. The dashboard renders compressed messages only inside one collapsed fold.
8. The active summary renders immediately after that fold, followed by live messages in chronological order.

Sessions without a compaction summary have no boundary: every ordinary message remains live and no history fold is rendered.

## Architecture

### Authoritative backend boundary

Introduce one pure backend selector for active context messages. It accepts persisted messages in chronological order and returns only rows where `compressedIntoSummary !== true`. Both `buildChatHistoryMessages` and `ContextUsageBuilder` must use this selector instead of independently deciding which rows are active.

The selector does not reinterpret kinds, repair malformed boundaries, or fall back to compressed content. Invalid persisted state must remain visible through validation or tests rather than silently restoring old context.

### Automatic compaction flow

When prompt preflight exceeds the usable prompt budget:

1. Split the currently replayable transcript at the triggering user message.
2. Summarize the complete active history before that triggering message. On a later compaction, this naturally includes the prior summary plus every completed turn since it, so the new summary transitively represents the whole conversation without duplicating the triggering request.
3. Replace the engine transcript with system context, the new summary, and the triggering user message.
4. Persist the turn atomically: mark every pre-existing row compressed, append one uncompressed summary row, then append the triggering user message and generated assistant rows.
5. Return the updated session and replay-based context usage in the terminal stream response.

If summary generation fails or produces an unusable result, persist no boundary changes and surface the existing compaction failure. There is no partial boundary and no fallback that replays old messages.

### Prompt cache lifecycle

Compaction is a dedicated free-form summary generation. Its request must not flatten the active history into a new text blob. For automatic compaction, it must send the same structured, serialized completed-history prefix cached by the preceding turn and append one final user instruction asking for the compacted summary. The triggering user message is deliberately absent from this request and is restored after the summary boundary. Manual compaction uses the complete active transcript as its structured prefix because it has no triggering turn.

For inference backends with explicit prompt caching, the summary request must reuse the same slot, enable prompt caching, and preserve all message-rendering flags that affect the prefix. This lets the provider reuse the longest cached prefix while generating the summary. Tests must compare the serialized message prefix directly; merely setting a cache flag is insufficient evidence of reuse.

Once the summary replaces the old transcript, the next answer request necessarily has a different prefix: system context, the new summary, and the triggering user message. That request may need to prefill the new compacted context once. The obsolete full-history cache is intentionally abandoned, and subsequent turns reuse the smaller summary-based prefix.

Backends without explicit slot or cache controls still receive the stable structured prefix so any provider-managed prefix cache can reuse it. The application must report observed cache telemetry where the provider supplies it, but must not claim cache reuse from configuration alone.

### Manual compaction flow

Manual compaction uses the same replayable transcript and summary format. It atomically marks every pre-existing row compressed and appends one active summary. Because there is no triggering turn, the summary is the final live row until the user sends another message.

### Repeated compaction

Only the latest summary stays active. During the next compaction, the previous active summary and all later live messages become compressed alongside the already folded raw history. One new summary is appended.

The dashboard continues to expose one combined fold containing all compressed rows in chronological order. It shows only the newest active summary below that fold. This avoids nested boundaries while retaining complete inspectable history.

## Context Usage

The context meter must measure the request that would be built for the next turn:

- Include the chat system prompt.
- Include the latest active summary, if present.
- Include all uncompressed messages after the summary.
- Include thinking, tool, and image costs only for those active messages.
- Exclude every compressed row from chat, thinking, tool, image, fallback, and total token counts.
- Preserve the existing context-window, warning-threshold, provider-overhead, and image-ceiling calculations.

After compaction, `remainingTokens` must increase and `shouldCondense` must become false unless the new summary plus live messages genuinely remain within the warning zone.

## Dashboard Timeline

The timeline has three ordered regions:

1. A closed-by-default native `<details>` fold containing every compressed original message.
2. The latest active `compaction_summary` rendered as an assistant bubble labeled `Compacted summary`.
3. Every uncompressed message after the summary.

The fold summary reports the number of folded messages. Expanding it uses the existing message renderers so text, thinking, tool calls, images, and metadata remain inspectable. The summary bubble remains outside the fold and visible at all times.

The terminal streamed response must update the selected session and context meter together. A user must see the fold, summary bubble, and reduced usage immediately after the compaction-triggering response finishes, without refreshing.

For malformed legacy state with compressed rows but no active summary, retain the existing inspectable fold but do not invent a summary. Backend replay still excludes rows explicitly marked compressed; malformed state must be diagnosed rather than silently replayed.

## Contracts and Persistence

Keep the existing `ChatMessage` fields and kinds:

- `kind: 'compaction_summary'` identifies summary rows.
- `compressedIntoSummary: true` identifies persisted UI-only history.

No parallel condensed-summary field, compatibility shim, or alternate message collection is introduced. SQLite position remains the chronological source of truth. Compaction continues to update flags and append the summary in one `saveChatSession` transaction.

## Testing Strategy

Use TDD for every behavioral correction.

### Backend unit and integration coverage

- Context usage excludes compressed text, thinking, tool, and image tokens.
- Context usage includes the active summary and all post-summary messages.
- `shouldCondense` resets after a successful compaction when active context is below the threshold.
- Model history contains only the active summary and post-summary messages.
- Automatic and manual compaction persist the same boundary shape.
- A second compaction summarizes the previous summary plus intervening completed turns, leaves exactly one active summary, and never replays raw folded messages.
- Automatic compaction excludes the triggering user message from the summary and retains it exactly once after the new summary.
- The summary request byte-prefix matches the completed active-history serialization and only appends the summary instruction.
- Cache telemetry from the compaction request is retained and distinguishable from the resumed answer request when the provider reports it.
- Summary failure leaves all message flags and rows unchanged.

### Dashboard component coverage

- No fold appears before compaction.
- One collapsed fold contains every compressed message.
- The active summary appears outside and immediately below the fold.
- Live messages appear after the summary.
- Two compactions still produce one fold and one visible latest summary.
- Orphaned compressed rows remain inspectable without a fabricated summary.
- The context meter uses the corrected replay-based totals.

### End-to-end coverage

Drive a chat through the streaming endpoint with deterministic mock responses until preflight compaction occurs. Assert that the completed response and rendered dashboard show:

- persisted compressed flags;
- exactly one active summary;
- no compressed content in the next model request;
- one collapsed history fold;
- the visible summary and subsequent live messages in order;
- reduced context usage and `shouldCondense: false` without a page refresh.

## Acceptance Criteria

- After compaction, no pre-summary original message is included in model context.
- The latest summary transitively represents the entire prior conversation.
- The summary generation request preserves the completed active-history prompt prefix; it does not resend that history as a differently formatted blob.
- The automatic-compaction trigger message is not summarized or duplicated; it is the first live message after the new summary.
- The first request against the compacted transcript may re-prefill the new prefix, after which later turns reuse that smaller prefix.
- Exactly one active summary exists after any number of compactions.
- Original messages remain available only through one collapsed UI fold.
- The latest summary is always visible below the fold as an assistant bubble.
- New messages continue below the summary.
- API context usage matches replayed context and drops after successful compaction.
- Automatic and manual compaction share the same persisted and rendered boundary.
- The behavior is covered by backend, dashboard, repeated-compaction, and live E2E regression tests.

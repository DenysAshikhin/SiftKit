# Streaming Scan State — Design

Date: 2026-08-07
Status: Approved

## Problem

Two O(N²) per-token costs remain in the streaming hot path after the
runaway-check throttle, plus one class of wasted work:

1. **Early planner-action cutoff.** `src/llm-protocol/llama-cpp-client.ts:407`
   runs `findFirstCompleteJsonObjectText(reasoningText)` on every reasoning
   frame: `indexOf('{')` plus a brace-depth walk from the first `{` to
   end-of-text, restarting from scratch each token. O(N²) per thinking phase,
   unconditional. Load-bearing: it stops decode the moment the planner emits a
   complete `"action"` object in reasoning and rescues actions emitted in the
   wrong channel.
2. **Streaming finish-output extraction.**
   `src/repo-search/engine/task-loop.ts:536,541` call
   `ModelJson.extractStreamingFinishOutput(accContent)` per content frame:
   full-text regexes plus a char-by-char decode rebuild from `"output":"` to
   end-of-text (`src/lib/model-json.ts:107-148`). O(N²) per streamed answer.
3. **Wasted live-text events.** The task loop installs the
   `onThinkingDelta`/`onContentDelta` callbacks whenever `progress.enabled`
   (`src/repo-search/engine/task-loop.ts:530-545`), but the server repo-search
   writer drops `thinking`/`answer` events
   (`src/status-server/operation-progress-writers.ts:32`) — the extraction and
   event construction run for nothing on that path. Only the dashboard chat
   writers actually consume live text.

## Design

### 1. `FirstJsonObjectScanner` (replaces `findFirstCompleteJsonObjectText`)

Exported class in `src/llm-protocol/llama-cpp-client.ts`. State:
`scannedTo`, `startIndex`, `depth`, `inString`, `escaped`,
`result: string | null`. `push(text)` scans only `text[scannedTo..]` with the
identical state machine; on completion caches `result`
(`text.slice(startIndex, end).trim()`) and returns it on every later push —
matching the old function, which always re-returned the first complete
object. A `text.length < scannedTo` push (early-stop truncation) resets all
state and rescans. One instance per completion, declared next to the other
stream locals; the old module function is deleted (sole caller). Amortized
O(1) per token; behavior identical, including the quirk that a non-action
first object permanently blocks later fires (the caller re-tests the small
cached object per frame).

### 2. `StreamingFinishOutputExtractor` (replaces the `ModelJson` static)

Exported class in `src/lib/model-json.ts`; `ModelJson.extractStreamingFinishOutput`
and `decodeJsonStringPrefix` are deleted (complete replacement; module-level
`JSON_ESCAPE_CHARS` stays and is used by the class). State: `lastLength`,
`decodeIndex` (−1 until both markers found), `decoded`, `closed`, `stalled`.
`push(text)`:

- Length decrease → full reset (truncation guard), then proceed.
- Until markers found: run `/"action"\s*:\s*"finish"/` then
  `/"output"\s*:\s*"/` on the full text; return `null` if absent. This
  full-text scan repeats per push only until the markers appear — pre-finish
  content (the envelope head) is short, and the match is sticky afterwards.
- Once found: decode incrementally from `decodeIndex`, appending to
  `decoded`. Escape semantics identical to `decodeJsonStringPrefix`: trailing
  `\` or incomplete `\uXXXX` waits for more input without consuming; a full
  4-char invalid hex sets `stalled` (the old code froze at that point forever
  — same observable result); closing `"` sets `closed`. Returns `decoded`.

Task loop creates one extractor per planner request (both
`streamFinishAsAnswer` branches share it) and calls `push(accContent)` in
place of the static.

### 3. `wantsLiveText` capability

- `ProgressWriter<TEvent>` (`src/lib/progress-writer.ts`) gains
  `get wantsLiveText(): boolean` defaulting `true` (safe: no consumer loses
  events by default).
- Overrides returning `false` (confirmed non-consumers of thinking/answer):
  `RepoSearchSseProgressWriter` (`LoggedRepoSearchSseProgressWriter`
  inherits), `RepoSearchToolLogProgressWriter`
  (`src/status-server/routes/chat.ts:303`), `ProbeProgressWriter`
  (`src/repo-search/approval-verdict-probe.ts:120`).
- `RepoSearchLifecycleWriter` (`src/repo-search/execute.ts:142`) delegates to
  its target (its lifecycle logger has no thinking/answer branch).
- Consumers keep the default: `ChatStreamProgressWriter` (writes them),
  `ChatRepoOperationProgressTracker` (uses them for phase timestamps).
- `ProgressReporter` gains
  `get liveTextEnabled(): boolean` = `writer.enabled && writer.wantsLiveText`.
- `task-loop.ts` gates the two callback installations on `liveTextEnabled`;
  the `stream:` flag stays on `progress.enabled` so stream-side protections
  (early-action cutoff, runaway checks) are unchanged.
- `terminal-synthesizer.ts` gates its `onContentDelta` (line 75) and the
  final `progress.answer` (line 88) on `liveTextEnabled`; its `stream:`
  condition also stays unchanged.

## Error handling

Nothing new. Both classes are pure incremental state machines over strings;
the shrink guard makes any non-append input safe (full reset + rescan). No
inference-path failure modes added.

## Testing (TDD)

- `FirstJsonObjectScanner` unit tests: incremental completion, braces inside
  strings, escape spanning push boundaries, first-object caching after
  completion, shrink reset, no-brace text. Plus one client-level parity test:
  action assembled across multiple reasoning frames still early-stops with
  the same reason/text (passes before and after — a parity pin).
- `StreamingFinishOutputExtractor`: migrate the six existing
  `model-json.test.ts` static tests to single-push instances (same
  expectations), plus incremental tests: multi-push append decoding, escape
  and `\u` sequences spanning pushes, closed-then-frozen, markers appearing
  on a later push, shrink reset.
- `liveTextEnabled`: reporter-level tests with stub writers (wanting /
  non-wanting / silent). The concrete writer overrides are enforced by the
  `override` keyword (typecheck) and reviewed; `RepoSearchSseProgressWriter`
  is not directly instantiable in a unit test without an HTTP stack.
- Existing pinned tests must pass unchanged: streaming suite (early
  reasoning action, throttle tests), mock repo-search loop suites.

## Success criteria

- Reasoning-action detection and finish-output decoding cost O(delta) per
  frame after markers/objects are located; identical detection semantics.
- Server repo-search runs no longer execute finish-output extraction or emit
  thinking/answer events; dashboard chat behavior unchanged.
- `findFirstCompleteJsonObjectText` and the `ModelJson` static are gone.
- All suites, typecheck, lint green.

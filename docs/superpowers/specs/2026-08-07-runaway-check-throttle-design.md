# Runaway-Check Throttle — Design

Date: 2026-08-07
Status: Approved

## Problem

In the streaming completion loop
(`src/llm-protocol/llama-cpp-client.ts:421-428`), every SSE frame — in
practice every generated token — runs two runaway detectors on both
`contentText` and `reasoningText`:

- `getRecentTokenRepetition` (`src/llm-protocol/llama-cpp-client.ts:549-572`)
  splits the entire accumulated text on whitespace: O(N) per frame, O(N²)
  per completion. A 2,000-token response performs ~2M token-scans.
- `getRunawayStructuralTail` (`src/llm-protocol/llama-cpp-client.ts:534-547`)
  regex-tests the full text per frame.

This is the dominant Node-side CPU cost while a completion streams and a
contributor to the sawtooth CPU profile during repo-search/repo-agent runs.

Both detectors need large patterns before they can fire (48 repeated
`</arg_value>` tags ≈ 576 chars; 200+ tokens with a 48+-char repeated tail;
96 repeated trailing chars), so per-token checking is unnecessary.

## Design

Throttle the checks by streamed volume; detector internals untouched.

- In `streamChatAtBaseUrl`, track `lastRunawayCheckLength` (per completion,
  initialized 0). After appending a frame's deltas, compute
  `contentText.length + reasoningText.length`; run both detectors only when
  it has grown by at least `RUNAWAY_CHECK_INTERVAL_CHARS = 256` (~64 tokens)
  since the last check. On each check, update `lastRunawayCheckLength`.
- After the stream loop exits without an early stop, run one final check.
  This preserves today's end-state guarantee: a completed response never
  carries an undetected runaway tail (e.g. an `</arg_value>` flood arriving
  entirely within the final sub-256-char window). The final check reuses the
  identical early-stop path: set `earlyStopReason`, truncate, emit the final
  `onContentDelta`.
- Net behavior difference vs. today: mid-stream detection may fire up to
  ~64 tokens later. For a guard whose minimum trigger is 100+ tokens of
  repetition, this is immaterial; the truncation still removes the detected
  tail.

Cost effect: the O(N) full-text work drops from every frame to every ~64th
frame plus once at end — ~98% reduction of the per-token hot path.

Out of scope, noted for later:

- `findFirstCompleteJsonObjectText(reasoningText)`
  (`src/llm-protocol/llama-cpp-client.ts:395`) also scans full text per
  reasoning frame; different semantics (early action cutoff latency), not
  changed here.
- `LlamaCppStreamingResponseAssembler`
  (`src/llm-protocol/streaming-response-assembler.ts`) has no imports in
  `src/` — apparent dead code, only tests reference it.

## Error handling

Nothing new. The detectors are pure functions over accumulated strings; the
throttle only changes when they run. The final check runs outside the frame
loop but before response assembly, on the same in-scope locals.

## Testing (TDD)

Using the existing `StreamingHttpClient` mock pattern in
`tests/llm-protocol-streaming.test.ts`:

- Throttled detection regression: stream a runaway as many small frames;
  assert early stop still fires and assert the `onContentDelta` call count
  proves checks ran on the throttled cadence (the per-frame code would have
  stopped earlier, producing fewer calls).
- End-parity: a runaway tail arriving entirely within the final <256-char
  window followed by a natural finish (`[DONE]`) is still detected and
  truncated by the end-of-stream check.
- Existing pinned tests (`tests/llm-protocol-streaming.test.ts:234-271`)
  pass unchanged — the single 48-tag frame is 576 chars, over the threshold.

Before completion: targeted suite, broader applicable suite,
`npm run typecheck`, `npm run lint`.

## Success criteria

- Detectors run at most once per 256 streamed chars plus once at stream end.
- Runaway streams still early-stop with the same reasons and truncation.
- All suites, typecheck, lint green.

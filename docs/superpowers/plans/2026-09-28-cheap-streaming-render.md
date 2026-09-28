# Plan: cheap streaming render — near-zero CPU/GPU while chats stream

**Date:** 2026-09-28
**Scope:** dashboard only. No server/streaming-protocol changes.
**Status:** implemented.

## Evidence (measured, not inferred)

Display: RX550 at 2560×1440 @ 144 Hz; Chrome composites on it. Probe: a separate
headful Chrome (own profile, closed between runs) showing the real `ChatTab`
fed by the real stream client at 100 tokens/s, 10 updates/s (the server's
100 ms text flush). GPU from `Get-Counter '\GPU Engine(*)\Utilization Percentage'`
on Chrome's GPU process; CPU from per-process CPU time (% of one core).

| Page | GPU Copy / 3D |
|---|---|
| blank, one static 4px dot | 0 / 0 |
| blank, one 4px dot, smooth infinite opacity animation | 63% / 25% |
| same dot, `steps(3)` | 6.7% / 3% |
| blank, text rewritten at 60 / 30 / 20 Hz | 34/34, 14/16, 9/11 |

Findings:

- GPU cost scales with presented frames per second, not per-frame work.
- Any endless CSS animation — even stepped — keeps Chrome producing frames: the
  rail's typing dots pinned the GPU while another chat streamed, and the stepped
  caret blink alone cost ~8% renderer CPU while streaming.
- The typewriter advanced every ≥12 ms (~83 Hz of DOM writes + a React render,
  block split and markdown parse per advance).
- `ChatTab` already rendered 0 times per text delta; one leak remained: a usage
  update re-sent a value-equal `prompt`, changing `runtime.liveTokenBase` identity.

## What changed

1. **`liveTokenBase` identity** (`chat-session-runtime-store.ts`): a value-equal
   prompt reuses the previous object, so usage updates no longer re-render `ChatTab`.
2. **No endless animations** (`chat.css`, `ChatTab.tsx`): typing dots, pulse,
   spinners and caret blink removed. Streaming shows a static haloed accent dot
   (`.live-dot`); tool work / sending shows a static ringed dot (`.sp`); the caret
   is solid. Guard: `chat-css-animations.test.ts` fails on any `infinite` animation
   in dashboard CSS.
3. **`LiveStreamedText`** (replaces `useSmoothedText`, removed with its test):
   React renders only finished markdown blocks (or plain paragraphs); a 33 ms
   `setTimeout` loop (not a per-vsync rAF loop) writes the growing tail straight
   into one `<span class="stream-tail">`. An open code fence is marked
   `data-fence` for monospace. Stream end keeps the same `MarkdownBlocks` element,
   so finished blocks' memoized parses are reused. Boundary detection uses the
   shared scanner in `markdown-blocks.ts` (`streamTailStart`).

Accepted trade: inline markdown in the partial (last) paragraph shows raw until
that paragraph finishes; fenced code shows monospace immediately.

## Results (same probe)

| Scenario | renderer CPU | GPU-process CPU | GPU Copy / 3D |
|---|---|---|---|
| streaming chat shown, before | 11–15% | 6–8% | 40% / 16% |
| streaming chat shown, after | 4.4% | 2.8% | 7% / 7% |
| other chat shown, before | 2.4% | 6% | 39% / 15% |
| other chat shown, after | 0.8% | 0.1% | ~0 / ~0 |
| real dashboard idle | 0.2% | 0.1% | — |

## Verification

- `npm run test:dashboard` (609 pass), `npm run typecheck` (includes lint),
  `tests/perf/chat-stream-load.test.ts` green.

## Optional follow-ups (only if profiling demands)

- Lower `STREAM_ADVANCE_INTERVAL_MS` rate further (20 Hz measured ~⅓ cheaper than 30 Hz).
- `content-visibility: auto` on settled rows for very long transcripts.

# Chat Delta Streaming — Design

Date: 2026-08-07
Status: Approved

## Problem

The dashboard chat path re-sends the full accumulated thinking/answer text on
every token: `ChatStreamProgressWriter`
(`src/status-server/routes/chat.ts:264-301`) wraps each snapshot in
`{ thinking: text }` / `{ answer: text }` and `SseResponseWriter.writeEvent`
JSON-stringifies it per event (`src/status-server/sse-response-writer.ts:37`).
For an N-token thinking phase that is O(N²) serialize + transmit + browser
re-parse (~50 MB on the wire for a 5,000-token phase). The dashboard then
replaces the displayed text per event, so rendering cadence is welded to
network cadence.

Facts that scope the fix:

- All live text crosses one server chokepoint: `ChatStreamProgressWriter`,
  instantiated at `chat.ts:875` (message, phase tracker, streamAnswer),
  `chat.ts:1051` (plan), `chat.ts:1190` (repo-search, `answer` mode). No
  other `writeEvent('thinking'|'answer')` sites exist.
- There is no reconnect anywhere: no SSE `id:` field, the chat endpoints
  never abort on disconnect (writes silently no-op), and the dashboard's
  fetch-based `ChatStreamReader` (`dashboard/src/lib/chat-stream-parser.ts:85`)
  has no retry. Within one connection TCP guarantees ordering and delivery,
  so **gaps cannot occur today**. Offsets are therefore carried for
  defensive assembly and future resume support, but no backfill/resume
  endpoint is built now.
- Dashboard: React 19 + Vite; live messages live in the immutable
  `ChatSessionRuntimeStore`; `chat-tab` tests render with
  `renderToStaticMarkup` (effects never run).

## Design

### Wire protocol (complete replacement of the snapshot payloads)

Event names `thinking` / `answer` stay; the payload becomes a delta:

```
{ turn: number, offset: number, text: string }
```

- `offset` = char position of `text` within that turn's accumulated stream.
- `offset === 0` is a keyframe: the client replaces the assembled text.
- Emitted keyframes: first chunk of a turn, any turn change, and any shrink
  of the source snapshot (early-stop truncation).
- Zod schema `ChatStreamTextDeltaSchema` in `packages/contracts/src/chat.ts`,
  shared by server (types) and dashboard (runtime validation).

### Server: `LiveTextDeltaTracker` + batching writer

New pure class `LiveTextDeltaTracker` (`src/status-server/live-text-delta.ts`),
one instance per channel (thinking, answer). It converts the per-token
snapshots the progress events already carry into pending deltas, and decides
flushing with explicit timestamps (fully unit-testable):

- `pushSnapshot(turn, text, atMs)`: same turn and `text.length >= sentLength`
  → append `text.slice(sentLength)` to the pending delta (contiguous merge);
  turn change or shrink → discard pending, pend a keyframe
  `{ turn, offset: 0, text }`.
- `takeDue(atMs, force)`: returns the pending delta (and marks it sent) when
  `force`, pending length ≥ 1024 chars, or ≥ 100 ms since the pending chunk
  started; otherwise null. Empty deltas are never emitted.

`ChatStreamProgressWriter` owns two trackers plus one `setTimeout` (100 ms,
scheduled when a pending chunk exists, cleared on flush):

- thinking/answer events → `pushSnapshot`, emit due deltas; the phase
  tracker still observes the full snapshot (in-process, free).
- any other event kind → force-flush both trackers first, then forward
  (preserves ordering with tool events).
- public `flushPending()` → force-flush both and clear the timer. The three
  streaming endpoints hoist the writer to a local, call `flushPending()`
  immediately before their `done`/`error` `writeEvent` calls and in
  `finally` (timer cleanup; writes no-op after disconnect).

Net wire cost: O(total text) payload in ≤ ~10 events/sec, instead of
O(N²/2) payload in per-token events.

### Dashboard: delta assembly

- `parseChatStreamPacket` validates `thinking`/`answer` payloads with
  `ChatStreamTextDeltaSchema`; event types become
  `{ kind: 'thinking' | 'answer'; delta: ChatStreamTextDelta }`. Old
  snapshot shapes are gone (server and dashboard ship together).
- New helper `applyTextDelta(previous: string, delta)` in
  `dashboard/src/lib/stream-text-delta.ts`: `offset === 0` → `delta.text`;
  `offset === previous.length` → append; `offset < previous.length` →
  `previous.slice(0, offset) + delta.text`; `offset > previous.length`
  (impossible in-connection, defensive) → keep `previous`.
- Thinking assembly keys the live message id by turn
  (`live-thinking-${turn}`): same-turn deltas update the last thinking
  message via `applyTextDelta`; a new turn starts a new message (replaces
  the old `previous.length`-based id). Answer assembly applies
  `applyTextDelta` to the existing `live-answer` message content.
- `toRuntimeTransitions` passes deltas through; the `thinkingEnabled` gate
  stays.

### Dashboard: smooth rendering (jitter-buffered typewriter)

Transport batching would make text pop in chunks; a client-side pacer
decouples display cadence from arrival cadence:

- `SmoothStreamPacer` (`dashboard/src/lib/smooth-stream-pacer.ts`), pure,
  driven by explicit millisecond timestamps: `push(targetLength, atMs)`
  updates an EMA of arrival rate (chars/ms, weight 0.3 per push; shrink →
  snap displayed to target); `sample(atMs)` advances the displayed length
  toward the target at `ema × clamp(backlogMs / 300, 0.5, 3)` (fallback
  rate 0.06 chars/ms before the first EMA sample), and jumps forward to a
  300 ms backlog whenever the backlog exceeds 2000 ms; `snap()` completes
  instantly.
- Hook `useSmoothedText(text, live)`
  (`dashboard/src/hooks/useSmoothedText.ts`): initial displayed length =
  full current text (so `renderToStaticMarkup` and fresh mounts show
  everything — smoothing applies only to text arriving after mount); while
  `live` and behind, a 33 ms `setTimeout` loop samples the pacer and updates
  state; `live` false → snap. Returns `text.slice(0, displayedLength)`.
- `ChatTab.tsx` render sites become small components so the hook is legal:
  a thinking body (`<div className="think">`) and the assistant answer body
  (markdown block) call `useSmoothedText(message.content, isLive)`. Live
  answer markdown re-renders at ≤ 30 fps — no worse than today's per-token
  re-render.

## Out of scope (explicit)

- Reconnect/resume and range backfill: there is no reattachable operation
  today (disconnect orphans the stream server-side). Offsets in the payload
  keep the wire format ready for a future `Last-Event-ID`-style resume.
- The CLI/status-server repo-search SSE path: its writer drops live text
  (and with `wantsLiveText`, no longer receives it).

## Error handling

- Client-side zod validation rejects malformed delta payloads (event
  ignored, as today for unknown events).
- Defensive gap rule in `applyTextDelta` keeps the last good text.
- Server timer is cleared on flush, disconnect writes no-op, and
  `flushPending()` in `finally` guarantees no timer leaks.

## Testing (TDD)

- `LiveTextDeltaTracker` unit tests: contiguous merge, keyframe on turn
  change, keyframe on shrink, size flush (≥1024), time flush (≥100 ms),
  force flush, no empty emissions.
- `applyTextDelta` unit tests: keyframe, append, overlap rewrite, gap.
- Parser/transition/store tests migrated to delta payloads: thinking delta
  assembly across turns (new message per turn), answer assembly, keyframe
  replace.
- `SmoothStreamPacer` unit tests with explicit timestamps: EMA catch-up,
  backlog clamp, far-behind jump, snap, shrink.
- `useSmoothedText`: static-render shows full text (existing chat-tab tests
  must pass unchanged).
- Full suites: `npm test`, `npm run test:dashboard`, `npm run typecheck`,
  `npm run lint`, plus a live dashboard chat spot-check.

## Success criteria

- Live thinking/answer bytes on the wire are O(total text), event rate
  ≤ ~10/s, and the UI streams smoothly (no chunk popping, no dead zones
  under normal jitter; instant completion on done).
- Old snapshot payloads are fully gone from server and dashboard.
- All suites, typecheck, lint green.

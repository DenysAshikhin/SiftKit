# Progress-update delta batching

## Problem

`progress_update` is the only live-text event that bypasses the chat writer's delta trackers. Every content token forces a flush of the other trackers, commits one `chat_run_events` row in a synchronous SQLite transaction, publishes to the SSE subscriber (which re-reads and re-folds the journal), and prints one console line. Thinking, narration, and answer already batch at 100 ms / 1024 chars per channel.

With the current model every turn's content is tool-call XML, which the classifier treats as tool control, so narration never fires and `progress_update` is the only content channel. Tool-call generation therefore runs on the per-token path, producing the console burst seen in run `be52e99d` and stalling the stream loop.

## Goal

Route `progress_update` through the same tracker, journal row shape, and reducer path as thinking, narration, and answer. No schema change to `chat_run_events`. No dashboard client change.

## Non-goals

- In-memory live channel to subscribers (per-token UI). The UI keeps the 100 ms / 1024 char cadence.
- Incremental classifier scan. Separate change.
- Any change to the CLI `--progress` renderer or the plain repo-search SSE route.

## Design

### Contracts (`packages/contracts`)

- `ChatTranscriptEvent` union: `{ kind: 'progress', progress: ChatStreamProgress }` becomes `{ kind: 'progress', delta: ChatStreamTextDelta }` at `chat-transcript-reducer.ts:51`.
- Delete `ChatStreamProgressSchema` and `ChatStreamProgress` from `chat.ts:543-548`. The reducer union was their only consumer. `elapsedMs` is dropped; the dashboard never read it from the progress row.
- `reduceProgressEvent` applies the delta with `applyChatStreamTextDelta` onto the single progress row `${prefix}-progress`. Turn change arrives as `offset: 0` from the tracker and replaces the content, preserving today's "newest turn replaces the bar" behaviour. Removal on `completed` and the empty-row fallback in `finalizeChatRunTranscript` are unchanged.

### Writer (`src/status-server/chat-stream-progress-writer.ts`)

- Add `progressDeltas = new LiveTextDeltaTracker()`.
- `progress_update` branch: `progressDeltas.pushSnapshot(event.turn, event.progressText, now)` then `emitDueDeltas(false)`. Remove the `flushPending` + `recordDisplay` + `publish` handling for this kind.
- `emitDueDeltas` and `flushPending` include the progress tracker. `emitTrackerDeltas` kind union gains `'progress'` and records `{ kind: 'progress', delta }`.
- No phase-tracker call for progress.

### Console logging (`src/status-server/dashboard-runs.ts`)

- Remove `progress_update` from `SERVER_LOGGED_PROGRESS_KINDS`. Update the `LIVE_TEXT_PROGRESS_KINDS` comment; the "in both sets" note no longer applies.

### Unchanged

- `LiveTextDeltaTracker`, `ChatJournalStore`, SSE subscriber, projection encoder, dashboard client. `assistant_progress` is already a `ChatTextRowKind`, so `append_text` records apply to it.

## Behaviour after the change

| Path | Before | After |
|---|---|---|
| Journal rows per tool-call generation | one per token | one per 100 ms or 1024 chars |
| Forced flush of other trackers | per token | only at non-text events |
| Console `progress` lines | per token | none |
| Progress row content on reload | full text, last event wins | same, rebuilt from deltas |
| UI latency for progress text | one commit + read per token | ≤ 100 ms batching, same as thinking |

## Testing

TDD. Failing tests first.

- `tests/chat-transcript-reducer.test.ts`: progress cases at lines 47-60 and 114-115 move to delta shape. Add: consecutive deltas append; a new turn at `offset: 0` replaces; `completed` still removes the row.
- New `tests/chat-stream-progress-writer.test.ts` using the `ChatStreamProgressWriter` setup from `tests/chat-journal-attach.test.ts`: 50 `progress_update` events within 100 ms produce one `progress` journal row; a `tool_start` after pending progress flushes it before the tool row; turn change yields `offset: 0`.
- `tests/status-server-chat-stop.test.ts:396-442`: unchanged assertions must still pass (progress row `Step 2 of 5` persists via the stop-time flush).
- `dashboard/tests/chat-tab.test.tsx:1691-1707`: fixture events move to delta shape; assertions unchanged.
- `tests/repo-agent-sessions.test.ts:1391` already asserts no server log line for `progress_update`; add `isServerLoggedProgressEvent(progress_update) === false` to `tests/native-narration.e2e.test.ts`, which already imports it at line 6.
- `tests/chat-persist-token-parity.test.ts`, `tests/status-server-chat-operation-attach.test.ts`: run unchanged as regression.
- Full suite, `npm run typecheck`, `npm run lint`.

## Risks

- A test or fixture still emitting `{ kind: 'progress', progress: {...} }` fails the strict schema. That is the intended loud failure.
- Journal rows written before this change with the old progress shape fail to parse on replay. Replay only happens for runs whose `projected_sequence` lags `latest_sequence` (`chat-run-projection.ts:279-288`), so completed runs are unaffected. A chat run in flight across the upgrade fails projection on its next reconcile. No compatibility path per repo rules; restart the status server between chat runs when deploying.

## Files

Source: `packages/contracts/src/chat.ts`, `packages/contracts/src/chat-transcript-reducer.ts`, `src/status-server/chat-stream-progress-writer.ts`, `src/status-server/dashboard-runs.ts`.

Tests: `tests/chat-transcript-reducer.test.ts`, `tests/chat-journal-attach.test.ts`, `tests/status-server-chat-stop.test.ts`, `dashboard/tests/chat-tab.test.tsx`, plus one console-logging assertion.

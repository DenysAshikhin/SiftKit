# LLM-Based Context Compaction — Design

Date: 2026-08-20
Status: Approved (brainstorm complete)

## Problem

Current compaction (`compactPlannerMessagesOnce`, `src/repo-search/prompt-budget.ts`) is lossy
truncation: on preflight overflow it drops the oldest planner messages and inserts a
`[COMPRESSED HISTORICAL EVIDENCE]` breadcrumb containing one-line digests of the last 8 dropped
messages. Everything older is lost outright. Separately, chat has a crude manual "condense"
(`condenseChatSession`, `src/status-server/chat.ts`) that keeps the last 2 messages and stores the
last 2400 characters of raw concatenated text as `chat_sessions.condensed_summary`.

Replace both with a single LLM-based compaction: when the prompt hits the budget, the active model
summarizes the conversation, and that summary becomes the basis of the context going forward. The
chat UI shows a clear delineation between compacted history, the summary, and the continuation.

## Decisions (locked during brainstorm)

| Decision | Choice |
| --- | --- |
| Scope | All loop kinds: chat, repo-search, **and repo-agent** (the `'compact' \| 'fail'` policy split is removed) |
| Trigger | Reactive at budget, same as today: preflight overflow past `maxPromptBudget` (~135k on the 150k preset) |
| Retention | Summary only: `system → summary → latest user message`; nothing else survives verbatim |
| Oversize input | Guaranteed impossible via tightened tool caps; hard error if it happens anyway (no chunking) |
| Summarizer failure | One retry, then typed `planner_compaction_failed` error; run fails loudly. No truncation fallback — old compactor deleted |
| Manual condense | Rebuilt on the new path (same summarizer, same persistence); 2400-char mechanism deleted |
| Architecture | One engine-level compactor for all loop kinds; chat persists via a compaction event on the run-event stream |

## Section 1 — Core engine compaction

Trigger point unchanged: `PromptPreparer.prepareTurn` (`src/repo-search/engine/prompt-preparer.ts`)
when `!preflight.ok`. The `ContextOverflowPolicy` type, the `contextOverflowPolicy` option, and
`execute.ts`'s `isAgent ? 'fail' : 'compact'` branch are deleted — every loop kind compacts.

1. **Summarize.** One LLM call to the active model (same backend/preset as the run).
   - Input: the rendered transcript excluding the system prompt, plus a fixed summarization
     instruction.
   - Output: a structured summary with fixed sections — task/goal, current state, key findings with
     `file:line` anchors, decisions made, tool results that still matter (exact error text
     preserved verbatim), and in-flight work (pending edits, current hypothesis, next intended
     command). Written for the model to resume work; doubles as the user-visible summary text.
2. **Rebuild transcript** as: system prompt → assistant summary message (marked
   `[CONTEXT COMPACTED — SUMMARY OF PRIOR CONVERSATION]`) → the latest user message (same pinning
   rule as today). Everything else is dropped.
3. **Housekeeping** as today: `transcript.replaceWith()` bumps `generation` (invalidating duplicate
   replay anchors) and releases dropped-image re-read guards; the incremental token counter does a
   full recount; provider reserve text is rebuilt; preflight re-runs. The
   `turn_preflight_compaction_applied` log event gains `summaryTokenCount` and
   `summarizerElapsedMs`.
4. **Single-shot fit guarantee.** The summarization request must satisfy
   `transcript + instructions ≤ totalContextTokens − summaryOutputReserve`. Today's caps allow a
   worst-case transcript of ~budget + one assistant answer (~150k), which would not fit. `TurnBudget`
   is tightened: the effective prompt budget for accepting tool results is reduced by a fixed
   **compaction reserve** constant (10k tokens: summary output cap + instruction size). If a transcript
   still cannot fit single-shot, that is a hard error naming the actual counts — reaching it means
   the cap math regressed.
5. **At most once per turn.** Still overflowing after compaction → existing
   `planner_preflight_overflow` error. Summarizer failure (backend error, timeout, empty output) →
   one retry, then typed `planner_compaction_failed`.

Deleted: `summarizeMessageForCompaction`, `buildCompressedHistorySummary`, the greedy
newest-first keep loop in `compactPlannerMessagesOnce`, and the `COMPRESSED HISTORICAL EVIDENCE`
marker.

Consequence accepted: mid-run compaction in repo-search/repo-agent drops all verbatim tool
exchanges; the model resumes from summary + latest user message. The summary prompt therefore
explicitly demands in-flight-work detail.

## Section 2 — Chat persistence and data flow

Chat rebuilds planner history from the DB every turn (`buildChatHistoryMessages`,
`src/status-server/chat.ts`), so compaction must persist or the next turn re-sends full history.

1. **Event.** The engine emits a `compaction` event on the existing run-event stream:
   `{ summaryText, droppedMessageCount, beforePromptTokenCount, afterPromptTokenCount }`. Non-chat
   loops only log it; the chat stream handler persists it.
2. **Persistence shape.** New `chat_messages` row: `role: 'assistant'`,
   `kind: 'compaction_summary'`, `content = summaryText`, positioned at the boundary (after the last
   compacted message, before the continuing turn). All rows at or before the boundary get
   `compressed_into_summary = 1`. The session-level `condensed_summary` column is dropped via a new
   schema migration (registered in `src/state/migrations/registry.ts`); existing sessions' old
   condensed text is discarded and their `compressed_into_summary` flags reset, so full history
   replays until the next compaction.
3. **History replay.** `buildChatHistoryMessages`: skip rows with `compressed_into_summary = 1`;
   emit a `compaction_summary` row as the marked assistant summary message. Replayed history becomes
   `summary → post-boundary messages` (the system prompt is supplied separately, as today), so the
   engine transcript matches its in-memory post-compaction shape and the next turn neither
   re-overflows nor double-compacts.
4. **Composition.** A later compaction summarizes a transcript whose first non-system message is the
   prior summary; the new summary row supersedes it and the prior summary row is also marked
   `compressed_into_summary = 1`.
5. **Manual condense** (`POST /dashboard/chat/sessions/:id/condense`): reimplemented to invoke the
   same summarizer directly against the session's replayed history (one summarization call, no
   planner run), persisting the same row shape and flags. `condenseChatSession` is deleted.

## Section 3 — Dashboard UI (ChatTab)

- Rows with `compressed_into_summary = 1` render collapsed beneath a full-width divider labeled
  "— Context compacted (N messages summarized) —", with a toggle to expand the originals (kept in
  the DB; dimmed when expanded to signal they are no longer in the model's context).
- Directly below the divider: a distinct summary card (border/badge "Compacted summary") showing the
  summary text — visually different from normal assistant bubbles.
- Conversation continues normally beneath.
- The old `<pre>{condensedSummary}</pre>` block is removed.

## Section 4 — Error handling

- **Summarizer failure**: one retry, then `planner_compaction_failed`. In chat this surfaces through
  the existing stream-error path — the turn fails visibly, nothing is persisted, the user can retry.
- **Doesn't fit single-shot**: hard error with actual token counts; unreachable unless the
  compaction-reserve cap math regressed.
- **Still overflowing after compaction**: existing `planner_preflight_overflow`.
- **Persistence atomicity**: summary row + `compressed_into_summary` flags land in the same
  `saveChatSession` write as the turn's messages, so a crash mid-turn cannot leave flags without the
  summary row.

## Section 5 — Testing (TDD)

- **Engine loop tests** (extend `tests/repo-search-chat-loop.test.ts` and compaction tests): mock a
  turn that overflows; assert summarizer input (transcript minus system prompt), rebuilt transcript
  shape (`system → summary → last user`), generation bump, image-guard release, at most one
  compaction per turn, and typed errors for summarizer failure and post-compaction overflow. The
  summarizer is mocked through the existing `mockResponses` infrastructure.
- **Budget tests**: `TurnBudget` compaction-reserve math — worst-case transcript always fits
  single-shot; boundary behavior at tiny context sizes (reserve clamps).
- **Chat E2E** (status-server level, `tests/chat-sessions-db.test.ts` style): a chat turn that
  compacts → persisted `compaction_summary` row and flags; the next turn's
  `buildChatHistoryMessages` output matches the compacted shape (no re-compaction); multiple
  compactions compose; the manual condense endpoint produces the same shape.
- **Migration test**: new schema version — `condensed_summary` dropped, flags reset, old sessions
  replay full history (extend the `runtime-db-schema` / assistant-migration test patterns).
- **Dashboard tests** (`dashboard/tests/chat-tab.test.tsx`): divider with count, collapsed compacted
  messages with expand toggle, summary card, old `<pre>` block gone.
- Completion gate: relevant tests, broader suite, `npm run typecheck`, `npm run lint`.

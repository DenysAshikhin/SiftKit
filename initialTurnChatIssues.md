# Chat Cross-Turn Replay Issues

## Goal
What the dashboard UI shows (ordered: user → thinking → tool call+result → answer) should be exactly what is sent to the llama server, in that order. Today this holds **within a single run** but breaks **across turns**, because the chat persistence/replay layer drops or relocates content.

## How a chat request is actually assembled
The full message array is built in the engine ([engine.ts:974-988](src/repo-search/engine.ts#L974-L988)):

```
messages = [
  { role: 'system',  content: systemPrompt (+ hiddenToolContexts + grounding instruction) },
  ...historyMessages,                 // buildChatHistoryMessages output
  { role: 'user', content: task.question },
  ...this-run tool/assistant turns    // appended each loop turn
]
```

- `request.history` is built by `buildChatHistoryMessages` ([chat.ts:181-198](src/status-server/chat.ts#L181-L198)) → `historyMessages`.
- The system prompt is built by `buildChatSystemContent` ([chat.ts:229-245](src/status-server/chat.ts#L229-L245)), wired at [routes/chat.ts:636](src/status-server/routes/chat.ts#L636) / [:795](src/status-server/routes/chat.ts#L795).
- The provider serializes `messages` and POSTs to llama each turn. `buildChatHistoryMessages` builds only the middle slice; it does not send.

## Root cause
`buildChatHistoryMessages` replays only `user_text` + `assistant_answer` (`isChatReplayMessage`, [chat.ts:200-207](src/status-server/chat.ts#L200-L207)). It excludes `assistant_thinking` and `assistant_tool_call`. Tool evidence is instead carried (on some paths only) as flattened text in the system prompt via `hiddenToolContexts`, populated only when the caller passes `toolContextContents` to `appendChatMessagesWithUsage` ([chat.ts:318-322](src/status-server/chat.ts#L318), [:437-446](src/status-server/chat.ts#L437)).

Critical: `toolContextContents` is passed only on the **plan/repo-search** paths ([routes/chat.ts:982](src/status-server/routes/chat.ts#L982), [:1142](src/status-server/routes/chat.ts#L1142), [:1360](src/status-server/routes/chat.ts#L1360)). The **normal web-chat send path does NOT pass it** ([routes/chat.ts:858-870](src/status-server/routes/chat.ts#L858-L870)), so on the regular chat path prior tool evidence is carried nowhere.

## Issues

### Issue #1 — Prior thinking dropped from send but shown in UI
- `assistant_thinking` is persisted (UI renders it) but excluded from replay history and never placed in `hiddenToolContexts`.
- Consequence: on every subsequent turn, prior-turn thinking is not sent.
- Caveat: dropping prior-turn reasoning from the send is standard/often required (many reasoning models reject replayed old `reasoning_content`). The arguable defect is the UI implying prior thinking is part of ongoing context. Severity: low / by-design, pending the WYSIWYG goal.

### Issue #2 — Prior tool calls are not first-class ordered turns across turns
- Within a run, tool calls are ordered message-array turns (same as repo-search).
- Across turns the persistence/replay layer breaks ordering:
  - `assistant_tool_call` messages are excluded from history replay.
  - Plan path: flattened into a system-prompt text lump (`hiddenToolContexts`), losing original position/order.
  - Normal chat path: dropped from the send entirely (no history, no hidden context).
- Repo-search avoids this only because it is single-run (no cross-user-turn persistence layer).
- Severity: real correctness/structure gap.

### Issue #3 — A new turn does not receive prior web search/fetch results (cross-turn dedup is live, evidence is not)
- On the regular web-chat path, prior `web_search`/`web_fetch` outputs are neither in replay history nor in `hiddenToolContexts` (since `toolContextContents` is not passed). So the model in turn N+1 sees none of turn N's fetched page text.
- `retainedWebToolCalls` IS now wired into the grounding policy ([engine.ts:936](src/repo-search/engine.ts#L936) passes `retainedWebToolCalls: options.retainedWebToolCalls`; extracted at [routes/chat.ts:799](src/status-server/routes/chat.ts#L799)). But the constructor seeds **only** the dedup sets `searchedQueries`/`fetchedUrls` — it never sets `searchSucceeded`/`fetchSucceeded` ([chat-grounding-policy.ts:53-60](src/repo-search/chat-grounding-policy.ts#L53-L60)).
- Net effect — the worst combination, and it is live today:
  1. The prior URL/query is **dedup-blocked** in turn N+1 (seeded from retained calls), so the model cannot re-fetch/re-search it.
  2. The prior evidence is **absent from context** (point above), so it cannot read it back either.
  3. `fetchSucceeded` is false at run start (retained calls do not set it), so the **finish gate still forces a fresh fetch**.
  - Result: the model is pushed to fetch a *different* source every turn, even when the exact page it already read holds the answer. This is the concrete "stranding" scenario.
- Severity: real correctness gap; directly degrades web grounding.

### Issue #4 — UI order is timestamp-sorted, not position-contracted (fragility, not a confirmed reorder)
- The DB loads messages `ORDER BY position ASC` ([chat-sessions.ts:240](src/state/chat-sessions.ts#L240)), but the UI re-sorts persisted messages by `createdAtUtc` ([ChatTab.tsx:142](dashboard/src/tabs/ChatTab.tsx#L142) → [chatMessages.ts:9-15](dashboard/src/lib/chatMessages.ts#L9-L15)).
- `compareMessageCreatedAt` returns `0` on equal/unparseable timestamps with **no position tiebreak**. All messages in one turn share a single `now` timestamp ([chat.ts:303](src/status-server/chat.ts#L303)), so stable `Array.sort` preserves position order *in practice*.
- So order is correct today, but it rests on two implicit assumptions — stable sort + equal same-turn timestamps — rather than an explicit position-based contract. The "UI order == send order" premise holds in practice but is fragile.
- Severity: low / latent fragility.

## UI vs send (next turn)
| Item | In dashboard UI | In actual send (next turn) |
|---|---|---|
| Prior thinking | yes | no (often intentional) |
| Prior tool calls/outputs (chat path) | yes, ordered | no — dropped |
| Prior tool calls/outputs (plan path) | yes, ordered | yes but reordered into system prompt |
| Prior web search/fetch results | yes | no (chat path) |
| User + final answers | yes | yes, ordered |

## Direction (not yet approved)
The data needed to do this correctly already exists: persisted `assistant_tool_call` messages carry `toolCallCommand` + full `toolCallOutput`. The replay layer discards/relocates it instead of emitting it as ordered turns.

Clean fix: make `buildChatHistoryMessages` reconstruct the full ordered turn sequence (user → thinking? → tool call+result → answer → …) as real message-array entries, and retire the `hiddenToolContexts` / system-prompt detour. This would also dissolve the across-turns grounding problem (Issue #3), since prior fetched evidence would once again live in ordered context.

Open decision: whether prior `assistant_thinking` should be replayed (strict WYSIWYG) or intentionally stripped on send (provider compatibility).

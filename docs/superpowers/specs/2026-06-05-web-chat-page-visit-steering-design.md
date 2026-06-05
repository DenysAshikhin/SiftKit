# Web-Chat Page-Visit Steering Governor

Date: 2026-06-05

## Problem

In the web-on direct chat loop ([`streamDirectChatWebTurn`](../../../src/status-server/chat.ts)) the model can run one or
more `web_search` calls and then answer directly from result snippets, never
opening (`web_fetch`) a single result page. Observed: a session ran `web_search`
twice, emitted `{"action":"answer"}`, and the loop streamed prose with no page
visit. There is no governor steering it toward reading an actual page.

The repo-search loop already has the analogous "steer, then drop the nudge once
the model complies" pattern for duplicate tool calls
(`duplicateReplay*` in `src/repo-search/engine.ts`), where the nudge message is
overwritten in place so it never accumulates. The web-chat loop has no such
governor.

## Goal

After at least one `web_search`, intercept the model's attempt to answer and
steer it (up to 3 times) to either open a returned result (`web_fetch`) or run a
different `web_search`. Once the model complies, the steering prompt disappears
and never pollutes the persisted chat / answer turn. After 3 blocked answers,
allow the answer.

## Decisions (confirmed)

- **Trigger:** intercept the answer attempt (do not force after every search).
- **Fetch satisfies:** a successful `web_fetch` turns the gate off for the rest
  of the turn; the model may then answer freely.
- **Budget:** count intercepted answer-attempts; cap 3, then allow the answer. A
  refining `web_search` OR a `web_fetch` both clear the current nudge; each
  blocked answer costs one of the three.

## Design

All changes are local to `streamDirectChatWebTurn` plus one exported prompt
const. No change to the repo-search loop or any public API surface beyond the
new const.

### Transient nudge delivery

`evidenceMessages` is passed verbatim into the decision-turn request as chat
messages (`chat.ts` decision call → `streamChatAssistantMessage` →
`buildChatCompletionRequest`). The nudge is delivered by appending it to a
**local copy** used only for the decision turn:

```
evidenceMessages: steerMessage
  ? [...evidenceMessages, { role: 'user', content: steerMessage }]
  : evidenceMessages.slice()
```

The persistent `evidenceMessages` array is never mutated, so the nudge vanishes
the moment the model responds — nothing to splice, nothing persisted into
`turns`, nothing leaking into the final answer turn. This achieves the same
"prompted, then removed once it does the right thing" end state as the
repo-search duplicate pattern, more simply.

### Turn-local state

- `searchCount: number` — incremented after each `web_search` decision is
  dispatched.
- `fetchSucceeded: boolean` — set true when a `web_fetch` returns `exitCode 0`.
- `blockedAnswers: number` — intercepted answer attempts (cap 3).
- `steerMessage: string | null` — nudge for the next decision turn.

### Control flow (inside the `for(;;)` loop)

1. Run decision turn with the local evidence copy (nudge appended iff
   `steerMessage`).
2. Parse decision.
3. If `decision.kind !== 'answer'` and `toolCalls < maxTurns` (existing branch):
   - `steerMessage = null` (compliance clears the nudge).
   - Execute tool as today. On `web_search` success bump `searchCount`; on
     `web_fetch` success set `fetchSucceeded = true`.
   - `continue`.
4. If `decision.kind === 'answer'`:
   - `gateApplies = searchCount > 0 && !fetchSucceeded && blockedAnswers < 3 && toolCalls < maxTurns`.
   - If `gateApplies`: `blockedAnswers++`, `steerMessage = WEB_CHAT_STEER_PROMPT`,
     `continue` (re-decide; no turn recorded, `toolCalls` unchanged).
   - Else: `steerMessage = null`, fall through to the answer turn (unchanged).

`searchCount` is incremented on dispatch of a `web_search` decision regardless of
exit code (a search that errored still happened); `fetchSucceeded` requires
`exitCode 0` (only a real page read satisfies the gate).

### Nudge text

New exported const `WEB_CHAT_STEER_PROMPT` (mirrors `WEB_CHAT_DECISION_PROMPT` /
`WEB_CHAT_ANSWER_PROMPT` for test assertions). Content: the model searched the
web but opened no result; do NOT answer from search snippets; either
`{"action":"web_fetch","url":"..."}` a returned result URL to read the real
page, or run a different `{"action":"web_search",...}` if the results were poor;
only answer after reading a page.

## Components

| Unit | Responsibility | Depends on |
|------|----------------|------------|
| `WEB_CHAT_STEER_PROMPT` | static nudge text | none |
| `streamDirectChatWebTurn` governor | gate answer attempts, track state, deliver/clear transient nudge | `streamChatAssistantMessage`, `parseWebChatDecision`, `WebResearchTools` |

## Error handling

- A `web_search` that throws still counts toward `searchCount` (it happened);
  the gate may still fire and steer toward a different search/fetch.
- A `web_fetch` that throws does **not** set `fetchSucceeded` (no page read), so
  the gate keeps applying until budget exhausts.
- `maxTurns` cap is respected: the gate never fires when `toolCalls >= maxTurns`
  (no tool could run anyway), so the answer proceeds.

## Testing (TDD, mock-driven via existing `mockResponses`)

1. **Steer to fetch:** `search → answer(blocked) → fetch → answer`. Assert: one
   fetch tool turn present, exactly one block (one extra decision), final prose
   returned, no nudge text in any persisted `turn`.
2. **Budget exhaustion:** `search → answer ×4 → prose`. Assert: 3 blocked
   re-decisions then the answer is allowed; no nudge text in `turns`.
3. **Static answer not gated:** `answer → prose` with no prior search → answers
   immediately, no extra decision.
4. **Fetch satisfies:** `search → answer(blocked) → fetch → answer → prose`.
   After the successful fetch the second `answer` is allowed with no further
   block (assert only one block total).

## Out of scope

- Repo-search loop steering (unchanged).
- Persisting/visualizing the nudge in the UI (intentionally invisible).
- Configurable budget (hard-coded 3, matching request).

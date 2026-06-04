# Turn-Grouped Chat Bubbles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap each assistant turn (thinking + tool calls + final answer) in one chat bubble whose internal steps live in a collapsed "Internal Logic" section above the final answer, reducing scroll/clutter while keeping every step and the answer individually deletable, plus a turn-level delete.

**Architecture:** Pure grouping function `groupMessagesIntoTurns` (new `lib/chatTurns.ts`) folds the flat `visibleMessages` list into ordered `ChatTurn`s keyed by `sourceRunId` (plan/repo-search), a shared `"live"` key (the single in-progress streamed turn), or a per-message `solo`/`user` key. `ChatTab` renders each turn: turns with ≥1 step become a `ChatTurnBubble` (turn header + collapsed `Internal Logic` `<details>` holding the step sub-bubbles + a main slot showing the answer when settled or the latest live item while streaming); turns with 0 steps render the single message exactly as today. Per-message header/body JSX is extracted into shared `MessageHeader` + `renderMessageBody` helpers so the wrapped and unwrapped paths reuse identical markup. Turn-level delete loops the existing per-message DELETE API — **no backend changes**.

**Tech Stack:** React 19 + TypeScript, `react-markdown`/`remark-gfm`, Node built-in `node:test` + `react-dom/server` `renderToStaticMarkup` for tests (run via `tsx`).

---

## File Structure

- **Create** `dashboard/src/lib/chatTurns.ts` — pure grouping: `ChatTurn` type, `normalizeMessageKind`, `groupMessagesIntoTurns`. One responsibility: turn the flat message list into ordered turn groups. No React.
- **Create** `dashboard/tests/lib/chatTurns.test.ts` — unit tests for grouping (target ~100% branch).
- **Modify** `dashboard/src/tabs/ChatTab.tsx` — extract `MessageHeader` + `renderMessageBody`; replace the `visibleMessages.map` body with turn rendering + `ChatTurnBubble`; add `onDeleteTurn` prop.
- **Modify** `dashboard/tests/tab-components.test.tsx` — add ChatTab render cases for turns.
- **Modify** `dashboard/src/hooks/useChatSessions.ts` — add `deleteMessages(messageIds)` (loops existing per-message DELETE).
- **Modify** `dashboard/src/App.tsx` — add `onDeleteChatTurn`, share post-delete refresh, wire `onDeleteTurn` into `<ChatTab>`.
- **Modify** `dashboard/src/styles.css` — `.msg.turn`, `.internal-logic`, nested-step styling.

**Test commands** (run from repo root):
- Lib: `npx tsx --test dashboard/tests/lib/chatTurns.test.ts`
- Component: `npx tsx --test dashboard/tests/tab-components.test.tsx`
- Typecheck: `npm --prefix dashboard run build`

---

## Task 1: Grouping function `chatTurns.ts`

**Files:**
- Create: `dashboard/src/lib/chatTurns.ts`
- Test: `dashboard/tests/lib/chatTurns.test.ts`

- [ ] **Step 1: Write the failing test**

Create `dashboard/tests/lib/chatTurns.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { groupMessagesIntoTurns, normalizeMessageKind } from '../../src/lib/chatTurns';
import type { ChatMessage } from '../../src/types';

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'id',
    role: 'assistant',
    kind: 'assistant_answer',
    content: '',
    inputTokensEstimate: 0,
    outputTokensEstimate: 0,
    thinkingTokens: 0,
    associatedToolTokens: 0,
    createdAtUtc: '2026-06-04T00:00:00.000Z',
    sourceRunId: null,
    ...overrides,
  } as ChatMessage;
}

test('normalizeMessageKind falls back by role when kind is absent', () => {
  assert.equal(normalizeMessageKind(message({ kind: undefined, role: 'assistant' })), 'assistant_answer');
  assert.equal(normalizeMessageKind(message({ kind: undefined, role: 'user' })), 'user_text');
  assert.equal(normalizeMessageKind(message({ kind: 'assistant_thinking' })), 'assistant_thinking');
});

test('groups a settled run turn: steps are thinking+tool, main is the answer', () => {
  const messages = [
    message({ id: 't', kind: 'assistant_thinking', sourceRunId: 'run-1' }),
    message({ id: 'c', kind: 'assistant_tool_call', sourceRunId: 'run-1' }),
    message({ id: 'a', kind: 'assistant_answer', sourceRunId: 'run-1' }),
  ];
  const turns = groupMessagesIntoTurns(messages, new Set());
  assert.equal(turns.length, 1);
  assert.equal(turns[0].key, 'run:run-1');
  assert.equal(turns[0].isLive, false);
  assert.deepEqual(turns[0].steps.map((m) => m.id), ['t', 'c']);
  assert.equal(turns[0].main?.id, 'a');
});

test('a solo answer (null run) is its own turn with no steps', () => {
  const turns = groupMessagesIntoTurns([message({ id: 'a', kind: 'assistant_answer', sourceRunId: null })], new Set());
  assert.equal(turns.length, 1);
  assert.equal(turns[0].key, 'solo:a');
  assert.deepEqual(turns[0].steps, []);
  assert.equal(turns[0].main?.id, 'a');
});

test('a user message is its own turn keyed by id with no steps', () => {
  const turns = groupMessagesIntoTurns([message({ id: 'u', role: 'user', kind: 'user_text' })], new Set());
  assert.equal(turns[0].key, 'user:u');
  assert.deepEqual(turns[0].steps, []);
  assert.equal(turns[0].main?.id, 'u');
});

test('all live messages collapse into one live turn; main is the latest, rest are steps', () => {
  const messages = [
    message({ id: 'lt', kind: 'assistant_thinking', sourceRunId: null }),
    message({ id: 'lc', kind: 'assistant_tool_call', sourceRunId: null, toolCallStatus: 'running' }),
  ];
  const turns = groupMessagesIntoTurns(messages, new Set(['lt', 'lc']));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].key, 'live');
  assert.equal(turns[0].isLive, true);
  assert.deepEqual(turns[0].steps.map((m) => m.id), ['lt']);
  assert.equal(turns[0].main?.id, 'lc');
});

test('preserves order and separates user turn from following run turn', () => {
  const messages = [
    message({ id: 'u', role: 'user', kind: 'user_text' }),
    message({ id: 't', kind: 'assistant_thinking', sourceRunId: 'run-9' }),
    message({ id: 'a', kind: 'assistant_answer', sourceRunId: 'run-9' }),
  ];
  const turns = groupMessagesIntoTurns(messages, new Set());
  assert.deepEqual(turns.map((turn) => turn.key), ['user:u', 'run:run-9']);
});

test('blank/whitespace sourceRunId is treated as solo, not grouped', () => {
  const messages = [
    message({ id: 'a', kind: 'assistant_answer', sourceRunId: '  ' }),
    message({ id: 'b', kind: 'assistant_answer', sourceRunId: '' }),
  ];
  const turns = groupMessagesIntoTurns(messages, new Set());
  assert.deepEqual(turns.map((turn) => turn.key), ['solo:a', 'solo:b']);
});

test('empty input yields no turns', () => {
  assert.deepEqual(groupMessagesIntoTurns([], new Set()), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test dashboard/tests/lib/chatTurns.test.ts`
Expected: FAIL — `Cannot find module '../../src/lib/chatTurns'`.

- [ ] **Step 3: Write minimal implementation**

Create `dashboard/src/lib/chatTurns.ts`:

```ts
import type { ChatMessage } from '../types';

export type ChatTurn = {
  key: string;
  isLive: boolean;
  messages: ChatMessage[];
  steps: ChatMessage[];
  main: ChatMessage | null;
};

export function normalizeMessageKind(message: ChatMessage): NonNullable<ChatMessage['kind']> {
  return message.kind ?? (message.role === 'user' ? 'user_text' : 'assistant_answer');
}

function isStepMessage(message: ChatMessage): boolean {
  const kind = normalizeMessageKind(message);
  return kind === 'assistant_thinking' || kind === 'assistant_tool_call';
}

function isAnswerMessage(message: ChatMessage): boolean {
  return normalizeMessageKind(message) === 'assistant_answer';
}

function resolveTurnKey(message: ChatMessage, isLive: boolean): string {
  if (isLive) return 'live';
  if (message.role === 'user') return `user:${message.id}`;
  const runId = typeof message.sourceRunId === 'string' ? message.sourceRunId.trim() : '';
  return runId ? `run:${runId}` : `solo:${message.id}`;
}

function finalizeTurn(turn: ChatTurn): void {
  const answer = turn.messages.find(isAnswerMessage) ?? null;
  const main = answer ?? turn.messages[turn.messages.length - 1] ?? null;
  turn.main = main;
  turn.steps = turn.messages.filter((message) => message !== main && isStepMessage(message));
}

export function groupMessagesIntoTurns(messages: ChatMessage[], liveMessageIds: Set<string>): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const message of messages) {
    const isLive = liveMessageIds.has(message.id);
    const key = resolveTurnKey(message, isLive);
    const lastTurn = turns[turns.length - 1];
    if (lastTurn && lastTurn.key === key) {
      lastTurn.messages.push(message);
    } else {
      turns.push({ key, isLive, messages: [message], steps: [], main: null });
    }
  }
  for (const turn of turns) {
    finalizeTurn(turn);
  }
  return turns;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test dashboard/tests/lib/chatTurns.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/chatTurns.ts dashboard/tests/lib/chatTurns.test.ts
git commit -m "feat(chat): add turn grouping for chat messages"
```

---

## Task 2: Refactor ChatTab to render turn bubbles

**Files:**
- Modify: `dashboard/src/tabs/ChatTab.tsx`
- Test: `dashboard/tests/tab-components.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append to `dashboard/tests/tab-components.test.tsx` (uses existing `renderChatTab`, `CHAT_SESSION`, `CHAT_MESSAGE`, `CHAT_THINKING_MESSAGE`, `CHAT_TOOL_MESSAGE` fixtures):

```ts
test('ChatTab wraps a run turn in a turn bubble with collapsed Internal Logic and the answer outside', () => {
  const thinking = { ...CHAT_THINKING_MESSAGE, id: 'th', sourceRunId: 'run-7' } as ChatMessage;
  const tool = { ...CHAT_TOOL_MESSAGE, id: 'to', sourceRunId: 'run-7' } as ChatMessage;
  const answer = { ...CHAT_MESSAGE, id: 'an', sourceRunId: 'run-7', content: 'Final formatted answer.' } as ChatMessage;
  const session = { ...CHAT_SESSION, messages: [thinking, tool, answer] } as ChatSession;
  const markup = renderChatTab({ selectedSession: session });
  assert.match(markup, /class="msg assistant turn/u);
  assert.match(markup, /Internal Logic \(2\)/u);
  assert.match(markup, /Final formatted answer\./u);
  // turn-level delete button present on a settled turn
  assert.match(markup, /aria-label="Delete turn"/u);
});

test('ChatTab renders a lone assistant answer as a plain bubble with no Internal Logic', () => {
  const session = { ...CHAT_SESSION, messages: [{ ...CHAT_MESSAGE, id: 'solo' } as ChatMessage] } as ChatSession;
  const markup = renderChatTab({ selectedSession: session });
  assert.match(markup, /class="msg assistant assistant_answer/u);
  assert.doesNotMatch(markup, /Internal Logic/u);
  assert.doesNotMatch(markup, /aria-label="Delete turn"/u);
});

test('ChatTab renders a user message as a plain bubble with no Internal Logic', () => {
  const session = {
    ...CHAT_SESSION,
    messages: [{ ...CHAT_MESSAGE, id: 'u1', role: 'user', kind: 'user_text', content: 'hi' } as ChatMessage],
  } as ChatSession;
  const markup = renderChatTab({ selectedSession: session });
  assert.match(markup, /class="msg user user_text/u);
  assert.doesNotMatch(markup, /Internal Logic/u);
});

test('ChatTab live turn shows latest item in the main slot, earlier steps in Internal Logic, and no delete buttons', () => {
  const liveThinking = { ...CHAT_THINKING_MESSAGE, id: 'live-thinking-0' } as ChatMessage;
  const liveTool = {
    ...CHAT_TOOL_MESSAGE, id: 'live-tool-x', toolCallStatus: 'running', toolCallOutput: '', toolCallOutputSnippet: '',
  } as ChatMessage;
  const session = { ...CHAT_SESSION, messages: [] } as ChatSession;
  const markup = renderChatTab({ selectedSession: session, liveMessages: [liveThinking, liveTool] });
  assert.match(markup, /Internal Logic \(1\)/u);
  assert.match(markup, /class="tool-spinner"/u);
  assert.doesNotMatch(markup, /aria-label="Delete message"/u);
  assert.doesNotMatch(markup, /aria-label="Delete turn"/u);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test dashboard/tests/tab-components.test.tsx`
Expected: FAIL — markup lacks `msg assistant turn` / `Internal Logic`; current flat renderer is still active.

- [ ] **Step 3: Add the `onDeleteTurn` prop to the type and signature**

In `dashboard/src/tabs/ChatTab.tsx`, in `ChatTabProps` add directly after the `onDeleteMessage` line:

```ts
  onDeleteMessage(messageId: string): Promise<void>;
  onDeleteTurn(messageIds: string[]): Promise<void>;
```

And in the destructured params, after `onDeleteMessage,` add:

```ts
  onDeleteMessage,
  onDeleteTurn,
```

- [ ] **Step 4: Add the shared import and helper components/functions**

At the top of `dashboard/src/tabs/ChatTab.tsx`, add the import (after the existing `useChatScroll` import):

```ts
import { groupMessagesIntoTurns, normalizeMessageKind, type ChatTurn } from '../lib/chatTurns';
```

Add these module-level helpers at the end of the file (after `RepoAutoAppendButton`):

```tsx
function MessageHeader({ message, isLive, chatBusy, onDeleteMessage }: {
  message: ChatMessage;
  isLive: boolean;
  chatBusy: boolean;
  onDeleteMessage(messageId: string): Promise<void>;
}) {
  const messageKind = normalizeMessageKind(message);
  const messageLabel = messageKind === 'assistant_thinking'
    ? 'assistant thinking'
    : messageKind === 'assistant_tool_call'
      ? 'assistant tool'
      : message.role;
  return (
    <header className="msg-header">
      <span>{messageLabel} | {isLive ? 'live' : formatDate(message.createdAtUtc)}</span>
      <span className="msg-meta">
        <span className="msg-tokens">{formatNumber(getMessageTokenCount(message))} tokens</span>
        {!isLive ? (
          <button
            type="button"
            className="msg-icon-button danger"
            onClick={() => { void onDeleteMessage(message.id); }}
            disabled={chatBusy}
            aria-label="Delete message"
            title="Delete message"
          >
            &#128465;
          </button>
        ) : null}
      </span>
    </header>
  );
}

function renderMessageBody(message: ChatMessage, isDirectChatMode: boolean) {
  const messageKind = normalizeMessageKind(message);
  const toolCommand = typeof message.toolCallCommand === 'string' ? message.toolCallCommand.trim() : '';
  const toolOutput = message.toolCallOutput || message.toolCallOutputSnippet || '';
  return (
    <>
      {isDirectChatMode && message.role === 'assistant' && message.thinkingContent ? (
        <details className="thinking-box">
          <summary>Thinking</summary>
          <pre>{message.thinkingContent}</pre>
        </details>
      ) : null}
      {messageKind === 'assistant_thinking' ? (
        <pre className="thinking-message">{message.content}</pre>
      ) : messageKind === 'assistant_tool_call' ? (
        <div className="tool-message">
          <code>{toolCommand}</code>
          {message.toolCallStatus === 'running' ? <span className="tool-spinner"> ...</span> : null}
          {toolOutput ? (
            <details className="tool-result">
              <summary aria-label="Show tool result" title="Show tool result">+ result</summary>
              <pre>{toolOutput}</pre>
            </details>
          ) : null}
        </div>
      ) : message.role === 'assistant' ? (
        <div className="markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {message.content}
          </ReactMarkdown>
        </div>
      ) : (
        <p className="user-message">{message.content}</p>
      )}
    </>
  );
}

function MessageBubble({ message, isLive, isDirectChatMode, chatBusy, onDeleteMessage, extraClass }: {
  message: ChatMessage;
  isLive: boolean;
  isDirectChatMode: boolean;
  chatBusy: boolean;
  onDeleteMessage(messageId: string): Promise<void>;
  extraClass?: string;
}) {
  const messageKind = normalizeMessageKind(message);
  return (
    <article className={`msg ${message.role} ${messageKind}${extraClass ? ` ${extraClass}` : ''}${isLive ? ' live' : ''}`}>
      <MessageHeader message={message} isLive={isLive} chatBusy={chatBusy} onDeleteMessage={onDeleteMessage} />
      {renderMessageBody(message, isDirectChatMode)}
    </article>
  );
}

function ChatTurnBubble({ turn, isDirectChatMode, chatBusy, onDeleteMessage, onDeleteTurn }: {
  turn: ChatTurn;
  isDirectChatMode: boolean;
  chatBusy: boolean;
  onDeleteMessage(messageId: string): Promise<void>;
  onDeleteTurn(messageIds: string[]): Promise<void>;
}) {
  const aggregateTokens = turn.messages.reduce((sum, message) => sum + getMessageTokenCount(message), 0);
  const headerTimestamp = turn.main ? turn.main.createdAtUtc : turn.messages[0].createdAtUtc;
  return (
    <article className={`msg assistant turn${turn.isLive ? ' live' : ''}`}>
      <header className="msg-header">
        <span>assistant turn | {turn.isLive ? 'live' : formatDate(headerTimestamp)}</span>
        <span className="msg-meta">
          <span className="msg-tokens">{formatNumber(aggregateTokens)} tokens</span>
          {!turn.isLive ? (
            <button
              type="button"
              className="msg-icon-button danger"
              onClick={() => { void onDeleteTurn(turn.messages.map((message) => message.id)); }}
              disabled={chatBusy}
              aria-label="Delete turn"
              title="Delete entire turn"
            >
              &#128465;
            </button>
          ) : null}
        </span>
      </header>
      <details className="internal-logic">
        <summary>Internal Logic ({turn.steps.length})</summary>
        <div className="internal-logic-steps">
          {turn.steps.map((step) => (
            <MessageBubble
              key={step.id}
              message={step}
              isLive={turn.isLive}
              isDirectChatMode={isDirectChatMode}
              chatBusy={chatBusy}
              onDeleteMessage={onDeleteMessage}
            />
          ))}
        </div>
      </details>
      {turn.main ? (
        <MessageBubble
          message={turn.main}
          isLive={turn.isLive}
          isDirectChatMode={isDirectChatMode}
          chatBusy={chatBusy}
          onDeleteMessage={onDeleteMessage}
          extraClass="turn-main"
        />
      ) : null}
    </article>
  );
}
```

- [ ] **Step 5: Replace the message map with turn rendering**

In `dashboard/src/tabs/ChatTab.tsx`, replace the whole block from `{visibleMessages.map((message) => {` through its closing `})}` (currently lines ~196-258) with:

```tsx
              {groupMessagesIntoTurns(visibleMessages, new Set(liveMessages.map((message) => message.id))).map((turn) => {
                if (turn.steps.length === 0) {
                  const message = turn.main;
                  if (!message) return null;
                  return (
                    <MessageBubble
                      key={message.id}
                      message={message}
                      isLive={turn.isLive}
                      isDirectChatMode={isDirectChatMode}
                      chatBusy={chatBusy}
                      onDeleteMessage={onDeleteMessage}
                    />
                  );
                }
                return (
                  <ChatTurnBubble
                    key={turn.key}
                    turn={turn}
                    isDirectChatMode={isDirectChatMode}
                    chatBusy={chatBusy}
                    onDeleteMessage={onDeleteMessage}
                    onDeleteTurn={onDeleteTurn}
                  />
                );
              })}
```

- [ ] **Step 6: Add `onDeleteTurn` to the test helper default props**

In `dashboard/tests/tab-components.test.tsx`, in the `renderChatTab` props object, after the `onDeleteMessage: ...` line add:

```ts
    onDeleteTurn: overrides.onDeleteTurn ?? (async () => {}),
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx tsx --test dashboard/tests/tab-components.test.tsx`
Expected: PASS (existing cases + 4 new cases). If a pre-existing test asserted the old flat structure for run-grouped/thinking/tool fixtures, update its expectation to the turn-wrapped markup (`msg assistant turn` + `Internal Logic`).

- [ ] **Step 8: Typecheck**

Run: `npm --prefix dashboard run build`
Expected: PASS (tsc reports no errors). The build will fail at `<ChatTab ... />` in `App.tsx` because `onDeleteTurn` is now required — that is wired in Task 3.

- [ ] **Step 9: Commit**

```bash
git add dashboard/src/tabs/ChatTab.tsx dashboard/tests/tab-components.test.tsx
git commit -m "feat(chat): render assistant turns as single bubbles with Internal Logic"
```

---

## Task 3: Wire turn-level delete (hook + App)

**Files:**
- Modify: `dashboard/src/hooks/useChatSessions.ts:248-263` (add `deleteMessages` after `deleteMessage`) and the returned object (~line 285)
- Modify: `dashboard/src/App.tsx:718-732` (refresh helper + `onDeleteChatTurn`) and the `<ChatTab>` usage (~line 1362)

- [ ] **Step 1: Add `deleteMessages` to the hook**

In `dashboard/src/hooks/useChatSessions.ts`, immediately after the `deleteMessage` function (ends ~line 263) add:

```ts
  async function deleteMessages(messageIds: string[]): Promise<ChatSessionResponse | null> {
    if (!selectedSessionId || messageIds.length === 0) {
      return null;
    }
    setChatBusy(true);
    try {
      let response: ChatSessionResponse | null = null;
      for (const messageId of messageIds) {
        if (!messageId) {
          continue;
        }
        response = await deleteChatMessage(selectedSessionId, messageId);
        applySessionResponse(response);
      }
      return response;
    } catch (error) {
      deps.onError(error);
      return null;
    } finally {
      setChatBusy(false);
    }
  }
```

In the returned object (the block starting ~line 272), after `deleteMessage,` add:

```ts
    deleteMessage,
    deleteMessages,
```

And in the result interface (`UseChatSessionsResult`, ~line 34 next to `deleteMessage(messageId: string)`), add:

```ts
  deleteMessage(messageId: string): Promise<ChatSessionResponse | null>;
  deleteMessages(messageIds: string[]): Promise<ChatSessionResponse | null>;
```

- [ ] **Step 2: Extract the post-delete refresh and add `onDeleteChatTurn` in App**

In `dashboard/src/App.tsx`, replace the existing `onDeleteChatMessage` function (lines 718-732) with:

```ts
  async function refreshAfterChatMessageMutation(): Promise<void> {
    requestDashboardDataRefresh();
    if (selectedRunId) {
      try {
        const detail = await getRunDetail(selectedRunId);
        setSelectedRunDetail(detail);
      } catch (error) {
        setChatError(describeStreamError(error));
      }
    }
  }

  async function onDeleteChatMessage(messageId: string): Promise<void> {
    const response = await chatSessionsHook.deleteMessage(messageId);
    if (!response) {
      return;
    }
    await refreshAfterChatMessageMutation();
  }

  async function onDeleteChatTurn(messageIds: string[]): Promise<void> {
    const response = await chatSessionsHook.deleteMessages(messageIds);
    if (!response) {
      return;
    }
    await refreshAfterChatMessageMutation();
  }
```

- [ ] **Step 3: Pass `onDeleteTurn` into `<ChatTab>`**

In `dashboard/src/App.tsx`, directly after the `onDeleteMessage={onDeleteChatMessage}` line (~1362) add:

```tsx
          onDeleteMessage={onDeleteChatMessage}
          onDeleteTurn={onDeleteChatTurn}
```

- [ ] **Step 4: Typecheck the whole dashboard**

Run: `npm --prefix dashboard run build`
Expected: PASS — `tsc` clean and `vite build` succeeds; `<ChatTab>` now receives the required `onDeleteTurn`.

- [ ] **Step 5: Run the full dashboard test files**

Run: `npx tsx --test dashboard/tests/lib/chatTurns.test.ts dashboard/tests/tab-components.test.tsx dashboard/tests/hooks/useChatComposer.test.tsx`
Expected: PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/hooks/useChatSessions.ts dashboard/src/App.tsx
git commit -m "feat(chat): add turn-level delete wiring"
```

---

## Task 4: Turn bubble styles

**Files:**
- Modify: `dashboard/src/styles.css` (append after the `.markdown-body` rules, ~line 990)

- [ ] **Step 1: Add CSS**

Append to `dashboard/src/styles.css`:

```css
.msg.turn {
  display: grid;
  gap: 8px;
}

.msg.turn .internal-logic {
  border: 1px solid var(--stroke);
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.18);
  padding: 4px 8px;
}

.msg.turn .internal-logic > summary {
  cursor: pointer;
  font-size: 12px;
  opacity: 0.8;
  list-style: none;
}

.msg.turn .internal-logic[open] > summary {
  margin-bottom: 8px;
}

.msg.turn .internal-logic-steps {
  display: grid;
  gap: 8px;
}

/* Nested step/answer bubbles inside a turn: drop the speech-bubble tail,
   span full width, soften the background so the turn reads as one unit. */
.msg.turn .msg {
  max-width: 100%;
  background: rgba(255, 255, 255, 0.03);
}

.msg.turn .msg::after {
  display: none;
}

.msg.turn .msg.turn-main {
  background: transparent;
  border-color: transparent;
  padding: 0;
}
```

- [ ] **Step 2: Verify the build still compiles**

Run: `npm --prefix dashboard run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/styles.css
git commit -m "style(chat): style turn bubbles and Internal Logic section"
```

---

## Self-Review Notes

- **Spec coverage:** turn wrapping (Task 2 `ChatTurnBubble`); latest-item-while-live + live Internal Logic (Task 1 `finalizeTurn` main=last when no answer + Task 2 main slot; live steps = all but latest); collapsed Internal Logic by default (`<details>` without `open`); per-step delete (Task 2 `MessageHeader` in steps); answer deletable independently (Task 2 `turn-main` `MessageHeader`); plain answer for 0-step turns (Task 2 Step 5 branch); turn-level delete (Tasks 2–3); no backend change (Task 3 loops existing `deleteChatMessage`).
- **Type consistency:** `groupMessagesIntoTurns`, `normalizeMessageKind`, `ChatTurn`, `deleteMessages`, `onDeleteTurn(messageIds: string[])`, `MessageBubble`, `ChatTurnBubble` names match across all tasks.
- **Live deletion suppressed:** `MessageHeader` and the turn-delete button both gate on `!isLive` / `!turn.isLive`, so streaming turns expose no delete controls (verified by Task 2 live test).
- **No placeholders:** every code/test step shows full content; test commands include expected pass/fail.

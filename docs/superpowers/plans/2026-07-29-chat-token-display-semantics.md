# Chat Token Display Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every token figure in the chat UI mean "tokens this element added to the context", so a turn header's number is exactly the sum of the numbers on its children, and move context-window fullness into a separate, visually distinct slot.

**Architecture:** Three render sites currently mix two quantities. `ToolCallCard` switches from the absolute prompt size (`toolCallPromptTokenCount`) to the tool result's own contribution (`associatedToolTokens`). The turn header switches from a filtered partial sum to an unfiltered total, and gains a second slot showing `max(toolCallPromptTokenCount)` over its steps against the session context window. Aggregation helpers move into `dashboard/src/lib/chatTurns.ts` (turn-level) and `dashboard/src/lib/format.ts` (message-level plus formatting), so `ChatTab.tsx` holds no token arithmetic.

**Tech Stack:** TypeScript, React 19, `node:test` + `node:assert/strict` + `react-dom/server` `renderToStaticMarkup` (the established dashboard test style).

**Spec:** `docs/superpowers/specs/2026-07-29-chat-token-display-semantics-design.md`

---

## Background for the implementer

Three facts about this codebase before you start.

**1. Where the two numbers come from today.**

`toolCallPromptTokenCount` is produced by the agent-loop prompt preflight as
`transcriptPromptTokenCount + providerPromptReserveTokenCount`
(`src/repo-search/prompt-budget.ts:100-115`). It is the entire prompt sent to the model at that
turn — transcript plus system prompt plus tool schemas. It rises monotonically through a run. It is
**not** a delta and must never be summed.

`associatedToolTokens` is the token count of a single tool's result. It is set live from the SSE
tool event's `outputTokens` (`dashboard/src/hooks/useLiveMessages.ts:66`) and on replay by the
status server (`src/status-server/chat.ts:487`). It **is** a delta.

**2. The estimated flags are not a display concern.**

`inputTokensEstimated` / `outputTokensEstimated` / `thinkingTokensEstimated` stay in
`packages/contracts/src/chat.ts`. They are load-bearing for `src/status-server/metrics.ts`,
`src/status-server/chat-turn-telemetry.ts`, and the `estimatedTokenFallbackTokens` path behind the
composer context bar. **Do not remove them from the contract.** This plan only stops the chat
message display from reading them.

**3. Task order exists because of one compile unit.**

Task 1 deletes symbols that `ChatTab.tsx` imports, so `ChatTab.tsx` will not compile from the end of
Task 1 until the end of Task 4. Tasks 2 and 3 have their own test files that do not import
`ChatTab`, so they stay green throughout. Do not reorder.

**Running the tests.** Dashboard tests are not discovered by `npm test` (the root runner scans
`tests/` only). Run them directly:

```bash
npx tsx --test dashboard/tests/<file>
```

Full dashboard suite:

```bash
npx tsx --test dashboard/tests/*.test.ts dashboard/tests/*.test.tsx dashboard/tests/hooks/*.test.tsx dashboard/tests/lib/*.test.ts
```

---

## File structure

| File | Responsibility after this change |
| --- | --- |
| `dashboard/src/lib/format.ts` | Message-level token arithmetic (`getMessageTokenCount`) and token formatting (`formatTokenDelta`, `formatContextFill`). Loses all known/exact filtering. |
| `dashboard/src/lib/chatTurns.ts` | Turn grouping (existing) plus turn-level aggregation: `getTurnTokenTotal`, `getTurnContextTokenCount`. |
| `dashboard/src/components/ToolCallCard.tsx` | Renders the tool result's own contribution. |
| `dashboard/src/tabs/ChatTab.tsx` | Render only. All token arithmetic removed; calls the two libs. |
| `dashboard/src/styles/chat.css` | Adds `.msg-context` so the fullness figure does not read as a contribution. |

Test files: `dashboard/tests/format.test.ts` (extend), `dashboard/tests/lib/chatTurns.test.ts`
(extend), `dashboard/tests/tool-call-card.test.tsx` (rewrite one case, add two),
`dashboard/tests/chat-tab.test.tsx` (extend — this holds the end-to-end reconciliation test).

---

## Task 1: Message-level token count and the two formatters

Replaces the known-vs-exact machinery in `format.ts` with a single unconditional sum, and adds the
two formatters every render site will share.

**Files:**
- Modify: `dashboard/src/lib/format.ts:51-53` (delete `formatTokenLabel`), `:71-101` (replace)
- Test: `dashboard/tests/format.test.ts`

- [ ] **Step 1: Write the failing tests**

In `dashboard/tests/format.test.ts`, change the import on line 4 to:

```ts
import { formatContextFill, formatTokenDelta, getMessageTokenCount, getSessionTelemetryStats } from '../src/lib/format';
```

Append to the end of the file:

```ts
test('getMessageTokenCount sums every component regardless of the estimated flags', () => {
  const message = {
    id: 'm1',
    role: 'assistant',
    content: 'Hello',
    inputTokensEstimate: 10,
    outputTokensEstimate: 20,
    thinkingTokens: 30,
    inputTokensEstimated: true,
    outputTokensEstimated: false,
    thinkingTokensEstimated: true,
    createdAtUtc: '2026-07-29T00:00:00.000Z',
    sourceRunId: null,
  } satisfies ChatSession['messages'][number];

  assert.equal(getMessageTokenCount(message), 60);
});

test('getMessageTokenCount treats missing and negative components as zero', () => {
  const message = {
    id: 'm2',
    role: 'assistant',
    content: '',
    inputTokensEstimate: -5,
    outputTokensEstimate: 7,
    thinkingTokens: 0,
    createdAtUtc: '2026-07-29T00:00:00.000Z',
    sourceRunId: null,
  } satisfies ChatSession['messages'][number];

  assert.equal(getMessageTokenCount(message), 7);
});

test('formatTokenDelta renders a signed, grouped token contribution', () => {
  assert.equal(formatTokenDelta(3120), '+3,120 tok');
  assert.equal(formatTokenDelta(0), '+0 tok');
});

test('formatContextFill renders compact used-over-window fullness', () => {
  assert.equal(formatContextFill(66_000, 128_000), '66k/128k');
  assert.equal(formatContextFill(940, 128_000), '940/128k');
});
```

The `ChatSession` type is already imported on line 5 of that file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test dashboard/tests/format.test.ts`

Expected: FAIL — `formatTokenDelta` and `formatContextFill` are not exported from
`../src/lib/format`, and `getMessageTokenCount` currently returns `number | null`.

- [ ] **Step 3: Replace the token helpers in `format.ts`**

Delete `dashboard/src/lib/format.ts:51-53`:

```ts
export function formatTokenLabel(value: number | null, exactLabel = 'tokens'): string {
  return value === null ? 'tokens unavailable' : `${formatNumber(value)} ${exactLabel}`;
}
```

Then replace the block from `hasExactTokenComponent` (line 71) through
`getReplayDisplayTokenCount` (line 101) — leaving `readTokenComponent` at lines 66-69 untouched —
with:

```ts
export function getMessageTokenCount(message: ChatSession['messages'][number]): number {
  return readTokenComponent(message.inputTokensEstimate)
    + readTokenComponent(message.outputTokensEstimate)
    + readTokenComponent(message.thinkingTokens);
}

export function formatTokenDelta(tokenCount: number): string {
  return `+${formatNumber(tokenCount)} tok`;
}

export function formatContextFill(usedTokens: number, contextWindowTokens: number): string {
  return `${formatCompactTokenCount(usedTokens)}/${formatCompactTokenCount(contextWindowTokens)}`;
}
```

`formatCompactTokenCount` is declared later in the same file (line ~348); function declarations
hoist, so no reordering is needed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test dashboard/tests/format.test.ts`

Expected: PASS, 7 tests (3 pre-existing + 4 new).

`dashboard/tests/chat-tab.test.tsx` is now broken — `ChatTab.tsx` still imports the deleted names.
That is expected and is repaired in Task 4.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/format.ts dashboard/tests/format.test.ts
git commit -m "refactor: make message token count an unconditional sum"
```

---

## Task 2: Turn-level aggregation helpers

Moves the turn arithmetic out of `ChatTab.tsx` into `chatTurns.ts`, where the `ChatTurn` type
already lives.

**Files:**
- Modify: `dashboard/src/lib/chatTurns.ts` (one new import, two appended functions)
- Test: `dashboard/tests/lib/chatTurns.test.ts`

- [ ] **Step 1: Write the failing tests**

In `dashboard/tests/lib/chatTurns.test.ts`, change the import on line 5 to:

```ts
import {
  getTurnContextTokenCount,
  getTurnTokenTotal,
  groupMessagesIntoTurns,
  normalizeMessageKind,
} from '../../src/lib/chatTurns';
```

Append to the end of the file. The `message` fixture at line 8 defaults every token component to
`0`, so only the overrides below contribute.

```ts
test('getTurnTokenTotal sums every message in the turn', () => {
  const turns = groupMessagesIntoTurns([
    message({ id: 's1', kind: 'assistant_thinking', sourceRunId: 'run-1', thinkingTokens: 400 }),
    message({ id: 's2', kind: 'assistant_tool_call', sourceRunId: 'run-1', outputTokensEstimate: 3120 }),
    message({ id: 's3', kind: 'assistant_tool_call', sourceRunId: 'run-1', outputTokensEstimate: 1940 }),
    message({ id: 'a1', kind: 'assistant_answer', sourceRunId: 'run-1', outputTokensEstimate: 260 }),
  ], new Set());

  assert.equal(turns.length, 1);
  assert.equal(getTurnTokenTotal(turns[0]), 5720);
});

test('getTurnTokenTotal counts estimated components the same as exact ones', () => {
  const turns = groupMessagesIntoTurns([
    message({ id: 's1', kind: 'assistant_thinking', sourceRunId: 'run-6', thinkingTokens: 890, thinkingTokensEstimated: true }),
    message({ id: 'a1', kind: 'assistant_answer', sourceRunId: 'run-6', outputTokensEstimate: 110, outputTokensEstimated: false }),
  ], new Set());

  assert.equal(getTurnTokenTotal(turns[0]), 1000);
});

test('getTurnContextTokenCount reports the largest step prompt size', () => {
  const turns = groupMessagesIntoTurns([
    message({ id: 's1', kind: 'assistant_tool_call', sourceRunId: 'run-1', toolCallPromptTokenCount: 62_140 }),
    message({ id: 's2', kind: 'assistant_tool_call', sourceRunId: 'run-1', toolCallPromptTokenCount: 66_020 }),
    message({ id: 'a1', kind: 'assistant_answer', sourceRunId: 'run-1' }),
  ], new Set());

  assert.equal(getTurnContextTokenCount(turns[0]), 66_020);
});

test('getTurnContextTokenCount is null when no step reported a prompt size', () => {
  const turns = groupMessagesIntoTurns([
    message({ id: 's1', kind: 'assistant_thinking', sourceRunId: 'run-1', thinkingTokens: 12 }),
    message({ id: 'a1', kind: 'assistant_answer', sourceRunId: 'run-1' }),
  ], new Set());

  assert.equal(getTurnContextTokenCount(turns[0]), null);
});

test('getTurnContextTokenCount ignores non-positive prompt sizes', () => {
  const turns = groupMessagesIntoTurns([
    message({ id: 's1', kind: 'assistant_tool_call', sourceRunId: 'run-1', toolCallPromptTokenCount: 0 }),
    message({ id: 's2', kind: 'assistant_tool_call', sourceRunId: 'run-1', toolCallPromptTokenCount: null }),
    message({ id: 'a1', kind: 'assistant_answer', sourceRunId: 'run-1' }),
  ], new Set());

  assert.equal(getTurnContextTokenCount(turns[0]), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test dashboard/tests/lib/chatTurns.test.ts`

Expected: FAIL — `getTurnTokenTotal` and `getTurnContextTokenCount` are not exported from
`../../src/lib/chatTurns`.

- [ ] **Step 3: Add the helpers to `chatTurns.ts`**

Add below the existing import on line 1 of `dashboard/src/lib/chatTurns.ts`:

```ts
import { getMessageTokenCount } from './format';
```

Append at the end of the file:

```ts
export function getTurnTokenTotal(turn: ChatTurn): number {
  let total = 0;
  for (const message of turn.messages) {
    total += getMessageTokenCount(message);
  }
  return total;
}

// The prompt sent at each step already contains every earlier step, so the largest step
// prompt is the turn's context high-water mark. Absolute, never summed.
export function getTurnContextTokenCount(turn: ChatTurn): number | null {
  let contextTokenCount: number | null = null;
  for (const message of turn.messages) {
    const promptTokenCount = Number(message.toolCallPromptTokenCount);
    if (Number.isFinite(promptTokenCount) && promptTokenCount > 0) {
      contextTokenCount = Math.max(contextTokenCount ?? 0, promptTokenCount);
    }
  }
  return contextTokenCount;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test dashboard/tests/lib/chatTurns.test.ts`

Expected: PASS — all pre-existing tests plus the 5 new ones.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/chatTurns.ts dashboard/tests/lib/chatTurns.test.ts
git commit -m "feat: add turn token total and context high-water helpers"
```

---

## Task 3: Tool card shows its own contribution

**Files:**
- Modify: `dashboard/src/components/ToolCallCard.tsx:1-23`
- Test: `dashboard/tests/tool-call-card.test.tsx:26-35` (rewrite), plus two new cases

- [ ] **Step 1: Rewrite the completed-call test and add two cases**

Replace `dashboard/tests/tool-call-card.test.tsx:26-35` with:

```tsx
test('completed tool call shows its own token contribution and collapsible output', () => {
  const markup = renderToStaticMarkup(
    <ToolCallCard message={msg({ toolCallCommand: 'grep "x"', toolCallStatus: 'done', toolCallOutput: 'line1\nline2', associatedToolTokens: 3120, toolCallPromptTokenCount: 66_020 })} />,
  );
  assert.match(markup, /✓/);
  assert.match(markup, /\+3,120 tok/);
  assert.doesNotMatch(markup, /66k/);
  assert.doesNotMatch(markup, /loaded/);
  assert.match(markup, /<pre/);
  assert.match(markup, /line1/);
});

test('completed tool call with no reported contribution falls back to a status word', () => {
  const markup = renderToStaticMarkup(
    <ToolCallCard message={msg({ toolCallCommand: 'grep "x"', toolCallStatus: 'done', toolCallOutput: 'line1', associatedToolTokens: null })} />,
  );
  assert.match(markup, /✓ loaded/);
  assert.doesNotMatch(markup, /tok/);
});

test('running tool call shows no token figure', () => {
  const markup = renderToStaticMarkup(
    <ToolCallCard message={msg({ toolCallCommand: 'grep "x"', toolCallStatus: 'running', associatedToolTokens: 3120 })} />,
  );
  assert.doesNotMatch(markup, /tok/);
  assert.doesNotMatch(markup, /✓/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test dashboard/tests/tool-call-card.test.tsx`

Expected: FAIL — the card renders `66k tok loaded` from `toolCallPromptTokenCount`, so
`/\+3,120 tok/` does not match and `/66k/` does.

- [ ] **Step 3: Rewrite the card header**

Replace `dashboard/src/components/ToolCallCard.tsx:1-23` with:

```tsx
import React from 'react';
import { getToolRunningLabel } from '../lib/tool-status';
import { formatTokenDelta } from '../lib/format';
import type { ChatMessage } from '../types';

export function ToolCallCard({ message }: { message: ChatMessage }) {
  const command = typeof message.toolCallCommand === 'string' ? message.toolCallCommand.trim() : '';
  const output = message.toolCallOutput || message.toolCallOutputSnippet || '';
  const isRunning = message.toolCallStatus === 'running';
  // The tokens this call added to the context. The absolute prompt size lives on the
  // turn header, so it is not repeated here.
  const tokenLabel = typeof message.associatedToolTokens === 'number'
    ? formatTokenDelta(message.associatedToolTokens)
    : 'loaded';

  return (
    <div className="tcall">
      <header>
        {isRunning ? <span className="sp" /> : null}
        <span className="tn">{command}</span>
        {isRunning ? (
          <span>{getToolRunningLabel(command)}</span>
        ) : (
          <span className="tok">✓ {tokenLabel}</span>
        )}
      </header>
```

Leave the rest of the file unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test dashboard/tests/tool-call-card.test.tsx`

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/components/ToolCallCard.tsx dashboard/tests/tool-call-card.test.tsx
git commit -m "feat: tool card reports its own token contribution"
```

---

## Task 4: Turn header and step header

This is the task that removes `known tokens` and makes `ChatTab.tsx` compile again. All edits are in
one file plus one stylesheet, because the header and the step header are the same compile unit.

**Decision recorded here:** a tool-call step renders inside `MessageBubble`, which draws
`MessageHeader` **and** `ToolCallCard`. Once both show a delta, the same number would appear twice
on one step. The figure lives on the innermost element that owns it, so `MessageHeader` omits its
token span for `assistant_tool_call` and the card (Task 3) carries it.

**Files:**
- Modify: `dashboard/src/tabs/ChatTab.tsx:5-13` (imports), `:21` (import), `:43-66` (delete),
  `:297-306` (call site), `:447-478` (`MessageHeader`), `:527-565` (`ChatTurnBubble` header)
- Modify: `dashboard/src/styles/chat.css:25`
- Test: `dashboard/tests/chat-tab.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append to `dashboard/tests/chat-tab.test.tsx`. The file already has a `msg` fixture (line 15), a
`SESSION` fixture (line 24), and a `render` helper (line 39) — reuse all three. `SESSION`'s
`contextWindowTokens` is `100`, so each case overrides it.

```ts
test('turn header delta equals the sum of its children and the context slot is separate', () => {
  const messages = [
    msg({ id: 's1', kind: 'assistant_thinking', sourceRunId: 'run-1', content: 'thinking', thinkingTokens: 400 }),
    msg({ id: 's2', kind: 'assistant_tool_call', sourceRunId: 'run-1', toolCallCommand: 'read path="a.ts"', toolCallStatus: 'done', toolCallOutput: 'x', outputTokensEstimate: 3120, associatedToolTokens: 3120, toolCallPromptTokenCount: 62_140 }),
    msg({ id: 's3', kind: 'assistant_tool_call', sourceRunId: 'run-1', toolCallCommand: 'grep "foo"', toolCallStatus: 'done', toolCallOutput: 'y', outputTokensEstimate: 1940, associatedToolTokens: 1940, toolCallPromptTokenCount: 66_020 }),
    msg({ id: 'a1', kind: 'assistant_answer', sourceRunId: 'run-1', content: 'done', outputTokensEstimate: 260 }),
  ];
  const session = { ...SESSION, contextWindowTokens: 128_000, messages } satisfies ChatSession;

  const markup = render({ selectedSession: session });

  // 400 + 3,120 + 1,940 + 260 = 5,720
  assert.match(markup, /class="msg-tokens"[^>]*>\+5,720 tok</);
  assert.match(markup, /class="msg-context"[^>]*>66k\/128k</);
  assert.doesNotMatch(markup, /known tokens/);
  assert.doesNotMatch(markup, /tokens unavailable/);
});

test('turn header omits the context slot when no step reported a prompt size', () => {
  const messages = [
    msg({ id: 's1', kind: 'assistant_thinking', sourceRunId: 'run-2', content: 'thinking', thinkingTokens: 40 }),
    msg({ id: 'a1', kind: 'assistant_answer', sourceRunId: 'run-2', content: 'done', outputTokensEstimate: 60 }),
  ];
  const session = { ...SESSION, contextWindowTokens: 128_000, messages } satisfies ChatSession;

  const markup = render({ selectedSession: session });

  assert.match(markup, /class="msg-tokens"[^>]*>\+100 tok</);
  assert.doesNotMatch(markup, /class="msg-context"/);
});

test('turn header counts estimated components with no marker', () => {
  const messages = [
    msg({ id: 's1', kind: 'assistant_thinking', sourceRunId: 'run-3', content: 'thinking', thinkingTokens: 890, thinkingTokensEstimated: true }),
    msg({ id: 's2', kind: 'assistant_tool_call', sourceRunId: 'run-3', toolCallCommand: 'grep "foo"', toolCallStatus: 'done', toolCallOutput: 'y', outputTokensEstimate: 1940, associatedToolTokens: 1940, outputTokensEstimated: false, toolCallPromptTokenCount: 9000 }),
    msg({ id: 'a1', kind: 'assistant_answer', sourceRunId: 'run-3', content: 'done', outputTokensEstimate: 170, outputTokensEstimated: true }),
  ];
  const session = { ...SESSION, contextWindowTokens: 128_000, messages } satisfies ChatSession;

  const markup = render({ selectedSession: session });

  // 890 + 1,940 + 170 = 3,000 — the estimated flags change nothing.
  assert.match(markup, /class="msg-tokens"[^>]*>\+3,000 tok</);
  assert.doesNotMatch(markup, /~/);
});

test('a thinking step renders its own delta in the step header', () => {
  const messages = [
    msg({ id: 's1', kind: 'assistant_thinking', sourceRunId: 'run-4', content: 'thinking', thinkingTokens: 890 }),
    msg({ id: 'a1', kind: 'assistant_answer', sourceRunId: 'run-4', content: 'done', outputTokensEstimate: 110 }),
  ];
  const session = { ...SESSION, contextWindowTokens: 128_000, messages } satisfies ChatSession;

  const markup = render({ selectedSession: session });

  assert.match(markup, /class="msg-tokens"[^>]*>\+890 tok</);
});

test('a tool-call step shows its delta exactly once, on the card', () => {
  const messages = [
    msg({ id: 's1', kind: 'assistant_tool_call', sourceRunId: 'run-5', toolCallCommand: 'grep "foo"', toolCallStatus: 'done', toolCallOutput: 'y', outputTokensEstimate: 1940, associatedToolTokens: 1940, toolCallPromptTokenCount: 9000 }),
    msg({ id: 'a1', kind: 'assistant_answer', sourceRunId: 'run-5', content: 'done', outputTokensEstimate: 60 }),
  ];
  const session = { ...SESSION, contextWindowTokens: 128_000, messages } satisfies ChatSession;

  const markup = render({ selectedSession: session });

  assert.equal(markup.match(/\+1,940 tok/g)?.length, 1);
  assert.doesNotMatch(markup, /class="msg-tokens"[^>]*>\+1,940 tok</);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test dashboard/tests/chat-tab.test.tsx`

Expected: FAIL to compile — `ChatTab.tsx` imports `formatTokenLabel`,
`getMessageKnownTokenCount`, and `getReplayDisplayTokenCount`, all deleted in Task 1.

- [ ] **Step 3: Fix the imports**

Replace `dashboard/src/tabs/ChatTab.tsx:5-13` with:

```tsx
import {
  formatCompactTokenCount,
  formatContextFill,
  formatDate,
  formatNumber,
  formatTokenDelta,
  getMessageTokenCount,
} from '../lib/format';
```

`formatCompactTokenCount` stays — it is still used by the composer context label at line ~373.

Replace line 21 with:

```tsx
import {
  getTurnContextTokenCount,
  getTurnTokenTotal,
  groupMessagesIntoTurns,
  normalizeMessageKind,
  type ChatTurn,
} from '../lib/chatTurns';
```

- [ ] **Step 4: Delete the local turn arithmetic**

Delete `dashboard/src/tabs/ChatTab.tsx:43-66` in full — the `TurnTokenDisplay` type and the
`getTurnTokenDisplay` function:

```tsx
type TurnTokenDisplay = {
  tokenCount: number | null;
  exact: boolean;
};

function getTurnTokenDisplay(messages: ChatMessage[]): TurnTokenDisplay {
  let total = 0;
  let knownTotal = 0;
  let hasUnavailableComponent = false;
  for (const message of messages) {
    const tokenCount = getMessageTokenCount(message);
    if (tokenCount === null) {
      hasUnavailableComponent = true;
      knownTotal += getMessageKnownTokenCount(message);
    } else {
      total += tokenCount;
      knownTotal += tokenCount;
    }
  }
  if (!hasUnavailableComponent) {
    return { tokenCount: total, exact: true };
  }
  return knownTotal > 0 ? { tokenCount: knownTotal, exact: false } : { tokenCount: null, exact: false };
}
```

- [ ] **Step 5: Rewrite `MessageHeader`**

Replace `dashboard/src/tabs/ChatTab.tsx:447-478` with:

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
      : message.role === 'user' ? 'You' : 'SiftKit';
  return (
    <div className="who">
      <span>{messageLabel} · {isLive ? 'live' : formatDate(message.createdAtUtc)}</span>
      <span className="msg-meta">
        {/* A tool call carries its delta on the card itself; do not render it twice. */}
        {messageKind === 'assistant_tool_call' ? null : (
          <span className="msg-tokens">{formatTokenDelta(getMessageTokenCount(message))}</span>
        )}
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
    </div>
  );
}
```

- [ ] **Step 6: Rewrite the turn header**

Replace `dashboard/src/tabs/ChatTab.tsx:527-565` — the `ChatTurnBubble` signature through the
closing `</div>` of its `who` row — with:

```tsx
function ChatTurnBubble({ turn, contextWindowTokens, isDirectChatMode, chatBusy, onDeleteMessage, onDeleteTurn }: {
  turn: ChatTurn;
  contextWindowTokens: number;
  isDirectChatMode: boolean;
  chatBusy: boolean;
  onDeleteMessage(messageId: string): Promise<void>;
  onDeleteTurn(messageIds: string[]): Promise<void>;
}) {
  const turnTokenTotal = getTurnTokenTotal(turn);
  const turnContextTokenCount = getTurnContextTokenCount(turn);
  const headerTimestamp = turn.main ? turn.main.createdAtUtc : turn.messages[0]?.createdAtUtc ?? null;
  return (
    <article className={`msg ai turn${turn.isLive ? ' live' : ''}`}>
      <div className="who">
        <span>SiftKit · {turn.isLive ? 'live' : formatDate(headerTimestamp)}</span>
        <span className="msg-meta">
          <span className="msg-tokens" title={`${formatNumber(turnTokenTotal)} tokens added to the context by this turn`}>
            {formatTokenDelta(turnTokenTotal)}
          </span>
          {turnContextTokenCount !== null && contextWindowTokens > 0 ? (
            <span
              className="msg-context"
              title={`Context at this turn's largest step: ${formatNumber(turnContextTokenCount)} of ${formatNumber(contextWindowTokens)} tokens. Absolute prompt size, not part of the total above.`}
            >
              {formatContextFill(turnContextTokenCount, contextWindowTokens)}
            </span>
          ) : null}
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
      </div>
```

Leave everything below that `</div>` — the `<details className="internal-logic">` block onward —
unchanged.

- [ ] **Step 7: Pass the context window at the call site**

In `dashboard/src/tabs/ChatTab.tsx:297-306`, add the new prop:

```tsx
                return (
                  <ChatTurnBubble
                    key={turn.key}
                    turn={turn}
                    contextWindowTokens={selectedSession.contextWindowTokens}
                    isDirectChatMode={isDirectChatMode}
                    chatBusy={chatBusy}
                    onDeleteMessage={onDeleteMessage}
                    onDeleteTurn={onDeleteTurn}
                  />
                );
```

`selectedSession` is already in scope there — it is used at line 265.

- [ ] **Step 8: Style the context slot so it does not read as a contribution**

In `dashboard/src/styles/chat.css`, replace line 25:

```css
.msg-tokens { color: var(--dim); }
```

with:

```css
.msg-tokens { color: var(--dim); font-variant-numeric: tabular-nums; }
.msg-context {
  color: var(--dim); font-variant-numeric: tabular-nums;
  border: 1px solid var(--line); border-radius: 999px; padding: 0 6px; opacity: 0.8;
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx tsx --test dashboard/tests/chat-tab.test.tsx`

Expected: PASS — all pre-existing tests plus the 5 new ones.

- [ ] **Step 10: Commit**

```bash
git add dashboard/src/tabs/ChatTab.tsx dashboard/src/styles/chat.css dashboard/tests/chat-tab.test.tsx
git commit -m "feat: turn header shows an additive delta and a separate context slot"
```

---

## Task 5: Full verification

**Files:** none modified unless a gate fails.

- [ ] **Step 1: Run the whole dashboard suite**

```bash
npx tsx --test dashboard/tests/*.test.ts dashboard/tests/*.test.tsx dashboard/tests/hooks/*.test.tsx dashboard/tests/lib/*.test.ts
```

Expected: PASS, zero failures.

- [ ] **Step 2: Confirm the deleted symbols have no callers left**

```bash
git grep -n "formatTokenLabel\|getMessageKnownTokenCount\|getReplayDisplayTokenCount\|known tokens\|tokens unavailable" -- dashboard src packages
```

Expected: no output. Any hit is a missed call site — fix it before continuing.

- [ ] **Step 3: Confirm the estimated flags survive outside the chat display**

```bash
git grep -n "TokensEstimated" -- packages/contracts/src/chat.ts src/status-server
```

Expected: hits in `packages/contracts/src/chat.ts`, `src/status-server/chat.ts`,
`src/status-server/chat-turn-telemetry.ts`, `src/status-server/metrics.ts`. If any are gone the
contract was over-pruned — restore them.

- [ ] **Step 4: Typecheck and lint**

```bash
npm run typecheck
```

Expected: exit 0. This covers the dashboard project, the dashboard test project, and `eslint .`.

- [ ] **Step 5: Run the root test suite for regressions**

```bash
npm test
```

Expected: PASS. Nothing in this plan touches `src/`, so a failure here is pre-existing — confirm by
stashing and re-running before investigating.

- [ ] **Step 6: Visual check**

```bash
npm run start
```

Open the dashboard, run a repo-search turn, and confirm on a completed turn:
- each tool card reads `✓ +N tok`
- the turn header reads `+N tok` next to a pill reading `Nk/Nk`
- the header's `+N tok` equals the sum of the step figures inside Internal Logic
- `known tokens` and `loaded` no longer appear

- [ ] **Step 7: Commit any fixes**

```bash
git add -A
git commit -m "test: verify chat token display reconciles across turn and steps"
```

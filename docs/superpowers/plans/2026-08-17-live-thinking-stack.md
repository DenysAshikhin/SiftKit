# Live Thinking Stack (Variant A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** During a live agentic turn, keep the three most recent thinking blocks visible as an age-faded stack above the running tool call, instead of demoting reasoning into collapsed `Internal Logic` the moment a tool starts — and relax the repo-search prompt's opening-search requirement from five calls to one-to-three.

**Architecture:** The live thinking messages are already retained in full by the runtime store (`chat-session-runtime-store.ts:93` passes `maintainPerStepThinking: true`). Nothing is lost — the turn model discards it at render time. So the fix is confined to the turn model and the renderer: `ChatTurn` gains a `liveThinking` slot that holds the newest N thinking messages for live turns only, `pickMainMessage` yields the main slot to the newest *tool call* rather than the newest *message*, and `ChatTurnBubble` renders the stack between `Internal Logic` and the main bubble. Settled (non-live) turns get an empty `liveThinking` and are byte-identical to today. The repo-search prompt change is independent text-and-test surgery in `src/repo-search/prompts.ts`.

**Tech Stack:** React 18 + TypeScript (dashboard, Vite), `node:test` + `node:assert/strict` as the test runner, `react-dom/server` `renderToStaticMarkup` for component assertions, plain CSS (`dashboard/src/styles/chat.css`).

---

## Background: why the thinking block vanishes today

Verified against the current tree:

| Fact | Anchor |
|---|---|
| Every live message is grouped into one turn keyed `live` | `dashboard/src/lib/chatTurns.ts:24-29` (`resolveTurnKey`) |
| For a live turn, `main` is the **last streamed message**, whatever its kind | `dashboard/src/lib/chatTurns.ts:35` |
| Everything that is not `main` becomes `steps` | `dashboard/src/lib/chatTurns.ts:48` |
| `steps` render inside a collapsed `<details class="internal-logic">` | `dashboard/src/tabs/ChatTab.tsx:680-695` |
| All thinking messages are retained in the store — nothing is pruned | `dashboard/src/lib/chat-session-runtime-store.ts:93` (`maintainPerStepThinking: true`) |

So when a `tool_start` event lands, the tool card takes the main slot and the reasoning the user was mid-way through reading folds away. It is a rendering decision, not data loss.

## Design decisions locked in

1. **Variant A** (chosen by the user): thinking stack above, newest tool card below it.
2. **Depth = 3** ("up to the last 3 thinking blocks", from the request). Exposed as `LIVE_THINKING_STACK_DEPTH`.
3. **Newest at the bottom, fully opaque**; older step back to `0.5` then `0.26` opacity with progressively dimmer left borders.
4. **Older entries are clamped** (depth 1 → 2 lines, depth 2 → 1 line) so a long reasoning burst can never push the running tool card out of the viewport. Bounded stack height is the reason this is on by default.
5. **Only depth 0 animates.** `useSmoothedText(text, live)` returns the full string immediately when `live` is `false` (`dashboard/src/hooks/useSmoothedText.ts:50`), so depths 1+ render settled text with no re-typing.
6. **DOM order is unchanged for settled turns.** The stack is inserted *between* the existing `Internal Logic` details and the existing main bubble, so a non-live turn (empty `liveThinking`) produces exactly today's markup.
7. **Once the answer starts streaming, the stack empties** and the turn settles into today's familiar shape. The stack is a live-only affordance.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `dashboard/src/lib/chatTurns.ts` | Modify | Turn model. Owns the `liveThinking` slot, the depth constant, and the `main`/`steps`/`liveThinking` partition. Pure, no React. |
| `dashboard/src/tabs/ChatTab.tsx` | Modify | Renders the stack. `ThinkingBody` gains a depth, a new `ThinkingStack` maps depth over the slot, `ChatTurnBubble` places it, and the turn dispatch stops discarding stack-only turns. |
| `dashboard/src/styles/chat.css` | Modify | The `.think-stack` opacity ramp and line clamping. Presentation only. |
| `src/repo-search/prompts.ts` | Modify | Opening-search requirement and the finish-gate sentence. |
| `dashboard/tests/lib/chatTurns.test.ts` | Modify | Turn-model unit tests. |
| `dashboard/tests/chat-tab.test.tsx` | Modify | Rendered-markup tests. |
| `tests/repo-search-prompts.test.ts` | Modify | Prompt-text assertions. |

## Commands

Run from the repo root (`C:\Users\denys\Documents\GitHub\SiftKit`), PowerShell.

- Single dashboard test file: `npm run build:test; node .\dist\test-runner\run-tests.js --dashboard chatTurns.test.tsx`
  (the runner matches on compiled basename — `src/test-runner/test-targets.ts:26-39`)
- All dashboard tests: `npm run test:dashboard`
- All node tests: `npm run test`
- Types + lint: `npm run typecheck` (this script already ends with `npm run lint`)

Per the repo's large-output routing rule, pipe broad suites through the summarizer:

```text
npm run test:dashboard 2>&1 | siftkit summary --question "Return pass/fail, failing test names, root errors, and relevant file:line anchors."
```

---

### Task 1: Add the `liveThinking` slot to the turn model

**Files:**
- Modify: `dashboard/src/lib/chatTurns.ts:3-49`
- Test: `dashboard/tests/lib/chatTurns.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `dashboard/tests/lib/chatTurns.test.ts`. The existing `message()` helper at the top of that file supplies defaults; keep using it.

```ts
test('a live turn keeps the newest thinking blocks in liveThinking and gives main to the newest tool call', () => {
  const messages = [
    message({ id: 'th1', kind: 'assistant_thinking', sourceRunId: null }),
    message({ id: 'tc1', kind: 'assistant_tool_call', sourceRunId: null, toolCallStatus: 'done' }),
    message({ id: 'th2', kind: 'assistant_thinking', sourceRunId: null }),
    message({ id: 'tc2', kind: 'assistant_tool_call', sourceRunId: null, toolCallStatus: 'running' }),
  ];
  const turns = groupMessagesIntoTurns(messages, new Set(['th1', 'tc1', 'th2', 'tc2']));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].isLive, true);
  assert.deepEqual(turns[0].liveThinking.map((m) => m.id), ['th1', 'th2']);
  assert.equal(turns[0].main?.id, 'tc2');
  assert.deepEqual(turns[0].steps.map((m) => m.id), ['tc1']);
});

test('liveThinking keeps only the newest LIVE_THINKING_STACK_DEPTH blocks; the overflow falls to steps', () => {
  const ids = ['th1', 'th2', 'th3', 'th4', 'th5'];
  const messages = ids.map((id) => message({ id, kind: 'assistant_thinking', sourceRunId: null }));
  const turns = groupMessagesIntoTurns(messages, new Set(ids));
  assert.equal(LIVE_THINKING_STACK_DEPTH, 3);
  assert.deepEqual(turns[0].liveThinking.map((m) => m.id), ['th3', 'th4', 'th5']);
  assert.deepEqual(turns[0].steps.map((m) => m.id), ['th1', 'th2']);
  assert.equal(turns[0].main, null);
});

test('a live turn that is only thinking has no main and an empty steps list', () => {
  const turns = groupMessagesIntoTurns(
    [message({ id: 'th1', kind: 'assistant_thinking', sourceRunId: null })],
    new Set(['th1']),
  );
  assert.deepEqual(turns[0].liveThinking.map((m) => m.id), ['th1']);
  assert.deepEqual(turns[0].steps, []);
  assert.equal(turns[0].main, null);
});

test('once the live answer arrives the stack empties and every step returns to Internal Logic', () => {
  const messages = [
    message({ id: 'th1', kind: 'assistant_thinking', sourceRunId: null }),
    message({ id: 'tc1', kind: 'assistant_tool_call', sourceRunId: null }),
    message({ id: 'ans', kind: 'assistant_answer', sourceRunId: null }),
  ];
  const turns = groupMessagesIntoTurns(messages, new Set(['th1', 'tc1', 'ans']));
  assert.deepEqual(turns[0].liveThinking, []);
  assert.equal(turns[0].main?.id, 'ans');
  assert.deepEqual(turns[0].steps.map((m) => m.id), ['th1', 'tc1']);
});

test('settled turns never populate liveThinking', () => {
  const messages = [
    message({ id: 'th1', kind: 'assistant_thinking', sourceRunId: 'run-1' }),
    message({ id: 'tc1', kind: 'assistant_tool_call', sourceRunId: 'run-1' }),
  ];
  const turns = groupMessagesIntoTurns(messages, new Set());
  assert.deepEqual(turns[0].liveThinking, []);
  assert.equal(turns[0].main, null);
  assert.deepEqual(turns[0].steps.map((m) => m.id), ['th1', 'tc1']);
});
```

Extend the import at `dashboard/tests/lib/chatTurns.test.ts:5` to pull in the new constant:

```ts
import { groupMessagesIntoTurns, normalizeMessageKind, LIVE_THINKING_STACK_DEPTH } from '../../src/lib/chatTurns';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js --dashboard chatTurns.test.tsx`

Expected: FAIL. The build step reports `LIVE_THINKING_STACK_DEPTH` has no exported member in `chatTurns`, and the `liveThinking` property does not exist on `ChatTurn`.

- [ ] **Step 3: Add the constant and widen the type**

In `dashboard/src/lib/chatTurns.ts`, replace lines 1-9:

```ts
import type { ChatMessage } from '../types';

/** How many recent thinking blocks a live turn keeps on screen, newest last. */
export const LIVE_THINKING_STACK_DEPTH = 3;

export type ChatTurn = {
  key: string;
  isLive: boolean;
  messages: ChatMessage[];
  steps: ChatMessage[];
  /** Live-only: the newest thinking blocks, oldest first. Always empty once settled. */
  liveThinking: ChatMessage[];
  main: ChatMessage | null;
};
```

- [ ] **Step 4: Add the kind predicates**

In the same file, directly after `isStepMessage` (currently `chatTurns.ts:19-22`), add:

```ts
function isThinkingMessage(message: ChatMessage): boolean {
  return normalizeMessageKind(message) === 'assistant_thinking';
}

function isToolCallMessage(message: ChatMessage): boolean {
  return normalizeMessageKind(message) === 'assistant_tool_call';
}
```

- [ ] **Step 5: Yield the main slot to the newest tool call**

Replace `pickMainMessage` (currently `chatTurns.ts:31-41`) in full:

```ts
function pickMainMessage(turn: ChatTurn): ChatMessage | null {
  const answer = turn.messages.find(isAnswerMessage);
  if (answer) return answer;
  // Live turn with no answer yet: the newest tool call owns the main slot. The
  // reasoning that led to it lives in the thinking stack instead of being
  // demoted into Internal Logic the moment the tool starts.
  if (turn.isLive) {
    const toolCalls = turn.messages.filter(isToolCallMessage);
    return toolCalls[toolCalls.length - 1] ?? null;
  }
  // Settled, no answer: surface the last non-step message (e.g. a lone user_text
  // message). A settled run that is only thinking/tool steps (answer deleted) has
  // no main slot, so everything stays in Internal Logic.
  const nonStepMessages = turn.messages.filter((message) => !isStepMessage(message));
  return nonStepMessages[nonStepMessages.length - 1] ?? null;
}
```

- [ ] **Step 6: Partition the turn into stack, main, and steps**

Add `pickLiveThinking` immediately after `pickMainMessage`, and replace `finalizeTurn` (currently `chatTurns.ts:43-49`) in full:

```ts
function pickLiveThinking(turn: ChatTurn): ChatMessage[] {
  // Settled turns keep every step in Internal Logic; the stack is live-only.
  if (!turn.isLive) return [];
  // Once the answer streams, the turn settles into the ordinary shape.
  if (turn.messages.some(isAnswerMessage)) return [];
  return turn.messages.filter(isThinkingMessage).slice(-LIVE_THINKING_STACK_DEPTH);
}

function finalizeTurn(turn: ChatTurn): void {
  const main = pickMainMessage(turn);
  const liveThinking = pickLiveThinking(turn);
  turn.main = main;
  turn.liveThinking = liveThinking;
  // steps = everything that is neither the main slot nor on the stack. No kind
  // filter, so a stray extra message in a run renders inside Internal Logic
  // rather than being dropped.
  turn.steps = turn.messages.filter((message) => message !== main && !liveThinking.includes(message));
}
```

- [ ] **Step 7: Seed the new field where turns are created**

In `groupMessagesIntoTurns` (currently `chatTurns.ts:60`), replace the push:

```ts
      turns.push({ key, isLive, messages: [message], steps: [], liveThinking: [], main: null });
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js --dashboard chatTurns.test.tsx`

Expected: PASS, all tests in the file — including the pre-existing ones. Note that `'all live messages collapse into one live turn; main is the latest, rest are steps'` (`chatTurns.test.ts:101-112`) still passes unchanged: its live turn is one thinking plus one tool call, so `main` is still `lc`, but `steps` is now `[]` and the thinking sits in `liveThinking`. **Its `steps` assertion at line 110 will fail.** Update that one assertion to reflect the new partition:

```ts
  assert.deepEqual(turns[0].steps, []);
  assert.deepEqual(turns[0].liveThinking.map((m) => m.id), ['lt']);
  assert.equal(turns[0].main?.id, 'lc');
```

This is not weakening a valid test — the behaviour it pinned is precisely the behaviour being changed, and the replacement is strictly more specific.

- [ ] **Step 9: Commit**

```bash
git add dashboard/src/lib/chatTurns.ts dashboard/tests/lib/chatTurns.test.ts
git commit -m "feat(chat): add live thinking stack slot to the turn model"
```

---

### Task 2: Render the stack in ChatTab

**Files:**
- Modify: `dashboard/src/tabs/ChatTab.tsx:350-353`, `:570-573`, `:607-609`, `:680-706`
- Test: `dashboard/tests/chat-tab.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append to `dashboard/tests/chat-tab.test.tsx`. This mirrors the existing store-driven style of `'a running tool message renders a ToolCallCard with spinner'` (`chat-tab.test.tsx:327-334`), including its `buildDefaultStore` / `render` helpers.

```ts
test('live thinking survives a tool start and renders as a depth-ranked stack', () => {
  const store = buildDefaultStore('session-a')
    .apply({ kind: 'begin', sessionId: 'session-a', operationKind: 'message' })
    .apply({ kind: 'thinking', sessionId: 'session-a', delta: { turn: 1, offset: 0, text: 'first reasoning' } })
    .apply({ kind: 'thinking', sessionId: 'session-a', delta: { turn: 2, offset: 0, text: 'second reasoning' } })
    .apply({ kind: 'tool', sessionId: 'session-a', toolEvent: { kind: 'tool_start', toolCallId: 'tool', turn: 2, maxTurns: 4, command: 'rg thinking' } });

  const markup = render({ selectedRuntime: store.get('session-a'), sessionRuntimes: store.getAll() });

  assert.match(markup, /class="think-stack"/u);
  assert.match(markup, /data-depth="1"[^>]*>first reasoning/u);
  assert.match(markup, /data-depth="0"[^>]*>second reasoning/u);
  // the tool card still renders, below the stack rather than in place of it
  assert.match(markup, /class="think-stack"[\s\S]*class="tcall"/u);
  assert.match(markup, /class="sp"/u);
});

test('a live turn that is only thinking still renders instead of collapsing to nothing', () => {
  const store = buildDefaultStore('session-a')
    .apply({ kind: 'begin', sessionId: 'session-a', operationKind: 'message' })
    .apply({ kind: 'thinking', sessionId: 'session-a', delta: { turn: 1, offset: 0, text: 'sole reasoning' } });

  const markup = render({ selectedRuntime: store.get('session-a'), sessionRuntimes: store.getAll() });

  assert.match(markup, /class="think-stack"/u);
  assert.match(markup, /data-depth="0"[^>]*>sole reasoning/u);
  assert.doesNotMatch(markup, /Internal Logic/u);
});

test('the stack holds at most three blocks and the overflow moves to Internal Logic', () => {
  let store = buildDefaultStore('session-a')
    .apply({ kind: 'begin', sessionId: 'session-a', operationKind: 'message' });
  for (const turn of [1, 2, 3, 4]) {
    store = store.apply({ kind: 'thinking', sessionId: 'session-a', delta: { turn, offset: 0, text: `reasoning ${turn}` } });
  }

  const markup = render({ selectedRuntime: store.get('session-a'), sessionRuntimes: store.getAll() });

  assert.match(markup, /data-depth="2"[^>]*>reasoning 2/u);
  assert.match(markup, /data-depth="0"[^>]*>reasoning 4/u);
  assert.doesNotMatch(markup, /data-depth="3"/u);
  assert.match(markup, /Internal Logic \(1\)/u);
});

test('a settled turn renders no stack', () => {
  const markup = render({
    selectedSession: {
      ...SESSION_A,
      messages: [
        { ...BASE_MESSAGE, id: 'th', kind: 'assistant_thinking', content: 'settled reasoning', sourceRunId: 'run-1' },
        { ...BASE_MESSAGE, id: 'ans', kind: 'assistant_answer', content: 'settled answer', sourceRunId: 'run-1' },
      ],
    },
  });

  assert.doesNotMatch(markup, /class="think-stack"/u);
  assert.match(markup, /Internal Logic \(1\)/u);
});
```

The last test needs a `BASE_MESSAGE` fixture. If `chat-tab.test.tsx` does not already define one, add it beside the other module-level fixtures (near `PRESET`, around `chat-tab.test.tsx:24`):

```ts
const BASE_MESSAGE = {
  id: 'base',
  role: 'assistant',
  kind: 'assistant_answer',
  content: '',
  inputTokensEstimate: 0,
  outputTokensEstimate: 0,
  thinkingTokens: 0,
  associatedToolTokens: 0,
  createdAtUtc: '2026-08-17T00:00:00.000Z',
  sourceRunId: null,
} satisfies ChatMessage;
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js --dashboard chat-tab.test.tsx`

Expected: FAIL. No `class="think-stack"` appears in the markup, and the thinking-only test renders an empty transcript because the turn dispatch returns `null` for a turn whose `main` is `null`.

- [ ] **Step 3: Give `ThinkingBody` a depth**

In `dashboard/src/tabs/ChatTab.tsx`, replace `ThinkingBody` (currently `:570-573`) in full:

```tsx
function ThinkingBody({ message, isLive, depth }: {
  message: ChatMessage;
  isLive: boolean;
  /** Stack position, 0 = newest. `null` outside the live stack (no attribute emitted). */
  depth: number | null;
}) {
  const content = useSmoothedText(message.content, isLive);
  return <div className="think" data-depth={depth ?? undefined}>{content}</div>;
}
```

Update its existing call site in `renderMessageBody` (currently `:607-609`):

```tsx
  if (messageKind === 'assistant_thinking') {
    return <ThinkingBody message={message} isLive={isLive} depth={null} />;
  }
```

- [ ] **Step 4: Add the `ThinkingStack` component**

Insert directly after `ThinkingBody`:

```tsx
function ThinkingStack({ messages, isLive }: { messages: ChatMessage[]; isLive: boolean }) {
  return (
    <div className="think-stack">
      {messages.map((message, index) => {
        // Oldest first in the array, so the newest entry lands at depth 0 (bottom, solid).
        const depth = messages.length - 1 - index;
        return (
          <ThinkingBody
            key={message.id}
            message={message}
            // Only the newest block streams; older ones render settled text at once.
            isLive={isLive && depth === 0}
            depth={depth}
          />
        );
      })}
    </div>
  );
}
```

- [ ] **Step 5: Place the stack inside `ChatTurnBubble`**

In `ChatTurnBubble`, replace the block from the `<details className="internal-logic">` opening through the closing of the main `MessageBubble` (currently `:680-706`):

```tsx
      {turn.steps.length > 0 ? (
        <details className="internal-logic">
          <summary>Internal Logic ({turn.steps.length})</summary>
          <div className="internal-logic-steps">
            {turn.steps.map((step) => (
              <MessageBubble
                key={step.id}
                message={step}
                sessionId={sessionId}
                isLive={turn.isLive}
                isDirectChatMode={isDirectChatMode}
                chatBusy={chatBusy}
                onDeleteMessage={onDeleteMessage}
              />
            ))}
          </div>
        </details>
      ) : null}
      {turn.liveThinking.length > 0 ? (
        <ThinkingStack messages={turn.liveThinking} isLive={turn.isLive} />
      ) : null}
      {turn.main ? (
        <MessageBubble
          message={turn.main}
          sessionId={sessionId}
          isLive={turn.isLive}
          isDirectChatMode={isDirectChatMode}
          chatBusy={chatBusy}
          onDeleteMessage={onDeleteMessage}
          extraClass="turn-main"
        />
      ) : null}
```

The `turn.steps.length > 0` guard is new and required: `ChatTurnBubble` can now be reached with zero steps (a live turn that is only thinking), and an `Internal Logic (0)` disclosure would be noise.

- [ ] **Step 6: Stop discarding stack-only turns in the transcript dispatch**

In the transcript loop, replace the branch condition (currently `:351`):

```tsx
                if (turn.steps.length === 0 && turn.liveThinking.length === 0) {
```

Without this, a live turn holding only thinking has `steps: []` and `main: null`, falls into the simple-bubble branch, and returns `null` — the transcript would go blank while the model reasons before its first tool call.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js --dashboard chat-tab.test.tsx`

Expected: PASS, including the pre-existing tests. `'a running tool message renders a ToolCallCard with spinner'` (`:327-334`) still passes: its turn has one tool call and no thinking, so `main` is the tool call and the stack is empty.

- [ ] **Step 8: Commit**

```bash
git add dashboard/src/tabs/ChatTab.tsx dashboard/tests/chat-tab.test.tsx
git commit -m "feat(chat): render recent live thinking as an age-faded stack above the tool card"
```

---

### Task 3: Style the stack

**Files:**
- Modify: `dashboard/src/styles/chat.css:32-35`

There is no CSS test harness in this repo, so this task is verified visually against the approved mockup at `c:\tmp\rsx\siftkit-thinking-stack.html`.

- [ ] **Step 1: Add the stack rules**

In `dashboard/src/styles/chat.css`, insert immediately after the existing `.think` rule at line 32 and before the `.thinking-box, .system-context-bubble, .internal-logic` rule at line 33:

```css
/* ---- live thinking stack: newest at the bottom, older stepping back ---- */
.think-stack { display: grid; gap: 6px; margin-top: 8px; }
.think-stack .think { margin-top: 0; overflow: hidden; }
.think-stack .think[data-depth="0"] { opacity: 1; border-left-color: #5d7994; }
.think-stack .think[data-depth="1"] {
  opacity: 0.5; border-left-color: #3a4c61;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
.think-stack .think[data-depth="2"] {
  opacity: 0.26; border-left-color: #33424f;
  display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical;
}
```

The clamped entries deliberately keep `display: -webkit-box` rather than the inherited block: `-webkit-line-clamp` only takes effect inside a `-webkit-box`. The dashboard targets Chromium (`dashboard/package.json` ships a Vite build consumed by the desktop shell), so the prefixed properties are the correct mechanism here.

- [ ] **Step 2: Verify the build compiles the stylesheet**

Run: `npm --prefix .\dashboard run build`

Expected: exit 0, no CSS warnings referencing `think-stack`.

- [ ] **Step 3: Verify visually**

Start the dashboard (`npm run start:dashboard`), open a session with `per-step thinking` enabled, and send a prompt that triggers at least three tool calls. Confirm against the mockup:

- three thinking blocks visible at once, newest at the bottom and fully opaque
- the running tool card sits below the stack, spinner clearly visible at full opacity
- older blocks are truncated to 2 and 1 lines and never push the tool card out of view
- the reasoning does **not** disappear when a tool starts
- when the answer streams, the stack empties and the turn looks exactly as it does today

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/styles/chat.css
git commit -m "style(chat): depth-ranked opacity and clamping for the live thinking stack"
```

---

### Task 4: Relax the repo-search opening-search requirement

**Files:**
- Modify: `src/repo-search/prompts.ts:242`, `:250`
- Test: `tests/repo-search-prompts.test.ts:102`, `:107-108`

**Scope note.** `buildAgentSystemPrompt` (`src/repo-search/prompts.ts:280-319`) has **no** opening-search rule to relax — it deliberately omits the search-discipline block, and `tests/repo-search-prompts.test.ts:204-216` asserts that absence by name. So this task touches `buildTaskSystemPrompt` only, and repo-agent is left alone.

**Why line 250 is in scope.** It reads *"Minimum 5 tool-call turns before finish"*, which directly contradicts an opening budget of 1-3 searches — leaving it would make the prompt self-defeating. It is also stale: the hard gate it describes was deleted in commit `3d05fd5c` in favour of evidence-based `evaluateFinishAttempt` (`src/tool-loop-governor.ts:191-215`), which has no turn-count input at all. The replacement sentence below states the rule the runtime actually enforces.

- [ ] **Step 1: Write the failing test**

In `tests/repo-search-prompts.test.ts`, replace the assertions at lines 101-109:

```ts
    // Anchor-before-read
    assert.match(prompt, /1-3 grep keyword searches/u);
    assert.doesNotMatch(prompt, /3 of your first 5/u);
    assert.match(prompt, /5 keywords/u);
    assert.match(prompt, /500 lines/u);

    // Finish gate reflects the runtime rule, not the deleted turn-count gate
    assert.match(prompt, /two evidence-bearing tool calls/u);
    assert.doesNotMatch(prompt, /5 tool-call turns/u);
    assert.doesNotMatch(prompt, /shallow search/u);
    assert.match(prompt, /anchor/u);
```

The `/5 keywords/u` assertion at line 103 is deliberately kept. Line 243 tells the planner to pack five *keywords* into one alternation grep — that is what makes a single opening search sufficient, so it supports the new budget rather than conflicting with it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- --test-name-pattern "preserves load-bearing planner rules"`

Expected: FAIL on `assert.match(prompt, /1-3 grep keyword searches/u)` — the prompt still says `≥3 of your first 5 calls`.

- [ ] **Step 3: Relax the opening-search requirement**

In `src/repo-search/prompts.ts`, replace line 242:

```ts
    '- Open with 1-3 grep keyword searches; no file reads or list calls until you have anchors.',
```

- [ ] **Step 4: Replace the stale finish-gate sentence**

In the same file, replace line 250:

```ts
    '- Finish is rejected when an anchored answer rests on fewer than two evidence-bearing tool calls; add a corroborating search or read rather than finishing thin.',
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test -- --test-name-pattern "preserves load-bearing planner rules"`

Expected: PASS.

- [ ] **Step 6: Run the whole prompt suite**

Run: `npm run test -- repo-search-prompts.test.ts`

Expected: PASS. Pay attention to `'buildTaskSystemPrompt includes anti-loop and larger single-file read guidance'` (`:175-185`) — its `/Anchor-before-read/u` and `/grep.*anchor|anchor.*grep/iu` assertions still hold, because the section heading is untouched and the new line 242 contains both `grep` and `anchors`.

- [ ] **Step 7: Commit**

```bash
git add src/repo-search/prompts.ts tests/repo-search-prompts.test.ts
git commit -m "feat(repo-search): open with 1-3 greps and state the real finish gate"
```

---

### Task 5: Full verification

**Files:** none modified.

- [ ] **Step 1: Run the dashboard suite**

```text
npm run test:dashboard 2>&1 | siftkit summary --question "Return pass/fail, failing test names, root errors, and relevant file:line anchors."
```

Expected: pass, zero failures.

- [ ] **Step 2: Run the node suite**

```text
npm run test 2>&1 | siftkit summary --question "Return pass/fail, failing test names, root errors, and relevant file:line anchors."
```

Expected: pass, zero failures.

- [ ] **Step 3: Typecheck and lint**

```text
npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail, error categories, and file:line anchors for every diagnostic."
```

Expected: pass, zero diagnostics. (`typecheck` already chains `lint` as its final step.)

- [ ] **Step 4: Confirm no scope drift**

Run: `git status --short` and `git diff --stat main`

Expected: exactly these files changed —
`dashboard/src/lib/chatTurns.ts`, `dashboard/src/tabs/ChatTab.tsx`, `dashboard/src/styles/chat.css`, `src/repo-search/prompts.ts`, `dashboard/tests/lib/chatTurns.test.ts`, `dashboard/tests/chat-tab.test.tsx`, `tests/repo-search-prompts.test.ts`, and this plan file. No temp files, no `.test-build` artifacts staged.

---

## Deferred — not in this plan

Recorded so they are not silently lost. Neither is required for the work above.

1. **Dead `MIN_TOOL_CALLS_BEFORE_FINISH` plumbing.** The constant (`src/repo-search/engine/task-loop-support.ts:30`) is read into a field (`src/repo-search/engine/task-loop.ts:130`, `:185`) and threaded through `src/repo-search/execute.ts:399`, but its only consumer is a log payload (`src/repo-search/engine/task-loop.ts:618`) — it is never compared against anything. Task 4 removes the prompt sentence that described it; removing the plumbing itself is a separate cleanup touching four source files and their tests.
2. **`ARCHITECTURE-REVIEW.md:22` and `:28`** document the prompt/runtime contradiction that Task 4 resolves. Those two lines become stale once Task 4 lands and should be refreshed in the same cleanup pass.

## Risks

| Risk | Mitigation |
|---|---|
| A pre-existing test pinned the exact behaviour being changed (`chatTurns.test.ts:110`). | Task 1 Step 8 replaces that single assertion with a stricter one covering both `steps` and `liveThinking`, and explains why this is not weakening a valid test. |
| `ChatTurnBubble` can now render with zero steps, which previously could not happen. | Task 2 Step 5 guards the `Internal Logic` disclosure on `turn.steps.length > 0`. |
| A live turn of pure thinking previously produced `main: null` and rendered nothing. | Task 2 Step 6 changes the dispatch condition; Task 2 Step 1 covers it with a dedicated test. |
| `-webkit-line-clamp` is prefixed and non-standard. | The dashboard is a Chromium-targeted Vite app; Task 3 Step 3 verifies the rendering visually. |
| Relaxing the opening-search budget could make repo-search answers thinner. | The real finish gate is unchanged — `evaluateFinishAttempt` (`src/tool-loop-governor.ts:191-215`) still rejects an anchored answer backed by fewer than two evidence-bearing calls, and Task 4 makes the prompt state that rule accurately. |

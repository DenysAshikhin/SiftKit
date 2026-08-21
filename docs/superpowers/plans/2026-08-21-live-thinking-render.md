# Live Thinking Render Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the live thinking stack in the dashboard chat turn so streamed reasoning is visible while it arrives, instead of appearing only after the answer starts.

**Architecture:** `dashboard/src/lib/chatTurns.ts` already computes `ChatTurn.liveThinking` correctly and is fully unit-tested. No component reads that field, so the messages are dropped at render: `finalizeTurn` excludes them from `steps`, and `ChatTab`'s turn map returns `null` for any turn with no `steps` and no `main`. The fix is render-only — add a `liveThinking` slot to `ChatTurnBubble`, relax `ChatTab`'s early-out so a thinking-only live turn reaches that component, and hide the now-reachable empty `Internal Logic` disclosure.

**Tech Stack:** TypeScript, React 18, `react-dom/server` `renderToStaticMarkup` for assertions, `node:test` via the repo test runner (`npm run build:test` then `npm test`), plain CSS in `dashboard/src/styles/chat.css`.

---

## Background: the confirmed defect

Reproduced on 2026-08-21 against `main` at `cc563ac6`.

During a live turn that has streamed only thinking (no tool call, no answer yet):

1. `pickMainMessage` (`dashboard/src/lib/chatTurns.ts:47-66`) finds no answer, no tool call, and no non-step message, so `main = null`.
2. `pickLiveThinking` (`dashboard/src/lib/chatTurns.ts:68-74`) puts the newest ≤3 thinking blocks in `liveThinking`.
3. `finalizeTurn` (`dashboard/src/lib/chatTurns.ts:84`) sets `steps = messages.filter(m => m !== main && !liveThinking.includes(m))`, which is now empty.
4. `ChatTab.tsx:382-384` takes the `turn.steps.length === 0` branch, finds `turn.main === null`, and returns `null`. **The entire assistant side of the turn is absent from the DOM.**

The moment the first `answer` delta lands, `pickLiveThinking` returns `[]` (`chatTurns.ts:72`), the thinking blocks fall back into `steps`, `main` becomes the answer, and everything renders — which is why the answer appears to stream correctly while thinking appears "frozen".

`ChatTurnBubble` (`dashboard/src/tabs/ChatTab.tsx:755-829`) renders only `turn.steps` and `turn.main`; it has no `liveThinking` slot. So even when a tool call gives the live turn a `main`, the newest ≤3 thinking blocks are still silently dropped.

Scope note: this is **not** image-specific and **not** first-message-specific. An image-only first message is simply the most visible case (long image prompt-eval, empty screen). Verified failing for text-only submits and for live turns with a tool call.

Server side is clean and needs no change: `ChatStreamProgressWriter` flushes thinking deltas within 100 ms (`src/status-server/routes/chat.ts:355-384`, `src/status-server/live-text-delta.ts:41-43`), `llama-cpp-client.ts:494` emits per SSE frame, and `chat-session-runtime-store.ts:104-109` stores every delta.

## File Structure

| File | Change | Responsibility after the change |
| --- | --- | --- |
| `dashboard/src/tabs/ChatTab.tsx` | Modify `ChatTurnBubble` (lines 755-829) and the turn map (lines 381-411) | Renders the live thinking stack; routes thinking-only live turns to `ChatTurnBubble`; hides an empty `Internal Logic` disclosure |
| `dashboard/src/styles/chat.css` | Modify line 35 | Gives the thinking stack the same vertical grid spacing as `.internal-logic-steps` |
| `dashboard/tests/chat-tab.test.tsx` | Add tests | Regression coverage that streamed thinking is in the DOM before the answer arrives, and that thinking survives alongside a tool call |

`dashboard/src/lib/chatTurns.ts` is **not** modified. Its behaviour is already correct and `dashboard/tests/lib/chatTurns.test.ts` already covers it.

## Conventions for the implementing engineer

- Tests run from the repo root. The runner consumes a prebuilt bundle, so **every** test run is `npm run build:test` first, then `npm test -- <path>`. Skipping the build fails with `Error: Test artifacts are stale`.
- `dashboard/tests/chat-tab.test.tsx` already imports everything needed and exposes two helpers you will reuse:
  - `buildProps(overrides)` — full `ChatTabProps` with `chatMode: 'chat'`, `isDirectChatMode: true`, sessions `SESSION_A` / `SESSION_B`.
  - `render(overrides)` — `renderToStaticMarkup(React.createElement(ChatTab, buildProps(overrides)))`, returns an HTML string.
- `SESSION_B` (`chat-tab.test.tsx:48-53`) has `messages: []` and id `'session-b'` — that is the fresh-session fixture.
- A `PendingImage` is `{ dataUrl: ImageDataUrl; note: string | null }` (`dashboard/src/lib/downscale-image.ts:9`). In tests write it as an inline literal: `{ dataUrl: 'data:image/png;base64,AA', note: null }`.
- Repo rules: no `any`, no type assertions, no non-null assertions. None are needed here.
- Do not commit unless the plan step says to.

---

### Task 1: Make streamed thinking visible before the answer arrives

**Files:**
- Test: `dashboard/tests/chat-tab.test.tsx` (append at end of file)
- Modify: `dashboard/src/tabs/ChatTab.tsx:381-384` (turn map early-out)
- Modify: `dashboard/src/tabs/ChatTab.tsx:796-826` (`ChatTurnBubble` body)

- [ ] **Step 1: Write the failing test**

First extend the existing type-only import block at the top of `dashboard/tests/chat-tab.test.tsx` so the fixture helper can be typed without a cast. Add this line directly below the existing `import type { ChatMessage, ChatSession, ContextUsage, DashboardPreset } from '../src/types';`:

```tsx
import type { PendingImage } from '../src/lib/downscale-image';
```

`PendingImage['dataUrl']` is the branded `ImageDataUrl`, not `string`, so the helper parameter must be `PendingImage[]`. Typing it that way lets the call-site object literals be contextually typed and keeps the file free of assertions.

Then append to the end of `dashboard/tests/chat-tab.test.tsx`:

```tsx
function buildThinkingOnlyStore(content: string, images: PendingImage[]): ChatSessionRuntimeStore {
  return new ChatSessionRuntimeStore()
    .ensureSession(SESSION_B.id)
    .apply({ kind: 'submit', sessionId: SESSION_B.id, content, images })
    .apply({ kind: 'begin', sessionId: SESSION_B.id, operationKind: 'message' })
    .apply({ kind: 'thinking', sessionId: SESSION_B.id, delta: { turn: 1, offset: 0, text: 'THINK_MARKER_ONE' } });
}

test('a live turn that has only streamed thinking renders the thinking text', () => {
  const store = buildThinkingOnlyStore('', [{ dataUrl: 'data:image/png;base64,AA', note: null }]);
  const html = render({
    selectedSessionId: SESSION_B.id,
    selectedRuntime: store.get(SESSION_B.id),
    sessionRuntimes: store.getAll(),
  });
  assert.ok(html.includes('THINK_MARKER_ONE'), 'streamed thinking must be in the DOM before the answer arrives');
});

test('a live turn that has only streamed thinking renders no empty Internal Logic disclosure', () => {
  const store = buildThinkingOnlyStore('hello', []);
  const html = render({
    selectedSessionId: SESSION_B.id,
    selectedRuntime: store.get(SESSION_B.id),
    sessionRuntimes: store.getAll(),
  });
  assert.ok(html.includes('THINK_MARKER_ONE'), 'streamed thinking must be in the DOM for a text-only submit too');
  assert.ok(!html.includes('Internal Logic (0)'), 'an empty Internal Logic disclosure must not render');
});

test('once the answer streams, the answer and the thinking both render', () => {
  const store = buildThinkingOnlyStore('hello', [])
    .apply({ kind: 'answer', sessionId: SESSION_B.id, delta: { turn: 1, offset: 0, text: 'ANSWER_MARKER' } });
  const html = render({
    selectedSessionId: SESSION_B.id,
    selectedRuntime: store.get(SESSION_B.id),
    sessionRuntimes: store.getAll(),
  });
  assert.ok(html.includes('ANSWER_MARKER'), 'the streamed answer must render');
  assert.ok(html.includes('THINK_MARKER_ONE'), 'the thinking must remain visible once the answer arrives');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run build:test
npm test -- dashboard/tests/chat-tab.test.tsx
```

Expected: the first two new tests FAIL with `AssertionError [ERR_ASSERTION]: streamed thinking must be in the DOM before the answer arrives`. The third new test (`once the answer streams…`) PASSES already — it is the control that proves the store and the stream transitions are fine and only the thinking-only phase is broken. Every pre-existing test in the file still passes.

- [ ] **Step 3: Route thinking-only live turns to `ChatTurnBubble`**

In `dashboard/src/tabs/ChatTab.tsx`, inside the `groupMessagesIntoTurns(...).map(...)` callback, replace:

```tsx
                if (turn.steps.length === 0) {
```

with:

```tsx
                if (turn.steps.length === 0 && turn.liveThinking.length === 0) {
```

This is the only change in the turn map. The live user bubble and settled single-message turns keep the `MessageBubble` fast path, because `pickLiveThinking` returns `[]` for both (`chatTurns.ts:70` for settled turns, and a user-keyed turn holds no thinking messages).

- [ ] **Step 4: Render the live thinking stack in `ChatTurnBubble`**

In `dashboard/src/tabs/ChatTab.tsx`, in the `return` of `ChatTurnBubble`, replace the block that currently starts with `<details className="internal-logic">` and ends with the `{turn.main ? (...) : null}` expression with:

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
                isPending={false}
                isDirectChatMode={isDirectChatMode}
                chatBusy={chatBusy}
                onDeleteMessage={onDeleteMessage}
                onDeleteMessageImage={onDeleteMessageImage}
              />
            ))}
          </div>
        </details>
      ) : null}
      {turn.liveThinking.length > 0 ? (
        <div className="live-thinking-stack">
          {turn.liveThinking.map((thinking) => (
            <MessageBubble
              key={thinking.id}
              message={thinking}
              sessionId={sessionId}
              isLive={turn.isLive}
              isPending={false}
              isDirectChatMode={isDirectChatMode}
              chatBusy={chatBusy}
              onDeleteMessage={onDeleteMessage}
              onDeleteMessageImage={onDeleteMessageImage}
            />
          ))}
        </div>
      ) : null}
      {turn.main ? (
        <MessageBubble
          message={turn.main}
          sessionId={sessionId}
          isLive={turn.isLive}
          isPending={false}
          isDirectChatMode={isDirectChatMode}
          chatBusy={chatBusy}
          onDeleteMessage={onDeleteMessage}
          onDeleteMessageImage={onDeleteMessageImage}
          extraClass="turn-main"
        />
      ) : null}
```

Three things changed and nothing else:
- the `internal-logic` `<details>` is now guarded by `turn.steps.length > 0` (it became reachable with zero steps in Step 3, and `Internal Logic (0)` is noise);
- a `live-thinking-stack` block renders `turn.liveThinking` between Internal Logic and the main slot, matching the ordering the `chatTurns.ts:50-58` comments describe (settled reasoning collapsed below the fold, newest reasoning above the answer/tool-call slot);
- the `{turn.main ? ... : null}` block is unchanged and repeated verbatim above only so the whole replaced region is shown.

`MessageBubble` already dispatches `assistant_thinking` to `ThinkingBody` (`ChatTab.tsx:720-722`), which applies `useSmoothedText(message.content, isLive)`, so the stack streams smoothly with no further wiring. `MessageHeader` hides the delete button while `isLive` is true (`ChatTab.tsx:647-658`), so live thinking blocks correctly get no delete affordance.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm run build:test
npm test -- dashboard/tests/chat-tab.test.tsx
```

Expected: PASS, all tests in the file, including the three added in Step 1.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/tabs/ChatTab.tsx dashboard/tests/chat-tab.test.tsx
git commit -m "fix(dashboard): render the live thinking stack during a thinking-only turn"
```

---

### Task 2: Keep thinking visible when a tool call owns the main slot

**Files:**
- Test: `dashboard/tests/chat-tab.test.tsx` (append at end of file)

No source change is expected in this task — Task 1 already fixes the behaviour. This task exists to pin the second half of the defect (thinking blocks dropped from a live turn that has a tool call) with its own regression test, so a future change to `pickLiveThinking` or the turn map cannot silently reintroduce it.

- [ ] **Step 1: Write the test**

Append to the end of `dashboard/tests/chat-tab.test.tsx`:

```tsx
test('a live turn with a running tool call still renders the thinking that led to it', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession(SESSION_B.id)
    .apply({ kind: 'submit', sessionId: SESSION_B.id, content: 'find it', images: [] })
    .apply({ kind: 'begin', sessionId: SESSION_B.id, operationKind: 'repo-search' })
    .apply({ kind: 'thinking', sessionId: SESSION_B.id, delta: { turn: 1, offset: 0, text: 'THINK_MARKER_TOOL' } })
    .apply({
      kind: 'tool',
      sessionId: SESSION_B.id,
      toolEvent: { kind: 'tool_start', toolCallId: 't1', turn: 1, maxTurns: 4, command: 'TOOL_MARKER' },
    });
  const html = render({
    selectedSessionId: SESSION_B.id,
    selectedRuntime: store.get(SESSION_B.id),
    sessionRuntimes: store.getAll(),
  });
  assert.ok(html.includes('TOOL_MARKER'), 'the running tool call must render in the main slot');
  assert.ok(html.includes('THINK_MARKER_TOOL'), 'the thinking that led to the tool call must render');
});
```

- [ ] **Step 2: Run the test to verify it passes**

```bash
npm run build:test
npm test -- dashboard/tests/chat-tab.test.tsx
```

Expected: PASS. If it fails on `THINK_MARKER_TOOL`, Task 1 Step 4 was applied incompletely — re-check that the `live-thinking-stack` block is inside `ChatTurnBubble`'s returned `<article>` and not accidentally nested inside the `internal-logic` `<details>`.

- [ ] **Step 3: Commit**

```bash
git add dashboard/tests/chat-tab.test.tsx
git commit -m "test(dashboard): pin live thinking visibility alongside a running tool call"
```

---

### Task 3: Space the thinking stack

**Files:**
- Modify: `dashboard/src/styles/chat.css:35`

- [ ] **Step 1: Add the stack to the existing grid rule**

In `dashboard/src/styles/chat.css`, replace line 35:

```css
.internal-logic-steps { display: grid; gap: 8px; margin-top: 8px; }
```

with:

```css
.internal-logic-steps, .live-thinking-stack { display: grid; gap: 8px; margin-top: 8px; }
```

No new rule is introduced. The thinking body itself is already styled by `.think` (`chat.css:32`), which `ThinkingBody` emits; the stack only needs the same vertical rhythm the Internal Logic steps get. Stacked thinking blocks only occur when `maintainPerStepThinking` produces more than one `live-thinking-<turn>` message, which is the repo/plan multi-turn case.

- [ ] **Step 2: Verify the stylesheet still compiles and the tests still pass**

```bash
npm --prefix dashboard run build
npm run build:test
npm test -- dashboard/tests/chat-tab.test.tsx
```

Expected: the dashboard build succeeds with no CSS error, and all tests in the file PASS. `renderToStaticMarkup` does not evaluate CSS, so this step is a build check, not a behavioural one.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/styles/chat.css
git commit -m "style(dashboard): give the live thinking stack the internal-logic grid spacing"
```

---

### Task 4: Full verification

**Files:** none modified.

- [ ] **Step 1: Run the turn-grouping unit tests**

```bash
npm test -- dashboard/tests/lib/chatTurns.test.ts
```

Expected: PASS, unchanged. `chatTurns.ts` was not modified, so any failure here means an accidental edit — revert it.

- [ ] **Step 2: Run the whole dashboard suite**

```bash
npm run test:dashboard 2>&1 | siftkit summary --question "Return pass/fail, failing test names, root errors, and relevant file:line anchors."
```

Expected: pass, zero failures. The likeliest regression is a pre-existing test asserting on `Internal Logic` markup for a turn whose `steps` are now empty; as of `cc563ac6` no such test exists in `dashboard/tests`, but re-check if the summary reports one.

- [ ] **Step 3: Run the full suite**

```bash
npm test 2>&1 | siftkit summary --question "Return pass/fail, failing tests, root errors, and relevant file:line anchors."
```

Expected: pass. No server or engine file is touched by this plan, so any failure outside `dashboard/` is pre-existing — confirm against `git stash` before treating it as caused by this work.

- [ ] **Step 4: Typecheck and lint**

```bash
npm run typecheck
npm run lint
```

Expected: both exit 0. `npm run typecheck` already chains `typecheck:dashboard-test` and `lint`, so a clean `typecheck` covers the new test file's types.

- [ ] **Step 5: Manual confirmation in the running webui**

Start the dev stack, open a **new** chat session in `chat` mode with `per-step thinking` enabled, attach one image, send with an empty text box, and watch the turn.

Expected: an assistant turn labelled `SiftKit · live` appears as soon as the first thinking delta lands and its italic thinking text grows continuously; when the answer begins it takes the main slot and the thinking collapses into `Internal Logic (1)`. Before this fix the turn was absent from the DOM for the entire thinking phase.

- [ ] **Step 6: Confirm the tree is clean**

```bash
git status --porcelain
```

Expected: empty. Three commits exist on the branch (Tasks 1-3), no stray scratch files.

---

## Out of scope

- `dashboard/src/lib/chatTurns.ts` — already correct, already covered.
- The server SSE path, `LiveTextDeltaTracker`, and `llama-cpp-client` streaming — verified working; changing flush latency would mask, not fix, this defect.
- `useChatSessions.ts:341`, where `thinkingEnabled` is read from `selectedSession` rather than the runtime for the `sessionId` being streamed. This is a real latent bug for concurrent sessions (streaming session A while session B is selected reads B's toggle) but is unrelated to this symptom and is worth its own plan.
- `buildLiveMessageScrollSignature` / auto-scroll behaviour during the thinking phase. Once thinking renders, the log may need to scroll for it; confirm during Task 4 Step 5 and file separately if the view does not follow.

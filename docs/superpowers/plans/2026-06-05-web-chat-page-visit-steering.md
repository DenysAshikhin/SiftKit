# Web-Chat Page-Visit Steering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a `web_search` in the web-on direct chat loop, intercept the model's attempt to answer from snippets and steer it (up to 3 times) to either `web_fetch` a result page or run a different `web_search`; the steering prompt is transient and never pollutes chat history.

**Architecture:** A turn-local governor inside [`streamDirectChatWebTurn`](../../../src/status-server/chat.ts). When the model emits `{"action":"answer"}` after ≥1 search with no successful fetch, the governor blocks the answer, appends a nudge to a *local copy* of `evidenceMessages` for the next decision turn only, and re-decides. A successful `web_fetch` permanently satisfies the gate for the turn; the budget is 3 blocked answers, then the answer is allowed. The persistent `evidenceMessages` array is never mutated, so the nudge auto-vanishes once the model responds.

**Tech Stack:** TypeScript (ESM, `.ts` imports via tsx), `node --test` test runner.

---

## File Structure

- Modify: `src/status-server/chat.ts`
  - Add exported const `WEB_CHAT_STEER_PROMPT` (near the other web prompts, line ~50).
  - Add const `WEB_CHAT_MAX_STEER_ATTEMPTS = 3` (near `WEB_CHAT_MAX_TOOL_CALLS`, line 52).
  - Add governor state + gate logic inside `streamDirectChatWebTurn` (lines 778–842).
- Modify (tests): `tests/status-server-chat.test.ts`
  - Add 4 behavior tests + 1 prompt-content test for the new governor.

No other files change. No public API changes beyond the new exported const.

---

## Task 1: Add the steering prompt const and its content test

**Files:**
- Modify: `src/status-server/chat.ts:46-52`
- Test: `tests/status-server-chat.test.ts` (add after the `WEB_CHAT_ANSWER_PROMPT` test, line ~194)

- [ ] **Step 1: Write the failing test**

Add to `tests/status-server-chat.test.ts`. First add `WEB_CHAT_STEER_PROMPT` to the import block from `'../src/status-server/chat.ts'` (the block at lines 17-20 already imports `WEB_CHAT_ANSWER_PROMPT`, `WEB_CHAT_DECISION_PROMPT`):

```ts
import {
  streamDirectChatWebTurn,
  WEB_CHAT_ANSWER_PROMPT,
  WEB_CHAT_DECISION_PROMPT,
  WEB_CHAT_STEER_PROMPT,
} from '../src/status-server/chat.ts';
```

Then add this test after the `WEB_CHAT_ANSWER_PROMPT instructs prose answer...` test:

```ts
test('WEB_CHAT_STEER_PROMPT steers toward fetching a page or re-searching', () => {
  assert.match(WEB_CHAT_STEER_PROMPT, /web_fetch/);
  assert.match(WEB_CHAT_STEER_PROMPT, /web_search/);
  assert.match(WEB_CHAT_STEER_PROMPT, /snippet/i);
  assert.match(WEB_CHAT_STEER_PROMPT, /Only answer once you have read a page\./);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --test-name-pattern "WEB_CHAT_STEER_PROMPT steers" .\tests\status-server-chat.test.ts`
Expected: FAIL — `WEB_CHAT_STEER_PROMPT` is `undefined` / not exported.

- [ ] **Step 3: Add the const**

In `src/status-server/chat.ts`, immediately after the `WEB_CHAT_ANSWER_PROMPT` definition (which ends at line 50) and before `const WEB_CHAT_MAX_TOOL_CALLS = 4;`, insert:

```ts
// Steering nudge (web-on) injected transiently when the model tries to answer
// after searching without opening any result. Delivered only on the re-decision
// turn via a local evidence copy and never persisted, so it cannot pollute chat
// history.
export const WEB_CHAT_STEER_PROMPT = [
  'You ran a web_search but have not opened any result page yet.',
  'Do NOT answer from search-result snippets alone.',
  'Either read an actual page with {"action":"web_fetch","url":"<one of the returned result URLs>"},',
  'or run a different {"action":"web_search","query":"..."} if the results were poor.',
  'Only answer once you have read a page.',
].join('\n');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test --test-name-pattern "WEB_CHAT_STEER_PROMPT steers" .\tests\status-server-chat.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/status-server/chat.ts tests/status-server-chat.test.ts
git commit -m "feat(chat): add WEB_CHAT_STEER_PROMPT for page-visit steering"
```

---

## Task 2: Add the budget constant

**Files:**
- Modify: `src/status-server/chat.ts:52`

- [ ] **Step 1: Add the constant**

In `src/status-server/chat.ts`, directly after `const WEB_CHAT_MAX_TOOL_CALLS = 4;` (line 52), insert:

```ts
const WEB_CHAT_MAX_STEER_ATTEMPTS = 3;
```

(No standalone test — this constant is exercised by the governor tests in Task 4. It is committed together with Task 3.)

---

## Task 3: Implement the governor in `streamDirectChatWebTurn`

**Files:**
- Modify: `src/status-server/chat.ts:778-842`

This task wires the gate. The tests that prove it live in Task 4 — but to follow TDD, write Task 4's Test A first, watch it fail, then do this task. The steps below are ordered for that flow.

- [ ] **Step 1: Write Task 4 Test A (the failing test)**

Add the "steer to fetch" test from Task 4 Step 1 now and run it (Task 4 Step 2) to confirm it FAILS against the current loop (the current loop answers immediately after the blocked `answer`, so it consumes the wrong mock and asserts wrong tool-turn count). Then return here.

- [ ] **Step 2: Add governor state**

In `streamDirectChatWebTurn`, after `let toolCalls = 0;` (line 781) add:

```ts
  let searchCount = 0;
  let fetchSucceeded = false;
  let blockedAnswers = 0;
  let steerMessage: string | null = null;
```

- [ ] **Step 3: Deliver the transient nudge on the decision turn**

Replace the live decision-turn call's evidence argument. Current code (lines 797-806):

```ts
    } else {
      const decision = await streamChatAssistantMessage(config, session, userContent, (progress) => {
        if (exposeThinking) {
          onProgress({ kind: 'thinking', phase: 'decision', thinking: progress.thinkingContent });
        }
      }, {
        promptPrefix: options.promptPrefix,
        webActionInstruction: WEB_CHAT_DECISION_PROMPT,
        evidenceMessages: evidenceMessages.slice(),
      });
```

Replace with:

```ts
    } else {
      const decisionEvidence = steerMessage
        ? [...evidenceMessages, { role: 'user' as const, content: steerMessage }]
        : evidenceMessages.slice();
      const decision = await streamChatAssistantMessage(config, session, userContent, (progress) => {
        if (exposeThinking) {
          onProgress({ kind: 'thinking', phase: 'decision', thinking: progress.thinkingContent });
        }
      }, {
        promptPrefix: options.promptPrefix,
        webActionInstruction: WEB_CHAT_DECISION_PROMPT,
        evidenceMessages: decisionEvidence,
      });
```

- [ ] **Step 4: Track searches/fetches and clear the nudge on compliance**

Inside the tool branch, after `const command = buildWebToolCommand(decision);` (line 816), insert:

```ts
      if (decision.kind === 'web_search') {
        searchCount += 1;
      }
      steerMessage = null;
```

Then, in the success path of the `try` block, after the `evidenceMessages.push(...)` pair for success (currently lines 825-826), insert the fetch-satisfies flag:

```ts
        if (decision.kind === 'web_fetch') {
          fetchSucceeded = true;
        }
```

So the success branch becomes:

```ts
      try {
        const toolResult = decision.kind === 'web_search'
          ? await webTools.search(decision.args)
          : await webTools.fetch(decision.args);
        bubble = buildWebToolBubble(toolResult.command, toolResult.output, toolResult.outputTokens, turnIndex, maxTurns, 0);
        onProgress({ kind: 'tool_result', toolCallId, turn: turnIndex, maxTurns, command: toolResult.command, outputSnippet: bubble.toolCallOutputSnippet, outputTokens: toolResult.outputTokens, exitCode: 0 });
        evidenceMessages.push({ role: 'assistant', content: decisionText });
        evidenceMessages.push({ role: 'user', content: `Tool ${toolResult.command} output:\n${toolResult.output}` });
        if (decision.kind === 'web_fetch') {
          fetchSucceeded = true;
        }
      } catch (error) {
```

(`searchCount` is incremented before the `try`, so a search that throws still counts; `fetchSucceeded` is set only on the success path.)

- [ ] **Step 5: Add the gate before the answer turn**

The tool branch ends with `continue;` and `}` at line 838. Immediately after that closing `}` (i.e., before the existing line 840 `if (exposeThinking && decisionThinking.trim()) {`), insert the gate:

```ts
    const gateApplies = decision.kind === 'answer'
      && searchCount > 0
      && !fetchSucceeded
      && blockedAnswers < WEB_CHAT_MAX_STEER_ATTEMPTS
      && toolCalls < maxTurns;
    if (gateApplies) {
      blockedAnswers += 1;
      steerMessage = WEB_CHAT_STEER_PROMPT;
      continue;
    }
    steerMessage = null;
```

- [ ] **Step 6: Run Task 4 Test A to verify it passes**

Run: `npx tsx --test --test-name-pattern "steers a snippet answer into a web_fetch" .\tests\status-server-chat.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/status-server/chat.ts tests/status-server-chat.test.ts
git commit -m "feat(chat): steer web turn toward page visit after search"
```

---

## Task 4: Governor behavior tests

**Files:**
- Test: `tests/status-server-chat.test.ts` (add after the existing `streamDirectChatWebTurn answers directly when no web tool is needed` test, line ~226)

Test A is written during Task 3 Step 1. Add Tests B–D here. After each, run and confirm PASS.

- [ ] **Step 1: Test A — steer to fetch (written in Task 3 Step 1)**

```ts
test('streamDirectChatWebTurn steers a snippet answer into a web_fetch', async () => {
  const events: WebStreamProgress[] = [];
  const result = await streamDirectChatWebTurn(createConfig(), createSession(), 'osrs iron bar price', searxngWebTools(), (event) => events.push(event), {
    mockResponses: [
      '{"action":"web_search","query":"osrs iron bar"}',
      '{"action":"answer"}',
      '{"action":"web_fetch","url":"https://example.com/iron"}',
      '{"action":"answer"}',
      'Iron bars trade around 150gp.',
    ],
  });

  assert.equal(result.assistantContent, 'Iron bars trade around 150gp.');
  const toolTurns = result.turns.filter((turn) => turn.toolMessages.length > 0);
  assert.equal(toolTurns.length, 2);
  assert.equal(toolTurns[0].toolMessages[0].toolCallCommand, 'web_search query="osrs iron bar"');
  assert.equal(toolTurns[1].toolMessages[0].toolCallCommand, 'web_fetch url="https://example.com/iron"');
  // The steering nudge must never appear in any persisted turn.
  assert.ok(!result.turns.some((turn) => turn.toolMessages.some((message) => message.toolCallOutput.includes('have not opened any result page'))));
});
```

- [ ] **Step 2: Run Test A to verify it fails (before Task 3 impl), then passes (after)**

Run: `npx tsx --test --test-name-pattern "steers a snippet answer into a web_fetch" .\tests\status-server-chat.test.ts`
Before Task 3: FAIL (loop answers after the first `answer`, so it returns `{"action":"web_fetch"...}` text as the prose answer / wrong tool-turn count and runs out of mocks differently). After Task 3: PASS.

- [ ] **Step 3: Test B — budget exhaustion (3 blocks then allow)**

```ts
test('streamDirectChatWebTurn allows the answer after 3 blocked snippet answers', async () => {
  const result = await streamDirectChatWebTurn(createConfig(), createSession(), 'osrs iron bar price', searxngWebTools(), () => {}, {
    mockResponses: [
      '{"action":"web_search","query":"osrs iron bar"}',
      '{"action":"answer"}',
      '{"action":"answer"}',
      '{"action":"answer"}',
      '{"action":"answer"}',
      'Iron bars trade around 150gp.',
    ],
  });

  assert.equal(result.assistantContent, 'Iron bars trade around 150gp.');
  const toolTurns = result.turns.filter((turn) => turn.toolMessages.length > 0);
  assert.equal(toolTurns.length, 1);
});
```

Run: `npx tsx --test --test-name-pattern "allows the answer after 3 blocked" .\tests\status-server-chat.test.ts`
Expected: PASS. (4 `answer` decisions: 3 blocked, the 4th allowed → consumes the 5th mock as prose. If the budget were wrong, the loop would run out of mocks and throw.)

- [ ] **Step 4: Test C — static answer not gated**

```ts
test('streamDirectChatWebTurn does not steer when no search has run', async () => {
  const result = await streamDirectChatWebTurn(createConfig(), createSession(), 'what is 2+2', searxngWebTools(), () => {}, {
    mockResponses: ['{"action":"answer"}', 'Four.'],
  });

  assert.equal(result.assistantContent, 'Four.');
  assert.equal(result.turns.filter((turn) => turn.toolMessages.length > 0).length, 0);
});
```

Run: `npx tsx --test --test-name-pattern "does not steer when no search" .\tests\status-server-chat.test.ts`
Expected: PASS. (The gate requires `searchCount > 0`; with no search it answers immediately and only consumes 2 mocks.)

- [ ] **Step 5: Test D — fetch satisfies the gate**

```ts
test('streamDirectChatWebTurn stops steering after a successful fetch', async () => {
  const result = await streamDirectChatWebTurn(createConfig(), createSession(), 'osrs iron bar price', searxngWebTools(), () => {}, {
    mockResponses: [
      '{"action":"web_search","query":"osrs iron bar"}',
      '{"action":"web_fetch","url":"https://example.com/iron"}',
      '{"action":"answer"}',
      'Iron bars trade around 150gp.',
    ],
  });

  assert.equal(result.assistantContent, 'Iron bars trade around 150gp.');
  const toolTurns = result.turns.filter((turn) => turn.toolMessages.length > 0);
  assert.equal(toolTurns.length, 2);
});
```

Run: `npx tsx --test --test-name-pattern "stops steering after a successful fetch" .\tests\status-server-chat.test.ts`
Expected: PASS. (After the fetch sets `fetchSucceeded`, the `answer` is allowed with no block; if the gate still fired it would block and run out of mocks.)

- [ ] **Step 6: Commit**

```bash
git add tests/status-server-chat.test.ts
git commit -m "test(chat): cover web-turn page-visit steering governor"
```

---

## Task 5: Full regression run

**Files:** none (verification only)

- [ ] **Step 1: Run the full chat test file**

Run: `npx tsx --test .\tests\status-server-chat.test.ts`
Expected: all tests PASS, including the 4 pre-existing `streamDirectChatWebTurn` tests (the gate must not change their behavior — they either do no search, or do one search then answer; Test at line 196 does `search → answer` with no prior search-then-answer-block because... see note).

> **Note on the existing line-196 test** (`streams a web_search tool then a prose answer`): it uses mocks `[web_search, answer, prose]`. After the search, `searchCount = 1`, so the `answer` WILL now be gated (one block), and the loop will re-decide — consuming the `prose` mock as a decision, which parses as `answer` (non-JSON → `answer` via `parseWebChatDecision`), blocking again, then running out of mocks. **This test must be updated** as part of Task 4 Step 6: change its mocks to `['{"action":"web_search","query":"osrs iron bar"}', '{"action":"web_fetch","url":"https://example.com"}', '{"action":"answer"}', 'Iron bars are refined iron, made by smelting iron ore.']` and update its assertions to expect 2 tool turns (search + fetch), keeping the existing search-command and answer-content assertions. Add this edit to Task 4 before committing.

- [ ] **Step 2: Run the broader build+test suite**

Run: `npm test`
Expected: build succeeds and the suite passes. If unrelated pre-existing failures appear, note them but do not fix in this plan.

- [ ] **Step 3: Final commit (if the line-196 test edit was not already committed)**

```bash
git add tests/status-server-chat.test.ts
git commit -m "test(chat): update existing web-search test for steering gate"
```

---

## Self-Review Notes

- **Spec coverage:** Trigger (intercept answer) → Task 3 Step 5 gate; fetch-satisfies → Task 3 Step 4 `fetchSucceeded`; 3-block budget → Task 2 const + gate; transient nudge non-pollution → Task 3 Step 3 local copy + Test A assertion; nudge text → Task 1.
- **Type consistency:** `searchCount`/`fetchSucceeded`/`blockedAnswers`/`steerMessage` declared once (Task 3 Step 2) and referenced consistently; `WEB_CHAT_MAX_STEER_ATTEMPTS` (Task 2) used in the gate (Task 3 Step 5); `WEB_CHAT_STEER_PROMPT` exported (Task 1) and asserted in tests.
- **Existing-test interaction:** the line-196 test changes behavior under the gate — explicitly handled in Task 5 Note / Task 4. This is the one non-obvious regression; it is called out rather than left to discovery.
- **No placeholders:** every code/test step shows complete code and an exact run command with expected result.

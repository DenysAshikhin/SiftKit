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
  - Add 1 prompt-content test, 6 mock-mode behavior tests (steer-to-fetch, budget-exhaustion, static-not-gated, fetch-satisfies, fetch-failure-keeps-steering, maxTurns-bypass), and 1 HTTP-captured injection/non-pollution test. Update the existing `streams a web_search tool then a prose answer` test for the new gate behavior.

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

- [ ] **Step 7: Update the existing line-196 test for the new gate behavior**

The governor changes the behavior of the pre-existing test `streamDirectChatWebTurn streams a web_search tool then a prose answer` (tests/status-server-chat.test.ts:196). Its mocks are `[web_search, answer, prose]`; under the gate the `answer` after a search is now blocked, so it must walk through a fetch. Replace the whole test body (lines 196-215) with:

```ts
test('streamDirectChatWebTurn streams a web_search tool then a prose answer', async () => {
  const events: WebStreamProgress[] = [];
  const result = await streamDirectChatWebTurn(createConfig(), createSession(), 'find latest', searxngWebTools(), (event) => events.push(event), {
    mockResponses: [
      '{"action":"web_search","query":"osrs iron bar"}',
      '{"action":"web_fetch","url":"https://example.com"}',
      '{"action":"answer"}',
      'Iron bars are refined iron, made by smelting iron ore.',
    ],
  });

  assert.equal(result.assistantContent, 'Iron bars are refined iron, made by smelting iron ore.');
  const toolTurns = result.turns.filter((turn) => turn.toolMessages.length > 0);
  assert.equal(toolTurns.length, 2);
  assert.equal(toolTurns[0].toolMessages[0].toolCallCommand, 'web_search query="osrs iron bar"');
  assert.equal(toolTurns[1].toolMessages[0].toolCallCommand, 'web_fetch url="https://example.com"');
  assert.equal(toolTurns[0].toolMessages[0].toolCallExitCode, 0);
  assert.match(toolTurns[0].toolMessages[0].toolCallOutput, /example\.com/);
  assert.ok(events.some((event) => event.kind === 'tool_start' && event.command === 'web_search query="osrs iron bar"'));
  assert.ok(events.some((event) => event.kind === 'tool_result' && event.exitCode === 0));
  assert.ok(events.some((event) => event.kind === 'answer' && event.answer.includes('refined iron')));
});
```

Run: `npx tsx --test --test-name-pattern "streams a web_search tool then a prose answer" .\tests\status-server-chat.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/status-server/chat.ts tests/status-server-chat.test.ts
git commit -m "feat(chat): steer web turn toward page visit after search"
```

---

## Task 4: Governor behavior tests

**Files:**
- Test: `tests/status-server-chat.test.ts` (add after the existing `streamDirectChatWebTurn answers directly when no web tool is needed` test, line ~226)

Test A is written during Task 3 Step 1. Add Tests B–F here. After each, run and confirm PASS.

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

- [ ] **Step 6: Test E — a failed web_fetch does NOT satisfy the gate**

This proves the `fetchSucceeded`-only-on-success branch: a `web_fetch` that throws (HTTP non-ok) keeps the gate active. `WebFetchService.fetch` throws on non-ok status, landing the call in the loop's catch branch. Use a tools instance whose handler returns search results for the searxng base URL but a 500 for any fetch target:

```ts
test('streamDirectChatWebTurn keeps steering when a web_fetch fails', async () => {
  const webTools = new WebResearchTools(WEB_CONFIG, async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('search.example.test')) {
      return new Response(JSON.stringify({ results: [{ title: 'Example', url: 'https://example.com', content: 'snippet' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('upstream error', { status: 500 });
  });
  const result = await streamDirectChatWebTurn(createConfig(), createSession(), 'osrs iron bar price', webTools, () => {}, {
    mockResponses: [
      '{"action":"web_search","query":"osrs iron bar"}',
      '{"action":"answer"}',
      '{"action":"web_fetch","url":"https://example.com/iron"}',
      '{"action":"answer"}',
      '{"action":"answer"}',
      '{"action":"answer"}',
      'Iron bars trade around 150gp.',
    ],
  });

  assert.equal(result.assistantContent, 'Iron bars trade around 150gp.');
  const toolTurns = result.turns.filter((turn) => turn.toolMessages.length > 0);
  assert.equal(toolTurns.length, 2);
  assert.equal(toolTurns[1].toolMessages[0].toolCallExitCode, 1);
});
```

Trace: search → answer(block1) → fetch FAILS (exitCode 1, `fetchSucceeded` stays false) → answer(block2) → answer(block3) → answer(allowed, budget spent) → prose. 6 decisions + prose = 7 mocks; if a failed fetch had wrongly satisfied the gate, the second `answer` would be allowed and the loop would run out of mocks early / return the wrong content.

Run: `npx tsx --test --test-name-pattern "keeps steering when a web_fetch fails" .\tests\status-server-chat.test.ts`
Expected: PASS.

- [ ] **Step 7: Test F — `toolCalls >= maxTurns` bypasses steering**

This proves the `toolCalls < maxTurns` clause of the gate: once the tool budget is spent, an `answer` after a search is allowed without steering. Drive it with `maxTurns: 1`:

```ts
test('streamDirectChatWebTurn does not steer once maxTurns is reached', async () => {
  const result = await streamDirectChatWebTurn(createConfig(), createSession(), 'osrs iron bar price', searxngWebTools(), () => {}, {
    maxTurns: 1,
    mockResponses: [
      '{"action":"web_search","query":"osrs iron bar"}',
      '{"action":"answer"}',
      'Iron bars trade around 150gp.',
    ],
  });

  assert.equal(result.assistantContent, 'Iron bars trade around 150gp.');
  assert.equal(result.turns.filter((turn) => turn.toolMessages.length > 0).length, 1);
});
```

Trace: search (toolCalls→1, the cap) → answer → gate sees `toolCalls (1) < maxTurns (1)` is false → not gated → answer turn → prose. 3 mocks consumed; if the gate had fired, it would block and run out of mocks.

Run: `npx tsx --test --test-name-pattern "does not steer once maxTurns is reached" .\tests\status-server-chat.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add tests/status-server-chat.test.ts
git commit -m "test(chat): cover web-turn page-visit steering governor"
```

---

## Task 5: Transient-injection / non-pollution HTTP test

**Files:**
- Test: `tests/status-server-chat.test.ts` (add after the Task 4 tests)

The mock-mode tests in Task 4 prove control flow but never construct `decisionEvidence`, so they cannot prove `WEB_CHAT_STEER_PROMPT` is actually injected into the re-decision request or absent from the final answer request. This test drives the real `streamChatAssistantMessage` path against a captured HTTP server (mirroring the existing `streamChatAssistantMessage forwards webActionInstruction...` test at line 116) and inspects every request body.

- [ ] **Step 1: Write the failing test**

```ts
test('streamDirectChatWebTurn injects the steer prompt only into the re-decision request', async () => {
  const bodies: Dict[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      bodies.push(JSON.parse(body) as Dict);
      const action = bodies.length === 1 ? '{"action":"web_search","query":"osrs iron bar"}'
        : bodies.length === 2 ? '{"action":"answer"}'
        : bodies.length === 3 ? '{"action":"web_fetch","url":"https://example.com/iron"}'
        : bodies.length === 4 ? '{"action":"answer"}'
        : 'Iron bars trade around 150gp.';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: action } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const config = createConfig();
  (config.Server as Dict).LlamaCpp = {
    ...((config.Server as Dict).LlamaCpp as Dict),
    BaseUrl: `http://127.0.0.1:${port}`,
  };
  try {
    const result = await streamDirectChatWebTurn(config, createSession(), 'osrs iron bar price', searxngWebTools(), () => {});

    assert.equal(result.assistantContent, 'Iron bars trade around 150gp.');
    assert.equal(bodies.length, 5);
    const steerInBody = (body: Dict): boolean =>
      (body.messages as Dict[]).some((message) => String(message.content).includes('have not opened any result page'));
    // Injected ONLY into the re-decision request (#3); absent from the first
    // decision (#1), the first answer decision (#2), the post-fetch decision
    // (#4), and the final answer request (#5).
    assert.ok(!steerInBody(bodies[0]));
    assert.ok(!steerInBody(bodies[1]));
    assert.ok(steerInBody(bodies[2]));
    assert.ok(!steerInBody(bodies[3]));
    assert.ok(!steerInBody(bodies[4]));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
```

Request sequence: (1) decision→web_search, executed via `searxngWebTools()`; (2) decision→answer, blocked, `steerMessage` set; (3) re-decision carries the steer in `decisionEvidence`→web_fetch (succeeds, clears steer, sets `fetchSucceeded`); (4) decision→answer, allowed; (5) answer turn→prose.

- [ ] **Step 2: Run to verify**

Run: `npx tsx --test --test-name-pattern "injects the steer prompt only into the re-decision request" .\tests\status-server-chat.test.ts`
Expected (before governor lands): FAIL — without the gate there is no re-decision, `bodies.length` is not 5 and the steer text appears in no body. After the governor (Tasks 2-3): PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/status-server-chat.test.ts
git commit -m "test(chat): assert steer prompt injection and answer-turn non-pollution"
```

---

## Task 6: Full regression run

**Files:** none (verification only)

- [ ] **Step 1: Run the full chat test file**

Run: `npx tsx --test .\tests\status-server-chat.test.ts`
Expected: all tests PASS. The pre-existing `streamDirectChatWebTurn answers directly when no web tool is needed` test (no search → not gated) is unaffected; the `streams a web_search tool then a prose answer` test was already updated to walk search→fetch→answer in Task 3 Step 7, so it passes here with no further change.

- [ ] **Step 2: Run the broader build+test suite**

Run: `npm test`
Expected: build succeeds and the suite passes. If unrelated pre-existing failures appear, note them but do not fix in this plan.

- [ ] **Step 3: No commit needed**

This task is verification only; all code is already committed by Tasks 1-5. If `npm test` surfaced a needed fix, commit it with a descriptive message.

---

## Self-Review Notes

- **Spec coverage:** Trigger (intercept answer) → Task 3 Step 5 gate; fetch-satisfies → Task 3 Step 4 `fetchSucceeded` + Task 4 Test D; failed-fetch does-not-satisfy → Task 4 Test E; 3-block budget → Task 2 const + gate + Task 4 Test B; `maxTurns` bypass → Task 4 Test F; static-not-gated → Task 4 Test C; transient nudge injection + answer-turn non-pollution → Task 3 Step 3 local copy + **Task 5 HTTP-captured test** (asserts the steer text is present only in the re-decision request body and absent from the answer request); nudge text → Task 1.
- **Type consistency:** `searchCount`/`fetchSucceeded`/`blockedAnswers`/`steerMessage` declared once (Task 3 Step 2) and referenced consistently; `WEB_CHAT_MAX_STEER_ATTEMPTS` (Task 2) used in the gate (Task 3 Step 5); `WEB_CHAT_STEER_PROMPT` exported (Task 1) and asserted in tests.
- **Existing-test interaction:** the `streams a web_search tool then a prose answer` test (line 196) changes behavior under the gate — updated in Task 3 Step 7, in the same commit as the governor, so no commit ever leaves it red.
- **No placeholders:** every code/test step shows complete code and an exact run command with expected result.

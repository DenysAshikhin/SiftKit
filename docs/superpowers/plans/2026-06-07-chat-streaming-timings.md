# Chat-Path Streaming Timings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make streaming planner/chat requests record llama's real decode time (`timings.predicted_ms` / token count) for `generation_duration_ms`, even when the planner aborts the stream early — so the dashboard "Gen/s" reflects actual GPU decode instead of inflated wall-clock.

**Architecture:** Single-line change to the shared request body in `requestPlannerAction` to send `timings_per_token: true` whenever streaming. llama then emits a cumulative `timings` object on **every** SSE chunk (verified against the live server), so the existing per-chunk parser ([planner-protocol.ts:788-795](../../../src/repo-search/planner-protocol.ts)) captures real `predicted_ms`/`predicted_n` before the early-stop fires — instead of falling through to the wall-clock fallback ([planner-protocol.ts:884](../../../src/repo-search/planner-protocol.ts)). The fix flows automatically to planner turns, finish-validation, and terminal synthesis because all three share this body builder.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `node:test` + `node:assert/strict`, llama.cpp server (`/v1/chat/completions` SSE), `LlamaClient.streamChatCompletion`.

---

## Root Cause (confirmed by measurement, not inference)

- Live probe of `/v1/chat/completions` streaming: the **default** response only carries `timings` in the **final** chunk (just before `data: [DONE]`). Setting `timings_per_token: true` attaches a cumulative `timings` object to **every** chunk.
- The planner deliberately **aborts the stream early** the instant it detects a complete action / runaway / repetition in the streamed deltas (`return 'stop'` at [planner-protocol.ts:824/830/836/849/855](../../../src/repo-search/planner-protocol.ts)). On that path the final timings chunk is never consumed, so `generationDurationMs` stays `null` and resolves to **wall-clock** (`finishedAt - generationStartedAt`, [planner-protocol.ts:884](../../../src/repo-search/planner-protocol.ts)).
- The engine **sums** per-turn `generationDurationMs` ([engine.ts:1281](../../../src/repo-search/engine.ts), [engine.ts:2181](../../../src/repo-search/engine.ts), [engine.ts:2264](../../../src/repo-search/engine.ts)) and the dashboard derives Gen/s as `tokens / duration` ([telemetry-metrics.ts:53](../../../src/lib/telemetry-metrics.ts)). Wall-clock summed across a many-turn loop → huge duration → near-zero Gen/s (the misleading "0.117").
- Measured ground truth: real decode is 14–22 tok/s at all context sizes; the "0.117" was an accounting artifact, not GPU behavior.

**Therefore:** the parser is already correct; the only defect is that the timings never arrive on the early-stop path. `timings_per_token: true` fixes it at the source.

## Scope / Non-Goals

- In scope: the body change + tests proving early-stopped streaming turns record real `predicted_ms`/token count, and a body-content assertion locking the flag.
- Out of scope (do NOT do here): changing `maxTurns` / the web_search loop; adding a DB "estimated vs measured" flag; dashboard UI changes; touching the non-streaming path (it already reads timings from the full response body via [planner-protocol.ts:621](../../../src/repo-search/planner-protocol.ts)).

## File Structure

- Modify: `src/repo-search/planner-protocol.ts` — add `timings_per_token: true` to the streaming spread in the shared `bodyObj` (line 533). One responsibility: request construction. No other code changes needed; the per-chunk parser already consumes `timings`.
- Create: `tests/planner-streaming-timings.test.ts` — one fake SSE llama server helper plus two tests: (1) an early-stopped streaming turn records real `predicted_ms`/`predicted_n` from per-chunk timings; (2) the streamed request body contains `stream: true` and `timings_per_token: true`. Both are written before the implementation (strict TDD) and both fail until Task 2.

---

## Task 1: Failing tests — early-stop timing capture + request body flag

**Files:**
- Create: `tests/planner-streaming-timings.test.ts`

The fake `/v1/chat/completions` server mimics llama: it attaches a cumulative `timings` object to each chunk **only when the request body sets `timings_per_token: true`** (otherwise only on the final chunk, like real llama), and it records the last request body so a second test can assert the flag. It streams a `reasoning_content` that completes a `finish` action across two chunks, which makes the planner stop early (via `findPlannerActionText` → `'stop'`) before the final chunk. No monkey-patching: the request body is captured by the server, so the test never depends on `LlamaStreamResult`'s shape.

- [ ] **Step 1: Write the failing tests**

Create `tests/planner-streaming-timings.test.ts` with exactly this content:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { requestPlannerAction } from '../src/repo-search/planner-protocol.js';

const PREDICTED_MS = 4321;
const PREDICTED_N = 7;

type FakeLlamaServer = { baseUrl: string; lastBody: () => string; close: () => Promise<void> };

// Fake llama SSE server. Mirrors real llama.cpp: a cumulative `timings` object
// is attached to non-final chunks ONLY when the request asks for
// timings_per_token. The final chunk always carries timings (as real llama
// does), but the planner stops early and never consumes it. The server records
// the last request body so the body-flag test needs no monkey-patching.
function startFakeLlamaServer(): Promise<FakeLlamaServer> {
  return new Promise((resolve) => {
    let lastBody = '';
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        lastBody = raw;
        const perToken = raw.includes('"timings_per_token":true');
        const timings = {
          cache_n: 0,
          prompt_n: 3,
          prompt_ms: 30,
          predicted_n: PREDICTED_N,
          predicted_ms: PREDICTED_MS,
          predicted_per_second: (PREDICTED_N / PREDICTED_MS) * 1000,
        };
        const writeChunk = (delta: Record<string, unknown>, withTimings: boolean): void => {
          const payload: Record<string, unknown> = {
            choices: [{ index: 0, delta }],
            object: 'chat.completion.chunk',
          };
          if (withTimings) payload.timings = timings;
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        };
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        // Two reasoning chunks that together form a complete finish action.
        writeChunk({ reasoning_content: '{"action":"finish",' }, perToken);
        writeChunk({ reasoning_content: '"output":"hi"}' }, perToken);
        // Final chunk: real llama always includes timings here. The planner has
        // already stopped, so this must NOT be the source of the captured value.
        res.write(`data: ${JSON.stringify({
          choices: [{ index: 0, finish_reason: 'stop', delta: {} }],
          object: 'chat.completion.chunk',
          timings: { ...timings, predicted_ms: 999999 },
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        lastBody: () => lastBody,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

async function runStreamingPlanner(baseUrl: string): Promise<Awaited<ReturnType<typeof requestPlannerAction>>> {
  return requestPlannerAction({
    baseUrl,
    model: 'mock',
    messages: [{ role: 'user', content: 'hi' }],
    timeoutMs: 5000,
    maxTokens: 64,
    thinkingEnabled: true,
    stream: true,
    toolDefinitions: [],
    onThinkingDelta: () => {},
  });
}

test('early-stopped streaming planner turn records real predicted_ms from per-chunk timings', async () => {
  const fake = await startFakeLlamaServer();
  try {
    const response = await runStreamingPlanner(fake.baseUrl);
    assert.equal(response.generationDurationMs, PREDICTED_MS);
    assert.equal(response.completionTokens, PREDICTED_N);
  } finally {
    await fake.close();
  }
});

test('streaming planner request body sets stream and timings_per_token', async () => {
  const fake = await startFakeLlamaServer();
  try {
    await runStreamingPlanner(fake.baseUrl);
    const parsed = JSON.parse(fake.lastBody()) as Record<string, unknown>;
    assert.equal(parsed.stream, true);
    assert.equal(parsed.timings_per_token, true);
  } finally {
    await fake.close();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test .\tests\planner-streaming-timings.test.ts`
Expected: BOTH tests FAIL.
- Test 1: without `timings_per_token`, the reasoning chunks carry no timings and the planner stops before the final chunk, so `generationDurationMs` is a small wall-clock value (not `4321`) and `completionTokens` is `null`.
- Test 2: the request body lacks `timings_per_token`, so `parsed.timings_per_token` is `undefined`, not `true`.

- [ ] **Step 3: Commit the failing tests**

```bash
git add tests/planner-streaming-timings.test.ts
git commit -m "test: cover real decode timing capture on early-stopped streams"
```

---

## Task 2: Request `timings_per_token` on streaming requests

**Files:**
- Modify: `src/repo-search/planner-protocol.ts:533`

- [ ] **Step 1: Apply the body change**

In `requestPlannerAction`, change the streaming spread in `bodyObj` from:

```typescript
    ...options.extraBody,
    ...(options.stream ? { stream: true } : {}),
  };
```

to:

```typescript
    ...options.extraBody,
    ...(options.stream ? { stream: true, timings_per_token: true } : {}),
  };
```

Rationale: `timings_per_token` makes llama attach a cumulative `timings` object to every SSE chunk, so the existing per-chunk parser captures real `predicted_ms`/`predicted_n` before any early stop. This body is already llama-specific (`cache_prompt`, `id_slot`, `chat_template_kwargs`), so the extra field is consistent with existing assumptions. Note on ordering: this spread runs **after** `...options.extraBody`, so the streaming fields take precedence over any same-named `extraBody` key. That is intended — `timings_per_token`/`stream` must not be silently overridable by `extraBody`. No current caller sets `timings_per_token` via `extraBody`, so there is no behavior change for existing call sites.

- [ ] **Step 2: Run the Task 1 tests to verify they pass**

Run: `npx tsx --test .\tests\planner-streaming-timings.test.ts`
Expected: BOTH tests PASS.
- Test 1: `generationDurationMs === 4321` and `completionTokens === 7` — captured from the per-chunk timings, never the `999999` final chunk.
- Test 2: `parsed.stream === true` and `parsed.timings_per_token === true`.

- [ ] **Step 3: Commit**

```bash
git add src/repo-search/planner-protocol.ts
git commit -m "fix: request per-token timings so streaming records real decode time"
```

---

## Task 3: Typecheck + full suite + reality check

**Files:** none (verification only)

- [ ] **Step 1: Typecheck (including tests)**

Run: `npm run typecheck:test`
Expected: exits 0, no type errors.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: typecheck + build + all tests pass. Pay attention to existing streaming/chat tests in `tests/repo-search-chat-loop.test.ts`, `tests/status-server-chat.test.ts`, and `tests/dashboard-status-server.test.ts` — they must remain green (the body change only adds a field; `mockResponses`-based tests bypass the network entirely so are unaffected).

- [ ] **Step 3: Manual reality check against the live server (optional but recommended)**

With the managed llama server running, send one streaming chat turn through the dashboard, then read the persisted turn:

```bash
node -e "const D=require('better-sqlite3'); const db=new D('.siftkit/runtime.sqlite',{readonly:true}); const r=db.prepare(\"select output_tokens_estimate o, generation_duration_ms g from chat_messages where kind='assistant_answer' order by rowid desc limit 1\").get(); console.log(r, 'derived tok/s=', r.o/(r.g/1000));"
```

Expected: `derived tok/s` is in the ~10–22 range (real decode), not a fraction like 0.1.

- [ ] **Step 4: Final commit (only if Step 1/2 required a code change)**

No code changes are expected in this task. If a typecheck/test fix was needed, commit it:

```bash
git add -A
git commit -m "chore: typecheck/test fixes for streaming timings"
```

---

## Self-Review

- **Spec coverage:** The spec asks that `generation_duration_ms` and Gen/s reflect real decode from streaming timings. Task 2 makes llama emit per-chunk timings; the existing parser captures them; Task 1 Test 1 proves the early-stop path (the actual defect) now records `predicted_ms`; Task 1 Test 2 locks the request flag; Task 3 Step 3 confirms end-to-end on the live server. Covered.
- **Placeholder scan:** No TBD/TODO; all test and impl code is complete and literal.
- **Type consistency:** The test passes a subset of `PlannerRequestOptions` (`baseUrl`, `model`, `messages`, `timeoutMs`, `maxTokens`, `thinkingEnabled`, `stream`, `toolDefinitions`, `onThinkingDelta`), each matching its declaration in [planner-protocol.ts:406-437](../../../src/repo-search/planner-protocol.ts). The remaining options are optional and intentionally unused here: `reasoningContentEnabled`/`preserveThinking` only affect message serialization (irrelevant to timing capture), and `onContentDelta` is unused because the fake server streams the finish action via `reasoning_content` (driving `onThinkingDelta`), not `content`. `PlannerActionResponse.generationDurationMs` / `.completionTokens` match [planner-protocol.ts:35-47](../../../src/repo-search/planner-protocol.ts). The test derives its return type via `Awaited<ReturnType<typeof requestPlannerAction>>` and captures the request body from the fake server, so it has no dependency on `LlamaStreamResult`'s shape (`{ sawDone: boolean }`, [llama-client.ts:45](../../../src/lib/llama-client.ts)) — no monkey-patching, no fragile casts.
- **Early-stop determinism:** `findPlannerActionText` ([planner-protocol.ts:699](../../../src/repo-search/planner-protocol.ts)) parses the first complete JSON object in accumulated reasoning and validates it via `ModelJson.parseRepoSearchPlannerAction`. A `finish` action validates with an empty `allowedToolNames` set (it is not a tool), so `toolDefinitions: []` is correct and the two reasoning chunks deterministically trigger the early stop.

---

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.

Which approach?

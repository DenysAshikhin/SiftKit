# Runaway-Check Throttle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop running the O(N) runaway/repetition detectors on every streamed SSE frame; run them once per 256 streamed chars plus once at stream end.

**Architecture:** In `streamChatAtBaseUrl` (`src/llm-protocol/llama-cpp-client.ts`), a `lastRunawayCheckLength` tracker gates the two detectors (`getRecentTokenRepetition`, `getRunawayStructuralTail`) behind a 256-char growth threshold; a final ungated check after the frame loop preserves today's end-state guarantee. Detector internals are untouched. Spec: `docs/superpowers/specs/2026-08-07-runaway-check-throttle-design.md`.

**Tech Stack:** TypeScript (Node), `node:test` via `npx tsx --test`, existing `StreamingHttpClient` mock in `tests/llm-protocol-streaming.test.ts`.

---

### Task 1: Throttle runaway checks in the streaming loop

**Files:**
- Modify: `src/llm-protocol/llama-cpp-client.ts` (lines 353, 421-434, after the frame loop at ~438, and above `getRunawayStructuralTail` at ~534)
- Test: `tests/llm-protocol-streaming.test.ts`

Background: the stream loop appends each SSE frame's deltas to `contentText`/`reasoningText`, then currently runs `getRecentTokenRepetition` and `getRunawayStructuralTail` on both strings every frame (`src/llm-protocol/llama-cpp-client.ts:421-434`). `getRecentTokenRepetition` whitespace-splits the entire accumulated text per call — O(N) per frame, O(N²) per completion. Detector minimum triggers: 48 consecutive `</arg_value>` tags (576 chars), 200+ whitespace tokens with a repeated ≥48-char tail, or 96 repeated trailing structural chars — so a 256-char check stride cannot miss a live runaway, and one final check at stream end covers a runaway completing inside the last sub-256-char window.

- [ ] **Step 1: Write the failing tests**

Append to `tests/llm-protocol-streaming.test.ts` (imports `JsonObject`, `LlamaCppClient`, `StreamingHttpClient`, and `streamingConfig` already exist in the file):

```typescript
test('llama streaming client throttles runaway checks to the 256-char stride', async () => {
  const contentUpdates: string[] = [];
  // Frame 1 is 15 chars; each brace frame adds 8. Per-frame checking would
  // stop at 111 chars (96 trailing braces, 13 callbacks). The throttled check
  // first runs at 263 chars: 31 normal callbacks, then the stop callback.
  const packets: JsonObject[] = [
    { choices: [{ delta: { content: '{"action":"x"} ' } }] },
    ...Array.from({ length: 60 }, (): JsonObject => ({ choices: [{ delta: { content: '}}}}}}}}' } }] })),
  ];
  const http = new StreamingHttpClient(packets);

  const response = await new LlamaCppClient(http).chat({
    config: streamingConfig,
    model: 'local',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    maxTokens: 64,
    stream: true,
    allowedToolNames: [],
    onContentDelta: (value) => contentUpdates.push(value),
  });

  assert.equal(response.stoppedEarly, true);
  assert.match(response.earlyStopReason || '', /runaway streamed planner content repeated/u);
  assert.equal(response.text, `{"action":"x"} ${'}'.repeat(96)}`);
  assert.equal(contentUpdates.length, 32);
});

test('llama streaming client detects a runaway completing after the last throttled check', async () => {
  const contentUpdates: string[] = [];
  // 'prefix ' (7 chars) + 48 tag frames (12 chars each) = 583 chars total.
  // Throttled checks run at 259 chars (21 tags) and 523 chars (43 tags) —
  // both below the 48-tag trigger. The final 60 chars arrive unchecked, so
  // only the end-of-stream check can catch the completed 48-tag flood.
  const packets: JsonObject[] = [
    { choices: [{ delta: { content: 'prefix ' } }] },
    ...Array.from({ length: 48 }, (): JsonObject => ({ choices: [{ delta: { content: '</arg_value>' } }] })),
  ];
  const http = new StreamingHttpClient(packets);

  const response = await new LlamaCppClient(http).chat({
    config: streamingConfig,
    model: 'local',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    maxTokens: 64,
    stream: true,
    allowedToolNames: [],
    onContentDelta: (value) => contentUpdates.push(value),
  });

  assert.equal(response.stoppedEarly, true);
  assert.match(response.earlyStopReason || '', /recent planner content tokens repeated/u);
  assert.equal(response.text, 'prefix');
  // 49 normal per-frame callbacks plus one truncation callback from the
  // end-of-stream check. Per-frame checking stops inside the loop at frame
  // 49 and produces only 49 callbacks.
  assert.equal(contentUpdates.length, 50);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test tests/llm-protocol-streaming.test.ts`
Expected: the two new tests FAIL on the callback-count assertions (13 ≠ 32 and 49 ≠ 50 respectively — per-frame checking stops earlier). All pre-existing tests PASS.

- [ ] **Step 3: Implement the throttle**

In `src/llm-protocol/llama-cpp-client.ts`, make four edits.

Edit A — above `function getRunawayStructuralTail` (~line 534), add:

```typescript
/**
 * The runaway detectors scan the full accumulated text, so the stream loop
 * runs them only after this many new streamed characters (~64 tokens), plus
 * once at stream end. Every detector trigger spans well over this window, so
 * the added latency cannot miss a live runaway.
 */
const RUNAWAY_CHECK_INTERVAL_CHARS = 256;
```

Edit B — in `streamChatAtBaseUrl`, directly after `let earlyStopReason: string | null = null;` (line 353), add:

```typescript
    let lastRunawayCheckLength = 0;
    const detectRunaway = (): boolean => {
      const runaway = getRecentTokenRepetition(contentText)
        || getRecentTokenRepetition(reasoningText)
        || getRunawayStructuralTail(contentText)
        || getRunawayStructuralTail(reasoningText);
      if (!runaway) return false;
      earlyStopReason = runaway.reason;
      if (contentText) contentText = runaway.truncatedText;
      options.onContentDelta?.(contentText);
      return true;
    };
```

(The `||` chain preserves the current precedence: repetition on content, repetition on reasoning, then structural on content, structural on reasoning; reason strings and truncation are unchanged.)

Edit C — replace the per-frame check blocks (current lines 421-434):

```typescript
          const repetition = getRecentTokenRepetition(contentText) || getRecentTokenRepetition(reasoningText);
          if (repetition) {
            earlyStopReason = repetition.reason;
            if (contentText) contentText = repetition.truncatedText;
            options.onContentDelta?.(contentText);
            break streamFrames;
          }
          const structural = getRunawayStructuralTail(contentText) || getRunawayStructuralTail(reasoningText);
          if (structural) {
            earlyStopReason = structural.reason;
            if (contentText) contentText = structural.truncatedText;
            options.onContentDelta?.(contentText);
            break streamFrames;
          }
```

with:

```typescript
          const streamedLength = contentText.length + reasoningText.length;
          if (streamedLength - lastRunawayCheckLength >= RUNAWAY_CHECK_INTERVAL_CHARS) {
            lastRunawayCheckLength = streamedLength;
            if (detectRunaway()) {
              break streamFrames;
            }
          }
```

The `if (deltaContent) { options.onContentDelta?.(contentText); }` block that follows stays as-is.

Edit D — after the closing `}` of the `streamFrames:` for-await loop (currently line 438, still inside the `try` before `} catch (error) {`), add:

```typescript
      if (!earlyStopReason) {
        detectRunaway();
      }
```

(Guarded so the reasoning-action early stop at lines 395-401 and in-loop detections are not re-processed; a runaway found here takes the identical early-stop path — reason set, truncation, final `onContentDelta`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test tests/llm-protocol-streaming.test.ts`
Expected: PASS — both new tests and all pre-existing ones, including the single-frame 48-tag repetition stop at lines 234-271 (that frame alone is 576+ chars, over the stride, so it still stops in-loop).

- [ ] **Step 5: Full verification**

```powershell
npm test
npm run typecheck
npm run lint
```

Expected: all green. Report any pre-existing failures unrelated to this change separately.

- [ ] **Step 6: Commit**

```powershell
git add src/llm-protocol/llama-cpp-client.ts tests/llm-protocol-streaming.test.ts
git commit -m "perf: throttle streaming runaway checks to a 256-char stride"
```

---

## Self-review notes

- Spec coverage: throttle + tracker → Edits A-C; end-of-stream parity check → Edit D; "detectors untouched" → only call sites move into `detectRunaway`; testing section → Steps 1-2 and 4-5; success criteria → Step 4 (behavior) and Step 5 (suites/typecheck/lint).
- Callback-count math verified against the current code: test 1 fires per-frame at 111 chars (13 callbacks) vs throttled at 263 chars (32); test 2 fires per-frame at frame 49 (49 callbacks) vs end-of-stream check (50). Both tests assert identical final `text` under old and new code, isolating the cadence change.
- Names consistent across steps: `RUNAWAY_CHECK_INTERVAL_CHARS`, `lastRunawayCheckLength`, `detectRunaway`.

# Streaming Scan State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the two remaining O(N²) per-token streaming scans incremental (early planner-action detection, finish-output decoding) and stop building live-text progress events on paths whose writers discard them.

**Architecture:** A stateful `FirstJsonObjectScanner` in `llama-cpp-client.ts` replaces `findFirstCompleteJsonObjectText`, scanning only appended reasoning chars per frame. A stateful `StreamingFinishOutputExtractor` in `model-json.ts` replaces `ModelJson.extractStreamingFinishOutput`, decoding only appended content chars. A `wantsLiveText` capability on `ProgressWriter` (surfaced as `ProgressReporter.liveTextEnabled`) gates the task-loop/terminal-synthesizer live-text callbacks so server repo-search runs skip the work entirely. Spec: `docs/superpowers/specs/2026-08-07-streaming-scan-state-design.md`.

**Tech Stack:** TypeScript (Node), `node:test` via `npx tsx --test`, existing `StreamingHttpClient` mock in `tests/llm-protocol-streaming.test.ts`.

---

### Task 1: FirstJsonObjectScanner

**Files:**
- Modify: `src/llm-protocol/llama-cpp-client.ts` (locals near line 354, reasoning branch at ~405-415, delete `findFirstCompleteJsonObjectText` at ~590-623)
- Test: create `tests/first-json-object-scanner.test.ts`; append one parity test to `tests/llm-protocol-streaming.test.ts`

Background: the stream loop's reasoning branch currently calls the stateless `findFirstCompleteJsonObjectText(reasoningText)` every reasoning frame. The replacement class keeps the walk state (`scannedTo`, `startIndex`, `depth`, `inString`, `escaped`) across frames. Parity requirements: identical first-complete-object semantics (braces inside strings ignored, `\"` handled), cached result re-returned after completion (the old function always re-found the same first object), reset when the pushed text is shorter than what was scanned (early-stop truncation).

- [ ] **Step 1: Write the failing unit tests**

Create `tests/first-json-object-scanner.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';

import { FirstJsonObjectScanner } from '../src/llm-protocol/llama-cpp-client.js';

test('finds the first complete object across incremental pushes', () => {
  const scanner = new FirstJsonObjectScanner();
  assert.equal(scanner.push('pre {"a'), null);
  assert.equal(scanner.push('pre {"a":1'), null);
  assert.equal(scanner.push('pre {"a":1}'), '{"a":1}');
});

test('ignores braces inside JSON strings', () => {
  const scanner = new FirstJsonObjectScanner();
  assert.equal(scanner.push('{"s":"x{y}"'), null);
  assert.equal(scanner.push('{"s":"x{y}"}'), '{"s":"x{y}"}');
});

test('carries escape state across a push boundary', () => {
  const scanner = new FirstJsonObjectScanner();
  // Text ends with a backslash inside a string; the escaped quote arrives
  // in the next push and must not close the string.
  assert.equal(scanner.push('{"s":"a\\'), null);
  assert.equal(scanner.push('{"s":"a\\"b"}'), '{"s":"a\\"b"}');
});

test('caches the first completed object and ignores later ones', () => {
  const scanner = new FirstJsonObjectScanner();
  assert.equal(scanner.push('{"a":1} {"b":2}'), '{"a":1}');
  assert.equal(scanner.push('{"a":1} {"b":2} more'), '{"a":1}');
});

test('resets when the text shrinks', () => {
  const scanner = new FirstJsonObjectScanner();
  assert.equal(scanner.push('{"a"'), null);
  assert.equal(scanner.push('{'), null);
  assert.equal(scanner.push('{"b":2}'), '{"b":2}');
});

test('returns null for text without an object', () => {
  const scanner = new FirstJsonObjectScanner();
  assert.equal(scanner.push('plain text, no braces'), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test tests/first-json-object-scanner.test.ts`
Expected: FAIL — `FirstJsonObjectScanner` is not exported.

- [ ] **Step 3: Implement the scanner**

In `src/llm-protocol/llama-cpp-client.ts`, add (place directly above `function findFirstCompleteJsonObjectText`, ~line 590):

```typescript
/**
 * Incrementally finds the first complete JSON object in an append-only text
 * stream. State persists across push() calls so each call scans only newly
 * appended characters; a push shorter than what was already scanned
 * (early-stop truncation) resets the scan. After the first object completes,
 * it is cached and returned on every later push.
 */
export class FirstJsonObjectScanner {
  private scannedTo = 0;
  private startIndex = -1;
  private depth = 0;
  private inString = false;
  private escaped = false;
  private result: string | null = null;

  push(text: string): string | null {
    if (text.length < this.scannedTo) {
      this.resetState();
    }
    if (this.result !== null) {
      return this.result;
    }
    for (let index = this.scannedTo; index < text.length; index += 1) {
      const char = text[index];
      if (this.startIndex < 0) {
        if (char === '{') {
          this.startIndex = index;
          this.depth = 1;
        }
        continue;
      }
      if (this.inString) {
        if (this.escaped) {
          this.escaped = false;
        } else if (char === '\\') {
          this.escaped = true;
        } else if (char === '"') {
          this.inString = false;
        }
        continue;
      }
      if (char === '"') {
        this.inString = true;
        continue;
      }
      if (char === '{') {
        this.depth += 1;
        continue;
      }
      if (char === '}') {
        this.depth -= 1;
        if (this.depth === 0) {
          this.scannedTo = text.length;
          this.result = text.slice(this.startIndex, index + 1).trim();
          return this.result;
        }
      }
    }
    this.scannedTo = text.length;
    return null;
  }

  private resetState(): void {
    this.scannedTo = 0;
    this.startIndex = -1;
    this.depth = 0;
    this.inString = false;
    this.escaped = false;
    this.result = null;
  }
}
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `npx tsx --test tests/first-json-object-scanner.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Swap the call site and delete the old function**

In `streamChatAtBaseUrl`, directly after the `detectRunaway` closure (after its closing `};`, ~line 366), add:

```typescript
    const reasoningActionScanner = new FirstJsonObjectScanner();
```

In the reasoning branch (~line 405-415), replace:

```typescript
            const completedAction = findFirstCompleteJsonObjectText(reasoningText);
```

with:

```typescript
            const completedAction = reasoningActionScanner.push(reasoningText);
```

Delete the entire `function findFirstCompleteJsonObjectText(text: string): string | null { ... }` (its only caller was the line above).

- [ ] **Step 6: Add the client-level parity test**

Append to `tests/llm-protocol-streaming.test.ts` (this passes before and after the swap — it pins that multi-frame assembly with braces inside strings still early-stops):

```typescript
test('llama streaming client stops on a planner action assembled across reasoning frames', async () => {
  const http = new StreamingHttpClient([
    { choices: [{ delta: { reasoning_content: 'plan: {"action":"grep","args"' } }] },
    { choices: [{ delta: { reasoning_content: ':{"pattern":"x{y}"' } }] },
    { choices: [{ delta: { reasoning_content: '}} trailing' } }] },
    { choices: [{ delta: { content: 'must not be read' } }] },
  ]);

  const response = await new LlamaCppClient(http).chat({
    config: streamingConfig,
    model: 'local',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    maxTokens: 64,
    stream: true,
    allowedToolNames: [],
  });

  assert.equal(response.text, '{"action":"grep","args":{"pattern":"x{y}"}}');
  assert.equal(response.reasoningText, '');
  assert.equal(response.stoppedEarly, true);
  assert.equal(response.earlyStopReason, 'planner action completed in streamed reasoning');
});
```

- [ ] **Step 7: Run the streaming suite**

Run: `npx tsx --test tests/llm-protocol-streaming.test.ts tests/first-json-object-scanner.test.ts`
Expected: PASS — all tests, including the pre-existing `stops on completed planner action in reasoning` test.

- [ ] **Step 8: Commit**

```powershell
git add src/llm-protocol/llama-cpp-client.ts tests/first-json-object-scanner.test.ts tests/llm-protocol-streaming.test.ts
git commit -m "perf: incremental first-JSON-object scanning for streamed reasoning"
```

---

### Task 2: StreamingFinishOutputExtractor

**Files:**
- Modify: `src/lib/model-json.ts` (delete static `extractStreamingFinishOutput` at 107-116 and `decodeJsonStringPrefix` at 118-148; add the exported class; `JSON_ESCAPE_CHARS` at 80-89 stays)
- Modify: `src/repo-search/engine/task-loop.ts` (~lines 519-545)
- Test: `tests/model-json.test.ts` (migrate 6 static tests at lines 76-112, add incremental tests)

Decode-semantics parity (from `decodeJsonStringPrefix`): plain chars append; `\` + mapped escape appends `JSON_ESCAPE_CHARS[escape] ?? escape`; `\uXXXX` with 4 valid hex chars appends `String.fromCharCode(parseInt(hex, 16))`; a trailing `\` or fewer than 4 hex chars waits (does not consume); 4 invalid hex chars stops decoding permanently (the old code re-hit the same break point on every call — model as a `stalled` flag); an unescaped `"` closes the value permanently.

- [ ] **Step 1: Write the failing tests**

In `tests/model-json.test.ts`, add `StreamingFinishOutputExtractor` to the existing import from `../src/lib/model-json.js`, and replace the six `ModelJson.extractStreamingFinishOutput(...)` tests (lines 76-112) with instance equivalents plus incremental cases:

```typescript
test('extractor decodes a complete streaming finish action', () => {
  const output = new StreamingFinishOutputExtractor().push('{"action":"finish","output":"Line one\\nLine two"}');
  assert.equal(output, 'Line one\nLine two');
});

test('extractor decodes the prefix while a finish output is still streaming', () => {
  const output = new StreamingFinishOutputExtractor().push(
    '{"action":"finish","output":"Tool calls are handled\\n- Backend',
  );
  assert.equal(output, 'Tool calls are handled\n- Backend');
});

test('extractor decodes escaped quotes inside a streaming finish output', () => {
  const output = new StreamingFinishOutputExtractor().push('{"action":"finish","output":"He said \\"hi\\" loudly"}');
  assert.equal(output, 'He said "hi" loudly');
});

test('extractor ignores a trailing incomplete escape', () => {
  const output = new StreamingFinishOutputExtractor().push('{"action":"finish","output":"first line\\');
  assert.equal(output, 'first line');
});

test('extractor returns null for a streaming tool action', () => {
  const output = new StreamingFinishOutputExtractor().push('{"action":"read","args":{"path":"a.ts"}}');
  assert.equal(output, null);
});

test('extractor returns null before the finish output key has streamed', () => {
  const output = new StreamingFinishOutputExtractor().push('{"action":"finish"');
  assert.equal(output, null);
});

test('extractor decodes incrementally across pushes, resuming pending escapes', () => {
  const extractor = new StreamingFinishOutputExtractor();
  const t1 = '{"action":"finish","output":"ab';
  const t2 = `${t1}c\\`;
  const t3 = `${t2}n def`;
  assert.equal(extractor.push(t1), 'ab');
  assert.equal(extractor.push(t2), 'abc');
  assert.equal(extractor.push(t3), 'abc\n def');
});

test('extractor resumes a unicode escape split across pushes', () => {
  const extractor = new StreamingFinishOutputExtractor();
  const t1 = '{"action":"finish","output":"A\\u00';
  assert.equal(extractor.push(t1), 'A');
  assert.equal(extractor.push(`${t1}2F!`), 'A/!');
});

test('extractor freezes the value once the closing quote streams', () => {
  const extractor = new StreamingFinishOutputExtractor();
  const closed = '{"action":"finish","output":"done"}';
  assert.equal(extractor.push(closed), 'done');
  assert.equal(extractor.push(`${closed} trailing`), 'done');
});

test('extractor finds markers that only appear on a later push', () => {
  const extractor = new StreamingFinishOutputExtractor();
  assert.equal(extractor.push('{"action":"fin'), null);
  assert.equal(extractor.push('{"action":"finish","output":"hi'), 'hi');
});

test('extractor resets when the text shrinks', () => {
  const extractor = new StreamingFinishOutputExtractor();
  assert.equal(extractor.push('{"action":"finish","output":"done"}'), 'done');
  assert.equal(extractor.push('{"action":"finish","output":"d'), 'd');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test tests/model-json.test.ts`
Expected: FAIL — `StreamingFinishOutputExtractor` is not exported (and the old static tests were replaced).

- [ ] **Step 3: Implement the extractor and delete the statics**

In `src/lib/model-json.ts`, delete `static extractStreamingFinishOutput` (lines 107-116) and `private static decodeJsonStringPrefix` (lines 118-148). Add after the `ModelJson` class:

```typescript
/**
 * Incrementally decodes the streamed value of a finish action's "output"
 * string over append-only accumulated content. Until the finish/output
 * markers appear, each push rescans the (short, pre-answer) text; once
 * found, each push decodes only the newly appended characters. A push
 * shorter than the previous one (early-stop truncation) resets the state.
 */
export class StreamingFinishOutputExtractor {
  private lastLength = 0;
  private decodeIndex = -1;
  private decoded = '';
  private closed = false;
  private stalled = false;

  push(text: string): string | null {
    if (text.length < this.lastLength) {
      this.resetState();
    }
    this.lastLength = text.length;
    if (this.decodeIndex < 0) {
      if (!/"action"\s*:\s*"finish"/.test(text)) {
        return null;
      }
      const openMatch = /"output"\s*:\s*"/.exec(text);
      if (!openMatch) {
        return null;
      }
      this.decodeIndex = openMatch.index + openMatch[0].length;
    }
    while (!this.closed && !this.stalled && this.decodeIndex < text.length) {
      const char = text[this.decodeIndex];
      if (char === '"') {
        this.closed = true;
        break;
      }
      if (char === '\\') {
        const escape = text[this.decodeIndex + 1];
        if (escape === undefined) {
          break;
        }
        if (escape === 'u') {
          const hex = text.slice(this.decodeIndex + 2, this.decodeIndex + 6);
          if (hex.length < 4) {
            break;
          }
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            this.stalled = true;
            break;
          }
          this.decoded += String.fromCharCode(parseInt(hex, 16));
          this.decodeIndex += 6;
          continue;
        }
        this.decoded += JSON_ESCAPE_CHARS[escape] ?? escape;
        this.decodeIndex += 2;
        continue;
      }
      this.decoded += char;
      this.decodeIndex += 1;
    }
    return this.decoded;
  }

  private resetState(): void {
    this.lastLength = 0;
    this.decodeIndex = -1;
    this.decoded = '';
    this.closed = false;
    this.stalled = false;
  }
}
```

- [ ] **Step 4: Rewire the task loop**

In `src/repo-search/engine/task-loop.ts`, add `StreamingFinishOutputExtractor` to the existing import from `../../lib/model-json.js` (the `ModelJson` import stays — other statics are still used). Directly before the `return await requestRepoSearchPlannerProtocolAction({` call (~line 520), add:

```typescript
      const finishOutputExtractor = new StreamingFinishOutputExtractor();
```

Replace the two extraction calls inside `onContentDelta` (lines 536 and 541):

```typescript
                const finishOutput = ModelJson.extractStreamingFinishOutput(accContent);
```
→
```typescript
                const finishOutput = finishOutputExtractor.push(accContent);
```

and

```typescript
                const finishOutput = ModelJson.extractStreamingFinishOutput(accContent) ?? accContent;
```
→
```typescript
                const finishOutput = finishOutputExtractor.push(accContent) ?? accContent;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx tsx --test tests/model-json.test.ts tests/mock-repo-search-loop.test.ts`
Expected: PASS — extractor tests and the untouched loop suite.

- [ ] **Step 6: Commit**

```powershell
git add src/lib/model-json.ts src/repo-search/engine/task-loop.ts tests/model-json.test.ts
git commit -m "perf: incremental streaming finish-output extraction"
```

---

### Task 3: wantsLiveText capability

**Files:**
- Modify: `src/lib/progress-writer.ts`
- Modify: `src/repo-search/engine/progress-reporter.ts` (~line 35)
- Modify: `src/status-server/operation-progress-writers.ts` (`RepoSearchSseProgressWriter`, lines 22-36)
- Modify: `src/status-server/routes/chat.ts` (`RepoSearchToolLogProgressWriter`, lines 303-322)
- Modify: `src/repo-search/approval-verdict-probe.ts` (`ProbeProgressWriter`, lines 120-139)
- Modify: `src/repo-search/execute.ts` (`RepoSearchLifecycleWriter`, lines 142-162)
- Modify: `src/repo-search/engine/task-loop.ts` (callback conditionals, lines 530-545)
- Modify: `src/repo-search/engine/terminal-synthesizer.ts` (lines 75-77 and 88-90)
- Test: create `tests/progress-reporter-live-text.test.ts`

Writers that keep the default `true` (they consume thinking/answer): `ChatStreamProgressWriter` (chat.ts:264, writes them to SSE), `ChatRepoOperationProgressTracker` (chat-repo-operation-runner.ts:83, feeds phase timestamps). `SilentProgressWriter` keeps the default; its `enabled: false` already gates everything.

- [ ] **Step 1: Write the failing tests**

Create `tests/progress-reporter-live-text.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';

import { ProgressWriter, SilentProgressWriter } from '../src/lib/progress-writer.js';
import { ProgressReporter } from '../src/repo-search/engine/progress-reporter.js';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.js';

class StubWriter extends ProgressWriter<RepoSearchProgressEvent> {
  readonly events: RepoSearchProgressEvent[] = [];

  constructor(private readonly liveText: boolean) {
    super();
  }

  get enabled(): boolean {
    return true;
  }

  override get wantsLiveText(): boolean {
    return this.liveText;
  }

  write(event: RepoSearchProgressEvent): void {
    this.events.push(event);
  }
}

function buildReporter(progressWriter: ProgressWriter<RepoSearchProgressEvent>): ProgressReporter {
  return new ProgressReporter({ progressWriter, taskId: 'task', maxTurns: 5, taskStartedAt: Date.now() });
}

test('liveTextEnabled requires both an enabled writer and wantsLiveText', () => {
  assert.equal(buildReporter(new StubWriter(true)).liveTextEnabled, true);
  assert.equal(buildReporter(new StubWriter(false)).liveTextEnabled, false);
});

test('a silent writer disables live text through enabled', () => {
  const reporter = buildReporter(new SilentProgressWriter<RepoSearchProgressEvent>());
  assert.equal(reporter.liveTextEnabled, false);
});

test('ProgressWriter wants live text by default', () => {
  class DefaultWriter extends ProgressWriter<RepoSearchProgressEvent> {
    get enabled(): boolean {
      return true;
    }

    write(_event: RepoSearchProgressEvent): void {}
  }
  assert.equal(new DefaultWriter().wantsLiveText, true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test tests/progress-reporter-live-text.test.ts`
Expected: FAIL — `wantsLiveText` does not exist on `ProgressWriter` (TypeScript error via tsx) and `liveTextEnabled` does not exist on `ProgressReporter`.

- [ ] **Step 3: Implement the capability**

`src/lib/progress-writer.ts` — add to the abstract base:

```typescript
export abstract class ProgressWriter<TEvent> {
  abstract get enabled(): boolean;
  abstract write(event: TEvent): void;

  /**
   * Whether this writer consumes per-token live-text ('thinking'/'answer')
   * events. Producers skip building them when false.
   */
  get wantsLiveText(): boolean {
    return true;
  }
}
```

`src/repo-search/engine/progress-reporter.ts` — add below the `enabled` getter (~line 37):

```typescript
  get liveTextEnabled(): boolean {
    return this.progressWriter.enabled && this.progressWriter.wantsLiveText;
  }
```

`src/status-server/operation-progress-writers.ts` — in `RepoSearchSseProgressWriter`, add below the `enabled` getter:

```typescript
  override get wantsLiveText(): boolean {
    return false;
  }
```

`src/status-server/routes/chat.ts` — same `override get wantsLiveText(): boolean { return false; }` in `RepoSearchToolLogProgressWriter` (below its `enabled` getter, ~line 313).

`src/repo-search/approval-verdict-probe.ts` — same `override get wantsLiveText(): boolean { return false; }` in `ProbeProgressWriter` (below its `enabled` getter, ~line 125).

`src/repo-search/execute.ts` — in `RepoSearchLifecycleWriter` (below its `enabled` getter, ~line 153):

```typescript
  override get wantsLiveText(): boolean {
    return this.target.wantsLiveText;
  }
```

- [ ] **Step 4: Gate the producers**

`src/repo-search/engine/task-loop.ts` (lines 530-545): change the two callback conditionals from `this.progress.enabled` to `this.progress.liveTextEnabled`. The `stream: this.progress.enabled` line stays exactly as it is (stream mode also powers the early-action cutoff and runaway checks):

```typescript
        stream: this.progress.enabled,
        onThinkingDelta: this.progress.liveTextEnabled
          ? (accThinking) => { this.progress.thinking(turn, accThinking); }
          : undefined,
        onContentDelta: this.progress.liveTextEnabled
          ? (accContent) => {
              if (this.streamFinishAsAnswer) {
                const finishOutput = finishOutputExtractor.push(accContent);
                if (finishOutput !== null) {
                  this.progress.answer(turn, finishOutput);
                }
              } else {
                const finishOutput = finishOutputExtractor.push(accContent) ?? accContent;
                this.progress.thinking(turn, finishOutput);
              }
            }
          : undefined,
```

`src/repo-search/engine/terminal-synthesizer.ts`: at lines 75-77, change only the `onContentDelta` condition (the `stream:` line above it stays on `progress.enabled`):

```typescript
          onContentDelta: this.options.streamFinishAsAnswer && this.options.progress.liveTextEnabled
            ? (answerText: string) => { this.options.progress.answer(input.turnsUsed, answerText); }
            : undefined,
```

and at lines 88-90:

```typescript
          if (this.options.streamFinishAsAnswer && this.options.progress.liveTextEnabled) {
            this.options.progress.answer(input.turnsUsed, finalOutput);
          }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx tsx --test tests/progress-reporter-live-text.test.ts tests/mock-repo-search-loop.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/lib/progress-writer.ts src/repo-search/engine/progress-reporter.ts src/status-server/operation-progress-writers.ts src/status-server/routes/chat.ts src/repo-search/approval-verdict-probe.ts src/repo-search/execute.ts src/repo-search/engine/task-loop.ts src/repo-search/engine/terminal-synthesizer.ts tests/progress-reporter-live-text.test.ts
git commit -m "perf: skip live-text progress events when the writer discards them"
```

---

### Task 4: Full verification

**Files:** none modified.

- [ ] **Step 1: Full checks**

```powershell
npm test
npm run typecheck
npm run lint
```

Expected: all green. Report any failures with output; distinguish pre-existing from plan-caused.

- [ ] **Step 2: Live spot-check (optional but recommended)**

Run a small `siftkit repo-search` against this repo and confirm it completes normally (early-action cutoff still fires — server console shows turns ending promptly) and the dashboard chat still streams thinking/answer text.

- [ ] **Step 3: Report**

State result, changed files, validation evidence, and risks.

---

## Self-review notes

- Spec coverage: design §1 → Task 1; §2 → Task 2; §3 → Task 3; testing section → Steps 1-2/5-7 of each task; success criteria → Task 4 plus the deletions in Tasks 1-2.
- Parity risks called out in-task: scanner caches the first object (matches old always-first behavior); extractor's `stalled` models the old permanent break on invalid hex; `stream:` flags intentionally unchanged in both producer files.
- Names consistent across tasks: `FirstJsonObjectScanner.push`, `StreamingFinishOutputExtractor.push`, `wantsLiveText`, `liveTextEnabled`, `finishOutputExtractor`.
- Escape-heavy test literals double-checked: `'{"s":"a\\'` is source text ending in one backslash; `t2 = `${t1}c\\`` appends `c` plus one backslash; the `\u00` + `2F` split decodes to `/`.

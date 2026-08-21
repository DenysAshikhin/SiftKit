# Streaming Transport Decoupling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make streaming the only chat transport, so no provider response can silently bypass runaway detection, the reasoning budget, or a sane deadline — and make any attempt to bypass them fail loudly.

**Architecture:** Bring the streaming path to parity with the non-streaming path first (zod frame validation, transient-error retry), then delete the non-streaming branch and the `stream` option entirely so all six current call sites become compile errors. Replace the single overloaded 120 s timeout with an explicit idle timeout plus a total deadline derived from `maxTokens`, asserted at construction so a budget can never exceed its own deadline.

**Tech Stack:** TypeScript (ESM, NodeNext), zod (`src/lib/zod.js`), `node:test` + `node:assert/strict`, SSE via `src/lib/http-client.ts`.

**Spec:** `docs/superpowers/specs/2026-08-21-streaming-transport-decoupling-design.md`

---

## Ordering constraint (read first)

Tasks 1–5 must land **before** Task 6. Task 6 deletes the non-streaming branch, which is
currently the only path with zod response validation (`llama-cpp-client.ts:303-309`) and
client-level retry (`:315-320`). Deleting it first would create the same class of silent
bypass this plan exists to remove.

`requestJsonFull` stays on `LlamaCppHttpClient` after Task 6 — it is still used by
`countTokens` (`:206`) and `getStatus` (`:249`), which hit `/v1/token/encode` and
`/v1/models`. Only the chat-completions use at `:303` is deleted. This is why Task 9's
regression guard is a test rather than a type change.

## File structure

**New files**
- `src/llm-protocol/stream-deadline.ts` — `MIN_EXPECTED_TOKENS_PER_SECOND`, `computeRequiredGenerationMs`, `assertDeadlineFitsBudget`.
- `src/llm-protocol/stream-errors.ts` — `ProviderStreamDegenerateError`, `ProviderStreamDeadlineError`.
- `tests/helpers/streaming-client.ts` — shared SSE fakes, recording logger, frame builder, and test config. Every new test file imports from here; no test file imports another test file.
- `tests/llm-protocol-stream-integrity.test.ts` — degenerate stream + invalid frame coverage.
- `tests/llm-protocol-stream-deadline.test.ts` — deadline math and enforcement.
- `tests/llm-protocol-no-blocking-chat.test.ts` — regression guard.

**Modified — protocol**
- `src/llm-protocol/llama-cpp-client.ts` — frame counting/validation, degenerate detection, retry on stream, deadline enforcement, delete non-streaming branch, drop `stream` from options.
- `src/llm-protocol/inference-request-builder.ts` — unconditional `stream`/`stream_options`.
- `src/llm-protocol/inference-backend.ts` — drop `stream` from the input type.

**Modified — call sites**
- `src/repo-search/engine/terminal-synthesizer.ts` — drop `stream`.
- `src/repo-search/engine/task-loop.ts` — drop `stream`.
- `src/repo-search/planner-protocol.ts` — drop `stream` (three places).
- `src/providers/llama-cpp.ts` — drop `stream: false`.
- `src/assistant/inference/client.ts` — drop `stream: false`.
- `src/agent-loop/agent-loop.ts` — delete the dead `stream` param and option.

**Modified — tests**
- `tests/llm-protocol.test.ts` — migrate non-streaming chat tests to streaming.

---

### Task 1: Count and validate SSE frames

Malformed frames are currently swallowed by a bare `continue` (`llama-cpp-client.ts:452-457`),
so a server emitting garbage looks identical to a server emitting nothing. Frame counting is
also the prerequisite for Tasks 2 and 3.

**Files:**
- Modify: `src/llm-protocol/llama-cpp-client.ts:160-181` (options type), `:444-457` (frame loop)
- Test: `tests/llm-protocol-stream-integrity.test.ts` (create)

- [ ] **Step 1: Add the logger option**

In `src/llm-protocol/llama-cpp-client.ts`, add this type above `LlamaCppChatOptions`
(around line 158). It is structurally satisfied by `JsonLogger` from
`src/repo-search/types.ts`, so no layering dependency is introduced:

```ts
/**
 * Structural subset of JsonLogger. Declared here so llm-protocol never imports
 * from repo-search; any JsonLogger is assignable.
 */
export type ProviderEventLogger = {
  write: (event: Record<string, JsonSerializable>) => void;
};
```

Add the import at the top of the file, next to the other `src/lib` imports:

```ts
import type { JsonSerializable } from '../lib/json-types.js';
```

Then add this field to `LlamaCppChatOptions` (after `abortSignal?: AbortSignal;` at `:176`):

```ts
  logger?: ProviderEventLogger | null;
```

- [ ] **Step 2: Create the shared test helper**

Create `tests/helpers/streaming-client.ts`. This mirrors the proven config setup in
`tests/llm-protocol-streaming.test.ts:40-60` and is the single home for the SSE fakes used by
Tasks 1, 2, 3, 5, and 9:

```ts
import type { FullJsonResponse, RequestJsonOptions, SseStreamOptions } from '../../src/lib/http-client.js';
import type { JsonSerializable } from '../../src/lib/json-types.js';
import type { SseFrame } from '../../src/lib/sse-frame-parser.js';
import { getDefaultConfigObject } from '../../src/config/defaults.js';
import type { SiftConfig } from '../../src/config/types.js';

export const STREAM_TEST_BASE_URL = 'http://127.0.0.1:8097';

export function buildStreamingTestConfig(): SiftConfig {
  const config = getDefaultConfigObject();
  const preset = config.Server.ModelPresets.Presets[0];
  if (!preset) {
    throw new Error('default config must include a model preset');
  }
  preset.id = 'p1';
  preset.label = 'p1';
  preset.Model = 'local';
  preset.BaseUrl = STREAM_TEST_BASE_URL;
  preset.Reasoning = 'off';
  config.Server.ModelPresets.ActivePresetId = 'p1';
  config.Runtime.LlamaCpp = { ...config.Runtime.LlamaCpp, BaseUrl: STREAM_TEST_BASE_URL };
  return config;
}

/** A single content delta, serialized as the client expects it on the wire. */
export function contentFrame(text: string): string {
  return JSON.stringify({ choices: [{ delta: { content: text } }] });
}

/** Yields raw frame strings verbatim so tests can emit malformed JSON. */
export class RawFrameHttpClient {
  constructor(private readonly frames: string[]) {}

  async requestJsonFull<T>(options: RequestJsonOptions): Promise<FullJsonResponse<T>> {
    throw new Error(`requestJsonFull must not be called for chat completions (${options.url})`);
  }

  async *streamSse(_options: SseStreamOptions): AsyncGenerator<SseFrame> {
    for (const data of this.frames) {
      yield { event: 'message', data };
    }
  }
}

export class RecordingLogger {
  readonly events: Record<string, JsonSerializable>[] = [];

  write(event: Record<string, JsonSerializable>): void {
    this.events.push(event);
  }
}
```

Check the exported name of `requestJsonFull`'s options type in `src/lib/http-client.ts:208`
before writing this — it is `RequestJsonOptions`. Do not introduce a local structural alias.

- [ ] **Step 3: Write the failing test**

Create `tests/llm-protocol-stream-integrity.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { LlamaCppClient } from '../src/llm-protocol/llama-cpp-client.js';
import {
  RawFrameHttpClient,
  RecordingLogger,
  buildStreamingTestConfig,
  contentFrame,
} from './helpers/streaming-client.js';

test('malformed stream frames are logged rather than silently skipped', async () => {
  const logger = new RecordingLogger();
  const client = new LlamaCppClient(new RawFrameHttpClient([
    contentFrame('hello'),
    'not-json-at-all',
    contentFrame(' world'),
    '[DONE]',
  ]));

  const response = await client.chat({
    config: buildStreamingTestConfig(),
    model: 'local',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    maxTokens: 64,
    allowedToolNames: [],
    logger,
  });

  assert.equal(response.text, 'hello world');
  const invalid = logger.events.filter((event) => event.kind === 'provider_stream_frame_invalid');
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0]?.rawFrame, 'not-json-at-all');
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm run build:test && node ./dist/test-runner/run-tests.js llm-protocol-stream-integrity`
Expected: FAIL — no `provider_stream_frame_invalid` events are emitted (`invalid.length` is `0`).

- [ ] **Step 5: Implement frame counting and validation**

In `streamChatAtBaseUrl`, add these declarations next to `let lastRunawayCheckLength = 0;` (`:420`):

```ts
    let frameCount = 0;
    let invalidFrameCount = 0;
    let sawDoneSentinel = false;
```

Replace the frame-parsing block at `:449-457`:

```ts
        if (frame.data === '[DONE]') {
          break;
        }
        let packet: JsonObject;
        try {
          packet = parseJsonObjectText(frame.data);
        } catch {
          continue;
        }
```

with:

```ts
        if (frame.data === '[DONE]') {
          sawDoneSentinel = true;
          break;
        }
        frameCount += 1;
        let packet: JsonObject;
        try {
          packet = parseJsonObjectText(frame.data);
        } catch {
          invalidFrameCount += 1;
          options.logger?.write({
            kind: 'provider_stream_frame_invalid',
            url,
            frameIndex: frameCount,
            rawFrame: frame.data.slice(0, INVALID_FRAME_LOG_CHARS),
          });
          continue;
        }
```

Add this constant next to `RUNAWAY_CHECK_INTERVAL_CHARS` (`:636`):

```ts
/** Cap on how much of a malformed frame is copied into the log event. */
const INVALID_FRAME_LOG_CHARS = 512;
```

Surface the count on the response. In the return object at `:548-569`, add after `stoppedEarly`:

```ts
      invalidFrameCount,
```

Add the matching field to `NormalizedLlamaCppChatResponse`. Find its declaration (it is the
return type of `normalizeChatResponse`, `:572`) and add:

```ts
  /** Frames that failed JSON parsing and were skipped. Always 0 on a healthy stream. */
  invalidFrameCount: number;
```

`normalizeChatResponse` is deleted in Task 6; until then add `invalidFrameCount: 0,` to its
return object so the type stays satisfied.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run build:test && node ./dist/test-runner/run-tests.js llm-protocol-stream-integrity`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/llm-protocol/llama-cpp-client.ts tests/helpers/streaming-client.ts tests/llm-protocol-stream-integrity.test.ts
git commit -m "feat(llm-protocol): log malformed SSE frames instead of skipping them"
```

---

### Task 2: Detect degenerate streams

A server or proxy that buffers instead of streaming produces a "streaming" request that
behaves exactly like a blocking one — the failure mode this whole plan removes. It shows up
as a stream with zero frames, or one that ends without `[DONE]`.

**Files:**
- Create: `src/llm-protocol/stream-errors.ts`
- Modify: `src/llm-protocol/llama-cpp-client.ts:523-527`
- Test: `tests/llm-protocol-stream-integrity.test.ts:end`

- [ ] **Step 1: Write the failing tests**

Append to `tests/llm-protocol-stream-integrity.test.ts`:

```ts
test('a stream that yields no frames throws rather than returning empty text', async () => {
  const logger = new RecordingLogger();
  const client = new LlamaCppClient(new RawFrameHttpClient([]));

  await assert.rejects(
    client.chat({
      config: buildStreamingTestConfig(),
      model: 'local',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 64,
      allowedToolNames: [],
      logger,
    }),
    /stream produced no frames/u,
  );

  const degenerate = logger.events.filter((event) => event.kind === 'provider_stream_degenerate');
  assert.equal(degenerate.length, 1);
  assert.equal(degenerate[0]?.reason, 'no_frames');
});

test('a stream ending without [DONE] throws', async () => {
  const logger = new RecordingLogger();
  const client = new LlamaCppClient(new RawFrameHttpClient([contentFrame('partial')]));

  await assert.rejects(
    client.chat({
      config: buildStreamingTestConfig(),
      model: 'local',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 64,
      allowedToolNames: [],
      logger,
    }),
    /ended without a \[DONE\] sentinel/u,
  );

  const degenerate = logger.events.filter((event) => event.kind === 'provider_stream_degenerate');
  assert.equal(degenerate[0]?.reason, 'missing_done_sentinel');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build:test && node ./dist/test-runner/run-tests.js llm-protocol-stream-integrity`
Expected: FAIL — both calls resolve instead of rejecting.

- [ ] **Step 3: Create the error types**

Create `src/llm-protocol/stream-errors.ts`:

```ts
export type ProviderStreamDegenerateReason = 'no_frames' | 'missing_done_sentinel';

/**
 * A streaming chat request completed without behaving like a stream. Usually a
 * proxy or server that buffered the whole response, which silently disables the
 * runaway detector, the reasoning budget, and idle-timeout semantics.
 */
export class ProviderStreamDegenerateError extends Error {
  constructor(
    readonly url: string,
    readonly reason: ProviderStreamDegenerateReason,
    readonly frameCount: number,
  ) {
    super(
      reason === 'no_frames'
        ? `Chat stream produced no frames (url=${url}). The endpoint is not streaming; `
          + 'runaway detection and reasoning-budget guards cannot run.'
        : `Chat stream ended without a [DONE] sentinel after ${frameCount} frame(s) (url=${url}). `
          + 'The response may be truncated.',
    );
    this.name = 'ProviderStreamDegenerateError';
  }
}
```

- [ ] **Step 4: Enforce it in the client**

In `src/llm-protocol/llama-cpp-client.ts`, add the import:

```ts
import { ProviderStreamDegenerateError, type ProviderStreamDegenerateReason } from './stream-errors.js';
```

In `streamChatAtBaseUrl`, replace the post-loop block at `:523-526`:

```ts
      if (!earlyStopReason) {
        detectRunaway();
      }
```

with:

```ts
      if (!earlyStopReason) {
        detectRunaway();
      }
      // An early stop breaks out before [DONE], so only a stream that ran to
      // completion is required to have produced one.
      const degenerateReason: ProviderStreamDegenerateReason | null = frameCount === 0
        ? 'no_frames'
        : (!sawDoneSentinel && earlyStopReason === null ? 'missing_done_sentinel' : null);
      if (degenerateReason !== null) {
        options.logger?.write({
          kind: 'provider_stream_degenerate',
          url,
          reason: degenerateReason,
          frameCount,
          invalidFrameCount,
        });
        throw new ProviderStreamDegenerateError(url, degenerateReason, frameCount);
      }
```

This sits inside the existing `try` block. `ProviderStreamDegenerateError` is not an
`HttpResponseError`, so the existing catch at `:527-535` rethrows it unchanged.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run build:test && node ./dist/test-runner/run-tests.js llm-protocol-stream-integrity`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/llm-protocol/stream-errors.ts src/llm-protocol/llama-cpp-client.ts tests/llm-protocol-stream-integrity.test.ts
git commit -m "feat(llm-protocol): fail loudly when a chat stream does not actually stream"
```

---

### Task 3: Transient-error retry on the streaming path

`retryProviderRequest` exists only in the non-streaming branch (`:315-320`). Task 6 deletes
that branch, so the retry must move first or every caller silently loses it. Retry may only
fire before the first frame reaches the caller, otherwise a replay would duplicate deltas
already delivered through `onContentDelta`.

**Files:**
- Modify: `src/llm-protocol/llama-cpp-client.ts:294-300` (wrapper), `:527-535` (catch)
- Test: `tests/llm-protocol-stream-integrity.test.ts:end`

- [ ] **Step 1: Write the failing test**

Append to `tests/llm-protocol-stream-integrity.test.ts`:

```ts
/** Fails the first N attempts with a transient 503, then streams normally. */
class FlakyStreamHttpClient {
  attempts = 0;
  constructor(private readonly failures: number) {}

  async requestJsonFull<T>(): Promise<FullJsonResponse<T>> {
    throw new Error('requestJsonFull must not be called for chat completions');
  }

  async *streamSse(_options: SseStreamOptions): AsyncGenerator<SseFrame> {
    this.attempts += 1;
    if (this.attempts <= this.failures) {
      throw new HttpResponseError(503, 'LOADING MODEL');
    }
    yield { event: 'message', data: contentFrame('recovered') };
    yield { event: 'message', data: '[DONE]' };
  }
}

test('a transient failure before the first frame is retried', async () => {
  const http = new FlakyStreamHttpClient(1);
  const client = new LlamaCppClient(http);

  const response = await client.chat({
    config: buildStreamingTestConfig(),
    model: 'local',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    maxTokens: 64,
    allowedToolNames: [],
    retryMaxWaitMs: 5_000,
  });

  assert.equal(response.text, 'recovered');
  assert.equal(http.attempts, 2);
});
```

Add `HttpResponseError` to the existing `src/lib/http-client.js` import at the top of the file:

```ts
import { HttpResponseError, type FullJsonResponse, type SseStreamOptions } from '../src/lib/http-client.js';
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build:test && node ./dist/test-runner/run-tests.js llm-protocol-stream-integrity`
Expected: FAIL — the 503 propagates on the first attempt; `http.attempts` is `1`.

- [ ] **Step 3: Gate transient classification on zero frames**

In `streamChatAtBaseUrl`, change the catch at `:527-535` so an error is only classified as
transient when nothing was delivered:

```ts
    } catch (error) {
      // Once a frame has been delivered the caller may already have seen deltas,
      // so a replay would duplicate them. Only a pre-first-frame failure is retryable.
      if (frameCount === 0
        && error instanceof HttpResponseError
        && isTransientProviderHttpResponse(error.statusCode, error.rawText)) {
        throw buildTransientProviderHttpError(error.statusCode, error.rawText);
      }
      if (error instanceof HttpResponseError) {
        throw new LlamaHttpError(error.statusCode, error.rawText);
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
```

- [ ] **Step 4: Wrap the stream attempt in the retry helper**

Replace `chatAtBaseUrl` (`:294-325`) — keeping the non-streaming branch for now, since Task 6
deletes it:

```ts
  private async chatAtBaseUrl(baseUrl: string, options: LlamaCppChatOptions): Promise<NormalizedLlamaCppChatResponse> {
    if (options.stream) {
      const attempt = async (): Promise<NormalizedLlamaCppChatResponse> => {
        const streamed = await this.streamChatAtBaseUrl(baseUrl, options);
        if (streamed.earlyStopReason !== THINKING_BUDGET_EARLY_STOP_REASON) {
          return streamed;
        }
        return this.continueAfterThinkingBudget(baseUrl, options, streamed);
      };
      return options.retryMaxWaitMs === 0
        ? attempt()
        : retryProviderRequest(
          attempt,
          options.retryMaxWaitMs ? { maxWaitMs: options.retryMaxWaitMs } : undefined,
        );
    }
```

Leave the rest of the method (the non-streaming `requestOnce` block, `:301-324`) unchanged.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run build:test && node ./dist/test-runner/run-tests.js llm-protocol-stream-integrity`
Expected: PASS

- [ ] **Step 6: Run the existing streaming suite for regressions**

Run: `node ./dist/test-runner/run-tests.js llm-protocol-streaming`
Expected: PASS — all existing tests, including the runaway-detection tests at
`tests/llm-protocol-streaming.test.ts:258` and `:286`.

- [ ] **Step 7: Commit**

```bash
git add src/llm-protocol/llama-cpp-client.ts tests/llm-protocol-stream-integrity.test.ts
git commit -m "feat(llm-protocol): retry transient stream failures before the first frame"
```

---

### Task 4: Deadline math that cannot contradict the budget

The failure came from a 15 000-token budget and a 120 000 ms deadline coexisting. Make that
combination throw where it is constructed instead of timing out 120 s later.

**Files:**
- Create: `src/llm-protocol/stream-deadline.ts`
- Test: `tests/llm-protocol-stream-deadline.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/llm-protocol-stream-deadline.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_EXPECTED_TOKENS_PER_SECOND,
  assertDeadlineFitsBudget,
  computeRequiredGenerationMs,
} from '../src/llm-protocol/stream-deadline.js';

test('required generation time is derived from the throughput floor', () => {
  assert.equal(MIN_EXPECTED_TOKENS_PER_SECOND, 20);
  assert.equal(computeRequiredGenerationMs(15_000), 750_000);
  assert.equal(computeRequiredGenerationMs(200), 10_000);
});

test('the historical 15k-tokens-in-120s combination is rejected', () => {
  assert.throws(
    () => { assertDeadlineFitsBudget({ maxTokens: 15_000, totalDeadlineMs: 120_000 }); },
    /cannot fit a 15000-token budget/u,
  );
});

test('a deadline that fits the budget is accepted', () => {
  assertDeadlineFitsBudget({ maxTokens: 15_000, totalDeadlineMs: 750_000 });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build:test && node ./dist/test-runner/run-tests.js llm-protocol-stream-deadline`
Expected: FAIL — `Cannot find module '../src/llm-protocol/stream-deadline.js'`.

- [ ] **Step 3: Create the module**

Create `src/llm-protocol/stream-deadline.ts`:

```ts
/**
 * Throughput floor used to convert an output-token budget into a wall-clock
 * requirement. Deliberately far below observed rates (72-106 tok/s for
 * 3.8_27b_4.6bpw on exl3) so the derived deadline is generous but bounded.
 */
export const MIN_EXPECTED_TOKENS_PER_SECOND = 20;

/** The minimum wall-clock time a maxTokens budget could legitimately need. */
export function computeRequiredGenerationMs(maxTokens: number): number {
  return Math.ceil((Math.max(1, maxTokens) / MIN_EXPECTED_TOKENS_PER_SECOND) * 1000);
}

/**
 * Rejects a deadline shorter than its own token budget. Without this, a request
 * can be granted an output budget it has no time to emit -- the defect behind
 * repo-search run 82616c85 (15000 tokens, 120000 ms).
 */
export function assertDeadlineFitsBudget(input: { maxTokens: number; totalDeadlineMs: number }): void {
  const requiredMs = computeRequiredGenerationMs(input.maxTokens);
  if (input.totalDeadlineMs < requiredMs) {
    throw new Error(
      `Total deadline ${input.totalDeadlineMs} ms cannot fit a ${input.maxTokens}-token budget: `
      + `at ${MIN_EXPECTED_TOKENS_PER_SECOND} tok/s it needs at least ${requiredMs} ms. `
      + 'Raise totalDeadlineMs or lower maxTokens.',
    );
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build:test && node ./dist/test-runner/run-tests.js llm-protocol-stream-deadline`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/llm-protocol/stream-deadline.ts tests/llm-protocol-stream-deadline.test.ts
git commit -m "feat(llm-protocol): derive a total deadline from the output budget"
```

---

### Task 5: Name the idle timeout and enforce the total deadline

`requestTimeoutSeconds` currently means "idle gap" when streaming and "total wall clock"
when not. After Task 6 only the streaming meaning survives, so rename it to say so, and add
the total deadline as a separate, explicit bound.

**Files:**
- Modify: `src/llm-protocol/llama-cpp-client.ts:174` (option), `:443-447` (idle timeout), `:444` (loop)
- Modify: `src/repo-search/planner-protocol.ts:654`
- Test: `tests/llm-protocol-stream-deadline.test.ts:end`

- [ ] **Step 1: Write the failing test**

Append to `tests/llm-protocol-stream-deadline.test.ts`:

```ts
import type { FullJsonResponse, RequestJsonOptions, SseStreamOptions } from '../src/lib/http-client.js';
import type { SseFrame } from '../src/lib/sse-frame-parser.js';
import { LlamaCppClient } from '../src/llm-protocol/llama-cpp-client.js';
import { buildStreamingTestConfig, contentFrame } from './helpers/streaming-client.js';

/** Emits frames forever, one per tick, so only a deadline can stop it. */
class EndlessStreamHttpClient {
  async requestJsonFull<T>(options: RequestJsonOptions): Promise<FullJsonResponse<T>> {
    throw new Error(`requestJsonFull must not be called for chat completions (${options.url})`);
  }

  async *streamSse(_options: SseStreamOptions): AsyncGenerator<SseFrame> {
    for (;;) {
      await new Promise((resolve) => { setTimeout(resolve, 1); });
      yield { event: 'message', data: contentFrame('x') };
    }
  }
}

test('a stream exceeding its total deadline is aborted', async () => {
  const client = new LlamaCppClient(new EndlessStreamHttpClient());

  await assert.rejects(
    client.chat({
      config: buildStreamingTestConfig(),
      model: 'local',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 64,
      allowedToolNames: [],
      totalDeadlineMs: 50,
    }),
    /total deadline/u,
  );
});

test('a maxTokens budget larger than the deadline is rejected up front', async () => {
  const client = new LlamaCppClient(new EndlessStreamHttpClient());

  await assert.rejects(
    client.chat({
      config: buildStreamingTestConfig(),
      model: 'local',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 15_000,
      allowedToolNames: [],
      totalDeadlineMs: 120_000,
    }),
    /cannot fit a 15000-token budget/u,
  );
});
```

Both fakes and the config builder come from `tests/helpers/streaming-client.ts`, created in
Task 1 Step 2. No test file imports another test file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build:test && node ./dist/test-runner/run-tests.js llm-protocol-stream-deadline`
Expected: FAIL — the first hangs until the test runner's own timeout; the second resolves.

- [ ] **Step 3: Add the deadline error**

Append to `src/llm-protocol/stream-errors.ts`:

```ts
/** A streaming chat request ran past its total wall-clock budget. */
export class ProviderStreamDeadlineError extends Error {
  constructor(readonly url: string, readonly totalDeadlineMs: number, readonly maxTokens: number) {
    super(
      `Chat stream exceeded its total deadline of ${totalDeadlineMs} ms `
      + `(maxTokens=${maxTokens}, url=${url}).`,
    );
    this.name = 'ProviderStreamDeadlineError';
  }
}
```

- [ ] **Step 4: Rename the option and add the deadline**

In `src/llm-protocol/llama-cpp-client.ts`, in `LlamaCppChatOptions` replace:

```ts
  requestTimeoutSeconds?: number;
```

with:

```ts
  /** Maximum gap between SSE frames. Not a total duration; see totalDeadlineMs. */
  idleTimeoutSeconds?: number;
  /** Total wall-clock ceiling. Defaults to what maxTokens needs at the throughput floor. */
  totalDeadlineMs?: number;
```

Add the imports:

```ts
import { assertDeadlineFitsBudget, computeRequiredGenerationMs } from './stream-deadline.js';
import { ProviderStreamDeadlineError } from './stream-errors.js';
```

In `streamChatAtBaseUrl`, immediately after `const startedAt = Date.now();` (`:402`):

```ts
    const totalDeadlineMs = options.totalDeadlineMs ?? computeRequiredGenerationMs(options.maxTokens);
    assertDeadlineFitsBudget({ maxTokens: options.maxTokens, totalDeadlineMs });
```

Update the `streamSse` call at `:443-447`:

```ts
        idleTimeoutMs: Math.max(1, options.idleTimeoutSeconds ?? 300) * 1000,
```

Add the deadline check as the first statement inside the frame loop, immediately after
`for await (const frame of ...) {`:

```ts
        if (Date.now() - startedAt > totalDeadlineMs) {
          throw new ProviderStreamDeadlineError(url, totalDeadlineMs, options.maxTokens);
        }
```

`ProviderStreamDeadlineError` is not an `HttpResponseError`, so the catch at `:527-535`
rethrows it unchanged.

- [ ] **Step 5: Update the one remaining producer of the old name**

In `src/repo-search/planner-protocol.ts:654`, replace:

```ts
    requestTimeoutSeconds: options.timeoutMs / 1000,
```

with:

```ts
    idleTimeoutSeconds: options.timeoutMs / 1000,
```

Then run `npm run typecheck` and fix every remaining `requestTimeoutSeconds` the compiler
reports. Expected sites: `src/providers/llama-cpp.ts`, `src/assistant/inference/client.ts`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run build:test && node ./dist/test-runner/run-tests.js llm-protocol-stream-deadline`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/llm-protocol/ src/repo-search/planner-protocol.ts tests/llm-protocol-stream-deadline.test.ts
git commit -m "feat(llm-protocol): separate idle timeout from total deadline"
```

---

### Task 6: Delete the non-streaming branch

With parity in place, remove the transport choice entirely. Every remaining `stream:` becomes
a compile error, which is the loud failure the design asks for.

**Files:**
- Modify: `src/llm-protocol/llama-cpp-client.ts:169` (option), `:294-325` (branch), `:366-395` (builder), `:572-605` (normalize)
- Modify: `src/llm-protocol/inference-request-builder.ts:44-47`
- Modify: `src/llm-protocol/inference-backend.ts:27`

- [ ] **Step 1: Delete `stream` from the options type**

In `LlamaCppChatOptions` (`:169`), delete the line:

```ts
  stream: boolean;
```

- [ ] **Step 2: Collapse `chatAtBaseUrl`**

Replace the whole method with:

```ts
  private async chatAtBaseUrl(baseUrl: string, options: LlamaCppChatOptions): Promise<NormalizedLlamaCppChatResponse> {
    const attempt = async (): Promise<NormalizedLlamaCppChatResponse> => {
      const streamed = await this.streamChatAtBaseUrl(baseUrl, options);
      if (streamed.earlyStopReason !== THINKING_BUDGET_EARLY_STOP_REASON) {
        return streamed;
      }
      return this.continueAfterThinkingBudget(baseUrl, options, streamed);
    };
    return options.retryMaxWaitMs === 0
      ? attempt()
      : retryProviderRequest(
        attempt,
        options.retryMaxWaitMs ? { maxWaitMs: options.retryMaxWaitMs } : undefined,
      );
  }
```

- [ ] **Step 3: Delete `normalizeChatResponse` and its now-dead imports**

Delete the entire `normalizeChatResponse` method (`:572-605`). It had no caller other than
the deleted branch. Then delete any import left unused — expect `RawChatResponseSchema` and
`FullJsonResponse`. Keep `requestJsonFull` on the `LlamaCppHttpClient` `Pick` at `:36`:
`countTokens` (`:206`) and `getStatus` (`:249`) still use it.

- [ ] **Step 4: Make streaming unconditional on the wire**

In `src/llm-protocol/llama-cpp-client.ts`, in `buildChatRequest` (`:380`), delete:

```ts
        stream: options.stream,
```

In `src/llm-protocol/inference-request-builder.ts`, replace `:45-47`:

```ts
      ...sampling,
      stream: input.stream,
      ...(input.stream ? { stream_options: { include_usage: true } } : {}),
```

with:

```ts
      ...sampling,
      stream: true,
      stream_options: { include_usage: true },
```

In `src/llm-protocol/inference-backend.ts:27`, delete `stream: boolean;` from the request
**input** type. Leave `:49-50` alone — that is the wire shape and still carries both fields.

- [ ] **Step 5: Run typecheck to enumerate the call sites**

Run: `npm run typecheck`
Expected: FAIL, with errors at each of the six call sites listed in Task 7. Record the list;
Task 7 fixes them.

- [ ] **Step 6: Commit after Task 7**

The tree does not compile between Steps 5 and Task 7. Do not commit here; commit once at
the end of Task 7.

---

### Task 7: Migrate the six call sites

**Files:**
- Modify: `src/repo-search/engine/terminal-synthesizer.ts:74`
- Modify: `src/repo-search/engine/task-loop.ts:610`
- Modify: `src/repo-search/planner-protocol.ts:650`, `:882`, `:449`
- Modify: `src/providers/llama-cpp.ts:483`
- Modify: `src/assistant/inference/client.ts:96`

- [ ] **Step 1: Terminal synthesis — the original bug**

In `src/repo-search/engine/terminal-synthesizer.ts`, delete line `:74`:

```ts
          stream: this.options.streamFinishAsAnswer && this.options.progress.enabled,
```

Leave `:75` (`onContentDelta`) exactly as it is. That is `streamFinishAsAnswer` doing its one
legitimate job: deciding whether streamed output renders as an answer.

- [ ] **Step 2: Planner turn**

In `src/repo-search/engine/task-loop.ts`, delete line `:610`:

```ts
        stream: this.progress.enabled,
```

- [ ] **Step 3: Planner protocol**

In `src/repo-search/planner-protocol.ts`, delete `:650`:

```ts
      stream: options.stream === true,
```

and `:882`:

```ts
    stream: options.stream,
```

Delete the now-unused `stream?: boolean;` from the `requestTerminalSynthesis` options type
(`:863`).

At `:449`, `buildPlannerRequestPromptReserveText` renders the request shape for token
estimation. Since the wire request now always carries `stream`, replace:

```ts
    ...(options.stream ? { stream: true } : {}),
```

with:

```ts
    stream: true,
```

and delete `stream` from that function's options type if it becomes unused.

- [ ] **Step 4: Summary provider**

In `src/providers/llama-cpp.ts`, delete line `:483`:

```ts
    stream: false,
```

- [ ] **Step 5: Assistant inference**

In `src/assistant/inference/client.ts`, delete line `:96`:

```ts
      stream: false,
```

- [ ] **Step 6: Typecheck until clean**

Run: `npm run typecheck`
Expected: PASS. Any further error is a call site this plan did not enumerate — fix it the same
way (delete the `stream` key) and note it in the commit body.

- [ ] **Step 7: Run the full suite**

Run: `npm run build:test && npm test 2>&1 | siftkit summary --question "Return pass/fail, failing test names, root errors, and relevant file:line anchors."`
Expected: PASS. Failures here are most likely in `tests/llm-protocol.test.ts`, which Task 10
migrates — record them and continue.

- [ ] **Step 8: Commit**

```bash
git add src/llm-protocol/ src/repo-search/ src/providers/llama-cpp.ts src/assistant/inference/client.ts
git commit -m "refactor: make streaming the only chat transport"
```

---

### Task 8: Delete the dead AgentLoop stream parameter

`AgentLoopModelClient.chat` takes `stream: boolean`, `AgentLoop` always passes `false`
(`agent-loop.ts:56`, since both constructions omit `AgentLoopOptions.stream`), and the only
implementation never reads it (`agent-loop-adapter.ts:86`). It is a third copy of the same
coupling, and it is pure noise.

**Files:**
- Modify: `src/agent-loop/agent-loop.ts:13-21`, `:26`, `:56`

- [ ] **Step 1: Delete the parameter from the interface**

In `src/agent-loop/agent-loop.ts`, remove `stream: boolean;` from `AgentLoopModelClient.chat`
(`:19`), so the interface reads:

```ts
export interface AgentLoopModelClient {
  chat(options: {
    turnNumber: number;
    preparedTurn: AgentLoopPreparedTurn;
    messages: LlamaCppChatMessage[];
    tools: LlamaCppToolDefinition[];
    allowedToolNames: string[];
  }): Promise<AgentLoopModelResponse>;
}
```

- [ ] **Step 2: Delete the option and the argument**

Remove `stream?: boolean;` from `AgentLoopOptions` (`:26`), and delete this line from the
`chat` call (`:56`):

```ts
        stream: this.options.stream === true,
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS. `agent-loop-adapter.ts:86` types its parameter as
`Parameters<AgentLoopModelClient['chat']>[0]`, so it follows automatically.

- [ ] **Step 4: Run the agent-loop tests**

Run: `node ./dist/test-runner/run-tests.js agent-loop`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent-loop/agent-loop.ts
git commit -m "refactor(agent-loop): delete the unread stream parameter"
```

---

### Task 9: Regression guard against a blocking chat request

`requestJsonFull` must remain available for `/v1/token/encode` and `/v1/models`, so the type
system cannot prevent someone reintroducing a blocking chat call. A test can.

**Files:**
- Create: `tests/llm-protocol-no-blocking-chat.test.ts`

- [ ] **Step 1: Write the test**

Create `tests/llm-protocol-no-blocking-chat.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import type { FullJsonResponse, RequestJsonOptions, SseStreamOptions } from '../src/lib/http-client.js';
import type { SseFrame } from '../src/lib/sse-frame-parser.js';
import { LlamaCppClient } from '../src/llm-protocol/llama-cpp-client.js';
import { buildStreamingTestConfig, contentFrame } from './helpers/streaming-client.js';

/** Rejects any blocking request aimed at chat completions. */
class ChatBlockingDetector {
  async requestJsonFull<T>(options: RequestJsonOptions): Promise<FullJsonResponse<T>> {
    if (options.url.includes('/v1/chat/completions')) {
      throw new Error(
        `Blocking chat request detected at ${options.url}. Chat must stream: a blocking `
        + 'request bypasses runaway detection, the reasoning budget, and idle-timeout semantics.',
      );
    }
    throw new Error(`unexpected requestJsonFull to ${options.url}`);
  }

  async *streamSse(_options: SseStreamOptions): AsyncGenerator<SseFrame> {
    yield { event: 'message', data: JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }) };
    yield { event: 'message', data: '[DONE]' };
  }
}

test('chat never issues a blocking request to /v1/chat/completions', async () => {
  const client = new LlamaCppClient(new ChatBlockingDetector());

  const response = await client.chat({
    config: buildStreamingTestConfig(),
    model: 'local',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    maxTokens: 64,
    allowedToolNames: [],
  });

  assert.equal(response.text, 'ok');
});
```

- [ ] **Step 2: Run the test**

Run: `npm run build:test && node ./dist/test-runner/run-tests.js llm-protocol-no-blocking-chat`
Expected: PASS

- [ ] **Step 3: Verify the guard actually guards**

Temporarily re-add a blocking call by changing `chatAtBaseUrl` to call
`this.client.requestJsonFull` before `attempt()`. Re-run the test.
Expected: FAIL with "Blocking chat request detected". Revert the temporary change and re-run.
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/llm-protocol-no-blocking-chat.test.ts
git commit -m "test(llm-protocol): guard against reintroducing a blocking chat request"
```

---

### Task 10: Migrate the non-streaming chat tests

`tests/llm-protocol.test.ts:122-147` asserts the deleted behaviour: `CapturingHttpClient`
throws from `streamSse` with "should not be called by non-streaming tests". Those tests must
invert, not be deleted — they cover tool-call parsing, usage normalization, and HTTP error
mapping that still matter.

**Files:**
- Modify: `tests/llm-protocol.test.ts:122-168`

- [ ] **Step 1: Invert the fake**

In `tests/llm-protocol.test.ts`, replace `CapturingHttpClient`'s two methods so
`requestJsonFull` is the forbidden call for chat and `streamSse` serves the queued responses.
Each previously-queued `RawChatResponse` becomes a frame sequence:

```ts
class CapturingHttpClient {
  readonly requests: SseStreamOptions[] = [];
  private readonly frameSets: string[][];

  constructor(frameSets: string[][]) {
    this.frameSets = frameSets;
  }

  async requestJsonFull<T>(options: RequestJsonOptions): Promise<FullJsonResponse<T>> {
    if (options.url.includes('/v1/chat/completions')) {
      throw new Error('chat must not use requestJsonFull');
    }
    throw new Error(`unexpected requestJsonFull to ${options.url}`);
  }

  async *streamSse(options: SseStreamOptions): AsyncGenerator<SseFrame> {
    this.requests.push(options);
    const frames = this.frameSets.shift();
    if (!frames) throw new Error('no queued frame set');
    for (const data of frames) {
      yield { event: 'message', data };
    }
    yield { event: 'message', data: '[DONE]' };
  }
}
```

- [ ] **Step 2: Convert each queued response to frames**

For every test that queued a body like
`{ choices: [{ message: { content: 'x', tool_calls: [...] } }] }`, queue instead:

```ts
[JSON.stringify({ choices: [{ delta: { content: 'x' } }] })]
```

For tool calls, use the streamed delta shape the client accumulates at `:499-511`:

```ts
[JSON.stringify({
  choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'grep', arguments: '{"pattern":"x"}' } }] } }],
})]
```

- [ ] **Step 3: Delete tests that only covered the deleted branch**

`StringThrowingHttpClient` (`:149-153`) and the retry-counting client (`:162-168`) exercised
non-streaming retry. Task 3 covers streaming retry in
`tests/llm-protocol-stream-integrity.test.ts`. Delete these two fakes and the tests that use
them only if every assertion they made is already covered there; otherwise port the missing
assertion across first.

- [ ] **Step 4: Run the file**

Run: `npm run build:test && node ./dist/test-runner/run-tests.js llm-protocol`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/llm-protocol.test.ts
git commit -m "test(llm-protocol): migrate blocking chat tests to streaming"
```

---

### Task 11: Verify the newly-streaming callers end to end

Four callers changed transport in Task 7. Each has existing coverage that must still pass,
and two carry the usage-accounting risk named in the spec.

**Files:**
- Verify only. Fix forward if a test fails.

- [ ] **Step 1: Structured output over SSE**

Run: `node ./dist/test-runner/run-tests.js engine-transcript-compactor`
Expected: PASS. This is the highest-risk migration: `providers/llama-cpp.ts` uses response
schemas, so reassembled frames must produce the same JSON the blocking body did. A failure
here means frame reassembly is lossy — fix reassembly, do not relax the test.

- [ ] **Step 2: Approval verdict**

Run: `node ./dist/test-runner/run-tests.js approval-verdict-request`
Then: `node ./dist/test-runner/run-tests.js auto-approval-verdict-probe`
Expected: PASS

- [ ] **Step 3: Reasoning budget and runaway detection now apply everywhere**

Run: `node ./dist/test-runner/run-tests.js llama-cpp-client-thinking-budget`
Then: `node ./dist/test-runner/run-tests.js mock-repo-search-loop`
Expected: PASS. These guards previously did not run for the migrated callers; they do now.

- [ ] **Step 4: Verify usage accounting survived**

Streamed usage is summed per frame via `stream_options.include_usage` (`:458-470`) rather
than read from a single body. Confirm the assistant and summary paths still record tokens:

Run: `node ./dist/test-runner/run-tests.js assistant`
Expected: PASS. If a token count is now `null` where it was a number, the frame-level usage
extraction is missing a field the blocking body carried — add it to the per-frame extraction
rather than defaulting it.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: reconcile streamed usage accounting for migrated callers"
```

---

### Task 12: Full validation

- [ ] **Step 1: Typecheck and lint**

Run: `npm run typecheck`
Expected: PASS (this script also runs `npm run lint`).

- [ ] **Step 2: Full suite**

Run: `npm run build:test && npm test 2>&1 | siftkit summary --question "Return pass/fail, failing test names, root errors, and relevant file:line anchors."`
Expected: PASS

- [ ] **Step 3: Confirm no `stream:` transport flags remain**

Run: `grep -rn "stream: options.stream\|stream: false\|streamFinishAsAnswer &&" src/`
Expected: no matches.

Run: `grep -rn "requestTimeoutSeconds" src/`
Expected: no matches.

- [ ] **Step 4: Confirm the original failure cannot recur**

Run: `node ./dist/test-runner/run-tests.js llm-protocol-stream-deadline`
Expected: PASS, including "the historical 15k-tokens-in-120s combination is rejected".

- [ ] **Step 5: Live smoke test**

With a model server running, issue a repo-search whose prompt is broad enough to exhaust the
turn budget, and confirm terminal synthesis now streams:

Run: `siftkit repo-search "Describe every module under src/ and its responsibilities, with file:line anchors for each."`

Then check the engine log for the synthesis request:

```bash
sqlite3 .siftkit/runtime.sqlite "SELECT chunk_text FROM inference_run_log_chunks WHERE stream_kind='engine_stdout' ORDER BY sequence DESC LIMIT 1;" | grep -c "Received chat completion request "
```

Expected: `0` — every request logs "Received chat completion **streaming** request". A
non-zero count means a blocking chat request survived.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat: decouple provider transport from presentation"
```

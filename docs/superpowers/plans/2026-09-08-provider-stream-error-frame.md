# Provider Stream Error Frame Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a provider terminates an SSE stream with an OpenAI-style `{"error": ...}` frame, surface the server's own message as a typed error instead of discarding the frame and reporting a generic "stream ended without a [DONE] sentinel".

**Architecture:** A new pure parser module reads the error frame off an already-parsed packet. Two new error classes in the existing `stream-errors.ts` carry the server's text, split by whether the failure was the server's fault (`ProviderStreamErrorFrameError`) or ours (`ProviderContextLengthError`, meaning our prompt-budget math sent an over-length prompt). The chat frame loop in `inference-client.ts` checks each packet and throws before the packet can be misread as a usage or delta frame.

**Tech Stack:** TypeScript (ESM, NodeNext), zod 4.4.3 for IO validation, `node:test` + `node:assert/strict`, custom test runner at `dist/test-runner/run-tests.js`.

---

## Background: why this is needed

On 2026-09-08 a repo-search run died on turn 22 of 45 with:

```
provider request failed stage=planner_action ... error=Chat stream ended without a
[DONE] sentinel after 1 frame(s). The response may be truncated.
```

The actual cause was a CUDA OOM inside the model server. TabbyAPI handled it correctly: [`endpoints/OAI/utils/chat_completion.py:913-917`](file:///C:/Users/denys/Documents/GitHub/TabbyAPI/endpoints/OAI/utils/chat_completion.py) yields a single well-formed error frame and then returns without `[DONE]`. That frame — the "1 frame(s)" in the message — is parsed successfully by our client, found to have no `choices`, and silently dropped. The stream then trips the missing-sentinel check and reports a generic truncation error.

The two payload shapes TabbyAPI emits:

```json
{"error": {"message": "Chat completion aborted. Please check the server console.", "trace": null}}
{"error": {"message": "...", "type": "invalid_request_error", "param": null, "code": "context_length_exceeded"}}
```

**Explicitly out of scope** (decided during design, do not add):
- No retry-behaviour change. An error frame arrives with `frameCount >= 1`, so the existing pre-first-frame retry gate at `inference-client.ts:487-497` stays closed and a mid-run failure still ends the run. It will simply say why.
- No `TABBY_NETWORK_SEND_TRACEBACKS` change. The generic message stays "Chat completion aborted. Please check the server console."; the underlying exception text remains only in `inference_run_log_chunks`.

## File Structure

| File | Responsibility |
|---|---|
| `src/llm-protocol/stream-error-frame.ts` (create) | Recognise and validate a fatal error frame. Pure, no I/O, no throwing. |
| `src/llm-protocol/stream-errors.ts` (modify) | Owns the provider-stream failure vocabulary. Gains two error classes and the frame→error dispatch. |
| `src/llm-protocol/inference-client.ts` (modify) | Calls the parser inside the frame loop, logs, and throws. ~10 lines. |
| `tests/llm-protocol-stream-error-frame.test.ts` (create) | Unit coverage for the parser and the dispatch. |
| `tests/llm-protocol-stream-integrity.test.ts` (modify) | End-to-end coverage through `InferenceClient.chat`. |
| `tests/helpers/streaming-client.ts` (modify) | Gains an `errorFrame()` builder next to the existing `contentFrame()`. |

The parser is a separate module from `stream-errors.ts` deliberately: `stream-errors.ts` is a small file of pure error vocabulary, and a zod schema for wire payloads is a different responsibility.

---

### Task 1: Error-frame parser

**Files:**
- Create: `src/llm-protocol/stream-error-frame.ts`
- Test: `tests/llm-protocol-stream-error-frame.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/llm-protocol-stream-error-frame.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { readStreamErrorFrame } from '../src/llm-protocol/stream-error-frame.js';

test('reads an object error frame carrying a message and a code', () => {
  assert.deepEqual(
    readStreamErrorFrame({
      error: {
        message: 'Request length 210000 exceeds the context window',
        type: 'invalid_request_error',
        param: null,
        code: 'context_length_exceeded',
      },
    }),
    { message: 'Request length 210000 exceeds the context window', code: 'context_length_exceeded' },
  );
});

test('reads a TabbyAPI abort frame that has no code', () => {
  assert.deepEqual(
    readStreamErrorFrame({
      error: { message: 'Chat completion aborted. Please check the server console.', trace: null },
    }),
    { message: 'Chat completion aborted. Please check the server console.', code: null },
  );
});

test('reads a bare string error frame', () => {
  assert.deepEqual(
    readStreamErrorFrame({ error: 'upstream connection reset' }),
    { message: 'upstream connection reset', code: null },
  );
});

test('falls back to a placeholder when the frame carries no usable message', () => {
  assert.deepEqual(
    readStreamErrorFrame({ error: {} }),
    { message: 'provider reported an unspecified stream error', code: null },
  );
  assert.deepEqual(
    readStreamErrorFrame({ error: '   ' }),
    { message: 'provider reported an unspecified stream error', code: null },
  );
});

test('returns null for ordinary delta frames', () => {
  assert.equal(readStreamErrorFrame({ choices: [{ delta: { content: 'hello' } }] }), null);
  assert.equal(readStreamErrorFrame({ choices: [{ delta: {}, finish_reason: 'stop' }] }), null);
});

test('returns null when the error key is absent or not a string or object', () => {
  assert.equal(readStreamErrorFrame({}), null);
  assert.equal(readStreamErrorFrame({ error: null }), null);
  assert.equal(readStreamErrorFrame({ error: 42 }), null);
  assert.equal(readStreamErrorFrame({ choices: [{ delta: { content: 'hi' } }], error: null }), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```powershell
npm run build:test
```

Expected: build fails, or the subsequent run fails, with a module-resolution error naming `src/llm-protocol/stream-error-frame.js`. This is the expected red state — the module does not exist yet.

- [ ] **Step 3: Write the minimal implementation**

Create `src/llm-protocol/stream-error-frame.ts`:

```ts
import { z } from '../lib/zod.js';
import type { JsonObject } from './types.js';

/**
 * OpenAI-compatible providers reserve a top-level `error` key for fatal stream
 * termination, so a delta packet never matches this shape. Both the object form
 * (`{"error": {"message": ...}}`) and the bare string form appear in the wild.
 * Unknown sibling keys such as TabbyAPI's `trace` are stripped by `z.object`.
 */
const StreamErrorFrameSchema = z.object({
  error: z.union([
    z.string(),
    z.object({
      message: z.string().optional(),
      code: z.string().nullish(),
    }),
  ]),
});

export type StreamErrorFrame = {
  message: string;
  code: string | null;
};

/** Used when a provider sends an error frame with no message text of its own. */
export const UNSPECIFIED_STREAM_ERROR_MESSAGE = 'provider reported an unspecified stream error';

/** Reads a fatal error frame off an already-parsed packet, or null if this is not one. */
export function readStreamErrorFrame(packet: JsonObject): StreamErrorFrame | null {
  const parsed = StreamErrorFrameSchema.safeParse(packet);
  if (!parsed.success) {
    return null;
  }
  const { error } = parsed.data;
  if (typeof error === 'string') {
    return { message: error.trim() || UNSPECIFIED_STREAM_ERROR_MESSAGE, code: null };
  }
  return {
    message: error.message?.trim() || UNSPECIFIED_STREAM_ERROR_MESSAGE,
    code: error.code ?? null,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js llm-protocol-stream-error-frame
```

Expected: all 6 tests pass, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/llm-protocol/stream-error-frame.ts tests/llm-protocol-stream-error-frame.test.ts
git commit -m "feat(llm-protocol): parse provider SSE error frames"
```

---

### Task 2: Typed error classes and dispatch

**Files:**
- Modify: `src/llm-protocol/stream-errors.ts` (append after the existing `ProviderStreamDeadlineError` class, which ends at line 34 — the last line of the file)
- Test: `tests/llm-protocol-stream-error-frame.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/llm-protocol-stream-error-frame.test.ts`, and add the new import to the existing import block at the top of that file:

```ts
import {
  buildStreamErrorFrameError,
  ProviderContextLengthError,
  ProviderStreamErrorFrameError,
} from '../src/llm-protocol/stream-errors.js';
```

```ts
const TEST_URL = 'http://127.0.0.1:8098/v1/chat/completions';

test('a generic error frame becomes a ProviderStreamErrorFrameError carrying the server text', () => {
  const error = buildStreamErrorFrameError(TEST_URL, {
    message: 'Chat completion aborted. Please check the server console.',
    code: null,
  });

  assert.ok(error instanceof ProviderStreamErrorFrameError);
  assert.equal(error.serverMessage, 'Chat completion aborted. Please check the server console.');
  assert.equal(error.serverCode, null);
  assert.equal(error.url, TEST_URL);
  assert.match(error.message, /Chat completion aborted\. Please check the server console\./u);
  assert.match(error.message, /code=none/u);
  assert.doesNotMatch(error.message, /\[DONE\] sentinel/u);
});

test('a context_length_exceeded frame becomes a ProviderContextLengthError', () => {
  const error = buildStreamErrorFrameError(TEST_URL, {
    message: 'Request length 210000 exceeds the context window',
    code: 'context_length_exceeded',
  });

  assert.ok(error instanceof ProviderContextLengthError);
  assert.equal(error.serverMessage, 'Request length 210000 exceeds the context window');
  assert.equal(error.url, TEST_URL);
  assert.match(error.message, /rejected the prompt as too long/u);
});

test('an unrecognised code stays a generic stream error and keeps the code', () => {
  const error = buildStreamErrorFrameError(TEST_URL, { message: 'nope', code: 'rate_limit_exceeded' });

  assert.ok(error instanceof ProviderStreamErrorFrameError);
  assert.equal(error.serverCode, 'rate_limit_exceeded');
  assert.match(error.message, /code=rate_limit_exceeded/u);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```powershell
npm run build:test
```

Expected: build fails with TypeScript errors reporting that `buildStreamErrorFrameError`, `ProviderContextLengthError` and `ProviderStreamErrorFrameError` are not exported from `stream-errors.js`.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/llm-protocol/stream-errors.ts`, and add this import at the top of the file:

```ts
import type { StreamErrorFrame } from './stream-error-frame.js';
```

```ts
/** OpenAI's code for a prompt that exceeds the served context window. */
export const CONTEXT_LENGTH_EXCEEDED_CODE = 'context_length_exceeded';

/**
 * The provider terminated the stream with an `{"error": ...}` frame. The server
 * failed; the message is whatever it chose to tell us.
 */
export class ProviderStreamErrorFrameError extends Error {
  constructor(
    readonly url: string,
    readonly serverMessage: string,
    readonly serverCode: string | null,
  ) {
    super(
      `Provider stream returned an error frame: ${serverMessage} `
      + `(code=${serverCode ?? 'none'}, url=${url})`,
    );
    this.name = 'ProviderStreamErrorFrameError';
  }
}

/**
 * The provider rejected the prompt as longer than its context window. Unlike a
 * server abort this is our bug: the prompt budget let an over-length request
 * through. Kept distinct so budget failures stay greppable in run_logs.
 */
export class ProviderContextLengthError extends Error {
  constructor(readonly url: string, readonly serverMessage: string) {
    super(`Provider rejected the prompt as too long: ${serverMessage} (url=${url})`);
    this.name = 'ProviderContextLengthError';
  }
}

/** Maps a parsed error frame onto the failure class that matches its cause. */
export function buildStreamErrorFrameError(url: string, frame: StreamErrorFrame): Error {
  return frame.code === CONTEXT_LENGTH_EXCEEDED_CODE
    ? new ProviderContextLengthError(url, frame.message)
    : new ProviderStreamErrorFrameError(url, frame.message, frame.code);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js llm-protocol-stream-error-frame
```

Expected: all 9 tests pass, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/llm-protocol/stream-errors.ts tests/llm-protocol-stream-error-frame.test.ts
git commit -m "feat(llm-protocol): add typed provider stream error frame failures"
```

---

### Task 3: Add the `errorFrame` test helper

**Files:**
- Modify: `tests/helpers/streaming-client.ts` (append directly after the existing `contentFrame` function, which ends at line 28)

This is a test-only fixture with no behaviour of its own, so it has no test of its own; Task 4 consumes it.

- [ ] **Step 1: Add the helper**

Append after `contentFrame` in `tests/helpers/streaming-client.ts`:

```ts
/** A fatal error frame, serialized the way providers send it before closing without [DONE]. */
export function errorFrame(error: JsonSerializable): string {
  return JSON.stringify({ error });
}
```

`JsonSerializable` is already imported at the top of this file, so no import change is needed.

- [ ] **Step 2: Verify it compiles**

```powershell
npm run build:test
```

Expected: build succeeds with no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add tests/helpers/streaming-client.ts
git commit -m "test: add errorFrame builder for streaming client tests"
```

---

### Task 4: Throw on error frames in the chat stream loop

**Files:**
- Modify: `src/llm-protocol/inference-client.ts:23` (import block), `src/llm-protocol/inference-client.ts:411-412` (frame loop)
- Test: `tests/llm-protocol-stream-integrity.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/llm-protocol-stream-integrity.test.ts`, extend the existing helper import block to add `errorFrame`:

```ts
import {
  RawFrameHttpClient,
  RecordingLogger,
  buildStreamingTestConfig,
  contentFrame,
  errorFrame,
} from './helpers/streaming-client.js';
```

Add this import as well:

```ts
import {
  ProviderContextLengthError,
  ProviderStreamErrorFrameError,
} from '../src/llm-protocol/stream-errors.js';
```

Then append these four tests to the end of the file:

```ts
test('an error frame surfaces the server message instead of a missing-sentinel error', async () => {
  const logger = new RecordingLogger();
  const client = new InferenceClient(new RawFrameHttpClient([
    errorFrame({ message: 'Chat completion aborted. Please check the server console.', trace: null }),
  ]));

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
    (error: unknown) => {
      assert.ok(error instanceof ProviderStreamErrorFrameError);
      assert.match(error.message, /Chat completion aborted\. Please check the server console\./u);
      assert.doesNotMatch(error.message, /\[DONE\] sentinel/u);
      assert.equal(error.serverCode, null);
      return true;
    },
  );

  const errorFrames = logger.events.filter((event) => event.kind === 'provider_stream_error_frame');
  assert.equal(errorFrames.length, 1);
  assert.equal(errorFrames[0]?.serverMessage, 'Chat completion aborted. Please check the server console.');
  assert.equal(errorFrames[0]?.serverCode, null);
  assert.equal(errorFrames[0]?.frameIndex, 1);

  const degenerate = logger.events.filter((event) => event.kind === 'provider_stream_degenerate');
  assert.equal(degenerate.length, 0);
});

test('a context_length_exceeded frame throws ProviderContextLengthError', async () => {
  const client = new InferenceClient(new RawFrameHttpClient([
    errorFrame({
      message: 'Request length 210000 exceeds the context window',
      type: 'invalid_request_error',
      param: null,
      code: 'context_length_exceeded',
    }),
  ]));

  await assert.rejects(
    client.chat({
      config: buildStreamingTestConfig(),
      model: 'local',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 64,
      allowedToolNames: [],
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderContextLengthError);
      assert.match(error.message, /rejected the prompt as too long/u);
      assert.match(error.message, /exceeds the context window/u);
      return true;
    },
  );
});

test('an error frame arriving after content deltas still throws', async () => {
  const client = new InferenceClient(new RawFrameHttpClient([
    contentFrame('partial answer'),
    errorFrame({ message: 'generator died mid-stream' }),
  ]));

  await assert.rejects(
    client.chat({
      config: buildStreamingTestConfig(),
      model: 'local',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 64,
      allowedToolNames: [],
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderStreamErrorFrameError);
      assert.match(error.message, /generator died mid-stream/u);
      return true;
    },
  );
});

test('a clean stream with no error key is unaffected by error-frame detection', async () => {
  const logger = new RecordingLogger();
  const client = new InferenceClient(new RawFrameHttpClient([
    contentFrame('all'),
    contentFrame(' good'),
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

  assert.equal(response.text, 'all good');
  assert.equal(logger.events.filter((event) => event.kind === 'provider_stream_error_frame').length, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js llm-protocol-stream-integrity
```

Expected: the first three new tests FAIL. The first fails with a `ProviderStreamDegenerateError` whose message matches `/ended without a \[DONE\] sentinel/` rather than the expected `ProviderStreamErrorFrameError` — this is exactly the production bug being fixed. The fourth test passes already (it is the regression guard).

- [ ] **Step 3: Write the minimal implementation**

In `src/llm-protocol/inference-client.ts`, replace the single-line import on line 23:

```ts
import { ProviderStreamDegenerateError, ProviderStreamDeadlineError, type ProviderStreamDegenerateReason } from './stream-errors.js';
```

with:

```ts
import {
  buildStreamErrorFrameError,
  ProviderStreamDegenerateError,
  ProviderStreamDeadlineError,
  type ProviderStreamDegenerateReason,
} from './stream-errors.js';
import { readStreamErrorFrame } from './stream-error-frame.js';
```

Then insert the error-frame check into the frame loop, between the closing brace of the `catch` block (line 411) and the `const promptUsage` line (line 412). After the edit that region reads:

```ts
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
        // A fatal error frame terminates the stream, so it must be recognised
        // before the packet can be misread as a usage or delta frame.
        const errorFrame = readStreamErrorFrame(packet);
        if (errorFrame !== null) {
          options.logger?.write({
            kind: 'provider_stream_error_frame',
            url,
            frameIndex: frameCount,
            serverMessage: errorFrame.message,
            serverCode: errorFrame.code,
          });
          throw buildStreamErrorFrameError(url, errorFrame);
        }
          const promptUsage = getPromptUsageFromResponseBody(packet);
```

Leave the indentation of `const promptUsage` and the lines below it exactly as they are. That block is over-indented in the existing file; re-indenting it would bury this change in unrelated diff noise.

No change is needed to the `catch` block at lines 487-497. Neither new error is an `HttpResponseError`, so both fall through to the final `throw error` and reach the caller unmodified — which is the intended no-retry behaviour.

- [ ] **Step 4: Run the tests to verify they pass**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js llm-protocol-stream-integrity
```

Expected: all tests in the file pass, `# fail 0`. Confirm specifically that the two pre-existing tests `a stream that yields no frames throws rather than returning empty text` and `a stream ending without [DONE] throws` still pass — a stream that closes with no error frame must keep its old message.

- [ ] **Step 5: Commit**

```bash
git add src/llm-protocol/inference-client.ts tests/llm-protocol-stream-integrity.test.ts
git commit -m "fix(llm-protocol): surface provider stream error frames instead of a missing-sentinel error"
```

---

### Task 5: Full validation

**Files:** none modified.

- [ ] **Step 1: Run the two directly affected test files**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js llm-protocol-stream-error-frame
node .\dist\test-runner\run-tests.js llm-protocol-stream-integrity
```

Expected: `# fail 0` for both.

- [ ] **Step 2: Run the neighbouring llm-protocol suites**

```powershell
node .\dist\test-runner\run-tests.js llm-protocol
node .\dist\test-runner\run-tests.js llm-protocol-streaming
node .\dist\test-runner\run-tests.js llm-protocol-stream-deadline
node .\dist\test-runner\run-tests.js inference-client-thinking-budget
```

Expected: `# fail 0` for each. These exercise the same frame loop and would catch a false positive where a legitimate packet is misread as an error frame.

- [ ] **Step 3: Run the full suite**

Per the repo's large-output routing rule, summarise rather than reading the raw dump:

```powershell
npm run test 2>&1 | siftkit summary --question "Return pass/fail, failing test names, root errors, and relevant file:line anchors."
```

If SiftKit is unavailable, run `npm run test` directly and read only the failure section.

Expected: no failures. Any failure mentioning `stream`, `frame`, `sentinel`, or `degenerate` is caused by this change and must be fixed before continuing.

- [ ] **Step 4: Typecheck and lint**

```powershell
npm run typecheck
```

Expected: exits 0. This script already chains `npm run lint`, so no separate lint run is needed.

Watch for these specific violations of the repo's TypeScript rules, none of which the implementation above should introduce: no `any`, no type assertions, no non-null assertions, no namespace imports. The `error instanceof ProviderContextLengthError` narrowing in the tests is a valid type guard and is allowed.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "chore: satisfy typecheck and lint for provider stream error frames"
```

Skip this step if steps 1-4 were clean and produced no changes.

---

## Acceptance Criteria

1. A stream whose only frame is `{"error": {"message": "Chat completion aborted. Please check the server console.", "trace": null}}` rejects with a `ProviderStreamErrorFrameError` whose message contains the server's text and does **not** contain "[DONE] sentinel".
2. A stream whose only frame carries `code: "context_length_exceeded"` rejects with a `ProviderContextLengthError`.
3. An error frame that arrives after content deltas still throws.
4. A stream that closes with no `[DONE]` and no error frame still throws the original `ProviderStreamDegenerateError` with reason `missing_done_sentinel`.
5. A stream that yields zero frames still throws with reason `no_frames`.
6. A clean stream ending in `[DONE]` returns its content unchanged and logs no `provider_stream_error_frame` event.
7. Every error frame writes one `provider_stream_error_frame` log event carrying `url`, `frameIndex`, `serverMessage`, and `serverCode`.
8. `npm run test` and `npm run typecheck` both pass.

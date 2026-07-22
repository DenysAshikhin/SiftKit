# Streamed CLI Transport Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove dynamic progress callbacks and duplicate SSE transport while preserving complete structured diagnostics across every streamed CLI failure.

**Architecture:** `HttpClient.streamSse` is the only client SSE transport and returns an async frame generator. Typed `ProgressWriter` objects cross application layers. Runtime Zod schemas define a canonical recursive error payload consumed by both server and CLI.

**Tech Stack:** TypeScript, Node `http`/`https`, Zod 4, `node:test`.

## Global Constraints

- Execute after completed Tasks 1-14 in `2026-07-22-streamed-cli-transport.md`.
- Follow `2026-07-22-streamed-cli-transport-corrections-design.md`.
- TDD only; run each RED command before production edits and each GREEN command after.
- No `as` casts, `any`, non-null assertions, namespace imports, callback-shaped progress APIs, shims, or legacy compatibility.
- Runtime-boundary types come from `z.infer`.
- Reuse explicit classes; do not dynamically pass functions.
- Do not use worktrees or SiftKit.
- Full `npm test` and `npm run typecheck` must pass.

---

## File structure

| File | Responsibility |
|---|---|
| `src/lib/http-client.ts` | Sole callback-free SSE client transport |
| `src/lib/error-diagnostics.ts` | Recursive diagnostic schemas and inferred types |
| `src/lib/operation-stream.ts` | Stream error and queue diagnostic wire schemas |
| `src/lib/progress-writer.ts` | Typed progress writer and silent implementation |
| `src/llm-protocol/llama-cpp-client.ts` | Explicit llama SSE frame interpretation |
| `src/cli/status-server-api-client.ts` | Injected streamed transport and typed errors |
| `src/status-server/routes/streamed-operation-endpoint.ts` | Stream lifecycle and canonical terminal errors |
| `src/status-server/operation-progress-writers.ts` | Status SSE progress writers and repo-search filtering |
| `src/summary/types.ts`, `src/command-output/types.ts`, `src/repo-search/types.ts` | Separate wire data from explicit execution dependencies |
| `tests/helpers/collecting-progress-writer.ts` | Reusable writer test double |
| `tests/helpers/sse-http.ts` | Complete streamed error collection |

### Task 15: Unify SSE client transport

**Files:**
- Modify: `src/lib/http-client.ts`
- Modify: `src/llm-protocol/llama-cpp-client.ts`
- Delete: `src/lib/sse-client.ts`
- Delete: `tests/sse-client.test.ts`
- Modify: `tests/http-client.test.ts`
- Modify: `tests/llm-protocol.test.ts`
- Modify: `tests/llm-protocol-streaming.test.ts`

**Interfaces:**
- Produces `HttpClient.streamSse(options: SseStreamOptions): AsyncGenerator<SseFrame>`.
- Produces `HttpResponseError(statusCode, rawText)`.
- Removes the stream callback, `SseStreamResult`, `SseStreamPacket`, `SseStreamSignal`, and `SseClient`.

- [ ] **Step 1: Write failing async-generator transport tests**

Move `SseClient` behavior coverage into `tests/http-client.test.ts`. Collection must be explicit:

```ts
const frames: SseFrame[] = [];
for await (const frame of client.streamSse({
  url: `${server.baseUrl}/v1/chat/completions`,
  body: '{}',
  idleTimeoutMs: 5_000,
})) {
  frames.push(frame);
}
assert.deepEqual(frames, [
  { event: 'message', data: '{"choices":[{"delta":{"content":"hi"}}]}' },
  { event: 'message', data: '[DONE]' },
]);
```

Cover split chunks, CRLF, ignored heartbeat comments, HTTP 503 fields, caller abort reason, idle timeout, fresh sockets, and early `break` closing the request.

- [ ] **Step 2: Verify RED**

Run: `npm run build:test; node .\dist\scripts\run-tests.js http-client`

Expected: compile/test failure because `streamSse` requires a callback and returns a promise.

- [ ] **Step 3: Implement the generator**

Replace the public declarations with:

```ts
export type SseStreamOptions = {
  url: string;
  body: string;
  idleTimeoutMs: number;
  abortSignal?: AbortSignal;
};

export class HttpResponseError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly rawText: string,
  ) {
    super(`HTTP ${statusCode}: ${rawText}`);
    this.name = 'HttpResponseError';
  }
}
```

`streamSse` must use `this.localAgent(target)`, `SseFrameParser`, lifecycle logging, `request.setTimeout(options.idleTimeoutMs, ...)`, abort listener cleanup, a FIFO frame/end/error queue, and `request.destroy()` in `finally`. Yield every parsed frame, including `[DONE]`. Non-2xx responses throw `HttpResponseError` after their body ends.

- [ ] **Step 4: Verify transport GREEN**

Run: `npm run build:test; node .\dist\scripts\run-tests.js http-client`

Expected: all `http-client` tests pass.

- [ ] **Step 5: Rewrite llama consumption and fakes**

Use a labeled loop so early completion exits iteration without a callback:

```ts
streamFrames: for await (const frame of this.client.streamSse({
  url,
  body,
  idleTimeoutMs: Math.max(1, options.requestTimeoutSeconds ?? 300) * 1_000,
  abortSignal: options.abortSignal,
})) {
  if (frame.data === '[DONE]') break;
  let packet: JsonObject;
  try {
    packet = parseJsonObjectText(frame.data);
  } catch {
    continue;
  }
  // The current packet-processing statements remain in this loop; each current
  // `return 'stop'` becomes `break streamFrames`.
}
```

Catch `HttpResponseError`; transient responses use `buildTransientProviderHttpError`, and other HTTP failures become `LlamaHttpError`. Fake clients override `async *streamSse(): AsyncGenerator<SseFrame>` and yield JSON frames plus `[DONE]`.

- [ ] **Step 6: Verify llama GREEN**

Run: `npm run build:test; node .\dist\scripts\run-tests.js llm-protocol`

Expected: all llama protocol tests pass, including malformed packets and early stopping.

- [ ] **Step 7: Delete duplicate transport and commit**

Run: `rg -n "SseClient|SseStreamResult|SseStreamSignal" src tests`

Expected: only the files about to be deleted match; after deletion, zero matches.

```powershell
git rm src/lib/sse-client.ts tests/sse-client.test.ts
git add src/lib/http-client.ts src/llm-protocol/llama-cpp-client.ts tests/http-client.test.ts tests/llm-protocol.test.ts tests/llm-protocol-streaming.test.ts
git commit -m "refactor: unify SSE streaming in HttpClient"
```

### Task 16: Preserve full error diagnostics

**Files:**
- Modify: `src/lib/error-diagnostics.ts`, `src/lib/operation-stream.ts`
- Modify: `src/status-server/error-response.ts`, `src/status-server/server-types.ts`
- Modify: `src/status-server/routes/streamed-operation-endpoint.ts`
- Modify: `src/cli/status-server-api-client.ts`
- Modify: `tests/helpers/sse-http.ts`
- Modify: `tests/error-diagnostics.test.ts`, `tests/server-error-response.test.ts`
- Modify: `tests/summary-status-server.test.ts`, `tests/repo-search-status-server.test.ts`
- Create: `tests/status-server-api-client.test.ts`

**Interfaces:**
- Produces inferred `ErrorDiagnostic`, `ServerErrorPayload`, `ModelRequestQueueDiagnostics`, and `OperationStreamError`.
- Produces `StatusServerOperationError` retaining every wire field.
- Consumes Task 15 `HttpClient.streamSse`.

- [ ] **Step 1: Write failing endpoint and injected-client tests**

Readiness and execution failures must assert `error`, `errorName`, `diagnosticId`, and `diagnostic.message`. Queue timeout also asserts `modelRequests.queueLength`. A fake `HttpClient` must yield a complete error frame, and the client assertion must prove the fake handled streaming and the thrown typed error retained recursive cause and queue fields.

```ts
await assert.rejects(run, (error) => {
  assert.ok(error instanceof StatusServerOperationError);
  assert.equal(error.message, 'stream failed');
  assert.equal(error.diagnosticId, 'err_test');
  assert.equal(error.diagnostic.cause?.message, 'socket reset');
  assert.equal(error.modelRequests?.queueLength, 2);
  return true;
});
```

- [ ] **Step 2: Verify RED**

Run: `npm run build:test; node .\dist\scripts\run-tests.js status-server-api-client; node .\dist\scripts\run-tests.js summary-status-server; node .\dist\scripts\run-tests.js repo-search-status-server`

Expected: failures show discarded diagnostic fields and bypassed injected streaming.

- [ ] **Step 3: Define runtime schemas and inferred types**

In `error-diagnostics.ts`:

```ts
export const ErrorDiagnosticSchema = z.object({
  name: z.string(),
  message: z.string(),
  stack: z.string().optional(),
  operation: z.string().optional(),
  serviceUrl: z.string().optional(),
  healthUrl: z.string().optional(),
  get cause() { return ErrorDiagnosticSchema.optional(); },
});
export type ErrorDiagnostic = z.infer<typeof ErrorDiagnosticSchema>;

export const ServerErrorPayloadSchema = z.object({
  error: z.string(),
  errorName: z.string(),
  diagnosticId: z.string(),
  diagnostic: ErrorDiagnosticSchema,
});
export type ServerErrorPayload = z.infer<typeof ServerErrorPayloadSchema>;
```

In `operation-stream.ts`, define the full queue schema and infer its type, then:

```ts
export const OperationStreamErrorSchema = ServerErrorPayloadSchema.extend({
  modelRequests: ModelRequestQueueDiagnosticsSchema.optional(),
});
export type OperationStreamError = z.infer<typeof OperationStreamErrorSchema>;
```

Remove duplicate handwritten payload/queue types from server files.

- [ ] **Step 4: Emit the canonical payload**

Readiness and execution paths write `recordServerError(...)` directly. Queue timeout records a 503 error, then writes:

```ts
writer.writeEvent(OPERATION_STREAM_EVENTS.error, {
  ...payload,
  modelRequests: getModelRequestQueueDiagnostics(ctx),
});
```

- [ ] **Step 5: Consume through the injected client and throw a typed error**

Remove the `SseClient` import and iterate `this.client.streamSse`. Add:

```ts
export class StatusServerOperationError extends Error {
  public readonly diagnosticId: string;
  public readonly diagnostic: ErrorDiagnostic;
  public readonly modelRequests: ModelRequestQueueDiagnostics | undefined;
  constructor(payload: OperationStreamError) {
    super(payload.error);
    this.name = payload.errorName;
    this.diagnosticId = payload.diagnosticId;
    this.diagnostic = payload.diagnostic;
    this.modelRequests = payload.modelRequests;
  }
}
```

Return this error unchanged at the start of `normalizeError`.

- [ ] **Step 6: Update collector and verify GREEN**

`tests/helpers/sse-http.ts` sets `errorMessage = String(data.error || '')` while retaining `error`.

Run: `npm run build:test; node .\dist\scripts\run-tests.js error-diagnostics; node .\dist\scripts\run-tests.js server-error-response; node .\dist\scripts\run-tests.js status-server-api-client; node .\dist\scripts\run-tests.js summary-status-server; node .\dist\scripts\run-tests.js repo-search-status-server`

Expected: all listed tests pass.

- [ ] **Step 7: Commit**

```powershell
git add src/lib/error-diagnostics.ts src/lib/operation-stream.ts src/status-server/error-response.ts src/status-server/server-types.ts src/status-server/routes/streamed-operation-endpoint.ts src/cli/status-server-api-client.ts tests/helpers/sse-http.ts tests/error-diagnostics.test.ts tests/server-error-response.test.ts tests/summary-status-server.test.ts tests/repo-search-status-server.test.ts tests/status-server-api-client.test.ts
git commit -m "feat: preserve streamed operation diagnostics"
```

### Task 17: Replace summary-family progress callbacks

**Files:**
- Create: `src/lib/progress-writer.ts`, `tests/helpers/collecting-progress-writer.ts`
- Modify: `src/summary/progress-reporter.ts`, `src/summary/types.ts`, `src/summary/request-runner.ts`
- Modify: `src/command-output/types.ts`, `src/command-output/analyzer.ts`
- Modify: `src/status-server/eval.ts`, `src/status-server/engine-service.ts`, `src/status-server/preset-runner.ts`
- Modify: `tests/summary-progress-reporter.test.ts`, `tests/summary-logging.test.ts`
- Modify: `tests/eval.test.ts`, `tests/preset-runner.test.ts`, `tests/command.test.ts`

**Interfaces:**
- Produces `ProgressWriter<TEvent>` and `SilentProgressWriter<TEvent>`.
- Produces separate serializable request and internal execution request types.

- [ ] **Step 1: Write failing object-based reporter tests**

```ts
export class CollectingProgressWriter<TEvent> extends ProgressWriter<TEvent> {
  public readonly events: TEvent[] = [];
  get enabled(): boolean { return true; }
  write(event: TEvent): void { this.events.push(event); }
}
```

Replace test callbacks with this writer and assert `writer.events`. Add a silent-writer test proving `SummaryProgressReporter.enabled === false`.

- [ ] **Step 2: Verify RED**

Run: `npm run build:test; node .\dist\scripts\run-tests.js summary-progress-reporter`

Expected: missing `ProgressWriter` and `progressWriter` API failures.

- [ ] **Step 3: Implement writer classes and request splits**

```ts
export abstract class ProgressWriter<TEvent> {
  abstract get enabled(): boolean;
  abstract write(event: TEvent): void;
}
export class SilentProgressWriter<TEvent> extends ProgressWriter<TEvent> {
  get enabled(): boolean { return false; }
  write(_event: TEvent): void {}
}
```

`SummaryProgressReporter` stores `ProgressWriter<SummaryProgressEvent>`. `SummaryRequest` keeps serializable data only; `SummaryExecutionRequest` adds required `progressWriter` and optional `abortSignal`. Apply the same split to `CommandOutputAnalyzeRequest`/`CommandOutputAnalyzeExecutionRequest`. Forward writer objects unchanged.

- [ ] **Step 4: Convert eval, service, preset, and silent callers**

`EvaluationExecutionOptions` requires `progressWriter`; `PresetRunOptions` requires `summaryProgressWriter` and `repoSearchProgressWriter`; `StatusEngineService.runEvaluation(request, options)` forwards the object. Every non-rendering caller creates `new SilentProgressWriter<EventType>()`; no default hides a missing dependency.

- [ ] **Step 5: Verify GREEN**

Run: `npm run build:test; node .\dist\scripts\run-tests.js summary; node .\dist\scripts\run-tests.js eval; node .\dist\scripts\run-tests.js preset-runner`

Expected: all listed tests pass.

- [ ] **Step 6: Commit**

```powershell
git add src/lib/progress-writer.ts src/summary src/command-output src/status-server/eval.ts src/status-server/engine-service.ts src/status-server/preset-runner.ts tests
git commit -m "refactor: use explicit summary progress writers"
```

### Task 18: Replace repo-search and route progress callbacks

**Files:**
- Modify: `src/repo-search/types.ts`, `src/repo-search/execute.ts`, `src/repo-search/engine.ts`
- Modify: `src/repo-search/engine/progress-reporter.ts`, `task-loop.ts`, `task-loop-support.ts`
- Create: `src/status-server/operation-progress-writers.ts`
- Modify: `src/status-server/routes/streamed-operation-endpoint.ts`, `core.ts`, `chat.ts`
- Modify: `src/status-server/preset-runner.ts`
- Modify: `tests/engine-progress-reporter.test.ts`, `tests/engine-prompt-preparer.test.ts`, `tests/engine-terminal-synthesizer.test.ts`
- Modify: `tests/mock-repo-search-loop.test.ts`, `tests/repo-search-chat-execute.test.ts`, `tests/repo-search-chat-loop.test.ts`
- Modify: `tests/repo-search-loop.core.test.ts`, `tests/repo-search.test.ts`

**Interfaces:**
- Consumes Task 17 `ProgressWriter<TEvent>`.
- Produces `StreamedOperationContext`, `SummarySseProgressWriter`, and `RepoSearchSseProgressWriter`.
- Removes all streamed-operation callback fields.

- [ ] **Step 1: Convert tests to collecting writers and verify RED**

Run: `rg -l "onProgress|emitProgress" tests`

Replace each listed progress callback fixture with `CollectingProgressWriter<RepoSearchProgressEvent>` or the summary equivalent.

Run: `npm run build:test; node .\dist\scripts\run-tests.js engine-progress-reporter; node .\dist\scripts\run-tests.js repo-search-chat`

Expected: production APIs do not yet accept writer objects.

- [ ] **Step 2: Convert repo-search core**

Make `RepoSearchExecutionRequest.progressWriter`, `runRepoSearch` options, and `TaskLoopOptions.progressWriter` required. The existing engine `ProgressReporter` calls `progressWriter.write(event)`. Replace the execution callback closure with a concrete `RepoSearchExecutionProgressWriter` that logs, normalizes `elapsedMs`, and delegates to its target writer.

- [ ] **Step 3: Replace the function-shaped stream object**

```ts
export class StreamedOperationContext {
  constructor(
    private readonly writer: SseResponseWriter,
    public readonly abortSignal: AbortSignal,
  ) {}
  writeProgress(event: JsonSerializable): void {
    this.writer.writeEvent(OPERATION_STREAM_EVENTS.progress, event);
  }
}
```

Construct this class in `StreamedOperationEndpoint`; delete `StreamedOperationStream` and its `emitProgress` closure.

- [ ] **Step 4: Add concrete status writers and migrate routes**

`SummarySseProgressWriter.write` forwards all summary events. `RepoSearchSseProgressWriter.write` preserves tool-start server logging, suppresses `thinking`/`answer`, and forwards every other event. `core.ts`, presets, eval, command-output, and chat create these writer objects. Repeated chat behavior lives in a reusable class, not closures.

- [ ] **Step 5: Verify GREEN and zero callback APIs**

Run: `npm run build:test; node .\dist\scripts\run-tests.js engine-progress-reporter; node .\dist\scripts\run-tests.js repo-search; node .\dist\scripts\run-tests.js streamed-op-endpoints; node .\dist\scripts\run-tests.js summary-status-server`

Expected: all listed tests pass.

Run: `rg -n "onProgress|onSummaryProgress|onRepoSearchProgress|emitProgress" src/summary src/command-output src/repo-search src/status-server`

Expected: zero matches.

- [ ] **Step 6: Commit**

```powershell
git add src/repo-search src/status-server src/summary src/command-output tests
git commit -m "refactor: replace progress callbacks with writer objects"
```

### Task 19: Full validation and cleanup

**Files:** Modify only files required by failures.

- [ ] **Step 1: Run all tests**

Run: `npm test`

Expected: zero failures; intentional skips may remain.

- [ ] **Step 2: Run complete typecheck/lint**

Run: `npm run typecheck`

Expected: exit 0 for every TypeScript project and ESLint.

- [ ] **Step 3: Verify architecture**

```powershell
rg -n "SseClient|SseStreamResult|SseStreamSignal" src tests
rg -n "onProgress|onSummaryProgress|onRepoSearchProgress|emitProgress" src/summary src/command-output src/repo-search src/status-server
rg -n "OperationStreamErrorSchema = z.object\(\{ message" src tests
rg -n "new HttpClient\(\).*streamSse" src/cli
git diff --check
```

Expected: all four searches return zero matches; `git diff --check` exits 0.

- [ ] **Step 4: Remove investigation files and commit cleanup**

Remove only temporary files created during these tasks after verifying they are inside the task's single temporary folder. Do not remove user files. If tracked cleanup exists:

```powershell
git add -A
git commit -m "chore: complete streamed transport corrections"
```

If no tracked cleanup exists, leave the worktree clean without an empty commit.

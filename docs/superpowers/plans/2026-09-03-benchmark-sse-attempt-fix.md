# Benchmark Attempt SSE Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard Benchmark tab run attempts again by teaching the benchmark runner to consume the `text/event-stream` responses that `/summary` and `/repo-search` have emitted since commit `200bdfbb`.

**Architecture:** The operation-stream wire protocol is currently split — producer-side constants and schemas live in `src/lib/operation-stream.ts`, while consumer-side frame dispatch is private to `src/cli/status-server-api-client.ts`. Task 1 completes that module by adding the consumer half (`classifyOperationStreamFrame`, plus the `StatusServerOperationError` class moved out of the CLI). Task 2 migrates the CLI onto it. Task 3 rewrites the benchmark runner's HTTP call on top of it, splitting the network concern (`requestBenchmarkAttemptResult`) from the persistence concern (`invokeAttempt`) so the regression is testable without a database. Task 4 removes a dead parameter on a function the rewrite touches.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Zod via `src/lib/zod.js`, `node:test` + `node:assert/strict`, `node:http`, better-sqlite3 via `src/state/runtime-db.ts`.

---

## Background: why this is broken

`src/status-server/dashboard-benchmark-runner.ts:118` calls `/repo-search` and `/summary` with `httpClient.requestJsonFull(...)`, which buffers the whole response body and runs `parseJsonText` on it (`src/lib/http-client.ts:534`).

Both endpoints extend `StreamedOperationEndpoint`, which calls `writer.open()` unconditionally for any request that passes validation (`src/status-server/routes/streamed-operation-endpoint.ts:84-85`). That sets `Content-Type: text/event-stream` and writes `event: result\ndata: {...}\n\n` frames. `parseJsonText` throws on that body, so **every benchmark attempt fails** and lands in the `catch` at `dashboard-benchmark-runner.ts:220`.

`/summary` was converted to SSE on 2026-07-22 (`200bdfbb`), which touched no benchmark files. The CLI consumer was migrated; the benchmark runner was not. No test covers `invokeAttempt`, which is why the regression went silent.

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/lib/operation-stream.ts` | The operation-stream protocol for **both** ends: event names, heartbeat, payload schemas, the typed stream error, and frame classification. | Modify |
| `src/cli/status-server-api-client.ts` | CLI transport. Keeps progress rendering and approval prompting; delegates frame classification. | Modify |
| `src/status-server/dashboard-benchmark-runner.ts` | Benchmark orchestration. Gains `requestBenchmarkAttemptResult` (network only); `invokeAttempt` keeps metrics and persistence. | Modify |
| `src/status-server/dashboard-runs/queries.ts` | Run detail lookup. | Modify (dead param removal) |
| `tests/helpers/sse-http.ts` | Shared SSE test plumbing. | Modify (add `writeSseError`) |
| `tests/operation-stream.test.ts` | Unit coverage for frame classification. | Create |
| `tests/benchmark-attempt-stream.test.ts` | Regression coverage: benchmark attempt against a fake SSE server. | Create |
| `tests/status-server-api-client.test.ts` | Existing CLI transport coverage. | Modify (import path only) |

## Conventions this repo enforces

- All imports use explicit `.js` specifiers, even from `.ts` sources.
- Import Zod from `../lib/zod.js` (or `./zod.js`), never from the `zod` package directly.
- No `any`, no type assertions, no non-null assertions, no namespace imports. Parse IO with Zod schemas and derive types with `z.infer`.
- Unused imports fail `npm run lint`, which `npm run typecheck` runs at the end. If a step removes the last use of an import, remove the import too.
- Refactors are complete replacements. Do not leave a re-export shim behind when a symbol moves.

## How to run things

Node tests are compiled before they run. Always build first:

```bash
npm run build:test
```

Then run one file (basename match is enough):

```bash
node ./dist/test-runner/run-tests.js operation-stream.test.ts
```

Or one test by name:

```bash
node ./dist/test-runner/run-tests.js operation-stream.test.ts --test-name-pattern "classifies a result frame"
```

Full node suite: `npm run test`. Dashboard suite: `npm run test:dashboard`. Types + lint: `npm run typecheck`.

---

### Task 1: Add the consumer half of the operation-stream protocol

**Files:**
- Modify: `src/lib/operation-stream.ts`
- Test: `tests/operation-stream.test.ts` (create)

Note the real shape of `ErrorDiagnostic` (`src/lib/error-diagnostics.ts:3-13`): `{ name, message, stack?, operation?, serviceUrl?, healthUrl?, cause? }`. It has no `diagnosticId`, no `occurredAtUtc`, and no `taskKind` — those live on the enclosing `ServerErrorPayload`. The fixtures below match that shape exactly.

- [ ] **Step 1: Write the failing test**

Create `tests/operation-stream.test.ts` with exactly this content:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';

import { z } from '../src/lib/zod.js';
import {
  OPERATION_STREAM_EVENTS,
  StatusServerOperationError,
  classifyOperationStreamFrame,
} from '../src/lib/operation-stream.js';

const ResultSchema = z.object({ requestId: z.string(), value: z.number() });

const ERROR_PAYLOAD = {
  error: 'stream failed',
  errorName: 'TypeError',
  diagnosticId: 'diag-1',
  diagnostic: { name: 'TypeError', message: 'stream failed' },
};

test('classifies a result frame into the parsed result', () => {
  const classified = classifyOperationStreamFrame({
    event: OPERATION_STREAM_EVENTS.result,
    data: JSON.stringify({ requestId: 'run-1', value: 7 }),
  }, ResultSchema);

  assert.equal(classified.kind, 'result');
  if (classified.kind !== 'result') return;
  assert.deepEqual(classified.result, { requestId: 'run-1', value: 7 });
});

test('classifies a progress frame into its payload object', () => {
  const classified = classifyOperationStreamFrame({
    event: OPERATION_STREAM_EVENTS.progress,
    data: JSON.stringify({ kind: 'lock_wait', elapsedMs: 12 }),
  }, ResultSchema);

  assert.equal(classified.kind, 'progress');
  if (classified.kind !== 'progress') return;
  assert.equal(classified.event.kind, 'lock_wait');
  assert.equal(classified.event.elapsedMs, 12);
});

test('throws a typed error for an error frame', () => {
  assert.throws(
    () => classifyOperationStreamFrame({
      event: OPERATION_STREAM_EVENTS.error,
      data: JSON.stringify(ERROR_PAYLOAD),
    }, ResultSchema),
    (error) => {
      assert.ok(error instanceof StatusServerOperationError);
      assert.equal(error.message, 'stream failed');
      assert.equal(error.name, 'TypeError');
      assert.equal(error.diagnosticId, 'diag-1');
      return true;
    },
  );
});

test('ignores frames that are not part of the operation protocol', () => {
  const classified = classifyOperationStreamFrame({ event: 'message', data: '{}' }, ResultSchema);
  assert.equal(classified.kind, 'ignored');
});

test('rejects a result frame whose payload does not match the schema', () => {
  assert.throws(() => classifyOperationStreamFrame({
    event: OPERATION_STREAM_EVENTS.result,
    data: JSON.stringify({ requestId: 'run-1' }),
  }, ResultSchema));
});
```

- [ ] **Step 2: Run the build to verify the test fails**

```bash
npm run build:test
```

Expected: FAIL with TypeScript errors like `Module '"../src/lib/operation-stream.js"' has no exported member 'classifyOperationStreamFrame'` and the same for `StatusServerOperationError`. That is the expected failure — the symbols do not exist yet.

- [ ] **Step 3: Add the consumer half to `src/lib/operation-stream.ts`**

Replace the first two lines of `src/lib/operation-stream.ts`:

```typescript
import { z } from './zod.js';
import { ServerErrorPayloadSchema } from './error-diagnostics.js';
```

with:

```typescript
import { z } from './zod.js';
import { ServerErrorPayloadSchema, type ErrorDiagnostic } from './error-diagnostics.js';
import { parseJsonObjectText, parseJsonText } from './json.js';
import type { JsonObject } from './json-types.js';
import type { SseFrame } from './sse-frame-parser.js';
```

Then append this block to the end of the file:

```typescript
/** Idle ceiling for an operation stream: a model turn may be silent for a long time. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export const OPERATION_STREAM_NO_RESULT_ERROR = 'Operation stream ended before a result frame.';

/** The server's terminal `error` frame, rehydrated on the client side with its diagnostics intact. */
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

export type OperationStreamFrame<T> =
  | { kind: 'progress'; event: JsonObject }
  | { kind: 'result'; result: T }
  | { kind: 'ignored' };

/**
 * Sorts one SSE frame into the operation protocol's three outcomes. Consumers differ only in
 * what they do with progress frames, so the terminal semantics live here once: an `error` frame
 * always throws, and a `result` frame is always parsed against the caller's schema.
 */
export function classifyOperationStreamFrame<T>(
  frame: SseFrame,
  schema: z.ZodType<T>,
): OperationStreamFrame<T> {
  if (frame.event === OPERATION_STREAM_EVENTS.progress) {
    return { kind: 'progress', event: parseJsonObjectText(frame.data) };
  }
  if (frame.event === OPERATION_STREAM_EVENTS.error) {
    throw new StatusServerOperationError(OperationStreamErrorSchema.parse(parseJsonObjectText(frame.data)));
  }
  if (frame.event === OPERATION_STREAM_EVENTS.result) {
    return { kind: 'result', result: parseJsonText(frame.data, schema) };
  }
  return { kind: 'ignored' };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run build:test && node ./dist/test-runner/run-tests.js operation-stream.test.ts
```

Expected: PASS — `# pass 5`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/operation-stream.ts tests/operation-stream.test.ts
git commit -m "feat: add operation stream frame classification to the shared protocol module"
```

---

### Task 2: Migrate the CLI transport onto the shared classifier

This is a complete replacement. The CLI's private `StatusServerOperationError` class and `DEFAULT_STREAM_IDLE_TIMEOUT_MS` constant are deleted, not aliased.

**Files:**
- Modify: `src/cli/status-server-api-client.ts`
- Modify: `tests/status-server-api-client.test.ts:5-8`

- [ ] **Step 1: Point the existing test at the new home**

In `tests/status-server-api-client.test.ts`, replace lines 5-8:

```typescript
import {
  StatusServerApiClient,
  StatusServerOperationError,
} from '../src/cli/status-server-api-client.js';
```

with:

```typescript
import { StatusServerApiClient } from '../src/cli/status-server-api-client.js';
import { StatusServerOperationError } from '../src/lib/operation-stream.js';
```

- [ ] **Step 2: Run the build to see the current state**

```bash
npm run build:test
```

Expected: the build succeeds, because both classes exist — the CLI still declares its own and `src/lib/operation-stream.ts` now declares the shared one. That duplication is exactly what Step 3 removes. If instead you see `has no exported member 'StatusServerOperationError'` on the CLI module, Task 1 is not applied; stop and apply it first.

- [ ] **Step 3: Delete the CLI's private copies and import the shared ones**

In `src/cli/status-server-api-client.ts`:

**3a.** Replace the `operation-stream.js` import block (lines 15-20):

```typescript
import {
  OPERATION_STREAM_EVENTS,
  OperationStreamErrorSchema,
  type ModelRequestQueueDiagnostics,
  type OperationStreamError,
} from '../lib/operation-stream.js';
```

with:

```typescript
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  OPERATION_STREAM_NO_RESULT_ERROR,
  StatusServerOperationError,
  classifyOperationStreamFrame,
} from '../lib/operation-stream.js';
```

**3b.** Delete the now-unused import on line 21:

```typescript
import type { ErrorDiagnostic } from '../lib/error-diagnostics.js';
```

**3c.** Delete line 96:

```typescript
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
```

**3d.** Delete the whole class at lines 106-118:

```typescript
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

**3e.** Replace the frame-dispatch body inside `requestStreamedOperation`. The current code is:

```typescript
        if (frame.event === OPERATION_STREAM_EVENTS.progress) {
          const progressEvent = parseJsonObjectText(frame.data);
          if (progressEvent.kind === 'approval_request') {
            if (!approvalPrompter) {
              throw new Error('Received approval_request on a non-interactive run.');
            }
            // The frame crossed the wire, so it is parsed back into its declared shape here.
            const approval = ApprovalRequestProgressEventSchema.parse(progressEvent);
            const decision = await approvalPrompter.promptDecision(approval);
            await this.submitApproval(approval, decision);
            continue;
          }
          renderer.render(progressEvent);
          continue;
        }
        if (frame.event === OPERATION_STREAM_EVENTS.error) {
          const payload = OperationStreamErrorSchema.parse(parseJsonObjectText(frame.data));
          throw new StatusServerOperationError(payload);
        }
        if (frame.event === OPERATION_STREAM_EVENTS.result) {
          logHttpClientBoundary(
            task,
            'caller_response_received',
            `elapsed_ms=${Math.max(0, Date.now() - startedAt)} no_awaited_flush_before_next=true`,
          );
          return parseJsonText(frame.data, schema);
        }
      }
      throw new Error('Operation stream ended before a result frame.');
```

Replace it with:

```typescript
        const classified = classifyOperationStreamFrame(frame, schema);
        if (classified.kind === 'progress') {
          const progressEvent = classified.event;
          if (progressEvent.kind === 'approval_request') {
            if (!approvalPrompter) {
              throw new Error('Received approval_request on a non-interactive run.');
            }
            // The frame crossed the wire, so it is parsed back into its declared shape here.
            const approval = ApprovalRequestProgressEventSchema.parse(progressEvent);
            const decision = await approvalPrompter.promptDecision(approval);
            await this.submitApproval(approval, decision);
            continue;
          }
          renderer.render(progressEvent);
          continue;
        }
        if (classified.kind === 'result') {
          logHttpClientBoundary(
            task,
            'caller_response_received',
            `elapsed_ms=${Math.max(0, Date.now() - startedAt)} no_awaited_flush_before_next=true`,
          );
          return classified.result;
        }
      }
      throw new Error(OPERATION_STREAM_NO_RESULT_ERROR);
```

**3f.** `parseJsonObjectText` and `parseJsonText` may now be unused in this file. Check before editing the import on line 14:

```bash
grep -n "parseJsonObjectText\|parseJsonText" src/cli/status-server-api-client.ts
```

Keep whichever names still have a call site in `import { parseJsonObjectText, parseJsonText } from '../lib/json.js';`; drop the others. If neither remains, delete the whole import line.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm run build:test && node ./dist/test-runner/run-tests.js status-server-api-client.test.ts
```

Expected: PASS — `# fail 0`.

Then confirm nothing still reaches for the moved symbol through the CLI module:

```bash
grep -rn "StatusServerOperationError" src/ tests/ --include=*.ts
```

Expected: every import resolves to `src/lib/operation-stream.js`. No import of that name from `src/cli/status-server-api-client.js`.

- [ ] **Step 5: Commit**

```bash
git add src/cli/status-server-api-client.ts tests/status-server-api-client.test.ts
git commit -m "refactor: move the operation stream error and frame dispatch out of the CLI client"
```

---

### Task 3: Make the benchmark runner speak SSE

**Files:**
- Modify: `tests/helpers/sse-http.ts` (add `writeSseError`)
- Modify: `src/status-server/dashboard-benchmark-runner.ts:116-170`
- Test: `tests/benchmark-attempt-stream.test.ts` (create)

`requestBenchmarkAttemptResult` is the whole network concern and takes no `ServerContext` and no database, so it can be tested against a fake HTTP server. `invokeAttempt` keeps the run-metrics lookup and the `updateBenchmarkAttempt` write.

Field casing differs between the two result schemas and is not interchangeable:
- `SummaryResultSchema` (`src/summary/types.ts:89`) → `RequestId`, `Summary` (capitalised), `Provider` is the enum `'real' | 'mock'`, `Classification` is the enum `'summary' | 'command_failure' | 'unsupported_input'`.
- `RepoSearchExecutionResultSchema` (`src/repo-search/types.ts:193`) → `requestId`, `transcriptPath`, `artifactPath`, `scorecard`.

- [ ] **Step 1: Add an error-frame writer to the shared SSE test helper**

Append to `tests/helpers/sse-http.ts`, directly after `writeSseResult`:

```typescript
export function writeSseError(res: http.ServerResponse, payload: JsonSerializable): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('\n');
  res.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
  res.end();
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/benchmark-attempt-stream.test.ts` with exactly this content. It reuses the repo's existing SSE and scorecard helpers so the fake server frames responses the same way the real endpoints do.

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { parseJsonObjectText } from '../src/lib/json.js';
import type { JsonObject, JsonSerializable } from '../src/lib/json-types.js';
import { requestBenchmarkAttemptResult } from '../src/status-server/dashboard-benchmark-runner.js';
import { buildMockScorecard } from './_test-helpers.js';
import { closeHttpServer, getAddressInfo } from './helpers/dashboard-http.js';
import { writeSseError, writeSseResult } from './helpers/sse-http.js';

type FakeOperationServer = {
  baseUrl: string;
  requests: { pathname: string; body: JsonObject }[];
  close: () => Promise<void>;
};

const SUMMARY_RESULT = {
  RequestId: 'summary-run-1',
  WasSummarized: true,
  PolicyDecision: 'summarize',
  Provider: 'mock',
  Model: 'mock-model',
  Summary: 'Benchmark summary output.',
  Classification: 'summary',
  RawReviewRequired: false,
  ModelCallSucceeded: true,
  ProviderError: null,
} satisfies JsonSerializable;

const REPO_SEARCH_RESULT = {
  requestId: 'repo-search-run-1',
  transcriptPath: 'db://repo-search/transcript',
  artifactPath: 'db://repo-search/artifact',
  scorecard: buildMockScorecard('benchmark repo-search output'),
};

const ERROR_PAYLOAD = {
  error: 'Timed out waiting for model request queue.',
  errorName: 'Error',
  diagnosticId: 'diag-2',
  diagnostic: { name: 'Error', message: 'Timed out waiting for model request queue.' },
} satisfies JsonSerializable;

/** Mirrors StreamedOperationEndpoint: an opening progress frame, then one terminal frame. */
async function startFakeOperationServer(
  respond: (pathname: string, res: http.ServerResponse) => void,
): Promise<FakeOperationServer> {
  const requests: { pathname: string; body: JsonObject }[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { raw += chunk; });
    req.on('end', () => {
      requests.push({ pathname: String(req.url || ''), body: parseJsonObjectText(raw || '{}') });
      respond(String(req.url || ''), res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${getAddressInfo(server).port}`,
    requests,
    close: () => closeHttpServer(server),
  };
}

test('benchmark summary attempt reads its result out of the SSE stream', async () => {
  const server = await startFakeOperationServer((_pathname, res) => {
    writeSseResult(res, SUMMARY_RESULT, [{ kind: 'lock_wait', elapsedMs: 1 }]);
  });
  try {
    const result = await requestBenchmarkAttemptResult(server.baseUrl, {
      taskKind: 'summary',
      prompt: 'Summarize the queue behavior.',
    });

    assert.equal(result.runId, 'summary-run-1');
    assert.equal(result.outputText, 'Benchmark summary output.');
    assert.equal(server.requests[0]?.pathname, '/summary');
    assert.equal(server.requests[0]?.body.question, 'Summarize the queue behavior.');
    assert.equal(server.requests[0]?.body.sourceKind, 'standalone');
  } finally {
    await server.close();
  }
});

test('benchmark repo-search attempt reads its result out of the SSE stream', async () => {
  const server = await startFakeOperationServer((_pathname, res) => {
    writeSseResult(res, REPO_SEARCH_RESULT);
  });
  try {
    const result = await requestBenchmarkAttemptResult(server.baseUrl, {
      taskKind: 'repo-search',
      prompt: 'Trace repo-search execution.',
    });

    assert.equal(result.runId, 'repo-search-run-1');
    assert.match(result.outputText, /db:\/\/repo-search\/artifact/u);
    assert.equal(server.requests[0]?.pathname, '/repo-search');
    assert.equal(server.requests[0]?.body.prompt, 'Trace repo-search execution.');
  } finally {
    await server.close();
  }
});

test('benchmark attempt surfaces a terminal error frame as a rejection', async () => {
  const server = await startFakeOperationServer((_pathname, res) => {
    writeSseError(res, ERROR_PAYLOAD);
  });
  try {
    await assert.rejects(
      requestBenchmarkAttemptResult(server.baseUrl, { taskKind: 'summary', prompt: 'anything' }),
      /Timed out waiting for model request queue/u,
    );
  } finally {
    await server.close();
  }
});

test('benchmark attempt fails loudly when the stream ends without a result', async () => {
  const server = await startFakeOperationServer((_pathname, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('\n');
    res.end();
  });
  try {
    await assert.rejects(
      requestBenchmarkAttemptResult(server.baseUrl, { taskKind: 'summary', prompt: 'anything' }),
      /ended before a result frame/u,
    );
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 3: Run the build to verify the test fails**

```bash
npm run build:test
```

Expected: FAIL with `Module '"../src/status-server/dashboard-benchmark-runner.js"' has no exported member 'requestBenchmarkAttemptResult'`.

- [ ] **Step 4: Rewrite the network call in `src/status-server/dashboard-benchmark-runner.ts`**

**4a. Fix the imports at the top of the file.** Replace:

```typescript
import { JsonObjectSchema, type JsonObject } from '../lib/json-types.js';
```

with:

```typescript
import type { JsonObject } from '../lib/json-types.js';
```

Then add these imports alongside the existing `import { httpClient } from '../lib/http-client.js';` line:

```typescript
import { z } from '../lib/zod.js';
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  OPERATION_STREAM_NO_RESULT_ERROR,
  classifyOperationStreamFrame,
} from '../lib/operation-stream.js';
import { RepoSearchExecutionResultSchema } from '../repo-search/types.js';
import { SummaryResultSchema } from '../summary/types.js';
```

Finally, add `type BenchmarkTaskKind` to the existing named import from `../state/dashboard-benchmark.js` (the block that already imports `type BenchmarkAttemptRecord` and `type BenchmarkSessionDetail`), so the request type reuses the enum instead of restating it:

```typescript
  type BenchmarkAttemptRecord,
  type BenchmarkSessionDetail,
  type BenchmarkTaskKind,
} from '../state/dashboard-benchmark.js';
```

**4b. Replace the whole `invokeAttempt` function** (currently `src/status-server/dashboard-benchmark-runner.ts:116-170`) with the three declarations below.

Each task kind is dispatched in its own branch rather than through a ternary over the two schemas. That keeps `T` inferable: a union of two `z.ZodType` values does not infer a usable `T` through `classifyOperationStreamFrame`.

```typescript
export type BenchmarkAttemptRequest = {
  taskKind: BenchmarkTaskKind;
  prompt: string;
};

export type BenchmarkAttemptResponse = {
  outputText: string;
  runId: string;
};

async function readOperationStreamResult<T>(url: string, body: string, schema: z.ZodType<T>): Promise<T> {
  for await (const frame of httpClient.streamSse({
    url,
    body,
    idleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  })) {
    const classified = classifyOperationStreamFrame(frame, schema);
    if (classified.kind === 'result') {
      return classified.result;
    }
  }
  throw new Error(OPERATION_STREAM_NO_RESULT_ERROR);
}

/**
 * Both operation endpoints answer over SSE, so a result arrives as a terminal frame rather than
 * a JSON body. Parsing each task kind against its declared result schema is what keeps the run
 * id and the output text off string sniffing.
 */
export async function requestBenchmarkAttemptResult(
  baseUrl: string,
  attempt: BenchmarkAttemptRequest,
): Promise<BenchmarkAttemptResponse> {
  if (attempt.taskKind === 'repo-search') {
    const result = await readOperationStreamResult(
      `${baseUrl}/repo-search`,
      JSON.stringify({ prompt: attempt.prompt }),
      RepoSearchExecutionResultSchema,
    );
    return { outputText: JSON.stringify(result), runId: result.requestId };
  }
  const result = await readOperationStreamResult(
    `${baseUrl}/summary`,
    JSON.stringify({
      question: attempt.prompt,
      inputText: attempt.prompt,
      format: 'text',
      policyProfile: 'general',
      sourceKind: 'standalone',
    }),
    SummaryResultSchema,
  );
  return { outputText: result.Summary, runId: result.RequestId };
}

async function invokeAttempt(ctx: ServerContext, attempt: BenchmarkAttemptRecord): Promise<{
  outputText: string;
  runId: string;
  metrics: BenchmarkAttemptMetrics;
}> {
  const started = Date.now();
  const response = await requestBenchmarkAttemptResult(ctx.getServiceBaseUrl(), {
    taskKind: attempt.taskKind,
    prompt: attempt.prompt,
  });
  const runDetail = buildDashboardRunDetail('', response.runId);
  const runMetrics = buildBenchmarkAttemptMetrics(runDetail?.run ?? null);
  const metrics = {
    ...runMetrics,
    durationMs: runMetrics.durationMs ?? Date.now() - started,
  };
  updateBenchmarkAttempt({
    attemptId: attempt.id,
    durationMs: metrics.durationMs,
    runId: response.runId,
    promptTokensPerSecond: metrics.promptTokensPerSecond,
    generationTokensPerSecond: metrics.generationTokensPerSecond,
    acceptanceRate: metrics.acceptanceRate,
    outputTokens: metrics.outputTokens,
    thinkingTokens: metrics.thinkingTokens,
    speculativeAcceptedTokens: metrics.speculativeAcceptedTokens,
    speculativeGeneratedTokens: metrics.speculativeGeneratedTokens,
  });
  return { outputText: response.outputText, runId: response.runId, metrics };
}
```

The `buildDashboardRunDetail('', ...)` call keeps the current two-argument signature so this task compiles on its own. Task 4 removes the dead first argument.

**4c.** `runId` is now `string` instead of `string | null`. The only consumer is `runBenchmarkJob`, which passes `result.runId` straight into `updateBenchmarkAttempt` (`runId?: string | null`), so no call-site change is needed. Confirm with:

```bash
grep -n "result.runId\|\.runId" src/status-server/dashboard-benchmark-runner.ts
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm run build:test && node ./dist/test-runner/run-tests.js benchmark-attempt-stream.test.ts
```

Expected: PASS — `# pass 4`, `# fail 0`.

Then confirm the existing benchmark tests still pass:

```bash
node ./dist/test-runner/run-tests.js dashboard-benchmark.test.ts
node ./dist/test-runner/run-tests.js dashboard-benchmark-restart.test.ts
```

Expected: `# fail 0` for both.

- [ ] **Step 6: Commit**

```bash
git add src/status-server/dashboard-benchmark-runner.ts tests/benchmark-attempt-stream.test.ts tests/helpers/sse-http.ts
git commit -m "fix: read benchmark attempt results from the operation SSE stream"
```

---

### Task 4: Drop the dead `runtimeRoot` parameter from `buildDashboardRunDetail`

`src/status-server/dashboard-runs/queries.ts:120` is literally `void runtimeRoot;` — the parameter was orphaned when run detail moved into the runtime database, and the benchmark runner has been passing `''` to satisfy it. The benchmark runner is its only caller.

**Files:**
- Modify: `src/status-server/dashboard-runs/queries.ts:119-121`
- Modify: `src/status-server/dashboard-benchmark-runner.ts` (the `buildDashboardRunDetail` call site)

- [ ] **Step 1: Confirm the caller inventory**

```bash
grep -rn "buildDashboardRunDetail" src/ tests/ dashboard/ scripts/ bench/ --include=*.ts --include=*.tsx
```

Expected: one call site in `src/status-server/dashboard-benchmark-runner.ts`, the definition in `src/status-server/dashboard-runs/queries.ts`, and two name-only re-exports in `src/status-server/dashboard-runs.ts:30` and `src/status-server/index.ts:39`. Re-exports carry no signature and need no edit. If this finds any other call site, update it in Step 3 too.

- [ ] **Step 2: Remove the parameter**

In `src/status-server/dashboard-runs/queries.ts`, replace:

```typescript
export function buildDashboardRunDetail(runtimeRoot: string, runId: string): { run: RunRecord; events: JsonlEvent[] } | null {
  void runtimeRoot;
  const databasePath = getRuntimeDatabasePath();
```

with:

```typescript
export function buildDashboardRunDetail(runId: string): { run: RunRecord; events: JsonlEvent[] } | null {
  const databasePath = getRuntimeDatabasePath();
```

- [ ] **Step 3: Update the call site**

In `src/status-server/dashboard-benchmark-runner.ts`, inside `invokeAttempt`, replace:

```typescript
  const runDetail = buildDashboardRunDetail('', response.runId);
```

with:

```typescript
  const runDetail = buildDashboardRunDetail(response.runId);
```

- [ ] **Step 4: Run typecheck to verify nothing else used the old signature**

```bash
npm run typecheck
```

Expected: PASS — exit 0. An `Expected 1 arguments, but got 2` error means Step 1 missed a call site; fix it and re-run.

- [ ] **Step 5: Commit**

```bash
git add src/status-server/dashboard-runs/queries.ts src/status-server/dashboard-benchmark-runner.ts
git commit -m "refactor: drop the dead runtimeRoot parameter from buildDashboardRunDetail"
```

---

### Task 5: Send the required `repoRoot` on summary requests

Found during Task 5 validation, not during planning. `parseSummaryRequest` requires `repoRoot` and returns `null` without it (`src/status-server/route-request-normalizers.ts:136`), which makes `/summary` answer `400 {"error":"Expected question and inputText."}` as plain JSON *before* it ever opens a stream. The benchmark's summary body has never sent `repoRoot`, so summary attempts fail even with the SSE fix in place. `parseRepoSearchRequest` defaults it to `process.cwd()` (line 109), so repo-search was unaffected.

**Files:**
- Modify: `tests/benchmark-attempt-stream.test.ts`
- Modify: `src/status-server/dashboard-benchmark-runner.ts`

- [x] **Step 1: Assert the request body against the server's own parser**

Field-name assertions cannot catch this class of drift. Import the real normalizers and require the captured body to satisfy them:

```typescript
import { parseRepoSearchRequest, parseSummaryRequest } from '../src/status-server/route-request-normalizers.js';
```

In the summary test, after the existing field assertions:

```typescript
    // The real endpoint rejects the body before it ever opens a stream, so the benchmark's
    // request must satisfy the server's own parser rather than merely look plausible.
    assert.notEqual(parseSummaryRequest(server.requests[0]?.body ?? {}), null);
```

In the repo-search test:

```typescript
    assert.notEqual(parseRepoSearchRequest(server.requests[0]?.body ?? {}), null);
```

- [x] **Step 2: Run to verify the summary case fails**

Expected: FAIL — `AssertionError [ERR_ASSERTION]: Expected "actual" to be strictly unequal to: null` on the summary test; the repo-search test passes.

- [x] **Step 3: Send `repoRoot` from `requestBenchmarkAttemptResult`**

In the summary branch's body literal, add as the first field:

```typescript
      // Required by parseSummaryRequest, which rejects the body outright without it. The
      // repo-search route defaults this to the server's cwd, so the benchmark sends the same
      // value to keep both task kinds measuring the same tree.
      repoRoot: process.cwd(),
```

- [x] **Step 4: Run to verify it passes**

Expected: PASS — `# pass 4`, `# fail 0`.

- [x] **Step 5: Commit**

```bash
git add src/status-server/dashboard-benchmark-runner.ts tests/benchmark-attempt-stream.test.ts
git commit -m "fix: send the required repoRoot on benchmark summary requests"
```

---

### Task 6: Full validation

**Files:** none modified.

- [ ] **Step 1: Types and lint**

```bash
npm run typecheck
```

Expected: PASS — exit 0, no TypeScript or ESLint errors.

- [ ] **Step 2: Full node suite**

```bash
npm run test
```

Expected: PASS — `# fail 0`. Report any failure with its test name and assertion output. Do not weaken a test to make it pass.

- [ ] **Step 3: Dashboard suite**

The Benchmark tab's render test lives here and must stay green:

```bash
npm run test:dashboard
```

Expected: PASS — `# fail 0`.

- [ ] **Step 4: Confirm no `requestJsonFull` call remains against an operation endpoint**

```bash
grep -rn -B4 "requestJsonFull" src/ --include=*.ts
```

Expected: no call whose `url` targets `/summary`, `/repo-search`, or `/repo-agent`. Those three are SSE endpoints; a remaining `requestJsonFull` against any of them is this same bug in another place. Report it rather than fixing it here — it is outside this plan's scope.

- [ ] **Step 5: Nothing to commit**

If Steps 1-4 were clean there is no diff, and this task is complete.

---

## Manual verification (requires a live model — not part of the automated suite)

The automated tests prove the transport is correct against a faithful fake. They cannot prove a real attempt completes, because that needs a loaded model. To close the loop by hand:

1. `npm run build && npm run start`
2. Open the dashboard and go to the **Bench** tab.
3. Pick one question preset and one managed preset, set repetitions to 1, click Start.
4. Expect Live Logs to stream `Starting <taskKind> attempt 0:0:0.` followed by `Completed attempt <id>.`, and the results table to show a row with a non-null generation speed.
5. Before the fix, step 4 produced `Failed attempt <id>: Unexpected token ...` instead.

A benchmark session restarts the inference runtime between cases, and `restartConfiguredPreset` refuses while a model request is in flight (`src/status-server/preset-runtime-coordinator.ts:87`). Run this against an otherwise idle server.

## Out of scope

Found while diagnosing, not part of this fix. Each is independently harmless today:

- **`benchmark_attempts.managed_run_id` is a dead column.** Declared in `src/state/migrations/schema-helpers.ts:279` and in the contracts, never written by the runner, never read by the UI. Removing it is a migration, not a bug fix.
- **Question-preset CRUD has no UI.** `createBenchmarkQuestionPreset` / `updateBenchmarkQuestionPreset` / `deleteBenchmarkQuestionPreset` (`dashboard/src/api.ts:268-295`) have server routes but no caller in `dashboard/src`. Missing feature, not a regression.
- **Start-before-subscribe race.** `BenchmarkSessionCreateEndpoint` calls `startBenchmarkJob` before `sendJson` (`src/status-server/routes/dashboard.ts:420-421`), so the first log lines can be emitted before the browser's `EventSource` attaches. The detail refetch backfills them; only the live tail is affected.

# SiftKit Memory & Leak Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate five confirmed memory leaks and unbounded-growth defects in the status-server process: the process-lifetime artifact-path map, the never-evicted speculative-metrics tracker, the never-settling request-body promise, the unbounded O(n²) inference-log buffer, and the quadratic planner-debug payload with its four-times-redundant serialization.

**Architecture:** Five independent fixes, ordered smallest-blast-radius first. Three are deletions or lifecycle corrections that reuse seams the codebase already has (`flushDerivedMetrics` override, `appendCappedTail`, `getInferenceRunPendingLogChunkStats`, the `db://` artifact-URI convention). Two are data-shape changes: the inference-log pending buffer becomes a chunk array with running counters plus a high-water mark that overrides the model-request flush deferral, and the planner-debug payload stops storing per-turn prompt snapshots and the duplicated raw input.

**Tech Stack:** TypeScript, `node:test` + `node:assert/strict`, better-sqlite3. Build tests with `npm run build:test`; run with `node ./dist/scripts/run-tests.js <filename-substring>`. Full suite: `npm test`.

**Do not pipe verification commands in this plan through `siftkit`.** These changes touch the status server; run them raw.

---

## File Structure

| File | Responsibility |
|---|---|
| Modify `src/repo-search/logging.ts` | Delete the process-lifetime path→artifact-id map and the three dead/test-only functions it serves |
| Modify `tests/repo-search-logging.test.ts` | Drop the single assertion on the deleted path resolver; existing URI assertions stay |
| Modify `src/status-server/inference-run-recorder.ts` | New `releaseDerivedMetrics()` seam, mirroring the existing `flushDerivedMetrics()`; called from `finalize()` |
| Modify `src/status-server/llama-run-recorder.ts` | Override `releaseDerivedMetrics()` to evict the speculative tracker |
| Modify `tests/inference-run-recorder.test.ts` | Assert the tracker is gone after `finalize()` and metrics still persisted |
| Modify `src/status-server/http-utils.ts` | `readBody` settles on abort/error/close; size cap; `RequestBodyTooLargeError`; `sendBodyReadError` |
| Modify `src/status-server/routes/{core,chat,dashboard,inference-passthrough,streamed-operation-endpoint}.ts` | 22 catch blocks route through `sendBodyReadError` so oversize bodies return 413, malformed still 400 |
| Create `tests/http-utils-read-body.test.ts` | Abort settles, oversize rejects, normal body unaffected |
| Modify `src/state/inference-runs.ts` | Pending buffer becomes `string[]` per stream with running character counters |
| Modify `src/status-server/inference-run-flush-queue.ts` | High-water mark overrides the model-request flush deferral |
| Modify `tests/inference-runs.test.ts` | Buffer accumulates without concat; counters correct after partial flush |
| Modify `tests/inference-run-flush-queue.test.ts` | Over-high-water run flushes despite an active model request |
| Modify `src/summary/artifacts.ts` | Events into a dedicated array map; drop `inputText`; DB reference instead of `writeFileSync` |
| Modify `src/summary/planner/mode.ts` | Record `promptChars` instead of the whole prompt; drop `inputText` from recorder construction |
| Modify `src/config/paths.ts` | `getPlannerDebugReference(requestId)` returning the `db://` form |
| Modify `src/config/status-backend.ts` | Artifact payload types become `JsonObject`, bypassing the `toJsonObject` deep clone |
| Modify `tests/runtime-planner-mode.test.ts` | Payload carries `promptChars`, no `prompt`, no `inputText` |

**Out of scope (explicitly):** findings #1–#5 from the audit (the `toJsonObject` clone in `llm-protocol/llama-cpp-client.ts:648`, the `json_filter` O(n²) fallback, the per-tool-call input re-split, the per-file regex recompile in `find`, and the per-turn transcript tokenize). Task 6 removes the *status-backend* copy of `toJsonObject` from the artifact path only; the `llama-cpp-client.ts` copy is a separate fix. Also out of scope: routing in-process artifacts past the self-POST (audit item #6.5) — the notify contract change belongs in its own plan.

---

### Task 1: Delete the process-lifetime artifact-path map

`logPathToArtifactId` (`src/repo-search/logging.ts:19`) is a module-level `Map` with only `.get`/`.set` — one entry per repo-search log path, never evicted. Verified consumers: `moveFileSafe` and `readJsonLog` have **zero** callers anywhere in `src/`, `tests/`, `bench/`, or `scripts/`; `resolveRepoSearchLogUri` is referenced only by `tests/repo-search-logging.test.ts`. `createJsonLogger.persist()` already returns the `db://` URI and `src/repo-search/execute.ts:365,504` already capture it as `transcriptUri`. The map exists solely to serve dead and test-only code, so the fix is deletion — no cache, no eviction policy, no schema change.

**Files:**
- Modify: `src/repo-search/logging.ts:1-140`
- Test: `tests/repo-search-logging.test.ts:1-60`

- [ ] **Step 1: Drop the test's dependency on the resolver being deleted**

The two existing tests in `tests/repo-search-logging.test.ts` already assert everything that matters — that `persist()` returns a `db://` URI, that the artifact is readable at that id with the right title and content, and that a repeat `persist()` reuses the same artifact. Only the one line that exercises the doomed path resolver has to go.

Delete line 24:

```ts
    assert.equal(resolveRepoSearchLogUri(transcriptPath), transcriptUri);
```

And narrow the import on line 4 to drop `resolveRepoSearchLogUri`:

```ts
import { createJsonLogger } from '../src/repo-search/logging.js';
```

Leave everything else in the file exactly as it is, including the `withTestEnvAndServer` wrappers and the `listRuntimeArtifacts` pre-persist assertion.

- [ ] **Step 2: Build and run to verify the current state**

Run: `npm run build:test`
Expected: PASS (the test compiles; `resolveRepoSearchLogUri` is no longer imported).

Run: `node ./dist/scripts/run-tests.js repo-search-logging`
Expected: PASS — these tests describe behaviour that already works through `persistedArtifactId`. They are the safety net for the deletion in Step 3, not red tests.

- [ ] **Step 3: Delete the map and the functions it serves**

In `src/repo-search/logging.ts`, delete lines 19-44 (`logPathToArtifactId`, `normalizeLogKey`, `getArtifactIdForPath`, `setArtifactIdForPath`), delete `moveFileSafe` (lines 58-77), delete `readJsonLog` (lines 79-86), and delete `resolveRepoSearchLogUri` (the final function in the file).

Then simplify `persist` inside `createJsonLogger` so it relies only on its closure-local `persistedArtifactId`:

```ts
export function createJsonLogger(logPath: string): BufferedJsonLogger {
  const lines: string[] = [];
  let persistedArtifactId: string | null = null;
  const getText = (): string => lines.join('');
  const persist = (targetPath: string, requestId?: string | null): string => {
    const targetId = persistedArtifactId || randomUUID();
    const existing = readRuntimeArtifact(targetId);
    upsertRuntimeTextArtifact({
      id: targetId,
      artifactKind: existing?.artifactKind || 'repo_search_transcript',
      requestId: requestId ?? existing?.requestId ?? null,
      title: targetPath,
      content: getText(),
    });
    persistedArtifactId = targetId;
    return getRuntimeArtifactUri(targetId);
  };
  return {
    path: logPath,
    write(event: Record<string, JsonSerializable>): void {
      lines.push(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
    },
    getText,
    persist,
  };
}
```

Finally, prune the now-unused imports at the top of the file. After the deletions the file needs only:

```ts
import { randomUUID } from 'node:crypto';
import {
  getRuntimeArtifactUri,
  readRuntimeArtifact,
  upsertRuntimeTextArtifact,
} from '../state/runtime-artifacts.js';
import { createTracer } from '../lib/trace.js';
import type { JsonSerializable } from '../lib/json-types.js';
import type { JsonLogger } from './types.js';
```

`parseRuntimeArtifactUri` was only used by the deleted `getArtifactIdForPath`; it stays exported from `runtime-artifacts.ts` for the test and other callers.

- [ ] **Step 4: Build and run to verify nothing regressed**

Run: `npm run build:test`
Expected: PASS. If the compiler reports an unused import or an unresolved reference to a deleted function, fix it — that is the compiler proving the deletion was complete.

Run: `node ./dist/scripts/run-tests.js repo-search-logging`
Expected: PASS (both tests).

Run: `node ./dist/scripts/run-tests.js repo-search-agent-execute` and `node ./dist/scripts/run-tests.js repo-search-cli`
Expected: PASS — these exercise `execute.ts:365,504`, the only production `persist()` callers.

Run: `node ./dist/scripts/run-tests.js eslint-gate`
Expected: PASS (no unused exports or imports left behind).

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/logging.ts tests/repo-search-logging.test.ts
git commit -m "fix: drop process-lifetime repo-search artifact path map and its dead consumers"
```

---

### Task 2: Evict the speculative-metrics tracker when a run finalizes

`trackerByRunId` (`src/status-server/managed-llama-speculative-tracker.ts:95`) gains one entry per managed-llama run and never loses one — `deleteManagedLlamaSpeculativeMetricsTracker` (`:138`) is exported with zero call sites. Each tracker holds up to `MAX_LINE_CARRY_CHARACTERS` (4096) per stream plus counters, so every server restart, preset switch, and model swap leaks for the process lifetime.

The base recorder already has the exact seam for this: `finalize()` (`inference-run-recorder.ts:107`) calls the overridable `flushDerivedMetrics()`, which `LlamaRunRecorder` implements as the tracker flush. Add a matching `releaseDerivedMetrics()` and override it the same way. Eviction must happen only at `finalize()`, never at flush — `managed-llama.ts:816` flushes the tracker mid-run for the startup review and the run continues afterwards.

**Files:**
- Modify: `src/status-server/inference-run-recorder.ts:94-124`
- Modify: `src/status-server/llama-run-recorder.ts:12-24`
- Test: `tests/inference-run-recorder.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/inference-run-recorder.test.ts`. The file already defines `withRecorderDatabase`, which chdirs into a temp root (isolating the runtime DB) and hands the callback a flush queue it closes afterwards — use it as-is:

```ts
test('finalize evicts the speculative metrics tracker after persisting its metrics', async () => {
  await withRecorderDatabase(async (flushQueue) => {
    const recorder = new LlamaRunRecorder({
      backend: 'llama',
      purpose: 'tracker-eviction-test',
      entrypointPath: null,
      baseUrl: null,
      flushQueue,
    });

    recorder.appendLine(
      'engine_stderr',
      'llama_decode: statistics spec: #gen tokens = 40, #acc tokens = 30\n',
    );
    assert.ok(
      getManagedLlamaSpeculativeMetricsTracker(recorder.runId),
      'tracker must exist while the run is live',
    );

    recorder.finalize({ status: 'exited', exitCode: 0 });

    assert.equal(
      getManagedLlamaSpeculativeMetricsTracker(recorder.runId),
      null,
      'tracker must be evicted once the run has finalized',
    );

    const run = readInferenceRun(recorder.runId);
    assert.ok(run, 'run row must exist');
    assert.equal(run.speculativeGeneratedTokens, 40);
    assert.equal(run.speculativeAcceptedTokens, 30);
  });
});
```

`LlamaRunRecorder` and `readInferenceRun` are already imported by that file. Add the one missing import:

```ts
import { getManagedLlamaSpeculativeMetricsTracker } from '../src/status-server/managed-llama-speculative-tracker.js';
```

- [ ] **Step 2: Build and run to verify it fails**

Run: `npm run build:test`
Expected: PASS (test compiles).

Run: `node ./dist/scripts/run-tests.js inference-run-recorder`
Expected: FAIL on `tracker must be evicted once the run has finalized` — the tracker is still present because nothing deletes it.

- [ ] **Step 3: Add the release seam to the base recorder**

In `src/status-server/inference-run-recorder.ts`, add the new hook directly below `flushDerivedMetrics` (line 99-100):

```ts
  /**
   * Frees per-run derived-metrics state once the run is terminal. Separate from
   * flushDerivedMetrics because the flush also runs mid-run (managed-llama's
   * startup review) where the run continues and the state must survive.
   */
  protected releaseDerivedMetrics(): void {
  }
```

Then call it from `finalize()`, after `finish()` so the metrics are persisted first:

```ts
  finalize(options: {
    status: InferenceRunStatus;
    exitCode?: number | null;
    errorMessage?: string | null;
    baseUrl?: string | null;
  }): void {
    try {
      this.flush();
      this.flushDerivedMetrics();
    } catch {
      // The runtime DB may already be gone during test/process teardown.
    }
    try {
      this.finish(options);
    } catch {
      // The runtime DB may already be gone during test/process teardown.
    }
    this.releaseDerivedMetrics();
  }
```

`releaseDerivedMetrics()` sits outside the try blocks deliberately: it is a pure in-memory `Map.delete` that cannot throw, and it must run even when the DB writes above fail during teardown — that failure mode is exactly when the leak would otherwise persist.

- [ ] **Step 4: Override it in the llama recorder**

Replace `src/status-server/llama-run-recorder.ts` in full:

```ts
import { InferenceRunRecorder } from './inference-run-recorder.js';
import {
  appendManagedLlamaSpeculativeMetricsChunk,
  deleteManagedLlamaSpeculativeMetricsTracker,
  flushManagedLlamaSpeculativeMetricsTracker,
} from './managed-llama-speculative-tracker.js';
import type { InferenceRunStreamKind } from '../state/inference-runs.js';

export class LlamaRunRecorder extends InferenceRunRecorder {
  protected override observeRawChunk(streamKind: InferenceRunStreamKind, chunkText: string): void {
    appendManagedLlamaSpeculativeMetricsChunk({
      runId: this.runId,
      streamKind,
      chunkText,
    });
  }

  protected override flushDerivedMetrics(): void {
    flushManagedLlamaSpeculativeMetricsTracker(this.runId);
  }

  protected override releaseDerivedMetrics(): void {
    deleteManagedLlamaSpeculativeMetricsTracker(this.runId);
  }
}
```

Keep the existing import style of the file you are replacing — if the original imported `InferenceRunStreamKind` from a different module path, preserve that path.

- [ ] **Step 5: Build and run to verify it passes**

Run: `npm run build:test`
Expected: PASS.

Run: `node ./dist/scripts/run-tests.js inference-run-recorder`
Expected: PASS, including the new eviction test.

Run: `node ./dist/scripts/run-tests.js inference-runs` and `node ./dist/scripts/run-tests.js managed-llama-lifecycle-gate`
Expected: PASS. A queued flush that resolves after `finalize()` now gets `null` from `getManagedLlamaSpeculativeMetricsSnapshot` — that is already the declared type (`inference-run-flush-queue.ts:25`) and is correct, because `flushDerivedMetrics()` persisted the metrics synchronously before eviction.

Run: `node ./dist/scripts/run-tests.js managed-tabby`
Expected: PASS — `managed-tabby.ts:179` uses the base `InferenceRunRecorder`, whose `releaseDerivedMetrics()` is a no-op.

- [ ] **Step 6: Commit**

```bash
git add src/status-server/inference-run-recorder.ts src/status-server/llama-run-recorder.ts tests/inference-run-recorder.test.ts
git commit -m "fix: evict managed-llama speculative metrics tracker when a run finalizes"
```

---

### Task 3: Make readBody settle on abort and enforce a body cap

`readBody` (`src/status-server/http-utils.ts:12-18`) listens only for `'data'` and `'end'`. A client that disconnects mid-body never fires `'end'`, so the promise never settles: the buffered chunks and the entire route handler frame are retained for the process lifetime. There is also no `'error'` listener, so a request-stream error is an unhandled `'error'` event, and no size limit, so a runaway client can OOM the server.

The 22 call sites all follow the same shape — `try { parseJsonBody(await readBody(req)) } catch { sendJson(res, 400, <site-specific payload>) }` — but with differing payload shapes, so the classification goes into a shared helper each site delegates to, preserving its own payload.

**Files:**
- Modify: `src/status-server/http-utils.ts:12-18`
- Modify: `src/status-server/routes/core.ts` (5 sites), `routes/chat.ts` (8), `routes/dashboard.ts` (7), `routes/inference-passthrough.ts` (1), `routes/streamed-operation-endpoint.ts` (1)
- Test: Create `tests/http-utils-read-body.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/http-utils-read-body.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  RequestBodyTooLargeError,
  readBody,
} from '../src/status-server/http-utils.js';

type ReadOutcome = { ok: true; text: string } | { ok: false; error: Error };

async function startBodyServer(
  onOutcome: (outcome: ReadOutcome) => void,
  maxBytes?: number,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    readBody(req, maxBytes === undefined ? undefined : { maxBytes })
      .then((text) => {
        onOutcome({ ok: true, text });
        res.writeHead(200).end('ok');
      })
      .catch((error: Error) => {
        onOutcome({ ok: false, error });
        if (!res.writableEnded) {
          res.writeHead(500).end('err');
        }
      });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('readBody resolves normally for a complete body', async () => {
  const outcomes: ReadOutcome[] = [];
  const server = await startBodyServer((outcome) => outcomes.push(outcome));
  try {
    await new Promise<void>((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port: server.port, method: 'POST', path: '/' },
        (response) => {
          response.resume();
          response.on('end', () => resolve());
        },
      );
      request.on('error', reject);
      request.end('{"a":1}');
    });
    assert.equal(outcomes.length, 1);
    assert.deepEqual(outcomes[0], { ok: true, text: '{"a":1}' });
  } finally {
    await server.close();
  }
});

test('readBody settles with an error when the client aborts mid-body', async () => {
  const outcomes: ReadOutcome[] = [];
  const server = await startBodyServer((outcome) => outcomes.push(outcome));
  try {
    const request = http.request({
      host: '127.0.0.1',
      port: server.port,
      method: 'POST',
      path: '/',
      headers: { 'Content-Length': '1000' },
    });
    request.on('error', () => {});
    request.write('partial');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    request.destroy();

    for (let attempt = 0; attempt < 100 && outcomes.length === 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }

    assert.equal(outcomes.length, 1, 'readBody must settle instead of hanging forever');
    assert.equal(outcomes[0]?.ok, false);
  } finally {
    await server.close();
  }
});

test('readBody rejects with RequestBodyTooLargeError past the cap', async () => {
  const outcomes: ReadOutcome[] = [];
  const server = await startBodyServer((outcome) => outcomes.push(outcome), 64);
  try {
    await new Promise<void>((resolve) => {
      const request = http.request(
        { host: '127.0.0.1', port: server.port, method: 'POST', path: '/' },
        (response) => {
          response.resume();
          response.on('end', () => resolve());
        },
      );
      request.on('error', () => resolve());
      request.end('x'.repeat(512));
    });

    for (let attempt = 0; attempt < 100 && outcomes.length === 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }

    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.ok, false);
    assert.ok(
      outcomes[0]?.ok === false && outcomes[0].error instanceof RequestBodyTooLargeError,
      'oversize bodies must reject with RequestBodyTooLargeError',
    );
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: Build and run to verify it fails**

Run: `npm run build:test`
Expected: FAIL — `RequestBodyTooLargeError` is not exported from `http-utils.js`, and `readBody` takes one argument.

- [ ] **Step 3: Rewrite readBody and add the shared error responder**

In `src/status-server/http-utils.ts`, replace the `readBody` function (lines 12-18) with:

```ts
/** Default ceiling for a buffered request body. Summary input is legitimately
 * large, so this is a runaway-client backstop, not a product limit. */
const DEFAULT_MAX_REQUEST_BODY_BYTES = 256 * 1024 * 1024;

export class RequestBodyTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`Request body exceeded the ${maxBytes} byte limit.`);
    this.name = 'RequestBodyTooLargeError';
    this.maxBytes = maxBytes;
  }
}

function getMaxRequestBodyBytes(override?: number): number {
  if (Number.isFinite(override) && Number(override) > 0) {
    return Math.trunc(Number(override));
  }
  const configured = Number(process.env.SIFTKIT_MAX_REQUEST_BODY_BYTES);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.trunc(configured);
  }
  return DEFAULT_MAX_REQUEST_BODY_BYTES;
}

export function readBody(
  req: IncomingMessage,
  options: { maxBytes?: number } = {},
): Promise<string> {
  const maxBytes = getMaxRequestBodyBytes(options.maxBytes);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAborted);
      req.off('error', onError);
      req.off('close', onClose);
    };
    const settleResolve = (text: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(text);
    };
    const settleReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      chunks.length = 0;
      reject(error);
    };

    const onData = (chunk: Buffer): void => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        settleReject(new RequestBodyTooLargeError(maxBytes));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => settleResolve(Buffer.concat(chunks).toString('utf8'));
    const onAborted = (): void => settleReject(new Error('Request aborted before the body was received.'));
    const onError = (error: Error): void => settleReject(error);
    const onClose = (): void => {
      // On a complete message 'end' already ran and the `settled` guard makes this
      // inert. On a mid-body disconnect 'end' never fires, and this is what stops
      // the promise hanging forever. The `req.complete` check mirrors the existing
      // disconnect detection in server-ops.ts:630-635.
      if (req.complete) {
        return;
      }
      settleReject(new Error('Request closed before the body was received.'));
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('aborted', onAborted);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

/**
 * Shared classification for a failed body read. Oversize bodies get 413; every
 * other failure keeps the caller's existing 400 payload so route-specific error
 * shapes are preserved.
 */
export function sendBodyReadError(
  res: ServerResponse,
  error: unknown,
  badRequestPayload: JsonSerializable,
): void {
  if (error instanceof RequestBodyTooLargeError) {
    sendJson(res, 413, { error: error.message });
    return;
  }
  sendJson(res, 400, badRequestPayload);
}
```

- [ ] **Step 4: Build and run to verify the unit tests pass**

Run: `npm run build:test`
Expected: PASS.

Run: `node ./dist/scripts/run-tests.js http-utils-read-body`
Expected: PASS (all three tests).

- [ ] **Step 5: Route every call site through the shared responder**

There are 22 sites: `routes/core.ts` (5), `routes/chat.ts` (8), `routes/dashboard.ts` (7), `routes/inference-passthrough.ts` (1), `routes/streamed-operation-endpoint.ts` (1). Find them with:

```bash
grep -rn "await readBody(req)" src/status-server/
```

Every one currently reads:

```ts
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, <PAYLOAD>);
      return;
    }
```

Change each to bind the error and delegate, keeping `<PAYLOAD>` exactly as it is at that site:

```ts
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch (error) {
      sendBodyReadError(res, error, <PAYLOAD>);
      return;
    }
```

Worked example — `src/status-server/routes/core.ts:1578-1585` keeps its distinct payload:

```ts
    let parsedBody: ReturnType<typeof parseJsonBody>;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch (error) {
      sendBodyReadError(res, error, { ok: false, statusCode: 0, error: 'Expected valid JSON object.' });
      return;
    }
```

`src/status-server/routes/core.ts:1672-1679` uses `parseJsonValueText` rather than `parseJsonBody`; apply the same change to its catch block and leave the parse call alone:

```ts
    let parsedBody: JsonValue;
    try {
      parsedBody = parseJsonValueText(await readBody(req) || '{}');
    } catch (error) {
      sendBodyReadError(res, error, { error: 'Expected valid JSON object.' });
      return;
    }
```

Add `sendBodyReadError` to the existing `../http-utils.js` / `../../http-utils.js` import list in each of the five route files.

- [ ] **Step 6: Build and run the route suites**

Run: `npm run build:test`
Expected: PASS. If the compiler flags an unused `error` binding, that site's catch block was missed — every changed catch must use its bound `error`.

Run: `node ./dist/scripts/run-tests.js status-route-table`, `node ./dist/scripts/run-tests.js server-error-response`, `node ./dist/scripts/run-tests.js dashboard-status-server`, `node ./dist/scripts/run-tests.js status-server-chat`, `node ./dist/scripts/run-tests.js streamed-op-endpoints`
Expected: PASS — malformed bodies still return 400 with their original payloads.

Run: `node ./dist/scripts/run-tests.js inference-passthrough-status-server`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/status-server/http-utils.ts src/status-server/routes/ tests/http-utils-read-body.test.ts
git commit -m "fix: settle readBody on abort, cap body size, return 413 past the limit"
```

---

### Task 4: Bound the inference-log pending buffer and stop the O(n²) concat

`bufferInferenceRunLogChunk` (`src/state/inference-runs.ts:428`) rebuilds the entire accumulated per-stream string on every stdout chunk, and `getPendingChunkCharacterCount` (`:430` calling `:307`) rescans every stream on every chunk. Flushing is deliberately deferred while a model request is active (`inference-run-flush-queue.ts:236`), so a long verbose generation grows this buffer with no ceiling.

Fix: chunks accumulate in an array joined once at flush, with running character counters; and the flush queue overrides the model-request deferral once a run's pending characters cross a high-water mark, so no log data is ever dropped.

**Files:**
- Modify: `src/state/inference-runs.ts:53-54, 298-331, 357-411, 413-439, 476-507`
- Modify: `src/status-server/inference-run-flush-queue.ts:161-241`
- Test: `tests/inference-runs.test.ts`, `tests/inference-run-flush-queue.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/inference-runs.test.ts`:

```ts
test('pending log chunks accumulate with O(1) character accounting and flush intact', async () => {
  await withTestEnvAndServer(async () => {
    const run = createInferenceRun({
      backend: 'llama',
      purpose: 'pending-buffer-test',
      entrypointPath: null,
      baseUrl: null,
      status: 'running',
    });

    for (let index = 0; index < 500; index += 1) {
      bufferInferenceRunLogChunk({
        runId: run.id,
        streamKind: 'engine_stdout',
        chunkText: `line-${index}\n`,
      });
    }
    bufferInferenceRunLogChunk({
      runId: run.id,
      streamKind: 'engine_stderr',
      chunkText: 'warn\n',
    });

    const stats = getInferenceRunPendingLogChunkStats(run.id);
    assert.equal(stats.streamCount, 2);
    assert.equal(stats.characterCountByStream.engine_stderr, 'warn\n'.length);
    assert.ok(stats.totalCharacters > 0);
    assert.equal(
      stats.characterCountByStream.engine_stdout + stats.characterCountByStream.engine_stderr,
      stats.totalCharacters,
    );

    flushInferenceRunLogChunks(run.id);

    const text = readInferenceRunLogTextByStream(run.id);
    assert.match(text.engine_stdout, /^line-0\n/u);
    assert.match(text.engine_stdout, /line-499\n$/u);
    assert.equal(text.engine_stderr, 'warn\n');

    const afterFlush = getInferenceRunPendingLogChunkStats(run.id);
    assert.equal(afterFlush.totalCharacters, 0);
    assert.equal(afterFlush.streamCount, 0);
  });
});
```

Add `getInferenceRunPendingLogChunkStats` to that file's existing import from `../src/state/inference-runs.js`.

Append to `tests/inference-run-flush-queue.test.ts`:

```ts
test('a run past the pending high-water mark flushes despite an active model request', async () => {
  await withTestEnvAndServer(async () => {
    const flushQueue = new InferenceRunFlushQueue({ idleDelayMs: 60_000 });
    try {
      const run = createInferenceRun({
        backend: 'llama',
        purpose: 'high-water-test',
        entrypointPath: null,
        baseUrl: null,
        status: 'running',
      });

      flushQueue.setModelRequestState({ active: true, queueLength: 0 });

      const chunk = 'x'.repeat(64 * 1024);
      const chunkCount = Math.ceil(PENDING_FLUSH_HIGH_WATER_CHARACTERS / chunk.length) + 1;
      for (let index = 0; index < chunkCount; index += 1) {
        bufferInferenceRunLogChunk({
          runId: run.id,
          streamKind: 'engine_stdout',
          chunkText: chunk,
        });
      }

      flushQueue.enqueue(run.id, 'llama');
      await flushQueue.waitForIdle(30_000);

      const stats = getInferenceRunPendingLogChunkStats(run.id);
      assert.equal(stats.totalCharacters, 0, 'over-high-water run must flush past the deferral');

      const text = readInferenceRunLogTextByStream(run.id);
      assert.equal(text.engine_stdout.length, chunk.length * chunkCount, 'no log data may be dropped');
    } finally {
      await flushQueue.close();
    }
  });
});
```

That file already imports `InferenceRunFlushQueue`, `bufferInferenceRunLogChunk`, `createInferenceRun`, `readInferenceRunLogTextByStream`, and `withTestEnvAndServer`. Two additions are needed — add `PENDING_FLUSH_HIGH_WATER_CHARACTERS` to the existing `inference-run-flush-queue.js` import, and `getInferenceRunPendingLogChunkStats` to the existing `inference-runs.js` import:

```ts
import {
  InferenceRunFlushQueue,
  PENDING_FLUSH_HIGH_WATER_CHARACTERS,
} from '../src/status-server/inference-run-flush-queue.js';
import {
  bufferInferenceRunLogChunk,
  createInferenceRun,
  getInferenceRunPendingLogChunkStats,
  readInferenceRunLogTextByStream,
} from '../src/state/inference-runs.js';
```

- [ ] **Step 2: Build and run to verify they fail**

Run: `npm run build:test`
Expected: FAIL — `PENDING_FLUSH_HIGH_WATER_CHARACTERS` is not exported.

- [ ] **Step 3: Convert the pending buffer to chunk arrays with running counters**

In `src/state/inference-runs.ts`, replace the two module maps at lines 53-54:

```ts
const PENDING_LOG_PEAK_MIN_STREAM_CHARACTER_DELTA = 1024;

type PendingRunChunks = {
  chunksByStream: Map<InferenceRunStreamKind, string[]>;
  characterCountByStream: Map<InferenceRunStreamKind, number>;
  totalCharacters: number;
};

const pendingChunksByRunId = new Map<string, PendingRunChunks>();
const pendingLogPeakStreamCharactersByRunId = new Map<string, Map<InferenceRunStreamKind, number>>();
```

Replace `getPendingChunksForRun` and `getPendingChunkCharacterCount` (lines 298-313) with:

```ts
function getPendingChunksForRun(runId: string): PendingRunChunks {
  let pending = pendingChunksByRunId.get(runId);
  if (!pending) {
    pending = {
      chunksByStream: new Map<InferenceRunStreamKind, string[]>(),
      characterCountByStream: new Map<InferenceRunStreamKind, number>(),
      totalCharacters: 0,
    };
    pendingChunksByRunId.set(runId, pending);
  }
  return pending;
}

function clearPendingChunksForRun(runId: string): void {
  pendingChunksByRunId.delete(runId);
  pendingLogPeakStreamCharactersByRunId.delete(runId);
}

function takePendingEntries(pending: PendingRunChunks): InferenceRunPendingLogChunkEntry[] {
  const entries: InferenceRunPendingLogChunkEntry[] = [];
  for (const [streamKind, chunks] of pending.chunksByStream.entries()) {
    if (chunks.length === 0) {
      continue;
    }
    const chunkText = chunks.join('');
    if (chunkText) {
      entries.push({ streamKind, chunkText });
    }
  }
  return entries;
}
```

Replace `getInferenceRunPendingLogChunkStats` (lines 357-381) so the counters are read rather than recomputed:

```ts
export function getInferenceRunPendingLogChunkStats(runId: string): InferenceRunPendingLogChunkStats {
  const normalizedRunId = String(runId || '').trim();
  const counts = createEmptyStreamCharacterCounts();
  const pending = normalizedRunId ? pendingChunksByRunId.get(normalizedRunId) : null;
  if (!pending) {
    return {
      characterCountByStream: counts,
      totalCharacters: 0,
      streamCount: 0,
    };
  }
  let streamCount = 0;
  for (const [streamKind, characterCount] of pending.characterCountByStream.entries()) {
    counts[streamKind] = characterCount;
    streamCount += characterCount > 0 ? 1 : 0;
  }
  return {
    characterCountByStream: counts,
    totalCharacters: pending.totalCharacters,
    streamCount,
  };
}
```

Replace `consumeInferenceRunPendingLogChunks` (lines 383-397):

```ts
export function consumeInferenceRunPendingLogChunks(runId: string): InferenceRunPendingLogChunkEntry[] {
  const normalizedRunId = String(runId || '').trim();
  if (!normalizedRunId) {
    return [];
  }
  const pending = pendingChunksByRunId.get(normalizedRunId);
  if (!pending) {
    return [];
  }
  const entries = takePendingEntries(pending);
  clearPendingChunksForRun(normalizedRunId);
  return entries;
}
```

Replace `bufferInferenceRunLogChunk` (lines 413-439):

```ts
export function bufferInferenceRunLogChunk(options: {
  runId: string;
  streamKind: InferenceRunStreamKind;
  chunkText: string;
}): void {
  const runId = String(options.runId || '').trim();
  if (!runId) {
    throw new Error('Inference run id is required for log chunks.');
  }
  const chunkText = String(options.chunkText || '');
  if (!chunkText) {
    return;
  }
  const streamKind = normalizeStreamKind(options.streamKind);
  const pending = getPendingChunksForRun(runId);
  let chunks = pending.chunksByStream.get(streamKind);
  if (!chunks) {
    chunks = [];
    pending.chunksByStream.set(streamKind, chunks);
  }
  chunks.push(chunkText);
  const nextStreamCharacters = (pending.characterCountByStream.get(streamKind) ?? 0) + chunkText.length;
  pending.characterCountByStream.set(streamKind, nextStreamCharacters);
  pending.totalCharacters += chunkText.length;
  if (shouldLogPendingChunkPeak({ runId, streamKind, streamCharacters: nextStreamCharacters })) {
    logPendingChunkPeak({
      runId,
      streamKind,
      pendingCharacters: pending.totalCharacters,
      streamCharacters: nextStreamCharacters,
    });
  }
}
```

Replace `flushInferenceRunLogChunks` (lines 476-507):

```ts
export function flushInferenceRunLogChunks(runId: string, databasePath?: string): void {
  const normalizedRunId = String(runId || '').trim();
  if (!normalizedRunId) {
    return;
  }
  const pending = pendingChunksByRunId.get(normalizedRunId);
  if (!pending || pending.totalCharacters === 0) {
    clearPendingChunksForRun(normalizedRunId);
    return;
  }
  const entries = takePendingEntries(pending);
  if (entries.length === 0) {
    clearPendingChunksForRun(normalizedRunId);
    return;
  }
  const database = getDatabase(databasePath);
  database.transaction(() => {
    for (const entry of entries) {
      appendInferenceRunLogChunk({
        runId: normalizedRunId,
        streamKind: entry.streamKind,
        chunkText: entry.chunkText,
        sequence: getNextChunkSequence(database, normalizedRunId, entry.streamKind),
        databasePath,
      });
    }
  })();
  clearPendingChunksForRun(normalizedRunId);
}
```

`restoreInferenceRunPendingLogChunks` (lines 399-411) needs no change — it re-enters through `bufferInferenceRunLogChunk`.

- [ ] **Step 4: Add the high-water override to the flush queue**

In `src/status-server/inference-run-flush-queue.ts`, add the exported constant below the imports:

```ts
/** Pending characters at which a run flushes even while a model request is
 * active. The deferral exists to keep DB writes off the inference path; past
 * this point the memory cost outweighs it. No log data is dropped either way. */
export const PENDING_FLUSH_HIGH_WATER_CHARACTERS = 8 * 1024 * 1024;
```

In `drainNow`, hoist the pending stats above the deferral check and feed them in. Replace lines 168-191 (from `while (this.pendingOrder.length > 0) {` through `const waitMs = startedAtMs - item.enqueuedAtMs;`):

```ts
      while (this.pendingOrder.length > 0) {
        const nextRunId = this.pendingOrder[0];
        if (!nextRunId) {
          continue;
        }
        const item = this.pendingByRunId.get(nextRunId);
        if (!item) {
          this.pendingOrder.shift();
          continue;
        }
        const pendingStats = getInferenceRunPendingLogChunkStats(nextRunId);
        const idleWaitMs = this.getIdleWaitMs(item.enqueuedAtMs, pendingStats.totalCharacters);
        if (idleWaitMs > 0) {
          this.scheduleDrain(idleWaitMs);
          return;
        }
        const runId = this.pendingOrder.shift();
        if (!runId) {
          continue;
        }
        this.pendingByRunId.delete(runId);
        this.runningRunId = runId;
        const startedAtMs = Date.now();
        const waitMs = startedAtMs - item.enqueuedAtMs;
```

The old `const pendingStats = getInferenceRunPendingLogChunkStats(runId);` line that sat between `this.runningRunId = runId;` and `const startedAtMs` is now redundant — it is replaced by the hoisted one above, which reads the same run. Delete it.

Then replace `getIdleWaitMs` (lines 235-241):

```ts
  private getIdleWaitMs(fallbackStartedAtMs: number, pendingCharacters: number): number {
    if (pendingCharacters >= PENDING_FLUSH_HIGH_WATER_CHARACTERS) {
      return 0;
    }
    if (this.activeModelRequest || this.modelRequestQueueLength > 0) {
      return Math.max(1, Math.min(1000, this.idleDelayMs || 1000));
    }
    const lastFinishedAtMs = this.lastModelRequestFinishedAtMs ?? fallbackStartedAtMs;
    return Math.max(0, this.idleDelayMs - (Date.now() - lastFinishedAtMs));
  }
```

- [ ] **Step 5: Build and run to verify they pass**

Run: `npm run build:test`
Expected: PASS.

Run: `node ./dist/scripts/run-tests.js inference-runs`
Expected: PASS, including the new accounting test.

Run: `node ./dist/scripts/run-tests.js inference-run-flush-queue`
Expected: PASS, including the new high-water test.

Run: `node ./dist/scripts/run-tests.js inference-run-recorder`, `node ./dist/scripts/run-tests.js managed-tabby-run-history`, `node ./dist/scripts/run-tests.js managed-llama-blank-startup`
Expected: PASS — these exercise buffering and flushing end to end.

- [ ] **Step 6: Commit**

```bash
git add src/state/inference-runs.ts src/status-server/inference-run-flush-queue.ts tests/inference-runs.test.ts tests/inference-run-flush-queue.test.ts
git commit -m "fix: bound inference log pending buffer with chunk arrays and a flush high-water mark"
```

---

### Task 5: Stop the planner debug payload growing quadratically

`mode.ts:409` records the entire rendered prompt every turn. The prompt is `renderPlannerTranscript(this.messages)` — a fresh string that would otherwise be garbage right after the tokenize call, and it grows monotonically as tool results append (up to `MAX_PLANNER_TOOL_CALLS = 30` at `MAX_PLANNER_TOOL_RESULT_CHARACTERS = 12_000` each). Retained bytes are therefore `Σ prompt_N`. The content is fully derivable: `planner_tool` events (`mode.ts:1324`) already carry each tool's output and `planner_model_response` (`mode.ts:457`) each response — the transcript is those interleaved.

`artifacts.ts:80` separately retains `inputText`, which `buildSummaryRequestArtifact` (`artifacts.ts:226`) already stores. Verified: nothing in `src/status-server/dashboard-runs/` or `dashboard/src/` reads `inputText` off the planner-debug payload.

Events also move into their own typed array map, so `record()` appends instead of rebuilding the payload object and its events array on every call.

**Files:**
- Modify: `src/summary/artifacts.ts:38-99, 103-135, 268-271`
- Modify: `src/summary/planner/mode.ts:409-415, 1430-1436`
- Test: `tests/runtime-planner-mode.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/runtime-planner-mode.test.ts`:

```ts
test('planner debug payload records prompt size, not the prompt, and no duplicated input', () => {
  const requestId = 'planner-debug-shape-test';
  const recorder = createPlannerDebugRecorder({
    requestId,
    question: 'what failed?',
    inputText: 'x'.repeat(50_000),
    sourceKind: 'command-output',
    commandExitCode: 1,
    commandText: 'npm test',
  });
  try {
    recorder.record({ kind: 'planner_prompt', promptChars: 1234, promptTokenCount: 400 });
    recorder.record({ kind: 'planner_tool', toolName: 'find_text', output: { text: 'hit' } });
    recorder.finish({ status: 'completed' });

    const payload = readPlannerDebugPayload(requestId);
    assert.equal(payload.inputText, undefined, 'raw input must not be duplicated into the planner dump');
    assert.equal(payload.question, 'what failed?');

    const events = payload.events;
    assert.ok(Array.isArray(events), 'events must be an array');
    assert.equal(events.length, 2);

    const promptEvent = events[0];
    assert.ok(promptEvent && typeof promptEvent === 'object' && !Array.isArray(promptEvent));
    assert.equal(promptEvent.promptChars, 1234);
    assert.equal(promptEvent.prompt, undefined, 'the rendered prompt must not be retained per turn');
  } finally {
    clearSummaryArtifactState(requestId);
  }
});
```

Add to that file's imports:

```ts
import {
  clearSummaryArtifactState,
  createPlannerDebugRecorder,
  readPlannerDebugPayload,
} from '../src/summary/artifacts.js';
```

- [ ] **Step 2: Build and run to verify it fails**

Run: `npm run build:test`
Expected: FAIL — `createPlannerDebugRecorder` still requires `inputText` in its options type, so omitting the assertion target is not yet possible; if it compiles, the run fails on `raw input must not be duplicated into the planner dump`.

Run: `node ./dist/scripts/run-tests.js runtime-planner-mode`
Expected: FAIL on the new test.

- [ ] **Step 3: Move events to their own map and drop inputText**

In `src/summary/artifacts.ts`, replace the block from line 38 through line 99 with:

```ts
// ---------- planner debug dump (in-memory, request-scoped) ---------- //

const plannerDebugPayloadByRequestId = new Map<string, JsonObject>();
const plannerDebugEventsByRequestId = new Map<string, JsonObject[]>();
const plannerFailedArtifactByRequestId = new Set<string>();

export type SummaryDeferredArtifact = {
  artifactType: 'summary_request' | 'planner_debug' | 'planner_failed';
  artifactRequestId: string;
  artifactPayload: JsonObject;
};

export function readPlannerDebugPayload(requestId: string): JsonObject {
  const payload = plannerDebugPayloadByRequestId.get(requestId);
  if (!payload) {
    return {};
  }
  return { ...payload, events: plannerDebugEventsByRequestId.get(requestId) ?? [] };
}

export function updatePlannerDebugDump(
  requestId: string,
  update: (payload: JsonObject) => JsonObject,
): void {
  const payload = plannerDebugPayloadByRequestId.get(requestId) ?? {};
  plannerDebugPayloadByRequestId.set(requestId, update(payload));
}

export function createPlannerDebugRecorder(options: {
  requestId: string;
  question: string;
  sourceKind: SummarySourceKind;
  commandExitCode?: number | null;
  commandText?: string | null;
}): {
  record: (event: JsonObject) => void;
  finish: (result: JsonObject) => void;
} {
  plannerDebugPayloadByRequestId.set(options.requestId, {
    requestId: options.requestId,
    command: options.commandText ?? null,
    question: options.question,
    sourceKind: options.sourceKind,
    commandExitCode: options.commandExitCode ?? null,
    final: null,
  });
  plannerDebugEventsByRequestId.set(options.requestId, []);
  return {
    record(event) {
      plannerDebugEventsByRequestId.get(options.requestId)?.push(event);
    },
    finish(result) {
      updatePlannerDebugDump(options.requestId, (payload) => ({
        ...payload,
        final: result,
      }));
    },
  };
}
```

The returned `path` field is dropped: nothing reads it. Verified — every consumer of `SummaryPlannerDebugRecorder` (`mode.ts:169, 220, 365` and the `record`/`finish` call sites) uses only the two methods, and the public accessor for the dump location is `buildDeferredPlannerDebugPath`. `getPlannerDebugPath` stays imported in this file for now; `buildPlannerDebugArtifact` and `buildDeferredPlannerDebugPath` still use it until Task 6.

Update `clearSummaryArtifactState` (line 268):

```ts
export function clearSummaryArtifactState(requestId: string): void {
  plannerDebugPayloadByRequestId.delete(requestId);
  plannerDebugEventsByRequestId.delete(requestId);
  plannerFailedArtifactByRequestId.delete(requestId);
}
```

`buildPlannerDebugArtifact` reads through `readPlannerDebugPayload`, which now merges the events array in, so its `updatePlannerDebugDump` call and the `payload` it writes are unchanged apart from that.

- [ ] **Step 4: Record the prompt size instead of the prompt**

In `src/summary/planner/mode.ts`, replace the `record` call at lines 409-415:

```ts
    this.debugRecorder.record({
      kind: 'planner_prompt',
      promptChars: this.prompt.length,
      promptTokenCount: this.promptTokenCount,
      toolCallCount: this.toolResults.length,
      plannerBudget: this.promptBudget,
    });
```

And drop `inputText` from the recorder construction at lines 1430-1436:

```ts
  const debugRecorder = createPlannerDebugRecorder({
    requestId: options.requestId,
    question: options.question,
    sourceKind: options.sourceKind,
    commandExitCode: options.commandExitCode,
    commandText: options.debugCommand,
  });
```

- [ ] **Step 5: Build and run to verify it passes**

Run: `npm run build:test`
Expected: PASS. `SummaryPlannerDebugRecorder = ReturnType<typeof createPlannerDebugRecorder>` (`mode.ts:169`) tracks the shape automatically; if any code reads `.path` off the recorder, the compiler will name it.

Run: `node ./dist/scripts/run-tests.js runtime-planner-mode`
Expected: PASS, including the new shape test.

Run: `node ./dist/scripts/run-tests.js runtime-planner-mode.integration`, `node ./dist/scripts/run-tests.js runtime-planner-mode.fallbacks`, `node ./dist/scripts/run-tests.js runtime-planner-mode.tools`
Expected: PASS.

Run: `node ./dist/scripts/run-tests.js runtime-summarize` and `node ./dist/scripts/run-tests.js dashboard-status-server.run-logs`
Expected: PASS — the planner-debug artifact still persists, now without the prompt snapshots or the duplicated input.

- [ ] **Step 6: Commit**

```bash
git add src/summary/artifacts.ts src/summary/planner/mode.ts tests/runtime-planner-mode.test.ts
git commit -m "fix: stop retaining per-turn prompts and duplicated input in the planner debug dump"
```

---

### Task 6: Remove the synchronous dump write and the redundant payload clone

`buildPlannerDebugArtifact` (`artifacts.ts:127-129`) does `mkdirSync` + `writeFileSync(JSON.stringify(payload, null, 2))` on the status-server's only thread — the planner runs in-process (`engine-service.ts:30`). The file is redundant: the same payload is persisted to `run_logs.planner_debug_json` (`artifact-upserts.ts:218`), and `buildDeferredPlannerDebugPath` (`artifacts.ts:147`) already treats the in-memory map as an equally valid source. The codebase is already migrating file artifacts to `db://` references (`repo-search/logging.ts`, `runtime-artifacts.ts:89`).

Separately, `status-backend.ts:380` wraps the artifact payload in `toJsonObject` — `parseJsonObjectText(JSON.stringify(value))`, a stringify → parse → recursive-Zod deep clone whose result is immediately re-stringified into the HTTP body. It exists to convert an untyped `object` into `JsonObject`; the artifact payloads are already `JsonObject` (`SummaryDeferredArtifact`), so typing the option correctly removes the clone entirely. `toolStats` and `deferredMetadata` keep `toJsonObject` — those are genuinely untyped `object` inputs and are small.

**Files:**
- Modify: `src/config/paths.ts:111-113`
- Modify: `src/summary/artifacts.ts:1-8, 103-151`
- Modify: `src/config/status-backend.ts:226-232, 353-382`
- Test: `tests/runtime-planner-mode.test.ts`, `tests/runtime-summarize.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/runtime-planner-mode.test.ts`:

The assertion touches the real logs directory, so it runs inside `withTempEnv` — the helper every other test in this file already uses, which chdirs into a temp root so `getRuntimeLogsPath()` resolves off the developer's `~/.siftkit`:

```ts
test('planner debug artifact persists without writing a dump file', async () => {
  await withTempEnv(async () => {
    const requestId = 'planner-debug-no-file-test';
    const recorder = createPlannerDebugRecorder({
      requestId,
      question: 'what failed?',
      sourceKind: 'command-output',
      commandExitCode: 1,
      commandText: 'npm test',
    });
    try {
      recorder.record({ kind: 'planner_tool', toolName: 'find_text', output: { text: 'hit' } });

      const artifact = buildPlannerDebugArtifact({
        requestId,
        finalOutput: 'the build failed',
        classification: 'command_failure',
        rawReviewRequired: true,
      });

      assert.ok(artifact, 'artifact must be produced');
      assert.equal(artifact.artifactType, 'planner_debug');
      assert.equal(artifact.artifactRequestId, requestId);

      const final = artifact.artifactPayload.final;
      assert.ok(final && typeof final === 'object' && !Array.isArray(final));
      assert.equal(final.finalOutput, 'the build failed');

      assert.equal(
        existsSync(getPlannerDebugPath(requestId)),
        false,
        'planner debug must not write a file; run_logs is the store',
      );
      assert.match(buildDeferredPlannerDebugPath(requestId) || '', /^db:\/\/run-logs\//u);
    } finally {
      clearSummaryArtifactState(requestId);
    }
  });
});
```

Extend that file's imports. `withTempEnv` is already imported (line 20) and the `artifacts.js` block was added in Task 5 — add the two new named exports to that existing block rather than writing a second import statement:

```ts
import { existsSync } from 'node:fs';
import {
  buildDeferredPlannerDebugPath,
  buildPlannerDebugArtifact,
  clearSummaryArtifactState,
  createPlannerDebugRecorder,
  readPlannerDebugPayload,
} from '../src/summary/artifacts.js';
import { getPlannerDebugPath } from '../src/config/paths.js';
```

- [ ] **Step 2: Build and run to verify it fails**

Run: `npm run build:test`
Expected: PASS (test compiles).

Run: `node ./dist/scripts/run-tests.js runtime-planner-mode`
Expected: FAIL on `planner debug must not write a file; run_logs is the store`.

- [ ] **Step 3: Add the reference helper and drop the file write**

In `src/config/paths.ts`, add directly below `getPlannerDebugPath` (line 113):

```ts
/**
 * Reference to a planner debug dump. The payload lives in
 * `run_logs.planner_debug_json` keyed by request id; this is the human-facing
 * pointer used in error messages and the summary_request artifact. Mirrors the
 * `db://` convention used for repo-search transcripts and runtime artifacts.
 */
export function getPlannerDebugReference(requestId: string): string {
  return `db://run-logs/${requestId}/planner-debug`;
}
```

`getPlannerDebugPath` stays — `artifact-upserts.ts:376-380` still needs it to migrate pre-existing dump files off disk.

In `src/summary/artifacts.ts`, replace the imports at lines 1-8 with exactly:

```ts
import { appendFileSync } from 'node:fs';
import { createTracer } from '../lib/trace.js';
import type { JsonObject } from '../lib/json-types.js';
import {
  getPlannerDebugReference,
  getPlannerFailedPath,
} from '../config/paths.js';
import { getRecord } from './planner/json-filter.js';
```

`mkdirSync`, `writeFileSync`, and `dirname` go with the deleted file write; `existsSync` goes with the rewritten `buildDeferredPlannerDebugPath` below; `getPlannerDebugPath` is replaced by `getPlannerDebugReference`. `appendFileSync` stays — `appendTestProviderEvent` still uses it.

Replace `buildPlannerDebugArtifact` lines 123-135 (from `const payload = readPlannerDebugPayload(...)` to the closing brace):

```ts
  const payload = readPlannerDebugPayload(options.requestId);
  if (Object.keys(payload).length === 0) {
    return null;
  }
  return {
    artifactType: 'planner_debug',
    artifactRequestId: options.requestId,
    artifactPayload: payload,
  };
```

Replace `buildDeferredPlannerDebugPath` (lines 147-151):

```ts
export function buildDeferredPlannerDebugPath(requestId: string): string | null {
  return plannerDebugPayloadByRequestId.has(requestId)
    ? getPlannerDebugReference(requestId)
    : null;
}
```

`createPlannerDebugRecorder` needs no change in this task — Task 5 already removed its `path` field, so `getPlannerDebugReference` is referenced only from `buildDeferredPlannerDebugPath`.

- [ ] **Step 4: Type the artifact payload so the clone is unnecessary**

In `src/config/status-backend.ts`, change the two option types at lines 226 and 228-232:

```ts
  artifactPayload?: JsonObject | null;
  deferredMetadata?: object | null;
  deferredArtifacts?: Array<{
    artifactType: 'summary_request' | 'planner_debug' | 'planner_failed';
    artifactRequestId: string;
    artifactPayload: JsonObject;
  }> | null;
```

Confirm `JsonObject` is in the file's imports from `../lib/json-types.js`; it already imports `MutableJsonObject` from there, so add `JsonObject` to that same import.

Then drop the clone at line 355:

```ts
    body.artifactPayload = options.artifactPayload;
```

and at line 379-380:

```ts
      .map((artifact) => ({
        artifactType: artifact.artifactType,
        artifactRequestId: artifact.artifactRequestId.trim(),
        artifactPayload: artifact.artifactPayload,
      }));
```

Leave `toJsonObject` in place and still used at lines 312 (`toolStats`) and 362 (`deferredMetadata`) — those take untyped `object` and are small.

- [ ] **Step 5: Build and run to verify it passes**

Run: `npm run build:test`
Expected: PASS. The compiler will flag any caller passing a non-`JsonObject` into `artifactPayload`; `SummaryDeferredArtifact.artifactPayload` is already `JsonObject`, so the summary path compiles unchanged.

Run: `node ./dist/scripts/run-tests.js runtime-planner-mode`
Expected: PASS, including the new no-file test.

Run: `node ./dist/scripts/run-tests.js runtime-summarize`
Expected: PASS.

Run: `node ./dist/scripts/run-tests.js dashboard-status-server.run-logs` and `node ./dist/scripts/run-tests.js dashboard-run-log-admin`
Expected: PASS — `run_logs.planner_debug_json` is still populated through `upsertRunArtifactPayload`; only the redundant file and the redundant clone are gone.

Run: `node ./dist/scripts/run-tests.js status-running-wake` and `node ./dist/scripts/run-tests.js processed-input-metrics`
Expected: PASS — these exercise `notifyStatusBackend` payload construction.

- [ ] **Step 6: Commit**

```bash
git add src/config/paths.ts src/summary/artifacts.ts src/config/status-backend.ts tests/runtime-planner-mode.test.ts
git commit -m "fix: drop synchronous planner dump file and redundant artifact payload clone"
```

---

### Task 7: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck and lint**

Run: `npm run typecheck`
Expected: PASS across every project (`src`, scripts, dashboard, bench, tests, analysis) plus ESLint.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: PASS.

Watch for these specific risk points:
- Tests that construct `createPlannerDebugRecorder` with `inputText` — the compiler catches them; delete the field.
- Tests asserting a planner debug file exists on disk — they now assert on the `db://run-logs/...` reference instead.
- Tests importing `moveFileSafe`, `readJsonLog`, or `resolveRepoSearchLogUri` — those functions are gone; the only such importer was `tests/repo-search-logging.test.ts`, corrected in Task 1.
- Tests calling `readBody(req)` directly — the second parameter is optional, so existing calls compile unchanged.
- Contract tests pinning the `deferredArtifacts` body shape (`tests/contracts-*.test.ts`) — the wire shape is unchanged; only the TypeScript option type narrowed.

- [ ] **Step 3: Confirm the leak fixes hold under a real server run**

Run: `npm run build`

Start the server, drive one summary through the planner path with a large input, and confirm no planner dump file appears:

```bash
node ./dist/status-server/index.js
```

In a second shell:

```bash
node -e "const s='line\n'.repeat(200000);require('fs').writeFileSync('tmp/planner-input.txt',s)"
node ./bin/siftkit.js summary --file tmp/planner-input.txt --question "what is in this file?"
ls ~/.siftkit/logs/planner_debug_*.json
```

Expected: the summary completes; `ls` reports no matching files. Confirm the run is visible in the dashboard Runs tab with its planner_debug event present.

Clean up: `rm -f tmp/planner-input.txt`

- [ ] **Step 4: Commit any test fixups**

```bash
git add -A
git commit -m "test: align suites with memory and leak fixes"
```

---

## Self-Review Notes

**Coverage against the five findings:**

| Finding | Task | Mechanism |
|---|---|---|
| #6 planner dump quadratic + sync write | 5, 6 | `promptChars` instead of `prompt`; `inputText` dropped; events in a dedicated array; file write deleted; payload clone bypassed |
| #7 `trackerByRunId` never evicted | 2 | `releaseDerivedMetrics()` seam called from `finalize()` |
| #8 `logPathToArtifactId` never cleared | 1 | Map and its three dead/test-only consumers deleted |
| #9 `readBody` never settles on abort | 3 | Settles on `aborted`/`error`/`close`; size cap; 413 via shared responder |
| #10 unbounded O(n²) pending buffer | 4 | Chunk arrays + running counters; high-water mark overrides flush deferral |

**Cross-task type consistency:** `createPlannerDebugRecorder` returns `{ record, finish }` from Task 5 Step 3 onward — the `path` field is dropped there and Task 6 does not touch the recorder. `PENDING_FLUSH_HIGH_WATER_CHARACTERS` is exported from `inference-run-flush-queue.ts` in Task 4 Step 4 and imported by its test in Task 4 Step 1. `getPlannerDebugReference` is defined in Task 6 Step 3 and referenced by the test in Task 6 Step 1. `sendBodyReadError` and `RequestBodyTooLargeError` are both exported from `http-utils.ts` in Task 3 Step 3 before their use in Step 5. `getInferenceRunPendingLogChunkStats` keeps its existing `InferenceRunPendingLogChunkStats` return shape in Task 4 — only its implementation changes from rescan to counter read, so the flush queue's existing `pendingStats.totalCharacters` / `.streamCount` reads are unaffected.

**Test helpers used (each verified against the file it is used in):** Task 1 keeps the `withTestEnvAndServer` wrappers already in `tests/repo-search-logging.test.ts`. Task 2 uses `withRecorderDatabase`, defined inside `tests/inference-run-recorder.test.ts` over `withTempEnv`. Task 4 uses `withTestEnvAndServer`, already imported by both `tests/inference-runs.test.ts` and `tests/inference-run-flush-queue.test.ts`. Task 6 uses `withTempEnv`, already imported by `tests/runtime-planner-mode.test.ts` (line 20) — that file does **not** import `withTestEnvAndServer`. Task 5's new test is pure in-memory state with no filesystem or DB access, so it needs no wrapper; it cleans up via `clearSummaryArtifactState` in a `finally`. Task 3's new test starts its own `http.createServer` and needs neither.

**Deliberately unchanged:** `getPlannerDebugPath` stays in `config/paths.ts` for the legacy file→DB migration at `artifact-upserts.ts:376-380`. `toJsonObject` stays in `status-backend.ts` for `toolStats` and `deferredMetadata`. `restoreInferenceRunPendingLogChunks` keeps its entry-based signature and re-enters through `bufferInferenceRunLogChunk`.

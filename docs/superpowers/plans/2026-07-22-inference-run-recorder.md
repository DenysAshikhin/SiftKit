# Inference Run Recorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract run recording (run row, stream capture, storage filtering, flush queueing, terminal status) out of `managed-llama.ts`'s free functions into a reusable `InferenceRunRecorder` class, migrate llama.cpp onto it, and use it to give managed TabbyAPI real run history in place of its truncate-on-every-spawn file log.

**Architecture:** One base class owns everything both backends do identically. llama.cpp's only unique behaviour — scraping speculative-decode counters out of the raw pre-filter stream — becomes a single protected hook overridden by `LlamaRunRecorder`; no callbacks are passed anywhere. Process lifecycle stays where it is: llama's spawn path remains `ServerContext` free functions, Tabby's remains `ManagedTabbyRuntime`. The recorder is the shared unit, not the lifecycle.

**Tech Stack:** TypeScript (ESM, NodeNext), better-sqlite3, Zod runtime schemas, `node:test` via `dist/scripts/run-tests.js`.

---

## Prerequisites

This plan consumes `src/state/inference-runs.ts`, which is produced by **Tasks 1–2 of `2026-07-22-backend-neutral-inference-run-history.md`**. Do not start until those have landed and `npm run build:test` succeeds. Specifically, this plan assumes these exist and are exported from `src/state/inference-runs.ts`:

| Export | Kind |
|---|---|
| `InferenceRunBackend` (`'llama' \| 'exl3'`) | type |
| `InferenceRunStatus` (`'running' \| 'ready' \| 'failed' \| 'stopped' \| 'sync_completed'`) | type |
| `InferenceRunStreamKind` (`'launcher_stdout' \| 'launcher_stderr' \| 'engine_stdout' \| 'engine_stderr' \| 'startup_review' \| 'startup_failure'`) | type |
| `createInferenceRun({ backend, purpose, entrypointPath, baseUrl, status })` | function |
| `updateInferenceRun({ id, status, exitCode?, errorMessage?, finishedAtUtc?, baseUrl? })` | function |
| `bufferInferenceRunLogChunk({ runId, streamKind, chunkText })` | function |
| `flushInferenceRunLogChunks(runId)` | function |
| `readInferenceRunLogTextByStream(runId, options?)` | function |
| `readInferenceRunLogTextStatsByStream(runId, options?)` | function |
| `updateInferenceRunSpeculativeMetrics({ runId, ... })` | function |
| `readInferenceRun(id, databasePath?)` | function |
| `listInferenceRuns({ limit?, status?, backend?, databasePath? })` | function |

## Background: what was verified against the current tree

These were each confirmed by reading the file at `main` = `97ed9c5`. Four of them correct or sharpen claims made in the parent plan — read this section before writing code.

1. Run recording today is four free functions plus a plain-data struct threaded through every call: `createManagedLlamaLogRun`, `enqueueManagedLlamaLogFlush`, `appendManagedLlamaLogLine`, `attachStreamCollector` at [managed-llama.ts:535-619](../../../src/status-server/managed-llama.ts#L535-L619), with `MANAGED_STDOUT_STREAM` / `MANAGED_STDERR_STREAM` constants at [:535-536](../../../src/status-server/managed-llama.ts#L535-L536).
2. `attachStreamCollector` takes an `onProgress?: (chars: number) => void` callback ([:582](../../../src/status-server/managed-llama.ts#L582)), which violates the repo's no-dynamically-passed-functions rule. The recorder owns the counters instead.
3. **Correction to the parent plan.** It claims every remaining `ManagedLlamaLogRef` consumer "only ever reads `.runId`". False — `writeManagedLlamaStartupReviewDump` reads `logRef.purpose` at [:907](../../../src/status-server/managed-llama.ts#L907). The recorder must therefore expose a public `purpose`. `scriptPath` and `baseUrl` on the ref are never read by anyone, so they are dropped.
4. **Landmine the parent plan understates.** `ManagedLlamaSpeculativeMetricsTracker.appendChunk` branches on the *literal* stream-kind strings at [managed-llama-speculative-tracker.ts:33-39](../../../src/status-server/managed-llama-speculative-tracker.ts#L33-L39) and `return`s early on anything unrecognised. Renaming the stream kinds without updating those literals makes every speculative metric silently go to zero, with no error. Task 2 Step 1 fixes this first, on purpose.
5. `progress` is `ChildOutputProgress = { stdoutChars, stderrChars }` ([managed-llama.ts:805](../../../src/status-server/managed-llama.ts#L805)) and is read by `waitForManagedLlamaStartup` at [:1035](../../../src/status-server/managed-llama.ts#L1035) and [:1058-1066](../../../src/status-server/managed-llama.ts#L1058-L1066). The recorder exposes exactly that shape under exactly those field names so no consumer changes.
6. `SpawnedScript` at [server-types.ts:80](../../../src/status-server/server-types.ts#L80) is dead — its only occurrence in `src/` is its own definition. It is deleted alongside `ManagedLlamaLogRef`.
7. **Test that will break.** [tests/managed-tabby.test.ts:14-16](../../../tests/managed-tabby.test.ts#L14-L16) asserts `ManagedTabbyRuntime.length === 1`. Adding a required `flushQueue` parameter makes it `2`. That assertion is updated, not deleted — it exists to pin the constructor contract.
8. **Test isolation gap.** `tests/managed-tabby.test.ts` never chdirs into a temp root and never calls `getRuntimeDatabase`, unlike the `withTempEnv` harness in [tests/_runtime-helpers.ts:981-1038](../../../tests/_runtime-helpers.ts#L981-L1038). Once `ManagedTabbyRuntime` records runs, every `Managed: true` test in that file writes to whatever `getRuntimeDatabasePath()` resolves to from the repo cwd — the developer's real `.siftkit/runtime.sqlite`. Task 3 Step 4 fixes this before the recorder is wired in.
9. `ManagedTabbyRuntime` currently writes both streams with `fs.appendFileSync` to `<getManagedTabbyLogRoot()>/latest-startup.log`, truncated on every spawn ([managed-tabby.ts:42](../../../src/status-server/managed-tabby.ts#L42), [:176-177](../../../src/status-server/managed-tabby.ts#L176-L177), [:265-267](../../../src/status-server/managed-tabby.ts#L265-L267)). `assertDraftingActive` ([:251-259](../../../src/status-server/managed-tabby.ts#L251-L259)) is that file's only reader.
10. `assertDraftingActive` is only reachable when `shouldManage(preset)` is true ([:235](../../../src/status-server/managed-tabby.ts#L235)), i.e. only when a process was spawned, so a recorder always exists by the time it runs.
11. `readInferenceRunLogTextByStream` merges the in-memory pending buffer with persisted chunks, so no explicit flush is needed before reading it.
12. **`npx rg` does not work in this repo.** It resolves to an unrelated npm package called `rg` (a README generator), not ripgrep. Use your editor/agent's own search tool for the sweep steps.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/status-server/inference-run-recorder.ts` | Run row + stream capture + filter + flush + terminal status | Create |
| `src/status-server/llama-run-recorder.ts` | llama-only speculative scrape override | Create |
| [src/status-server/managed-llama-speculative-tracker.ts](../../../src/status-server/managed-llama-speculative-tracker.ts) | Speculative counter scraping | Retype + fix literal stream kinds |
| [src/status-server/managed-llama.ts](../../../src/status-server/managed-llama.ts) | llama.cpp process management | Delete 4 free functions, use `LlamaRunRecorder` |
| [src/status-server/server-types.ts](../../../src/status-server/server-types.ts) | Shared context/types | Delete `ManagedLlamaLogRef` + `SpawnedScript`, retype `LogEntry` |
| [src/status-server/managed-tabby.ts](../../../src/status-server/managed-tabby.ts) | TabbyAPI process management | Use `InferenceRunRecorder`, drop the file log |
| [src/status-server/index.ts](../../../src/status-server/index.ts) | Wiring | Pass the flush queue to `ManagedTabbyRuntime` |
| [src/status-server/paths.ts](../../../src/status-server/paths.ts) | Path helpers | Delete `getManagedTabbyLogRoot` if it loses its last caller |
| `tests/inference-run-recorder.test.ts` | Recorder unit behaviour | Create |
| [tests/managed-tabby.test.ts](../../../tests/managed-tabby.test.ts) | Tabby lifecycle | Update arity assertion + 8 construction sites + DB isolation |
| `tests/managed-tabby-run-history.test.ts` | E2E: a Tabby launch produces a run row + chunks | Create |

---

### Task 1: The reusable recorder

**Files:**
- Create: `src/status-server/inference-run-recorder.ts`
- Test: `tests/inference-run-recorder.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/inference-run-recorder.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { InferenceRunRecorder } from '../src/status-server/inference-run-recorder.js';
import { ManagedLlamaFlushQueue } from '../src/status-server/managed-llama-flush-queue.js';
import { readInferenceRun, readInferenceRunLogTextByStream } from '../src/state/inference-runs.js';
import { getRuntimeDatabase, closeRuntimeDatabase } from '../src/state/runtime-db.js';

function withRecorderDatabase<R>(fn: (flushQueue: ManagedLlamaFlushQueue) => Promise<R>): Promise<R> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-recorder-'));
  getRuntimeDatabase(path.join(root, 'runtime.sqlite'));
  const flushQueue = new ManagedLlamaFlushQueue({ idleDelayMs: 0 });
  return fn(flushQueue).finally(async () => {
    await flushQueue.close();
    closeRuntimeDatabase();
    fs.rmSync(root, { recursive: true, force: true });
  });
}

test('the recorder captures a run row, its stream text, and its terminal status', async () => {
  await withRecorderDatabase(async (flushQueue) => {
    const recorder = new InferenceRunRecorder({
      backend: 'exl3',
      purpose: 'startup',
      entrypointPath: 'C:/tabby/main.py',
      baseUrl: 'http://127.0.0.1:8098',
      flushQueue,
    });

    const stdout = new PassThrough();
    recorder.attachEngineStdout(stdout);
    stdout.write('loading model\n');
    stdout.end();
    recorder.flush();

    assert.equal(readInferenceRunLogTextByStream(recorder.runId).engine_stdout, 'loading model\n');
    assert.equal(readInferenceRun(recorder.runId)?.status, 'running');
    assert.equal(readInferenceRun(recorder.runId)?.backend, 'exl3');

    recorder.finish({ status: 'ready' });
    assert.equal(readInferenceRun(recorder.runId)?.status, 'ready');
  });
});

test('the recorder counts stdout and stderr characters separately', async () => {
  await withRecorderDatabase(async (flushQueue) => {
    const recorder = new InferenceRunRecorder({
      backend: 'llama',
      purpose: 'startup',
      entrypointPath: null,
      baseUrl: null,
      flushQueue,
    });

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    recorder.attachLauncherStdout(stdout);
    recorder.attachLauncherStderr(stderr);
    stdout.write('abc');
    stderr.write('de');
    stdout.end();
    stderr.end();

    assert.equal(recorder.progress.stdoutChars, 3);
    assert.equal(recorder.progress.stderrChars, 2);
  });
});

test('a failed run records its exit code and error message', async () => {
  await withRecorderDatabase(async (flushQueue) => {
    const recorder = new InferenceRunRecorder({
      backend: 'exl3',
      purpose: 'startup',
      entrypointPath: null,
      baseUrl: null,
      flushQueue,
    });

    recorder.appendLine('engine_stderr', 'boom\n');
    recorder.flush();
    recorder.finish({ status: 'failed', exitCode: 3, errorMessage: 'boom' });

    const run = readInferenceRun(recorder.runId);
    assert.equal(run?.status, 'failed');
    assert.equal(run?.exitCode, 3);
    assert.equal(run?.errorMessage, 'boom');
    assert.equal(readInferenceRunLogTextByStream(recorder.runId).engine_stderr, 'boom\n');
  });
});

test('a null stream is ignored rather than throwing', async () => {
  await withRecorderDatabase(async (flushQueue) => {
    const recorder = new InferenceRunRecorder({
      backend: 'llama',
      purpose: 'shutdown',
      entrypointPath: null,
      baseUrl: null,
      flushQueue,
    });

    recorder.attachEngineStdout(null);
    recorder.attachEngineStderr(null);
    assert.equal(recorder.progress.stdoutChars, 0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run build:test
node .\dist\scripts\run-tests.js inference-run-recorder
```

Expected: FAIL — `src/status-server/inference-run-recorder.ts` does not exist.

- [ ] **Step 3: Write the recorder**

Create `src/status-server/inference-run-recorder.ts`:

```ts
import { ManagedLlamaLogStorageFilter } from './managed-llama-log-storage-filter.js';
import { ManagedLlamaFlushQueue } from './managed-llama-flush-queue.js';
import {
  bufferInferenceRunLogChunk,
  createInferenceRun,
  flushInferenceRunLogChunks,
  updateInferenceRun,
  type InferenceRunBackend,
  type InferenceRunStatus,
  type InferenceRunStreamKind,
} from '../state/inference-runs.js';

export type InferenceRunRecorderOptions = {
  backend: InferenceRunBackend;
  purpose: string;
  entrypointPath: string | null;
  baseUrl: string | null;
  flushQueue: ManagedLlamaFlushQueue;
};

/**
 * Field names match what `waitForManagedLlamaStartup` already reads, so the startup
 * stall detector needs no changes when llama moves onto the recorder.
 */
export type InferenceRunStreamProgress = {
  stdoutChars: number;
  stderrChars: number;
};

export class InferenceRunRecorder {
  readonly runId: string;
  readonly backend: InferenceRunBackend;
  readonly purpose: string;
  readonly baseUrl: string | null;
  readonly progress: InferenceRunStreamProgress = { stdoutChars: 0, stderrChars: 0 };
  private readonly flushQueue: ManagedLlamaFlushQueue;
  private flushEnabled = false;

  constructor(options: InferenceRunRecorderOptions) {
    this.backend = options.backend;
    this.purpose = options.purpose;
    this.baseUrl = options.baseUrl;
    this.flushQueue = options.flushQueue;
    this.runId = createInferenceRun({
      backend: options.backend,
      purpose: options.purpose,
      entrypointPath: options.entrypointPath,
      baseUrl: options.baseUrl,
      status: 'running',
    }).id;
  }

  /** Chunk flushes are queued only once the server is ready to drain them. */
  enableFlushQueue(): void {
    this.flushEnabled = true;
  }

  attachEngineStdout(stream: NodeJS.ReadableStream | null): void {
    this.attach(stream, 'engine_stdout');
  }

  attachEngineStderr(stream: NodeJS.ReadableStream | null): void {
    this.attach(stream, 'engine_stderr');
  }

  attachLauncherStdout(stream: NodeJS.ReadableStream | null): void {
    this.attach(stream, 'launcher_stdout');
  }

  attachLauncherStderr(stream: NodeJS.ReadableStream | null): void {
    this.attach(stream, 'launcher_stderr');
  }

  /**
   * llama.cpp reports speculative-decode acceptance only in its stdout/stderr, and only in
   * the raw stream before the storage filter drops the request echo. The base recorder has
   * nothing to scrape; LlamaRunRecorder overrides this.
   */
  protected observeRawChunk(streamKind: InferenceRunStreamKind, chunkText: string): void {
    void streamKind;
    void chunkText;
  }

  appendLine(streamKind: InferenceRunStreamKind, text: string): void {
    this.observeRawChunk(streamKind, text);
    bufferInferenceRunLogChunk({ runId: this.runId, streamKind, chunkText: text });
    this.enqueueFlush();
  }

  flush(): void {
    flushInferenceRunLogChunks(this.runId);
  }

  finish(options: {
    status: InferenceRunStatus;
    exitCode?: number | null;
    errorMessage?: string | null;
    baseUrl?: string | null;
  }): void {
    updateInferenceRun({
      id: this.runId,
      status: options.status,
      exitCode: options.exitCode ?? null,
      errorMessage: options.errorMessage ?? null,
      finishedAtUtc: new Date().toISOString(),
      baseUrl: options.baseUrl ?? this.baseUrl,
    });
  }

  private enqueueFlush(): void {
    if (!this.flushEnabled) {
      return;
    }
    this.flushQueue.enqueue(this.runId);
  }

  private countProgress(streamKind: InferenceRunStreamKind, characters: number): void {
    if (streamKind === 'engine_stdout' || streamKind === 'launcher_stdout') {
      this.progress.stdoutChars += characters;
      return;
    }
    this.progress.stderrChars += characters;
  }

  private attach(stream: NodeJS.ReadableStream | null, streamKind: InferenceRunStreamKind): void {
    if (!stream) {
      return;
    }
    const storageFilter = new ManagedLlamaLogStorageFilter();
    stream.setEncoding?.('utf8');
    stream.on('data', (chunk: string | Buffer) => {
      try {
        const chunkText = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        this.countProgress(streamKind, chunkText.length);
        this.observeRawChunk(streamKind, chunkText);
        const filteredChunkText = storageFilter.filterChunk(chunkText);
        if (filteredChunkText) {
          bufferInferenceRunLogChunk({ runId: this.runId, streamKind, chunkText: filteredChunkText });
          this.enqueueFlush();
        }
      } catch {
        // Ignore teardown races after the runtime DB has already closed.
      }
    });
    stream.on('error', (error: Error) => {
      try {
        this.appendLine(streamKind, `\n[stream-error] ${error.message}\n`);
      } catch {
        // Ignore teardown races after the runtime DB has already closed.
      }
    });
  }
}
```

- [ ] **Step 4: Run the test**

```bash
npm run build:test
node .\dist\scripts\run-tests.js inference-run-recorder
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/status-server/inference-run-recorder.ts tests/inference-run-recorder.test.ts
git commit -m "feat: add reusable InferenceRunRecorder for backend-neutral run capture"
```

---

### Task 2: Move llama.cpp onto the recorder

**Files:**
- Create: `src/status-server/llama-run-recorder.ts`
- Modify: [src/status-server/managed-llama-speculative-tracker.ts:1-49](../../../src/status-server/managed-llama-speculative-tracker.ts#L1-L49), [:97-101](../../../src/status-server/managed-llama-speculative-tracker.ts#L97-L101)
- Modify: [src/status-server/managed-llama.ts:535-619](../../../src/status-server/managed-llama.ts#L535-L619), [:805-869](../../../src/status-server/managed-llama.ts#L805-L869), [:875-882](../../../src/status-server/managed-llama.ts#L875-L882), [:1241-1277](../../../src/status-server/managed-llama.ts#L1241-L1277)
- Modify: [src/status-server/server-types.ts:60-84](../../../src/status-server/server-types.ts#L60-L84), [:146](../../../src/status-server/server-types.ts#L146)

- [ ] **Step 1: Retype the speculative tracker and fix its literal stream kinds**

This is first because it is the silent-failure risk. In [managed-llama-speculative-tracker.ts](../../../src/status-server/managed-llama-speculative-tracker.ts), change the import at lines 1-4:

```ts
import {
  updateInferenceRunSpeculativeMetrics,
  type InferenceRunStreamKind,
} from '../state/inference-runs.js';
```

Replace every remaining `ManagedLlamaStreamKind` in the file with `InferenceRunStreamKind` (lines 26, 28, 99), replace the `updateManagedLlamaRunSpeculativeMetrics` call at line 129 with `updateInferenceRunSpeculativeMetrics`, and replace the stream-kind branch at lines 33-39 with:

```ts
    if (streamKind === 'launcher_stdout' || streamKind === 'engine_stdout') {
      this.stdoutCharacterCount += normalizedChunk.length;
    } else if (streamKind === 'launcher_stderr' || streamKind === 'engine_stderr') {
      this.stderrCharacterCount += normalizedChunk.length;
    } else {
      return;
    }
```

Leaving the old literals here compiles cleanly and makes every speculative metric silently zero.

- [ ] **Step 2: Write the llama subclass**

Create `src/status-server/llama-run-recorder.ts`:

```ts
import { InferenceRunRecorder } from './inference-run-recorder.js';
import { appendManagedLlamaSpeculativeMetricsChunk } from './managed-llama-speculative-tracker.js';
import type { InferenceRunStreamKind } from '../state/inference-runs.js';

/**
 * llama.cpp reports speculative-decode acceptance only in its stdout/stderr, and only in the
 * raw stream before the storage filter drops the request echo. Scrape it on the way past.
 */
export class LlamaRunRecorder extends InferenceRunRecorder {
  protected override observeRawChunk(streamKind: InferenceRunStreamKind, chunkText: string): void {
    appendManagedLlamaSpeculativeMetricsChunk({
      runId: this.runId,
      streamKind,
      chunkText,
    });
  }
}
```

- [ ] **Step 3: Delete the superseded free functions**

Delete [managed-llama.ts:535-619](../../../src/status-server/managed-llama.ts#L535-L619) entirely — `MANAGED_STDOUT_STREAM`, `MANAGED_STDERR_STREAM`, `createManagedLlamaLogRun`, `enqueueManagedLlamaLogFlush`, `appendManagedLlamaLogLine` and `attachStreamCollector`. All six are now the recorder's job.

Also delete the now-duplicated `ChildOutputProgress` type at [:805](../../../src/status-server/managed-llama.ts#L805); the recorder exports the same shape as `InferenceRunStreamProgress`.

- [ ] **Step 4: Fix the imports at the top of `managed-llama.ts`**

Remove `ManagedLlamaLogRef` from the `./server-types.js` type import at [:41](../../../src/status-server/managed-llama.ts#L41). From the `../state/managed-llama-runs.js` import, drop `createManagedLlamaRun`, `updateManagedLlamaRun`, `bufferManagedLlamaLogChunk`, `flushManagedLlamaLogChunks` and `ManagedLlamaStreamKind`; point the rest at `../state/inference-runs.js` under their new names. Add:

```ts
import { LlamaRunRecorder } from './llama-run-recorder.js';
import type { InferenceRunStreamProgress } from './inference-run-recorder.js';
import type { InferenceRunStatus, InferenceRunStreamKind } from '../state/inference-runs.js';
```

- [ ] **Step 5: Rewrite `spawnManagedLlamaProcess`**

Replace [managed-llama.ts:807-869](../../../src/status-server/managed-llama.ts#L807-L869) with:

```ts
function spawnManagedLlamaProcess(
  ctx: ServerContext,
  managed: ReturnType<typeof getManagedLlamaConfig>,
  purpose: string,
): { child: ChildProcess; recorder: LlamaRunRecorder } {
  const invocation = getManagedExecutableInvocation(ctx, managed);
  const recorder = new LlamaRunRecorder({
    backend: 'llama',
    purpose,
    entrypointPath: invocation.resolvedPath,
    baseUrl: managed.BaseUrl,
    flushQueue: ctx.managedLlamaFlushQueue,
  });
  if (ctx.managedLlamaReady) {
    recorder.enableFlushQueue();
  }
  const child = spawn(invocation.filePath, invocation.args, {
    cwd: invocation.cwd,
    env: {
      ...process.env,
      SIFTKIT_LLAMA_VERBOSE_LOGGING: managed.VerboseLogging ? '1' : '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: false,
  });
  recorder.attachLauncherStdout(child.stdout);
  recorder.attachLauncherStderr(child.stderr);
  child.on('exit', (code: number | null) => {
    try {
      recorder.flush();
      flushManagedLlamaSpeculativeMetricsTracker(recorder.runId);
    } catch {
      // The runtime DB may already be gone during test/process teardown.
    }
    const successStatus: InferenceRunStatus = purpose === 'shutdown' ? 'stopped' : 'ready';
    try {
      recorder.finish({
        status: (code ?? 0) === 0 ? successStatus : 'failed',
        exitCode: Number.isFinite(code) ? Number(code) : null,
      });
    } catch {
      // The runtime DB may already be gone during test/process teardown.
    }
  });
  child.on('error', (error: Error) => {
    try {
      recorder.appendLine('launcher_stderr', `\n[spawn-error] ${error.message}\n`);
      recorder.flush();
      flushManagedLlamaSpeculativeMetricsTracker(recorder.runId);
    } catch {
      // Ignore teardown races after the test/server has already closed.
    }
    try {
      recorder.finish({ status: 'failed', errorMessage: error.message });
    } catch {
      // Ignore teardown races after the test/server has already closed.
    }
    process.stderr.write(`[siftKitStatus] llama.cpp ${purpose} executable failed to spawn (${managed.ExecutablePath}): ${error.message}\n`);
  });
  return { child, recorder };
}
```

The llama launcher is a script that in turn runs llama-server, so its piped stdio is `launcher_*`. `engine_*` is reserved for TabbyAPI, whose piped stdio is the engine itself.

- [ ] **Step 6: Update the stream-kind source list**

Replace the `sources` array in `collectManagedLlamaLogEntries` at [managed-llama.ts:877-882](../../../src/status-server/managed-llama.ts#L877-L882):

```ts
  const sources: Array<[string, InferenceRunStreamKind]> = [
    ['launcher_stdout', 'launcher_stdout'],
    ['launcher_stderr', 'launcher_stderr'],
    ['engine_stdout', 'engine_stdout'],
    ['engine_stderr', 'engine_stderr'],
  ];
```

- [ ] **Step 7: Retype the remaining `logRef` consumers**

Six functions take a `ManagedLlamaLogRef`. Change each parameter to `recorder: LlamaRunRecorder` (keeping `| null` where it already exists) and rename the parameter from `logRef` to `recorder` throughout each body:

| Function | Line | Reads |
|---|---|---|
| `getManagedLlamaPrimaryStreamText` | [:290](../../../src/status-server/managed-llama.ts#L290) | `.runId` |
| `getManagedLlamaLogCursor` | [:344](../../../src/status-server/managed-llama.ts#L344) | `.runId` |
| `captureManagedLlamaSpeculativeMetricsSnapshot` | [:355](../../../src/status-server/managed-llama.ts#L355) | `.runId` |
| `getManagedLlamaSpeculativeMetricsSince` | [:375](../../../src/status-server/managed-llama.ts#L375) | `.runId` |
| `getManagedLlamaSpeculativeMetricsDelta` | [:393](../../../src/status-server/managed-llama.ts#L393) | `.runId` |
| `collectManagedLlamaLogEntries` | [:875](../../../src/status-server/managed-llama.ts#L875) | `.runId` |

`writeManagedLlamaStartupReviewDump` at [:902](../../../src/status-server/managed-llama.ts#L902) additionally reads `.purpose` at [:907](../../../src/status-server/managed-llama.ts#L907) — the recorder exposes it as a public readonly field, so `recorder.purpose` works unchanged.

- [ ] **Step 8: Update the startup path**

At [managed-llama.ts:1241-1277](../../../src/status-server/managed-llama.ts#L1241-L1277), `launched.logRef` becomes `launched.recorder` and `launched.progress` becomes `launched.recorder.progress`. Replace the ready-path `updateManagedLlamaRun` block at [:1248-1252](../../../src/status-server/managed-llama.ts#L1248-L1252) with:

```ts
      launched.recorder.finish({ status: 'ready', baseUrl });
```

and the failure-path block at [:1272-1277](../../../src/status-server/managed-llama.ts#L1272-L1277) with:

```ts
      launched.recorder.finish({ status: 'failed', errorMessage, baseUrl });
```

- [ ] **Step 9: Clean up `server-types.ts`**

Delete `ManagedLlamaLogRef` ([:60-65](../../../src/status-server/server-types.ts#L60-L65)) and `SpawnedScript` ([:80](../../../src/status-server/server-types.ts#L80)). Retype `LogEntry` at [:84](../../../src/status-server/server-types.ts#L84):

```ts
export type LogEntry = { label: string; streamKind: InferenceRunStreamKind; text: string; matchingLines: string[] };
```

and `managedLlamaLastStartupLogs` at [:146](../../../src/status-server/server-types.ts#L146):

```ts
  managedLlamaLastStartupLogs: LlamaRunRecorder | null;
```

Add the two imports the file now needs:

```ts
import type { LlamaRunRecorder } from './llama-run-recorder.js';
import type { InferenceRunStreamKind } from '../state/inference-runs.js';
```

- [ ] **Step 10: Typecheck**

```bash
npm run typecheck:test
```

Expected: exit 0. The compiler is the checklist for this task — fix every error before moving on. Do not silence one with a cast; the repo bans type assertions.

- [ ] **Step 11: Run the llama tests**

```bash
npm run build:test
node .\dist\scripts\run-tests.js managed-llama
node .\dist\scripts\run-tests.js dashboard-status-server.run-logs
```

Expected: PASS. Any test asserting on the literal strings `startup_script_stdout`, `startup_script_stderr`, `llama_stdout` or `llama_stderr` must be updated to the new kind — that is the intended rename, not a regression. Search `tests/` for those four strings and fix each hit.

- [ ] **Step 12: Commit**

```bash
git add src/status-server/llama-run-recorder.ts src/status-server/inference-run-recorder.ts src/status-server/managed-llama.ts src/status-server/managed-llama-speculative-tracker.ts src/status-server/server-types.ts tests/
git commit -m "refactor: record managed llama runs through LlamaRunRecorder"
```

---

### Task 3: Record managed Tabby runs

**Files:**
- Modify: [src/status-server/managed-tabby.ts](../../../src/status-server/managed-tabby.ts), [src/status-server/index.ts:266](../../../src/status-server/index.ts#L266)
- Modify: [tests/managed-tabby.test.ts](../../../tests/managed-tabby.test.ts) (arity assertion, 8 construction sites, DB isolation)
- Test: `tests/managed-tabby-run-history.test.ts` (create)

- [ ] **Step 1: Move the fake-Tabby writer into the shared helper**

`writeFakeTabby` in [tests/managed-tabby.test.ts:122-189](../../../tests/managed-tabby.test.ts#L122-L189) already prints `INFO: Using main model MTP component for drafting` to stdout when `TABBY_DRAFT_MODEL_DRAFT_MODE === 'mtp'`, which is exactly what the new test needs. Do **not** import it from the `.test.ts` file — the runner discovers tests by file, so importing one test file from another re-registers its whole suite.

Cut the `FakeTabbyFiles` interface and the `writeFakeTabby` function ([tests/managed-tabby.test.ts:109-189](../../../tests/managed-tabby.test.ts#L109-L189)) verbatim into [tests/helpers/tabby-fake.ts](../../../tests/helpers/tabby-fake.ts) next to the existing `FakeTabbyModelState`, exporting both:

```ts
export interface FakeTabbyFiles {
```

```ts
export function writeFakeTabby(
```

`tabby-fake.ts` needs `import fs from 'node:fs';` and `import path from 'node:path';` if it does not already have them. Then in `managed-tabby.test.ts`, delete those lines and add `writeFakeTabby` to its existing import from `./helpers/tabby-fake.js`.

- [ ] **Step 2: Write the failing E2E test**

Create `tests/managed-tabby-run-history.test.ts`:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { ManagedLlamaFlushQueue } from '../src/status-server/managed-llama-flush-queue.js';
import { ManagedTabbyRuntime } from '../src/status-server/managed-tabby.js';
import { listInferenceRuns, readInferenceRunLogTextByStream } from '../src/state/inference-runs.js';
import { getRuntimeDatabase, closeRuntimeDatabase } from '../src/state/runtime-db.js';
import { getFreePort } from './_runtime-helpers.js';
import { writeFakeTabby } from './helpers/tabby-fake.js';

test('a managed TabbyAPI launch is recorded as an inference run with log chunks', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-tabby-run-history-'));
  const databasePath = path.join(root, 'runtime.sqlite');
  getRuntimeDatabase(databasePath);
  const port = await getFreePort();
  const { scriptPath } = writeFakeTabby(root, port, null);
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  const flushQueue = new ManagedLlamaFlushQueue({ idleDelayMs: 0 });
  const runtime = new ManagedTabbyRuntime({
    Managed: true,
    WorkingDirectory: root,
    PythonPath: process.execPath,
    Entrypoint: path.basename(scriptPath),
    ModelRoot: root,
    AdminApiKey: '',
    ShutdownTimeoutMs: 5_000,
  }, flushQueue);
  try {
    await runtime.ensurePresetReady({
      ...preset,
      Backend: 'exl3' as const,
      BaseUrl: `http://127.0.0.1:${port}`,
      Model: 'model-a',
      ModelPath: path.join(root, 'model-a'),
      SpeculativeEnabled: true,
      SpeculativeType: 'draft-mtp' as const,
    });

    const runs = listInferenceRuns({ backend: 'exl3', databasePath });
    assert.equal(runs.length, 1, 'exactly one exl3 run must be recorded');
    assert.equal(runs[0].status, 'ready');
    assert.equal(runs[0].purpose, 'startup');

    const streams = readInferenceRunLogTextByStream(runs[0].id);
    assert.match(streams.engine_stdout, /Using main model MTP component for drafting/u);
  } finally {
    await runtime.stopProcess();
    await flushQueue.close();
    closeRuntimeDatabase();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a managed TabbyAPI run is marked stopped when the runtime shuts it down', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-tabby-run-stopped-'));
  const databasePath = path.join(root, 'runtime.sqlite');
  getRuntimeDatabase(databasePath);
  const port = await getFreePort();
  const { scriptPath } = writeFakeTabby(root, port, null);
  const preset = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!preset) throw new Error('Default model preset is missing');
  const flushQueue = new ManagedLlamaFlushQueue({ idleDelayMs: 0 });
  const runtime = new ManagedTabbyRuntime({
    Managed: true,
    WorkingDirectory: root,
    PythonPath: process.execPath,
    Entrypoint: path.basename(scriptPath),
    ModelRoot: root,
    AdminApiKey: '',
    ShutdownTimeoutMs: 5_000,
  }, flushQueue);
  try {
    await runtime.ensurePresetReady({
      ...preset,
      Backend: 'exl3' as const,
      BaseUrl: `http://127.0.0.1:${port}`,
      Model: 'model-a',
      ModelPath: path.join(root, 'model-a'),
    });
    await runtime.stopProcess();

    const runs = listInferenceRuns({ backend: 'exl3', databasePath });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'stopped');
  } finally {
    await flushQueue.close();
    closeRuntimeDatabase();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
npm run build:test
node .\dist\scripts\run-tests.js managed-tabby-run-history
```

Expected: FAIL — `ManagedTabbyRuntime` takes no second constructor argument, and `listInferenceRuns({ backend: 'exl3' })` returns `[]`.

- [ ] **Step 4: Isolate the runtime database in the existing Tabby tests**

`tests/managed-tabby.test.ts` never chdirs to a temp root, so once the runtime records runs, its `Managed: true` tests would write to the repo's real `.siftkit/runtime.sqlite`. In each of the four tests that pass `Managed: true` — at [:191](../../../tests/managed-tabby.test.ts#L191), [:253](../../../tests/managed-tabby.test.ts#L253), [:284](../../../tests/managed-tabby.test.ts#L284), [:347](../../../tests/managed-tabby.test.ts#L347) — add a `getRuntimeDatabase` call immediately after the existing `mkdtempSync`, and a `closeRuntimeDatabase()` in the `finally` block before `fs.rmSync`. Add the import:

```ts
import { getRuntimeDatabase, closeRuntimeDatabase } from '../src/state/runtime-db.js';
```

and in each of those four tests:

```ts
  getRuntimeDatabase(path.join(root, 'runtime.sqlite'));
```

The `external EXL3 preset does not launch...` test at [:379](../../../tests/managed-tabby.test.ts#L379) uses `Managed: true` but asserts nothing launches, so it needs the same isolation.

- [ ] **Step 5: Update the constructor-arity assertion and every construction site**

[tests/managed-tabby.test.ts:14-16](../../../tests/managed-tabby.test.ts#L14-L16) pins the constructor contract and must move to 2:

```ts
test('ManagedTabbyRuntime construction requires engine configuration and a flush queue', () => {
  assert.equal(ManagedTabbyRuntime.length, 2);
});
```

Then add a `ManagedLlamaFlushQueue` as the second argument to all seven remaining `new ManagedTabbyRuntime(` calls in the file — at [:65](../../../tests/managed-tabby.test.ts#L65), [:94](../../../tests/managed-tabby.test.ts#L94), [:211](../../../tests/managed-tabby.test.ts#L211), [:259](../../../tests/managed-tabby.test.ts#L259), [:300](../../../tests/managed-tabby.test.ts#L300), [:325](../../../tests/managed-tabby.test.ts#L325), [:431](../../../tests/managed-tabby.test.ts#L431) — closing each one in the test's `finally`. Import it:

```ts
import { ManagedLlamaFlushQueue } from '../src/status-server/managed-llama-flush-queue.js';
```

Search `src/` and `tests/` for any other `new ManagedTabbyRuntime` and update those too.

- [ ] **Step 6: Give `ManagedTabbyRuntime` a recorder**

In [managed-tabby.ts](../../../src/status-server/managed-tabby.ts), replace the `fs` / `path` / `getManagedTabbyLogRoot` imports at [:2-3](../../../src/status-server/managed-tabby.ts#L2-L3) and [:12](../../../src/status-server/managed-tabby.ts#L12) with:

```ts
import { InferenceRunRecorder } from './inference-run-recorder.js';
import type { ManagedLlamaFlushQueue } from './managed-llama-flush-queue.js';
import { readInferenceRunLogTextByStream } from '../state/inference-runs.js';
```

Replace the `logPath` field at [:27](../../../src/status-server/managed-tabby.ts#L27):

```ts
  private recorder: InferenceRunRecorder | null = null;
```

and the constructor at [:36-43](../../../src/status-server/managed-tabby.ts#L36-L43):

```ts
  constructor(
    private readonly engine: Exl3EngineConfig,
    private readonly flushQueue: ManagedLlamaFlushQueue,
    private readonly client = new TabbyModelClient(engine.AdminApiKey),
  ) {
    super('exl3');
    this.adapter = new Exl3PresetAdapter(engine.ModelRoot);
  }
```

Delete the `appendLog` method at [:265-267](../../../src/status-server/managed-tabby.ts#L265-L267).

- [ ] **Step 7: Record the spawn**

Replace `spawnProcess` at [managed-tabby.ts:173-201](../../../src/status-server/managed-tabby.ts#L173-L201):

```ts
  private spawnProcess(launchEnvironment: Exl3LaunchEnvironment): void {
    this.stopping = false;
    this.startupError = null;
    const recorder = new InferenceRunRecorder({
      backend: 'exl3',
      purpose: 'startup',
      entrypointPath: this.engine.Entrypoint,
      baseUrl: null,
      flushQueue: this.flushQueue,
    });
    recorder.enableFlushQueue();
    this.recorder = recorder;
    const child = spawn(this.engine.PythonPath, [this.engine.Entrypoint], {
      cwd: this.engine.WorkingDirectory,
      env: { ...process.env, ...launchEnvironment },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    recorder.attachEngineStdout(child.stdout);
    recorder.attachEngineStderr(child.stderr);
    child.once('error', (error) => {
      this.startupError = error;
      recorder.flush();
      recorder.finish({ status: 'failed', errorMessage: error.message });
      this.transitionProcessTo('failed');
    });
    child.once('exit', (code, signal) => {
      const exitMessage = `TabbyAPI exited unexpectedly (code=${String(code)}, signal=${String(signal)}).`;
      recorder.flush();
      recorder.finish({
        status: this.stopping ? 'stopped' : 'failed',
        exitCode: Number.isFinite(code) ? Number(code) : null,
        errorMessage: this.stopping ? null : exitMessage,
      });
      if (this.stopping) return;
      this.startupError = new Error(exitMessage);
      this.processBaseUrl = null;
      this.processManaged = null;
      this.processSignature = null;
      this.transitionModelTo('unloaded');
      this.transitionProcessTo('failed');
    });
  }
```

- [ ] **Step 8: Mark the run ready and read the startup log from the database**

In `waitForProcess`, immediately before `this.transitionProcessTo('ready');` at [managed-tabby.ts:219](../../../src/status-server/managed-tabby.ts#L219):

```ts
          this.recorder?.finish({ status: 'ready', baseUrl });
```

Replace `assertDraftingActive` at [:251-259](../../../src/status-server/managed-tabby.ts#L251-L259):

```ts
  private assertDraftingActive(preset: ModelRuntimePreset): void {
    const runId = this.recorder?.runId;
    const startupLog = runId ? readInferenceRunLogTextByStream(runId).engine_stdout : '';
    if (!startupLog.includes('Using main model MTP component for drafting')) {
      throw new Error(
        `Preset '${preset.id}' requires MTP drafting, but the TabbyAPI startup log never reported the MTP draft `
        + 'component loading. Decode speed would be silently halved.',
      );
    }
  }
```

`readInferenceRunLogTextByStream` merges the in-memory pending buffer with persisted chunks, so no explicit flush is needed here.

Add `this.recorder = null;` alongside the other field resets in `stopProcess` — both the early-return block at [:130-137](../../../src/status-server/managed-tabby.ts#L130-L137) and the normal path at [:149-156](../../../src/status-server/managed-tabby.ts#L149-L156) — and in `stopForProcessExitSync` at [:163-170](../../../src/status-server/managed-tabby.ts#L163-L170).

- [ ] **Step 9: Wire the flush queue at construction**

At [index.ts:266](../../../src/status-server/index.ts#L266):

```ts
  const managedTabbyRuntime = new ManagedTabbyRuntime(
    initialConfig.Server.Engines.Exl3,
    ctx.managedLlamaFlushQueue,
  );
```

`ctx.managedLlamaFlushQueue` is already constructed at [index.ts:260](../../../src/status-server/index.ts#L260), above this line, so no reordering is needed.

- [ ] **Step 10: Run the Tabby tests**

```bash
npm run build:test
node .\dist\scripts\run-tests.js managed-tabby
node .\dist\scripts\run-tests.js managed-tabby-run-history
```

Expected: PASS, including the pre-existing `managed Tabby rejects a speculative preset when the startup log never reports MTP drafting` test at [:347](../../../tests/managed-tabby.test.ts#L347) — it now exercises `assertDraftingActive` against the database instead of the file, and must still reject.

- [ ] **Step 11: Delete the superseded log path helper**

Search `src/` for `latest-startup.log` and `getManagedTabbyLogRoot`. Expected: no hits in `managed-tabby.ts`. If `getManagedTabbyLogRoot` in [paths.ts](../../../src/status-server/paths.ts) now has no callers anywhere in `src/` or `tests/`, delete the function and any import of it.

- [ ] **Step 12: Full verification**

```bash
npm run typecheck
npm test
```

Expected: exit 0, all tests pass.

- [ ] **Step 13: Commit**

```bash
git add src/status-server/managed-tabby.ts src/status-server/index.ts src/status-server/paths.ts tests/managed-tabby.test.ts tests/managed-tabby-run-history.test.ts
git commit -m "feat: record managed TabbyAPI runs in inference run history"
```

---

## Deliberate non-goals

- **Speculative metrics for EXL3.** `speculative_accepted_tokens` / `speculative_generated_tokens` stay NULL for `backend='exl3'`. Those columns are populated by scraping llama.cpp's stdout counters; TabbyAPI's startup log has no equivalent. Per-request speculative data for EXL3 already arrives through the provider `usage` payload and reaches `runtime_metrics_totals` via the normal status path.
- **Moving process lifecycle into `ManagedInferenceRuntime`.** llama's spawn path is driven by `ServerContext` free functions across a 1510-line module. The recorder is the shared unit; unifying the lifecycle is a rewrite with no payoff here.
- **Retention and dashboard call sites.** `dashboard-runs/deletion.ts` and `routes/dashboard.ts` still reference the old table and filter names. Those are Task 6 of the parent plan and are out of scope here; `npm test` in Task 3 Step 11 will not pass until that task lands, so run these three tasks and Task 6 in the same branch.

# SiftKit Self-Call Deadlock Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the status-server deadlock where a `run` command executed *inside* a repo-agent run spawns a `siftkit` CLI that calls back into the same server and parks forever behind the model lock its own parent run holds (see `docs/superpowers/handoffs/2026-07-23-repo-agent-siftkit-selfcall-deadlock.md`).

**Architecture:** Three layers. (1) The engine stamps every `run`/command child process with `SIFTKIT_AGENT_RUN_ID=<requestId>` via a new env option on `spawnPowerShellAsync`. (2) The CLI dispatch checks the marker before touching the server: `summary` degrades to a passthrough (banner + raw stdin, exit 0) so piped plan commands still work; `repo-search`, `repo-agent`, `run`, and `eval` fail fast with a deadlock explanation. (3) Defense-in-depth: the CLI attaches the marker as an `x-siftkit-agent-run-id` header on all streamed operations, the model lock records its owner's requestId, and streamed endpoints reject a request whose marker matches the active lock owner with HTTP 409 instead of queueing it into a 15-minute dead wait.

**Tech Stack:** TypeScript, `node:test` + `node:assert/strict`, existing test harnesses (`tests/helpers/streamed-op-harness.ts`, `tests/helpers/sse-http.ts`). Build with `npm run build:test`; run tests with `node ./dist/scripts/run-tests.js <filename-substring>`.

**IMPORTANT — do not pipe any verification command in this plan through `siftkit`. Run them raw.** (This plan fixes the very deadlock those pipes cause; the server may be mid-agent-run while you work.)

---

## File Structure

| File | Responsibility |
|---|---|
| Create `src/lib/agent-run-marker.ts` | Single source of truth: env var name, header name, `readNestedAgentRunId()` |
| Modify `src/lib/powershell.ts` | `env` option on `spawnPowerShellAsync` |
| Modify `src/repo-search/engine/repo-tools.ts` | `RepoToolContext.agentRunId` (required); `executeRun` stamps the env marker |
| Modify `src/repo-search/engine/command-execution.ts` | `executeRepoCommand` takes `agentRunId`, stamps the env marker |
| Modify `src/repo-search/engine/tool-action-processor.ts` | Pass `this.deps.task.id` as `agentRunId` at both call sites |
| Modify `src/cli/args.ts` | `MODEL_LOCK_COMMANDS` set |
| Modify `src/cli/dispatch.ts` | Nested-run guard before server preflight |
| Modify `src/cli/run-summary.ts` | Passthrough mode when nested |
| Modify `src/lib/http-client.ts` | `headers` option on `streamSse` |
| Modify `src/cli/status-server-api-client.ts` | Attach marker header on streamed operations |
| Modify `src/lib/operation-stream.ts` | `ownerRunId` in `ModelRequestQueueDiagnosticsSchema.activeRequest` |
| Modify `src/status-server/server-types.ts` | `ownerRunId` on `ModelRequestLock`, `ModelRequestWaiter`, `ModelRequestWaitOptions` |
| Modify `src/status-server/server-ops.ts` | Plumb `ownerRunId` through acquire/queue/grant/diagnostics |
| Modify `src/status-server/routes/streamed-operation-endpoint.ts` | `lockOwnerRunId()` hook; 409 self-call rejection |
| Modify `src/status-server/routes/core.ts` | `RepoTaskEndpoint.lockOwnerRunId` returns `admission.requestId` |
| Modify `tests/helpers/sse-http.ts` | `headers` option on `requestSse` |
| Modify `tests/repo-tools.test.ts` | `agentRunId` in `makeContext`; env-propagation test |
| Create `tests/nested-agent-guard.test.ts` | CLI-layer guard tests (passthrough + fail-fast) |
| Create `tests/nested-agent-server-reject.test.ts` | Server E2E: 409 on self-lineage, normal queueing otherwise |

Out of scope (explicitly): guarding non-model server commands (`config-get`, `install`, `preset list` — they never take the model lock); releasing the model lock during tool execution (handoff fix 2 — separate architectural change).

---

### Task 1: Marker module + env stamping on spawned commands

**Files:**
- Create: `src/lib/agent-run-marker.ts`
- Modify: `src/lib/powershell.ts:50-66`
- Modify: `src/repo-search/engine/repo-tools.ts:53-60` (RepoToolContext), `:666-682` (executeRun)
- Modify: `src/repo-search/engine/command-execution.ts:23-70`
- Modify: `src/repo-search/engine/tool-action-processor.ts:476-483`, `:560-562`
- Test: `tests/repo-tools.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/repo-tools.test.ts`, first extend `makeContext` (line 43) so the compile-required new field exists everywhere:

```ts
function makeContext(root: string) {
  return {
    repoRoot: root,
    ignorePolicy: buildIgnorePolicy(root),
    webTools: makeWebTools(),
    expandReads: true,
    agentRunId: 'test-run',
  };
}
```

Then append the new test at the end of the file:

```ts
test('executeRun exposes SIFTKIT_AGENT_RUN_ID to spawned commands', async () => {
  const root = makeRepo();
  const context = { ...makeContext(root), agentRunId: 'run-abc-123' };
  const result = await executeRepoTool('run', { command: 'Write-Output $env:SIFTKIT_AGENT_RUN_ID' }, context);
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.trim(), 'run-abc-123');
});
```

- [ ] **Step 2: Run build to verify it fails**

Run: `npm run build:test`
Expected: FAIL — `agentRunId` does not exist on `RepoToolContext` (object literal may only specify known properties).

- [ ] **Step 3: Create the marker module**

Create `src/lib/agent-run-marker.ts`:

```ts
/**
 * Marker identifying processes spawned from inside a repo-agent run. The
 * engine sets the env var on every `run`/command child; the CLI refuses (or
 * degrades) server calls when it is present, and forwards it as a header so
 * the server can reject self-lineage requests instead of deadlocking.
 */
export const AGENT_RUN_ID_ENV = 'SIFTKIT_AGENT_RUN_ID';
export const AGENT_RUN_ID_HEADER = 'x-siftkit-agent-run-id';

export function readNestedAgentRunId(): string | null {
  const value = (process.env[AGENT_RUN_ID_ENV] || '').trim();
  return value ? value : null;
}
```

- [ ] **Step 4: Add the env option to spawnPowerShellAsync**

In `src/lib/powershell.ts`, extend `PowerShellAsyncOptions` (line 50):

```ts
export type PowerShellAsyncOptions = {
  cwd?: string;
  windowsHide?: boolean;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  env?: Record<string, string>;
};
```

And in `spawnPowerShellAsync` (line 62), add the env to the spawn call:

```ts
    const child = spawn(POWERSHELL_EXECUTABLE, [...POWERSHELL_BASE_ARGS, '-Command', command], {
      cwd: options.cwd,
      windowsHide: options.windowsHide ?? true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
    });
```

- [ ] **Step 5: Stamp the marker in the engine**

In `src/repo-search/engine/repo-tools.ts`:

Add the import at the top (alongside the other `../../lib/` imports):

```ts
import { AGENT_RUN_ID_ENV } from '../../lib/agent-run-marker.js';
```

Add the required field to `RepoToolContext` (line 53):

```ts
export type RepoToolContext = {
  repoRoot: string;
  ignorePolicy: IgnorePolicy;
  webTools: WebResearchTools;
  fileReadStateByPath?: Map<string, FileReadState>;
  abortSignal?: AbortSignal;
  expandReads: boolean;
  agentRunId: string;
};
```

In `executeRun` (line 673), stamp the child env:

```ts
  const result = await spawnPowerShellAsync(commandText, {
    cwd: context.repoRoot,
    abortSignal: context.abortSignal,
    timeoutMs: timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000,
    env: { [AGENT_RUN_ID_ENV]: context.agentRunId },
  });
```

In `src/repo-search/engine/command-execution.ts`, add the same import, add a required `agentRunId` parameter, and stamp the fallback command path (line 23 and 66):

```ts
import { AGENT_RUN_ID_ENV } from '../../lib/agent-run-marker.js';

export function executeRepoCommand(
  command: string,
  repoRoot: string,
  mockCommandResults: Record<string, RepoSearchMockCommandResult> | null,
  agentRunId: string,
  abortSignal?: AbortSignal,
): Promise<{ exitCode: number; output: string }> {
```

```ts
  return spawnPowerShellAsync(command, {
    cwd: repoRoot,
    env: { [AGENT_RUN_ID_ENV]: agentRunId },
  }).then((result) => ({
    exitCode: result.exitCode,
    output: result.output,
  }));
```

In `src/repo-search/engine/tool-action-processor.ts`, update both call sites (`task.id` **is** the server-side requestId — `execute.ts:284` builds the task with `id: requestId`):

Line 476 (`runNativeExecution`):

```ts
    return executeRepoTool(normalizedToolName, toolAction.args, {
      repoRoot: this.deps.repoRoot,
      ignorePolicy: this.deps.ignorePolicy,
      webTools: this.deps.webTools,
      fileReadStateByPath: this.deps.readWindows.stateMap,
      abortSignal: this.deps.abortSignal,
      expandReads: isReadExpansionEnabled(this.deps.config),
      agentRunId: this.deps.task.id,
    });
```

Line 562 (fallback command execution):

```ts
      : await executeRepoCommand(commandToRun, this.deps.repoRoot, this.deps.mockCommandResults || null, this.deps.task.id, this.deps.abortSignal);
```

- [ ] **Step 6: Build and run the test to verify it passes**

Run: `npm run build:test`
Expected: PASS (the compiler will surface any remaining `RepoToolContext` construction sites — fix each by passing the real run id, or `'test-run'` in tests).

Run: `node ./dist/scripts/run-tests.js repo-tools`
Expected: PASS, including `executeRun exposes SIFTKIT_AGENT_RUN_ID to spawned commands`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/agent-run-marker.ts src/lib/powershell.ts src/repo-search/engine/repo-tools.ts src/repo-search/engine/command-execution.ts src/repo-search/engine/tool-action-processor.ts tests/repo-tools.test.ts
git commit -m "feat: stamp SIFTKIT_AGENT_RUN_ID on commands spawned by agent runs"
```

---

### Task 2: CLI guard — summary passthrough, fail-fast for lock-taking commands

**Files:**
- Modify: `src/cli/args.ts:90-101`
- Modify: `src/cli/dispatch.ts:26-75`
- Modify: `src/cli/run-summary.ts`
- Test: Create `tests/nested-agent-guard.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/nested-agent-guard.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { runCli } from '../src/cli/index.js';
import { AGENT_RUN_ID_ENV } from '../src/lib/agent-run-marker.js';
import { makeCaptureStream } from './_test-helpers.js';

async function runGuardedCli(argv: string[], stdinText?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const previous = process.env[AGENT_RUN_ID_ENV];
  const previousBackend = process.env.SIFTKIT_STATUS_BACKEND_URL;
  const previousConfig = process.env.SIFTKIT_CONFIG_SERVICE_URL;
  process.env[AGENT_RUN_ID_ENV] = 'run-guard-1';
  // Point at a dead port: any accidental server contact fails loudly.
  process.env.SIFTKIT_STATUS_BACKEND_URL = 'http://127.0.0.1:9/status';
  process.env.SIFTKIT_CONFIG_SERVICE_URL = 'http://127.0.0.1:9/config';
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  try {
    const code = await runCli({ argv, stdout: stdout.stream, stderr: stderr.stream, stdinText });
    return { code, stdout: stdout.read(), stderr: stderr.read() };
  } finally {
    if (previous === undefined) delete process.env[AGENT_RUN_ID_ENV]; else process.env[AGENT_RUN_ID_ENV] = previous;
    if (previousBackend === undefined) delete process.env.SIFTKIT_STATUS_BACKEND_URL; else process.env.SIFTKIT_STATUS_BACKEND_URL = previousBackend;
    if (previousConfig === undefined) delete process.env.SIFTKIT_CONFIG_SERVICE_URL; else process.env.SIFTKIT_CONFIG_SERVICE_URL = previousConfig;
  }
}

test('nested summary passes stdin through raw with a banner and no server contact', async () => {
  const result = await runGuardedCli(
    ['summary', '--question', 'did it pass?'],
    'raw build output line 1\nraw build output line 2',
  );
  assert.equal(result.code, 0);
  assert.match(result.stdout, /nested in agent run run-guard-1/);
  assert.match(result.stdout, /raw build output line 1\nraw build output line 2/);
});

test('nested summary still requires input', async () => {
  const result = await runGuardedCli(['summary', '--question', 'did it pass?']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /stdin, --text or --file required/);
});

for (const argv of [
  ['repo-search', '--prompt', 'find things'],
  ['repo-agent', '--prompt', 'do things'],
  ['run', 'echo hi'],
  ['eval'],
]) {
  test(`nested ${argv[0]} fails fast with a deadlock explanation`, async () => {
    const result = await runGuardedCli(argv);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /blocked inside agent run run-guard-1/);
    assert.match(result.stderr, /deadlock/);
  });
}
```

- [ ] **Step 2: Build and run to verify failure**

Run: `npm run build:test`
Expected: PASS (test compiles).

Run: `node ./dist/scripts/run-tests.js nested-agent-guard`
Expected: FAIL — passthrough test errors trying to reach `127.0.0.1:9`; fail-fast tests exit with the wrong message (token validation / connection errors instead of the guard message).

- [ ] **Step 3: Add the MODEL_LOCK_COMMANDS set**

In `src/cli/args.ts`, directly below `SERVER_DEPENDENT_COMMANDS` (line 101):

```ts
/** Commands that acquire the server's single model-request lock. */
export const MODEL_LOCK_COMMANDS = new Set([
  'summary',
  'repo-search',
  'repo-agent',
  'run',
  'eval',
]);
```

- [ ] **Step 4: Add the guard to dispatch**

In `src/cli/dispatch.ts`:

Add to the existing `./args.js` import list: `MODEL_LOCK_COMMANDS`. Add a new import:

```ts
import { readNestedAgentRunId } from '../lib/agent-run-marker.js';
```

Directly after the `BLOCKED_PUBLIC_COMMANDS` check (line 39) and **before** the `try` block's TTY/token validation, insert:

```ts
  const nestedAgentRunId = readNestedAgentRunId();
  if (nestedAgentRunId && MODEL_LOCK_COMMANDS.has(commandName) && commandName !== 'summary') {
    stderr.write(
      `siftkit ${commandName} is blocked inside agent run ${nestedAgentRunId}: `
      + 'the status server\'s model lock is held by the parent run, so this call would deadlock. '
      + 'Run the underlying command raw instead of routing it through siftkit.\n',
    );
    return 1;
  }
```

Then make the server preflight skip a nested summary — change line 70:

```ts
    if (SERVER_DEPENDENT_COMMANDS.has(commandName) && !(commandName === 'summary' && nestedAgentRunId)) {
```

And pass the marker into `runSummary` (line 78):

```ts
      case 'summary':
        return await runSummary({
          argv: options.argv,
          stdinText: options.stdinText,
          stdout,
          stderr,
          nestedAgentRunId,
          timing: {
            processStartedAtMs: options.timing?.processStartedAtMs ?? null,
            stdinWaitMs: options.timing?.stdinWaitMs ?? null,
            serverPreflightMs,
          },
        });
```

- [ ] **Step 5: Add passthrough mode to runSummary**

In `src/cli/run-summary.ts`, add `nestedAgentRunId?: string | null;` to the options type, and insert the passthrough directly after the input-required check (line 28) so argument validation still applies:

```ts
export async function runSummary(options: {
  argv: string[];
  stdinText?: string | Buffer;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  nestedAgentRunId?: string | null;
  timing?: SummaryTimingInput;
}): Promise<number> {
```

```ts
  if ((!parsed.file || parsed.file.length === 0) && !inputText?.trim()) {
    throw new Error('stdin, --text or --file required');
  }

  if (options.nestedAgentRunId) {
    options.stdout.write(`[siftkit] nested in agent run ${options.nestedAgentRunId}: summarization skipped to avoid model-lock deadlock; raw output follows\n`);
    options.stdout.write(`${(inputText ?? '').trim()}\n`);
    return 0;
  }
```

- [ ] **Step 6: Build and run tests to verify they pass**

Run: `npm run build:test`
Expected: PASS.

Run: `node ./dist/scripts/run-tests.js nested-agent-guard`
Expected: PASS (all 6 tests).

Run: `node ./dist/scripts/run-tests.js summary-cli` and `node ./dist/scripts/run-tests.js cli-command-surface`
Expected: PASS (no regressions — the guard is inert without the env var).

- [ ] **Step 7: Commit**

```bash
git add src/cli/args.ts src/cli/dispatch.ts src/cli/run-summary.ts tests/nested-agent-guard.test.ts
git commit -m "feat: nested siftkit CLI guard - summary passthrough, fail-fast for lock-taking commands"
```

---

### Task 3: Server-side self-lineage rejection (defense-in-depth)

**Files:**
- Modify: `src/lib/operation-stream.ts:10-24`
- Modify: `src/status-server/server-types.ts:35-47`
- Modify: `src/status-server/server-ops.ts` (`acquireModelRequest:464`, `createModelRequestLock:479`, `grantNextModelRequest:563`, `acquireModelRequestWithWait:588`, `getModelRequestQueueDiagnostics:388`)
- Modify: `src/status-server/routes/streamed-operation-endpoint.ts`
- Modify: `src/status-server/routes/core.ts:837-850` (RepoTaskEndpoint)
- Modify: `src/lib/http-client.ts` (`SseStreamOptions`, `streamSse:220`)
- Modify: `src/cli/status-server-api-client.ts:186-231`
- Modify: `tests/helpers/sse-http.ts:17-43`
- Test: Create `tests/nested-agent-server-reject.test.ts`

- [ ] **Step 1: Add headers support to the test helper**

In `tests/helpers/sse-http.ts`, extend `requestSse` options and merge headers into the request (lines 17-42):

```ts
export function requestSse(
  url: string,
  options: {
    body: JsonSerializable;
    timeoutMs?: number;
    headers?: Record<string, string>;
    onProgress?: (event: JsonObject) => void | Promise<void>;
  },
): Promise<CollectedSseResponse> {
```

```ts
    const request = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyText, 'utf8'),
        ...(options.headers ?? {}),
      },
    }, (response) => {
```

- [ ] **Step 2: Write the failing server E2E test**

Create `tests/nested-agent-server-reject.test.ts`. It holds the lock with a real `/repo-agent` run (via `simulateWorkMs`), discovers the owner id from `/status` diagnostics, then proves a marker-matching request is rejected immediately while a non-matching one queues and completes:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { requestSse } from './helpers/sse-http.js';
import { asObject, requestJson } from './helpers/dashboard-http.js';
import { startHarness } from './helpers/streamed-op-harness.js';
import { AGENT_RUN_ID_HEADER } from '../src/lib/agent-run-marker.js';

const ANALYZE_BODY = {
  outputKind: 'command',
  exitCode: 0,
  combinedText: 'all tests passed',
  question: 'did it pass?',
  backend: 'mock',
};

test('summary-family request whose marker matches the active agent run is rejected, others queue', async () => {
  const harness = await startHarness('siftkit-selfcall-reject-');
  try {
    const agentRun = requestSse(`${harness.baseUrl}/repo-agent`, {
      body: {
        prompt: 'hold the lock', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 2,
        approval: false, availableModels: ['mock-model'], simulateWorkMs: 5000,
        mockResponses: ['{"action":"finish","output":"done"}'],
        mockCommandResults: {},
      },
      timeoutMs: 30_000,
    });

    let ownerRunId = '';
    for (let attempt = 0; attempt < 200 && !ownerRunId; attempt += 1) {
      const status = await requestJson(`${harness.baseUrl}/status`);
      const activeRequest = asObject(asObject(status.body.modelRequests).activeRequest);
      ownerRunId = String(activeRequest.ownerRunId || '');
      if (!ownerRunId) await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(ownerRunId, 'expected the agent run to hold the lock with an ownerRunId');

    const rejected = await requestSse(`${harness.baseUrl}/command-output/analyze`, {
      body: ANALYZE_BODY,
      headers: { [AGENT_RUN_ID_HEADER]: ownerRunId },
    });
    assert.equal(rejected.statusCode, 409, rejected.rawBody);
    assert.match(rejected.rawBody, /self-call/);

    const queued = await requestSse(`${harness.baseUrl}/command-output/analyze`, {
      body: ANALYZE_BODY,
      headers: { [AGENT_RUN_ID_HEADER]: 'some-finished-run' },
      timeoutMs: 30_000,
    });
    assert.equal(queued.statusCode, 200);
    assert.ok(queued.result, queued.rawBody);

    const agentResponse = await agentRun;
    assert.ok(agentResponse.result, agentResponse.rawBody);
  } finally {
    await harness.close();
  }
});
```

- [ ] **Step 3: Build and run to verify failure**

Run: `npm run build:test`
Expected: PASS.

Run: `node ./dist/scripts/run-tests.js nested-agent-server-reject`
Expected: FAIL — `ownerRunId` never appears in diagnostics (field does not exist yet), assertion `expected the agent run to hold the lock with an ownerRunId` fires.

- [ ] **Step 4: Add ownerRunId to the diagnostics schema and lock types**

In `src/lib/operation-stream.ts` (line 12):

```ts
  activeRequest: z.object({
    kind: z.string(),
    startedAtUtc: z.string(),
    heldMs: z.number(),
    ownerRunId: z.string().nullable(),
  }).nullable(),
```

In `src/status-server/server-types.ts` (lines 35-47):

```ts
export type ModelRequestLock = { token: string; kind: string; startedAtUtc: string; ownerRunId: string | null };
export type ModelRequestWaitOptions = { timeoutMs?: number; ownerRunId?: string | null };
export type ModelRequestWaiter = {
  queueToken: string;
  kind: string;
  ownerRunId: string | null;
  enqueuedAtUtc: string;
  cancelled: boolean;
  grantedLock: ModelRequestLock | null;
  timeoutHandle: NodeJS.Timeout | null;
  timeoutMs: number;
  lastQueuePosition: number;
  resolveLock(lock: ModelRequestLock | null): void;
};
```

- [ ] **Step 5: Plumb ownerRunId through server-ops**

In `src/status-server/server-ops.ts`:

`createModelRequestLock` (line 479):

```ts
function createModelRequestLock(kind: string, ownerRunId: string | null): ModelRequestLock {
  return {
    token: randomUUID(),
    kind: String(kind),
    startedAtUtc: new Date().toISOString(),
    ownerRunId,
  };
}
```

`acquireModelRequest` (line 464) — add the parameter and pass it through:

```ts
export function acquireModelRequest(ctx: ServerContext, kind: string, ownerRunId: string | null = null): ModelRequestLock | null {
  if (
    ctx.activeModelRequest
    || ctx.modelRequestQueue.length > 0
    || ctx.presetRuntimeCoordinator?.canGrantModelRequest() === false
  ) {
    return null;
  }
  const lock = createModelRequestLock(kind, ownerRunId);
  ctx.activeModelRequest = lock;
  ctx.presetRuntimeCoordinator?.setModelRequestActive(true);
  syncInferenceRunFlushQueueModelState(ctx);
  return lock;
}
```

`grantNextModelRequest` (line 572):

```ts
    const lock = createModelRequestLock(waiter.kind, waiter.ownerRunId);
```

`acquireModelRequestWithWait` (line 598 and the waiter literal at line 611):

```ts
  let lock = acquireModelRequest(ctx, kind, options.ownerRunId ?? null);
```

```ts
  const waiter: ModelRequestWaiter = {
    queueToken: randomUUID(),
    kind: String(kind),
    ownerRunId: options.ownerRunId ?? null,
    enqueuedAtUtc: new Date().toISOString(),
    cancelled: false,
    grantedLock: null,
    timeoutHandle: null,
    timeoutMs,
    lastQueuePosition: initialQueuePosition,
    resolveLock: resolveWaiterLock,
  };
```

`getModelRequestQueueDiagnostics` (line 391):

```ts
    activeRequest: ctx.activeModelRequest
      ? {
        kind: ctx.activeModelRequest.kind,
        startedAtUtc: ctx.activeModelRequest.startedAtUtc,
        heldMs: getElapsedMsSinceIso(ctx.activeModelRequest.startedAtUtc),
        ownerRunId: ctx.activeModelRequest.ownerRunId,
      }
      : null,
```

- [ ] **Step 6: Reject self-lineage requests in the streamed endpoint**

In `src/status-server/routes/streamed-operation-endpoint.ts`:

Add the import:

```ts
import { AGENT_RUN_ID_HEADER } from '../../lib/agent-run-marker.js';
```

Add the overridable owner hook to the class (below `onOperationFailed`, line 49):

```ts
  /** RequestId this operation's lock should be attributed to, for self-call rejection. */
  protected lockOwnerRunId(_parsed: TParsed): string | null {
    return null;
  }
```

In `handle()`, insert the rejection directly after the body is parsed (after line 63's catch block, before `parseRequest`):

```ts
    const nestedRunId = String(req.headers[AGENT_RUN_ID_HEADER] || '').trim();
    if (nestedRunId && ctx.activeModelRequest?.ownerRunId === nestedRunId) {
      const message = `Rejected self-call from agent run ${nestedRunId}: it holds the model lock, so this request would deadlock behind its own run.`;
      const payload = recordServerError(req, 409, new Error(message), { taskKind: this.taskKind });
      sendJson(res, 409, { ...payload, modelRequests: getModelRequestQueueDiagnostics(ctx) });
      return;
    }
```

And attribute the lock at acquisition (line 89):

```ts
    const modelRequestLock = await acquireModelRequestWithWait(ctx, this.lockKind, req, res, {
      ownerRunId: this.lockOwnerRunId(parsed.value),
    });
```

- [ ] **Step 7: Attribute repo-search/agent locks to their requestId**

In `src/status-server/routes/core.ts`, inside `RepoTaskEndpoint` (below `onOperationFailed`, line 854):

```ts
  protected lockOwnerRunId(parsed: ParsedRepoSearchRoute): string | null {
    return parsed.admission.requestId;
  }
```

- [ ] **Step 8: Send the marker header from the CLI**

In `src/lib/http-client.ts`, add `headers?: Record<string, string>;` to `SseStreamOptions` (find the type near the top of the file), and merge into the request headers in `streamSse` (line 220):

```ts
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(options.body, 'utf8'),
        Accept: 'text/event-stream',
        ...(options.headers ?? {}),
      },
```

In `src/cli/status-server-api-client.ts`, add the import:

```ts
import { AGENT_RUN_ID_HEADER, readNestedAgentRunId } from '../lib/agent-run-marker.js';
```

And in `requestStreamedOperation` (line 196):

```ts
      const nestedAgentRunId = readNestedAgentRunId();
      for await (const frame of this.client.streamSse({
        url: this.getServiceUrl(pathname),
        body,
        idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
        ...(nestedAgentRunId ? { headers: { [AGENT_RUN_ID_HEADER]: nestedAgentRunId } } : {}),
      })) {
```

- [ ] **Step 9: Build and run tests to verify they pass**

Run: `npm run build:test`
Expected: PASS.

Run: `node ./dist/scripts/run-tests.js nested-agent-server-reject`
Expected: PASS — 409 with `self-call` for the matching marker; the mismatched marker queues and completes; the agent run finishes normally.

Run: `node ./dist/scripts/run-tests.js streamed-op-endpoints`, `node ./dist/scripts/run-tests.js streamed-repo-agent-endpoint`, `node ./dist/scripts/run-tests.js streamed-summary-endpoint`
Expected: PASS (endpoints without the header are untouched).

- [ ] **Step 10: Commit**

```bash
git add src/lib/operation-stream.ts src/status-server/server-types.ts src/status-server/server-ops.ts src/status-server/routes/streamed-operation-endpoint.ts src/status-server/routes/core.ts src/lib/http-client.ts src/cli/status-server-api-client.ts tests/helpers/sse-http.ts tests/nested-agent-server-reject.test.ts
git commit -m "feat: server rejects self-lineage model requests instead of deadlocking"
```

---

### Task 4: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS across the board. Pay attention to any test that constructs `RepoToolContext`, calls `executeRepoCommand`, or asserts on `ModelRequestQueueDiagnostics` shapes — the compiler catches the first two; `contracts-*` tests may pin the diagnostics schema and need the `ownerRunId` field added to expectations.

- [ ] **Step 2: Update the handoff doc**

Append to `docs/superpowers/handoffs/2026-07-23-repo-agent-siftkit-selfcall-deadlock.md`:

```markdown
## Resolution (2026-07-23)
Shipped the guardrail (fixes 1 + 3): the engine stamps `SIFTKIT_AGENT_RUN_ID` on every spawned run/command child; nested `siftkit summary` degrades to raw passthrough with a banner, nested `repo-search`/`repo-agent`/`run`/`eval` fail fast; and the server rejects requests whose `x-siftkit-agent-run-id` header matches the active lock owner with HTTP 409. Plan: `docs/superpowers/plans/2026-07-23-siftkit-selfcall-guard.md`. Fix 2 (lock scoped to inference only) remains open by design.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/handoffs/2026-07-23-repo-agent-siftkit-selfcall-deadlock.md
git commit -m "docs: record self-call guard resolution in deadlock handoff"
```

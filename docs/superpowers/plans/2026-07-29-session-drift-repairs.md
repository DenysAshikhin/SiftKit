# Session Drift Repairs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the three identified session drifts by centralizing chat phase timestamps, extracting a dedicated model-queue E2E harness, and proving both queue-race tests fail under their corresponding regressions.

**Architecture:** A single `ChatTurnPhaseTracker` owns timestamp transitions and is composed by both production consumers. A dedicated `DashboardModelQueueHarness` owns queue-test lifecycle and synchronization while scenario assertions remain in the E2E file. Controlled temporary mutations provide red evidence and are fully restored before final validation.

**Tech Stack:** TypeScript 5.9, Node.js test runner, `tsx`, Node HTTP server, `c8`, ESLint.

## Global Constraints

- Follow `docs/superpowers/specs/2026-07-28-session-drift-repairs-design.md`.
- Use TDD exclusively: observe the specified red result before adding each production or helper implementation.
- Prefer the existing HTTP E2Es; add only the focused tracker unit test required to establish the new production boundary.
- Keep functions explicit. Do not pass behavior through callbacks, predicates, or injected functions.
- Do not add casts, `any`, non-null assertions, namespace imports, shims, legacy compatibility, or dynamically passed functions.
- Remove superseded implementations completely; no compatibility wrapper may remain.
- Keep the solution concise, DRY, and limited to the three approved repairs.
- Do not use a worktree.
- Do not invoke SiftKit.
- Do not stage or modify the unrelated `package-lock.json` worktree change.
- Preserve all HTTP, SSE, persistence, telemetry, and timestamp semantics.
- Final branch coverage must be at least the pre-repair baseline of 80.75%.
- Store any temporary mutation artifacts under one temporary folder and delete them before completion; the planned source mutations require no artifact files.

---

## File Structure

- Create `src/status-server/chat-turn-phase-tracker.ts`: sole owner of chat phase timestamp state and transitions.
- Create `tests/chat-turn-phase-tracker.test.ts`: focused behavioral coverage for the shared tracker.
- Create `tests/helpers/dashboard-test-repo.ts`: existing dashboard test-repository and environment primitives moved out of the monolithic E2E file so the harness can reuse them without duplication.
- Create `tests/helpers/dashboard-model-queue-harness.ts`: lifecycle, session, queue-state, and lock-holder class for model-queue E2Es.
- Modify `src/status-server/chat-repo-operation-runner.ts`: compose the shared tracker and retain only event forwarding.
- Modify `src/status-server/routes/chat.ts`: replace the local tracker type/factory with the shared class.
- Modify `tests/dashboard-status-server.test.ts`: import the shared repository helpers, remove local duplicates, and express the two race scenarios through the harness.
- Modify `docs/superpowers/plans/2026-07-28-strict-preset-drift-remediation.md`: persist exact red/green mutation evidence.

---

### Task 1: Establish the shared chat phase tracker

**Files:**
- Create: `tests/chat-turn-phase-tracker.test.ts`
- Create: `src/status-server/chat-turn-phase-tracker.ts`
- Modify: `src/status-server/chat-repo-operation-runner.ts:51-139`
- Modify: `src/status-server/routes/chat.ts:269-321`
- Verify: `tests/dashboard-status-server.test.ts:1106-1290`

**Interfaces:**
- Consumes: non-empty thinking and answer text emitted by existing chat progress paths.
- Produces: `ChatTurnPhaseTracker`, `ChatTurnPhaseTimestamps`, `observeThinking(content: string): void`, `observeAnswer(content: string): void`, and `snapshot(): ChatTurnPhaseTimestamps`.

- [ ] **Step 1: Add the focused test before the shared module exists**

Create `tests/chat-turn-phase-tracker.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { ChatTurnPhaseTracker } from '../src/status-server/chat-turn-phase-tracker.js';

const REQUEST_STARTED_AT_UTC = '2026-07-29T00:00:00.000Z';

test('chat phase tracker starts empty and ignores whitespace', () => {
  const tracker = new ChatTurnPhaseTracker(REQUEST_STARTED_AT_UTC);

  tracker.observeThinking(' \n');
  tracker.observeAnswer('\t');

  assert.deepEqual(tracker.snapshot(), {
    requestStartedAtUtc: REQUEST_STARTED_AT_UTC,
    thinkingStartedAtUtc: null,
    thinkingEndedAtUtc: null,
    answerStartedAtUtc: null,
    answerEndedAtUtc: null,
  });
});

test('chat phase tracker retains phase starts across later content', () => {
  const tracker = new ChatTurnPhaseTracker(REQUEST_STARTED_AT_UTC);

  tracker.observeThinking('first thought');
  const firstThinking = tracker.snapshot();
  assert.equal(typeof firstThinking.thinkingStartedAtUtc, 'string');
  assert.equal(typeof firstThinking.thinkingEndedAtUtc, 'string');

  tracker.observeThinking('second thought');
  const secondThinking = tracker.snapshot();
  assert.equal(secondThinking.thinkingStartedAtUtc, firstThinking.thinkingStartedAtUtc);
  assert.equal(typeof secondThinking.thinkingEndedAtUtc, 'string');

  tracker.observeAnswer('first answer');
  const firstAnswer = tracker.snapshot();
  assert.equal(typeof firstAnswer.answerStartedAtUtc, 'string');
  assert.equal(typeof firstAnswer.answerEndedAtUtc, 'string');

  tracker.observeAnswer('second answer');
  const secondAnswer = tracker.snapshot();
  assert.equal(secondAnswer.answerStartedAtUtc, firstAnswer.answerStartedAtUtc);
  assert.equal(typeof secondAnswer.answerEndedAtUtc, 'string');
});
```

- [ ] **Step 2: Run the tracker test and verify RED**

Run:

```powershell
npm test -- chat-turn-phase-tracker
```

Expected: FAIL during typechecking or module loading because `src/status-server/chat-turn-phase-tracker.ts` does not exist.

- [ ] **Step 3: Implement the sole timestamp owner**

Create `src/status-server/chat-turn-phase-tracker.ts`:

```ts
export type ChatTurnPhaseTimestamps = {
  requestStartedAtUtc: string;
  thinkingStartedAtUtc: string | null;
  thinkingEndedAtUtc: string | null;
  answerStartedAtUtc: string | null;
  answerEndedAtUtc: string | null;
};

export class ChatTurnPhaseTracker {
  private readonly requestStartedAtUtc: string;
  private thinkingStartedAtUtc: string | null = null;
  private thinkingEndedAtUtc: string | null = null;
  private answerStartedAtUtc: string | null = null;
  private answerEndedAtUtc: string | null = null;

  constructor(requestStartedAtUtc = new Date().toISOString()) {
    this.requestStartedAtUtc = requestStartedAtUtc;
  }

  observeThinking(content: string): void {
    if (!content.trim()) {
      return;
    }
    const now = new Date().toISOString();
    this.thinkingStartedAtUtc ??= now;
    this.thinkingEndedAtUtc = now;
  }

  observeAnswer(content: string): void {
    if (!content.trim()) {
      return;
    }
    const now = new Date().toISOString();
    this.answerStartedAtUtc ??= now;
    this.answerEndedAtUtc = now;
  }

  snapshot(): ChatTurnPhaseTimestamps {
    return {
      requestStartedAtUtc: this.requestStartedAtUtc,
      thinkingStartedAtUtc: this.thinkingStartedAtUtc,
      thinkingEndedAtUtc: this.thinkingEndedAtUtc,
      answerStartedAtUtc: this.answerStartedAtUtc,
      answerEndedAtUtc: this.answerEndedAtUtc,
    };
  }
}
```

- [ ] **Step 4: Migrate the repo-operation progress writer**

In `src/status-server/chat-repo-operation-runner.ts`:

1. Import `ChatTurnPhaseTracker` from `./chat-turn-phase-tracker.js`.
2. Delete the local `ChatTurnPhaseTimestamps` type.
3. Replace the four timestamp fields with one tracker.
4. Delegate observations and snapshots while preserving event forwarding:

```ts
class ChatRepoOperationProgressTracker extends ProgressWriter<RepoSearchProgressEvent> {
  private readonly phaseTracker = new ChatTurnPhaseTracker();

  constructor(private readonly writer: ProgressWriter<RepoSearchProgressEvent>) {
    super();
  }

  get enabled(): boolean {
    return this.writer.enabled;
  }

  write(event: RepoSearchProgressEvent): void {
    if (event.kind === 'thinking') {
      this.phaseTracker.observeThinking(event.thinkingText ?? '');
    }
    if (event.kind === 'answer') {
      this.phaseTracker.observeAnswer(event.answerText ?? '');
    }
    this.writer.write(event);
  }

  observeAnswer(content: string): void {
    this.phaseTracker.observeAnswer(content);
  }

  snapshot(): ChatTurnPhaseTimestamps {
    return this.phaseTracker.snapshot();
  }
}
```

Import `type ChatTurnPhaseTimestamps` beside the class because the explicit `snapshot()` signature uses it.

- [ ] **Step 5: Migrate the chat route**

In `src/status-server/routes/chat.ts`:

1. Import `ChatTurnPhaseTracker` from `../chat-turn-phase-tracker.js`.
2. Delete the local `ChatTurnPhaseTimestamps` type.
3. Delete `createChatTurnPhaseTracker`.
4. Delete `type ChatTurnPhaseTracker = ReturnType<typeof createChatTurnPhaseTracker>`.
5. Keep `ChatStreamProgressWriter` typed as `ChatTurnPhaseTracker | null`.
6. Replace the construction at the streamed chat route:

```ts
const phaseTracker = new ChatTurnPhaseTracker(requestStartedAtUtc);
```

Do not change the nullable tracker used by Plan and Repo Search stream writers; those operations record their timestamps inside `ChatRepoOperationRunner`.

- [ ] **Step 6: Run focused tracker and telemetry coverage GREEN**

Run:

```powershell
npm test -- chat-turn-phase-tracker
npm test -- dashboard-status-server --test-name-pattern "plan/repo-search stream events include backend promptTokenCount"
```

Expected: both commands PASS. The dashboard E2E must continue asserting string timestamps for JSON Plan and streamed Repo Search messages.

- [ ] **Step 7: Confirm the duplicate owner is gone**

Run:

```powershell
rg -n "type ChatTurnPhaseTimestamps|class ChatTurnPhaseTracker|createChatTurnPhaseTracker|private thinkingStartedAtUtc" src/status-server
```

Expected:

- One `ChatTurnPhaseTimestamps` declaration in `chat-turn-phase-tracker.ts`.
- One `ChatTurnPhaseTracker` class in `chat-turn-phase-tracker.ts`.
- One `private thinkingStartedAtUtc` field in that class.
- No `createChatTurnPhaseTracker` result.

- [ ] **Step 8: Commit the shared tracker**

```powershell
git add -- src/status-server/chat-turn-phase-tracker.ts src/status-server/chat-repo-operation-runner.ts src/status-server/routes/chat.ts tests/chat-turn-phase-tracker.test.ts
git commit -m "refactor: centralize chat phase tracking"
```

Do not stage `package-lock.json`.

---

### Task 2: Extract the dedicated model-queue E2E harness

**Files:**
- Create: `tests/helpers/dashboard-test-repo.ts`
- Create: `tests/helpers/dashboard-model-queue-harness.ts`
- Modify: `tests/dashboard-status-server.test.ts:12-33`
- Modify: `tests/dashboard-status-server.test.ts:137-220`
- Modify: `tests/dashboard-status-server.test.ts:2058-2225`

**Interfaces:**
- Consumes: `startStatusServer`, existing dashboard HTTP helpers, and existing test-repository environment variables.
- Produces: `DashboardModelQueueHarness` with `start`, `getBaseUrl`, `createChatSession`, `waitForActiveRequest`, `waitForQueuedRequest`, `holdModelLock`, and `close`.
- Produces: shared `configureDashboardTestEnv`, `restoreDashboardTestEnv`, `enterDashboardTestRepo`, and `restoreDashboardTestRepo` primitives used by the harness and existing dashboard tests.

- [ ] **Step 1: Refactor the two race tests to the missing harness**

Add:

```ts
import { DashboardModelQueueHarness } from './helpers/dashboard-model-queue-harness.js';
```

Rewrite `queued JSON Plan returns 404 when its session disappears before lock grant` to this structure:

```ts
test('queued JSON Plan returns 404 when its session disappears before lock grant', async () => {
  const harness = new DashboardModelQueueHarness('siftkit-dashboard-plan-session-race-');
  try {
    await harness.start();
    const baseUrl = harness.getBaseUrl();
    const sessionId = await harness.createChatSession(
      'Queued Plan session',
      'Qwen3.5-9B-Q8_0.gguf',
    );
    const delayedRepoSearch = harness.holdModelLock(
      'hold lock while queued Plan loses its session',
      500,
    );
    await harness.waitForActiveRequest('repo_search');

    const queuedPlan = requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/plan`, {
      method: 'POST',
      timeoutMs: 6_000,
      body: JSON.stringify({
        content: 'plan after queued session deletion',
        repoRoot: process.cwd(),
        maxTurns: 1,
        availableModels: ['Qwen3.5-9B-Q8_0.gguf'],
        mockResponses: ['{"action":"finish","output":"must not run"}'],
        mockCommandResults: {},
      }),
    });
    await harness.waitForQueuedRequest('dashboard_plan');

    const deleteResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}`, {
      method: 'DELETE',
    });
    assert.equal(deleteResponse.statusCode, 200);

    const [holderResponse, planResponse] = await Promise.all([delayedRepoSearch, queuedPlan]);
    assert.equal(holderResponse.statusCode, 200);
    assert.equal(planResponse.statusCode, 404);
    assert.equal(planResponse.body.error, 'Session not found.');

    const deletedSessionResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}`);
    assert.equal(deletedSessionResponse.statusCode, 404);
  } finally {
    await harness.close();
  }
});
```

Rewrite `queued Repo Search disconnect leaves the chat session unchanged` with the same lifecycle:

```ts
test('queued Repo Search disconnect leaves the chat session unchanged', async () => {
  const harness = new DashboardModelQueueHarness('siftkit-dashboard-repo-search-disconnect-');
  try {
    await harness.start();
    const baseUrl = harness.getBaseUrl();
    const sessionId = await harness.createChatSession(
      'Queued Repo Search session',
      'Qwen3.5-9B-Q8_0.gguf',
    );
    const createdSessionResponse = await requestJson(
      `${baseUrl}/dashboard/chat/sessions/${sessionId}`,
    );
    assert.equal(createdSessionResponse.statusCode, 200);
    const createdSession = d(createdSessionResponse.body.session);
    const delayedRepoSearch = harness.holdModelLock(
      'hold lock while queued Repo Search disconnects',
      1_000,
    );
    await harness.waitForActiveRequest('repo_search');

    const disconnectedRepoSearch = fireAndAbortJsonRequest(
      `${baseUrl}/dashboard/chat/sessions/${sessionId}/repo-search/stream`,
      JSON.stringify({
        content: 'must not persist after disconnect',
        repoRoot: process.cwd(),
        maxTurns: 1,
        availableModels: ['Qwen3.5-9B-Q8_0.gguf'],
        mockResponses: ['{"action":"finish","output":"must not run"}'],
        mockCommandResults: {},
      }),
      500,
    );
    await harness.waitForQueuedRequest('dashboard_repo_search_stream');
    await disconnectedRepoSearch;

    const holderResponse = await delayedRepoSearch;
    assert.equal(holderResponse.statusCode, 200);

    const sessionResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}`);
    assert.equal(sessionResponse.statusCode, 200);
    const persistedSession = d(sessionResponse.body.session);
    assert.equal(persistedSession.presetId, createdSession.presetId);
    assert.equal(persistedSession.mode, createdSession.mode);
    assert.deepEqual(asArray(persistedSession.messages), asArray(createdSession.messages));
  } finally {
    await harness.close();
  }
});
```

Delete the now-unused local `waitForActiveModelRequest` and `waitForQueuedModelRequest` functions. Do not create the harness yet.

- [ ] **Step 2: Run the focused race E2Es and verify RED**

Run:

```powershell
npm test -- dashboard-status-server --test-name-pattern "queued JSON Plan returns 404|queued Repo Search disconnect leaves"
```

Expected: FAIL during typechecking or module loading because `tests/helpers/dashboard-model-queue-harness.ts` does not exist.

- [ ] **Step 3: Extract the existing test-repository primitives**

Create `tests/helpers/dashboard-test-repo.ts` by moving the exact environment keys and repository lifecycle behavior currently defined at `tests/dashboard-status-server.test.ts:177-220`:

```ts
import fs from 'node:fs';
import path from 'node:path';

import { closeRuntimeDatabase } from '../../src/state/runtime-db.js';

export function configureDashboardTestEnv(
  tempRoot: string,
  statusPath: string,
  configPath: string,
): Record<string, string | undefined> {
  const envBackup: Record<string, string | undefined> = {
    sift_kit_status: process.env.sift_kit_status,
    SIFTKIT_STATUS_PATH: process.env.SIFTKIT_STATUS_PATH,
    SIFTKIT_CONFIG_PATH: process.env.SIFTKIT_CONFIG_PATH,
    SIFTKIT_METRICS_PATH: process.env.SIFTKIT_METRICS_PATH,
    SIFTKIT_IDLE_SUMMARY_DB_PATH: process.env.SIFTKIT_IDLE_SUMMARY_DB_PATH,
    SIFTKIT_STATUS_HOST: process.env.SIFTKIT_STATUS_HOST,
    SIFTKIT_STATUS_PORT: process.env.SIFTKIT_STATUS_PORT,
    SIFTKIT_TERMINAL_METADATA_IDLE_DELAY_MS: process.env.SIFTKIT_TERMINAL_METADATA_IDLE_DELAY_MS,
    SIFTKIT_DISABLE_RUNTIME_HISTORY_PRUNE: process.env.SIFTKIT_DISABLE_RUNTIME_HISTORY_PRUNE,
  };
  process.env.sift_kit_status = statusPath;
  process.env.SIFTKIT_STATUS_PATH = statusPath;
  process.env.SIFTKIT_CONFIG_PATH = configPath;
  process.env.SIFTKIT_METRICS_PATH = path.join(tempRoot, '.siftkit', 'status', 'compression-metrics.json');
  process.env.SIFTKIT_IDLE_SUMMARY_DB_PATH = path.join(tempRoot, '.siftkit', 'status', 'idle-summary.sqlite');
  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';
  process.env.SIFTKIT_TERMINAL_METADATA_IDLE_DELAY_MS = '0';
  process.env.SIFTKIT_DISABLE_RUNTIME_HISTORY_PRUNE = '1';
  return envBackup;
}

export function restoreDashboardTestEnv(envBackup: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(envBackup)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

export function enterDashboardTestRepo(tempRoot: string): string {
  const previousCwd = process.cwd();
  fs.writeFileSync(
    path.join(tempRoot, 'package.json'),
    JSON.stringify({ name: 'siftkit', version: '0.1.0' }, null, 2),
    'utf8',
  );
  process.chdir(tempRoot);
  return previousCwd;
}

export function restoreDashboardTestRepo(previousCwd: string): void {
  process.chdir(previousCwd);
  closeRuntimeDatabase();
}
```

In `tests/dashboard-status-server.test.ts`, import the three previously local functions from `./helpers/dashboard-test-repo.js`, then delete their local definitions. Remove the direct `closeRuntimeDatabase` import if no remaining use exists. Existing unrelated test scenarios continue calling the same functions with the same signatures.

- [ ] **Step 4: Implement the dedicated queue harness**

Create `tests/helpers/dashboard-model-queue-harness.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { startStatusServer } from '../../src/status-server/index.js';
import {
  asObject,
  asObjectArray,
  getAddressInfo,
  removeDirectoryWithRetries,
  requestJson,
  requestSse,
  type SseResponse,
} from './dashboard-http.js';
import {
  configureDashboardTestEnv,
  enterDashboardTestRepo,
  restoreDashboardTestEnv,
  restoreDashboardTestRepo,
} from './dashboard-test-repo.js';

const QUEUE_WAIT_TIMEOUT_MS = 2_000;
const QUEUE_POLL_INTERVAL_MS = 10;
const LOCK_HOLDER_MODEL = 'Qwen3.5-35B-A3B-UD-Q4_K_L.gguf';
const LOCK_HOLDER_COMMAND = 'git grep -n "x" src';

export class DashboardModelQueueHarness {
  private readonly tempRoot: string;
  private readonly previousCwd: string;
  private readonly envBackup: Record<string, string | undefined>;
  private server: ReturnType<typeof startStatusServer> | null = null;
  private baseUrl: string | null = null;

  constructor(tempDirectoryPrefix: string) {
    this.tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), tempDirectoryPrefix));
    this.previousCwd = enterDashboardTestRepo(this.tempRoot);
    const statusPath = path.join(this.tempRoot, '.siftkit', 'status', 'inference.txt');
    const configPath = path.join(this.tempRoot, '.siftkit', 'config.json');
    this.envBackup = configureDashboardTestEnv(this.tempRoot, statusPath, configPath);
  }

  async start(): Promise<void> {
    if (this.server !== null) {
      throw new Error('DashboardModelQueueHarness.start() may only be called once.');
    }
    const server = startStatusServer({ disableManagedLlamaStartup: true });
    this.server = server;
    await server.startupPromise;
    const address = getAddressInfo(server);
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  getBaseUrl(): string {
    if (this.baseUrl === null) {
      throw new Error('DashboardModelQueueHarness.start() must complete before use.');
    }
    return this.baseUrl;
  }

  async createChatSession(title: string, model: string): Promise<string> {
    const response = await requestJson(`${this.getBaseUrl()}/dashboard/chat/sessions`, {
      method: 'POST',
      body: JSON.stringify({ title, model }),
    });
    if (response.statusCode !== 201 && response.statusCode !== 200) {
      throw new Error(`Expected chat session creation to succeed, received ${response.statusCode}.`);
    }
    const sessionId = asObject(response.body.session).id;
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new Error('Expected chat session creation to return a session id.');
    }
    return sessionId;
  }

  async waitForActiveRequest(kind: string): Promise<void> {
    const deadline = Date.now() + QUEUE_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const response = await requestJson(`${this.getBaseUrl()}/status`);
      const activeRequest = asObject(asObject(response.body.modelRequests).activeRequest);
      if (activeRequest.kind === kind) {
        return;
      }
      await delay(QUEUE_POLL_INTERVAL_MS);
    }
    throw new Error(`Timed out waiting for active model request "${kind}".`);
  }

  async waitForQueuedRequest(kind: string): Promise<void> {
    const deadline = Date.now() + QUEUE_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const response = await requestJson(`${this.getBaseUrl()}/status`);
      const queuedRequests = asObjectArray(asObject(response.body.modelRequests).queuedRequests);
      for (const request of queuedRequests) {
        if (request.kind === kind) {
          return;
        }
      }
      await delay(QUEUE_POLL_INTERVAL_MS);
    }
    throw new Error(`Timed out waiting for queued model request "${kind}".`);
  }

  holdModelLock(prompt: string, delayMs: number): Promise<SseResponse> {
    return requestSse(`${this.getBaseUrl()}/repo-search`, {
      method: 'POST',
      timeoutMs: 6_000,
      body: JSON.stringify({
        prompt,
        repoRoot: this.tempRoot,
        model: LOCK_HOLDER_MODEL,
        maxTurns: 1,
        simulateWorkMs: 80,
        availableModels: [LOCK_HOLDER_MODEL],
        mockResponses: [
          `{"action":"git","command":"${LOCK_HOLDER_COMMAND.replaceAll('"', '\\"')}"}`,
          '{"action":"finish","output":"done"}',
        ],
        mockCommandResults: {
          [LOCK_HOLDER_COMMAND]: {
            exitCode: 0,
            stdout: 'src/example.ts:1:x',
            stderr: '',
            delayMs,
          },
        },
      }),
    });
  }

  async close(): Promise<void> {
    try {
      const server = this.server;
      if (server !== null && server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    } finally {
      try {
        try {
          restoreDashboardTestEnv(this.envBackup);
        } finally {
          restoreDashboardTestRepo(this.previousCwd);
        }
      } finally {
        await removeDirectoryWithRetries(this.tempRoot);
      }
    }
  }
}
```

Do not add configurable callbacks or generic request builders. The harness owns one queue-test purpose.

- [ ] **Step 5: Run the focused race E2Es GREEN**

Run:

```powershell
npm test -- dashboard-status-server --test-name-pattern "queued JSON Plan returns 404|queued Repo Search disconnect leaves"
```

Expected: both tests PASS with the same HTTP and persistence assertions as before the refactor.

- [ ] **Step 6: Run the complete dashboard status-server test file**

Run:

```powershell
npm test -- dashboard-status-server
```

Expected: PASS. Moving the repository helpers must not change unrelated test setup or cleanup.

- [ ] **Step 7: Commit the harness refactor**

```powershell
git add -- tests/helpers/dashboard-test-repo.ts tests/helpers/dashboard-model-queue-harness.ts tests/dashboard-status-server.test.ts
git commit -m "test: extract dashboard model queue harness"
```

Do not stage `package-lock.json`.

---

### Task 3: Prove the race E2Es detect both regressions

**Files:**
- Temporarily modify and restore: `src/status-server/routes/chat.ts:1049`
- Temporarily modify and restore: `src/status-server/server-ops.ts:597-620`
- Modify: `docs/superpowers/plans/2026-07-28-strict-preset-drift-remediation.md:83-87`

**Interfaces:**
- Consumes: the two queue-race E2Es refactored in Task 2.
- Produces: persistent red/green mutation evidence with no mutated production source left behind.

- [ ] **Step 1: Establish the green pre-mutation baseline**

Run:

```powershell
npm test -- dashboard-status-server --test-name-pattern "queued JSON Plan returns 404|queued Repo Search disconnect leaves"
```

Expected: both tests PASS.

- [ ] **Step 2: Apply the temporary post-lock reload mutation**

In only the JSON Plan handler in `src/status-server/routes/chat.ts`, temporarily replace:

```ts
const activeSession = readChatSessionFromPath(sessionPath);
```

with:

```ts
const activeSession = session;
```

Do not commit this mutation.

- [ ] **Step 3: Run the Plan race E2E and verify RED**

Run:

```powershell
npm test -- dashboard-status-server --test-name-pattern "queued JSON Plan returns 404 when its session disappears before lock grant"
```

Expected: FAIL because the request uses the stale pre-lock session instead of returning `404`; the status assertion or deleted-session assertion must identify the regression.

- [ ] **Step 4: Restore the post-lock reload and verify GREEN**

Restore the exact production line:

```ts
const activeSession = readChatSessionFromPath(sessionPath);
```

Run:

```powershell
npm test -- dashboard-status-server --test-name-pattern "queued JSON Plan returns 404 when its session disappears before lock grant"
```

Expected: PASS.

- [ ] **Step 5: Apply the temporary disconnect-drop mutation**

In `acquireModelRequestWithWait` in `src/status-server/server-ops.ts`, temporarily remove these response-disconnect cancellation blocks:

```ts
if (response) {
  response.once('close', onClosedResponse);
}
if (response?.destroyed && !response.writableEnded) {
  cancelModelRequestWaiter(ctx, waiter, 'client_cancelled');
}
```

and:

```ts
if (response?.destroyed && !response.writableEnded) {
  cancelModelRequestWaiter(ctx, waiter, 'client_cancelled');
}
```

from the `finally` block. Leave request-side handlers and listener cleanup intact. Do not commit this mutation.

- [ ] **Step 6: Run the Repo Search disconnect E2E and verify RED**

Run:

```powershell
npm test -- dashboard-status-server --test-name-pattern "queued Repo Search disconnect leaves the chat session unchanged"
```

Expected: FAIL because the disconnected queued request proceeds after lock grant and changes the session; the preset, mode, or message equality assertion must identify the regression.

- [ ] **Step 7: Restore disconnect cancellation and verify GREEN**

Restore both response-disconnect cancellation blocks in their original positions, then run:

```powershell
npm test -- dashboard-status-server --test-name-pattern "queued Repo Search disconnect leaves the chat session unchanged"
```

Expected: PASS.

- [ ] **Step 8: Confirm production source is fully restored**

Run:

```powershell
git diff -- src/status-server/routes/chat.ts src/status-server/server-ops.ts
```

Expected: no Task 3 mutation diff. The only production diff in the branch is the committed Task 1 tracker refactor.

- [ ] **Step 9: Record exact mutation evidence**

In `docs/superpowers/plans/2026-07-28-strict-preset-drift-remediation.md`, mark Task 4’s five checklist items complete and append:

```md
**Mutation evidence (2026-07-29):**

- Post-lock reload: replacing the JSON Plan handler's authoritative `readChatSessionFromPath(sessionPath)` reload with the stale pre-lock `session` made `queued JSON Plan returns 404 when its session disappears before lock grant` fail because the deleted session was not rejected. Restoring the reload returned the focused test to green.
- Disconnect drop: removing response-close cancellation and destroyed-response checks from `acquireModelRequestWithWait` made `queued Repo Search disconnect leaves the chat session unchanged` fail because the disconnected queued request proceeded and changed persisted session state. Restoring cancellation returned the focused test to green.
- Combined focused command: `npm test -- dashboard-status-server --test-name-pattern "queued JSON Plan returns 404|queued Repo Search disconnect leaves"` passed after both mutations were restored.
```

If the observed assertion differs, record the exact observed failing assertion while preserving the demonstrated cause. Do not claim evidence not seen in command output.

- [ ] **Step 10: Commit only the evidence**

```powershell
git add -- docs/superpowers/plans/2026-07-28-strict-preset-drift-remediation.md
git commit -m "docs: record queue race mutation proofs"
```

Verify that neither production mutation nor `package-lock.json` is staged.

---

### Task 4: Run completion gates and audit the final diff

**Files:**
- Verify only: all Task 1-3 files
- Preserve: `package-lock.json`

**Interfaces:**
- Consumes: the three committed repair tasks.
- Produces: evidence that the complete branch is typed, tested, built, coverage-safe, and free of the diagnosed drifts.

- [ ] **Step 1: Run all focused repair tests**

```powershell
npm test -- chat-turn-phase-tracker
npm test -- dashboard-status-server --test-name-pattern "plan/repo-search stream events include backend promptTokenCount|queued JSON Plan returns 404|queued Repo Search disconnect leaves"
```

Expected: all focused tests PASS.

- [ ] **Step 2: Run the complete affected E2E file**

```powershell
npm test -- dashboard-status-server
```

Expected: PASS.

- [ ] **Step 3: Run static validation and the production build**

```powershell
npm run typecheck
npm run build
```

Expected: both commands exit `0`, including ESLint through `npm run typecheck`.

- [ ] **Step 4: Run the full test suite**

```powershell
npm test
```

Expected: exit `0` with no new skips or failures.

- [ ] **Step 5: Run full branch coverage**

```powershell
npm run test:coverage
```

Expected: exit `0`; branch coverage is at least 80.75%.

- [ ] **Step 6: Audit duplication and forbidden constructs**

Run exact raw searches:

```powershell
rg -n "type ChatTurnPhaseTimestamps|class ChatTurnPhaseTracker|createChatTurnPhaseTracker|private thinkingStartedAtUtc" src/status-server
rg -n "waitForActiveModelRequest|waitForQueuedModelRequest|siftkit-dashboard-plan-session-race-|siftkit-dashboard-repo-search-disconnect-" tests/dashboard-status-server.test.ts tests/helpers
rg -n "import \\* as|:\\s*any\\b|<any>|\\bas unknown\\b|\\bas [A-Z][A-Za-z0-9_<>, |\\[\\]]*|\\w+!\\." src/status-server/chat-turn-phase-tracker.ts src/status-server/chat-repo-operation-runner.ts src/status-server/routes/chat.ts tests/chat-turn-phase-tracker.test.ts tests/helpers/dashboard-test-repo.ts tests/helpers/dashboard-model-queue-harness.ts tests/dashboard-status-server.test.ts
```

Expected:

- The timestamp type, class, and state fields exist only in `chat-turn-phase-tracker.ts`; the old factory is absent.
- Queue lifecycle prefixes and waits belong to the harness, not the two E2E bodies.
- The forbidden-construct search has no genuine code matches. Inspect exact matches and remove violations rather than suppressing them.

- [ ] **Step 7: Check diff integrity and temporary-file cleanup**

Run:

```powershell
git diff --check ca08c59..HEAD
git status --short
```

Expected:

- No whitespace errors.
- No temporary mutation or test files.
- `package-lock.json` may remain as the user’s pre-existing unstaged modification, but it is absent from all repair commits.
- No uncommitted repair changes remain.

- [ ] **Step 8: Review commit scope**

Run:

```powershell
git log --oneline ca08c59..HEAD
git diff --stat ca08c59..HEAD
```

Expected: three focused implementation commits: shared tracker, queue harness, and mutation evidence. No unrelated files are included.

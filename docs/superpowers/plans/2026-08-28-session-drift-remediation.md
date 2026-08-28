# Session Drift Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the five drift findings from the 2026-08-28 session: the unrequested idle-gate fallback, the triplicated pending-capture state list, the duplicated server-test harness with fail-quiet token handling, the duplicated status-port derivation in start-dev, and the PowerShell mirror of the toolchain root.

**Architecture:** Each fix is a complete replacement, not a patch: the idle gate becomes input-only with no quiet-window parallel path; shared constants/helpers become the single source their copies used to shadow; obsolete artifacts (QuietWindowTracker, noteActivity plumbing, ctx field, local fixtures) are deleted, not shimmed.

**Tech Stack:** TypeScript 5.9, Node `node:test` runner via `dist/test-runner/run-tests.js`, zod v4 (`src/lib/zod.js` re-export), PowerShell 5.1.

**Precondition (hard):** the working tree currently contains another session's in-progress repo-search changes that do not compile (`src/repo-search/engine/task-loop.ts` imports `evaluateTaskSignals`, which is not exported yet). `npm run build:test` and `npm run typecheck` fail on those files, so **no task can be validated until that work compiles or is finished**. Do not touch those files.

**Dispatch batching (repo-agent, sequential, one dispatch each):**
- Dispatch A: Task 1 (idle-gate semantics — isolated on purpose)
- Dispatch B: Tasks 2 + 4 (small mechanical DRY fixes)
- Dispatch C: Tasks 3 + 5 (test-harness extraction + ps1 tooling root)

Commits are performed by the primary agent after reviewing each dispatch, not by repo-agent.

---

### Task 1: Input-only idle gate — delete the quiet-window fallback

The user directive is that assistant idleness is decided **solely** by keyboard/mouse input (shell-reported `secondsSinceInput`), gated by an instantaneous "server not busy" check. The `QuietWindowTracker` fallback, the `noteActivity` stamp, and the `ctx.assistantIdleGate` plumbing exist only to serve the fallback — remove all of it. Stale/no shell heartbeats now mean **not idle** (background work pauses), reported once on stderr.

**Files:**
- Modify: `src/status-server/assistant-idle-gate.ts` (full rewrite below)
- Modify: `src/status-server/server-ops.ts` (remove one line)
- Modify: `src/status-server/server-types.ts` (remove field + import)
- Modify: `src/status-server/index.ts` (remove hoist/assign/init)
- Modify: `tests/helpers/server-context-fixture.ts` (remove one line)
- Test: `tests/assistant-idle-gate.test.ts` (full rewrite below)

- [ ] **Step 1: Rewrite the test file (failing first)**

Replace the entire content of `tests/assistant-idle-gate.test.ts` with:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { evaluateIdle } from '../src/status-server/assistant-idle-gate.js';

test('idle requires shell-reported input quiet for the full threshold', () => {
  assert.equal(evaluateIdle(false, 180, 180), true);
  assert.equal(evaluateIdle(false, 179, 180), false);
  assert.equal(evaluateIdle(false, 500, 180), true);
});

test('server busyness overrides reported input idleness', () => {
  assert.equal(evaluateIdle(true, 500, 180), false);
});

test('missing shell input data means not idle, never a fallback path', () => {
  assert.equal(evaluateIdle(false, null, 180), false);
  assert.equal(evaluateIdle(true, null, 180), false);
});

test('a zero threshold drains as soon as input stops and the server is quiet', () => {
  assert.equal(evaluateIdle(false, 0, 0), true);
  assert.equal(evaluateIdle(true, 0, 0), false);
});

test('the gate has no quiet-window fallback and reads the configured threshold', () => {
  const gateSource = fs.readFileSync(path.join('src', 'status-server', 'assistant-idle-gate.ts'), 'utf8');

  assert.match(gateSource, /IdleSecondsBeforeProcessing/u);
  assert.doesNotMatch(gateSource, /QuietWindowTracker/u);
  assert.doesNotMatch(gateSource, /noteActivity/u);
});

test('no server code stamps or references the removed idle-gate activity plumbing', () => {
  for (const file of ['server-ops.ts', 'server-types.ts', 'index.ts']) {
    const source = fs.readFileSync(path.join('src', 'status-server', file), 'utf8');
    assert.doesNotMatch(source, /assistantIdleGate/u, file);
  }
});

test('the environment cache exposes input idleness only while heartbeats are fresh', async () => {
  const { DesktopEnvironmentCache } = await import('../src/assistant/observation/environment-cache.js');
  const { FixedClock } = await import('../src/assistant/clock.js');
  const clock = new FixedClock('2026-08-28T09:00:00.000Z');
  const cache = new DesktopEnvironmentCache(clock);

  assert.equal(cache.readInputIdleSeconds(), null);

  cache.ingest({
    schemaVersion: 1,
    capturedAtUtc: clock.nowUtc(),
    fullscreen: false,
    locked: false,
    doNotDisturb: false,
    presenting: false,
    excludedApplication: false,
    secondsSinceInput: 240,
    power: { kind: 'unavailable' },
  });
  assert.equal(cache.readInputIdleSeconds(), 240);

  clock.advanceSeconds(120);
  assert.equal(cache.readInputIdleSeconds(), null);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js assistant-idle-gate.test.ts }`
Expected: FAIL — `evaluateIdle` currently takes 5 arguments (tracker first), and the wiring assertions reject `QuietWindowTracker`/`noteActivity`/`assistantIdleGate`, which still exist.

- [ ] **Step 3: Rewrite `src/status-server/assistant-idle-gate.ts`**

Full new content:

```ts
import type { InteractivityGate } from '../assistant/jobs/job-runner.js';
import { DEFAULT_ASSISTANT_CONFIG } from '../config/defaults.js';
import { isIdle } from './server-ops.js';
import type { ServerContext } from './server-types.js';

/**
 * Idle means: the server is serving/queueing nothing right now, AND the user's keyboard/mouse
 * (shell-reported seconds since last OS input) have been quiet for the configured threshold.
 * No fresh shell heartbeat means no input data, which means not idle — background work waits
 * for the shell instead of guessing (§12.4).
 */
export function evaluateIdle(
  busy: boolean,
  inputIdleSeconds: number | null,
  thresholdSeconds: number,
): boolean {
  if (busy || inputIdleSeconds === null) {
    return false;
  }
  return inputIdleSeconds >= thresholdSeconds;
}

export class StatusServerIdleGate implements InteractivityGate {
  private reportedMissingInputData = false;

  constructor(private readonly ctx: ServerContext) {}

  isIdle(): boolean {
    const control = this.ctx.assistantControl;
    const background = control === null
      ? DEFAULT_ASSISTANT_CONFIG.Background
      : control.config.Background;
    const inputIdleSeconds = control === null ? null : control.desktopInputIdleSeconds();
    if (inputIdleSeconds === null && control !== null && control.enabled) {
      if (!this.reportedMissingInputData) {
        this.reportedMissingInputData = true;
        process.stderr.write(
          '[assistant] no fresh desktop input heartbeats; background work is paused until the shell reports.\n',
        );
      }
    } else {
      this.reportedMissingInputData = false;
    }
    return evaluateIdle(!isIdle(this.ctx), inputIdleSeconds, background.IdleSecondsBeforeProcessing);
  }
}
```

- [ ] **Step 4: Remove the dead plumbing**

1. `src/status-server/server-ops.ts` — delete the line `ctx.assistantIdleGate?.noteActivity();` (inside `acquireModelRequestWithWait`, directly after `ctx.assistant?.onInteractiveRequest();`).
2. `src/status-server/server-types.ts` — delete the field `assistantIdleGate: StatusServerIdleGate | null;` and the import `import type { StatusServerIdleGate } from './assistant-idle-gate.js';`.
3. `src/status-server/index.ts` — in the context literal delete `assistantIdleGate: null,`; in the assistant construction change back to the inline form and delete the assignment:

```ts
// BEFORE
      const assistantIdleGate = new StatusServerIdleGate(ctx);
      const assistant = AssistantService.create({
        // ...
        idleGate: assistantIdleGate,
// and later:
      ctx.assistantIdleGate = assistantIdleGate;

// AFTER
      const assistant = AssistantService.create({
        // ...
        idleGate: new StatusServerIdleGate(ctx),
// (assignment line deleted entirely)
```

4. `tests/helpers/server-context-fixture.ts` — delete the line `assistantIdleGate: null,`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js assistant-idle-gate.test.ts assistant-config-propagation.test.ts assistant-pending-captures.test.ts }`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck:test; npx tsc -p .\tsconfig.json --noEmit`
Expected: exit 0 for both.

- [ ] **Step 7: Commit (primary agent, after review)**

```powershell
git add src/status-server/assistant-idle-gate.ts src/status-server/server-ops.ts src/status-server/server-types.ts src/status-server/index.ts tests/helpers/server-context-fixture.ts tests/assistant-idle-gate.test.ts
git commit -m "fix: make assistant idleness input-only with no quiet-window fallback"
```

---

### Task 2: One source of truth for pending-capture list states

**Files:**
- Modify: `packages/contracts/src/assistant-desktop.ts` (the `PendingCaptureDtoSchema` block)
- Modify: `src/assistant/assistant-service.ts` (`listPendingCaptures`, around line 467)
- Test: `tests/assistant-pending-captures.test.ts` (append one test)

- [ ] **Step 1: Append the failing test**

Append to `tests/assistant-pending-captures.test.ts` (add `PENDING_CAPTURE_LIST_STATES` and `PendingCaptureDtoSchema` to the existing `@siftkit/contracts` import, and add `import fs from 'node:fs';`):

```ts
test('pending-capture list states have exactly one source of truth', () => {
  assert.deepEqual(PendingCaptureDtoSchema.shape.state.options, [...PENDING_CAPTURE_LIST_STATES]);

  const serviceSource = fs.readFileSync(path.join('src', 'assistant', 'assistant-service.ts'), 'utf8');
  assert.match(serviceSource, /PENDING_CAPTURE_LIST_STATES/u);
  assert.doesNotMatch(serviceSource, /'queued', 'awaiting_image_capability', 'processing'/u);
  assert.match(serviceSource, /PENDING_CAPTURE_LIST_LIMIT/u);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js assistant-pending-captures.test.ts }`
Expected: FAIL — `PENDING_CAPTURE_LIST_STATES` is not exported from `@siftkit/contracts`.

- [ ] **Step 3: Export the constant from contracts and derive the enum**

In `packages/contracts/src/assistant-desktop.ts`, change the pending-capture block to:

```ts
/** Queue states the dashboard pending view lists; the DTO state enum derives from this. */
export const PENDING_CAPTURE_LIST_STATES = ['queued', 'awaiting_image_capability', 'processing'] as const;

/** A capture still owed an extraction, listed for the dashboard pending view. */
export const PendingCaptureDtoSchema = z.object({
  evidenceId: z.string().min(1),
  state: z.enum(PENDING_CAPTURE_LIST_STATES),
  enqueuedAtUtc: z.string(),
  byteLength: z.number().int().positive(),
  foregroundContextKey: z.string(),
}).strict();
```

(`PendingCapturesResponseSchema` and the inferred types stay as they are.)

- [ ] **Step 4: Use it in the service and name the limit**

In `src/assistant/assistant-service.ts`:
1. Add a value import line `import { PENDING_CAPTURE_LIST_STATES } from '@siftkit/contracts';` (the existing contracts import is type-only; keep them separate).
2. Next to the existing `PENDING_CAPTURE_STATES` const (line ~146), add:

```ts
/** Caps each state's rows in the dashboard pending-captures listing. */
const PENDING_CAPTURE_LIST_LIMIT = 200;
```

3. In `listPendingCaptures`, replace the inline tuple and magic number:

```ts
    for (const state of PENDING_CAPTURE_LIST_STATES) {
      for (const row of this.captureQueue.listByState(this.ownerId, state, PENDING_CAPTURE_LIST_LIMIT)) {
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js assistant-pending-captures.test.ts }`
Expected: PASS (all tests in the file, including the e2e).

- [ ] **Step 6: Commit (primary agent, after review)**

```powershell
git add packages/contracts/src/assistant-desktop.ts src/assistant/assistant-service.ts tests/assistant-pending-captures.test.ts
git commit -m "refactor: single source of truth for pending-capture list states"
```

---

### Task 3: Shared assistant server-test harness with parsed bootstrap

Extract the tempRoot/env/server/teardown boilerplate (currently copied in 3+ tests) and the capture PNG fixture into one helper. The bootstrap token is zod-parsed and throws instead of silently degrading to `''`.

**Files:**
- Create: `tests/helpers/assistant-server-harness.ts`
- Modify: `tests/assistant-config-propagation.test.ts` (migrate to the harness)
- Modify: `tests/assistant-pending-captures.test.ts` (migrate to the harness)
- Modify: `tests/assistant-key-custody-routes.test.ts` (migrate to the harness)
- Modify: `tests/assistant-gate-d-e2e.test.ts` (import `CAPTURE_PNG_BYTES`/`captureSubmissionDto`, delete its local `PNG_BYTES`/`captureDto`)

- [ ] **Step 1: Create the harness helper**

`tests/helpers/assistant-server-harness.ts`:

```ts
import path from 'node:path';

import type { CaptureSubmissionDto } from '@siftkit/contracts';
import type { AssistantConfig } from '../../src/config/types.js';
import { getConfigPath } from '../../src/config/index.js';
import { getDefaultConfig, writeConfig } from '../../src/status-server/config-store.js';
import { startStatusServer } from '../../src/status-server/index.js';
import { z } from '../../src/lib/zod.js';
import { closeHttpServer, getAddressInfo, requestJson } from './dashboard-http.js';
import {
  configureDashboardTestEnv, enterDashboardTestRepo, restoreDashboardTestRepo,
} from './dashboard-test-repo.js';
import { createManagedTempDir, removeDirectoryWithRetries } from './temp-dirs.js';

const BootstrapResponseSchema = z.object({ token: z.string().min(1) });

/** 1x1 PNG used wherever a test needs real, decodable capture pixels. */
export const CAPTURE_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

export function captureSubmissionDto(pixelSeed: string, perceptualHash: string): CaptureSubmissionDto {
  return {
    schemaVersion: 1,
    capturedAtUtc: new Date().toISOString(),
    reason: 'fixed_cadence',
    display: {
      id: 'DISPLAY1', name: 'Monitor', primary: true,
      pixelWidth: 1920, pixelHeight: 1080, logicalWidth: 1920, logicalHeight: 1080,
      scaleFactor: 1,
    },
    foregroundContextKey: 'app:code|siftkit',
    foreground: {
      processName: 'Code.exe',
      executablePath: 'C:/Code.exe',
      applicationId: 'app:code',
      normalizedTitle: 'SiftKit',
      fullscreen: false,
    },
    pixelSha256: pixelSeed.repeat(64).slice(0, 64),
    perceptualHash,
    imageDataUrl: `data:image/png;base64,${CAPTURE_PNG_BYTES.toString('base64')}`,
  };
}

export interface AssistantServerHarness {
  readonly tempRoot: string;
  readonly baseUrl: string;
  /** Bearer auth for /assistant routes; the token came from a schema-parsed bootstrap. */
  readonly headers: Record<string, string>;
}

/**
 * Boots a real status server in an isolated temp repo with the given Assistant block,
 * bootstraps (and validates) an assistant token, runs `body`, then tears everything down.
 */
export async function withAssistantServer(
  prefix: string,
  assistant: AssistantConfig,
  body: (harness: AssistantServerHarness) => Promise<void>,
): Promise<void> {
  const tempRoot = createManagedTempDir(prefix);
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  writeConfig(getConfigPath(), { ...getDefaultConfig(), Assistant: assistant });
  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;
  try {
    const bootstrap = BootstrapResponseSchema.parse(
      (await requestJson(`${baseUrl}/assistant/auth/bootstrap`)).body,
    );
    await body({ tempRoot, baseUrl, headers: { Authorization: `Bearer ${bootstrap.token}` } });
  } finally {
    await closeHttpServer(server);
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await removeDirectoryWithRetries(tempRoot);
  }
}
```

(The `body` callback follows the repo's established `withAssistantContext`/`withTempEnv` fixture-lifecycle pattern.)

- [ ] **Step 2: Migrate `tests/assistant-pending-captures.test.ts`**

Rewrite the file to use the harness (behavioral assertions unchanged); it also carries the Task 2 source-of-truth test:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  PENDING_CAPTURE_LIST_STATES, PendingCaptureDtoSchema, PendingCapturesResponseSchema,
} from '@siftkit/contracts';
import { getDefaultConfig } from '../src/status-server/config-store.js';
import { requestJson } from './helpers/dashboard-http.js';
import {
  CAPTURE_PNG_BYTES, captureSubmissionDto, withAssistantServer,
} from './helpers/assistant-server-harness.js';

test('pending captures route lists queued captures whose pixels the evidence route serves', async () => {
  const initial = getDefaultConfig();
  await withAssistantServer('siftkit-pending-captures-', {
    ...initial.Assistant,
    Enabled: true,
    Observation: { ...initial.Assistant.Observation, ScreenshotsEnabled: true },
  }, async ({ baseUrl, headers }) => {
    const empty = await requestJson(`${baseUrl}/assistant/captures/pending`, { headers });
    assert.equal(empty.statusCode, 200);
    assert.deepEqual(PendingCapturesResponseSchema.parse(empty.body), { captures: [] });

    const ingested = await requestJson(`${baseUrl}/assistant/ingest/capture`, {
      method: 'POST', headers, body: JSON.stringify(captureSubmissionDto('a', 'f'.repeat(16))),
    });
    assert.equal(ingested.statusCode, 200);

    const listed = await requestJson(`${baseUrl}/assistant/captures/pending`, { headers });
    assert.equal(listed.statusCode, 200);
    const { captures } = PendingCapturesResponseSchema.parse(listed.body);
    assert.equal(captures.length, 1);
    const capture = captures[0];
    assert.ok(capture);
    assert.ok(['queued', 'awaiting_image_capability', 'processing'].includes(capture.state));
    assert.equal(capture.foregroundContextKey, 'app:code|siftkit');
    assert.equal(capture.byteLength, CAPTURE_PNG_BYTES.byteLength);
    assert.ok(capture.enqueuedAtUtc.length > 0);

    const blob = await fetch(`${baseUrl}/assistant/evidence/blob?id=${encodeURIComponent(capture.evidenceId)}`, {
      headers,
    });
    assert.equal(blob.status, 200);
    assert.equal(blob.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await blob.arrayBuffer()), CAPTURE_PNG_BYTES);
  });
});

test('pending-capture list states have exactly one source of truth', () => {
  assert.deepEqual(PendingCaptureDtoSchema.shape.state.options, [...PENDING_CAPTURE_LIST_STATES]);

  const serviceSource = fs.readFileSync(path.join('src', 'assistant', 'assistant-service.ts'), 'utf8');
  assert.match(serviceSource, /PENDING_CAPTURE_LIST_STATES/u);
  assert.doesNotMatch(serviceSource, /'queued', 'awaiting_image_capability', 'processing'/u);
  assert.match(serviceSource, /PENDING_CAPTURE_LIST_LIMIT/u);
});
```

- [ ] **Step 3: Migrate `tests/assistant-config-propagation.test.ts`**

Same mechanical migration: wrap the existing body in `withAssistantServer('siftkit-assistant-config-prop-', getDefaultConfig().Assistant, async ({ baseUrl, headers }) => { ... })`, delete the local setup/teardown/bootstrap lines, keep every assertion. This test starts with the assistant **disabled** (default config) and enables it via `PUT /config` — pass the default Assistant block unchanged.

- [ ] **Step 4: Migrate `tests/assistant-key-custody-routes.test.ts`**

Wrap in `withAssistantServer('siftkit-assistant-custody-', { ...getDefaultConfig().Assistant, Enabled: true }, ...)`. Keep all assertions, including the pre-token 401 checks (they send no Authorization header, so they still 401 after bootstrap). `keyFilePath` derives from `harness.tempRoot` as before. Delete the local setup/teardown.

- [ ] **Step 5: Dedupe the gate-d fixture**

In `tests/assistant-gate-d-e2e.test.ts`: delete the local `PNG_BYTES` const and `captureDto` function; add `import { CAPTURE_PNG_BYTES, captureSubmissionDto } from './helpers/assistant-server-harness.js';`; replace usages (`PNG_BYTES` → `CAPTURE_PNG_BYTES`, `captureDto(x, y)` → `captureSubmissionDto(x, y)`). Do not change its own `startHarness`.

- [ ] **Step 6: Run the four suites**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js assistant-pending-captures.test.ts assistant-config-propagation.test.ts assistant-key-custody-routes.test.ts assistant-gate-d-e2e.test.ts }`
Expected: PASS.

- [ ] **Step 7: Commit (primary agent, after review)**

```powershell
git add tests/helpers/assistant-server-harness.ts tests/assistant-config-propagation.test.ts tests/assistant-pending-captures.test.ts tests/assistant-key-custody-routes.test.ts tests/assistant-gate-d-e2e.test.ts
git commit -m "refactor: shared assistant server-test harness with schema-parsed bootstrap"
```

---

### Task 4: Single status-port derivation in start-dev

**Files:**
- Modify: `scripts/start-dev-ports.ts` (export `getStatusServerPort`, reuse internally at line ~64)
- Modify: `scripts/start-dev.ts` (use it in `waitForBackendReady` and `syncAssistantShell`; name the watcher interval)
- Test: `tests/start-dev-ports.test.ts` and `tests/start-dev-assistant-shell.test.ts` (append)

- [ ] **Step 1: Append the failing tests**

To `tests/start-dev-ports.test.ts` (extend the existing import from `../scripts/start-dev-ports.js` with `getStatusServerPort`):

```ts
test('status server port derives from one exported helper', () => {
  assert.equal(getStatusServerPort({}), 4765);
  assert.equal(getStatusServerPort({ SIFTKIT_STATUS_PORT: '5123' }), 5123);
});
```

To `tests/start-dev-assistant-shell.test.ts`, inside the existing wiring test `start-dev wires the assistant shell watcher into the dev stack`, append:

```ts
  assert.doesNotMatch(script, /4765/u);
  assert.match(script, /getStatusServerPort/u);
  assert.match(script, /ASSISTANT_SHELL_WATCH_INTERVAL_MS/u);
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js start-dev-ports.test.ts start-dev-assistant-shell.test.ts }`
Expected: FAIL — `getStatusServerPort` not exported; `4765` still appears twice in `start-dev.ts`.

- [ ] **Step 3: Implement**

In `scripts/start-dev-ports.ts`, next to the existing `parsePositivePort` usage (line ~64 uses `parsePositivePort(env.SIFTKIT_STATUS_PORT, 4765)`):

```ts
/** Single source for the status server port shared by port preflight, health, and config polls. */
export function getStatusServerPort(env: NodeJS.ProcessEnv): number {
  return parsePositivePort(env.SIFTKIT_STATUS_PORT, 4765);
}
```

and replace the line-64 expression with `getStatusServerPort(env)`.

In `scripts/start-dev.ts`:
1. Add `getStatusServerPort` to the existing import from `./start-dev-ports.js`.
2. Add near the other module constants: `const ASSISTANT_SHELL_WATCH_INTERVAL_MS = 5000;`
3. In `waitForBackendReady` and in `syncAssistantShell`, replace
   `const port = Number.parseInt(process.env.SIFTKIT_STATUS_PORT || '4765', 10);`
   with `const port = getStatusServerPort(process.env);`
4. Replace the watcher's `}, 5000);` with `}, ASSISTANT_SHELL_WATCH_INTERVAL_MS);`

- [ ] **Step 4: Run to verify pass**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js start-dev-ports.test.ts start-dev-assistant-shell.test.ts }`
Expected: PASS.

- [ ] **Step 5: Commit (primary agent, after review)**

```powershell
git add scripts/start-dev-ports.ts scripts/start-dev.ts tests/start-dev-ports.test.ts tests/start-dev-assistant-shell.test.ts
git commit -m "refactor: one status-port derivation for start-dev"
```

---

### Task 5: refresh-global resolves the tooling root from toolchain-paths.mjs

`scripts/desktop/toolchain-paths.mjs` exports `TOOLING_ROOT` (already honors `SIFTKIT_TOOLING_ROOT`; the ps1 child node process inherits the env, so the override keeps working). The ps1 mirror re-implements it; replace the mirror with a call.

**Files:**
- Modify: `scripts/refresh-global.ps1` (`Get-SiftKitDesktopToolingRoot`)
- Test: `tests/refresh-global-desktop.test.ts`

- [ ] **Step 1: Update the wiring test (failing first)**

In `tests/refresh-global-desktop.test.ts`, replace the first test with:

```ts
test('refresh-global resolves the tooling root from toolchain-paths.mjs, not a ps1 mirror', () => {
  assert.match(script, /toolchain-paths\.mjs/u);
  assert.match(script, /TOOLING_ROOT/u);
  assert.doesNotMatch(script, /siftkit-gate-d/u);
  assert.match(script, /cargo\\bin\\cargo-tauri\.exe/u);
  assert.match(script, /desktop:install-toolchain/u);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js refresh-global-desktop.test.ts }`
Expected: FAIL — the ps1 still hardcodes `siftkit-gate-d` and never mentions `toolchain-paths.mjs`.

- [ ] **Step 3: Replace the ps1 function**

In `scripts/refresh-global.ps1`, replace the whole `Get-SiftKitDesktopToolingRoot` function with:

```powershell
function Get-SiftKitDesktopToolingRoot {
    $toolchainPathsScript = Join-Path $script:RepoRoot 'scripts\desktop\toolchain-paths.mjs'
    $printRoot = 'const { pathToFileURL } = await import(''node:url''); const m = await import(pathToFileURL(process.argv[1]).href); process.stdout.write(m.TOOLING_ROOT);'
    $root = & node --input-type=module -e $printRoot $toolchainPathsScript
    if (-not $root) {
        throw 'Unable to resolve the desktop tooling root from scripts/desktop/toolchain-paths.mjs.'
    }
    $root
}
```

- [ ] **Step 4: Run the test and a live sanity check**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js refresh-global-desktop.test.ts }`
Expected: PASS.

Then verify the node one-liner actually prints a path:
Run: `node --input-type=module -e "const { pathToFileURL } = await import('node:url'); const m = await import(pathToFileURL(process.argv[1]).href); process.stdout.write(m.TOOLING_ROOT);" .\scripts\desktop\toolchain-paths.mjs`
Expected: prints the absolute `..\.tooling\siftkit-gate-d` path (or `$env:SIFTKIT_TOOLING_ROOT` when set).

- [ ] **Step 5: Commit (primary agent, after review)**

```powershell
git add scripts/refresh-global.ps1 tests/refresh-global-desktop.test.ts
git commit -m "refactor: refresh-global reads the tooling root from toolchain-paths.mjs"
```

---

### Final validation (primary agent, after all dispatches)

- [ ] `npm run build:test` then `npm test` — green (modulo the pre-existing `chat-tab` live-stream failure and any repo-search failures owned by the other session's work).
- [ ] `npm run typecheck` — exit 0 (blocked until the other session's repo-search changes compile).
- [ ] `npm run refresh-global` — end-to-end, including the new tooling-root resolution.

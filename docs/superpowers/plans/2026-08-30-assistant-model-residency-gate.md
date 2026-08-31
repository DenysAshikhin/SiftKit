# Assistant Model Residency Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the assistant's background drain from claiming model-backed jobs while the inference model is frozen or unloaded, so a sleeping model means paused background work instead of a stream of failed, dead-lettered jobs.

**Architecture:** A new `ModelResidencyGate` is injected into `AssistantJobRunner` beside the existing `InteractivityGate`. The runner ANDs it into the `modelWorkAllowed` flag it already computes, so "not resident" means model-backed job types are never claimed — no attempt spent, no GPU minutes billed, deterministic jobs still drain. A defence-in-depth branch in the drain's `catch` requeues (rather than fails) a model-backed job when residency dropped mid-call, and the idle controller preempts the drain before it freezes or unloads. The status-server implementation reads `PresetRuntimeCoordinator.getStatus().modelState`; when SiftKit is not managing the runtime the gate is constructed with `null` and never blocks.

**Tech Stack:** TypeScript (ESM, strict, no `any`/assertions), `node:test` + `node:assert/strict`, better-sqlite3-backed assistant job store.

---

## Background (verified facts, do not re-derive)

- Freeze sets `self.loaded = False` and `self.generator = None` on the TabbyAPI container but leaves the container object alive (`TabbyAPI/backends/exllamav3/model.py:917-919`), so `check_model_container()` (`TabbyAPI/common/model.py:310`) passes and the request proceeds to fail rather than restore. With `inline_model_loading: false` (the default, `TabbyAPI/common/config_models.py:139`) nothing reloads the model.
- The assistant reaches the model directly at the preset `BaseUrl` (`src/assistant/inference/client.ts:86` → `src/config/getters.ts:59`), bypassing `ensureActivePresetReadyForModelRequest` (`src/status-server/server-ops.ts:632`). It therefore cannot wake a frozen model.
- Freeze/unload fires on the same idle condition as the drain: `ModelIdleController.armAfterRequest` (`src/status-server/model-idle-controller.ts:17`) versus `StatusServerIdleGate.isIdle` (`src/status-server/assistant-idle-gate.ts:29`).
- Failures consume attempts at claim time and dead-letter after `DEFAULT_MAX_ATTEMPTS = 3` with `RETRY_BACKOFF_SECONDS = 30` per attempt (`src/assistant/storage/job-store.ts:36-38,109,127-136`), and `recordGpuUse` bills failed model calls against `MaxGpuMinutesPerDay` (`src/assistant/jobs/job-runner.ts:118-120`).

## File Structure

- Create `tests/helpers/assistant-gates.ts` — shared `ALWAYS_IDLE` / `ALWAYS_RESIDENT` test values (`AlwaysIdle` is currently copy-pasted into ten test files).
- Modify `src/assistant/jobs/job-runner.ts` — add `ModelResidencyGate`, gate claiming, harden the failure path.
- Modify `src/assistant/jobs/job-types.ts` — define the canonical model-backed job tuple.
- Modify `src/assistant/storage/job-store.ts` — bind that tuple into the claim-time exclusion.
- Modify `src/assistant/assistant-service.ts` — thread `residencyGate` through options; add `onModelResidencyChanging()`.
- Create `src/status-server/assistant-residency-gate.ts` — `StatusServerResidencyGate` over `PresetRuntimeCoordinator.getStatus()`.
- Modify `src/status-server/index.ts` — construct and inject the gate.
- Modify `src/status-server/model-idle-controller.ts` — preempt the drain before freeze/unload.
- Create `tests/assistant-residency-gate.test.ts` — gate unit tests.
- Modify `tests/model-residency-actions.test.ts` — behaviorally prove freeze waits for the drain.
- Modify `tests/assistant-job-runner.test.ts` — residency behaviour tests.
- Modify `tests/assistant-service.test.ts` — `onModelResidencyChanging` test.
- Modify the nine other test files that construct `AssistantService` — supply `residencyGate`.

---

### Task 1: Share the idle-gate test double

`AlwaysIdle` is duplicated in ten test files. Task 2 adds a second gate to the same option objects; sharing first keeps that change to one line per file instead of a second ten-way copy-paste.

**Files:**
- Create: `tests/helpers/assistant-gates.ts`
- Modify: `tests/assistant-backup-restore.test.ts:126`, `tests/assistant-capture-retention.test.ts:250`, `tests/assistant-desktop-state.test.ts:44`, `tests/assistant-gate-b-e2e.test.ts:21`, `tests/assistant-gate-c-e2e.test.ts:15`, `tests/assistant-gate-d-e2e.test.ts:42`, `tests/assistant-gate-e-e2e.test.ts:48`, `tests/assistant-image-extraction.test.ts:118`, `tests/assistant-mobile-envelope.test.ts:24`, `tests/assistant-service.test.ts:19`

- [ ] **Step 1: Create the shared helper**

`tests/helpers/assistant-gates.ts`:

```ts
import type { InteractivityGate } from '../../src/assistant/jobs/job-runner.js';

/** The host is always quiet, so every drain in these suites is allowed to claim. */
export const ALWAYS_IDLE = {
  isIdle(): boolean {
    return true;
  },
} satisfies InteractivityGate;
```

- [ ] **Step 2: Delete each local copy and import the shared one**

In each of the ten files listed above, delete the local `class AlwaysIdle { ... }` declaration and add this import next to the file's other `./helpers/...` imports:

```ts
import { ALWAYS_IDLE } from './helpers/assistant-gates.js';
```

- [ ] **Step 3: Verify no local copies remain**

Run: `git grep -n "class AlwaysIdle" -- tests`
Expected: no matches.

- [ ] **Step 4: Run the touched suites**

Run: `npm run test 2>&1 | siftkit summary --question "Return pass/fail, failing test names, root errors, and file:line anchors."`
Expected: pass, with the same test counts as before the change.

- [ ] **Step 5: Commit**

```bash
git add tests/helpers/assistant-gates.ts tests/assistant-backup-restore.test.ts tests/assistant-capture-retention.test.ts tests/assistant-desktop-state.test.ts tests/assistant-gate-b-e2e.test.ts tests/assistant-gate-c-e2e.test.ts tests/assistant-gate-d-e2e.test.ts tests/assistant-gate-e-e2e.test.ts tests/assistant-image-extraction.test.ts tests/assistant-mobile-envelope.test.ts tests/assistant-service.test.ts
git commit -m "test: share the AlwaysIdle assistant gate double"
```

---

### Task 2: Gate model-backed job claiming on model residency

**Files:**
- Modify: `src/assistant/jobs/job-runner.ts:15-18` (interfaces), `:20-34` (options), `:73-127` (drain)
- Modify: `src/assistant/jobs/job-types.ts:12-19` (canonical model-backed types)
- Modify: `src/assistant/storage/job-store.ts:94-97` (claim-time model-backed exclusion list)
- Modify: `src/assistant/assistant-service.ts:39` (import), `:119` (options), `:318-338` (runner construction)
- Create: `src/status-server/assistant-residency-gate.ts`
- Modify: `src/status-server/index.ts:101` (import), `:343` (wiring)
- Modify: `tests/helpers/assistant-gates.ts`
- Modify: `tests/assistant-job-runner.test.ts`, plus the ten `AssistantService.create` call sites from Task 1
- Create: `tests/assistant-residency-gate.test.ts`

- [ ] **Step 1: Write the failing runner tests**

In `tests/assistant-job-runner.test.ts`, add this directly after the existing `class StaticIdleGate` declaration (around line 43):

```ts
class StaticResidencyGate {
  constructor(private resident: boolean) {}

  isModelResident(): boolean {
    return this.resident;
  }

  setResident(resident: boolean): void {
    this.resident = resident;
  }
}

const RESIDENT = new StaticResidencyGate(true);
```

Then, in every existing `new AssistantJobRunner({ ... })` literal in this file (lines 126, 185, 216, 267, 300, 329, 369, 417), add `residencyGate: RESIDENT,` immediately after the `idleGate:` property.

Then append these two tests to the end of the file:

```ts
test('a frozen model claims no model-backed job and spends no attempt', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    const pipeline = new IngestionPipeline(graph, new SecretScanner(), 800);
    new ConversationIngestor(pipeline).ingestTurn({
      ownerId, sessionId: 'chat_1', capturedAtUtc: '2026-08-05T09:00:00.000Z',
      userMessageId: 'm1', userText: 'I use PowerShell.',
      assistantMessageId: 'm2', assistantText: '',
    });
    graph.jobs.enqueue({
      ownerId, jobType: 'image_extraction', payload: { evidenceId: 'evidence_1' },
      idempotencyKey: 'image-extraction:residency-gate',
    }, JOB_PRIORITIES.ImageExtraction);
    const inference = new FakeAssistantInference([]);
    const runner = new AssistantJobRunner({
      graph,
      ...UNUSED_GATE_C_JOBS,
      extractor: new ConversationExtractor(graph, new StructuredOutputRunner(inference)),
      promoter: new CandidatePromoter(graph, new CandidateGate(graph.policies, new SecretScanner())),
      consolidator: new CandidateConsolidator(graph, new StructuredOutputRunner(inference)),
      projections: projectionCompiler(graph),
      idleGate: new StaticIdleGate(true),
      residencyGate: new StaticResidencyGate(false),
      resourcePolicy: new NoLimitResourcePolicy(),
      jobPriorities: JOB_PRIORITIES,
      leaseOwner: 'runner_test',
      leaseSeconds: 120,
    });

    const summary = await runner.drain(ownerId, 10);

    assert.equal(summary.claimed, 0);
    assert.equal(summary.failed, 0);
    const queued = graph.jobs.listByStatus(ownerId, 'queued');
    const conversation = queued.find((job) => job.job_type === 'conversation_ingestion');
    const image = queued.find((job) => job.job_type === 'image_extraction');
    assert.equal(conversation?.attempts, 0, 'a sleeping model must not burn the attempt budget');
    assert.equal(image?.attempts, 0, 'image extraction must not be claimed against a sleeping model');
  });
});

test('a frozen model still lets deterministic jobs drain', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    graph.jobs.enqueue({
      ownerId, jobType: 'capture_retention',
      payload: { reason: 'schedule' },
      idempotencyKey: 'capture_retention:schedule',
    }, JOB_PRIORITIES.CaptureRetention);
    const inference = new FakeAssistantInference([]);
    const runner = new AssistantJobRunner({
      graph,
      ...UNUSED_GATE_C_JOBS,
      extractor: new ConversationExtractor(graph, new StructuredOutputRunner(inference)),
      promoter: new CandidatePromoter(graph, new CandidateGate(graph.policies, new SecretScanner())),
      consolidator: new CandidateConsolidator(graph, new StructuredOutputRunner(inference)),
      projections: projectionCompiler(graph),
      idleGate: new StaticIdleGate(true),
      residencyGate: new StaticResidencyGate(false),
      resourcePolicy: new NoLimitResourcePolicy(),
      jobPriorities: JOB_PRIORITIES,
      leaseOwner: 'runner_test',
      leaseSeconds: 120,
    });

    const summary = await runner.drain(ownerId, 10);

    assert.equal(summary.completed, 1);
    assert.equal(graph.jobs.countByStatus(ownerId, 'queued'), 0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run typecheck`
Expected: FAIL — `residencyGate` does not exist on `AssistantJobRunnerOptions`.

- [ ] **Step 3: Add the interface and the option**

In `src/assistant/jobs/job-runner.ts`, after the existing `InteractivityGate` block (lines 15-18), add:

```ts
/**
 * Background model work only runs while the model is actually resident. Freeze and idle-unload
 * fire on the same idle condition the drain does, and the assistant talks to the inference
 * server directly, so it can only fail against a sleeping model — never wake it (§12.4).
 */
export interface ModelResidencyGate {
  isModelResident(): boolean;
}
```

In `AssistantJobRunnerOptions`, directly after `readonly idleGate: InteractivityGate;`:

```ts
  readonly residencyGate: ModelResidencyGate;
```

- [ ] **Step 4: Gate claiming on residency**

In `src/assistant/jobs/job-types.ts`, export the single canonical model-backed tuple and use it in
`isModelBackedJobType`:

```ts
export const MODEL_BACKED_JOB_TYPES = [
  'conversation_ingestion', 'candidate_consolidation', 'question_answer_ingestion',
  'question_planning', 'projection_summarization', 'image_extraction',
] as const satisfies readonly AssistantJobType[];
```

In `src/assistant/storage/job-store.ts`, derive SQL placeholders from that tuple and bind the tuple
values after the existing claim parameters. This keeps SQL-level exclusion and
`isModelBackedJobType` on the same source of truth. It is required for the test above to report
`summary.claimed === 0`; relying only on the runner's post-claim check would consume and refund an
attempt on every drain.

In `src/assistant/jobs/job-runner.ts`, add this private method to `AssistantJobRunner`, directly above `drain`:

```ts
  /** Model work needs budget *and* a resident model; either one missing means hold, not fail. */
  private modelWorkAvailable(): boolean {
    return this.options.resourcePolicy.canStartModelWork().kind === 'allowed'
      && this.options.residencyGate.isModelResident();
  }
```

Replace line 84:

```ts
      const modelWorkAllowed = this.options.resourcePolicy.canStartModelWork().kind === 'allowed';
```

with:

```ts
      const modelWorkAllowed = this.modelWorkAvailable();
```

Replace lines 100-103:

```ts
        if (modelBacked && this.options.resourcePolicy.canStartModelWork().kind === 'blocked') {
          this.options.graph.jobs.requeuePreempted(job.id);
          break;
        }
```

with:

```ts
        if (modelBacked && !this.modelWorkAvailable()) {
          this.options.graph.jobs.requeuePreempted(job.id);
          break;
        }
```

- [ ] **Step 5: Thread the gate through AssistantService**

In `src/assistant/assistant-service.ts`, replace line 39:

```ts
import {
  AssistantJobRunner, type InteractivityGate, type ModelResidencyGate,
} from './jobs/job-runner.js';
```

In `AssistantServiceOptions`, directly after `readonly idleGate: InteractivityGate;` (line 119):

```ts
  readonly residencyGate: ModelResidencyGate;
```

In the `new AssistantJobRunner({ ... })` literal, directly after `idleGate: options.idleGate,`:

```ts
      residencyGate: options.residencyGate,
```

- [ ] **Step 6: Add the shared resident double and update every call site**

Replace the contents of `tests/helpers/assistant-gates.ts` with:

```ts
import type {
  InteractivityGate, ModelResidencyGate,
} from '../../src/assistant/jobs/job-runner.js';

/** The host is always quiet, so every drain in these suites is allowed to claim. */
export const ALWAYS_IDLE = {
  isIdle(): boolean {
    return true;
  },
} satisfies InteractivityGate;

/** These suites never exercise residency; the model is treated as loaded throughout. */
export const ALWAYS_RESIDENT = {
  isModelResident(): boolean {
    return true;
  },
} satisfies ModelResidencyGate;
```

In each of the ten test files from Task 1, change the helper import to:

```ts
import { ALWAYS_IDLE, ALWAYS_RESIDENT } from './helpers/assistant-gates.js';
```

and add `residencyGate: ALWAYS_RESIDENT,` immediately after each `idleGate: ALWAYS_IDLE,` line.

- [ ] **Step 7: Write the failing status-server gate test**

Create `tests/assistant-residency-gate.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import type { InferenceModelState, InferenceRuntimeStatus } from '@siftkit/contracts';
import { StatusServerResidencyGate } from '../src/status-server/assistant-residency-gate.js';

function statusWith(modelState: InferenceModelState): InferenceRuntimeStatus {
  return {
    activePresetId: 'preset_a',
    activePresetLabel: 'Preset A',
    backend: 'exl3',
    idleAction: 'freeze',
    freezeSupported: true,
    processState: 'ready',
    modelState,
    model: 'model-a',
    idleDeadlineUtc: null,
    errorPhase: null,
    error: null,
    rollback: null,
  };
}

test('only a ready model counts as resident', () => {
  const notResident: readonly InferenceModelState[] = [
    'unloaded', 'loading', 'unloading', 'freezing', 'frozen', 'failed',
  ];
  for (const state of notResident) {
    const gate = new StatusServerResidencyGate({ getStatus: () => statusWith(state) });
    assert.equal(gate.isModelResident(), false, state);
  }
  const ready = new StatusServerResidencyGate({ getStatus: () => statusWith('ready') });
  assert.equal(ready.isModelResident(), true);
});

test('an unmanaged runtime is never gated', () => {
  assert.equal(new StatusServerResidencyGate(null).isModelResident(), true);
});
```

- [ ] **Step 8: Run the gate test to verify it fails**

Run: `npx tsx --test tests/assistant-residency-gate.test.ts`
Expected: FAIL — cannot resolve `../src/status-server/assistant-residency-gate.js`.

- [ ] **Step 9: Implement the status-server gate**

Create `src/status-server/assistant-residency-gate.ts`:

```ts
import type { ModelResidencyGate } from '../assistant/jobs/job-runner.js';
import type { PresetRuntimeCoordinator } from './preset-runtime-coordinator.js';

/**
 * Residency for the assistant's background drain. `null` means SiftKit is not managing the
 * inference runtime (managed startup disabled), so there is no residency to respect and nothing
 * is gated. Anything other than `ready` — frozen, unloaded, loading, failed — holds model work.
 */
export class StatusServerResidencyGate implements ModelResidencyGate {
  constructor(
    private readonly coordinator: Pick<PresetRuntimeCoordinator, 'getStatus'> | null,
  ) {}

  isModelResident(): boolean {
    return this.coordinator === null || this.coordinator.getStatus().modelState === 'ready';
  }
}
```

- [ ] **Step 10: Wire it into the status server**

In `src/status-server/index.ts`, next to the existing idle-gate import (line 101):

```ts
import { StatusServerResidencyGate } from './assistant-residency-gate.js';
```

In the `AssistantService.create({ ... })` literal, directly after `idleGate: new StatusServerIdleGate(ctx),`:

```ts
        residencyGate: new StatusServerResidencyGate(
          disableManagedLlamaStartup ? null : presetRuntimeCoordinator,
        ),
```

`disableManagedLlamaStartup` and the local `presetRuntimeCoordinator` const are both already in scope at that point (see `src/status-server/index.ts:316-326`).

- [ ] **Step 11: Run the tests to verify they pass**

Run: `npx tsx --test tests/assistant-residency-gate.test.ts tests/assistant-job-runner.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: no errors. A missing `residencyGate` at any `AssistantService.create` call site is the intended loud failure — fix each call site rather than giving the option a default.

- [ ] **Step 12: Commit**

```bash
git add src/assistant/jobs/job-types.ts src/assistant/jobs/job-runner.ts src/assistant/storage/job-store.ts src/assistant/assistant-service.ts src/status-server/assistant-residency-gate.ts src/status-server/index.ts tests/helpers/assistant-gates.ts tests/assistant-residency-gate.test.ts tests/assistant-job-runner.test.ts tests/assistant-backup-restore.test.ts tests/assistant-capture-retention.test.ts tests/assistant-desktop-state.test.ts tests/assistant-gate-b-e2e.test.ts tests/assistant-gate-c-e2e.test.ts tests/assistant-gate-d-e2e.test.ts tests/assistant-gate-e-e2e.test.ts tests/assistant-image-extraction.test.ts tests/assistant-mobile-envelope.test.ts tests/assistant-service.test.ts
git commit -m "feat: hold assistant background model work while the model is not resident"
```

---

### Task 3: Never burn an attempt on a model that went to sleep mid-drain

Residency can drop between the claim and the HTTP call. That failure must return the job to the queue like a preemption instead of consuming one of its three attempts, and must not bill GPU minutes for a call that never reached a resident model.

**Files:**
- Modify: `src/assistant/jobs/job-runner.ts:105-126` (the `try`/`catch`/`finally` inside `drain`)
- Test: `tests/assistant-job-runner.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/assistant-job-runner.test.ts`:

```ts
test('a model that freezes mid-call requeues the job without spending an attempt', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    const pipeline = new IngestionPipeline(graph, new SecretScanner(), 800);
    new ConversationIngestor(pipeline).ingestTurn({
      ownerId, sessionId: 'chat_1', capturedAtUtc: '2026-08-05T09:00:00.000Z',
      userMessageId: 'm1', userText: 'I use PowerShell.',
      assistantMessageId: 'm2', assistantText: '',
    });

    const residencyGate = new StaticResidencyGate(true);
    let recordedGpuUse = 0;

    class FreezingInference extends FakeAssistantInference {
      constructor() {
        super([]);
      }

      async complete(): Promise<never> {
        residencyGate.setResident(false);
        throw new Error('HTTP 500: inline_model_loading is not True in config.yml.');
      }
    }

    class CountingResourcePolicy extends NoLimitResourcePolicy {
      recordGpuUse(): void {
        recordedGpuUse += 1;
      }
    }

    const runner = new AssistantJobRunner({
      graph,
      ...UNUSED_GATE_C_JOBS,
      extractor: new ConversationExtractor(
        graph, new StructuredOutputRunner(new FreezingInference()),
      ),
      promoter: new CandidatePromoter(graph, new CandidateGate(graph.policies, new SecretScanner())),
      consolidator: new CandidateConsolidator(
        graph, new StructuredOutputRunner(new FakeAssistantInference([])),
      ),
      projections: projectionCompiler(graph),
      idleGate: new StaticIdleGate(true),
      residencyGate,
      resourcePolicy: new CountingResourcePolicy(),
      jobPriorities: JOB_PRIORITIES,
      leaseOwner: 'runner_test',
      leaseSeconds: 120,
    });

    const summary = await runner.drain(ownerId, 10);

    assert.equal(summary.failed, 0);
    assert.equal(summary.preempted, 1);
    assert.equal(recordedGpuUse, 0, 'a call that never reached a resident model is not GPU time');
    const queued = graph.jobs.listByStatus(ownerId, 'queued')
      .filter((job) => job.job_type === 'conversation_ingestion');
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.attempts, 0);
  });
});
```

`NoLimitResourcePolicy` is declared with `class` at the top of this file, so `extends` works as written.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test tests/assistant-job-runner.test.ts`
Expected: FAIL — `summary.failed` is 1, `summary.preempted` is 0, `recordedGpuUse` is 1, and the queued job has `attempts` 1.

- [ ] **Step 3: Add the residency branch to the catch**

In `src/assistant/jobs/job-runner.ts`, inside `drain`'s `catch (error)` block, directly after the existing preemption branch, add:

```ts
        if (modelBacked && !this.options.residencyGate.isModelResident()) {
          // The model went to sleep under the call. That is residency, not a bad job: give the
          // attempt back and stop the drain until the model is resident again.
          this.options.graph.jobs.requeuePreempted(job.id);
          preempted += 1;
          shouldRecordGpuUse = false;
          break;
        }
```

`shouldRecordGpuUse` is already declared with `let` above the `try` and read by the `finally`, so clearing it here suppresses the `recordGpuUse` call.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test tests/assistant-job-runner.test.ts`
Expected: PASS, every test in the file.

- [ ] **Step 5: Commit**

```bash
git add src/assistant/jobs/job-runner.ts tests/assistant-job-runner.test.ts
git commit -m "fix: requeue assistant jobs when the model sleeps mid-call instead of failing them"
```

---

### Task 4: Preempt the drain before freezing or unloading

Closes the race at its source: the idle controller stops background work and waits for the in-flight drain before it asks the runtime to freeze or unload.
While that drain unwinds, the service also blocks new drains so the periodic tick cannot reset
preemption and start a second model call before the runtime enters its residency transition.
`drainJobs()` is single-flight as well: a normal 20-second tick cannot overwrite `activeDrain`
while a previous long-running drain is still in progress.

**Files:**
- Modify: `src/assistant/assistant-service.ts:610-613` (add `onModelResidencyChanging` after `onInteractiveRequest`)
- Modify: `src/status-server/model-idle-controller.ts:46-65` (`expire`)
- Test: `tests/assistant-service.test.ts`, `tests/model-residency-actions.test.ts`

- [ ] **Step 1: Write deterministic failing service and controller integration tests**

In `tests/assistant-service.test.ts`, extend `GateInference` with a `callStarted` promise that is
resolved as the first statement of `complete()`. Await that promise in the new test instead of a
timer so the test knows the drain is inside the model call.

Append to `tests/assistant-service.test.ts`:

```ts
test('a residency change preempts the drain and waits for it to finish', async () => {
  try {
    const inference = new GateInference();
    const service = buildService({ inference });
    service.ingestChatTurn({
      ownerId: service.ownerId, sessionId: 'chat_residency',
      capturedAtUtc: '2026-08-05T09:00:00.000Z',
      userMessageId: 'm1', userText: 'I use PowerShell.',
      assistantMessageId: 'm2', assistantText: 'Noted.',
    });

    const order: string[] = [];
    const drain = service.drainJobs();
    void drain.then(() => order.push('drain'));
    await inference.callStarted;

    const residency = service.onModelResidencyChanging().then(() => order.push('residency'));
    inference.release();
    await drain;
    await residency;

    assert.deepEqual(order, ['drain', 'residency']);
  } finally {
    closeRuntimeDatabase();
  }
});
```

Mirror the teardown of the neighbouring tests in this file exactly; if they use a helper other than `closeRuntimeDatabase()`, use theirs.

In `tests/model-residency-actions.test.ts`, add a behavioral integration test using the existing
`createCoordinatorFixture`, `BlockingRecordingInferenceRuntime`, and `createDeferred` helpers:

1. Return `ctx` from `createCoordinatorFixture` and construct a real enabled `AssistantService`
   against `getRuntimeDatabase(fixture.configPath)` with `ALWAYS_IDLE`,
   `StatusServerResidencyGate(fixture.coordinator)`, and a blocking inference fake whose
   `callStarted` and `releaseCall()` are deferreds.
2. Assign that service to `fixture.ctx.assistant` and `fixture.ctx.assistantControl`, enqueue a
   conversation turn, start `drainJobs()`, and await the inference fake's `callStarted.promise`.
3. Arm the controller for a 1 ms frozen transition. While inference remains blocked, use the
   suite's bounded `Promise.race` pattern to prove `transitionStarted.promise` is still pending and
   assert the captured abort signal is aborted.
4. Release inference, await the drain, then await `transitionStarted`; assert the exact order is
   `['drain', 'freeze']` and the runtime events are `['freeze:exl3']`.
5. In `finally`, release both held transitions, await the drain if started, then call fixture
   cleanup. Do not use casts, source-text assertions, or fixed sleeps.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build:test` then
`npm run test -- tests/assistant-service.test.ts tests/model-residency-actions.test.ts`
Expected: FAIL because `service.onModelResidencyChanging` is not a function and freeze starts while
the assistant drain is still blocked.

- [ ] **Step 3: Add the service hook**

In `src/assistant/assistant-service.ts`, directly after `onInteractiveRequest()`:

First rename `maintenancePending` to `drainBlockers`; keep the existing maintenance increments,
decrements, and `drainJobs()` guard on that shared counter. Add an `activeDrain !== null` early
return to `drainJobs()` so the timer cannot start overlapping drains. Extract the shared
`preemptAndAwaitActiveDrain()` helper used by maintenance and residency changes. Then add:

```ts
  /**
   * Called by the host before it freezes or unloads the model (§12.4). Background model work
   * cannot survive the transition and cannot wake the model back up, so the drain is preempted
   * and awaited before residency changes.
   */
  async onModelResidencyChanging(): Promise<void> {
    this.drainBlockers += 1;
    try {
      await this.preemptAndAwaitActiveDrain();
    } finally {
      this.drainBlockers -= 1;
    }
  }
```

- [ ] **Step 4: Call it from the idle controller**

In `src/status-server/model-idle-controller.ts`, inside `expire()`, insert immediately before the `try {` that wraps `applyIdleResidencyAction`:

```ts
    // Background assistant work talks to the inference server directly and cannot wake a frozen
    // model, so it is stopped before residency changes rather than left to fail against it.
    await this.ctx.assistantControl?.onModelResidencyChanging();
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run build:test` then
`npm run test -- tests/assistant-service.test.ts tests/model-residency-actions.test.ts`
Expected: PASS. The service hook waits for the drain, and the real idle controller does not enter
freeze until that hook has completed.

- [ ] **Step 6: Run the full verification set**

Run: `npm run test 2>&1 | siftkit summary --question "Return pass/fail, failing test names, root errors, and file:line anchors."`
Expected: pass.

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/assistant/assistant-service.ts src/status-server/model-idle-controller.ts tests/assistant-service.test.ts tests/model-residency-actions.test.ts
git commit -m "feat: stop assistant background work before the model freezes or unloads"
```

---

## Out of scope

- Waking the model for background work (rejected: freeze and the drain share an idle trigger, so a waking drain would keep the GPU up on a 20-second cadence).
- Any change to `inline_model_loading` or the TabbyAPI fork.
- Surfacing a `blocked_model_not_resident` reason in `ResourceDecision` or on the dashboard — the residency gate is deliberately separate from `ResourcePolicy`, and nothing consumes such a reason today.

# Orchestrator Live-Validation Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every finding (F1–F15) from `docs/superpowers/plans/2026-09-24-orchestrator-live-validation-results.md` so that correct worker code is never failed by the orchestrator, model switches never crash TabbyAPI, and then re-validate on real models.

**Architecture:**
- **Model switching.** The model switch writes its selection to config before admission reopens (F4). A stopped TabbyAPI only counts as unloaded once its VRAM is released (F13).
- **Parent answers.**
  - They are parsed leniently: the JSON object is extracted from surrounding prose or a fence, and keys the schema doesn't define are dropped. Values are still validated by the schema (F5, F7, F10).
  - Every parent phase start records its label and the reason for any retry (F1).
  - Infrastructure failures retry once and then fail the run as `infrastructure_failed`. They are never recorded as a denial (F13).
  - The parent's own bad answers and bad citations are retried on the parent's side and never use up a worker attempt (F6, F10).
- **Plan checks.** Check commands are preflighted in the real check shell (F14).
- **Terminal runs.** A terminal run closes its open tasks, attempts and children (F15) and cleans `scratch/` (F12).
- **Smaller fixes:** F2, F3, F8 and F9. F11 only needs a design-doc correction: `tests/process/orchestrator-run.e2e.test.ts:140` already shows that in `auto` mode a child's `unsure` verdict reaches the parent.

**Tech Stack:** TypeScript, zod 4, node:test, the SiftKit status server, and PowerShell 5.1 (`powershell.exe`) for checks.

**Rules for every task:**
- Follow TDD: write the failing test, run it and see it fail, implement the minimum, then see it pass.
- Forbidden: `any`, type assertions, and non-null assertions.
- Do not commit.
- Do not create temporary files outside the OS temp dir.
- Do not touch other tasks.

**Test commands:**
- **Build:** `npm run build:test`. Always run it before any run below.
- **Single node-suite file:** `node .\dist\test-runner\run-tests.js tests/<file>.test.ts`.
- **Process suite file:** `node .\dist\test-runner\run-tests.js tests/process/<file>.test.ts`.
- **Narrow to one test:** append `--test-name-pattern="<regex>"`.

---

## File map

| File | Change |
|---|---|
| `src/status-server/preset-runtime-coordinator.ts` | Switch kind replaces `forceRestart`; a requested switch persists its selection inside the switch (F4) |
| `src/status-server/engine-process.ts` | `ManagedEngineHost.gpuMemory` probe (F13) |
| `src/status-server/managed-tabby.ts` | Record a VRAM baseline before launch; stop waits for VRAM release (F13) |
| `src/status-server/index.ts` | Pass `repoAgentRunStore` to `reconcileOnStartup` (F15) |
| `src/lib/model-json.ts` | Lenient `parseObject`: embedded-object extraction plus removal of unrecognized keys (F5/F7/F10) |
| `src/orchestrator/phase-runner.ts` | `OrchestratorPhaseLog`, phase labels, infrastructure retry, `OrchestratorInfrastructureError` (F1/F13) |
| `src/orchestrator/run.ts` | Phase log, decision retry and events, evidence-review retry, check preflight, failure cleanup (F1/F6/F10/F12/F13/F14) |
| `src/orchestrator/verification.ts` | `findReviewEvidenceProblems` (F6) |
| `src/orchestrator/prompts.ts` | Review retry text and the check-shell rule (F6/F14) |
| `src/orchestrator/check-preflight.ts` (new) | `findUnrunnableChecks` (F14) |
| `src/orchestrator/run-store.ts` | Close open work on terminal phases (F15) |
| `src/status-server/orchestrator-runs.ts` | Mark running children not resumable on startup (F15) |
| `packages/contracts/src/orchestrator.ts` | Attempt status `abandoned` (F15) |
| `src/cli/run-orchestrator.ts` | Per-task `output` (F2) |
| `src/orchestrator/workers.ts` | Child `requestId = childRunId` (F3) |
| `src/status-server/repo-agent-lock-adapter.ts`, `src/status-server/routes/repo-agent.ts` | Lock kind per worker (F9) |
| `src/repo-search/prompts.ts` | Leave `.siftkit` out of the file listing (F8) |
| `docs/superpowers/plans/2026-09-22-orchestrator-preset.md` | Child-approval wording (F11) |
| Tests | `tests/preset-runtime-coordinator.test.ts`, `tests/managed-tabby.test.ts`, `tests/model-json.test.ts`, `tests/orchestrator-check-preflight.test.ts` (new), `tests/orchestrator-run-store.test.ts`, `tests/orchestrator-runs.test.ts`, `tests/model-request-queue.test.ts`, `tests/repo-file-listing.test.ts` (new), `tests/process/orchestrator-run.e2e.test.ts`, helpers `tests/helpers/scripted-engine-service.ts`, `tests/helpers/tabby-fake.ts`, `tests/helpers/in-process-tabby.ts`, `tests/helpers/managed-engine-fixtures.ts` |

---

### Task 1: A requested model switch persists its selection before admission reopens (F4)

**Why:**
1. `ensureRequestPresetReady` persists the selection only after `startPendingSwitch` has cleared `switchPromise`.
2. A `GET /config` caller waiting in `ensureActivePresetReady` wakes up, still reads the old `ActivePresetId`, and switches back.
3. Once the persist lands, that caller switches forward again. That produces the target → previous → target pattern.

**Files:**
- Modify: `src/status-server/preset-runtime-coordinator.ts`
- Test: `tests/preset-runtime-coordinator.test.ts`

- [ ] **Step 1: Write the failing test.** Add it after the test `'a settings save landing while a requested switch is blocked is preserved'`:

```ts
test('a readiness check joining a requested switch sees the new selection and never switches back', async () => {
  const fixture = createBlockingCoordinator();
  const { coordinator, events, configPath, runtime } = fixture;
  try {
    await coordinator.initialize();
    const target = readConfig(configPath).Server.ModelPresets.Presets.find((preset) => preset.id === 'exl3-alt');
    assert.ok(target);
    runtime.setBlockedTransition('ensure');
    events.length = 0;

    const requested = coordinator.ensureRequestPresetReady(target);
    await runtime.transitionStarted.promise;
    const readiness = coordinator.ensureActivePresetReady(); // what GET /config does
    runtime.setBlockedTransition(null);
    runtime.releaseTransition();
    await Promise.all([requested, readiness]);

    assert.deepEqual(events, ['unload:exl3', 'load:exl3-alt'], 'one switch, never back to the previous model');
    assert.equal(readConfig(configPath).Server.ModelPresets.ActivePresetId, 'exl3-alt');
    assert.equal(coordinator.getStatus().activePresetId, 'exl3-alt');
  } finally {
    await disposeCoordinator(fixture);
  }
});
```

- [ ] **Step 2: Run it and confirm it fails.**
  - Run: `npm run build:test; node .\dist\test-runner\run-tests.js tests/preset-runtime-coordinator.test.ts --test-name-pattern="never switches back"`
  - Expected: FAIL. `events` is `['unload:exl3','load:exl3-alt','unload:exl3','load:exl3-main','unload:exl3','load:exl3-alt']`.

- [ ] **Step 3: Implement.** In `preset-runtime-coordinator.ts`:
  - Add this type above the class:

```ts
/** Administrative switches apply a saved selection; requested ones persist theirs inside the switch; restarts force a new process. */
type SwitchKind = 'administrative' | 'requested' | 'restart';
```

  - Replace the field `private pendingForceRestart = false;` with `private pendingKind: SwitchKind = 'administrative';`, and change `switchPromise` to `Promise<void> | null`.
  - In `applyPreset`, call `this.setPendingSwitch(target, 'administrative');`.
  - In `restartConfiguredPreset`, call `this.setPendingSwitch(configured, 'restart');`.
  - In `ensureRequestPresetReady`, replace the last three lines with:

```ts
    this.setPendingSwitch(requested, 'requested');
    await this.startPendingSwitch();
  }
```

  - Replace `setPendingSwitch`, `startPendingSwitch` and the `executeSwitch` signature and success path with:

```ts
  private setPendingSwitch(target: ModelRuntimePreset, kind: SwitchKind): void {
    if (this.pendingTarget === null) this.beginAdmissionBlocker();
    this.pendingTarget = structuredClone(target);
    this.pendingKind = kind;
    this.errorPhase = null;
    this.error = null;
    this.rollback = null;
  }

  private async startPendingSwitch(): Promise<void> {
    if (this.switchPromise) return this.switchPromise;
    if (this.pendingTarget === null) return;
    const target = this.pendingTarget;
    try {
      const expected = readConfig(this.configPath);
      this.findPreset(expected, target.id);
      this.switchPromise = this.executeSwitch(target, this.pendingKind, expected);
      await this.switchPromise;
    } finally {
      this.switchPromise = null;
      this.pendingTarget = null;
      this.pendingKind = 'administrative';
      this.endAdmissionBlocker();
    }
  }
```

```ts
  private async executeSwitch(target: ModelRuntimePreset, kind: SwitchKind, expected: SiftConfig): Promise<void> {
    const previous = this.appliedModelPresetState.getPreset();
    const runtime = this.runtime;
    const forceRestart = kind === 'restart';
    const reuseResidency = !forceRestart && this.hasReadyResidency(target);
    try {
      if (!reuseResidency) await runtime.unloadPreset();
      if (forceRestart) await runtime.stopProcess();
      await runtime.ensurePresetReady(target);
      this.publishReadyPreset(target);
      // A requested switch saves its selection before admission reopens, so a joined readiness check never sees the old one.
      // The compare-and-set keeps a newer settings save.
      if (kind === 'requested') persistAppliedModelSelection(this.configPath, expected, target);
    } catch (error) {
      // unchanged rollback body …
      throw error;
    }
  }
```

  - Keep the `catch` body exactly as it is.
  - Remove the now-unused `return expected;` and any `SiftConfig` return plumbing.
  - `onModelRequestReleased`, `ensureActivePresetReady` and `shutdown` keep awaiting `switchPromise` unchanged.

- [ ] **Step 4: Run the whole coordinator file and confirm it passes.**
  - Run: `npm run build:test; node .\dist\test-runner\run-tests.js tests/preset-runtime-coordinator.test.ts`
  - Expected: every test passes, including `'a settings save landing while a requested switch is blocked is preserved'`. That test proves the compare-and-set still keeps a newer save.

**Acceptance:**
- The new test passes.
- No existing coordinator test changed.
- `pendingForceRestart` no longer exists.

---

### Task 2: A stopped TabbyAPI counts as unloaded only after its VRAM is released (F13, infrastructure)

**Why:**
- `ManagedTabbyRuntime.stopProcess` waits only for the root process to exit, and then the next model spawns immediately.
- On Windows (WDDM) the driver releases VRAM after process exit. The next load then found only 720 MiB free and crashed.
- The runtime will now record GPU `usedBytes` before each launch. After a stop, it polls until usage is back within 1 GiB of that baseline. If that doesn't happen within `ShutdownTimeoutMs` (default 30 s), the stop fails loudly.
- When `nvidia-smi` is unavailable (the probe returns `null`), the check is skipped, which matches `GpuMemoryProbe` semantics.

**Files:**
- Modify: `src/status-server/engine-process.ts`, `src/status-server/managed-tabby.ts`
- Modify test helpers: `tests/helpers/tabby-fake.ts`, `tests/helpers/in-process-tabby.ts`, `tests/helpers/managed-engine-fixtures.ts`
- Test: `tests/managed-tabby.test.ts`

- [ ] **Step 1: Write the failing tests** in `tests/managed-tabby.test.ts`.
  - First give `createManagedTabbyFixture` a fifth parameter, `hostOptions: { gpuMemory?: GpuMemoryProbe; shutdownTimeoutMs?: number } = {}`.
  - Use `hostOptions.shutdownTimeoutMs ?? 5_000` for `ShutdownTimeoutMs`.
  - Pass `hostOptions.gpuMemory` into `writeFakeEngineHost(root, { port, ...fakeOptions }, hostOptions.gpuMemory)`.
  - Then add:

```ts
const MIB = 1_048_576;

/** Reports scripted used-VRAM readings in MiB; the last reading repeats until `settle` fixes every later one. */
class ScriptedGpuMemory implements GpuMemoryProbe {
  reads = 0;
  private settled: number | null = null;
  constructor(private readonly usedMiB: readonly number[]) {}
  settle(usedMiB: number): void {
    this.settled = usedMiB;
  }
  async read(): Promise<GpuMemory> {
    const used = this.settled ?? this.usedMiB[Math.min(this.reads, this.usedMiB.length - 1)] ?? 0;
    this.reads += 1;
    return { totalBytes: 24_000 * MIB, usedBytes: used * MIB, freeBytes: (24_000 - used) * MIB };
  }
}

test('managed Tabby stops only once the engine has released its VRAM', async () => {
  await withTempEnv(async (root) => {
    // baseline before launch, two readings still holding the model, then released
    const gpu = new ScriptedGpuMemory([2_000, 20_000, 20_000, 2_100]);
    await using fixture = await createManagedTabbyFixture(root, 'managed-tabby-vram-release', {}, undefined, { gpuMemory: gpu });
    await fixture.runtime.ensurePresetReady(fixture.exl3Preset);
    assert.equal(gpu.reads, 1, 'the baseline is read once before launch');

    await fixture.runtime.unloadPreset();

    assert.equal(gpu.reads, 4, 'stop polled until usage returned to the baseline');
    assert.equal(fixture.runtime.getProcessState(), 'stopped');
  });
});

test('managed Tabby fails the stop loudly when VRAM is never released', async () => {
  await withTempEnv(async (root) => {
    const gpu = new ScriptedGpuMemory([2_000, 20_000]);
    await using fixture = await createManagedTabbyFixture(root, 'managed-tabby-vram-held', {}, undefined,
      { gpuMemory: gpu, shutdownTimeoutMs: 600 });
    await fixture.runtime.ensurePresetReady(fixture.exl3Preset);

    await assert.rejects(fixture.runtime.unloadPreset(), /GPU memory was not released within 600 ms \(20000 MiB used; 2000 MiB before launch\)/u);
    assert.equal(fixture.runtime.getProcessState(), 'failed');
    gpu.settle(2_000); // lets the fixture's disposal stop cleanly
  });
});
```

Import `type GpuMemory, type GpuMemoryProbe` from `../src/status-server/gpu-memory.js`. If `createManagedTabbyFixture`'s `fakeOptions` default makes passing `undefined` awkward, keep its default through a named constant.

- [ ] **Step 2: Confirm the tests fail.**
  - Run: `npm run build:test`
  - Expected: a compile failure, because `ManagedEngineHost` has no `gpuMemory` and `writeFakeEngineHost` takes no third argument. That compile failure is the failing state.

- [ ] **Step 3: Implement.**
  - In `src/status-server/engine-process.ts`:
    - Import `NvidiaSmiGpuMemoryProbe, type GpuMemoryProbe` from `./gpu-memory.js`.
    - Add this field to `ManagedEngineHost`:

```ts
  /** Confirms a stopped engine released its VRAM before the next launch. */
  readonly gpuMemory: GpuMemoryProbe;
```

    - Change `createSystemManagedEngineHost` to return `{ launcher: new ChildProcessEngineLauncher(), packageLocator: new InterpreterExl3PackageLocator(), gpuMemory: new NvidiaSmiGpuMemoryProbe() }`.

  - In `src/status-server/managed-tabby.ts`, add these constants under `STARTUP_LOG_POLL_INTERVAL_MS`:

```ts
const MIB = 1_048_576;
/** Allowance for other GPU clients drifting while an engine ran; a resident model is far larger. */
const VRAM_RELEASE_TOLERANCE_BYTES = 1_024 * MIB;
const VRAM_RELEASE_POLL_MS = 250;
```

  - Add the field `private vramBaselineUsedBytes: number | null = null;`.
  - In `startProcess`, replace the spawn line with:

```ts
      if (!this.child || this.child.exitCode !== null) {
        this.vramBaselineUsedBytes = (await this.host.gpuMemory.read())?.usedBytes ?? null;
        this.spawnProcess(launchEnvironment);
      }
```

  - Replace `stopProcess` with the following. The body merges the two old branches, so that a crashed engine also waits for its VRAM:

```ts
  async stopProcess(): Promise<void> {
    const child = this.child;
    if (child && child.exitCode === null) {
      this.stopping = true;
      this.transitionProcessTo('stopping');
      this.host.launcher.terminate(child);
      const deadline = Date.now() + this.engine.ShutdownTimeoutMs;
      while (child.exitCode === null && Date.now() < deadline) await delay(25);
      if (child.exitCode === null) {
        this.transitionProcessTo('failed');
        throw new Error('Timed out stopping TabbyAPI.');
      }
    }
    this.child = null;
    this.recorder = null;
    this.processBaseUrl = null;
    this.processManaged = null;
    this.processSignature = null;
    this.currentPreset = null;
    this.residentResidencyKey = null;
    this.transitionModelTo('unloaded');
    await this.waitForVramRelease();
    this.transitionProcessTo('stopped');
  }

  /** Resolves once GPU use is back to its pre-launch level; Windows frees an exited engine's VRAM with a lag. */
  private async waitForVramRelease(): Promise<void> {
    const baseline = this.vramBaselineUsedBytes;
    if (baseline === null) return;
    const deadline = Date.now() + this.engine.ShutdownTimeoutMs;
    for (;;) {
      const memory = await this.host.gpuMemory.read();
      if (memory === null || memory.usedBytes <= baseline + VRAM_RELEASE_TOLERANCE_BYTES) {
        this.vramBaselineUsedBytes = null;
        return;
      }
      if (Date.now() >= deadline) {
        this.transitionProcessTo('failed');
        throw new Error(`TabbyAPI stopped, but GPU memory was not released within ${this.engine.ShutdownTimeoutMs} ms `
          + `(${Math.round(memory.usedBytes / MIB)} MiB used; ${Math.round(baseline / MIB)} MiB before launch).`);
      }
      await delay(VRAM_RELEASE_POLL_MS);
    }
  }
```

  - Update the test helpers:
    - `tests/helpers/tabby-fake.ts`: `writeFakeEngineHost(root, options, gpuMemory: GpuMemoryProbe = NO_GPU_MEMORY)` puts `gpuMemory` on `host`. Export `NO_GPU_MEMORY: GpuMemoryProbe = { read: async () => null }` from this file.
    - `tests/helpers/in-process-tabby.ts`: give `NEVER_LAUNCHING_ENGINE_HOST` a `gpuMemory` whose `read()` throws `new Error('Unexpected GPU memory probe.')`.
    - `tests/helpers/managed-engine-fixtures.ts`: every `ManagedEngineHost` it builds gets `gpuMemory: NO_GPU_MEMORY`.
    - Use `npm run typecheck:test` to find every other construction site.

- [ ] **Step 4: Run the tests and confirm they pass.**
  - Run: `npm run build:test; node .\dist\test-runner\run-tests.js tests/managed-tabby.test.ts tests/managed-tabby-run-history.test.ts tests/preset-runtime-coordinator.test.ts`
  - Expected: PASS.

**Acceptance:**
- Both new tests pass.
- The stop reports `stopped` only after the reading drops back to baseline + 1 GiB.
- A held reading fails with the exact message.

---

### Task 3: Lenient parsing of the parent's JSON answers (F5, F7, F10)

**Why:** Three of the four live plan answers, and every first drift review, were rejected only for their shape:
- an extra key such as `notes` or `evidence`;
- a ```` ```json ```` fence;
- prose before the JSON object.

The contents were valid. The fix: extract the object from surrounding prose or a fence, and drop keys the schema doesn't define. Everything else is still schema-validated: a missing `{status, plan}` wrapper or a wrong value is still rejected.

**Files:**
- Modify: `src/lib/model-json.ts` (only `ModelJson.parseObject` changes; its only caller is `src/orchestrator/phase-runner.ts`)
- Test: `tests/model-json.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `tests/model-json.test.ts`):

```ts
import { OrchestratorApprovalDecisionSchema, OrchestratorPlanPreparationSchema } from '@siftkit/contracts';
import { makeOrchestratorPlan, makeOrchestratorTask } from './helpers/orchestrator-plan.js';

test('ModelJson takes the answer object after prose or inside a fence surrounded by prose', () => {
  assert.deepEqual(ModelJson.parseObject('Confirmed: harmless.\n{"decision":"approve","reason":"read-only"}',
    OrchestratorApprovalDecisionSchema, 'approval decision'), { decision: 'approve', reason: 'read-only' });
  assert.deepEqual(ModelJson.parseObject('Here it is:\n```json\n{"decision":"deny","reason":"writes"}\n```\nDone.',
    OrchestratorApprovalDecisionSchema, 'approval decision'), { decision: 'deny', reason: 'writes' });
});

test('ModelJson drops keys the schema does not define, at any depth, and keeps validating values', () => {
  const plan = makeOrchestratorPlan([makeOrchestratorTask()]);
  const noisy = { status: 'generated', notes: 'extra', issues: [],
    plan: { ...plan, tasks: plan.tasks.map((task) => ({ ...task, steps: task.steps.map((step) => ({ ...step, evidence: 'x' })) })) } };
  assert.deepEqual(ModelJson.parseObject(JSON.stringify(noisy), OrchestratorPlanPreparationSchema, 'plan preparation'),
    { status: 'generated', issues: [], plan });
  assert.throws(() => ModelJson.parseObject(JSON.stringify(plan), OrchestratorPlanPreparationSchema, 'plan preparation'),
    /invalid_union|discriminator/u, 'a bare plan without its {status, plan} wrapper is still rejected');
  assert.throws(() => ModelJson.parseObject('{"decision":"maybe","reason":"x","notes":"y"}', OrchestratorApprovalDecisionSchema,
    'approval decision'), /decision/u, 'a wrong value is still rejected even with an extra key');
});
```

- [ ] **Step 2: Run them and confirm they fail.**
  - Run: `npm run build:test; node .\dist\test-runner\run-tests.js tests/model-json.test.ts`
  - Expected: FAIL. The first test gets "expected JSON object" or a jsonrepair error. The second gets `Unrecognized key`.

- [ ] **Step 3: Implement** in `src/lib/model-json.ts`:
  - Replace `parseObject` with:

```ts
  /**
   * A model's typed JSON answer: the object itself, or the one embedded after prose or in a fence.
   * Keys the schema does not define are dropped, and every value is still validated.
   * A repair that invents a missing value is rejected.
   */
  static parseObject<T>(text: string, schema: z.ZodType<T>, payloadName: string): T {
    const parsed = this.parseModelObject(this.answerObjectText(text), payloadName);
    if (parsed.repaired && parsed.synthesizedNull) {
      throw new Error(`Provider returned an invalid ${payloadName} payload: JSON repair synthesized a missing value.`);
    }
    return schema.parse(this.withoutUnrecognizedKeys(parsed.value, schema));
  }

  /** Text starting with an object is the answer; otherwise the last fenced object, else the outermost braces. */
  private static answerObjectText(text: string): string {
    const trimmed = String(text || '').trim();
    if (trimmed.startsWith('{')) return trimmed;
    const fenced = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gu)]
      .map((match) => (match[1] ?? '').trim())
      .filter((candidate) => candidate.startsWith('{'));
    const lastFenced = fenced[fenced.length - 1];
    if (lastFenced !== undefined) return lastFenced;
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
  }

  /** Removes only keys the schema reports as unrecognized; any other issue is left for `schema.parse` to report. */
  private static withoutUnrecognizedKeys<T>(value: JsonObject, schema: z.ZodType<T>): JsonValue {
    let current: JsonValue = value;
    for (let pass = 0; pass < UNRECOGNIZED_KEY_PASSES; pass += 1) {
      const result = schema.safeParse(current);
      if (result.success || !result.error.issues.every((issue) => issue.code === 'unrecognized_keys')) return current;
      for (const issue of result.error.issues) {
        if (issue.code === 'unrecognized_keys') current = removeKeys(current, issue.path, issue.keys);
      }
    }
    return current;
  }
```

  - Add at module level:

```ts
/** Nested unions can surface extra keys one level at a time. */
const UNRECOGNIZED_KEY_PASSES = 4;

function removeKeys(value: JsonValue, path: readonly PropertyKey[], keys: readonly string[]): JsonValue {
  const [head, ...rest] = path;
  if (Array.isArray(value)) {
    return typeof head === 'number' ? value.map((entry, index) => (index === head ? removeKeys(entry, rest, keys) : entry)) : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (head === undefined) return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
  if (typeof head !== 'string') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, key === head ? removeKeys(entry, rest, keys) : entry]));
}
```

If `JsonObject` entries are typed as optional, filter out `undefined` inside `removeKeys` rather than asserting.

- [ ] **Step 4: Run the tests and confirm they pass.**
  - Run: `npm run build:test; node .\dist\test-runner\run-tests.js tests/model-json.test.ts`
  - Expected: PASS, including the existing `'ModelJson parses a fenced typed object …'` test, whose `'I approve this.'` case is still rejected.

**Acceptance:**
- An answer embedded in prose is accepted, and so is an answer with extra keys.
- A missing wrapper, a wrong value, and prose with no JSON are all still rejected.

---

### Task 4: Phase events name their label and retry reason; infrastructure failures retry once and then fail the run (F1, F7, F13)

**Why:**
- Retried phases appear only as "Parent phase started." with no reason (F1, F7).
- An engine or model-switch failure inside a parent phase is swallowed into a deny or a finding (F13).

The changes:
- `OrchestratorPhaseRunner` gets an `OrchestratorPhaseLog` (implemented by `OrchestratorRun`) that commits `Parent phase started: <label>.` or `Parent phase started: <label>; retrying after: <reason>`.
- Lease-acquisition and engine failures become `OrchestratorInfrastructureError`: retried once as a new phase, then fatal.
- Answer problems (no answer, bad JSON) are not infrastructure failures; the callers retry those.

**Files:**
- Modify: `src/orchestrator/phase-runner.ts`, `src/orchestrator/run.ts`
- Modify test helper: `tests/helpers/scripted-engine-service.ts`
- Test: `tests/process/orchestrator-run.e2e.test.ts`

- [ ] **Step 1: Let the scripted engine fail a call.** In `tests/helpers/scripted-engine-service.ts`:
  - Change the type to:

```ts
/** One engine call: scripted planner turns, fixed or computed from the request, or an engine failure. */
export type ScriptedCall = MockPlannerResponseInput[] | ((request: RepoSearchExecutionRequest) => MockPlannerResponseInput[]) | Error;
```

  - In `executeRepoSearch`, add `if (next instanceof Error) return Promise.reject(next);` right after the `undefined` check.

- [ ] **Step 2: Write the failing e2e tests** (append to `tests/process/orchestrator-run.e2e.test.ts`):

```ts
const ENGINE_CRASH = 'TabbyAPI exited unexpectedly (code=1, signal=null).';

function readOnlyPlan(verification: OrchestratorVerificationCheck[]): OrchestratorPlan {
  const inspect = makeOrchestratorTask({ readPaths: ['src/app.ts'], verification,
    steps: [{ instruction: 'Report the value of app in src/app.ts.', expectedResult: 'The value.' }] });
  return { ...makeOrchestratorPlan([inspect]), finalVerification: [PASSING_CHECK] };
}

test('a parent phase hit by an engine failure is retried once as a new phase with the reason recorded', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-infra-retry-');
  const { engine } = context;
  engine.parent.push(new Error(ENGINE_CRASH));
  engine.parent.push(planAnswer(writePlan()));
  engine.children.push([writeFile('export const greeting = "hi";\n'), ...finalAnswer('Created.')]);
  engine.parent.push(driftReview('clean'));

  const { state, events } = await followRun(context, (await startRun(context, 'off')).runId);

  assert.equal(state.phase, 'completed', JSON.stringify(state.failure));
  assert.ok(events.some((event) => event.message === 'Parent phase started: plan preparation.'));
  assert.ok(events.some((event) => event.message.startsWith(
    `Parent phase started: plan preparation; retrying after: infrastructure failure: ${ENGINE_CRASH}`)));
});

test('an engine failure twice in one approval decision fails the run as infrastructure, never as a denial', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-infra-fail-');
  const { engine } = context;
  engine.parent.push(planAnswer(readOnlyPlan([PASSING_CHECK])));
  engine.children.push(finalAnswer('app is 1.'));
  engine.parent.push(new Error(ENGINE_CRASH));
  engine.parent.push(new Error(ENGINE_CRASH));

  const { state, events } = await followRun(context, (await startRun(context, 'auto')).runId);

  assert.equal(state.phase, 'failed');
  assert.equal(state.failure?.code, 'infrastructure_failed');
  assert.match(state.failure?.message ?? '', /approval decision phase failed 2 times: TabbyAPI exited unexpectedly/u);
  assert.equal(events.some((event) => /Not run|deny/u.test(event.message)), false, 'no check was denied');
});
```

  In the existing test `'a supplied adequate plan is kept as is, and malformed parent output gets exactly one retry'`, destructure `events` from `followRun` and add:

```ts
  assert.ok(events.some((event) => /^Parent phase started: plan preparation; retrying after: Provider returned an invalid plan preparation payload/u
    .test(event.message)));
```

- [ ] **Step 3: Run the tests and confirm they fail.**
  - Run: `npm run build:test; node .\dist\test-runner\run-tests.js tests/process/orchestrator-run.e2e.test.ts --test-name-pattern="engine failure|malformed parent output"`
  - Expected: FAIL. The events only say "Parent phase started.", and the second run fails with `implementation_failed` ("never ran").

- [ ] **Step 4: Rewrite `src/orchestrator/phase-runner.ts`.**
  - Keep `PhaseLeaseWriter` and the imports, and add `import { toError } from '../lib/errors.js';`.
  - Replace the rest from `OrchestratorPhaseRequest` down with:

```ts
/** One finite parent inference: its own durable ID owns the model lease and engine request. */
export type OrchestratorPhaseRequest = {
  runId: string;
  phaseRunId: string;
  presetId: string;
  repoRoot: string;
  abortSignal: AbortSignal;
};

export type OrchestratorPhaseLabel = 'plan preparation' | 'task review' | 'drift review' | 'final verification' | 'approval decision';

/** Commits each parent phase start as a run event and returns the request that owns it. */
export interface OrchestratorPhaseLog {
  startPhase(label: OrchestratorPhaseLabel, retryReason: string | null): OrchestratorPhaseRequest;
}

/** The parent's model or engine failed, not its answer; it ends the run once a phase fails twice this way. */
export class OrchestratorInfrastructureError extends Error {}

const PHASE_INFRASTRUCTURE_ATTEMPTS = 2;
```

```ts
export class OrchestratorPhaseRunner {
  /** `config` is the run's pinned snapshot; the model lease supplies the admitted engine config. */
  constructor(private readonly ctx: ServerContext, private readonly config: SiftConfig, private readonly log: OrchestratorPhaseLog) {}

  preparePlan(input: Parameters<typeof buildPlanPreparationPrompt>[0], retryReason: string | null): Promise<OrchestratorPlanPreparation> {
    return this.run('plan preparation', buildPlanPreparationPrompt(input), OrchestratorPlanPreparationSchema, retryReason);
  }

  reviewAttempt(input: Parameters<typeof buildAttemptReviewPrompt>[0], retryReason: string | null): Promise<OrchestratorTaskReview> {
    return this.run('task review', buildAttemptReviewPrompt(input), OrchestratorTaskReviewSchema, retryReason);
  }

  reviewDrift(input: Parameters<typeof buildDriftReviewPrompt>[0], retryReason: string | null): Promise<OrchestratorDriftReview> {
    return this.run('drift review', buildDriftReviewPrompt(input), OrchestratorDriftReviewSchema, retryReason);
  }

  verifyFinal(input: Parameters<typeof buildFinalVerificationPrompt>[0]): Promise<OrchestratorTaskReview> {
    return this.run('final verification', buildFinalVerificationPrompt(input), OrchestratorTaskReviewSchema, null);
  }

  /** The parent decides one permission request (built by the caller) on its own model, then lets go of it. */
  decideApproval(prompt: string, retryReason: string | null): Promise<OrchestratorApprovalDecision> {
    return this.run('approval decision', prompt, OrchestratorApprovalDecisionSchema, retryReason);
  }

  private async run<T>(label: OrchestratorPhaseLabel, prompt: string, schema: z.ZodType<T>, retryReason: string | null): Promise<T> {
    let reason = retryReason;
    for (let attempt = 1; ; attempt += 1) {
      const request = this.log.startPhase(label, reason);
      let finalOutput: string;
      try {
        finalOutput = await this.infer(request, prompt, label);
      } catch (error) {
        if (!(error instanceof OrchestratorInfrastructureError) || attempt >= PHASE_INFRASTRUCTURE_ATTEMPTS) {
          throw error instanceof OrchestratorInfrastructureError
            ? new OrchestratorInfrastructureError(`Orchestrator ${label} phase failed ${attempt} times: ${error.message}`)
            : error;
        }
        reason = `infrastructure failure: ${error.message}`;
        continue;
      }
      return ModelJson.parseObject(finalOutput, schema, label);
    }
  }

  /** The phase's final answer text. A lease or engine failure is infrastructure; a missing answer is the model's. */
  private async infer(request: OrchestratorPhaseRequest, prompt: string, label: OrchestratorPhaseLabel): Promise<string> {
    const preset = PresetCatalog.fromPresets(this.config.Presets).requireById(request.presetId);
    let lock;
    try {
      lock = await acquireModelRequestWithWait(this.ctx, 'orchestrator', undefined, undefined, {
        intent: { presetId: request.presetId, model: null },
        ownerRunId: request.phaseRunId,
        abortSignal: request.abortSignal,
        queueTimeout: 'none',
      });
    } catch (error) {
      request.abortSignal.throwIfAborted();
      throw new OrchestratorInfrastructureError(toError(error).message);
    }
    if (!lock) {
      request.abortSignal.throwIfAborted();
      throw new UncancelledModelWaitError('orchestrator');
    }
    try {
      let result;
      try {
        result = await this.ctx.engineService.executeRepoSearch({
          presetId: request.presetId, taskKind: 'orchestrator', prompt, requestId: request.phaseRunId, repoRoot: request.repoRoot,
          statusBackendUrl: `${this.ctx.getServiceBaseUrl()}/status`, config: lock.context.config,
          allowedTools: [...preset.allowedTools], abortSignal: request.abortSignal,
          progressWriter: new PhaseLeaseWriter(this.ctx, lock.token),
        });
      } catch (error) {
        request.abortSignal.throwIfAborted();
        throw new OrchestratorInfrastructureError(toError(error).message);
      }
      const task = result.scorecard.tasks[0];
      if (!task || !taskPassed(task)) {
        throw new Error(`Orchestrator ${label} phase ended without an answer (${task?.reason ?? 'no task'}).`);
      }
      return task.finalOutput;
    } finally {
      releaseModelRequest(this.ctx, lock.token);
    }
  }
}
```

  If `let lock;` / `let result;` infer as implicit `any`, type them with `Awaited<ReturnType<typeof acquireModelRequestWithWait>>` and `Awaited<ReturnType<ServerContext['engineService']['executeRepoSearch']>>`.

- [ ] **Step 5: Wire `run.ts`.**

  1. Imports: add `OrchestratorInfrastructureError`, `type OrchestratorPhaseLabel` and `type OrchestratorPhaseLog` from `./phase-runner.js`. Change the class line to `export class OrchestratorRun implements OrchestratorLiveRun, OrchestratorPhaseLog {`.

  2. Constructor: `this.phases = new OrchestratorPhaseRunner(ctx, config, this);`.

  3. Replace `phaseRequest()` with:

```ts
  startPhase(label: OrchestratorPhaseLabel, retryReason: string | null): OrchestratorPhaseRequest {
    const phaseRunId = randomUUID();
    this.commit({ phaseRunIds: [...this.state.phaseRunIds, phaseRunId] },
      retryReason === null ? `Parent phase started: ${label}.` : `Parent phase started: ${label}; retrying after: ${retryReason}`);
    return { runId: this.runId, phaseRunId, presetId: this.request.presetId, repoRoot: this.request.repoRoot, abortSignal: this.signal };
  }

  /** Aborts and infrastructure failures end the run; any other phase error is an unusable answer the caller may retry. */
  private rethrowFatal(error: unknown): void {
    this.signal.throwIfAborted();
    if (error instanceof OrchestratorInfrastructureError) throw error;
  }
```

  4. In `settleFailure`, map the infrastructure error:

```ts
    const failure = error instanceof OrchestratorRunFailure
      ? error.failure
      : { code: error instanceof OrchestratorInfrastructureError ? 'infrastructure_failed' : 'internal_error', message: error.message,
        taskId: null, purpose: null, findingIds: [] };
```

  5. Call sites. Every `this.phases.X(this.phaseRequest(), input)` becomes `this.phases.X(input, retryReason)`:
     - `preparePlan`: `this.phases.preparePlan({ … }, previousErrors.length === 0 ? null : previousErrors.join(' '))`. In its `catch`, replace `this.signal.throwIfAborted();` with `this.rethrowFatal(error);`.
     - `reviewDrift`: `this.phases.reviewDrift({ … }, rejectedProblems.length === 0 ? null : rejectedProblems.join(' '))`. Its `catch` also uses `this.rethrowFatal(error);`.
     - `verifyFinal`: `this.phases.verifyFinal({ goal: plan.goal, checks })`.
     - `reviewEvidence`: `this.phases.reviewAttempt({ task, result: { … } }, null)`. Its `catch` uses `this.rethrowFatal(error);` before building the error text. Task 6 rewrites this method.
     - `decideOnParentModel`: `this.phases.decideApproval(prompt, null)`. Its `catch` calls `this.rethrowFatal(error);` before returning the deny. Task 5 rewrites this method.

- [ ] **Step 6: Run the tests and confirm they pass.**
  - Run: `npm run build:test; node .\dist\test-runner\run-tests.js tests/process/orchestrator-run.e2e.test.ts`
  - Expected: all pass, the new tests included.

**Acceptance:**
- Each phase start event names its label.
- A retry event names its reason.
- Two infrastructure failures in one phase make the run `failed` / `infrastructure_failed`. Nothing is denied and no finding is created.

---

### Task 5: An unusable approval decision is retried once and then fails loudly; decisions are recorded in events (F10)

**Files:**
- Modify: `src/orchestrator/run.ts`
- Test: `tests/process/orchestrator-run.e2e.test.ts`

- [ ] **Step 1: Write the failing tests** (append; they reuse `readOnlyPlan` from Task 4):

```ts
test('an approval decision after prose is accepted and the decision is recorded', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-decision-prose-');
  const { engine } = context;
  engine.parent.push(planAnswer(readOnlyPlan([PASSING_CHECK])));
  engine.children.push(finalAnswer('app is 1.'));
  engine.parent.push(finalAnswer('Checked: it only exits.\n{"decision":"approve","reason":"A no-op check."}'));
  engine.parent.push(APPROVE_CHECK);

  const { state, events } = await followRun(context, (await startRun(context, 'auto')).runId);

  assert.equal(state.phase, 'completed', JSON.stringify(state.failure));
  assert.ok(events.some((event) => event.message === 'Approval resolved: approve.'));
});

test('an unusable approval decision is retried once, then fails the run instead of denying', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-decision-invalid-');
  const { engine } = context;
  engine.parent.push(planAnswer(readOnlyPlan([PASSING_CHECK])));
  engine.children.push(finalAnswer('app is 1.'));
  engine.parent.push(finalAnswer('Looks fine to me.'));
  engine.parent.push(finalAnswer('Still fine.'));

  const { state } = await followRun(context, (await startRun(context, 'auto')).runId);

  assert.equal(state.phase, 'failed');
  assert.equal(state.failure?.code, 'approval_decision_invalid');
  const decisions = engine.prompts('parent').filter((prompt) => prompt.includes('verification command'));
  assert.equal(decisions.length, 2);
  assert.match(decisions[1] ?? '', /Your previous answer was rejected: Provider returned an invalid approval decision payload/u);
});
```

- [ ] **Step 2: Run the tests and confirm they fail.**
  - Run: `npm run build:test; node .\dist\test-runner\run-tests.js tests/process/orchestrator-run.e2e.test.ts --test-name-pattern="approval decision"`
  - Expected: FAIL. The event reads "Approval resolved.", and the second run ends `implementation_failed`.

- [ ] **Step 3: Implement** in `run.ts`:
  - Add `const APPROVAL_DECISION_ATTEMPTS = 2;` next to `DRIFT_REVIEW_ATTEMPTS`.
  - Replace `decideOnParentModel` with:

```ts
  private async decideOnParentModel(prompt: string): Promise<ContinuingDecision> {
    let rejected: string | null = null;
    for (let attempt = 1; attempt <= APPROVAL_DECISION_ATTEMPTS; attempt += 1) {
      try {
        const decision = await this.phases.decideApproval(
          rejected === null ? prompt : `${prompt}\nYour previous answer was rejected: ${rejected}`, rejected);
        return decision.decision === 'approve' ? { decision: 'approve' } : { decision: 'deny', reason: `orchestrator: ${decision.reason}` };
      } catch (error) {
        this.rethrowFatal(error);
        rejected = toError(error).message;
      }
    }
    throw fail('approval_decision_invalid', `The orchestrator gave no usable approval decision: ${rejected ?? 'no answer'}`);
  }
```

  - In `answerApproval`, replace the `try … finally` with:

```ts
    let decision: RepoAgentDecision;
    try {
      decision = this.request.approval === 'interactive'
        ? await this.waitForUserDecision(pending.approvalId)
        : await this.decideOnParentModel(parentPrompt);
    } catch (error) {
      if (!this.signal.aborted) this.commit({ approval: null, phase: resumePhase }, 'Approval could not be resolved.');
      throw error;
    }
    if (!this.signal.aborted) this.commit({ approval: null, phase: resumePhase }, describeApprovalDecision(decision));
```

  - Add at module level:

```ts
function describeApprovalDecision(decision: RepoAgentDecision): string {
  return decision.decision === 'deny' ? `Approval resolved: deny (${decision.reason}).` : `Approval resolved: ${decision.decision}.`;
}
```

- [ ] **Step 4: Run the whole e2e file and confirm it passes.**
  - Run: `npm run build:test; node .\dist\test-runner\run-tests.js tests/process/orchestrator-run.e2e.test.ts`
  - Expected: PASS, including `'an auto run asks the parent before each check command and never runs a denied one'`, whose denies still produce "never ran".

**Acceptance:**
- An unusable decision retries once, carrying the rejection, and then the run fails `approval_decision_invalid`.
- Real denies behave as before.
- Every resolution event names the decision.

---

### Task 6: The parent's evidence review is retried on its own bad answers and citations and never uses up a worker attempt (F6)

**Files:**
- Modify: `src/orchestrator/verification.ts`, `src/orchestrator/prompts.ts`, `src/orchestrator/run.ts`
- Test: `tests/process/orchestrator-run.e2e.test.ts`

- [ ] **Step 1: Write the failing test** (append):

```ts
test('a review citing a snippet that is not in the file is re-asked, and the worker keeps its attempt', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-review-citation-');
  const { engine } = context;
  const evidence: OrchestratorVerificationCheck = { kind: 'evidence', instruction: 'Confirm app is 1.', paths: ['src/app.ts'] };
  engine.parent.push(planAnswer(readOnlyPlan([evidence])));
  engine.children.push(finalAnswer('app is 1 (src/app.ts:1).'));
  engine.parent.push(finalAnswer(JSON.stringify({ status: 'pass',
    evidence: [{ path: 'src/app.ts', line: 1, snippet: 'export const app = 1; // the only export' }] })));
  engine.parent.push(finalAnswer(JSON.stringify({ status: 'pass',
    evidence: [{ path: 'src/app.ts', line: 1, snippet: 'export const app = 1;' }] })));

  const { state } = await followRun(context, (await startRun(context, 'off')).runId);

  assert.equal(state.phase, 'completed', JSON.stringify(state.failure));
  assert.deepEqual(state.attempts.map((attempt) => [attempt.attempt, attempt.result?.passed]), [[1, true]]);
  const reviews = engine.prompts('parent').filter((prompt) => prompt.startsWith('Phase: review the evidence'));
  assert.equal(reviews.length, 2);
  assert.match(reviews[1] ?? '', /Your previous review was rejected:\n- Review evidence: src\/app\.ts:1 does not contain the cited snippet\./u);
});
```

- [ ] **Step 2: Run it and confirm it fails.**
  - Run: `npm run build:test; node .\dist\test-runner\run-tests.js tests/process/orchestrator-run.e2e.test.ts --test-name-pattern="cited snippet"`
  - Expected: FAIL. Attempt 1 is marked failed and a second child is requested (which is unscripted).

- [ ] **Step 3: Implement.**
  - In `verification.ts`, add the following, and in `evaluateAttempt` replace the `if (input.review?.status === 'pass') { … }` block with `if (input.review !== null) findings.push(...findReviewEvidenceProblems(input.repoRoot, input.review));`:

```ts
/** Problems with a passing review's citations; a failing review cites findings, not evidence. */
export function findReviewEvidenceProblems(repoRoot: string, review: OrchestratorTaskReview): string[] {
  if (review.status !== 'pass') return [];
  return review.evidence.flatMap((evidence) => {
    const problem = findEvidenceProblem(repoRoot, evidence);
    return problem === null ? [] : [`Review evidence: ${problem}.`];
  });
}
```

  - In `prompts.ts`, give `buildAttemptReviewPrompt` the input field `rejectedProblems: readonly string[]` and append, as the last array element:

```ts
    ...(input.rejectedProblems.length === 0 ? [] : ['Your previous review was rejected:', ...input.rejectedProblems.map((problem) => `- ${problem}`)]),
```

  - In `run.ts`:
    - Add `const TASK_REVIEW_ATTEMPTS = 2;` and import `findReviewEvidenceProblems`.
    - Replace `reviewEvidence` with:

```ts
  /** The parent's evidence review. Its own unusable answers and bad citations are retried here, never charged to the worker. */
  private async reviewEvidence(task: OrchestratorTask, child: ChildOutcome, checks: OrchestratorCheckResult[],
    changedPaths: string[]): Promise<OrchestratorTaskReview> {
    let rejectedProblems: string[] = [];
    for (let attempt = 1; attempt <= TASK_REVIEW_ATTEMPTS; attempt += 1) {
      let review: OrchestratorTaskReview;
      try {
        review = await this.phases.reviewAttempt({ task, result: { workerOutput: child.output, checks, changedPaths }, rejectedProblems },
          rejectedProblems.length === 0 ? null : rejectedProblems.join(' '));
      } catch (error) {
        this.rethrowFatal(error);
        rejectedProblems = [toError(error).message];
        continue;
      }
      rejectedProblems = findReviewEvidenceProblems(this.request.repoRoot, review);
      if (rejectedProblems.length === 0) return review;
    }
    throw fail('task_review_invalid', `Task '${task.id}' evidence review was unusable: ${rejectedProblems.join(' ')}`, { taskId: task.id });
  }
```

  - In `runAttempt`:

```ts
    const review = checks.some((check) => check.check.kind === 'evidence')
      ? await this.reviewEvidence(task, child, checks, changes.paths)
      : null;
    const evaluation = evaluateAttempt({ repoRoot: this.request.repoRoot, workerStatus: child.workerStatus, checks, scopeViolations, review });
    const findings = evaluation.findings;
```

  - Import `type OrchestratorTaskReview` from `@siftkit/contracts`.
  - `verifyFinal` is unchanged: it still fails final verification when a citation is bad, because no worker attempt is involved there.

- [ ] **Step 4: Run the tests and confirm they pass.**
  - Run: `npm run build:test; node .\dist\test-runner\run-tests.js tests/process/orchestrator-run.e2e.test.ts tests/orchestrator-verification.test.ts`
  - Expected: PASS.

**Acceptance:**
- A bad citation re-asks the parent once.
- A second unusable review fails the run with `task_review_invalid`.
- The worker attempt count is unaffected.

---

### Task 7: Plan and drift checks are preflighted in the real check shell (F14)

**Files:**
- Create: `src/orchestrator/check-preflight.ts`
- Modify: `src/orchestrator/prompts.ts`, `src/orchestrator/run.ts`
- Test: `tests/orchestrator-check-preflight.test.ts` (new), `tests/process/orchestrator-run.e2e.test.ts`

- [ ] **Step 1: Write the failing unit test** in `tests/orchestrator-check-preflight.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import type { OrchestratorVerificationCheck } from '@siftkit/contracts';
import { findUnrunnableChecks } from '../src/orchestrator/check-preflight.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

function command(text: string): OrchestratorVerificationCheck {
  return { kind: 'command', command: text, cwd: '.', expectedExitCode: 0 };
}

test('the preflight rejects checks that do not parse or name no command in the check shell, and nothing else', async () => {
  const problems = await findUnrunnableChecks(createManagedTempDir('siftkit-preflight-'), [
    command('node --version'),
    command('node --test 2>&1 | siftkit-missing-tool -E "greets by name"'),
    command('if (Test-Path README.md) { exit 0 } else { exit 1 }'),
    command('exit 0'),
    command('Get-ChildItem | Select-Object -First 1'),
    command('./scripts/check.ps1'),
    command('echo "unterminated'),
    command('node --version'),
    { kind: 'evidence', instruction: 'Read it.', paths: ['README.md'] },
  ], new AbortController().signal);

  assert.equal(problems.length, 2, problems.join('\n'));
  assert.match(problems[0] ?? '', /^Check `node --test 2>&1 \| siftkit-missing-tool -E "greets by name"` cannot run in PowerShell \(Windows, powershell\.exe\): 'siftkit-missing-tool' is not a PowerShell command or a program on PATH\.$/u);
  assert.match(problems[1] ?? '', /^Check `echo "unterminated` cannot run in .*: does not parse as PowerShell: /u);
});

test('the preflight skips the shell entirely when no check is a command', async () => {
  assert.deepEqual(await findUnrunnableChecks('C:\\does-not-matter', [{ kind: 'evidence', instruction: 'Read it.', paths: ['a'] }],
    new AbortController().signal), []);
});
```

- [ ] **Step 2: Run it and confirm it fails.**
  - Run: `npm run build:test`
  - Expected: FAIL (compile), because `check-preflight.js` doesn't exist.

- [ ] **Step 3: Create `src/orchestrator/check-preflight.ts`:**

```ts
import type { OrchestratorVerificationCheck } from '@siftkit/contracts';

import { parseJsonValueText } from '../lib/json.js';
import { RUN_SHELL_LABEL, spawnPowerShellAsync } from '../lib/powershell.js';
import { z } from '../lib/zod.js';

const PREFLIGHT_MARKER = 'SIFTKIT_CHECK_PREFLIGHT:';
const PREFLIGHT_TIMEOUT_MS = 30_000;
const PreflightProblemsSchema = z.array(z.object({ command: z.string(), problem: z.string() }));

// Parses each command with the PowerShell parser and resolves every named command; path-like names are left to the run.
const PREFLIGHT_SCRIPT = String.raw`
$commands = (@($input) -join [Environment]::NewLine) | ConvertFrom-Json
$problems = @()
foreach ($command in @($commands)) {
  $tokens = $null; $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseInput($command, [ref]$tokens, [ref]$errors)
  if ($errors.Count -gt 0) {
    $problems += [pscustomobject]@{ command = $command; problem = "does not parse as PowerShell: $($errors[0].Message)" }
    continue
  }
  $names = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true) |
    ForEach-Object { $_.GetCommandName() } | Where-Object { $_ -and $_ -notmatch '[\\/]' })
  foreach ($name in $names) {
    if (-not (Get-Command -Name $name -ErrorAction SilentlyContinue)) {
      $problems += [pscustomobject]@{ command = $command; problem = "'$name' is not a PowerShell command or a program on PATH" }
    }
  }
}
Write-Output ('${PREFLIGHT_MARKER}' + (ConvertTo-Json -Compress -InputObject @($problems)))
`;

/** Why declared command checks cannot run in the check shell: a parse error or an unresolvable command name. */
export async function findUnrunnableChecks(repoRoot: string, checks: readonly OrchestratorVerificationCheck[],
  abortSignal: AbortSignal): Promise<string[]> {
  const commands = [...new Set(checks.flatMap((check) => (check.kind === 'command' ? [check.command] : [])))];
  if (commands.length === 0) return [];
  const result = await spawnPowerShellAsync(PREFLIGHT_SCRIPT, { cwd: repoRoot, abortSignal, timeoutMs: PREFLIGHT_TIMEOUT_MS,
    stdinData: JSON.stringify(commands) });
  abortSignal.throwIfAborted();
  const line = result.output.split(/\r?\n/u).find((entry) => entry.startsWith(PREFLIGHT_MARKER));
  if (line === undefined) throw new Error(`The check preflight produced no result (exit ${result.exitCode}): ${result.output.slice(-2_000)}`);
  return PreflightProblemsSchema.parse(parseJsonValueText(line.slice(PREFLIGHT_MARKER.length)))
    .map(({ command, problem }) => `Check \`${command}\` cannot run in ${RUN_SHELL_LABEL}: ${problem}.`);
}
```

  - Verify that `buildPowerShellInvocation` in `src/lib/powershell.ts` pipes stdin into the script block as `$input`: `[Console]::In.ReadToEnd() | & ([ScriptBlock]::Create(...))`. It does as of this plan.

- [ ] **Step 4: Run the unit test and confirm it passes.**
  - Run: `npm run build:test; node .\dist\test-runner\run-tests.js tests/orchestrator-check-preflight.test.ts`
  - Expected: PASS.

- [ ] **Step 5: Write the failing e2e test** (append to `tests/process/orchestrator-run.e2e.test.ts`):

```ts
test('a plan whose check cannot run in the check shell is rejected and re-planned before any child starts', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-check-shell-');
  const { engine } = context;
  // A name no machine resolves; live S4 failed the same way on `grep`, which some PATHs do provide.
  const missingToolCheck: OrchestratorVerificationCheck = { kind: 'command', command: 'node --version | siftkit-missing-tool v', cwd: '.',
    expectedExitCode: 0 };
  const unrunnable = writePlan();
  engine.parent.push(planAnswer({ ...unrunnable, tasks: unrunnable.tasks.map((task) => ({ ...task, verification: [missingToolCheck] })) }));
  engine.parent.push(planAnswer(writePlan()));
  engine.children.push([writeFile('export const greeting = "hi";\n'), ...finalAnswer('Created.')]);
  engine.parent.push(driftReview('clean'));

  const { state, events } = await followRun(context, (await startRun(context, 'off')).runId);

  assert.equal(state.phase, 'completed', JSON.stringify(state.failure));
  assert.ok(events.some((event) => event.message.startsWith('Plan rejected: Check `node --version | siftkit-missing-tool v` cannot run in PowerShell')));
  assert.match(engine.prompts('parent')[1] ?? '', /'siftkit-missing-tool' is not a PowerShell command/u);
  assert.match(engine.prompts('parent')[0] ?? '', /Command checks run in PowerShell \(Windows, powershell\.exe\)/u);
  assert.equal(engine.prompts('children').length, 1);
});
```

- [ ] **Step 6: Run it and confirm it fails.**
  - Run: `npm run build:test; node .\dist\test-runner\run-tests.js tests/process/orchestrator-run.e2e.test.ts --test-name-pattern="check shell"`
  - Expected: FAIL. The first plan is accepted and the run fails `implementation_failed`.

- [ ] **Step 7: Implement.**
  - In `prompts.ts`:
    - Import `RUN_SHELL_LABEL` from `../lib/powershell.js` and add:

```ts
const CHECK_SHELL_RULE = `Command checks run in ${RUN_SHELL_LABEL} from their cwd: use PowerShell syntax, cmdlets, and programs on PATH only`
  + ' (grep, sed, awk, bash, and && are unavailable).';
```

    - Put `CHECK_SHELL_RULE` right before `PLAN_JSON_SHAPE` in `buildPlanPreparationPrompt`.
    - Put it right after the `"actionable"` finding-shape lines in `buildDriftReviewPrompt`.
  - In `run.ts`:
    - Import `findUnrunnableChecks` from `./check-preflight.js`.
    - In `preparePlan`, after the `validateOrchestratorPlan` try/catch, add:

```ts
      const unrunnable = await findUnrunnableChecks(this.request.repoRoot,
        [...plan.tasks.flatMap((task) => task.verification), ...plan.finalVerification], this.signal);
      if (unrunnable.length > 0) {
        previousErrors = unrunnable;
        this.commit({ phase: 'preparing_plan' }, `Plan rejected: ${unrunnable[0] ?? ''}`);
        continue;
      }
```

    - In `reviewDrift`, replace the validation lines with:

```ts
      rejectedProblems = validateDriftReview({ review, repoRoot: this.request.repoRoot, taskId: task.id, changeDigest, changedPaths,
        openFindings });
      if (rejectedProblems.length === 0 && review.status === 'actionable') {
        rejectedProblems = await findUnrunnableChecks(this.request.repoRoot, review.findings.flatMap((finding) => finding.verification),
          this.signal);
      }
      if (rejectedProblems.length === 0) return review;
```

- [ ] **Step 8: Run the tests and confirm they pass.**
  - Run: `npm run build:test; node .\dist\test-runner\run-tests.js tests/process/orchestrator-run.e2e.test.ts tests/orchestrator-check-preflight.test.ts`
  - Expected: PASS.

**Acceptance:**
- A `grep` check or unparsable check is rejected into the plan retry with the exact reason.
- Valid PowerShell checks, including `Test-Path`, `exit 0` and `npm`, pass the preflight.

---

### Task 8: Terminal runs close their open tasks, attempts and children (F15)

**Files:**
- Modify: `packages/contracts/src/orchestrator.ts`, `src/orchestrator/run-store.ts`, `src/status-server/orchestrator-runs.ts`, `src/status-server/index.ts`
- Test: `tests/orchestrator-run-store.test.ts`, `tests/orchestrator-runs.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - In `tests/orchestrator-run-store.test.ts`:

```ts
test('a stopped run aborts its open tasks and abandons unsettled attempts; untouched tasks stay pending', (t) => {
  const { store } = openStore(t);
  let state = planned(store);
  state = store.update(state.runId, state.revision, { tasks: state.tasks.map((task) => (task.taskId === 'inspect'
    ? { ...task, status: 'running' } : task)) }, { message: 'Task inspect: running.' });
  const attempt = store.reserveAttempt(state.runId, state.revision, 'inspect', implementationWork());
  state = store.markAttemptRunning(state.runId, store.read(state.runId).revision, attempt.childRunId);

  const aborted = store.update(state.runId, state.revision, { phase: 'aborted' }, { message: 'Aborted by user.' });

  assert.deepEqual(aborted.tasks.map((task) => [task.taskId, task.status]), [['inspect', 'aborted'], ['follow-up', 'pending']]);
  assert.deepEqual(aborted.attempts.map((entry) => entry.status), ['abandoned']);
});
```

  - In `tests/orchestrator-runs.test.ts`:
    - Update the two existing `reconcileOnStartup()` calls to `reconcileOnStartup(NO_CHILDREN)`, with `const NO_CHILDREN = { markNotResumable: (_runId: string) => undefined };`.
    - Add:

```ts
test('startup marks the running children of an interrupted parent not resumable', (t) => {
  const store = openStore(t);
  const created = createRun(store);
  const plan = makeOrchestratorPlan([makeOrchestratorTask()]);
  let state = store.savePlan(created.runId, created.revision, plan, 'docs/plan.md', 'hash');
  const task = plan.tasks[0];
  assert.ok(task);
  const attempt = store.reserveAttempt(state.runId, state.revision, task.id,
    { kind: 'implementation', planPath: 'docs/plan.md', planHash: 'hash', task });
  state = store.markAttemptRunning(state.runId, store.read(state.runId).revision, attempt.childRunId);
  const marked: string[] = [];

  new OrchestratorRunRegistry(store).reconcileOnStartup({ markNotResumable: (runId: string) => { marked.push(runId); } });

  assert.deepEqual(marked, [attempt.childRunId]);
  assert.deepEqual(store.read(state.runId).attempts.map((entry) => entry.status), ['abandoned']);
});
```

    - Import `makeOrchestratorPlan, makeOrchestratorTask` from `./helpers/orchestrator-plan.js`.

- [ ] **Step 2: Run the tests and confirm they fail.**
  - Run: `npm run build:test`
  - Expected: FAIL. It fails to compile first (`reconcileOnStartup` takes no argument, and `'abandoned'` isn't a status). Once that compiles, the assertions fail.

- [ ] **Step 3: Implement.**
  - In `packages/contracts/src/orchestrator.ts`, the attempt `status` becomes `z.enum(['reserved', 'running', 'settled', 'abandoned'])`.
  - In `run-store.ts`:
    - Import `type OrchestratorTaskStatus`.
    - Add at module level:

```ts
/** Task statuses that mean live work; a stopped parent turns them into `aborted`. */
const OPEN_TASK_STATUSES: readonly OrchestratorTaskStatus[] = ['running', 'verifying', 'reviewing_drift', 'correcting_drift', 'retry_pending'];
```

    - In `mutate`, replace `const { attempts: _attempts, ...fields } = stored;` with:

```ts
      const closing = isOrchestratorTerminalPhase(stored.phase) && stored.phase !== 'completed';
      const { attempts: _attempts, ...fields } = closing ? this.closeOpenWork(runId, stored) : stored;
```

    - Add the method:

```ts
  /** A stopped parent leaves nothing looking live: open tasks abort and unsettled attempts are abandoned. */
  private closeOpenWork(runId: string, state: OrchestratorRunState): OrchestratorRunState {
    for (const attempt of state.attempts) {
      if (attempt.status === 'reserved' || attempt.status === 'running') this.writeAttempt(runId, { ...attempt, status: 'abandoned' });
    }
    return { ...state, tasks: state.tasks.map((task) => (OPEN_TASK_STATUSES.includes(task.status) ? { ...task, status: 'aborted' } : task)) };
  }
```

  - In `orchestrator-runs.ts`, change `reconcileOnStartup` to:

```ts
  /** A stored nonterminal parent has no owner after a restart: it is interrupted and its running children are not resumable. */
  reconcileOnStartup(children: { markNotResumable(runId: string): void }): string[] {
    return this.store.listActive().map((state) => {
      for (const attempt of state.attempts) {
        if (attempt.status === 'running') children.markNotResumable(attempt.childRunId);
      }
      return this.store.markInterrupted(state.runId, state.revision, RESTART_REASON).runId;
    });
  }
```

    `RepoAgentRunStore` satisfies this parameter as it is; its `markNotResumable` returns state, which a `void` method type accepts.
  - In `src/status-server/index.ts:264`, use `orchestratorRuns.reconcileOnStartup(repoAgentRunStore);`.
  - Run `npm run typecheck` and fix every exhaustive use of the attempt status, for example the dashboard `OrchestratorRunPanel`, by rendering `abandoned` like a failed attempt.

- [ ] **Step 4: Run the tests and confirm they pass.**
  - Run: `npm run build:test; node .\dist\test-runner\run-tests.js tests/orchestrator-run-store.test.ts tests/orchestrator-runs.test.ts tests/contracts-orchestrator.test.ts tests/runtime-db-schema-orchestrator.test.ts; node .\dist\test-runner\run-tests.js tests/process/orchestrator-run.e2e.test.ts`
  - Expected: PASS.

**Acceptance:**
- An aborted, failed or interrupted run never shows a `running` task or attempt.
- The children of interrupted runs are marked not resumable at startup.

---

### Task 9: Failed and aborted runs clean `scratch/` (F12)

**Files:**
- Modify: `src/orchestrator/run.ts`
- Test: `tests/process/orchestrator-run.e2e.test.ts`

- [ ] **Step 1: Write the failing test.**
  - In the existing test `'a task that fails verification twice stops after two implementation children and never starts its dependent'`, change the children so each attempt also writes a scratch file:

```ts
  for (const attempt of [1, 2]) {
    engine.children.push((request) => [scratchNote(request),
      { toolCalls: [{ name: 'write', arguments: { path: 'src/wrong.ts', content: `// ${attempt}\n` } }] }, ...finalAnswer('Done.')]);
  }
```

  - Add at the end of the test:

```ts
  const scratch = path.join(context.repo, '.siftkit', 'orchestrator', state.runId, 'scratch');
  assert.deepEqual(fs.existsSync(scratch) ? fs.readdirSync(scratch) : [], [], 'a failed run leaves no scratch files');
```

  - Add the helper near `writeFile`:

```ts
/** A write into the attempt's scratch directory, read from its instruction. */
function scratchNote(request: RepoSearchExecutionRequest) {
  const scratch = /Scratch directory for temporary files: (\S+)/u.exec(request.prompt)?.[1];
  if (scratch === undefined) throw new Error(`Expected an implementation prompt, got: ${request.prompt.slice(0, 120)}`);
  return { toolCalls: [{ name: 'write', arguments: { path: `${scratch}/note.txt`, content: 'temporary\n' } }] };
}
```

- [ ] **Step 2: Run it and confirm it fails.**
  - Run: `npm run build:test; node .\dist\test-runner\run-tests.js tests/process/orchestrator-run.e2e.test.ts --test-name-pattern="fails verification twice"`
  - Expected: FAIL, because `['note.txt']` remains.

- [ ] **Step 3: Implement** in `run.ts`:
  - Replace `execute`'s `catch` and `finally` with:

```ts
    } catch (error) {
      await this.stopChildren();
      this.settleFailure(toError(error), this.scratchCleanupProblem());
    } finally {
      this.pendingUserDecision = null;
      await this.stopChildren();
    }
```

  - Add:

```ts
  private async stopChildren(): Promise<void> {
    for (const child of this.children.values()) child.abort();
    await Promise.allSettled([...this.children.values()].map((child) => child.settled));
  }

  /** A failed or aborted run still removes its scratch files; a cleanup problem joins the failure message. */
  private scratchCleanupProblem(): string | null {
    try {
      cleanupScratch(this.request.repoRoot, orchestratorScratchDir(this.runId));
      return null;
    } catch (error) {
      return `Scratch cleanup also failed: ${toError(error).message}`;
    }
  }
```

  - Change `settleFailure(error: Error, cleanupProblem: string | null)`. Build each message as `[message, cleanupProblem].filter((part) => part !== null).join(' ')`, both for the `aborted` message and for `failure.message`.

- [ ] **Step 4: Run the tests and confirm they pass.**
  - Run: `npm run build:test; node .\dist\test-runner\run-tests.js tests/process/orchestrator-run.e2e.test.ts`
  - Expected: PASS.

**Acceptance:** `scratch/` is empty after failed and aborted runs, as it already is after completed runs.

---

### Task 10: A run's result shows each task's worker answer (F2)

**Files:**
- Modify: `src/cli/run-orchestrator.ts`
- Test: `tests/process/orchestrator-run.e2e.test.ts`

- [ ] **Step 1: Write the failing test.** In the test `'the CLI starts a run, streams committed events, and prints the typed result with a completion exit code'`, replace the `result` parse with:

```ts
  const result = z.object({ runId: z.string().uuid(), status: z.string(),
    tasks: z.array(z.object({ taskId: z.string(), output: z.string().nullable() }).loose()) }).loose()
    .parse(parseJsonValueText(stdout.text));
  assert.equal(result.status, 'completed');
  assert.match(result.tasks[0]?.output ?? '', /Created\./u, 'the caller sees the worker answer');
```

- [ ] **Step 2: Run it and confirm it fails.**
  - Run: `npm run build:test; node .\dist\test-runner\run-tests.js tests/process/orchestrator-run.e2e.test.ts --test-name-pattern="CLI starts a run"`
  - Expected: FAIL (a zod error: `output` is missing).

- [ ] **Step 3: Implement** in `run-orchestrator.ts`:
  - The `tasks` mapping becomes:

```ts
    tasks: state.tasks.map((task) => ({ taskId: task.taskId, status: task.status, drift: task.driftReview?.status ?? null,
      output: taskOutput(state, task.taskId) })),
```

  - Add:

```ts
/** The worker report of the task's latest passing attempt; for a read-only task this is its answer. */
function taskOutput(state: OrchestratorRunState, taskId: string): string | null {
  const passing = state.attempts.filter((attempt) => attempt.taskId === taskId && attempt.result?.passed === true);
  return passing[passing.length - 1]?.result?.workerOutput ?? null;
}
```

- [ ] **Step 4: Run it and confirm it passes** (same command).

**Acceptance:** CLI output (`start`, `attach`, `status`) carries `tasks[].output`.

---

### Task 11: Repo-search and repo-agent child transcripts are keyed by `childRunId` (F3)

**Files:**
- Modify: `src/orchestrator/workers.ts`
- Test: `tests/process/orchestrator-run.e2e.test.ts`

- [ ] **Step 1: Write the failing test.** In the test `'a child approval unloads the child model for the parent decision …'`, add:

```ts
  const childRequests = engine.repoSearchRequests.filter((request) => request.taskKind !== 'orchestrator');
  assert.deepEqual([...new Set(childRequests.map((request) => request.requestId))], [state.attempts[0]?.childRunId],
    'the child transcript is keyed by its reserved child run ID');
```

- [ ] **Step 2: Run it and confirm it fails.**
  - Run: `npm run build:test; node .\dist\test-runner\run-tests.js tests/process/orchestrator-run.e2e.test.ts --test-name-pattern="child approval unloads"`
  - Expected: FAIL, because the request ID is an unrelated admission ID.

- [ ] **Step 3: Implement.** In `startOrchestratorChild`, add `requestId: request.childRunId,` to the `startRepoWorkerRun` input.

- [ ] **Step 4: Run it and confirm it passes** (same command, then the whole e2e file).

**Acceptance:** `run_logs` and engine request IDs for orchestrator children equal their `childRunId`.

---

### Task 12: Repo-agent workers hold the model under their own kind (F9)

**Files:**
- Modify: `src/status-server/repo-agent-lock-adapter.ts`, `src/status-server/routes/repo-agent.ts`
- Test: `tests/model-request-queue.test.ts`

- [ ] **Step 1: Write the failing test** (append to `tests/model-request-queue.test.ts`, next to the existing lock-adapter tests):

```ts
test('the worker lock adapter queues under the worker kind it was built for', async () => {
  const ctx = createQueueContext();
  try {
    const activeLock = await acquireModelRequestWithWait(ctx, 'repo_search');
    assert.ok(activeLock);
    const controller = new AbortController();
    const acquisition = new ServerModelLockAdapter(ctx, 'repo_agent', 'none', { presetId: null, model: null })
      .acquire('agent-run', controller.signal);
    assert.equal(ctx.modelRequestQueue[0]?.kind, 'repo_agent');
    controller.abort();
    assert.equal(await acquisition, null);
    assert.equal(releaseModelRequest(ctx, activeLock.token), true);
  } finally {
    await ctx.inferenceRunFlushQueue.close();
  }
});
```

  Update the two existing `new ServerModelLockAdapter(ctx, …)` calls in this file to pass `'repo_search'` as the second argument.

- [ ] **Step 2: Confirm it fails.**
  - Run: `npm run build:test`
  - Expected: FAIL (compile), because the constructor arity is different.

- [ ] **Step 3: Implement.**
  - `ServerModelLockAdapter`'s constructor becomes `(ctx, private readonly kind: 'repo_search' | 'repo_agent', queueTimeout, intent)`.
  - Use `this.kind` in `acquireModelRequestWithWait(this.ctx, this.kind, …)` and in `new UncancelledModelWaitError(this.kind)`.
  - In `startRepoWorkerRun`, use `new ServerModelLockAdapter(ctx, input.taskKind === 'repo-search' ? 'repo_search' : 'repo_agent', input.modelQueueTimeout, { … })`.
  - Grep `'repo_search'` in `src/`, `tests/` and `dashboard/src` for code that compares a model-request `kind` or queue `owner`. Update each place that describes a repo-agent run, and nothing else.

- [ ] **Step 4: Run the tests and confirm they pass.**
  - Run: `npm run build:test; node .\dist\test-runner\run-tests.js tests/model-request-queue.test.ts tests/repo-agent-sessions.test.ts tests/admitted-model-routes.e2e.test.ts`
  - Expected: PASS.

**Acceptance:** A repo-agent child shows in the model queue as `repo_agent`.

---

### Task 13: Runtime state under `.siftkit/` is left out of the planner's file listing (F8)

**Why:** Old runs' `.siftkit/orchestrator/<runId>/plan.md` files were listed, and the planner treated one as "the supplied plan". The ignore policy can't be used here, because it also blocks `read`, and workers must still read their run's plan. Only the listing changes.

**Files:**
- Modify: `src/repo-search/prompts.ts`
- Test: `tests/repo-file-listing.test.ts` (new)

- [ ] **Step 1: Write the failing test:**

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { buildIgnorePolicy } from '../src/repo-search/command-safety.js';
import { scanRepoFiles } from '../src/repo-search/prompts.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

test('the repository file listing never advertises runtime state under .siftkit', () => {
  const root = createManagedTempDir('siftkit-listing-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'export {};\n');
  fs.mkdirSync(path.join(root, '.siftkit', 'orchestrator', 'run-1'), { recursive: true });
  fs.writeFileSync(path.join(root, '.siftkit', 'orchestrator', 'run-1', 'plan.md'), '# Old plan\n');

  const listing = scanRepoFiles(root, buildIgnorePolicy(root));

  assert.match(listing, /src\/main\.ts/u);
  assert.doesNotMatch(listing, /\.siftkit/u);
});
```

- [ ] **Step 2: Run it and confirm it fails.**
  - Run: `npm run build:test; node .\dist\test-runner\run-tests.js tests/repo-file-listing.test.ts`
  - Expected: FAIL, because the listing includes `.siftkit/orchestrator/run-1/plan.md` or a `.siftkit` summary line.

- [ ] **Step 3: Implement** in `src/repo-search/prompts.ts`:
  - Add above `scanRepoFilesRaw`:

```ts
/** Runtime state: tools may still read it by path, but the listing never advertises it. */
const LISTING_EXCLUDED_PATHS = ['.siftkit'];
```

  - In `scanRepoFilesRaw`, change `const ignoredPaths = ignorePolicy.paths ?? [];` to `const ignoredPaths = [...(ignorePolicy.paths ?? []), ...LISTING_EXCLUDED_PATHS];`.

- [ ] **Step 4: Run it and confirm it passes** (same command).

**Acceptance:** `.siftkit/` never appears in any preset's repository listing; reads by explicit path still work.

---

### Task 14: Correct the child-approval design text (F11)

**Files:**
- Modify: `docs/superpowers/plans/2026-09-22-orchestrator-preset.md` (the "Parent-decided child approvals" bullets, around line 684)

- [ ] **Step 1:** Replace the bullet `With \`auto\`, the parent's \`decideChildApproval\` phase loads the parent model and answers. …` with:

```markdown
  - With `auto`, the child's own auto-reviewer (`LlmApprovalGate`) answers each request first, on the child's model. Only a request it escalates parks for the parent: a verdict of `unsure`, or two failed verdict calls. The parent's `decideChildApproval` phase then loads the parent model and answers, and the child re-queues for its own model and continues the same attempt.
```

- [ ] **Step 2:** Confirm the "observed load order is pinned as B, A, B" bullet still names `tests/process/orchestrator-run.e2e.test.ts`. That test uses `ESCALATING_VERDICTS`, which is exactly this escalation path. Leave the bullet unchanged.

**Acceptance:** The design doc describes the actual approval routing; no code changes.

---

### Task 15: Full validation

- [ ] **Step 1:** Run `npm run build:test; npm test 2>&1 | siftkit summary --question "Return pass/fail counts, failing test names, and root errors with file:line."`.
  - Expected: all pass.
- [ ] **Step 2:** Run `npm run test:process 2>&1 | siftkit summary --question "Return pass/fail counts, failing test names, and root errors with file:line."`.
  - Expected: all pass.
- [ ] **Step 3:** Run `npm run test:dashboard 2>&1 | siftkit summary --question "Return pass/fail counts and failing tests."`.
  - Expected: all pass. This is needed because Task 8 changed an attempt status the dashboard may render.
- [ ] **Step 4:** Run `npm run typecheck` (which includes lint) and `npm run lint`.
  - Expected: exit 0.
- [ ] **Step 5:** Confirm that `git status` shows only the files in the File map, plus the untracked validation-results doc.

---

### Task 16: Live re-validation on real models (manual; the primary agent runs it)

Follow `docs/superpowers/plans/2026-09-23-orchestrator-live-validation-handoff.md` §0–§2 for setup:
- back up the DB;
- `orchestrator` → `exl3-3-8-27b` and `repo-agent` → `exl3-3-8-27b-5bpw` via `PUT /config`;
- sandboxes under `c:\tmp\rsx`;
- a timeline sampler writing to a scratch dir.

- [ ] **Step 1 (F4, F13):**
  - During S2, for every A↔B switch, confirm that `inference_runs` shows exactly one stop and one start. There must be no target → previous → target pattern.
  - Sample `nvidia-smi --query-gpu=memory.used --format=csv,noheader` once per second, and confirm usage falls back to baseline before each new engine logs "Model loaded".
  - No `Insufficient VRAM` error may appear.
- [ ] **Step 2:** Rerun S2 (generated plan, `auto`).
  - Expected: `completed`.
  - Every retry event names its reason, and at most one plan retry happens, for a real content problem.
- [ ] **Step 3:** Rerun S3 (`auto`, write task).
  - Expected: `completed`.
  - Every decision event reads `Approval resolved: approve|deny …`, and no check is recorded as `Not run: The orchestrator could not decide`.
- [ ] **Step 4:** Rerun S4 (`interactive`, generated plan).
  - Expected: no check containing `grep`, `sed`, `awk`, `bash` or `&&` survives plan validation, and the run completes.
- [ ] **Step 5:** Rerun S8 with the supplied drift-bait plan.
  - If drift is found, `drift_fix` runs.
  - `drift_unresolved` stays covered by the existing stubbed e2e test `'drift still present after two corrections …'`.
- [ ] **Step 6:** Rerun S9a (abort) and S9b (restart).
  - Expected: no task `running`, attempts `abandoned`, and after S9b the child `state.json` is `failed` (not resumable).
- [ ] **Step 7:** Append the outcomes to `docs/superpowers/plans/2026-09-24-orchestrator-live-validation-results.md` under a new `## Re-validation 2026-09-2x` section, listing each finding as fixed or still open with run IDs.
- [ ] **Step 8:** Clean up as in the original handoff:
  - restore the config exactly;
  - stop the servers;
  - delete the sandboxes and scratch;
  - keep the DB evidence.
- [ ] **Still manual:** S5 and the web half of S6 need the Chrome extension connected; record them as blocked if it still isn't.

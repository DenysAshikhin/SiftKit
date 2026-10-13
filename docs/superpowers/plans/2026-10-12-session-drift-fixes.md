# Session drift fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 13 drift findings from the 2026-10-12 review of the EXL3 disk-cache and orchestrator answer-repair work.

**Architecture:** Five independent tasks, grouped by area: repo-search engine, orchestrator, managed Tabby, config contract, dashboard. Each task is a complete replacement with no shim left behind.

**Tech Stack:** TypeScript on Node 26 (no build step), node:test, vitest (dashboard), zod.

---

## Rules for every task

- TDD: write the test, run it and see it fail for the expected reason, implement, then see it pass.
- TypeScript rules:
  - No `any`, no explicit `unknown`, no `as` casts (except `as const`), no `!` non-null assertions, no namespace imports.
  - Comments are 1–2 lines.
- Do not commit. Do not use siftkit. Do not touch files outside the task's list. Leave unrelated working-tree changes alone (the tree is already dirty).
- Run tests with `node src/test-runner/run-tests.ts <file>` (unit). Use `npm run test:process -- <file>` for files under `tests/process/`, and `npm run test:dashboard` for the dashboard.
- Finish with `npm run typecheck`, which includes lint and must exit 0.

---

### Task 1: Answer repair in the repo-search engine (findings 2, 5, 9, 12)

**Files:**
- Modify: `src/repo-search/planner-protocol.ts`: `TerminalAnswerFormat` (~line 717) and `requestTerminalSynthesis`.
- Modify: `src/repo-search/engine/terminal-synthesizer.ts`: the `synthesize` input.
- Modify: `src/repo-search/engine/task-loop.ts`: `buildAgentLoopResult` and `synthesizeFinalOutput` (~lines 854–922).
- Test: `tests/engine-terminal-synthesizer.test.ts`, `tests/repo-search-loop.core.test.ts`.

What is wrong:
- (2) When repair synthesis fails, it throws. The orchestrator then treats the phase as an infrastructure failure and discards a usable answer.
- (5) `TerminalAnswerFormat` duplicates the existing `PlannerResponseConstraint` union.
- (9) The repair turn is logged and reported with `reason: this.counters.reason`, which is `finish`.
- (12) `answerFormat` is converted to JSON Schema on every finishing task, even when no synthesis happens.

- [ ] **Step 1: Write the failing tests**
  - In `tests/repo-search-loop.core.test.ts`, next to the existing answer-schema tests (around line 1520), add a test:
    - Use the existing `runAnswerSchemaTask` helper. The task finishes with a bad answer (e.g. `'not json at all'`), and every repair synthesis reply is empty. Supply enough `''` replies to exhaust the synthesizer's 3 attempts.
    - Expect:
      - `run.reason === 'finish'`
      - `run.finalOutput` equals the original bad answer
      - exactly one `task_answer_repair_requested` event
      - exactly one `task_answer_repair_failed` event, whose `error` mentions `Terminal synthesis produced no usable output`
      - the synthesizer's `task_terminal_synthesis_failed` event has `reason === 'answer_repair'`
  - In `tests/engine-terminal-synthesizer.test.ts`:
    - Replace the `answerFormat` input with `responseConstraint: PlannerResponseConstraint`, imported from `src/repo-search/planner-protocol.ts`.
    - `synthesisInput()` uses `responseConstraint: { responseSchema: null }`.
    - In the `synthesizeAgainstSse` overrides, the constrained case uses `{ responseSchema: PLAN_PREPARATION_SCHEMA, responseSchemaName: 'plan_preparation' }`.
    - The expected request bodies stay the same.

- [ ] **Step 2: Run the tests and confirm they fail**
  - The new loop test fails because the run throws (synthesis error).
  - The synthesizer tests fail typecheck or at runtime because `responseConstraint` is unknown.

- [ ] **Step 3: Implement**
  - `planner-protocol.ts`:
    - Delete `TerminalAnswerFormat`.
    - `requestTerminalSynthesis` takes `responseConstraint: PlannerResponseConstraint` in place of `answerFormat`, and spreads `...options.responseConstraint` where it currently spreads the mapped `constraint`. Remove the mapping.
  - `terminal-synthesizer.ts`: replace `answerFormat: TerminalAnswerFormat | null` with `responseConstraint: PlannerResponseConstraint`, and pass it through.
  - `task-loop.ts`: make these changes.
    ```ts
    async buildAgentLoopResult(): Promise<TaskResult> {
      const answerSchema = this.options.answerSchema;
      // Terminal synthesis if no final output — retry up to 3 times then hard-fail.
      if (!String(this.finalOutput || '').trim()) {
        await this.synthesizeFinalOutput(this.counters.reason, buildTerminalSynthesisInstruction(this.counters.reason));
      } else if (answerSchema !== undefined) {
        const problem = findAnswerSchemaProblem(this.finalOutput, answerSchema);
        if (problem !== null) await this.repairFinalOutput(problem);
      }
      ...unchanged...
    }

    /** One constrained repair turn; if it fails, the original answer stands for the caller's own parse to reject. */
    private async repairFinalOutput(problem: string): Promise<void> {
      this.options.logger?.write({ kind: 'task_answer_repair_requested', taskId: this.task.id, problem });
      try {
        await this.synthesizeFinalOutput('answer_repair', buildAnswerRepairInstruction([problem]));
      } catch (error) {
        this.options.abortSignal?.throwIfAborted();
        this.options.logger?.write({ kind: 'task_answer_repair_failed', taskId: this.task.id, error: toError(error).message });
      }
    }

    /** Replaces the final output with one terminal synthesis turn on the cached prefix, constrained to the answer schema. */
    private async synthesizeFinalOutput(reason: string, instruction: string): Promise<void> {
      const answerSchema = this.options.answerSchema;
      const responseConstraint: PlannerResponseConstraint = answerSchema === undefined
        ? { responseSchema: null }
        : { responseSchema: buildPlannerJsonSchema(answerSchema.schema), responseSchemaName: answerSchema.name };
      ...existing body, passing `reason` and `responseConstraint` to `synthesize`...
    }
    ```
  - Import `toError` from `../../lib/errors.ts` and the `PlannerResponseConstraint` type, and drop the `TerminalAnswerFormat` import.
  - Check how the logger's event type is declared. If event kinds are a closed union, add `task_answer_repair_failed` there the same way `task_answer_repair_requested` was added.

- [ ] **Step 4: Run the tests and confirm they pass**
  - `node src/test-runner/run-tests.ts tests/repo-search-loop.core.test.ts tests/engine-terminal-synthesizer.test.ts`
  - Run `npm run typecheck`.
  - Grep `src` and `tests` for `TerminalAnswerFormat` and `answerFormat`. No hits should remain.

---

### Task 2: Orchestrator schema name and duplicated goal (findings 6, 10)

**Files:**
- Modify: `src/orchestrator/phase-runner.ts`: `OrchestratorPhaseLabel` (line 26) and `infer`.
- Modify: `src/orchestrator/run.ts`: `askParent` (~line 294); the final verification prompt call (~line 551); the check approval call (~line 674).
- Modify: `src/orchestrator/prompts.ts`: `buildCheckApprovalPrompt` and `buildFinalVerificationPrompt` (~lines 206–240).
- Test: `tests/orchestrator-prompts.test.ts`; `tests/process/orchestrator-run.e2e.test.ts` must keep passing unchanged.

What is wrong:
- (6) `run.ts` builds the wire `json_schema` name from the display label with `label.replace(/ /gu, '_')`.
- (10) The run block already renders the saved plan, which starts with `# <goal>`. Check approval and final verification still repeat `Goal: ${input.goal}`.

- [ ] **Step 1: Write the failing tests** in `tests/orchestrator-prompts.test.ts`.
  - Add a test: in both `buildFinalVerificationPrompt` and `buildCheckApprovalPrompt` built with a planned run, the plan goal text occurs exactly once (count with `prompt.split(plan.goal).length - 1`).
  - Add a test: every value of `ORCHESTRATOR_PHASE_ANSWER_NAMES`, imported from `src/orchestrator/phase-runner.ts`, matches `/^[A-Za-z0-9_-]+$/u`, and its keys are exactly the five phase labels.
  - Remove the `goal:` argument from the existing calls in this file.

- [ ] **Step 2: Run them and confirm they fail** (goal appears twice; the export is missing).
  - `node src/test-runner/run-tests.ts tests/orchestrator-prompts.test.ts`

- [ ] **Step 3: Implement**
  - `phase-runner.ts`, below `OrchestratorPhaseLabel`:
    ```ts
    /** The `json_schema` name each phase's answer is constrained to when it needs repair. */
    export const ORCHESTRATOR_PHASE_ANSWER_NAMES = {
      'plan preparation': 'plan_preparation',
      'task review': 'task_review',
      'drift review': 'drift_review',
      'final verification': 'final_verification',
      'approval decision': 'approval_decision',
    } as const satisfies Record<OrchestratorPhaseLabel, string>;
    ```
  - Change `infer`:
    - The signature becomes `infer(request, prompt, label, schema: z.ZodType)`, with `import type { z } from '../lib/zod.ts'`.
    - It passes `answerSchema: { name: ORCHESTRATOR_PHASE_ANSWER_NAMES[label], schema }`.
    - Remove the `RepoSearchAnswerSchema` import if it is unused.
  - `run.ts` `askParent`: pass `schema` instead of `{ name: label.replace(/ /gu, '_'), schema }`.
  - `prompts.ts`:
    - Remove `goal` from both builders' input types.
    - The phase lines become `Phase: decide whether to run one verification command for <…>.` and `Phase: final verification of the whole run.`
    - In `run.ts`, remove `goal:` from both callers. `this.requirePlan()` may become unused there; remove it only if it has no other uses.

- [ ] **Step 4: Run the tests and confirm they pass**
  - `node src/test-runner/run-tests.ts tests/orchestrator-prompts.test.ts`
  - `npm run test:process -- tests/process/orchestrator-run.e2e.test.ts`
  - `npm run typecheck`

---

### Task 3: Managed Tabby stop sequence and drain-failure log (findings 3, 8)

**Files:**
- Modify: `src/status-server/managed-tabby.ts`: `stopProcess` (~line 159).
- Modify: `tests/helpers/in-process-tabby.ts`: add an `unloadDelayMs` option.
- Test: `tests/managed-tabby.test.ts`.

What is wrong:
- (3) `stopProcess` runs `flushDiskCache()` before `this.stopping = true` and `transitionProcessTo('stopping')`.
  - During the unload, which can take up to `ShutdownTimeoutMs`, the process still reports `ready`/`running`.
  - If Tabby exits during the flush, the exit handler records it as `TabbyAPI exited unexpectedly`.
- (8) The test `a failed disk-cache drain is logged and the engine still stops` never asserts the warning.

- [ ] **Step 1: Write the failing tests**
  - In `tests/helpers/in-process-tabby.ts`, add an option `unloadDelayMs?: number`, documented in one line. When it is set, the fake waits that long before answering `POST /v1/model/unload`. This is test-helper support, not production code.
  - New test, `a disk-cache drain runs while the process reports stopping`:
    - Start with `unloadDelayMs: 300`.
    - Start `fixture.runtime.unloadPreset()` without awaiting it.
    - Poll (25 ms steps, bounded at 2 s) until `fixture.launcher.events` contains `'unload'`.
    - Assert `fixture.runtime.getProcessState() === 'stopping'`.
    - Await the stop, then assert the state is `'stopped'` and the events are `['unload', 'terminate']`.
  - Extend the existing drain-failure test (signature `async (t) =>`):
    - Mock with `const warnings = t.mock.method(serverLogger, 'warning', () => {});`, following `tests/chat-runtime-owner.test.ts:46`.
    - Assert exactly one call whose argument has `scope: 'exl3'` and `event: 'disk_cache_flush_failed'`, and an `alert` that is a non-empty string.

- [ ] **Step 2: Run them and confirm they fail**
  - The stopping test fails: the state is still `ready`/`running` during the unload.
  - Run `node src/test-runner/run-tests.ts tests/managed-tabby.test.ts`.
  - The log assertion should already pass. That is expected: it is a coverage gap, not a behaviour change.

- [ ] **Step 3: Implement** `stopProcess`:
  ```ts
  async stopProcess(): Promise<void> {
    const child = this.child;
    if (child && child.exitCode === null) {
      this.stopping = true;
      this.transitionProcessTo('stopping');
      await this.flushDiskCache();
    }
    // One budget covers both the exit and the VRAM release; it starts once the flush is done.
    const deadline = Date.now() + this.engine.ShutdownTimeoutMs;
    if (child && child.exitCode === null) {
      this.host.launcher.terminate(child);
      while (child.exitCode === null && Date.now() < deadline) await delay(25);
      if (child.exitCode === null) {
        this.transitionProcessTo('failed');
        throw new Error('Timed out stopping TabbyAPI.');
      }
    }
    ...rest unchanged...
  }
  ```
  - Check that `flushDiskCache`'s `this.getModelState() !== 'ready'` guard still holds after `transitionProcessTo('stopping')`: that call must not change the model state. Read `src/status-server/managed-inference-runtime.ts` to confirm.

- [ ] **Step 4: Run the tests and confirm they pass**
  - `node src/test-runner/run-tests.ts tests/managed-tabby.test.ts`
  - `npm run typecheck`

---

### Task 4: Disk-cache validation in the config contract (findings 1, 7)

**Files:**
- Modify: `packages/contracts/src/config.ts`: `diskCacheRootKey` (~line 104) and the disk-cache loop in `ServerModelPresetsConfigSchema.superRefine` (~lines 130–155).
- Modify: `docs/superpowers/specs/2026-10-11-exl3-disk-cache-design.md`: the Validation bullets (~lines 69–72).
- Test: `tests/contracts-config.test.ts` (~lines 300–325), `tests/managed-tabby.test.ts`.

What is wrong:
- (1) The schema rejects `ExternalServerEnabled: true` together with a `DiskCacheDir`.
  - The dashboard disables the disk-cache fields for external presets (`managed-only`). So turning External on for a disk preset makes every save fail, and the user cannot clear the field.
  - `ManagedTabbyRuntime.ensurePresetReady` already rejects it at runtime. `SpeculativeEnabled` follows that precedent and has no schema rule.
- (7) `diskCacheRootKey` does not resolve `.` and `..`, while the launch uses `win32.resolve`. `D:\x\..\cache` and `D:\cache` count as different roots.
  - `node:path` cannot be used here: the dashboard bundles this module.

- [ ] **Step 1: Write the failing tests** in `tests/contracts-config.test.ts`.
  - Change the external assertion to `assert.equal(withDisk({ ExternalServerEnabled: true }).success, true, 'the runtime, not the schema, rejects an external disk preset');`
  - In the shared-root test, add a preset with `DiskCacheDir: 'D:\\AI\\other\\..\\exl3-disk-cache\\.'` and `DiskCacheSizeMiB: 1024` next to `disk`. Expect the parse to fail with `/share DiskCacheSizeMiB/u`.
  - In `tests/managed-tabby.test.ts`:
    - Add a test that a **managed** engine rejects an exl3 preset with `ExternalServerEnabled: true` and a `DiskCacheDir`, matching `/sets DiskCacheDir, but the disk cache is a launch setting/u`.
    - Mirror the existing `unmanaged EXL3 preset with a disk cache fails loud…` test, but with `Managed: true`.

- [ ] **Step 2: Run them and confirm they fail** (the schema still rejects external presets; `..` is not resolved).
  - `node src/test-runner/run-tests.ts tests/contracts-config.test.ts tests/managed-tabby.test.ts`
  - The managed-tabby test may already pass. Note it as coverage.

- [ ] **Step 3: Implement**
  - Delete the `if (preset.ExternalServerEnabled) { … }` clause from the disk-cache loop.
  - Replace `diskCacheRootKey`:
    ```ts
    /** One key per disk-cache root, resolved like the launch's win32.resolve: `.`/`..` applied, separators unified, case-insensitive. */
    function diskCacheRootKey(directory: string): string {
      const segments: string[] = [];
      for (const segment of directory.replace(/\//gu, '\\').toLowerCase().split('\\')) {
        if (segment === '' || segment === '.') continue;
        if (segment === '..') {
          if (segments.length > 1) segments.pop();
          continue;
        }
        segments.push(segment);
      }
      return segments.join('\\');
    }
    ```
  - In the spec, the first Validation bullet becomes: "A non-null `DiskCacheDir` must be an absolute Windows path with `CacheRam > 0`." The second bullet becomes: "`ManagedTabbyRuntime.ensurePresetReady` rejects a disk-cache preset unless SiftKit manages its launch (an unmanaged engine or an external-server preset), the same single runtime rule as `SpeculativeEnabled`."
  - The shared-root bullet already says "resolved"; keep it.

- [ ] **Step 4: Run the tests and confirm they pass**
  - `node src/test-runner/run-tests.ts tests/contracts-config.test.ts tests/managed-tabby.test.ts tests/config-normalization.test.ts`
  - `npm run test:dashboard`
  - `npm run typecheck`

---

### Task 5: Dashboard disk-cache controls (findings 4, 11, 13)

**Files:**
- Modify: `dashboard/src/tabs/settings/ModelPresetsSection.tsx`: the `DiskCacheDir` input (~line 186).
- Modify: `dashboard/src/settings-sections.ts`: the `Disk checkpoint spacing` help text.
- Modify: `dashboard/tests/fixtures.ts`: `DiskCacheCheckpointInterval: 4096` becomes `2048`.
- Test: `dashboard/tests/dashboard-model-presets-section.test.ts`, `tests/settings-sections.test.ts`.

What is wrong:
- (4) The directory input calls `event.target.value.trim() || null` on every keystroke. The input is controlled, so a typed space is removed immediately and a path such as `D:\AI Cache` cannot be typed. Sibling fields use the raw value; normalization trims it on save.
- (11) The help text hardcodes "about 111 MiB per checkpoint on Flash Next", a figure for one model in generic UI.
- (13) The fixture keeps the old checkpoint default, 4096.

- [ ] **Step 1: Write the failing tests**
  - In `dashboard/tests/dashboard-model-presets-section.test.ts`, extend `editing the disk-cache directory stores the path and an empty value as null`:
    - Add a third change with value `'D:\\AI Cache '` (internal and trailing space).
    - Expect the recorded call `['DiskCacheDir', 'D:\\AI Cache ']`, untrimmed. The whitespace-only `'  '` still expects `null`.
  - In `tests/settings-sections.test.ts`, add an assertion that the help text for `Disk checkpoint spacing` does not contain `Flash Next` and does contain `recurrent state`. Follow how that file already reads section fields.

- [ ] **Step 2: Run them and confirm they fail**
  - `npm run test:dashboard`
  - `node src/test-runner/run-tests.ts tests/settings-sections.test.ts`

- [ ] **Step 3: Implement**
  - The input `onChange` becomes `modelPresetActions.setNullableString('DiskCacheDir', event.target.value.trim() === '' ? null : event.target.value)`.
  - The help text becomes: `'Tokens between recurrent checkpoints kept on disk for hybrid models (`TABBY_MEMORY_DISK_CACHE_CHECKPOINT_INTERVAL`). A resumed prompt replays at most this many tokens; smaller values use much more disk, since each checkpoint stores the full recurrent state (often over 100 MiB).'`
  - In the fixture, change `DiskCacheCheckpointInterval: 4096` to `2048`.

- [ ] **Step 4: Run the tests and confirm they pass**
  - `npm run test:dashboard`
  - `node src/test-runner/run-tests.ts tests/settings-sections.test.ts`
  - `npm run typecheck`

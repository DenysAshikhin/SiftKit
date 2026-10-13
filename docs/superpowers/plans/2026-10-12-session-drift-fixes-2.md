# Session drift fixes, round 2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 13 findings from the second drift review of the EXL3 disk-cache and orchestrator answer-repair work.

**Architecture:** Four tasks, run in order, each a complete replacement with no shim:
- **Task A:** `askParent` becomes the one place that builds a parent prompt: the run block, then the phase text, then the answer's JSON schema.
- **Task B:** orchestrator cleanups.
- **Task C:** the engine-exit stderr race.
- **Task D:** contract and adapter fixes.

**Tech Stack:** TypeScript on Node 26 (no build step), node:test, vitest (dashboard), zod v4.

---

## Rules for every task

- **TDD:** write the test, run it and see it fail for the expected reason, implement, then see it pass.
- **TypeScript:** no `any`, no explicit `unknown`, no `as` casts (except `as const`), no `!` non-null assertions, no namespace imports. Keep comments to 1–2 lines.
- **Scope:**
  - Do not commit. Do not use siftkit. Do not touch files outside the task's list unless a listed change makes a test elsewhere fail; in that case, update that test only as far as needed and report it.
  - Leave unrelated working-tree changes alone. The tree is already dirty.
- **Running tests:**
  - Unit tests and `tests/process/*` files: `node src/test-runner/run-tests.ts <file> [<file>...]`. `npm run test:process -- <file>` runs the whole process suite, so don't use it for single files.
  - Dashboard: `npm run test:dashboard`.
- **Finish** with `npm run typecheck`, which includes lint and must exit 0.

---

### Task A: Parent prompts built in one place (findings 1, 3, 4, 5, 6)

**Files:**
- Modify: `src/orchestrator/prompts.ts`, `src/orchestrator/run.ts` (`askParent` ~line 280, `runContext` ~line 197, every builder call site).
- Test: `tests/orchestrator-prompts.test.ts`, `tests/process/orchestrator-run.e2e.test.ts` (assertions at ~lines 360 and 515, and any other prompt-text assertions).

**What is wrong:**
1. Six builders each start with `buildRunContext(input.run)`, and `run.ts` passes `run: this.runContext()` at six call sites. The run block must come first in every parent prompt, because that's what lets the KV cache be reused across phases, but nothing enforces it.
3. `RunContext.plan` is nullable. Since the `goal` input was removed, check approval and final verification would silently lose the goal if the plan were missing. The old `requirePlan()` used to throw.
4. The engine parses the answer as `plan_preparation`, and `askParent` parses it again as `plan preparation`. Both are reported, under different names.
5. The answer shape exists three times: hand-written prose (`PLAN_JSON_SHAPE`, the `{"status": …}` lines, the drift and decision shapes), the zod schema, and the JSON schema derived from zod. The prose already disagrees with the schema: it omits drift's `not_required`.
6. The evidence-review answer format is written out twice (`buildAttemptReviewPrompt` and `buildFinalVerificationPrompt`).

- [ ] **Step 1: Write the failing tests** in `tests/orchestrator-prompts.test.ts`. Rework the file for the new shape:
  - `buildParentPrompt(planned, phase, schema)`, with `schema = buildPlannerJsonSchema(OrchestratorTaskReviewSchema)` and `phase = buildFinalVerificationPrompt({ checks: [], rejectedProblems: [] })`:
    - It starts with `${buildRunContext(planned)}\n${phase}\n`.
    - It ends with `'Answer with exactly one JSON object that matches this JSON schema:\n' + JSON.stringify(schema)`.
  - Every phase builder's output starts with `Phase: `. None of them contains `Orchestrator run context`, `Answer with exactly one JSON object`, `"status": "pass"`, `"decision": "approve"`, or `Plan JSON shape`. The builders are plan preparation, attempt review, drift review, child approval, check approval and final verification.
  - Attempt review and final verification both contain the exported `EVIDENCE_REVIEW_GUIDANCE` line exactly once.
  - The drift review prompt contains `"not_required"` in the sentence that forbids it (see Step 3).
  - Keep the "goal appears exactly once" test, now applied to `buildParentPrompt(run(true), buildFinalVerificationPrompt(...), schema)` and the check-approval equivalent.
  - Keep the rejection-feedback and plan-preparation tests, adapted to the builders no longer taking `run`.

  In `tests/process/orchestrator-run.e2e.test.ts`, change the expected payload names to the schema names:
  - `invalid plan preparation payload` becomes `invalid plan_preparation payload` (~line 360).
  - `invalid approval decision payload` becomes `invalid approval_decision payload` (~line 515).
  - Then grep the e2e file for any other assertion on removed prompt text (`Answer with exactly one JSON object:`, the `{"status": ...}` shape lines) and update it to the new schema line.

- [ ] **Step 2: Run the tests and confirm they fail.**
  - `node src/test-runner/run-tests.ts tests/orchestrator-prompts.test.ts` fails: `buildParentPrompt` and `EVIDENCE_REVIEW_GUIDANCE` don't exist yet.
  - `node src/test-runner/run-tests.ts tests/process/orchestrator-run.e2e.test.ts` fails on the renamed payload names.

- [ ] **Step 3: Implement `prompts.ts`.**
  - Delete `PLAN_JSON_SHAPE`.
  - Add the guidance constant and `buildParentPrompt`:
    ```ts
    /** How an evidence review answers; shared by task review and final verification. */
    export const EVIDENCE_REVIEW_GUIDANCE = 'Answer "pass" with evidence whose snippet is the exact code at each cited line, or "fail" with one finding per problem.';

    /** A parent prompt: the shared run block first (one KV prefix for every phase), then the phase, then the answer's JSON schema. */
    export function buildParentPrompt(run: RunContext, phasePrompt: string, answerSchema: JsonObject): string {
      return [buildRunContext(run), phasePrompt,
        'Answer with exactly one JSON object that matches this JSON schema:', JSON.stringify(answerSchema)].join('\n');
    }
    ```
    Import `type JsonObject` from `../lib/json-types.ts`.
  - In every phase builder, remove the `run` input and the `buildRunContext(input.run)` line, so each builder returns its `Phase: …` text first.
  - **Plan preparation:** replace the lines from `'Answer with exactly one JSON object:'` through `PLAN_JSON_SHAPE` with:
    ```ts
    'Answer status "ready" when the supplied plan is adequate (its plan must be that plan\'s faithful manifest), "generated" when',
    'there is no plan or the supplied one is inadequate (list what was inadequate in "issues"), or "blocked" with a "reason"',
    'when the request cannot be planned safely (for example an ambiguous target). A command check\'s cwd is relative to the',
    'repository root, usually ".".',
    ```
  - **Attempt review:** replace its three answer lines with `EVIDENCE_REVIEW_GUIDANCE`, keeping `describeRejection('review', …)` after it.
  - **Final verification:** replace its three answer lines with `EVIDENCE_REVIEW_GUIDANCE`. Keep `describeRejection` before it, as now.
  - **Drift review:** replace the lines from `'Answer with exactly one JSON object with fields …'` through the `"actionable"` shape with:
    ```ts
    'Answer status "clean" with no findings, or "actionable" with your findings; account for every previously confirmed',
    'finding in "resolutions". Never answer "not_required": the host uses it only for steps without code changes.',
    ```
    Keep the existing `Use taskId … and changeDigest ….` line and `describeRejection('report', …)`.
  - **Child approval and check approval:** delete their `'Answer with exactly one JSON object: {"decision": …}'` line. Their "say why" guidance already exists.

- [ ] **Step 4: Implement `run.ts`.**
  - `askParent<T>(label, phasePrompt: string, schema: z.ZodType<T>, rejected)` builds the prompt once:
    ```ts
    const prompt = buildParentPrompt(this.runContext(label), phasePrompt, buildPlannerJsonSchema(schema));
    ```
    It passes `prompt` to `this.phases.infer`, and parses with `ModelJson.parseObject(output, schema, ORCHESTRATOR_PHASE_ANSWER_NAMES[label])`. Import `buildPlannerJsonSchema` from `../planner-protocol/json-schema.ts` and `ORCHESTRATOR_PHASE_ANSWER_NAMES` from `./phase-runner.ts`.
  - Replace `runContext()`:
    ```ts
    /** The block every parent prompt starts with; every phase after plan preparation requires the saved plan. */
    private runContext(label: OrchestratorPhaseLabel): RunContext {
      const { plan, planPath, planHash } = this.state;
      const saved = plan === null || planPath === null || planHash === null ? null : { path: planPath, hash: planHash, plan };
      if (saved === null && label !== 'plan preparation') throw new Error(`The plan must be saved before the ${label} phase.`);
      return { task: this.request.task, workers: this.workers, preexistingDirtyPaths: this.requireRunStart().dirtyPaths, plan: saved };
    }
    ```
  - Remove `run: this.runContext()` from every builder call. `buildRunContext` and `buildParentPrompt` are now the only users of `RunContext` in `prompts.ts`.
  - The `decideOnParentModel` prompt join (`[prompt, ...describeRejection('answer', rejected)].join('\n')`) stays as it is.
  - The `plan === null` throw can't be reached by any current path, so it gets no test. Mention this in the report.

- [ ] **Step 5: Run the tests and confirm they pass.**
  - `node src/test-runner/run-tests.ts tests/orchestrator-prompts.test.ts tests/process/orchestrator-run.e2e.test.ts`
  - `npm run typecheck`
  - Grep `src` and `tests` for `PLAN_JSON_SHAPE` and `run: this.runContext()`: no hits.

---

### Task B: Orchestrator cleanups (findings 9, 10, 12)

**Files:**
- Modify: `src/orchestrator/run.ts` (`askEvidenceReview` and `evidenceReviewPrompt`, ~lines 520–550).
- Modify: `src/orchestrator/prompts.ts` (`describePreexistingChanges`).
- Modify: `src/orchestrator/phase-runner.ts` (lines 26–37).
- Test: `tests/orchestrator-prompts.test.ts`, `tests/process/orchestrator-run.e2e.test.ts` (~line 64–65).

**What is wrong:**
9. Task review lists the run-start dirty paths twice: once in the run block, and again inside the task baseline list, which is a superset.
10. `askEvidenceReview` branches on `review.kind` in three places: the label ternary, a failure switch, and a prompt switch.
12. The five phase labels are listed both in `OrchestratorPhaseLabel` and in `ORCHESTRATOR_PHASE_ANSWER_NAMES`.

- [ ] **Step 1: Write the failing tests.**
  - **e2e** (`tests/process/orchestrator-run.e2e.test.ts`, the test with `src/app.ts` dirty before the run, ~line 64): the task review prompt must contain both of these lines:
    - `Uncommitted changes that predate this run (not made by it; never count them against it): src/app.ts`
    - `Uncommitted changes that predate this task, beyond those listed in the run context (not made by it; never count them against it): none`

    This replaces the current assertion that the task line lists `src/app.ts`.
  - **`tests/orchestrator-prompts.test.ts`:** `buildAttemptReviewPrompt` with `preexistingDirtyPaths: ['b.ts']` contains `predate this task, beyond those listed in the run context (not made by it; never count them against it): b.ts.`
  - No new tests for 10 and 12: they are structure-only. The existing `task_review_invalid` and `final_review_invalid` e2e tests must keep passing unchanged.

- [ ] **Step 2: Run the tests and confirm they fail.**

- [ ] **Step 3: Implement.**
  - **`prompts.ts`:**
    ```ts
    function describePreexistingChanges(subject: 'run' | 'task', paths: readonly string[]): string {
      const scope = subject === 'run' ? 'this run' : 'this task, beyond those listed in the run context';
      return `Uncommitted changes that predate ${scope} (not made by it; never count them against it): ${paths.join(', ') || 'none'}.`;
    }
    ```
  - **`run.ts`, replace `evidenceReviewPrompt` with one dispatch:**
    ```ts
    /** One evidence review's phase, prompt, and the failure it ends in when no answer is usable. */
    private describeEvidenceReview(review: EvidenceReviewRequest, rejectedProblems: readonly string[]):
      { label: OrchestratorPhaseLabel; prompt: string; failureCode: OrchestratorFailureCode; subject: string; taskId: string | null } {
      switch (review.kind) {
        case 'task': {
          const { task, baseline } = review.running;
          const runDirty = new Set(this.requireRunStart().dirtyPaths);
          return { label: 'task review', failureCode: 'task_review_invalid', subject: `Task '${task.id}' evidence review`, taskId: task.id,
            prompt: buildAttemptReviewPrompt({ task, result: { workerOutput: review.child.output, checks: review.checks,
              changedPaths: review.changedPaths }, preexistingDirtyPaths: [...baseline.keys()].filter((path) => !runDirty.has(path)),
              rejectedProblems }) };
        }
        case 'final':
          return { label: 'final verification', failureCode: 'final_review_invalid', subject: 'The final evidence review', taskId: null,
            prompt: buildFinalVerificationPrompt({ checks: review.checks, rejectedProblems }) };
      }
    }
    ```
  - **`askEvidenceReview`:**
    ```ts
    let rejected: string[] = [];
    let described = this.describeEvidenceReview(review, rejected);
    for (let attempt = 1; attempt <= PARENT_PHASE_ATTEMPTS; attempt += 1) {
      described = this.describeEvidenceReview(review, rejected);
      const reply = await this.askParent(described.label, described.prompt, OrchestratorTaskReviewSchema, rejected);
      rejected = reply.ok ? findReviewEvidenceProblems(this.request.repoRoot, reply.answer) : reply.problems;
      if (reply.ok && rejected.length === 0) return reply.answer;
    }
    throw fail(described.failureCode, `${described.subject} was unusable: ${rejected.join(' ')}`, { taskId: described.taskId });
    ```
    The failure messages must stay byte-identical to the current ones. Import `OrchestratorFailureCode` if it isn't imported already.
  - **`phase-runner.ts`:**
    - Define `ORCHESTRATOR_PHASE_ANSWER_NAMES` first, with `as const`.
    - Change the label type to `export type OrchestratorPhaseLabel = keyof typeof ORCHESTRATOR_PHASE_ANSWER_NAMES;` and drop the `satisfies Record<OrchestratorPhaseLabel, string>`.
    - Keep the 1-line doc comment, and add one for the type.

- [ ] **Step 4: Run the tests and confirm they pass.**
  - `node src/test-runner/run-tests.ts tests/orchestrator-prompts.test.ts tests/process/orchestrator-run.e2e.test.ts`
  - `npm run typecheck`

---

### Task C: Engine exit reads stderr only after it ends (finding 2)

**Files:**
- Modify: `src/status-server/tabby-run-recorder.ts`, `src/status-server/managed-tabby.ts` (the `child.once('exit', …)` handler, ~line 288).
- Modify: `tests/helpers/in-process-tabby.ts` (new option).
- Test: `tests/tabby-run-recorder.test.ts`, `tests/managed-tabby.test.ts`.

**What is wrong:** the exit handler calls `recorder.lastEngineError()` synchronously inside `'exit'`. Node can fire `'exit'` before the child's stdio has drained, so the final traceback line can be missed. A final line with no trailing newline is never observed at all.

- [ ] **Step 1: Write the failing tests.**
  - **`tests/tabby-run-recorder.test.ts`:**
    - `an unterminated last stderr line is observed when the stream ends`:
      - Write `'RuntimeError: boom'`, with no newline.
      - `lastEngineError()` is `null`.
      - Then `stderr.end()`, `await recorder.waitForEngineStderrEnd(1000)`, and `lastEngineError()` is `'RuntimeError: boom'`.
      - The `withTabbyRecorder` callback must become async-capable; adapt the helper.
    - `waitForEngineStderrEnd resolves after its bound when stderr never ends`: never end the stream; `await recorder.waitForEngineStderrEnd(20)` resolves.
  - **`tests/helpers/in-process-tabby.ts`:**
    - Add the option `/** With exitAfterLog: emits 'exit' first and writes exitStderrLine afterwards, as a real child's stderr can drain after its exit. */ stderrAfterExit?: boolean;`.
    - In `FakeTabbyProcess`, add a method that sets `exitCode` and emits `'exit'`, then on `setImmediate` writes the given line to stderr and ends both streams.
    - Use it from the `exitAfterLog` path when `stderrAfterExit` is set.
  - **`tests/managed-tabby.test.ts`:** new test `managed Tabby names the engine exception even when stderr drains after the exit`.
    - Same as the existing `…exits during startup` test, plus `stderrAfterExit: true`.
    - Expect the identical message, `TabbyAPI exited unexpectedly (code=1, signal=null): RuntimeError: Insufficient VRAM in split for model and cache`.

- [ ] **Step 2: Run the tests and confirm they fail.**
  - `waitForEngineStderrEnd` doesn't exist yet.
  - The managed test gets the message without the exception.
  - `node src/test-runner/run-tests.ts tests/tabby-run-recorder.test.ts tests/managed-tabby.test.ts`

- [ ] **Step 3: Implement.**
  - **`tabby-run-recorder.ts`:** first confirm that `InferenceRunRecorder.attach` consumes the stream with `on('data')`, so `'end'` will fire.
    ```ts
    private engineStderrEnd: Promise<void> = Promise.resolve();

    override attachEngineStderr(stream: NodeJS.ReadableStream | null): void {
      super.attachEngineStderr(stream);
      if (stream === null) return;
      // A last line without a newline is observed once the stream ends.
      this.engineStderrEnd = new Promise((resolve) => {
        stream.once('end', () => {
          this.observeEngineStderr('\n');
          resolve();
        });
      });
    }

    /** Resolves once engine stderr has ended and its last line is observed, or after `timeoutMs`. */
    async waitForEngineStderrEnd(timeoutMs: number): Promise<void> {
      await Promise.race([this.engineStderrEnd, delay(timeoutMs, undefined, { ref: false })]);
    }
    ```
    Use `import { setTimeout as delay } from 'node:timers/promises';`. If the file or the repo already uses a different `delay` helper, use that instead and keep the timer unref'd if it supports that.
  - **`managed-tabby.ts`:**
    - Add `const EXIT_STDERR_DRAIN_MS = 1_000;` near the top, with a 1-line comment.
    - Replace the `'exit'` handler body with `void this.settleExit(child, recorder, this.stopping, code, signal);`, and move the existing body into:
      ```ts
      /** Records an engine exit; 'exit' can precede the last stderr chunk, so the traceback is read once stderr ends. */
      private async settleExit(child: EngineProcess, recorder: TabbyRunRecorder, stopping: boolean,
        code: number | null, signal: NodeJS.Signals | null): Promise<void> {
        await recorder.waitForEngineStderrEnd(EXIT_STDERR_DRAIN_MS);
        ...existing message composition and recorder.finalize, using `stopping` instead of `this.stopping`...
        if (stopping || this.child !== child) return;
        ...existing state changes (startupError, processBaseUrl, …, transitionProcessTo('failed'))...
      }
      ```
    - `stopping` is captured at exit time, so a relaunch during the drain window can't be mistaken for a crash. The `this.child !== child` guard keeps a stale exit from touching a newer process.
    - Use the exact types already imported in the file for `EngineProcess` and `TabbyRunRecorder`.

- [ ] **Step 4: Run the tests and confirm they pass.**
  - `node src/test-runner/run-tests.ts tests/tabby-run-recorder.test.ts tests/managed-tabby.test.ts`
  - Every `tests/process/*managed*` and `tests/process/*tabby*` file, run individually.
  - `npm run typecheck`

---

### Task D: Contract and adapter fixes (findings 7, 8, 11, 13)

**Files:**
- Modify: `packages/contracts/src/config.ts` (~lines 101–160).
- Modify: `src/inference-presets/exl3-preset-adapter.ts` (~lines 29–75).
- Modify: `src/repo-search/approval-verdict.ts`, `src/repo-search/planner-protocol.ts` (~line 709).
- Modify: `docs/superpowers/specs/2026-10-11-exl3-disk-cache-design.md` (the Validation bullets).
- Test: `tests/contracts-config.test.ts`, `tests/model-preset-adapters.test.ts`, `tests/approval-verdict-request.test.ts`, `tests/live-approval-cache-chain.test.ts`.

**What is wrong:**
7. `diskCacheRootKey` reimplements `.`/`..` path resolution, separately from the adapter's `win32.resolve`.
8. `buildApprovalVerdictJsonSchema()` only forwards to `buildPlannerJsonSchema(ApprovalVerdictSchema)`.
11. `Exl3LaunchEnvironmentSchema` has three independent optional disk-cache variables, so a directory without a size parses.
13. The contract's error message hardcodes the user's own path, `D:\AI\exl3-disk-cache`.

- [ ] **Step 1: Write the failing tests.**
  - **`tests/contracts-config.test.ts`:**
    - In the disk-cache test, `withDisk({ DiskCacheDir: 'D:\\AI\\x\\..\\cache' })` and `withDisk({ DiskCacheDir: 'D:\\AI\\.\\cache' })` must each fail with an issue matching `/normalized absolute path/u`. The existing `'cache'` case must match that regex as well.
    - In the shared-root test, replace the `..` preset with a separator, case and trailing-slash variant (e.g. `'d:/AI/exl3-disk-cache/'`) that has `DiskCacheSizeMiB: 1024`. It must still fail with `/share DiskCacheSizeMiB/u`.
  - **`tests/model-preset-adapters.test.ts`:**
    - Take the launch environment the adapter builds for a disk-cache preset, delete its `TABBY_MEMORY_DISK_CACHE_SIZE` key, and pass it to `Exl3LaunchEnvironmentSchema.safeParse`. `success` must be `false`. Build the copy with object rest destructuring, not `delete` on a typed object.
    - A copy of a non-disk environment plus only `TABBY_MEMORY_DISK_CACHE_DIR` must also fail.
  - **`tests/approval-verdict-request.test.ts`:** change the `buildApprovalVerdictJsonSchema` test to assert the same expected schema from `buildPlannerJsonSchema(ApprovalVerdictSchema)`, and rename it to `the approval verdict JSON schema constrains verdict to approve|deny|unsure`. In `tests/live-approval-cache-chain.test.ts`, use `buildPlannerJsonSchema(ApprovalVerdictSchema)` too.

- [ ] **Step 2: Run the tests and confirm they fail**, except the approval-verdict ones, which are a pure rename and may already pass.
  - `node src/test-runner/run-tests.ts tests/contracts-config.test.ts tests/model-preset-adapters.test.ts tests/approval-verdict-request.test.ts`

- [ ] **Step 3: Implement.**
  - **`config.ts`:**
    ```ts
    const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/u;
    const DOT_SEGMENT = /(?:^|[\\/])\.{1,2}(?:[\\/]|$)/u;

    /** One key per disk-cache root: separators unified, trailing separators dropped, case-insensitive. */
    function diskCacheRootKey(directory: string): string {
      return directory.replace(/\//gu, '\\').replace(/\\+$/u, '').toLowerCase();
    }
    ```
    The absolute-path check becomes `if (!WINDOWS_ABSOLUTE_PATH.test(dir) || DOT_SEGMENT.test(dir))`, with the message `` `Model preset '${preset.id}': DiskCacheDir must be a normalized absolute path such as C:\\exl3-cache (no . or .. segments).` ``
  - **`exl3-preset-adapter.ts`:**
    ```ts
    // The disk tier is all three variables or none; a partial set must not parse.
    const Exl3DiskCacheEnvironment = {
      TABBY_MEMORY_DISK_CACHE_DIR: z.string(), TABBY_MEMORY_DISK_CACHE_SIZE: z.string(),
      TABBY_MEMORY_DISK_CACHE_CHECKPOINT_INTERVAL: z.string(),
    };
    const Exl3NoDiskCacheEnvironment = {
      TABBY_MEMORY_DISK_CACHE_DIR: z.undefined(), TABBY_MEMORY_DISK_CACHE_SIZE: z.undefined(),
      TABBY_MEMORY_DISK_CACHE_CHECKPOINT_INTERVAL: z.undefined(),
    };
    ```
    - Take the three disk-cache fields out of the base object, which becomes a private `const Exl3BaseLaunchEnvironmentSchema`.
    - Define `export const Exl3LaunchEnvironmentSchema = z.union([Exl3BaseLaunchEnvironmentSchema.extend(Exl3DiskCacheEnvironment), Exl3BaseLaunchEnvironmentSchema.extend(Exl3NoDiskCacheEnvironment)]);`.
    - Keep the existing doc comment on the disk-cache fields.
    - Fix any consumer that stops compiling (`managed-tabby.ts` uses `Exl3LaunchEnvironment`) without casts.
  - **`approval-verdict.ts`:** delete `buildApprovalVerdictJsonSchema` and any imports that become unused. In `planner-protocol.ts`, use `responseSchema: buildPlannerJsonSchema(ApprovalVerdictSchema)` and fix its imports.
  - **Spec:** the shared-root bullet becomes: "Presets whose `DiskCacheDir` values are equal after normalisation (separators unified, trailing separators dropped, case-insensitive) must have equal `DiskCacheSizeMiB`; `.` and `..` segments are rejected." The first bullet says "a normalized absolute Windows path".

- [ ] **Step 4: Run the tests and confirm they pass.**
  - `node src/test-runner/run-tests.ts tests/contracts-config.test.ts tests/model-preset-adapters.test.ts tests/approval-verdict-request.test.ts tests/managed-tabby.test.ts tests/config-normalization.test.ts`
  - `npm run test:dashboard`
  - `npm run typecheck`
  - Grep `src` and `tests` for `buildApprovalVerdictJsonSchema`: no hits.

# Admission State, RAM Zero, and Turn Summary Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish one in-memory applied-preset owner, remove flaky/implicit queue-test behavior, preserve zero cache RAM settings, and print a condensed activity summary at every tenth agent turn for both `repo-search` and `repo-agent`.

**Architecture:** `AppliedModelPresetState` becomes the only owner of the active applied preset and is shared by admission plus the optional runtime coordinator. Queue tests observe state transitions rather than time, RAM normalization gains a strict non-negative integer rule, and a typed `ActivitySummaryCollector` records each completed tool batch and emits a shared SSE event after turns divisible by ten; CLI renderers always send that event to `stderr`.

**Tech Stack:** TypeScript 5.9, Node.js test runner, Zod runtime schemas, status-server SSE, existing repo-search agent loop.

## Global Constraints

- Follow strict red-green-refactor TDD and observe every new test fail for the intended reason before production edits.
- Prefer E2E behavior coverage; add focused class tests only where an E2E seam cannot isolate the contract.
- Use `siftkit repo-search` for discovery and `siftkit summary` for diff/test-output interpretation, each with a 15-minute timeout.
- Delegate Tasks 1, 3, and 4 to exactly one sequential `siftkit repo-agent` invocation each. Do not retry a failed or rejected task; finish it locally.
- Implement Task 2 and Task 5 in the main session.
- Repo-agent must not commit or create temporary files. The main session reviews, validates, cleans, and commits after each task.
- Use the existing branch; do not create a worktree.
- Keep all code TypeScript and runtime-schema-derived at IO boundaries.
- No type-assertion casts, `any`, non-null assertions, namespace imports, function-valued dependencies, shims, compatibility aliases, or legacy fallbacks.
- Keep classes explicit, small, reusable, DRY, and no more abstract than the approved design requires.
- Request release and FIFO granting must perform no SQLite/config reads.
- Final validation includes full tests, typecheck/lint, and branch coverage.

---

## File Structure

### New files

- `src/status-server/applied-model-preset-state.ts`: sole in-memory owner of the normalized applied model preset.
- `tests/applied-model-preset-state.test.ts`: focused state ownership and mutation contract.
- `src/repo-search/engine/activity-summary-collector.ts`: typed ten-turn activity collection, classification, de-duplication, and window reset.
- `tests/activity-summary-collector.test.ts`: classification and turn-window behavior.

### Modified production files

- `src/status-server/server-types.ts`: require applied state and remove `modelRequestCapacity`.
- `src/status-server/index.ts`: initialize and inject applied state.
- `src/status-server/preset-runtime-coordinator.ts`: replace private `activePreset` with shared state and remove `getActiveParallelSlots()`.
- `src/status-server/server-ops.ts`: read capacity only from applied state.
- `src/status-server/routes/core.ts`: apply coordinator-free config changes to shared state.
- `src/config/normalization.ts`: add strict non-negative integer normalization for cache RAM fields.
- `src/repo-search/types.ts`: add runtime-schema-derived activity summary payload fields to the progress contract.
- `src/repo-search/engine/progress-reporter.ts`: emit typed activity summary events.
- `src/repo-search/engine/tool-action-processor.ts`: record one completed batch per agent turn and emit at multiples of ten.
- `src/cli/progress-renderer.ts`: render summaries as numbered multi-line `stderr` output even when detailed progress is disabled.

### Modified tests/helpers

- `tests/helpers/server-context-fixture.ts`
- `tests/inference-runs.test.ts`
- `tests/model-request-queue.test.ts`
- `tests/preset-runtime-coordinator.test.ts`
- `tests/dashboard-benchmark-restart.test.ts`
- `tests/helpers/dashboard-model-queue-harness.ts`
- `tests/dashboard-chat-concurrency.test.ts`
- `tests/dashboard-status-server.test.ts`
- `tests/model-request-queue-http.test.ts`
- `tests/config-normalization.test.ts`
- `tests/config-update-endpoint.e2e.test.ts`
- `tests/engine-progress-reporter.test.ts`
- `tests/cli-progress-renderer.test.ts`
- `tests/streamed-repo-search-endpoint.test.ts`
- `tests/streamed-repo-agent-endpoint.test.ts`
- `tests/repo-agent-command.test.ts`

---

### Task 1: Make AppliedModelPresetState the Sole Applied-Preset Owner

**Execution:** One `siftkit repo-agent` attempt.

**Files:**

- Create: `src/status-server/applied-model-preset-state.ts`
- Create: `tests/applied-model-preset-state.test.ts`
- Modify: `src/status-server/server-types.ts`
- Modify: `src/status-server/index.ts`
- Modify: `src/status-server/preset-runtime-coordinator.ts`
- Modify: `src/status-server/server-ops.ts`
- Modify: `src/status-server/routes/core.ts`
- Modify: `tests/helpers/server-context-fixture.ts`
- Modify: `tests/inference-runs.test.ts`
- Modify: `tests/model-request-queue.test.ts`
- Modify: `tests/preset-runtime-coordinator.test.ts`
- Modify: `tests/dashboard-benchmark-restart.test.ts`

**Interfaces:**

- Consumes: normalized `ModelRuntimePreset` from `src/config/types.ts` and `getActiveModelPreset(config)` from the config module.
- Produces:

```typescript
export class AppliedModelPresetState {
  constructor(initialPreset: ModelRuntimePreset);
  getPreset(): ModelRuntimePreset;
  getParallelSlots(): number;
  applyPreset(preset: ModelRuntimePreset): void;
}
```

- `ServerContext` keeps `presetRuntimeCoordinator?: PresetRuntimeCoordinator`, adds required `appliedModelPresetState: AppliedModelPresetState`, and removes `modelRequestCapacity`.
- `PresetRuntimeCoordinator` receives `AppliedModelPresetState` explicitly and owns no separate preset or capacity getter.

- [ ] **Step 1: Write failing applied-state and coordinator behavior tests**

Add a focused state contract that independently creates two literal normalized presets from existing config fixtures:

```typescript
test('applied model preset state changes preset and admission capacity together', () => {
  const initial = getActiveModelPreset(getDefaultConfig());
  const replacement = { ...initial, id: 'replacement', ParallelSlots: 3 };
  const state = new AppliedModelPresetState(initial);

  assert.equal(state.getPreset(), initial);
  assert.equal(state.getParallelSlots(), 1);
  state.applyPreset(replacement);
  assert.equal(state.getPreset(), replacement);
  assert.equal(state.getParallelSlots(), 3);
});
```

Extend coordinator tests to retain the injected state and assert:

```typescript
assert.equal(appliedState.getPreset().id, target.id); // after successful switch
assert.equal(appliedState.getPreset().id, previous.id); // after failed switch rollback
```

Extend the coordinator-free config endpoint E2E test to save `ParallelSlots: 2`, then acquire two model requests through the real server context and prove the third queues until release. This catches a missing state application at the config boundary.

- [ ] **Step 2: Run RED verification**

Run:

```powershell
npm run build:test
node .\dist\scripts\run-tests.js applied-model-preset-state preset-runtime-coordinator config-update-endpoint.e2e
```

Expected: FAIL because `AppliedModelPresetState` does not exist and the endpoint cannot expose the new shared-state contract.

- [ ] **Step 3: Implement the state class and server construction**

Create the class exactly as the interface above. In `startStatusServer`, construct it before the context:

```typescript
const appliedModelPresetState = new AppliedModelPresetState(getActiveModelPreset(initialConfig));
```

Assign that instance to `ctx.appliedModelPresetState`, pass the same instance into the coordinator constructor, and remove `modelRequestCapacity` initialization.

- [ ] **Step 4: Replace coordinator ownership completely**

Replace every read of `this.activePreset` with `this.appliedModelPresetState.getPreset()`. Replace successful activation and rollback writes with `applyPreset(target)` and `applyPreset(previous)`. Keep `configPath` for configured-target reads. Delete the `activePreset` field and `getActiveParallelSlots()` method; do not retain aliases.

- [ ] **Step 5: Replace admission and config mutation paths**

Make capacity unconditional and in-memory:

```typescript
function getModelRequestCapacity(ctx: ServerContext): number {
  return ctx.appliedModelPresetState.getParallelSlots();
}
```

After successful coordinator-free config persistence:

```typescript
if (!ctx.presetRuntimeCoordinator) {
  ctx.appliedModelPresetState.applyPreset(getActiveModelPreset(nextConfig));
}
```

Update every listed fixture and coordinator construction to inject explicit state. Remove all production and test occurrences of `modelRequestCapacity` and `getActiveParallelSlots`.

- [ ] **Step 6: Run GREEN and focused regression verification**

Run:

```powershell
npm run build:test
node .\dist\scripts\run-tests.js applied-model-preset-state preset-runtime-coordinator model-request-queue inference-runs dashboard-benchmark-restart config-update-endpoint.e2e
npm run typecheck:test
```

Expected: PASS. Confirm the SQLite-lock inference test still grants after release.

- [ ] **Step 7: Main-session review and commit**

Use `siftkit summary` on `git diff`, confirm only Task 1 scope changed, scan with `siftkit repo-search` for removed symbols and banned patterns, run `git diff --check`, then commit:

```powershell
git add -- src/status-server tests
git commit -m "refactor: centralize applied model preset state"
```

---

### Task 2: Remove Queue-Test Sleeps and Require Explicit Harness Capacity

**Execution:** Main session; no repo-agent invocation.

**Files:**

- Modify: `tests/model-request-queue.test.ts`
- Modify: `tests/helpers/dashboard-model-queue-harness.ts`
- Modify: `tests/dashboard-chat-concurrency.test.ts`
- Modify: `tests/dashboard-status-server.test.ts`
- Modify: `tests/model-request-queue-http.test.ts`

**Interfaces:**

- Consumes: existing synchronous queue diagnostics and acquisition promises.
- Produces required harness options:

```typescript
type DashboardModelQueueHarnessOptions = {
  exl3ActivePreset?: boolean;
  parallelSlots: number;
};
```

- [ ] **Step 1: Tighten the harness signature first and verify RED**

Make `parallelSlots` required and remove the constructor default options/fallback:

```typescript
constructor(prefix: string, options: DashboardModelQueueHarnessOptions) {
  this.parallelSlots = options.parallelSlots;
}
```

Run:

```powershell
npm run typecheck:test
```

Expected: FAIL at every omitted `parallelSlots` call site.

- [ ] **Step 2: Update all eleven constructor calls explicitly**

Use `parallelSlots: 4` for the three EXL3 concurrency callers that previously relied on four and for the EXL3 parallel case at `tests/dashboard-chat-concurrency.test.ts:36`. Use `parallelSlots: 1` for FIFO, session-conflict, plan-race, repo-search-disconnect, and existing capacity-one cases. Preserve existing explicit `parallelSlots: 2` for the llama capacity-two HTTP case.

Every call must pass an options object; no zero-argument compatibility overload remains.

- [ ] **Step 3: Replace three sleeps with queue-state transitions**

For each affected test, delete:

```typescript
await new Promise((resolve) => setTimeout(resolve, 20));
```

Immediately assert the synchronous diagnostics (`activeCount`, `queueLength`) after starting the queued acquisition. Keep the resolution flag assertion only where it distinguishes the transition. Release one active request, await the queued acquisition promise, and then assert resolution and FIFO ownership. Do not add fake elapsed time, polling, `setImmediate`, or another negative wait.

- [ ] **Step 4: Run GREEN verification**

Run:

```powershell
npm run build:test
node .\dist\scripts\run-tests.js model-request-queue model-request-queue-http dashboard-chat-concurrency dashboard-status-server
npm run typecheck:test
```

Expected: PASS with no `setTimeout(resolve, 20)` in `tests/model-request-queue.test.ts` and no omitted harness capacity.

- [ ] **Step 5: Main-session review and commit**

Review the Task 2 diff with `siftkit summary`, confirm all eleven callers are explicit, run `git diff --check`, then commit:

```powershell
git add -- tests
git commit -m "test: make model queue capacity deterministic"
```

---

### Task 3: Preserve Zero Cache RAM with Strict Non-Negative Normalization

**Execution:** One `siftkit repo-agent` attempt.

**Files:**

- Modify: `src/config/normalization.ts`
- Modify: `tests/config-normalization.test.ts`
- Modify: `tests/config-update-endpoint.e2e.test.ts`

**Interfaces:**

- Consumes: `JsonValue`, existing defaults, and normalized preset construction.
- Produces a private `getFiniteNonNegativeInteger(value, fallback): number` used only for `CacheRam` and `CacheRecurrentRam`.

- [ ] **Step 1: Write table-driven failing normalization tests**

Add literal cases for both fields:

```typescript
const cases = [
  { value: 0, expected: 0 },
  { value: 4096, expected: 4096 },
  { value: -1, expected: defaultValue },
  { value: 1.5, expected: defaultValue },
  { value: 'invalid', expected: defaultValue },
] as const;
```

Normalize a preset for each literal and assert the selected cache field. Add an endpoint E2E assertion that `PUT /config` with both RAM fields set to zero returns and persists zero.

- [ ] **Step 2: Run RED verification**

Run:

```powershell
npm run build:test
node .\dist\scripts\run-tests.js config-normalization config-update-endpoint.e2e
```

Expected: FAIL because zero normalizes to `8192`/`4096`; the fractional case must also fail until strict integer validation exists.

- [ ] **Step 3: Implement the minimal normalization rule**

Use explicit empty/null rejection and strict integer validation:

```typescript
function getFiniteNonNegativeInteger(value: JsonValue, fallback: number): number {
  const text = String(value ?? '').trim();
  if (!text) {
    return fallback;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
```

Replace only the two cache RAM calls. Do not change `ParallelSlots`, `GpuLayers`, or unrelated normalization semantics.

- [ ] **Step 4: Run GREEN verification**

Run:

```powershell
npm run build:test
node .\dist\scripts\run-tests.js config-normalization config-update-endpoint.e2e dashboard-managed-presets
npm run typecheck:test
```

Expected: PASS; zero persists and invalid values retain defaults.

- [ ] **Step 5: Main-session review and commit**

Review the Task 3 diff with `siftkit summary`, verify the helper has exactly two production call sites, run `git diff --check`, then commit:

```powershell
git add -- src/config/normalization.ts tests/config-normalization.test.ts tests/config-update-endpoint.e2e.test.ts
git commit -m "fix: preserve zero cache ram settings"
```

---

### Task 4: Emit and Render Ten-Turn Activity Summaries

**Execution:** One `siftkit repo-agent` attempt.

**Files:**

- Create: `src/repo-search/engine/activity-summary-collector.ts`
- Create: `tests/activity-summary-collector.test.ts`
- Modify: `src/repo-search/types.ts`
- Modify: `src/repo-search/engine/progress-reporter.ts`
- Modify: `src/repo-search/engine/tool-action-processor.ts`
- Modify: `src/cli/progress-renderer.ts`
- Modify: `tests/engine-progress-reporter.test.ts`
- Modify: `tests/cli-progress-renderer.test.ts`
- Modify: `tests/streamed-repo-search-endpoint.test.ts`
- Modify: `tests/streamed-repo-agent-endpoint.test.ts`
- Modify: `tests/repo-agent-command.test.ts`

**Interfaces:**

- Consumes: validated `ToolAction[]`, the matching new `TaskCommand[]` recorded by one `executeBatch`, existing `turn`/`maxTurns`, `ProgressReporter`, SSE progress transport, and `JsonObject` CLI events.
- Produces runtime-schema-derived event types:

```typescript
export const ActivitySummaryCategorySchema = z.enum([
  'read_files',
  'repository_searches',
  'commands',
  'edited_files',
  'tests',
  'web',
]);

export const ActivitySummaryEntrySchema = z.object({
  category: ActivitySummaryCategorySchema,
  label: z.string().min(1),
  failed: z.boolean(),
});

export const ActivitySummaryProgressEventSchema = z.object({
  kind: z.literal('activity_summary'),
  turn: z.number().int().positive(),
  maxTurns: z.number().int().positive(),
  entries: z.array(ActivitySummaryEntrySchema),
});
```

Derive all three TypeScript types with `z.infer`. Add `entries?: ActivitySummaryEntry[]` to the existing progress envelope so SSE serialization remains structurally compatible without casts.

The collector interface is explicit:

```typescript
export class ActivitySummaryCollector {
  recordBatch(turn: number, actions: readonly ToolAction[], commands: readonly TaskCommand[]): void;
  takeSummary(turn: number, maxTurns: number): ActivitySummaryProgressEvent | null;
}
```

`takeSummary` returns non-null only when `turn % 10 === 0`, de-duplicates entries within the current window, and clears that window after returning the event.

- [ ] **Step 1: Write failing collector tests**

Cover these literal behaviors:

1. Turns 1–9 return `null`.
2. Turn 10 returns one event containing unique reads, `git fetch`, an edit target, a normal run command, a recognized test command, and a failed action.
3. Multiple actions in the turn-10 batch still produce one event.
4. Turn 20 contains only activity recorded after turn 10.
5. A run ending at turn 17 never calls a partial-flush API because none exists.

Classify tool names explicitly: `read`; `grep`/`find`/`ls`; `git`; `run`; `write`/`edit`; `web_search`/`web_fetch`. Recognize tests only from `run` command text using a focused pattern covering repository commands such as `npm test`, `npm run test`, `node .\dist\scripts\run-tests.js`, `npx vitest`, `npx jest`, `pytest`, `cargo test`, and `go test`. Do not classify arbitrary commands containing the substring `test`.

- [ ] **Step 2: Run collector RED verification**

Run:

```powershell
npm run build:test
node .\dist\scripts\run-tests.js activity-summary-collector
```

Expected: FAIL because the collector and schemas do not exist.

- [ ] **Step 3: Implement schemas, collector, and reporter method**

Use `JsonRecordReader` or runtime schemas to read path/command fields from `ToolAction.args`; never cast the JSON. Preserve concise normalized command text from the matching `TaskCommand`. Mark an entry failed when the recorded command is unsafe or has a non-zero/null exit outcome representing rejection/failure.

Add an explicit reporter method:

```typescript
activitySummary(event: ActivitySummaryProgressEvent): void {
  this.emit(event);
}
```

- [ ] **Step 4: Integrate once per completed tool batch**

`ToolActionProcessor` owns one collector for its run. In `executeBatch`, snapshot `commands.length`, process all actions, pair the processed actions with the commands appended during that batch, and call `recordBatch`. After transcript/state finalization, call `takeSummary(turn, this.deps.progress.maxTurns)` and emit the non-null result exactly once.

Expose `ProgressReporter.getMaxTurns(): number` if required; do not duplicate the configured maximum or pass a function. A batch with several tools remains one turn because `takeSummary` receives the existing `turn` once after the loop.

- [ ] **Step 5: Write renderer and transport failing tests**

Add tests proving:

- `ProgressReporter.activitySummary` preserves the typed payload.
- `CliProgressRenderer.forCli(stderr, 'repo-search', false)` renders `activity_summary` but still hides ordinary `tool_start` events.
- The output is a numbered multi-line summary with non-empty categories only, counts, labels, and `[failed]` markers.
- Both repo-search and repo-agent SSE endpoint tests receive `activity_summary` after ten mock tool turns.
- Non-TTY repo-agent command output has the summary only in captured `stderr` and exactly one parseable JSON line in captured `stdout`.

- [ ] **Step 6: Implement unconditional stderr rendering**

Parse `activity_summary` with `ActivitySummaryProgressEventSchema.safeParse(event)` before formatting. Give the full renderer a private explicit summary-formatting method. Change `WarningOnlyProgressRenderer` to forward exactly `context_warning` and `activity_summary`; do not enable other progress without `--progress`.

No status-server transport fork is needed: `RepoSearchSseProgressWriter` already forwards every event except `thinking` and `answer`. Keep stdout writers unchanged.

- [ ] **Step 7: Run GREEN and E2E verification**

Run:

```powershell
npm run build:test
node .\dist\scripts\run-tests.js activity-summary-collector engine-progress-reporter cli-progress-renderer streamed-repo-search-endpoint streamed-repo-agent-endpoint repo-agent-command
npm run typecheck:test
```

Expected: PASS. Assert a ten-action `tool_batch` creates one summary because the existing agent turn is the clock, while ten separate turns also emit only at turn 10.

- [ ] **Step 8: Main-session review and commit**

Review the Task 4 diff with `siftkit summary`, scan for duplicated counters/renderers and banned patterns, run `git diff --check`, then commit:

```powershell
git add -- src/repo-search src/cli/progress-renderer.ts tests
git commit -m "feat: report activity every ten agent turns"
```

---

### Task 5: Full Validation and Cleanup

**Execution:** Main session; no repo-agent invocation.

**Files:**

- Verify all changed production, test, and documentation files.
- Delete any task logs/scratch artifacts after extracting review evidence.

- [ ] **Step 1: Verify removed legacy paths and explicit callers**

Use `siftkit repo-search` with exact extraction prompts to prove:

- No production/test occurrence of `modelRequestCapacity` remains.
- No `getActiveParallelSlots` method or call remains.
- No `DashboardModelQueueHarness` call omits `parallelSlots`.
- No target queue test contains `setTimeout(resolve, 20)`.
- Cache RAM uses the non-negative helper at exactly two production call sites.
- Only one `% 10` activity-summary checkpoint implementation exists.

- [ ] **Step 2: Scan the complete branch diff**

Pipe `git diff main...HEAD` through `siftkit summary` with requests for behavioral changes, scope drift, duplication, type assertions, `any`, non-null assertions, namespace imports, compatibility paths, dynamically passed functions, and overengineering. Inspect exact raw lines only for reported anchors.

- [ ] **Step 3: Run full static and test verification**

Run each command separately and interpret output through `siftkit summary`:

```powershell
npm run typecheck
npm test
npm run test:dashboard
npm run test:coverage
```

Expected: all commands exit zero, with no warnings or unhandled errors. Review branch coverage and add missing behavioral cases for any new branch that is not defensively unreachable.

- [ ] **Step 4: Verify repository cleanliness**

Run `git diff --check`, confirm no scratch/temp files remain, and use `siftkit summary` on `git status --short --branch`. The only changes relative to `main` must be the approved commits.

- [ ] **Step 5: Final closeout commit only if validation required fixes**

If validation produced scoped fixes, stage only those reviewed files and commit:

```powershell
git commit -m "test: complete admission and progress validation"
```

If no files changed, do not create an empty commit.

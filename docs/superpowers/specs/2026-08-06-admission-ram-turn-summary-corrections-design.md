# Admission State, RAM Zero, and Turn Summary Corrections Design

Date: 2026-08-06
Status: Approved

## Goal

Remove duplicated model-admission capacity state, make queue tests deterministic and explicit, preserve valid zero-valued cache RAM settings, and print deterministic ten-turn activity summaries for both `repo-search` and `repo-agent` without breaking non-TTY output contracts.

## Scope

This correction contains four independently testable changes:

1. One first-class owner for the applied model preset used by admission and runtime coordination.
2. Deterministic queue tests and explicit dashboard harness capacity.
3. Non-negative cache RAM normalization that preserves zero.
4. Shared activity summaries at agent turns 10, 20, 30, and subsequent multiples of 10.

The changes remove superseded state and defaults completely. No compatibility aliases, fallback capacity fields, implicit harness defaults, or parallel reporting path remain.

## Applied Model Preset State

### Problem

Model-request capacity currently has two mutable owners. Coordinator-backed servers read `PresetRuntimeCoordinator.activePreset.ParallelSlots`; coordinator-free servers read `ServerContext.modelRequestCapacity`. Both represent the applied preset, but they must be initialized and synchronized separately.

The in-memory fallback was introduced so releasing a model request never needs a SQLite read while the database is contended. That constraint remains mandatory.

### Architecture

Introduce an explicit `AppliedModelPresetState` class that owns the normalized model preset currently applied to the running backend. It exposes the current preset and its `ParallelSlots` value through explicit methods. Reads are synchronous and in-memory.

`ServerContext` requires one `AppliedModelPresetState`. `modelRequestCapacity` is removed. Model admission always reads capacity from the state object; it never branches on coordinator presence and never reads configuration or SQLite.

The runtime coordinator receives the same state object. It no longer owns a separate `activePreset` value or exposes a separate capacity getter. Its switch lifecycle is:

1. Read the current applied preset from `AppliedModelPresetState`.
2. Drain active work and pause new admission using the existing transition rules.
3. Start the target backend.
4. Update `AppliedModelPresetState` only after activation succeeds.
5. If activation fails and the previous backend is restored, retain or restore the previous applied preset in the same state object.

For coordinator-free servers, successful `PUT /config` persistence applies the normalized active preset directly to `AppliedModelPresetState`. Failed validation or persistence leaves the applied state unchanged.

Server construction initializes the state once from the normalized initial active preset, then injects it into the context and optional coordinator. Missing applied state fails at construction or typecheck; admission has no fallback capacity.

### Invariants

- Exactly one object owns the applied preset for the server lifetime.
- Admission capacity is always `AppliedModelPresetState.getPreset().ParallelSlots` or an equivalent explicit getter.
- Request release and FIFO granting perform no SQLite reads.
- Managed capacity changes only after a successful backend transition.
- Coordinator-free capacity changes only after a successful configuration update.
- Invalid or missing capacity never becomes unlimited and never falls back to a backend-specific default.

## Deterministic Queue Tests

The three `setTimeout(resolve, 20)` waits in `tests/model-request-queue.test.ts` are removed. Tests assert observable queue state immediately after the acquisition call has synchronously enqueued the waiter, then release capacity and await the queued acquisition to prove it resolves through the intended transition. No elapsed wall-clock delay proves a negative condition.

`DashboardModelQueueHarness` requires `parallelSlots` in its constructor options. Every construction site supplies the intended value explicitly, including callers whose intended value is one. Backend identity no longer implies test capacity.

## Cache RAM Zero Semantics

`CacheRam` and `CacheRecurrentRam` are MiB integer fields. Zero is valid and disables the corresponding CPU RAM allocation. Negative, fractional, non-finite, and non-numeric values remain invalid and fall back through the existing normalized defaults.

Normalization uses a shared non-negative-integer rule rather than the current positive-integer rule. The dashboard already parses and submits zero correctly; no UI conversion or compatibility behavior is added. The persisted values and response remain raw MiB integers, so saving zero rehydrates zero instead of `8192` or `4096`.

## Ten-Turn Activity Summaries

### Counting Semantics

The existing progress label `t{x}/{y}` is the agent turn number and configured maximum turn count. It is the only summary clock.

- Emit after completed turns whose `x` is divisible by 10.
- Summaries cover the completed window since the previous checkpoint: turns 1–10, 11–20, and so on.
- A `tool_batch` shares one turn number and therefore counts as one turn, regardless of how many tool actions it contains.
- Do not emit a partial summary when a run ends before the next multiple of 10.
- Emit at most one summary for each qualifying turn, including turns containing multiple tool actions.

### Collection and Classification

Add one shared, typed activity-summary component to the repo execution engine. The agent loop explicitly completes a turn through the reporter after tool results are available. The component records normalized, de-duplicated activity from typed tool actions and results; it does not ask an LLM to summarize and does not infer activity from prose.

The summary contains only non-empty categories:

- `Read files`: files observed through `read` and repository discovery tools, listed once.
- `Executed commands`: native `git` operations and `run` commands, preserving concise command text such as `git fetch`.
- `Edited files`: targets of successful `write` and `edit` operations, listed once.
- `Tests`: test commands recognized from successful or failed command execution, preserving the command or focused target.
- Any other supported operation category is named explicitly rather than silently folded into reads.

Failed actions are still activity and are marked failed. File lists are derived from validated tool arguments/results through runtime schemas; no type assertions, `any`, non-null assertions, namespace imports, or dynamically passed functions are introduced.

### Transport and Rendering

Introduce one runtime-schema-backed `activity_summary` progress event shared by `repo-search` and `repo-agent` because both use the same agent loop.

The status server forwards the event over the existing SSE progress channel. CLI clients render `activity_summary` to `stderr` unconditionally in both TTY and non-TTY execution, even when detailed per-operation progress is disabled. Existing detailed progress flag behavior remains unchanged for other events.

Final command output remains on `stdout`. In particular, `repo-agent` non-TTY mode still writes exactly one resumable-JSON boundary line to `stdout`; periodic summaries cannot corrupt parsers or pipelines.

Example rendering:

```text
Activity through turn 10/45:
1. Read 3 files:
   1. src/agent-loop/agent-loop.ts
   2. src/repo-search/engine/progress-reporter.ts
   3. tests/cli-progress-renderer.test.ts
2. Executed 1 command:
   1. git fetch
3. Edited 1 file:
   1. src/cli/progress-renderer.ts
4. Ran 1 test command:
   1. node --test dist/tests/cli-progress-renderer.test.js
```

## Testing Strategy

Implementation follows strict red-green-refactor TDD, preferring endpoint and command-level behavior.

### Applied State

- Coordinator-free `PUT /config` changes admission capacity through the shared applied state.
- A managed preset switch changes capacity only after successful activation.
- A failed switch retains the previous applied capacity.
- Admission and request release continue while SQLite is locked without reading SQLite.
- The old `modelRequestCapacity` field and coordinator capacity getter are absent from production and test fixtures.

### Queue Tests and Harness

- Capacity-one and capacity-two queue tests prove queued state and later resolution without real sleeps.
- Typecheck requires every `DashboardModelQueueHarness` caller to declare `parallelSlots`.
- Existing dashboard concurrency behavior remains unchanged with explicit values.

### RAM Normalization

- Zero is preserved for both cache RAM fields through normalization and `PUT /config` response behavior.
- Positive integers remain unchanged.
- Negative, fractional, non-finite, and non-numeric values use the configured defaults.

### Activity Summaries

- No summary is emitted through turn 9.
- One summary is emitted after turn 10 and contains activity from turns 1–10.
- Multiple actions in a turn do not create duplicate summaries.
- The next summary at turn 20 contains only turns 11–20.
- A run ending on a non-multiple emits no partial summary.
- Read, command, edit, test, failure, and de-duplication rendering are covered.
- Both `repo-search` and `repo-agent` endpoint streams carry the event.
- Non-TTY CLI tests prove summaries use `stderr` while `repo-agent` retains exactly one JSON line on `stdout`.

Focused tests run after each TDD cycle. Completion requires the full test suite, typecheck/lint, and branch-coverage validation to pass with no temporary investigation artifacts.

## Non-Goals

- Reading SQLite during admission or release.
- Changing queue ordering, timeout, cancellation, or nested-owner behavior.
- Changing backend process parallelism beyond consuming the applied preset.
- Converting other numeric settings to non-negative semantics.
- Summarizing model reasoning or answer text.
- Printing partial activity windows.
- Retaining old capacity fields, implicit test defaults, or duplicate progress implementations.

# Preset Model Routing and Resident-Model Queue Implementation Plan

> **For agentic workers:** Follow M1–M7 sequentially with TDD using `siftkit repo-agent` for defined implementation tasks, as now authorized. The primary agent owns review and validation. Do not create worktrees or commit.

**Goal:** Select models per operation preset, retain the selected model after execution, and prefer queued work that can use the resident model.

**Architecture:** Resolve model intent before admission and grant a frozen execution snapshot only after the runtime is ready. Reuse the runtime coordinator and one global request queue, replacing FIFO selection with resident-model preference. Remove downstream code that substitutes another model after admission.

**Tech stack:** TypeScript, Zod, SQLite, Node `node:test`, React, EXL3/Tabby.

**Spec:** [Shared design, sections A and B](../specs/2026-09-22-preset-model-routing-and-orchestration-design.md).

## Global constraints

- TypeScript throughout; parse IO with Zod and derive types with `z.infer`.
- No `any`, type assertions, non-null assertions, namespace imports, or schema-duplicating types.
- No worktrees; preserve unrelated changes.
- For this implementation session, the primary commits each independently verified task and starts every repo-agent dispatch from a clean Git working tree. Workers do not commit; controller artifacts stay in ignored scratch storage.
- Delegate review corrections and further implementation fixes to repo-agent with bounded findings and exact instructions. The primary owns review, independent validation, planning, and commits.
- Explicit versioned migrations; no runtime compatibility readers or silent invalid-reference fallback.
- Execute defined implementation tasks through `siftkit repo-agent` as newly requested; the primary agent owns planning, review, and validation. Follow the session's SiftKit-first discovery policy and wait for every invocation to finish.
- Existing chats inherit the current model at each operation, not their creation-time model.
- Queue affinity has no fairness override. Cancellation and ordinary timeouts still apply.

## Review focus

1. Same profile ID edited to another model while queued: validate its current loading identity, and freeze it at admission — M2/M3/M4.
2. Target model fails to load, or rollback fails: no execution on the wrong model and no stranded queue blocker — M3/M4.
3. New same-model work bypasses older other-model work continuously: preserve the explicitly requested policy — M4.
4. Old chat image/context settings or host cache overwrite the admitted target — M5.
5. Settings change during an automatic switch: preserve the newer save and the running request's snapshot — M3/M5.

## Test execution

Use the existing compiled test runner, not commands copied from older plans that refer to Vitest. Before each focused red/green run, rebuild with `npm run build:test`; then use `npm test -- <test-file-or-substring>`. A new test must fail for the missing behavior, not an unrelated compile/import error. Fix fixtures/schema conformance as part of their owning task.

The complete closeout gate appears in M7. Run no lifecycle tests against the user's live server.

## File ownership

| Area | Files |
|---|---|
| Contract/catalog | `packages/contracts/src/config.ts`, `src/preset-catalog.ts`, `src/config/normalization.ts` |
| Upgrade | New `src/state/schema-upgrades/preset-model-routing.ts`; `src/state/runtime-db.ts` |
| Resolution | New `src/status-server/model-request-context.ts` |
| Loading identity | `managed-inference-runtime.ts`, `managed-tabby.ts`, `preset-runtime-coordinator.ts`, `config-store.ts` under `src/status-server/` |
| Scheduling | New `src/status-server/model-request-selection.ts`; existing `server-ops.ts`, `server-types.ts`, `index.ts` |
| Request snapshots | CLI, repo-agent, chat, summary, passthrough, and provider boundaries named in M5 |
| Settings | Preset editor/action/controller files named in M6 |

### M1: Add a strict model reference and migrate stored operation presets

**Files**

- Modify `packages/contracts/src/config.ts`, `src/preset-catalog.ts`, `src/config/normalization.ts`, `src/config/getters.ts`.
- Create `src/state/schema-upgrades/preset-model-routing.ts`.
- Modify `src/state/runtime-db.ts`, `dashboard/src/settings-draft-editor.ts`.
- Test `tests/contracts-config.test.ts`, `tests/config-preset-http.test.ts`, `tests/preset-catalog.test.ts`, `tests/settings-draft-editor.test.ts`.
- Create `tests/runtime-db-schema-preset-model-routing.test.ts`.
- Update operation-preset literals identified by TypeScript, including `dashboard/tests/fixtures.ts`.

**Interfaces**

- `SiftPresetSchema.shape.modelPresetId = z.string().trim().min(1).nullable()`; required, without a runtime default.
- `upgradePresetModelRouting(database: RuntimeDatabase): void` upgrades stored schema 74 to 75.
- Full-config validation rejects duplicate model preset IDs, missing active IDs, and non-null operation references that do not exist.

- [x] **Write failing contract and HTTP tests.** Use the existing `completePreset()` fixture, adding the field to the fixture only after observing the new required-field test fail.

```typescript
test('operation model selection distinguishes current from an explicit model', () => {
  const source = completePreset();
  assert.equal(SiftPresetSchema.safeParse({ ...source, modelPresetId: null }).success, true);
  assert.equal(SiftPresetSchema.safeParse({ ...source, modelPresetId: 'coding-model' }).success, true);
  assert.equal(SiftPresetSchema.safeParse({ ...source, modelPresetId: '' }).success, false);
  const { modelPresetId, ...missing } = { ...source, modelPresetId: null };
  assert.equal(modelPresetId, null);
  assert.equal(SiftPresetSchema.safeParse(missing).success, false);
});

test('configuration rejects a dangling operation model reference', () => {
  const config = getDefaultConfigObject();
  const preset = config.Presets.find(entry => entry.id === 'repo-search');
  assert.ok(preset);
  const payload = {
    ...config,
    Presets: config.Presets.map(entry => entry.id === preset.id
      ? { ...entry, modelPresetId: 'deleted-model' } : entry),
  };
  assert.equal(SiftConfigSchema.safeParse(payload).success, false);
});
```

- [x] **Run red:** `npm run build:test`, then `npm test -- contracts-config.test.ts config-preset-http.test.ts`.
- [x] **Implement the schema/defaults/reference validation.** All five existing built-ins and newly created custom presets explicitly use `modelPresetId: null`. Keep the reference on the operation preset, not on `operationMode`.

```typescript
modelPresetId: z.string().trim().min(1).nullable(),
```

At the full-config schema's refinement, build a set from `Server.ModelPresets.Presets`; report a dangling reference at `['Presets', index, 'modelPresetId']`. Remove the active-ID fallback in normalization/getters where it would conceal a missing selection; issue a precise error instead. A label edit is legal; deleting a referenced model is rejected until its operation presets are reassigned.

- [x] **Write the database upgrade and its red/green tests.** Follow the transaction and schema-marker pattern in `tests/runtime-db-schema-inference-throughput.test.ts`. Create a version-74 row with built-in and custom operation presets, reopen through `getRuntimeDatabase`, and verify every record received only `modelPresetId: null`. Verify other config and historical run JSON remains byte-preserved. Malformed JSON/impossible historical record shapes must abort the upgrade.

```typescript
const StoredCatalogRowsSchema = z.array(z.object({
  id: z.number().int(),
  presets_json: z.string(),
}));
const HistoricCatalogSchema = z.array(JsonObjectSchema);

export function upgradePresetModelRouting(database: RuntimeDatabase): void {
  const rows = StoredCatalogRowsSchema.parse(
    database.prepare('SELECT id, presets_json FROM app_config').all(),
  );
  for (const row of rows) {
    const catalog = HistoricCatalogSchema.parse(parseJsonValueText(row.presets_json));
    const updated = catalog.map(preset => {
      z.string().trim().min(1).parse(preset.id);
      if (Object.hasOwn(preset, 'modelPresetId')) {
        throw new Error('Schema 74 operation preset already contains modelPresetId.');
      }
      return { ...preset, modelPresetId: null };
    });
    database.prepare('UPDATE app_config SET presets_json = ? WHERE id = ?')
      .run(JSON.stringify(updated), row.id);
  }
}
```

Imports are the existing `z`, `JsonObjectSchema`, `parseJsonValueText`, and `RuntimeDatabase`. The block illustrates the transformation only: before writing, validate the complete historical operation-preset layout through a version-pinned projection of the canonical field schemas, including historical enum values. Reject malformed required fields transactionally, not only malformed IDs. Keep this historical projection independent of future required fields such as O1's orchestrator options; it is a migration-only schema, never a runtime compatibility reader. Historical `run_logs.operation_preset_json` remains immutable evidence and is not rewritten as a current config record. Fixtures that rewind a newer database must also rewind its catalog fields to the actual historical shape.

- [x] **Run green:** `npm run build:test`, then `npm test -- contracts-config config-preset-http preset-catalog runtime-db-schema-preset-model-routing settings-draft-editor`.

**Acceptance:** Saving and reloading null/explicit choices works; invalid references fail through both schemas and HTTP; existing SQLite configs upgrade once without resetting presets. Account for any schema-version change made by concurrent work before assigning version 75.

### M2: Resolve one model target and execution configuration

**Files**

- Create `src/status-server/model-request-context.ts` and `tests/model-request-context.test.ts`.
- Modify `src/config/getters.ts` only where explicit missing-ID failure belongs.
- Create `tests/helpers/preset-routing-config.ts` for reusable, validated A/B/C fixtures.

**Interfaces**

```typescript
export const ModelRequestIntentSchema = z.object({
  presetId: z.string().trim().min(1).nullable(),
  model: z.string().trim().min(1).nullable(),
}).strict();
export type ModelRequestIntent = z.infer<typeof ModelRequestIntentSchema>;

export const ModelRequestContextSchema = z.object({
  operationPreset: SiftPresetSchema.nullable(),
  modelPreset: ModelRuntimePresetSchema,
  config: SiftConfigSchema,
}).strict();
export type ModelRequestContext = z.infer<typeof ModelRequestContextSchema>;
```

Produce `resolveModelRequestContext(config: SiftConfig, applied: ModelRuntimePreset, intent: ModelRequestIntent): ModelRequestContext`.

- [x] **Build the test fixture.** `createPresetRoutingConfig()` returns `getDefaultConfigObject()` with three copies of its validated model preset: IDs `model-a`, `model-b`, `model-c`, distinct `Model` and `ModelPath`, active `model-a`. Assign `repo-search` to B and `repo-agent` to C; keep chat/summary/plan null. Use existing test temporary model-directory utilities when runtime validation needs real paths.
- [x] **Write and run failing resolution tests.** Cover inherited A, explicitly selected B, current changing to C before admission, deleted operation/model IDs, and exact/ambiguous/unknown CLI model arguments.

```typescript
test('current-model resolution uses the applied selection at admission', () => {
  const config = createPresetRoutingConfig();
  const applied = config.Server.ModelPresets.Presets.find(preset => preset.id === 'model-c');
  assert.ok(applied);
  const resolved = resolveModelRequestContext(config, applied, { presetId: 'chat', model: null });
  assert.equal(resolved.modelPreset.id, 'model-c');
  assert.equal(getActiveModelPreset(resolved.config).id, 'model-c');
  assert.equal(config.Server.ModelPresets.ActivePresetId, 'model-a');
});
```

Run `npm run build:test`, then `npm test -- model-request-context`.

- [x] **Implement strict resolution and clone the snapshot.** Resolve the operation using `PresetCatalog.requireById`; use its reference when non-null, otherwise the supplied applied model. A CLI model equal to the chosen profile's `Model` retains that profile; a different override must match exactly one configured profile. Return a cloned config whose active ID and matching model entry are the resolved snapshot.

```typescript
const executionConfig = structuredClone(config);
const modelIndex = executionConfig.Server.ModelPresets.Presets
  .findIndex(candidate => candidate.id === modelPreset.id);
if (modelIndex < 0) throw new Error(`Model preset '${modelPreset.id}' does not exist.`);
executionConfig.Server.ModelPresets.Presets[modelIndex] = structuredClone(modelPreset);
executionConfig.Server.ModelPresets.ActivePresetId = modelPreset.id;
return ModelRequestContextSchema.parse({
  operationPreset,
  modelPreset: structuredClone(modelPreset),
  config: executionConfig,
});
```

`operationPreset` and `modelPreset` are the selections described above. Keep errors descriptive and do not mutate the caller's config. The residency key is supplied by the runtime in M3, not guessed from display text here.

- [x] **Run green and mutation tests.** Change saved config after resolution; assert the returned model, sampling/context settings, and operation preset remain unchanged. Run `npm run build:test`, then `npm test -- model-request-context config-normalization`.

**Acceptance:** Exactly one resolved model/config reaches execution; the resolver never switches a runtime or reads global state on its own.

### M3: Reuse residency and safely switch to a requested model

**Files**

- Modify `src/status-server/managed-inference-runtime.ts`, `managed-tabby.ts`, `preset-runtime-coordinator.ts`, `applied-model-preset-state.ts`, `config-store.ts`.
- Modify `src/inference-presets/exl3-preset-adapter.ts` only to expose reusable identity inputs already used for launch/load.
- Test `tests/preset-runtime-coordinator.test.ts`, `tests/managed-inference-runtime.test.ts`, `tests/model-preset-adapters.test.ts`.
- Update `tests/helpers/recording-inference-runtime.ts`.

**Interfaces**

- Runtime: `getPresetResidencyKey(preset: ModelRuntimePreset): string`.
- Coordinator: `ensureRequestPresetReady(target: ModelRuntimePreset): Promise<void>`; it accepts the frozen target, not an ID that it re-resolves midway through loading.
- Config store: `persistAppliedModelSelection(configPath: string, expected: SiftConfig, applied: ModelRuntimePreset): boolean`; returns false when a newer active-selection or target-profile edit prevents writeback.
- Both requested and administrative readiness share one transition implementation and blocker lifecycle.

- [x] **Write failing coordinator tests using `createCoordinator`/`disposeCoordinator`.** Verify sticky target selection, same-key no-op, same ID with a changed loading key, rollback behavior, and a save that lands while `ensurePresetReady` is blocked. Use the recording runtime for deterministic event assertions.

```typescript
test('an automatic request switch remains selected after readiness is checked again', async () => {
  const fixture = createCoordinator();
  try {
    await fixture.coordinator.initialize();
    const target = readConfig(fixture.configPath).Server.ModelPresets.Presets
      .find(preset => preset.id === 'exl3-alt');
    assert.ok(target);
    await fixture.coordinator.ensureRequestPresetReady(target);
    fixture.events.length = 0;
    await fixture.coordinator.ensureActivePresetReady();
    assert.equal(fixture.coordinator.getStatus().activePresetId, target.id);
    assert.equal(readConfig(fixture.configPath).Server.ModelPresets.ActivePresetId, target.id);
    assert.deepEqual(fixture.events, []);
  } finally {
    await disposeCoordinator(fixture);
  }
});
```

- [x] **Run red:** `npm run build:test`, then `npm test -- preset-runtime-coordinator`.
- [x] **Implement loading identity using the adapter.** Derive the key from normalized endpoint/backend/ownership, model request identity, the actual `buildLoadRequest`, and the actual managed `buildLaunchEnvironment`. Include engine launch configuration that affects process identity. For an external server, omit managed-only environment fields while retaining its load request and admission capacity. Do not include profile ID/label, sampler settings, or idle timers. Keep key construction and actual loading on the same normalized inputs.

```typescript
return JSON.stringify({
  backend: preset.Backend,
  baseUrl: getBaseUrl(preset),
  managed: this.shouldManage(preset),
  model: preset.Model,
  load: this.adapter.buildLoadRequest(preset),
  launch: this.shouldManage(preset) ? this.adapter.buildLaunchEnvironment(preset) : null,
  parallelSlots: preset.ParallelSlots,
});
```

The existing runtime also has engine/process launch settings: append the same normalized engine identity used when spawning; do not drop those settings from equality. Use a shared method if the current process signature must be expanded. Replace `residentPresetId` checks that reload equivalent profiles with the canonical key while retaining current profile metadata.

- [x] **Implement targeted readiness and conditional persistence.** If ready with the same key, update the applied profile/request settings without unloading. Otherwise require an empty active map, unload using the existing runtime, load target, then publish applied state. Wrap every transition with one `finally` that clears blockers. Preserve the actual managed Tabby behavior, which may stop its process on unload.

For persistence, open the existing config transaction, reread latest data, compare the latest active ID and target record with `expected`, and update only the intended selection when unchanged. Preserve unrelated edits. When a user saved a newer model intent, retain that pending intent; running work consumes its snapshot.

- [x] **Cover failure branches.** Missing target fails before unloading; load failure never executes the request; rollback restores the old physical model when possible; both failures release blockers; unchanged failed config intent can be rolled back, newer settings cannot. The coordinator completes irreversible transitions or rollback before releasing admission. Cancellation during that wait and suppression of execution are covered by M4 before granting its request lock.
- [x] **Run green:** `npm run build:test`, then `npm test -- preset-runtime-coordinator managed-inference-runtime model-preset-adapters model-residency-actions`.

**Acceptance:** Same residency requires zero lifecycle calls; a real change has exactly one ordered transition; subsequent inherited work uses the new selection; concurrent settings saves survive.

#### M3-C1: Correct the test runtime's capacity identity

- Scope: `tests/helpers/recording-inference-runtime.ts` only. Add `ParallelSlots` to `RecordingInferenceRuntime.getPresetResidencyKey`; admission capacity is already part of the production Tabby key. Keep profile metadata, samplers, and idle timers excluded. Make the short fixture comment accurate about its tested fields.
- Reproduce the current failures with `npm run build:test`, then `npm test -- model-request-queue`. The three failing cases are `preset switch pauses queued admission until the target preset is ready`, `switching to a single-slot preset drains all concurrent requests first`, and `preset switch arms idle for the preset that becomes active`: each incorrectly returns `ready` instead of `queued` because the fixture collapses the main/alt capacities into one residency.
- Preserve those queue assertions and their same-model/different-capacity fixtures. Do not change production behavior, weaken tests, or implement M4.
- Verify `npm test -- model-request-queue preset-runtime-coordinator managed-inference-runtime model-residency-actions`, then `npm run typecheck` (including lint). The primary independently runs broader validation.
- Acceptance: capacity changes require draining all active requests; the three regressions pass, equivalent-capacity reuse still passes, and the diff stays within the named helper.

### M4: Replace FIFO with resident-model scheduling

**Files**

- Create `src/status-server/model-request-selection.ts`, `tests/model-request-selection.test.ts`.
- Modify `src/status-server/server-ops.ts`, `server-types.ts`, `index.ts`, `src/lib/operation-stream.ts`.
- Test `tests/model-request-queue.test.ts`, `tests/model-request-queue-http.test.ts`.
- Update `tests/helpers/server-context-fixture.ts`, `tests/helpers/dashboard-model-queue-harness.ts`.

**Interfaces**

- Add optional `intent: ModelRequestIntent` to `ModelRequestWaitOptions`; omitted means `{ presetId: null, model: null }`, the real non-preset current-model behavior.
- Add `context: ModelRequestContext` and `residencyKey: string` to each granted `ModelRequestLock`.
- Queued entries retain intent, arrival time, timeout/cancellation state, and resolve/reject hooks. Failed resolution rejects that waiter; timeout/cancellation retains the existing null result.
- A single drain promise plus a requested-again flag in `ServerContext` owns asynchronous selection/transition/grant. No parallel scheduler or periodic polling.

- [x] **Write pure ordering tests first.** Derive candidate types from this small schema, then test the function against real scheduling cases.

```typescript
const CandidateSchema = z.object({ queueToken: z.string(), residencyKey: z.string() });
type Candidate = z.infer<typeof CandidateSchema>;

export function selectNextModelRequest(
  candidates: readonly Candidate[], residentKey: string, activeCount: number,
): string | null {
  const matching = candidates.find(candidate => candidate.residencyKey === residentKey);
  if (matching) return matching.queueToken;
  return activeCount === 0 ? candidates[0]?.queueToken ?? null : null;
}
```

```typescript
test('a later resident-model request overtakes an older different-model request', () => {
  const candidates = [
    { queueToken: 'b1', residencyKey: 'B' },
    { queueToken: 'a1', residencyKey: 'A' },
    { queueToken: 'c1', residencyKey: 'C' },
    { queueToken: 'a2', residencyKey: 'A' },
  ];
  assert.equal(selectNextModelRequest(candidates, 'A', 0), 'a1');
  assert.equal(selectNextModelRequest(candidates.filter(item => item.queueToken !== 'a1'), 'A', 0), 'a2');
  assert.equal(selectNextModelRequest([{ queueToken: 'b1', residencyKey: 'B' }], 'A', 1), null);
  assert.equal(selectNextModelRequest([{ queueToken: 'b1', residencyKey: 'B' }], 'A', 0), 'b1');
});
```

- [x] **Run red**, then implement the selector: `npm run build:test`, `npm test -- model-request-selection`.
- [x] **Add queue integration tests before changing the drain.** Use `PresetQueueHarness` and `BlockingQueueRuntime` already in `tests/model-request-queue.test.ts`. Assert A/B/A ordering by observed grants and lifecycle events, not sleep durations. Cover two active A requests draining before B, matching profiles with different samplers, target parallel-slot changes, and cancellation during selection/load.
- [x] **Replace the old grant/fast path.** All model acquisitions enter the same admission path; remove synchronous grant paths that bypass target resolution/readiness. Resolve candidates using M2 and compute keys using M3. A current-model candidate uses the currently applied snapshot. Reject invalid candidates individually. Choose with the pure selector, await readiness before installing any active lock, and grant only same-key work up to capacity.

Drain state transitions are:

```text
wake -> coalesce with current drain
     -> await existing administrative blocker
     -> resolve candidates / reject invalid candidates
     -> choose same-key candidate, or oldest after active drain
     -> freeze candidate; await requested readiness
     -> recheck cancellation; install lock with context/key
     -> repeat until capacity/no eligible candidate
     -> clear drain owner; rerun if a wake arrived during the pass
```

Cancellation after selection but before grant must remove the waiter and avoid engine execution. Release paths, config save notifications, and transition completion wake this drain. Keep idle unloading disabled while admissions/queued requests exist. Move target-switch errors through each endpoint's normal request error boundary rather than an unhandled rejection.

- [x] **Make affinity and timeout behavior explicit in tests.** Repeatedly add matching A work while B waits; B must never win merely due to age. A request using null follows A, including one enqueued before a previous switch. Preserve within-key arrival order. Existing timeout progression can reset on actual queue progress, but a model-affinity bypass alone cannot reset a waiter's deadline.
- [x] **Update queue diagnostics.** Expose requested operation/model identity, resolved target when known, resident key/profile, and waiting reason (`capacity`, `different_model`, `transition`). Keep `enqueuedAtUtc`/`waitMs`; describe the reported index as arrival order, not guaranteed service order. Add contract/renderer tests for the new fields. Public residency keys must be opaque SHA-256 fingerprints of the internal key: the internal key includes engine environment values and must never appear in responses or logs. Cover this boundary with a diagnostic regression assertion.
- [x] **Run green:** `npm run build:test`, then `npm test -- model-request-selection model-request-queue model-request-queue-http model-residency-actions routes-model-residency`.

**Acceptance:** The spec's ordering traces pass, active work is never unloaded, a transition is started once, and every granted lock has a matching ready runtime and immutable context.

### M5: Use admitted snapshots across every operation surface

**Files**

- Modify `src/status-server/routes/streamed-operation-endpoint.ts`, `routes/operations.ts`, `routes/repo-search.ts`, `preset-runner.ts`.
- Modify `src/status-server/repo-agent-lock-adapter.ts`, `repo-agent-sessions.ts`, `routes/repo-agent.ts`, `routes/chat-repo-agent.ts`.
- Modify `src/status-server/routes/chat.ts`, `routes/chat-session-operation-endpoint.ts`, `chat-repo-operation-runner.ts`, `chat.ts`, `chat-run-recorder.ts`, `chat-message-queue.ts`, `chat-queue-successor.ts`, `chat-session-response.ts`.
- Modify `src/status-server/routes/chat-image-caption.ts`, `routes/inference-passthrough.ts`, `routes/server-admin.ts` for admission/config interactions.
- Modify `src/repo-search/engine.ts`, `src/repo-search/execute.ts`, `src/repo-search/types.ts`, `src/summary/request-runner.ts`, `src/summary/types.ts`, `src/config/host-sync.ts`, `src/config/overrides.ts` only where late model replacement currently occurs.
- Test the route/engine files listed in the matrix below and `tests/run-log-backend-identity.test.ts`, `tests/chat-operation-preset.test.ts`, `tests/chat-repo-operation-runner.test.ts`.

**Interfaces**

- `StreamedOperationContext` exposes the granted `ModelRequestContext`.
- Each streamed endpoint resolves its operation preset ID before acquisition; summary uses `PresetCatalog.requireSummaryDefault()`.
- `RepoAgentModelLockHandle` exposes `context: ModelRequestContext`; `ServerModelLockAdapter` is constructed with the worker's `ModelRequestIntent`.
- A supplied execution context is authoritative in engine entry points. Internal already-admitted model calls reuse it rather than reacquiring locks.
- Remove the use of `resolveChatSessionConfig` as a historical-snapshot execution overlay. Replace its callers completely; keep historical session display explicit.

- [x] **Write cross-surface regression tests.** Use a recording engine/provider and a blocking runtime to inspect the exact `Model`, path/endpoint, token limits, sampling fields, and recorded profile ID handed to execution.

| Surface | Regression | Existing test owner |
|---|---|---|
| CLI summary/search/preset | Explicit operation model wins; null inherits after another operation switches | `tests/streamed-summary-endpoint.test.ts`, `tests/streamed-repo-search-endpoint.test.ts`, `tests/preset-runner.test.ts` |
| CLI repo-agent | Model selection reaches session-owned lock; approval continues same admitted model | `tests/streamed-repo-agent-endpoint.test.ts`, `tests/repo-agent-sessions.test.ts` |
| Existing chat | Session created on A executes next null-preset operation on B | `tests/dashboard-status-server.test.ts`, `tests/chat-operation-preset.test.ts` |
| Chat plan/search/agent | Resolve the actual selected/fallback operation before model admission | `tests/chat-repo-operation-runner.test.ts`, `tests/status-server-chat-repo-agent.test.ts` |
| Queue/force/condense | Each new operation resolves afresh; current in-flight operation stays frozen | `tests/chat-message-queue-http.test.ts`, `tests/chat-message-queue-force.test.ts` |
| Images | A has vision/B does not, and vice versa; apply B's limits for B-bound work | `tests/status-server-chat-operation-attach.test.ts`, `tests/runtime-image-capability.test.ts` |
| Override/host sync | Known override selects actual model; stale host config cannot replace admitted B | `tests/config-overrides.test.ts`, `tests/runtime-loadconfig.test.ts` |

For recording-engine tests, assert the relationship explicitly:

```typescript
const requestConfig = recordedRequest.config;
assert.ok(requestConfig);
assert.equal(getActiveModelPreset(requestConfig).id, admitted.context.modelPreset.id);
assert.equal(recordedRequest.modelPresetId, admitted.context.modelPreset.id);
assert.equal(recordedRequest.modelPreset?.NumCtx, admitted.context.modelPreset.NumCtx);
```

`recordedRequest` comes from the existing recording test engine; `admitted` is the granted model lock in that fixture. Assertions must check actual engine/provider input, not only config storage.

- [x] **Run each test red before changing its route.** Build tests, then select its test file from the matrix.
- [x] **Thread context through standalone routes first.** Put target parsing and acquisition inside the route's error boundary; make invalid reference/override errors 400 and lifecycle failures 503/SSE errors. Remove post-lock `ensureActivePresetReadyForModelRequest` calls after M4 guarantees readiness. `StatusPresetRunner` receives context/config instead of reading global config independently.

```typescript
const lock = await acquireModelRequestWithWait(ctx, lockKind, req, res, {
  intent: { presetId: selectedPreset.id, model: requestedModel },
  abortSignal,
});
if (!lock) return;
try {
  const result = await ctx.engineService.executeRepoSearch({
    ...engineRequest,
    config: lock.context.config,
    modelPresetId: lock.context.modelPreset.id,
    modelPreset: lock.context.modelPreset,
  });
  sendJson(res, 200, result);
} finally {
  releaseModelRequest(ctx, lock.token);
}
```

This is the shared ordering; preserve each endpoint's existing transport and terminal handling rather than replacing SSE with JSON. `selectedPreset`, `requestedModel`, `abortSignal`, and `engineRequest` are its parsed request values.

- [x] **Rebind chat operations at admission.** Select `ChatOperationPresetSelector` before queueing; after grant, set the run/session model metadata from `lock.context.modelPreset`. Start model-specific token/image calculations from that snapshot. Preserve durable submission IDs, stop signals, reload attachment, and the existing dirty chat recovery work.

Split image submission into schema/byte validation before queueing and model capability/budget checks when the target is resolved. Store original validated image data until target admission so creation-time downsizing cannot destroy information needed by the next model. Journal target-specific admission as run evidence; do not rewrite a submitted message silently. Revalidate queued image deliveries against the active run's snapshot.

- [x] **Remove late substitution and stale helpers.** An admitted config does not call host sync or reapply a `--model` string afterward. Non-admitted preview/remote-discovery paths remain explicitly separate. Validate a remote host's actual reported model; fail an unsupported explicit remote selection. Keep history/preview model data separate from the config used to execute the next turn.
- [x] **Test metadata and error paths.** Run logs capture actual operation/model IDs only after admission. Queued cancellation releases nothing it never acquired; stop during loading yields no engine call; a provided assistant-content path does not trigger an unnecessary model load. Confirm context-length changes cause the existing compaction/error policy rather than silent truncation.
- [x] **Run green:** `npm run build:test`, then all files in the regression matrix plus `npm test -- preset-execution run-log-backend-identity chat-session-recovery-cache status-server-chat-stop`.

**Acceptance:** CLI, Web, resumed workers, images, nested model calls, and logs all agree with the admitted target. Search for and remove obsolete session-model overlay/readiness call paths; no route bypasses the shared scheduler.

### M6: Expose model selection in settings and protect references

**Files**

- Modify `dashboard/src/tabs/settings/PresetsSection.tsx`, `settings-action-groups.ts`, `hooks/useSettingsController.ts`, `settings-draft-editor.ts`, `dashboard-presets.ts`, `model-runtime-presets.ts`, `tabs/settings/ModelPresetsSection.tsx`.
- Test `dashboard/tests/presets-section.test.tsx`, `tests/settings-draft-editor.test.ts`, `tests/dashboard-settings-controller.test.ts`, `tests/dashboard-presets.test.ts`.
- Modify `README.md` and preset/model settings documentation alongside the relevant current sections.

**Interfaces**

- Draft action: `{ type: 'set-preset-model'; presetId: string; value: string | null }`.
- Action method: `setModelPreset(presetId: string, value: string | null): void`.
- `hasSamePresetExecutionContext` includes `modelPresetId`, so changing a model is an execution-context change.

- [x] **Write failing editor/render/controller tests.** Verify default, choosing B, reset to current, save/reload, custom presets, and failed deletion of a referenced model.

```typescript
assert.match(markup, /Model preset/u);
assert.match(markup, /Current model/u);
assert.match(markup, /value="model-b"/u);
```

Use real change events in a component/controller test to prove it dispatches null for the empty selection and the exact profile ID otherwise; static markup alone is insufficient for persistence.

- [x] **Run red:** `npm run build:test`, then `npm test -- dashboard/tests/presets-section.test.tsx settings-draft-editor dashboard-settings-controller dashboard-presets.test.ts`.
- [x] **Add the control and typed action.**

```tsx
<SettingsField label="Model preset" layout="half">
  <select
    value={preset.modelPresetId ?? ''}
    onChange={event => presetActions.setModelPreset(
      preset.id, event.target.value === '' ? null : event.target.value,
    )}
  >
    <option value="">Current model</option>
    {dashboardConfig.Server.ModelPresets.Presets.map(model => (
      <option key={model.id} value={model.id}>{model.label}</option>
    ))}
  </select>
  <span className="fhint">Uses this model for the operation and keeps it selected afterward.</span>
</SettingsField>
```

Validate IDs against the draft model list in the editor. Block deleting referenced model presets and list the operation preset labels requiring reassignment; keep the server's full-config reference check authoritative. Saving an operation assignment alone must not load a model.

- [x] **Document behavior.** Describe current-at-admission semantics, sticky selection, existing-chat behavior, same-model queue preference with no fairness guarantee, strict CLI override matching, and retained idle unload policy.
- [x] **Run green:** focused tests above, then `npm run test:dashboard`.

**Acceptance:** All operation presets expose the selector; invalid references cannot be silently saved or produced through model deletion; changing the setting is separate from executing an operation.

### M7: Verify integrated routing and preserve the working tree

**Files**

- Create `tests/preset-model-routing.e2e.test.ts` using the existing isolated dashboard/runtime fixtures.
- Extend `tests/helpers/dashboard-model-queue-harness.ts` only as needed to install recording runtime targets.
- Update the shared design/README if verification exposes a necessary correction.

- [x] **Write an integrated failing scenario before its final route wiring.** Start A; enqueue B-search then A-summary while one A request is active; release it; assert A-summary precedes B-search. Finish B, issue a null-model operation from a chat created on A, and assert it executes on B without loading A.
- [x] **Assert actual lifecycle order.** Match the recording runtime's `unload`/`load` events and the provider inputs, not just response text. Test `B,A,C,A`, parallel A slots, same weights with distinct samplers, save-during-load, and failed target with a viable successor.

```typescript
assert.deepEqual(executedOperationIds, ['active-a', 'summary-a', 'search-b', 'existing-chat']);
assert.deepEqual(executedModelIds, ['model-a', 'model-a', 'model-b', 'model-b']);
assert.equal(loadEvents.filter(event => event === 'load:model-b').length, 1);
```

The arrays are captured by the recording test engine/runtime created for this scenario. Register cleanup with the test context before starting the server.

- [x] **Run focused and broader gates.**

```powershell
npm run build:test
npm test -- preset-model-routing model-request-queue preset-runtime-coordinator streamed- chat-operation chat-message-queue
npm test
npm run test:dashboard
npm run typecheck
npm run lint
```

- [x] **Review replacements and scope.** Search for old post-lock readiness calls, historical chat overlay execution, FIFO-only assertions, and raw model overlays at admitted boundaries. Remove unused artifacts created by this change. Preserve unrelated edits. Inspect diff whitespace and changed-file scope.
- [x] **Record verification evidence.** Report command results and any failures already present in the initial working tree. Live physical GPU switching remains unverified until a separate two-model smoke test is authorized/performed; recording-runtime tests prove ordering and config consistency.

**Acceptance:** M1–M6 tests and broader gates pass or pre-existing failures are explicitly isolated; the model routing contract is ready for the orchestrator's parent and worker phases.

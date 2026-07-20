# Cross-Backend Preset Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make EXL3-to-llama preset switches launch and stop the explicitly selected llama preset while preserving rollback state and keeping the status server alive on failure.

**Architecture:** Add explicit-preset entry points around the existing managed llama lifecycle and have `ManagedLlamaRuntime` retain the preset whose process it owns. Keep the coordinator's staged persistence model unchanged. Convert switch exceptions at the `/config` boundary into structured `503` responses.

**Tech Stack:** TypeScript 5.9, Node.js 24 test runner, Zod-derived contracts, HTTP integration fixtures, SQLite configuration store.

## Global Constraints

- Preserve the existing active preset until the target runtime reports ready.
- Do not add schema compatibility, shims, type assertions, `any`, or non-null assertions.
- Reuse the existing lifecycle, rollback, and structured error-response components.
- Validate with end-to-end tests before focused unit tests.

---

### Task 1: Explicit llama preset lifecycle

**Files:**
- Modify: `src/status-server/managed-llama.ts`
- Modify: `src/status-server/managed-llama-runtime.ts`
- Test: `tests/inference-passthrough-idle.test.ts`

**Interfaces:**
- Consumes: `ModelRuntimePreset`, `SiftConfig`, `ServerContext`.
- Produces: `ensureManagedLlamaPresetReady(ctx, preset, options)` and `shutdownManagedLlamaPresetIfNeeded(ctx, preset, options)`.

- [ ] **Step 1: Extend the existing cross-backend HTTP test to switch from llama to EXL3 and back**

Record `/v1/models` probe counts for both fake backends. After the existing queued llama-to-EXL3 switch completes, submit the same config with `ActivePresetId = llamaPreset.id`, assert HTTP `200`, assert the active runtime is llama, and assert the reverse switch probes the llama URL without probing Tabby again.

- [ ] **Step 2: Run the regression test and verify RED**

Run: `npx tsx --test --test-name-pattern "chat queued during a preset switch" tests/inference-passthrough-idle.test.ts`

Expected: FAIL because reverse switching probes the staged EXL3 URL instead of the target llama URL.

- [ ] **Step 3: Add explicit-preset lifecycle entry points**

In `managed-llama.ts`, add a typed helper that returns a `SiftConfig` with the supplied preset definition selected without writing it. Refactor the current startup and shutdown bodies into private config-driven functions. Keep the existing exports as persisted-config wrappers and add explicit-preset wrappers:

```ts
export async function ensureManagedLlamaPresetReady(
  ctx: ServerContext,
  preset: ModelRuntimePreset,
  options: EnsureManagedLlamaOptions = {},
): Promise<SiftConfig>

export async function shutdownManagedLlamaPresetIfNeeded(
  ctx: ServerContext,
  preset: ModelRuntimePreset,
  options: ShutdownManagedLlamaOptions = {},
): Promise<void>
```

All launch probes, arguments, cleanup ports, and runtime snapshots must use the selected in-memory configuration.

- [ ] **Step 4: Make `ManagedLlamaRuntime` own its explicit preset**

Store `currentPreset: ModelRuntimePreset | null`. Set it before startup, call `ensureManagedLlamaPresetReady`, use it during `stopProcess`, and clear it only after shutdown. Throw clearly if shutdown is requested for a runtime that has neither a current preset nor a stopped state.

- [ ] **Step 5: Run the regression test and verify GREEN**

Run: `npx tsx --test --test-name-pattern "chat queued during a preset switch" tests/inference-passthrough-idle.test.ts`

Expected: PASS with the reverse switch using only the llama target URL.

- [ ] **Step 6: Commit Task 1**

```powershell
git add -- src/status-server/managed-llama.ts src/status-server/managed-llama-runtime.ts tests/inference-passthrough-idle.test.ts
git commit -m "fix: launch explicit llama preset during switches"
```

### Task 2: Non-fatal switch failure response

**Files:**
- Modify: `src/status-server/routes/core.ts`
- Test: `tests/runtime-status-server.lifecycle.test.ts`

**Interfaces:**
- Consumes: `PresetRuntimeCoordinator.applyConfig`, `sendServerErrorJson`.
- Produces: HTTP `503` for a failed preset switch after coordinator rollback.

- [ ] **Step 1: Add a spawned-server failed-switch regression test**

Start a fake external Tabby server with an active EXL3 preset and an unreachable external llama target. Start the status server as a child process, stop Tabby after initialization, submit the llama preset through `PUT /config`, then assert:

```ts
assert.equal(update.status, 503);
assert.equal(readConfig(configPath).Server.ModelPresets.ActivePresetId, 'exl3-main');
assert.equal((await fetch(healthUrl)).status, 200);
```

- [ ] **Step 2: Run the regression test and verify RED**

Run: `npm run build:test; node --test --test-name-pattern "failed preset switch returns 503" dist/tests/runtime-status-server.lifecycle.test.js`

Expected: FAIL because the child status server exits or resets the connection.

- [ ] **Step 3: Catch switch errors at the config route**

Wrap only the coordinator application call and return through the existing structured response:

```ts
try {
  await ctx.presetRuntimeCoordinator.applyConfig(nextConfig);
} catch (error) {
  sendServerErrorJson(req, res, 503, error, { taskKind: 'summary' });
  return;
}
```

Do not change coordinator rollback behavior or persist the failed target.

- [ ] **Step 4: Run the regression test and verify GREEN**

Run: `npm run build:test; node --test --test-name-pattern "failed preset switch returns 503" dist/tests/runtime-status-server.lifecycle.test.js`

Expected: PASS; the child remains healthy after the response.

- [ ] **Step 5: Run focused lifecycle coverage**

Run: `npm run build:test; node --test dist/tests/preset-runtime-coordinator.test.js dist/tests/inference-passthrough-idle.test.js dist/tests/runtime-status-server.lifecycle.test.js`

Expected: all tests pass.

- [ ] **Step 6: Run repository validation**

Run: `npm run typecheck`

Run: `npm test`

Expected: both commands exit `0` with zero failures.

- [ ] **Step 7: Commit Task 2**

```powershell
git add -- src/status-server/routes/core.ts tests/runtime-status-server.lifecycle.test.ts
git commit -m "fix: contain preset switch failures"
```

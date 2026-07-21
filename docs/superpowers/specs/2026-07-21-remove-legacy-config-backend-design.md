# Remove legacy top-level `config.Backend` dual-axis

Date: 2026-07-21
Status: approved design, pending implementation plan

## Problem

Two independent `Backend` axes coexist:

| | Top-level `config.Backend` | Per-preset `Backend` |
|---|---|---|
| Schema | `z.string()` (`packages/contracts/src/config.ts:146`) | `z.enum(['llama','exl3'])` (`packages/contracts/src/config.ts:84`) |
| Production value | **always `'llama.cpp'`** (default + dead `ollama→llama.cpp` remap) | real engine selector |
| Test value | `'mock'` / `'noop'` | `'llama'` / `'exl3'` |
| Purpose | provider-identity constant **+ two smuggled test seams** | actual inference engine |

`config.Backend` is legacy. In production it is a constant, redundant with `preset.Backend==='llama'`. Its only live role is to smuggle **two unrelated test seams** through one production config field:

1. **Managed-llama lifecycle disable** — tests set `='noop'` so a real status server won't spawn llama.
2. **Summary mock-provider route** — tests set `='mock'` to reach the mock summary provider.

Conflating these two into one always-constant production field is the smell. This cleanup un-conflates them onto explicit, already-existing first-class mechanisms and deletes the field.

## Non-goal / confirmed non-bug

`config.Backend` being always `'llama.cpp'` does **not** hide an exl3 behavioral divergence. The two summary checks that looked backend-specific are actually generic-across-real-backends by design:

- Host-settings sync (`applyHostLlamaRuntimeSettings`) self-gates on `ExternalServerEnabled` (`src/config/host-sync.ts:30-31`), not on backend. It syncs generic terms (NumCtx, Reasoning, Model). Backend-agnostic.
- Chunking is shared by real backends; only `mock` cannot chunk.

So there is no exl3 fix folded in. Behavior is preserved exactly; only test-double routing moves to explicit seams.

## Design

### 1. Delete top-level `config.Backend`

- `packages/contracts/src/config.ts:146` — remove `Backend: z.string()` from the top-level config schema.
- `src/config/defaults.ts:77` — remove `Backend: 'llama.cpp'`.
- `src/config/normalization.ts:438-439` — remove the dead `ollama → llama.cpp` remap (ollama is gone).
- `src/status-server/config-store.ts:54,140,174` — remove the sqlite `backend` column: schema field, write, and read. Fail-loud; no migration shim (existing DBs recreate per repo convention).

### 2. Lifecycle gate collapses to one axis

`src/config/getters.ts:38-40`:

```ts
export function managesManagedLlamaLifecycle(config: SiftConfig): boolean {
  return getActiveInferenceBackend(config) === 'llama';
}
```

The `config.Backend === 'llama.cpp'` conjunct (always true in prod) is removed. The legacy-flag comment is deleted.

### 3. Lifecycle test-seam → existing `disableManagedLlamaStartup` flag

The ~5 tests that used `config.Backend='noop'` to keep a real status server from spawning llama switch to the purpose-built, already-existing flag:

- Production CLI arg `--disable-managed-llama-startup` (`src/status-server/index.ts:402`).
- `startStatusServer({ disableManagedLlamaStartup: true })` — already used by `tests/dashboard-status-server.run-logs.test.ts:183`.

Rejected alternatives:
- `ExternalServerEnabled:true` — **throws** on an unreachable URL (`src/status-server/managed-llama.ts:1170`), wrong for these quiet no-op tests.
- Active exl3 preset — introduces PresetRuntimeCoordinator side effects.

Affected tests (each passes `disableManagedLlamaStartup` through its real-server harness; verify no process spawns):
- `tests/runtime-status-server.lifecycle.test.ts` (4 sites)
- `tests/runtime-status-server.test.ts` (5 sites)
- `tests/execution-ownership.test.ts:19`

### 4. Summary provider axis → request-only mock seam

The summary pipeline's `backend: string` (`= request.backend || config.Backend`, i.e. `'llama.cpp'` prod / `'mock'` test) becomes a boundary enum, defaulting to the active engine, with `'mock'` reachable only via the request override — never a preset/config value:

- Boundary schema: `z.enum(['llama','exl3','mock'])` for the summary/eval request `backend` field and internal threading (type via `z.infer`). Mock exists only at this request boundary.
- Default when no override: `getActiveInferenceBackend(config)`.

Behavioral rewrites (the `backend` value's only real role is the mock switch):

- `src/summary/request-runner.ts:198` — delete the `if (backend === 'llama.cpp')` guard; call `applyHostLlamaSettings` unconditionally (it self-gates on `ExternalServerEnabled`). Backend removed from that decision.
- `src/summary/request-runner.ts:77-79` (`isOversizedNonLlamaInput`, `!== 'llama.cpp'`) — becomes `backend === 'mock'` only; rename to reflect "mock cannot chunk."
- `src/summary/provider-invoke.ts:96` (`=== 'mock'`) — unchanged; now sourced only from the request override.

Net: no `'llama'`/`'exl3'` branching anywhere in the summary path; the axis reduces to real-vs-mock.

### 5. Label sites source from the active engine

Everywhere `config.Backend` was carried as a reporting label, read `getActiveInferenceBackend(config)` instead:

- `src/status-server/eval.ts:72` — `request.Backend || getActiveInferenceBackend(config)`.
- `src/command-output/analyzer.ts:114` — `request.backend || getActiveInferenceBackend(config)`.
- `src/install.ts:102`, `src/cli/run-test.ts:70` — DTO `Backend` label from active engine.
- Hardcoded `'llama.cpp'` label fills: `src/repo-search/planner-protocol.ts:386`, `src/status-server/routes/core.ts:133,178`, `src/status-server/dashboard-runs/artifact-upserts.ts:326` — source from active engine (or request backend where one exists).
- Behavioral `config.Backend === 'llama.cpp'` probes in `src/cli/run-test.ts:38,46` and `src/install.ts:87` — these gate the llama provider probe. Replace with `getActiveInferenceBackend(config) === 'llama'` (probe only when the active engine is managed-llama).

Output DTO schemas `Backend: z.string()` (`src/eval-types.ts:31`, `src/summary/types.ts:53`) stay string labels; values now come from the active engine.

## Behavior preservation

Every production path resolved `config.Backend` to `'llama.cpp'`. Each rewrite keeps production identical:
- Lifecycle gate: prod active engine is `'llama'` → still true; exl3 → still false (unchanged).
- Summary: prod never hit the mock route and never rejected oversized input → still true after the mock-only rewrite; host-settings still self-gate on `ExternalServerEnabled`.
- Labels: value string changes from `'llama.cpp'` to `'llama'`/`'exl3'`, which is strictly more accurate; no logic branches on the label.

## Testing (TDD)

Each numbered change lands test-first. The 4 uncommitted test files are updated to the new seams:
- `tests/managed-llama-lifecycle-gate.test.ts` — drop the `config.Backend='noop'` case (that scenario no longer exists); assert the gate = active-engine-is-llama.
- `tests/managed-llama-config-backend-guard.test.ts` — retarget to guard the new invariant (no top-level `Backend`; seam is `disableManagedLlamaStartup`).
- `tests/managed-llama-exl3-shared-port.test.ts`, `tests/managed-llama-process-exit-sync-guard.test.ts` — update `config.Backend='llama.cpp'` setup (now implied by an active llama preset).

Full suite must pass with production behavior unchanged; new/updated tests assert the two seams are explicit and independent.

## Consumer inventory (removal checklist)

Behavioral: `getters.ts:39`, `provider-invoke.ts:96`, `request-runner.ts:77/198`, `run-test.ts:38/46`, `install.ts:87`.
Label: `eval.ts:72`, `analyzer.ts:114`, `install.ts:102`, `run-test.ts:70`, `planner-protocol.ts:386`, `core.ts:133/178`, `artifact-upserts.ts:326`.
Persistence: `config-store.ts:54/140/174`.
Schema/default/normalize: `contracts/config.ts:146`, `defaults.ts:77`, `normalization.ts:438-439`.
Test seams migrated: `runtime-status-server.lifecycle.test.ts`, `runtime-status-server.test.ts`, `execution-ownership.test.ts`, `summary-status-server.test.ts:772` (`='mock'` → request override), plus the 4 uncommitted managed-llama tests.

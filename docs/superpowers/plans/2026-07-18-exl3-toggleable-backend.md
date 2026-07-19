# EXL3 Toggleable Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add TabbyAPI/ExLlamaV3 1.1.0 as a first-class managed SiftKit backend with persisted UI/API/CLI selection, drain-before-switch behavior, rollback, and verified operation on the RTX 4090.

**Architecture:** Extend SiftKit with two explicit backend profiles behind a narrow runtime contract. The status server owns a switch coordinator that gates the existing serialized model-request queue, while one normalized inference client maps backend-specific request fields. TabbyAPI remains authoritative for EXL3 loading settings in `config.yml`.

**Tech Stack:** TypeScript 5.9, Node.js 24, Zod 4, React 19, native Node test runner, Windows child processes, Python 3.10.11, TabbyAPI, ExLlamaV3 1.1.0, Torch 2.9.0+cu128.

## Global Constraints

- Use `C:\Users\denys\Documents\GitHub\TabbyAPI` for the TabbyAPI checkout.
- Use `C:\envs\rl310\Scripts\python.exe` directly; do not create a Tabby virtual environment.
- Use ExLlamaV3 `1.1.0` and the matching CPython 3.10 Windows/Torch 2.9.0/CUDA 12.8 wheel.
- Load the existing checkpoint from `D:\personal\models\elx3\3.6_27B`; do not download another model.
- The existing checkpoint is a 4.00-bit `mul1` EXL3 quant with one MTP layer and internal architecture `Qwen3_5ForConditionalGeneration`.
- Use built-in MTP, `max_batch_size: 1`, explicit `vision: false`, no mmproj/vision-tower loading, and initial `84992`/`8,8` KV configuration.
- Never load managed llama.cpp and TabbyAPI concurrently.
- Preserve current llama.cpp launch, logs, metrics, idle sleep, request behavior, and tests.
- Do not add a proxy, dynamic provider registry, DFlash, vision, model conversion, or unmeasured persistent-cache claim.
- Follow strict TDD: every behavior test must be observed failing before its production implementation is added.
- Keep all new TypeScript schema-derived and inference-safe; no `any`, casts, non-null assertions, or namespace imports.

---

### Task 1: Typed Backend Configuration and Contracts

**Files:**
- Modify: `packages/contracts/src/config.ts`
- Modify: `packages/contracts/src/system.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `src/config/types.ts`
- Modify: `src/config/defaults.ts`
- Modify: `src/config/normalization.ts`
- Modify: `src/config/getters.ts`
- Modify: `src/config/index.ts`
- Test: `tests/contracts-config.test.ts`
- Test: `tests/config-normalization.test.ts`
- Test: `tests/config-schema-contract.test.ts`

**Interfaces:**
- Produces: `InferenceBackendIdSchema`, `InferenceRuntimeStateSchema`, `Exl3ProfileSchema`, `InferenceConfigSchema`, `BackendRuntimeStatusSchema`, and their `z.infer` types.
- Produces: `getSelectedBackend(config)`, `getLlamaProfile(config)`, and `getExl3Profile(config)`.

- [ ] **Step 1: Write failing contract tests**

Add tests that parse a complete config containing:

```ts
Inference: {
  SelectedBackend: 'exl3',
  Thinking: { Enabled: true, Preserve: true },
},
Server: {
  LlamaCpp: existingLlamaConfig,
  Exl3: {
    Managed: true,
    BaseUrl: 'http://127.0.0.1:8098',
    WorkingDirectory: 'C:\\Users\\denys\\Documents\\GitHub\\TabbyAPI',
    PythonPath: 'C:\\envs\\rl310\\Scripts\\python.exe',
    Entrypoint: 'main.py',
    ConfigPath: 'config.yml',
    ModelId: '3.6_27B',
    StartupTimeoutMs: 600_000,
    HealthcheckTimeoutMs: 2_000,
    HealthcheckIntervalMs: 1_000,
    ShutdownTimeoutMs: 30_000,
  },
}
```

Assert invalid backend IDs and missing selected-profile fields fail schema parsing. Assert normalization supplies the default `llama` selection and the exact deployment defaults above.

- [ ] **Step 2: Run the targeted tests and verify RED**

Run:

```powershell
npm run build:test
node .\dist\scripts\run-tests.js tests/contracts-config.test.ts tests/config-normalization.test.ts tests/config-schema-contract.test.ts
```

Expected: failures because inference and EXL3 schemas/config fields do not exist.

- [ ] **Step 3: Add the minimal schemas, inferred types, defaults, normalization, and getters**

Use literal Zod enums and inferred types. Keep existing `Server.LlamaCpp` intact and add `Server.Exl3`; do not migrate the full llama preset hierarchy in this task.

- [ ] **Step 4: Run targeted tests and verify GREEN**

Run the Step 2 command. Expected: all targeted tests pass.

- [ ] **Step 5: Run configuration coverage and commit**

Run `npm run typecheck:test` and commit:

```powershell
git add packages/contracts/src/config.ts packages/contracts/src/system.ts packages/contracts/src/index.ts src/config tests/contracts-config.test.ts tests/config-normalization.test.ts tests/config-schema-contract.test.ts
git commit -m "feat: add typed inference backend profiles"
```

### Task 2: Backend-Neutral Request Adapter

**Files:**
- Create: `src/llm-protocol/inference-backend.ts`
- Create: `src/llm-protocol/inference-request-builder.ts`
- Modify: `src/llm-protocol/types.ts`
- Modify: `src/llm-protocol/llama-cpp-client.ts`
- Modify: `src/providers/llama-cpp.ts`
- Test: `tests/inference-request-builder.test.ts`
- Test: `tests/llama-cpp-client.test.ts`
- Test: `tests/reasoning-history.test.ts`

**Interfaces:**
- Produces: `InferenceRequestBuilder.build(input): OpenAiChatRequest`.
- Consumes: `InferenceBackendId`, active profile, normalized messages, tools, structured output, and thinking policy.
- Preserves: normalized `text`, `reasoningText`, tool calls, usage, streaming deltas, and cancellation.

- [ ] **Step 1: Write failing request-mapping tests**

Assert the llama request includes `cache_prompt`, optional `id_slot`, and `timings_per_token` only when streaming. Assert the EXL3 request omits those fields and includes:

```ts
chat_template_kwargs: {
  enable_thinking: true,
  preserve_thinking: true,
}
```

Assert both paths retain assistant `reasoning_content` separately from visible content and forward tools and `response_format` unchanged.

- [ ] **Step 2: Verify RED with the targeted protocol tests**

Run:

```powershell
npm run build:test
node .\dist\scripts\run-tests.js tests/inference-request-builder.test.ts tests/llama-cpp-client.test.ts tests/reasoning-history.test.ts
```

Expected: missing builder/backend types.

- [ ] **Step 3: Implement one explicit request-builder class**

Move request-body construction out of `LlamaCppClient` without changing normalized response parsing. Use explicit `buildLlamaRequest` and `buildExl3Request` private methods; do not pass functions dynamically.

- [ ] **Step 4: Verify GREEN and existing protocol behavior**

Run the Step 2 command and `npm run test:coverage:llm`. Expected: passing tests and no coverage regression.

- [ ] **Step 5: Commit**

```powershell
git add src/llm-protocol src/providers/llama-cpp.ts tests/inference-request-builder.test.ts tests/llama-cpp-client.test.ts tests/reasoning-history.test.ts
git commit -m "refactor: centralize inference request mapping"
```

### Task 3: Managed Runtime Contract and Llama Adapter

**Files:**
- Create: `src/status-server/managed-inference-runtime.ts`
- Create: `src/status-server/managed-llama-runtime.ts`
- Modify: `src/status-server/server-types.ts`
- Modify: `src/status-server/index.ts`
- Modify: `src/status-server/managed-llama.ts`
- Test: `tests/managed-inference-runtime.test.ts`
- Test: `tests/runtime-status-server.lifecycle.test.ts`
- Test: `tests/runtime-status-server.test.ts`

**Interfaces:**
- Produces: `ManagedInferenceRuntime` and `ManagedLlamaRuntime`.
- `ManagedLlamaRuntime` delegates to existing start/readiness/shutdown functions and reports typed runtime state.

- [ ] **Step 1: Write failing adapter tests**

Test `id`, state transitions, base URL, model ID, capabilities, readiness delegation, and shutdown delegation using the existing fake llama process fixtures.

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm run build:test
node .\dist\scripts\run-tests.js tests/managed-inference-runtime.test.ts tests/runtime-status-server.lifecycle.test.ts tests/runtime-status-server.test.ts
```

Expected: missing runtime contract and adapter.

- [ ] **Step 3: Implement the minimal contract and llama adapter**

Keep llama-specific logs and metrics typed as llama concerns. Replace only lifecycle state in `ServerContext` with the runtime object where tests prove equivalence.

- [ ] **Step 4: Verify GREEN and commit**

Run the Step 2 command, then commit:

```powershell
git add src/status-server/managed-inference-runtime.ts src/status-server/managed-llama-runtime.ts src/status-server/server-types.ts src/status-server/index.ts src/status-server/managed-llama.ts tests/managed-inference-runtime.test.ts tests/runtime-status-server.lifecycle.test.ts tests/runtime-status-server.test.ts
git commit -m "refactor: adapt managed llama to runtime contract"
```

### Task 4: Managed TabbyAPI Runtime

**Files:**
- Create: `src/status-server/managed-tabby.ts`
- Modify: `src/status-server/paths.ts`
- Modify: `src/status-server/server-types.ts`
- Test: `tests/managed-tabby.test.ts`
- Create: `tests/helpers/managed-tabby-fixtures.ts`

**Interfaces:**
- Produces: `ManagedTabbyRuntime implements ManagedInferenceRuntime`.
- Consumes: typed EXL3 profile and existing HTTP/process-tree utilities.

- [ ] **Step 1: Write failing fake-process tests**

Cover command/cwd construction, stdout/stderr capture, expected-model readiness, wrong-model rejection, startup timeout, unexpected exit, shutdown timeout, process-tree termination, and port release. Use a fake Node child server; do not require Python or GPU.

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm run build:test
node .\dist\scripts\run-tests.js tests/managed-tabby.test.ts
```

Expected: missing Tabby runtime.

- [ ] **Step 3: Implement managed Tabby lifecycle**

Launch the configured executable with explicit arguments `[entrypoint]`, `shell: false`, and configured cwd. Store runtime logs below `.siftkit/logs/managed-tabby`. Probe `/v1/models` until the expected model is present.

- [ ] **Step 4: Verify GREEN and commit**

Run the Step 2 command, then commit:

```powershell
git add src/status-server/managed-tabby.ts src/status-server/paths.ts src/status-server/server-types.ts tests/managed-tabby.test.ts tests/helpers/managed-tabby-fixtures.ts
git commit -m "feat: manage TabbyAPI runtime"
```

### Task 5: Drain-Then-Switch Coordinator and Queue Gate

**Files:**
- Create: `src/status-server/backend-switch-coordinator.ts`
- Modify: `src/status-server/server-types.ts`
- Modify: `src/status-server/server-ops.ts`
- Modify: `src/status-server/index.ts`
- Test: `tests/backend-switch-coordinator.test.ts`
- Test: `tests/summary-status-server.test.ts`

**Interfaces:**
- Produces: `BackendSwitchCoordinator.select(backend)`, `.getStatus()`, `.waitForBackend(backend)`, `.onModelRequestReleased()`.
- Produces status fields `active`, `selected`, `pending`, `state`, `model`, `error`, and `rollback`.
- Consumes two explicit runtime instances and config persistence.

- [ ] **Step 1: Write failing state-machine tests**

Cover immediate idle switch, active-request drain, queued-request pause/resume, duplicate selection, pending replacement during drain, rejection after stopping begins, target failure with successful rollback, rollback failure, and restart selection.

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm run build:test
node .\dist\scripts\run-tests.js tests/backend-switch-coordinator.test.ts tests/summary-status-server.test.ts
```

Expected: coordinator and queue gate missing.

- [ ] **Step 3: Implement coordinator and queue gate**

Add one explicit `canGrantModelRequest()` check in both immediate acquisition and queued grant. On release, notify the coordinator before granting another request. Refresh waiter timeout accounting while a healthy transition is active.

- [ ] **Step 4: Verify GREEN and commit**

Run the Step 2 command, then commit:

```powershell
git add src/status-server/backend-switch-coordinator.ts src/status-server/server-types.ts src/status-server/server-ops.ts src/status-server/index.ts tests/backend-switch-coordinator.test.ts tests/summary-status-server.test.ts
git commit -m "feat: drain requests before backend switches"
```

### Task 6: Runtime API and Public CLI

**Files:**
- Modify: `packages/contracts/src/system.ts`
- Modify: `src/status-server/routes/core.ts`
- Modify: `src/cli/args.ts`
- Modify: `src/cli/dispatch.ts`
- Modify: `src/cli/help.ts`
- Modify: `src/cli/status-server-api-client.ts`
- Create: `src/cli/run-backend.ts`
- Test: `tests/runtime-backend-api.test.ts`
- Test: `tests/cli-command-surface.test.ts`
- Test: `tests/cli-help.test.ts`
- Test: `tests/cli-http-boundary.test.ts`

**Interfaces:**
- API: `GET /runtime/backend`, `PUT /runtime/backend` with `{ backend: 'llama' | 'exl3', wait?: boolean }`.
- CLI: `backend status`, `backend use <id>`, and optional `--wait`.

- [ ] **Step 1: Write failing API and CLI tests**

Assert runtime status schema, idempotent response, queued response, waited success, waited failure, invalid backend, help output, and non-zero failure exit.

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm run build:test
node .\dist\scripts\run-tests.js tests/runtime-backend-api.test.ts tests/cli-command-surface.test.ts tests/cli-help.test.ts tests/cli-http-boundary.test.ts
```

Expected: routes and command missing.

- [ ] **Step 3: Implement API and CLI**

Validate all request and response bodies with shared Zod schemas. Implement polling/waiting in the status server coordinator, not with CLI-side process knowledge.

- [ ] **Step 4: Verify GREEN and commit**

Run the Step 2 command, then commit:

```powershell
git add packages/contracts/src/system.ts src/status-server/routes/core.ts src/cli tests/runtime-backend-api.test.ts tests/cli-command-surface.test.ts tests/cli-help.test.ts tests/cli-http-boundary.test.ts
git commit -m "feat: expose backend selection API and CLI"
```

### Task 7: Dashboard Backend Selector and Status

**Files:**
- Modify: `dashboard/src/api.ts`
- Modify: `dashboard/src/types.ts`
- Modify: `dashboard/src/hooks/useSettingsController.ts`
- Modify: `dashboard/src/tabs/SettingsTab.tsx`
- Create: `dashboard/src/tabs/settings/InferenceBackendSection.tsx`
- Modify: `dashboard/src/styles/settings.css`
- Test: `dashboard/tests/tab-components.test.tsx`
- Test: `dashboard/tests/api-stream.test.ts`

**Interfaces:**
- Consumes shared backend status/update schemas.
- Produces a compact selector plus active/selected/pending/state/model/error rendering.

- [ ] **Step 1: Write failing component and API tests**

Render ready, draining, starting, rollback-success, and failed states. Assert selection calls `PUT /runtime/backend`, disables unsafe reselection during stopping/starting, and displays actionable errors.

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm run typecheck:dashboard-test
node .\node_modules\tsx\dist\cli.mjs --test dashboard/tests/tab-components.test.tsx dashboard/tests/api-stream.test.ts
```

Expected: missing component/API methods.

- [ ] **Step 3: Implement the compact settings section**

Reuse current settings section, field, toast, and refresh patterns. Do not add another page or duplicate runtime configuration editors.

- [ ] **Step 4: Verify GREEN, build dashboard, and commit**

Run the Step 2 command and `npm --prefix .\dashboard run build`, then commit:

```powershell
git add dashboard/src dashboard/tests/tab-components.test.tsx dashboard/tests/api-stream.test.ts
git commit -m "feat: add inference backend selector"
```

### Task 8: Automated Integration and Coverage Closure

**Files:**
- Modify: `tests/runtime-status-server.lifecycle.test.ts`
- Modify: `tests/runtime-status-server.test.ts`
- Modify: `tests/runtime-cli.test.ts`
- Modify: `tests/server-boundary-dict-contract.test.ts`
- Modify: additional focused tests identified by coverage output

**Interfaces:**
- Verifies all preceding public contracts together.

- [ ] **Step 1: Add failing end-to-end fake-runtime scenarios**

Exercise status-server startup with persisted EXL3, live llama-to-EXL3 switch with an active task, EXL3-to-llama switch, rollback, server shutdown during transition, and no overlapping child processes.

- [ ] **Step 2: Verify RED, add minimal integration corrections, and verify GREEN**

Run focused tests through `node .\dist\scripts\run-tests.js` after `npm run build:test`. Every correction requires its failing regression test first.

- [ ] **Step 3: Run full automated verification**

Run:

```powershell
npm test
npm run typecheck
npm run test:coverage
npm run build
```

Expected: all commands pass; branch coverage is as close to 100% as practical for new runtime/coordinator/request code.

- [ ] **Step 4: Commit coverage corrections**

```powershell
git add src packages dashboard tests
git commit -m "test: cover toggleable inference backends"
```

### Task 9: Install and Configure TabbyAPI

**Files:**
- External checkout: `C:\Users\denys\Documents\GitHub\TabbyAPI`
- Create: `C:\Users\denys\Documents\GitHub\TabbyAPI\config.yml`
- Modify: `C:\Users\denys\Documents\GitHub\TabbyAPI\pyproject.toml` only if the pinned upstream commit does not already specify ExLlamaV3 1.1.0.

**Interfaces:**
- Produces standalone OpenAI-compatible TabbyAPI at `http://127.0.0.1:8098/v1` using the existing local checkpoint.

- [ ] **Step 1: Clone TabbyAPI and record its commit**

Clone current main to the exact target directory and verify `pyproject.toml` references ExLlamaV3 `1.1.0` CPython 3.10 Windows wheels.

- [ ] **Step 2: Install matching dependencies into `rl310`**

Use `C:\envs\rl310\Scripts\python.exe`. Verify that the installed Torch becomes `2.9.0+cu128` and ExLlamaV3 becomes `1.1.0`; stop on resolver conflicts rather than forcing incompatible packages.

- [ ] **Step 3: Validate the existing model**

Verify `D:\personal\models\elx3\3.6_27B` contains the complete indexed safetensor set, tokenizer/template files, 4.00-bit `mul1` quantization metadata, and one MTP layer. Configure `model_dir: D:\personal\models\elx3` and `model_name: 3.6_27B`. Do not download or copy another checkpoint.

- [ ] **Step 4: Create the initial configuration**

Configure localhost port `8098`, OAI API, EXL3 backend, `max_seq_len: 84992`, `cache_size: 84992`, `cache_mode: 8,8`, `chunk_size: 2048`, output chunking, batch size 1, explicit `vision: false`, reasoning on, and MTP draft mode with three draft tokens. Verify logs do not show an mmproj or vision tower being loaded.

- [ ] **Step 5: Verify standalone startup**

Start `C:\envs\rl310\Scripts\python.exe main.py` from the Tabby directory. Verify `/v1/models`, one non-streaming chat, one streaming chat, and startup logs showing the expected model and MTP with no vision/mmproj load.

### Task 10: Real-Machine Acceptance and Operations Documentation

**Files:**
- Create: `docs/exl3-backend-setup.md`
- Create: `docs/exl3-backend-validation.md`
- Modify: `README.md`
- Modify: `docs/configuration.md` if present; otherwise document configuration in `docs/exl3-backend-setup.md`.

**Interfaces:**
- Produces reproducible setup identity, validation evidence, and rollback instructions.

- [ ] **Step 1: Configure SiftKit's EXL3 profile through the public API/CLI**

Persist the exact Tabby path, `rl310` interpreter, entrypoint, model ID, and base URL without hardcoding them in TypeScript.

- [ ] **Step 2: Run live switch acceptance**

Run a representative llama task, request EXL3 during the active task, verify drain and queue behavior, verify llama VRAM/process release before Tabby starts, run EXL3 chat/tool/structured/stream/cancel/reasoning cases, restart SiftKit, and switch back to llama.

- [ ] **Step 3: Measure performance and prefix reuse**

Record cold load, prefill, first token, generation rate, peak/steady VRAM, MTP on/off, and repeated 32K+ prefix timings warm, changed-near-start, and after restart. Classify reusable-prefix behavior from evidence.

- [ ] **Step 4: Write exact operational documentation**

Include Tabby commit, ExLlamaV3/Python/Torch/CUDA versions, local model identity/directory, config path, launch command, load identity, proof that vision/mmproj was not loaded, measured results, known limitations, and rollback procedure.

- [ ] **Step 5: Run final verification and commit documentation**

Run `npm test`, `npm run typecheck`, `npm run build`, and a final live backend status/switch smoke test. Commit:

```powershell
git add README.md docs/exl3-backend-setup.md docs/exl3-backend-validation.md docs/configuration.md
git commit -m "docs: record EXL3 setup and validation"
```

## Completion Review

- [ ] Confirm every acceptance criterion in the design has test or recorded live evidence.
- [ ] Confirm no managed llama and Tabby processes overlapped.
- [ ] Confirm all new source paths are typed and contain no casts, `any`, non-null assertions, namespace imports, or dynamic function dispatch.
- [ ] Confirm temporary test files are removed.
- [ ] Confirm the pre-existing untracked plan file remains untouched.
- [ ] Invoke `superpowers:verification-before-completion`, then `superpowers:finishing-a-development-branch`.

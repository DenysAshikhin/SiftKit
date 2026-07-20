# EXL3 Runtime Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve native EXL3 request features, authenticate every Tabby lifecycle operation, and make a validated EXL3 preset the only entry point that can start the Tabby runtime.

**Architecture:** A small typed request-compatibility module becomes the single production policy source for backend parameter names and unsupported fields. `TabbyModelClient` owns authenticated lifecycle HTTP, while `ManagedTabbyRuntime` is constructed without a preset and starts only from `ensurePresetReady` after backend validation.

**Tech Stack:** TypeScript 5.9, Zod 4, Node.js test runner, Node HTTP test servers, c8 branch coverage.

## Global Constraints

- Do not use `siftkit` while the user has the status server stopped.
- Follow red-green-refactor: run every new behavioral test and observe the expected failure before editing production code.
- Keep `tools` and `response_format` native for both backends; retain existing Qwen `<tool_call>` parsing.
- Store one `AdminApiKey` under `Server.Engines.Exl3`; never promote caller authorization to lifecycle authorization.
- Do not add compatibility shims, model-name detection, casts, `any`, non-null assertions, namespace imports, or dynamically passed functions.
- Preserve the user-owned untracked `docs/superpowers/plans/2026-06-26-f15-repackage-eval-benchmark-dedupe-bench.md`.
- Do not use a worktree.

---

## File Structure

- Create `src/inference-presets/request-compatibility.ts`: typed backend request policy used by both request-producing paths.
- Modify `src/llm-protocol/inference-request-builder.ts`: always emit supplied native tools/schema and consume shared policy.
- Modify `src/status-server/routes/inference-passthrough.ts`: consume shared policy and stop deleting native EXL3 fields.
- Modify `packages/contracts/src/config.ts`, `src/config/defaults.ts`, and `src/config/normalization.ts`: define, default, and normalize `AdminApiKey`.
- Modify `src/status-server/tabby-model-client.ts`: own authenticated process/model probes, load, and unload.
- Modify `src/status-server/managed-inference-runtime.ts`, `src/status-server/managed-llama-runtime.ts`, `src/status-server/managed-tabby.ts`, and `src/status-server/index.ts`: remove dead capabilities and invalid preset construction.
- Modify focused tests under `tests/`: prove request preservation, lifecycle authorization, remote wake, and valid runtime construction.
- Modify `docs/exl3-backend-setup.md`: document verified native request behavior and lifecycle authentication.

---

### Task 1: Share request compatibility and preserve native EXL3 fields

**Files:**
- Create: `src/inference-presets/request-compatibility.ts`
- Modify: `src/llm-protocol/inference-request-builder.ts`
- Modify: `src/status-server/routes/inference-passthrough.ts`
- Test: `tests/inference-request-builder.test.ts`
- Test: `tests/inference-passthrough-idle.test.ts`

**Interfaces:**
- Produces: `getInferenceRequestCompatibility(backend: InferenceBackendId): InferenceRequestCompatibility`.
- `InferenceRequestCompatibility` contains `repetitionPenaltyKey`, `removedFields`, and `reasoningContent`.
- Both internal and passthrough request paths consume the same object.

- [ ] **Step 1: Write the failing internal request test**

Update the existing EXL3 builder test to pass one tool and a JSON schema, then require both fields to survive:

```ts
const tools = [{
  type: 'function' as const,
  function: {
    name: 'get_weather',
    description: 'Get weather.',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
}];

assert.deepEqual(request.tools, tools);
assert.deepEqual(request.response_format, {
  type: 'json_schema',
  json_schema: { name: 'answer', schema: { type: 'object' } },
});
assert.equal(request.parallel_tool_calls, true);
```

- [ ] **Step 2: Write the failing passthrough test**

In `chat queued during a preset switch is translated for the target backend`, send:

```ts
body: JSON.stringify({
  messages: [{ role: 'user', content: 'queued' }],
  tools,
  response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object' } } },
  cache_prompt: true,
  id_slot: 4,
  timings_per_token: true,
}),
```

Assert the captured Tabby body retains `tools`, `parallel_tool_calls`, and `response_format`, while `cache_prompt`, `id_slot`, `timings_per_token`, and `repeat_penalty` are absent.

- [ ] **Step 3: Run the tests and verify RED**

Run:

```powershell
npm run build:test
node .\dist\scripts\run-tests.js tests/inference-request-builder.test.ts tests/inference-passthrough-idle.test.ts
```

Expected: failures show EXL3 `tools` and `response_format` are `undefined` or missing from the captured body.

- [ ] **Step 4: Add the shared compatibility policy**

Create `request-compatibility.ts`:

```ts
import type { InferenceBackendId } from '../config/types.js';

const llamaCompatibility = {
  repetitionPenaltyKey: 'repeat_penalty',
  removedFields: ['repetition_penalty'],
  reasoningContent: true,
} as const;

const exl3Compatibility = {
  repetitionPenaltyKey: 'repetition_penalty',
  removedFields: ['repeat_penalty', 'cache_prompt', 'id_slot', 'timings_per_token'],
  reasoningContent: false,
} as const;

export type InferenceRequestCompatibility = typeof llamaCompatibility | typeof exl3Compatibility;

export function getInferenceRequestCompatibility(
  backend: InferenceBackendId,
): InferenceRequestCompatibility {
  return backend === 'llama' ? llamaCompatibility : exl3Compatibility;
}
```

- [ ] **Step 5: Consume the policy from both request paths**

In `InferenceRequestBuilder`, remove the `includeTools`/`includeResponseFormat` parameters. Always add supplied `tools` and `response_format`, use `compatibility.repetitionPenaltyKey` for the sampler field, and use `compatibility.reasoningContent` before adding `reasoning_content`.

In `translateChatBody`, get the same compatibility object, set the penalty default through its key, and delete only `compatibility.removedFields`. Do not delete `tools`, `parallel_tool_calls`, or `response_format`.

- [ ] **Step 6: Run the focused tests and verify GREEN**

Run the Step 3 commands again.

Expected: both files pass with native EXL3 fields preserved and llama-only controls absent.

- [ ] **Step 7: Commit**

```powershell
git add -- src/inference-presets/request-compatibility.ts src/llm-protocol/inference-request-builder.ts src/status-server/routes/inference-passthrough.ts tests/inference-request-builder.test.ts tests/inference-passthrough-idle.test.ts
git commit -m "fix: preserve native EXL3 request features"
```

---

### Task 2: Authenticate the complete Tabby lifecycle

**Files:**
- Modify: `packages/contracts/src/config.ts`
- Modify: `src/config/defaults.ts`
- Modify: `src/config/normalization.ts`
- Modify: `src/status-server/tabby-model-client.ts`
- Modify: `src/status-server/managed-tabby.ts`
- Modify: `tests/contracts-config.test.ts`
- Modify: `tests/config-normalization.test.ts`
- Modify: `tests/tabby-model-client.test.ts`
- Modify: `tests/inference-passthrough-idle.test.ts`
- Modify: `tests/managed-tabby.test.ts`
- Modify: `tests/helpers/runtime-config.ts`
- Modify: `tests/_test-helpers.ts`

**Interfaces:**
- Produces: `Exl3EngineConfig.AdminApiKey: string`.
- Produces: `new TabbyModelClient(adminApiKey: string)`.
- Produces: `TabbyModelClient.isProcessReady(baseUrl: string, timeoutMs: number): Promise<boolean>`.
- All Tabby client methods use one explicit header builder; the managed runtime does no lifecycle fetches itself.

- [ ] **Step 1: Write failing schema and normalization tests**

Require the contract schema to accept `AdminApiKey: 'secret'`, require omission to fail schema parsing, and require normalization to trim the value while defaulting missing input to `''`:

```ts
assert.equal(normalizeConfig({ Server: { Engines: { Exl3: { AdminApiKey: '  secret  ' } } } })
  .Server.Engines.Exl3.AdminApiKey, 'secret');
assert.equal(normalizeConfig({}).Server.Engines.Exl3.AdminApiKey, '');
```

- [ ] **Step 2: Write failing authenticated lifecycle tests**

Extend the real HTTP server in `tabby-model-client.test.ts` to record `request.headers.authorization`. Construct `new TabbyModelClient('admin-secret')`, invoke process readiness, load, list, and unload, then assert every captured value is `Bearer admin-secret`.

Add a second client with `''` and assert the header is absent. Add explicit `401` and `403` responses and assert their exact operation-specific errors propagate.

- [ ] **Step 3: Write the failing authenticated remote-wake E2E test**

In `remote chat wakes idle-unloaded EXL3`, configure `AdminApiKey: 'admin-secret'`. Make the fake Tabby return `401` from `/v1/models`, `/v1/model`, `/v1/model/load`, and `/v1/model/unload` unless the header is exactly `Bearer admin-secret`. Preserve the existing unload-then-remote-chat wake assertions.

- [ ] **Step 4: Run the tests and verify RED**

Run:

```powershell
npm --prefix .\packages\contracts run build
npm run build:test
node .\dist\scripts\run-tests.js tests/contracts-config.test.ts tests/config-normalization.test.ts tests/tabby-model-client.test.ts tests/inference-passthrough-idle.test.ts
```

Expected: schema/default assertions fail and lifecycle requests omit authorization.

- [ ] **Step 5: Add and normalize `AdminApiKey`**

Add `AdminApiKey: z.string()` to `Exl3EngineConfigSchema`, set `AdminApiKey: ''` in defaults, and normalize with:

```ts
AdminApiKey: getNullableTrimmedString(input.AdminApiKey) ?? '',
```

Add `AdminApiKey: ''` to the typed EXL3 fixtures in `tests/managed-tabby.test.ts`, `tests/helpers/runtime-config.ts`, and `tests/_test-helpers.ts`. Use the non-empty key in `tests/inference-passthrough-idle.test.ts`. Do not add legacy field aliases.

- [ ] **Step 6: Centralize authenticated HTTP in `TabbyModelClient`**

Add one explicit header builder:

```ts
function buildHeaders(adminApiKey: string, json: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (json) headers['content-type'] = 'application/json';
  if (adminApiKey) headers.authorization = `Bearer ${adminApiKey}`;
  return headers;
}
```

Use it for `/v1/models`, `/v1/model`, `/v1/model/load`, and `/v1/model/unload`. `isProcessReady` catches connection/timeout failures and returns `false`, but throws for non-success HTTP responses. `listModels` treats only Tabby's current `503 No models are currently loaded` response as `[]`; remove the old `400`/`404` compatibility behavior.

- [ ] **Step 7: Route process readiness through the authenticated client**

Construct the default client with `engine.AdminApiKey`. Replace the raw `/v1/models` fetch in `ManagedTabbyRuntime.waitForProcess` with `client.isProcessReady`. Authentication errors must fail startup immediately; connection failures continue polling until the preset startup deadline.

- [ ] **Step 8: Run focused tests and typecheck**

Run:

```powershell
npm --prefix .\packages\contracts run build
npm run typecheck:test
npm run build:test
node .\dist\scripts\run-tests.js tests/contracts-config.test.ts tests/config-normalization.test.ts tests/tabby-model-client.test.ts tests/inference-passthrough-idle.test.ts
```

Expected: all commands exit `0`; authenticated remote wake still loads after idle unload.

- [ ] **Step 9: Commit**

```powershell
git add -- packages/contracts/src/config.ts src/config/defaults.ts src/config/normalization.ts src/status-server/tabby-model-client.ts src/status-server/managed-tabby.ts tests/contracts-config.test.ts tests/config-normalization.test.ts tests/tabby-model-client.test.ts tests/inference-passthrough-idle.test.ts tests/managed-tabby.test.ts tests/helpers/runtime-config.ts tests/_test-helpers.ts
git commit -m "fix: authenticate Tabby lifecycle operations"
```

---

### Task 3: Remove invalid runtime construction and dead capabilities

**Files:**
- Modify: `src/status-server/managed-inference-runtime.ts`
- Modify: `src/status-server/managed-llama-runtime.ts`
- Modify: `src/status-server/managed-tabby.ts`
- Modify: `src/status-server/index.ts`
- Modify: `tests/managed-inference-runtime.test.ts`
- Modify: `tests/managed-tabby.test.ts`
- Modify: `tests/inference-passthrough-idle.test.ts`

**Interfaces:**
- `ManagedInferenceRuntime` exposes only `stopProcess`, `ensurePresetReady`, `unloadPreset`, and state accessors.
- `ManagedTabbyRuntime` constructor becomes `(engine: Exl3EngineConfig, client?: TabbyModelClient)`.
- Concrete process-start helpers are private and accept the validated target preset when required.

- [ ] **Step 1: Write failing public-surface tests**

Add:

```ts
assert.equal(ManagedTabbyRuntime.length, 1);
assert.equal('getCapabilities' in new TestRuntime(), false);
```

In the preset-switch E2E test, count every fake Tabby request and assert the count remains zero while the llama preset is active, then assert EXL3 wake succeeds after switching.

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
npm run build:test
node .\dist\scripts\run-tests.js tests/managed-inference-runtime.test.ts tests/managed-tabby.test.ts tests/inference-passthrough-idle.test.ts
```

Expected: constructor arity is `2` and `getCapabilities` remains present.

- [ ] **Step 3: Simplify the abstract runtime**

Delete `BackendCapabilities`, the capability constructor parameter, `getCapabilities`, and abstract `startProcess`. Keep `id`, separate process/model state, `stopProcess`, `ensurePresetReady`, and `unloadPreset`.

Remove `llamaCapabilities` and `tabbyCapabilities`. Change subclasses to `super('llama')` and `super('exl3')`.

- [ ] **Step 4: Make concrete startup internal**

In `ManagedLlamaRuntime`, remove the unused `SiftConfig` constructor argument and make `startProcess` private.

In `ManagedTabbyRuntime`:

```ts
private currentPreset: ModelRuntimePreset | null = null;

constructor(
  private readonly engine: Exl3EngineConfig,
  private readonly client = new TabbyModelClient(engine.AdminApiKey),
) {
  super('exl3');
  this.logPath = path.join(getManagedTabbyLogRoot(), 'latest-startup.log');
}
```

`ensurePresetReady` must reject non-EXL3 presets before assigning `currentPreset` or performing network/process work. Private `startProcess(preset)` and `waitForProcess(preset)` receive the validated preset explicitly. `unloadPreset` returns immediately when already unloaded and otherwise throws a clear invariant error if no validated current preset exists.

- [ ] **Step 5: Update construction sites and tests**

In `startStatusServer`, remove `getActiveModelPreset(initialConfig)` from Tabby construction:

```ts
const managedTabbyRuntime = new ManagedTabbyRuntime(initialConfig.Server.Engines.Exl3);
```

Construct `ManagedLlamaRuntime` with only `ctx`. Update focused tests to construct Tabby with the engine and optional client, then call `ensurePresetReady(exl3Preset)` rather than public `startProcess`.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run the Step 2 commands again, followed by:

```powershell
npm run typecheck:test
```

Expected: all commands exit `0`; no Tabby request occurs while llama is active, and the later EXL3 wake passes.

- [ ] **Step 7: Commit**

```powershell
git add -- src/status-server/managed-inference-runtime.ts src/status-server/managed-llama-runtime.ts src/status-server/managed-tabby.ts src/status-server/index.ts tests/managed-inference-runtime.test.ts tests/managed-tabby.test.ts tests/inference-passthrough-idle.test.ts
git commit -m "refactor: require validated presets for runtime startup"
```

---

### Task 4: Document and verify the complete correction

**Files:**
- Modify: `docs/exl3-backend-setup.md`
- Test: focused files from Tasks 1-3 and the complete suite.

**Interfaces:**
- Documentation describes native EXL3 request forwarding, local XML tool parsing, `AdminApiKey`, authenticated wake/unload, and the thinking/token-budget caveat.

- [ ] **Step 1: Update deployment documentation**

Replace the blanket Formatron warning with the verified behavior:

- Tabby loads the model-folder `chat_template.jinja`.
- `tools` and `response_format` are forwarded.
- Qwen tool calls remain XML and are parsed locally by SiftKit.
- Constrained content can be delayed by thinking and therefore needs a sufficient output budget.
- `Server.Engines.Exl3.AdminApiKey` is the Tabby admin bearer token; leave it empty only when Tabby authentication is disabled.

- [ ] **Step 2: Run focused branch coverage**

Run:

```powershell
npm run build:test
npx c8 --include="src/inference-presets/request-compatibility.ts" --include="src/llm-protocol/inference-request-builder.ts" --include="src/status-server/tabby-model-client.ts" --include="src/status-server/managed-tabby.ts" --include="src/status-server/routes/inference-passthrough.ts" --reporter=text --reporter=text-summary node .\dist\scripts\run-tests.js tests/inference-request-builder.test.ts tests/tabby-model-client.test.ts tests/managed-tabby.test.ts tests/inference-passthrough-idle.test.ts
```

Expected: the command exits `0`, every changed file appears in the report, and the combined changed-file branch percentage is at least `90%`. Stop and report the exact uncovered branches if the threshold is not met.

- [ ] **Step 3: Run complete verification**

Run:

```powershell
npm test
npm run typecheck
npm run build
git diff --check
git status --short
```

Expected: tests report zero failures, typecheck/lint/build exit `0`, `git diff --check` is empty, and status contains only this task's documentation plus the preserved user-owned untracked plan.

- [ ] **Step 4: Commit documentation**

```powershell
git add -- docs/exl3-backend-setup.md
git commit -m "docs: document authenticated native EXL3 requests"
```

- [ ] **Step 5: Review requirement coverage**

Confirm from the final diff and fresh command output:

- EXL3 native fields are preserved in both request paths.
- One production compatibility policy is used by both paths.
- Every Tabby lifecycle request carries the configured admin key.
- Caller inference authorization remains unchanged.
- Tabby construction contains no arbitrary preset.
- No public runtime-start or dead capability API remains.
- Remote wake and idle unload still pass end to end.
- No casts, `any`, non-null assertions, shims, or unrelated file changes were introduced.

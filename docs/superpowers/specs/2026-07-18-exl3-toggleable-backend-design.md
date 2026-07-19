# EXL3 Toggleable Backend Design

**Date:** 2026-07-18

**Goal:** Add TabbyAPI/ExLlamaV3 as a first-class managed inference backend while preserving the existing managed llama.cpp path and ensuring only one GPU runtime is loaded at a time.

## Scope

SiftKit will manage two independent inference profiles:

- `llama`: the existing `llama-server.exe` and GGUF profile on port `8097`.
- `exl3`: TabbyAPI and an EXL3 model profile on port `8098`.

The selected backend is persisted and controlled through the status/config API, dashboard, and public CLI. A switch requested during inference drains the active request, pauses queued inference, unloads the old runtime, starts and verifies the new runtime, and then resumes queued work.

TabbyAPI will be installed at `C:\Users\denys\Documents\GitHub\TabbyAPI` and launched directly with `C:\envs\rl310\Scripts\python.exe`. These paths are initial deployment values, not source-code constants. TabbyAPI remains authoritative for EXL3 model, context, cache, batching, reasoning, vision, and MTP configuration through its `config.yml`.

The initial real-machine profile loads the existing EXL3 checkpoint at `D:\personal\models\elx3\3.6_27B`, with built-in MTP, `max_batch_size: 1`, vision disabled, and a conservative 84,992-token `8,8` KV cache. This reserves capacity for one active request and uses 8-bit K/V storage by default. Its files identify a 4.00-bit `mul1` quant with one MTP layer and the internal architecture `Qwen3_5ForConditionalGeneration`. Current upstream TabbyAPI and ExLlamaV3 `1.1.0` are the required target. Exact installed versions and commit identities must be recorded after setup.

The checkpoint contains vision/preprocessor metadata but no separate `mmproj` file. TabbyAPI must be configured with `vision: false`, and startup evidence must confirm that no multimodal projector or vision tower is loaded.

The selected `rl310` environment currently contains Python `3.10.11` and Torch `2.8.0+cu126`. TabbyAPI's ExLlamaV3 `1.1.0` CPython 3.10 Windows wheel targets Torch `2.9.0+cu128`, so dependency setup must upgrade the environment to the matching Torch/CUDA build before ExLlamaV3 is loaded. The resulting environment identity must be verified after installation.

## Considered Approaches

### 1. Narrow managed-runtime boundary and switch coordinator — selected

Extract only the lifecycle, endpoint, model, state, and capability concepts required by the two runtimes. Keep llama-specific command construction, metrics, and logs in the existing implementation. Add a Tabby implementation and a coordinator that owns selection and switching.

This approach reuses SiftKit's existing request queue, process-tree management, readiness probing, configuration store, routes, and dashboard patterns without turning the feature into a general plugin system.

### 2. General inference-provider plugin framework — rejected

A registry, dynamic provider loading, and generalized configuration editor would add abstractions that neither backend needs. It would also conflict with the requirement for explicit functions and first-class typed profiles.

### 3. Externally managed TabbyAPI with endpoint-only switching — rejected

This would be quicker but would not enforce drain-before-switch, single-runtime GPU ownership, rollback, persisted startup, or coherent status reporting. It would leave EXL3 as an operator workaround instead of a first-class SiftKit backend.

## Architecture

### Runtime contract

Introduce explicit backend and runtime types:

```ts
type InferenceBackendId = 'llama' | 'exl3';

type InferenceRuntimeState =
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'draining'
  | 'stopping'
  | 'failed';

type BackendCapabilities = {
  chatTemplateKwargs: boolean;
  reasoningContent: boolean;
  toolCalling: boolean;
  jsonSchema: boolean;
  speculativeMode: 'none' | 'mtp' | 'draft-model' | 'ngram';
  reusablePrefixCache: 'unknown' | 'none' | 'in-process-exact' | 'in-process-partial' | 'persistent';
};

interface ManagedInferenceRuntime {
  readonly id: InferenceBackendId;
  start(): Promise<void>;
  stop(): Promise<void>;
  waitUntilReady(): Promise<void>;
  getState(): InferenceRuntimeState;
  getBaseUrl(): string;
  getModelId(): string;
  getCapabilities(): BackendCapabilities;
}
```

The exact ownership of `waitUntilReady` may remain inside `start` if that better matches the current managed-llama lifecycle. The public behavior and typed state remain required.

Use explicit classes and methods. Do not introduce dynamic function dispatch or a broad provider registry.

### Runtime implementations

The llama runtime wraps existing managed-llama behavior without changing its launch arguments, logging, idle sleep, speculative metrics, readiness, or shutdown semantics.

The Tabby runtime:

- starts `C:\envs\rl310\Scripts\python.exe` with `main.py` and the configured working directory;
- spawns without a shell;
- captures stdout and stderr in backend-specific runtime logs;
- retains recent startup output for actionable errors;
- detects unexpected exits;
- terminates the Windows process tree;
- waits for port release on shutdown;
- probes `/v1/models` and requires the configured model identifier before reporting `ready`;
- applies configurable startup, health-check, and shutdown timeouts.

### Switch coordinator

The status server owns:

```text
activeBackend
selectedBackend
pendingBackend
runtimeState
previousWorkingBackend
switchError
rollbackResult
```

`selectedBackend` is persisted. The other fields describe live runtime state and are reconstructed at server startup.

When a different backend is selected:

1. Persist the new selection and expose it as pending.
2. Mark the active runtime draining.
3. Prevent the model-request queue from granting another lock.
4. Let the active lock finish normally.
5. Stop the old runtime and verify process exit and port release.
6. Start the selected runtime and verify the configured model.
7. Mark it active and ready.
8. Resume granting queued requests.

Duplicate selection is idempotent. A selection received while still draining replaces the pending target. A selection received after stopping starts is rejected with the current transition state. The coordinator never starts both managed runtimes concurrently.

If target startup fails, queued work remains paused while one rollback to the previous working backend is attempted. Successful rollback is reported explicitly and does not change the persisted selection silently. Failed rollback leaves the coordinator in `failed` until the user selects or restarts a configured backend.

### Queue integration

The existing serialized model-request queue remains the admission mechanism. Add an explicit coordinator gate so `acquireModelRequest`, `grantNextModelRequest`, wake logic, and request-ready checks cannot route work during `draining`, `stopping`, or `starting`.

Queue waiter timeouts must not expire merely because a healthy backend transition is underway. Their timeout accounting is paused or refreshed when the switch advances. Client cancellation continues to remove a waiter normally.

### Request adapter

Replace direct llama-specific endpoint resolution at task call sites with one typed inference client. The common client owns normalized chat messages, tools, response format, streaming callbacks, cancellation, usage, content, reasoning content, and normalized errors.

Backend adapters build request bodies:

- llama may send `cache_prompt`, `id_slot`, `timings_per_token`, and llama-specific template arguments.
- Tabby sends only fields verified against the installed OpenAI-compatible API.
- both use the configured model identifier and active runtime base URL.

SiftKit continues to retain reasoning separately from visible content. The Tabby adapter maps SiftKit's thinking policy to verified `chat_template_kwargs`, including `enable_thinking` and `preserve_thinking`. It never concatenates reasoning into visible assistant content.

Live KV allocation and reusable prompt-prefix caching remain separate capabilities. Tabby's `cache_size` and `cache_mode` do not imply persistent prefix caching.

## Configuration

The typed configuration adds:

```text
Inference.SelectedBackend
Inference.Thinking
Server.Inference.Llama
Server.Inference.Exl3
```

The llama profile retains all current managed-llama settings and preset behavior. The Exl3 profile stores only SiftKit-owned process and routing settings: managed/external mode, base URL, working directory, Python path, entrypoint, model identifier, config path, and lifecycle timeouts.

The complete Tabby YAML is not duplicated into SiftKit configuration. Configuration normalization performs a complete schema migration with no legacy compatibility layer. Invalid or incomplete selected profiles fail clearly.

## API, CLI, and Dashboard

The status/config API exposes runtime-aware operations equivalent to:

```http
GET /runtime/backend
PUT /runtime/backend
```

Status contains `active`, `selected`, `pending`, `state`, `model`, `error`, and rollback details. The update response states whether the target was already active, switched immediately, or queued behind active work.

The public CLI adds:

```text
siftkit backend status
siftkit backend use llama
siftkit backend use exl3
siftkit backend use exl3 --wait
```

`--wait` returns only when the target is ready or the transition fails. Invalid configuration, startup failure, and failed rollback return non-zero exit codes.

The existing settings page gains a compact selector and status display. It shows active, selected, pending, state, model, and actionable errors. It does not add a separate dashboard.

## Error Handling

- Configuration errors identify the backend and invalid field.
- Startup errors include the command identity, working directory, readiness failure, exit code, and recent redacted output.
- Switch status distinguishes target failure from rollback failure.
- No request is routed to a backend other than the visible active backend.
- Unexpected runtime exit moves the runtime to `failed`, pauses new work, and surfaces the error; it does not silently start the other backend.
- Status-server shutdown terminates only the managed active or transitioning runtime.

## Testing

All implementation follows test-first red-green-refactor cycles.

### Typed/unit coverage

- backend profile parsing and normalization;
- selected-backend persistence;
- active endpoint/model resolution;
- backend-specific request body mapping;
- thinking and reasoning-history policy;
- capability reporting;
- every switch-state transition and invalid transition;
- idempotent and replacement selections;
- startup timeout, rollback success, and rollback failure.

### Process integration coverage

Use controllable fake HTTP servers and child processes. Tests verify startup readiness, process exit ordering, port release, drain behavior, paused queue grants, queue resumption, restart persistence, API/CLI agreement, and visible failures without requiring a GPU.

### Real-machine acceptance

On the RTX 4090, verify standalone Tabby first, then run both directions of a live SiftKit switch. Cover normal completion, streaming, cancellation, tool calls, JSON-schema output, reasoning enabled/disabled, reasoning preservation enabled/disabled, built-in MTP, restart persistence, single-runtime VRAM ownership, and one successful request with at least 50,000 input-context tokens.

Measure cold load time, prompt ingestion, first-token latency, generation speed, peak VRAM, steady VRAM, MTP benefit, and repeated-prefix behavior. Run repeated-prefix tests warm, with an early-token change, and after restart before classifying prefix-cache capability.

## Documentation and Operational Record

Record:

- TabbyAPI commit SHA;
- ExLlamaV3 version;
- Python, Torch, and CUDA versions;
- model source identity and directory;
- `config.yml` path;
- managed launch command;
- observed load-log model identity;
- measured memory/performance results;
- switch rollback procedure;
- observed reusable-prefix-cache classification.

## Non-goals

- No proxy or gateway process.
- No general provider plugin framework.
- No simultaneous managed GPU runtimes.
- No GGUF support in ExLlamaV3 or EXL3 support in llama.cpp.
- No model conversion pipeline.
- No DFlash in the initial profile.
- No vision until image requests are implemented and tested end to end.
- No persistent prompt-cache claim without measurement.
- No unrelated summary, repo-search, logging, compression, or tool-loop refactor.

## Acceptance Criteria

The feature is complete when existing llama.cpp behavior remains green; EXL3 is managed through the same UI, API, and CLI selection; active work drains without cancellation; queued work pauses and resumes; process overlap is impossible; one visible rollback is attempted on startup failure; selection survives restart; normalized chat, streaming, tools, structured output, and reasoning work on both backends; the existing 4.00-bit `mul1` checkpoint runs with built-in MTP and without vision/mmproj loading on the RTX 4090; and exact dependency and cache-behavior evidence is documented.

# Per-Preset Inference Backends Design

**Date:** 2026-07-19

**Goal:** Make the inference backend a property of each model/runtime preset, translate the existing preset controls into correct llama.cpp or TabbyAPI/EXL3 parameters, expose unsupported controls as disabled, and provide transparent SiftKit-managed EXL3 idle unload and wake behavior for local and remote callers.

## Scope

- Move backend selection from the global inference configuration into every model/runtime preset.
- Keep one preset editor and the current preset option order.
- Translate shared preset values explicitly for llama.cpp and TabbyAPI/EXL3.
- Keep fields without a safe EXL3 equivalent visible but disabled when an EXL3 preset is selected.
- Replace the llama-specific public passthrough with a backend-neutral inference passthrough.
- Wake the active preset backend for workload requests from local SiftKit flows or remote SiftKit clients.
- Return active-preset model metadata from `GET /v1/models` without waking an idle model.
- Provide SiftKit-managed Tabby model unload after idle and transparent reload on the next workload.
- Preserve the existing single-runtime GPU ownership, request draining, queueing, rollback, and save-then-apply behavior.

## Non-Goals

- No general inference-provider plugin framework.
- No simultaneous managed GPU runtimes.
- No silent approximation for unsupported fields or enum values.
- No duplication of the entire preset editor by backend.
- No generated Tabby YAML per wake or process restart solely to load a preset.
- No vision, LoRA, embedding, DFlash, or model-conversion work.
- No compatibility layer for the old global backend selection or old llama-specific preset hierarchy.

## Selected Approach

Use one backend-neutral model preset schema and two explicit adapter classes. The active preset is the sole source of the model, backend, launcher/load values, sampling defaults, reasoning policy, and idle policy. Engine installation details remain outside presets.

This keeps the operator model simple, avoids duplicated UI and configuration, and makes every backend difference explicit at a typed translation boundary.

Rejected alternatives:

1. Separate llama.cpp and EXL3 preset schemas would provide clean backend-specific types but duplicate the editor and conflict with the shared-options requirement.
2. Generating Tabby YAML and restarting Tabby for each wake or preset change would be slower, couple model residency to process residency, and make remote passthrough requests unreliable during cold starts.

## Configuration Model

### Preset ownership

Replace the llama-specific preset library with a backend-neutral library:

```text
Server.ModelPresets.Presets
Server.ModelPresets.ActivePresetId
```

Each preset gains:

```text
Backend: llama | exl3
```

The preset retains the existing model/runtime fields. `ActivePresetId` selects the model and backend atomically.

Remove:

```text
Inference.SelectedBackend
Server.LlamaCpp.Presets
Server.LlamaCpp.ActivePresetId
```

Remove mirrored active runtime values that duplicate the active preset. Runtime code resolves the saved active preset directly. Configuration normalization performs a complete migration to the new schema and emits only the new shape; runtime code does not support both shapes.

### Engine installation settings

Backend executable and installation details remain engine-level because they describe an installed engine, not a model preset:

```text
Server.Engines.Exl3.WorkingDirectory
Server.Engines.Exl3.PythonPath
Server.Engines.Exl3.Entrypoint
Server.Engines.Exl3.ConfigPath
Server.Engines.Exl3.ModelRoot
Server.Engines.Exl3.ShutdownTimeoutMs
```

Tabby must be launched with `ConfigPath`. Its base configuration owns networking, authentication, and logging. Model identity and supported load parameters come from the active preset through `/v1/model/load`.

The Tabby server can run with no model resident. Process readiness means the HTTP API is reachable; model readiness is tracked separately.

### Save and application behavior

- Preset edits and selection remain draft-only until `Save Settings`.
- Saving persists the preset library and active preset id.
- Applying or restarting resolves the saved active preset and transitions to its backend.
- Selecting a preset with a different backend uses the existing drain, unload/stop, start/load, readiness, and rollback coordination.
- No global backend selector remains in the dashboard or CLI.

## Explicit Adapter Boundary

Use two concrete classes with explicit methods and coordinator branching. Do not use a dynamic provider registry or pass adapter functions around.

```text
LlamaPresetAdapter
  validatePreset
  buildLaunchConfiguration
  buildRequestDefaults
  ensureModelReady
  scheduleIdleBehavior

Exl3PresetAdapter
  validatePreset
  buildLoadRequest
  buildRequestDefaults
  ensureModelReady
  unloadModelAfterIdle
```

The coordinator selects the concrete adapter with an explicit backend branch. Adapters return typed values validated at the IO boundary by runtime schemas.

## Preset Field Parity

### Enabled for both backends

| Preset field | llama.cpp translation | EXL3 translation |
|---|---|---|
| `ExternalServerEnabled` | Do not manage the llama process | Do not manage the Tabby process; lifecycle API calls still require a reachable authorized endpoint |
| `BaseUrl` | llama.cpp API base URL | TabbyAPI base URL |
| `BindHost` | `--host` | Tabby network host when SiftKit owns the process configuration |
| `Port` | `--port` | Tabby network port when SiftKit owns the process configuration |
| `Model` | Request model id | Tabby model name/request model id |
| `ModelPath` | GGUF file | EXL3 model directory under the configured `ModelRoot`; split into model root plus model name for Tabby |
| `NumCtx` | `-c` | `max_seq_len`; derive `cache_size` as the smallest valid 256-token multiple not below `NumCtx` |
| `ParallelSlots` | `-np` | `max_batch_size` |
| `MaxTokens` | Request `max_tokens` default | Request `max_tokens` default |
| `Temperature` | Request `temperature` default | Request `temperature` default |
| `TopP` | Request `top_p` default | Request `top_p` default |
| `TopK` | Request `top_k` default | Request `top_k` default |
| `MinP` | Request `min_p` default | Request `min_p` default |
| `PresencePenalty` | Request `presence_penalty` default | Request `presence_penalty` default |
| `RepetitionPenalty` | Request `repetition_penalty` default | Request `repetition_penalty` default |
| `Reasoning` | llama template/reasoning request policy | Tabby load parser plus `chat_template_kwargs.enable_thinking` |
| `ReasoningContent` | llama reasoning-content request behavior | Enable Tabby reasoning parsing at load time |
| `PreserveThinking` | `chat_template_kwargs.preserve_thinking` | Same template variable when supported by the active model template |
| `MaintainPerStepThinking` | SiftKit conversation-history behavior | Same SiftKit conversation-history behavior |
| `StartupTimeoutMs` | Process/model startup deadline | Tabby process or model-load deadline |
| `HealthcheckTimeoutMs` | llama probe timeout | Tabby probe timeout |
| `HealthcheckIntervalMs` | llama probe interval | Tabby probe interval |
| `SleepIdleSeconds` | Native llama idle behavior | SiftKit timer followed by `/v1/model/unload` |

Sampling ownership moves to the request boundary for both backends. An explicit request value wins over the preset default. The preset supplies a value only when the caller omitted it. Backend server defaults are not relied on for preset sampling behavior.

### Partially compatible enum fields

`KvCacheQuantization` remains visible and enabled for EXL3, but incompatible choices are disabled. Safe translations are:

| Preset choice | EXL3 `cache_mode` |
|---|---|
| `f16` | `FP16` |
| `q8_0` | `8,8` |
| `q4_0` | `4,4` |
| `q5_0` | `5,5` |
| `q8_0/q4_0` | `8,4` |
| `q8_0/q5_0` | `8,5` |

`f32`, `bf16`, `q4_1`, `iq4_nl`, and `q5_1` have no safe EXL3 translation and are disabled for EXL3 presets. Saving an EXL3 preset with one of these stale values fails validation until the operator chooses a supported value.

For speculative decoding, EXL3 supports only the existing `draft-mtp` choice without introducing new preset fields. It maps to Tabby `draft_mode: mtp`; `SpeculativeDraftMax` maps to `draft_num_tokens`. Other speculative choices remain visible but disabled for EXL3 because Tabby's `model` and `ngram` modes do not have enough corresponding preset data for an exact translation.

### Visible but disabled for EXL3

These fields retain their saved values but cannot be edited or applied while the preset backend is EXL3:

- `ExecutablePath`: Tabby Python and entrypoint paths are engine-level settings.
- `GpuLayers`: EXL3 does not use llama-style layer offload counts.
- `Threads` and `NcpuMoe`: no current Tabby/ExLlamaV3 equivalent.
- `FlashAttention`: no equivalent operator control in the current Tabby schema.
- `BatchSize`: llama prompt-processing batch size is not Tabby concurrency.
- `UBatchSize`: Tabby prompt chunk size has different semantics.
- `CacheRam`: Tabby cache allocation is token-based, not the llama cache-RAM setting.
- `ReasoningBudget` and `ReasoningBudgetMessage`: no Tabby equivalent.
- `SpeculativeMtpEnabled`: Tabby cannot combine MTP with another draft mode.
- `SpeculativeDraftMin`: no Tabby equivalent.
- All llama-specific n-gram size, hit, and mod fields.
- `VerboseLogging`: Tabby exposes multiple non-equivalent logging controls at engine level.

Disabled controls show a concise explanation such as `Not supported by EXL3`. Values are preserved so changing the preset back to llama.cpp does not destroy previous edits. No disabled value is emitted in EXL3 load or request parameters.

## Dashboard Behavior

- Add a `Backend` selector beside the model preset name.
- Remove the global backend selector and status control.
- Keep a single model preset editor and the current option order.
- Recompute field availability immediately when the draft preset backend changes.
- Disable an entire field when it has no equivalent.
- For a partially compatible enum, disable only incompatible choices.
- Keep help text backend-specific and state the actual runtime mapping where useful.
- Show runtime status using the saved active preset: preset label/id, backend, process state, model-residency state, model id, idle deadline, and last wake/unload failure.

## Backend-Neutral Passthrough

Replace the llama-specific passthrough with one inference passthrough that resolves the saved active preset for every request.

Public routes:

```text
GET  /v1/models
POST /v1/chat/completions
POST /tokenize
POST /v1/token/encode
```

`GET /v1/models` returns the configured active-preset model without waking an idle model. It is a stable model catalog response, not a residency probe. Residency is available through SiftKit runtime status.

The workload routes acquire the shared model-request lock, call `ensureActivePresetReady`, translate the route/body when required, and proxy only after readiness succeeds. Both tokenization route forms are accepted:

- llama active: `/tokenize` passes through; `/v1/token/encode` is normalized to llama tokenization.
- EXL3 active: `/v1/token/encode` passes through; `/tokenize` is normalized to Tabby token encoding.

This lets a remote SiftKit use the public SiftKit endpoint without knowing whether the active preset is llama.cpp or EXL3.

For chat passthrough, parse and validate the JSON body, apply active-preset sampling and reasoning defaults only for omitted values, then use the active adapter to remove unsupported backend fields. Preserve caller-supplied supported values.

Local dashboard, CLI, summary, plan, repo-search, and remote passthrough traffic use the same request admission and readiness path. No inference path may address Tabby or llama.cpp directly without coordinator readiness.

## EXL3 Model Residency Lifecycle

Track engine process state separately from model residency:

```text
Process: stopped | starting | ready | stopping | failed
Model:   unloaded | loading | ready | unloading | failed
```

### Wake

1. A workload request clears the active preset's idle timer before queueing.
2. The request acquires the shared model-request lock.
3. `ensureActivePresetReady` ensures the selected engine process is reachable.
4. If the EXL3 model is unloaded, the EXL3 adapter posts the translated active preset to `/v1/model/load`.
5. It consumes the load progress stream and then requires `/v1/models` to contain the active preset model.
6. The original request is forwarded only after the model is ready.

One stored wake promise deduplicates simultaneous wake attempts. Other callers remain queued. Queue wait timeouts pause or refresh while a healthy wake advances.

### Idle unload

1. Releasing the final active request records the completion time.
2. If no request is active or queued, arm a timer for `SleepIdleSeconds`.
3. Timer expiry closes the coordinator admission gate and rechecks the active request and queue state.
4. If still idle and the same EXL3 preset remains active, post `/v1/model/unload` and verify that the model is absent from `/v1/models`.
5. Keep the Tabby process running and mark model residency `unloaded`.

A request arriving before unload begins cancels the timer. A request arriving after unload starts waits for unload completion and then follows the normal wake path. Preset selection or backend switching cancels the old idle timer before draining.

llama.cpp retains its native idle sleep/wake implementation. SiftKit still calls the common readiness method so process-offline and backend-transition behavior remains transparent.

## Error Handling

- Preset validation reports the preset id, backend, field, rejected value, and reason.
- Unsupported fields are never silently discarded during save if their value would be applied.
- A wake failure returns `503` with preset, backend, phase, and sanitized upstream details. The original workload is not forwarded.
- A passthrough translation or payload validation failure returns `400` without waking the backend.
- A provider failure after readiness returns `502` and preserves the provider status/body subject to existing redaction rules.
- An unload failure records the error, leaves residency state `failed`, and does not claim VRAM was released.
- The next workload may make one explicit wake retry. Repeated failure remains visible until the preset is reapplied or the backend is restarted.
- Backend-switch rollback remains one attempt to the previously working preset/backend. It never silently changes the saved active preset.
- Status distinguishes process failure, model-load failure, model-unload failure, and request failure.

## Testing

All implementation follows red-green-refactor TDD. Prefer end-to-end status-server tests with fake engine processes and HTTP APIs; use focused unit tests only for pure translation and validation branches.

### Schema and translation

- Complete migration from the global backend and llama preset hierarchy to backend-neutral presets.
- No runtime parsing of the old configuration shape.
- Every enabled common field maps to the expected llama or EXL3 parameter.
- Every disabled EXL3 field is omitted.
- Every incompatible EXL3 enum choice fails save validation.
- Request values override preset sampling defaults; omitted values receive preset defaults.
- Tokenization requests and responses normalize in both route/backend combinations.

### Dashboard

- Backend selection belongs to each preset.
- The global selector is absent.
- Unsupported fields remain visible and disabled for EXL3.
- Compatible fields remain editable.
- Incompatible enum choices are disabled.
- Switching the draft backend preserves stored values.
- Saving and applying use the saved active preset atomically.

### Lifecycle and passthrough

- Local and remote chat wake an unloaded EXL3 model and return the original response.
- Streaming stays queued through wake and releases the lock only after the downstream stream closes.
- Both tokenization routes wake and translate correctly.
- `GET /v1/models` works while unloaded and does not wake the model.
- Concurrent requests cause one Tabby load.
- Completion, error, cancellation, and downstream disconnect rearm idle behavior correctly.
- Idle expiry unloads once and frees the admission gate afterward.
- Arrival immediately before and during unload is race-safe.
- Preset switching cancels the old timer and prevents old-model reload.
- Load timeout, malformed progress, readiness mismatch, unload failure, retry, and switch rollback are visible and deterministic.
- Existing llama.cpp passthrough, queueing, startup, streaming, and native idle behavior remain green.

### Real-machine acceptance

On the configured TabbyAPI/EXL3 installation:

1. Apply an EXL3 preset and complete local and remote SiftKit chat requests.
2. Wait for `SleepIdleSeconds` and verify Tabby remains running while model VRAM is released.
3. Confirm `GET /v1/models` through SiftKit returns the configured model without changing VRAM residency.
4. Send a remote SiftKit workload and verify one transparent model reload followed by the original response.
5. Verify tokenization, streaming, cancellation, reasoning on/off, reasoning preservation, MTP, and at least 50,000 input-context tokens.
6. Switch to a llama.cpp preset and back while proving that both GPU runtimes are never resident simultaneously.

## Acceptance Criteria

- Backend selection exists only on model presets.
- The active preset is the only model/runtime source of truth.
- Existing preset controls remain in one editor.
- EXL3-incompatible controls are visible and disabled with no silent translation.
- Enabled controls produce correct backend-specific load, launch, or request parameters.
- All local and remote workload paths wake the active preset backend when needed.
- `GET /v1/models` does not wake an idle model.
- EXL3 unloads after the configured idle period and reloads transparently on the next workload.
- Queueing, draining, switching, rollback, and single-runtime GPU ownership remain correct.
- The complete automated suite and real-machine acceptance flow pass.

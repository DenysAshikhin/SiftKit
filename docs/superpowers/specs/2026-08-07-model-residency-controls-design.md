# Model residency controls design

## Problem

Model residency is entirely automatic and configured by a single number. `SleepIdleSeconds` (`src/config/constants.ts:43`, default 600) is the only knob: EXL3 presets get a SiftKit-owned idle timer that fully unloads the model (`src/status-server/model-idle-controller.ts:16-25`), and llama presets pass the value straight to `llama-server --sleep-idle-seconds` (`src/status-server/managed-llama.ts:556`).

Three capabilities are missing:

- No way to keep a model permanently resident. `SleepIdleSeconds` is normalized by `getFinitePositiveInteger` (`src/config/normalization.ts:142-145`), so `0` silently reverts to 600 even though `ModelIdleController` checks `<= 0` as a disabled case.
- No manual control. The only lifecycle button in the dashboard is "Restart backend" (`dashboard/src/tabs/SettingsTab.tsx:464`). There is no way to free VRAM on demand, or to load a model before sending a request.
- No way to free VRAM while keeping weights hot. Idle expiry is always a full unload; the next request reloads from disk.

## Required behavior

Both backends:

- Idle expiry after a configured number of seconds, as today.
- A mode in which the model stays resident indefinitely and is only unloaded manually.
- A manual button that fully unloads the model.
- A manual button that fully loads the model without sending an inference request.

EXL3 only:

- A manual button that moves weights to host RAM, frees VRAM, and restores them without reading the model from disk.
- Idle expiry may target host RAM instead of a full unload.

Across all of the above:

- Manual actions refuse rather than queue while the runtime is busy, and report why.
- Existing idle-unload behavior is unchanged for presets that do not opt into the new settings.

## Config model

`ModelRuntimePreset` gains one field and keeps `SleepIdleSeconds` unchanged:

```ts
IdleAction: 'none' | 'ram' | 'unload'   // default 'unload'
SleepIdleSeconds: number                 // default 600, existing validator
```

`IdleAction: 'none'` is the manual-only mode. Folding the mode switch into the destination enum avoids a separate boolean, avoids a magic `SleepIdleSeconds` sentinel, and makes contradictory state such as "auto-unload disabled but destination is RAM" unrepresentable. `SleepIdleSeconds` is ignored when `IdleAction` is `'none'`; its `getFinitePositiveInteger` validator is untouched.

`PRESET_FIELD_SUPPORT` (`src/inference-presets/preset-compatibility.ts:135`) marks `IdleAction` as `'both'`, with the `'ram'` value rejected for llama presets. This follows the existing per-value gating precedent of `KvCacheQuantization: 'exl3-cache-modes'`.

Persistence requires no schema migration. Presets are stored as a JSON array in `app_config.server_llama_presets_json` (`src/state/runtime-db.ts:685-700`); the per-field `server_*` columns, including `server_sleep_idle_seconds`, were dropped by migration v26 (`src/state/runtime-db.ts:656-671`). Preset JSON written before this change simply lacks `IdleAction`, and `normalizeModelPreset` supplies the `'unload'` default on read, which reproduces current behavior.

## Runtime state and status-server API

`InferenceModelStateSchema` (`packages/contracts/src/config.ts:23-26`) gains two members:

```ts
'unloaded' | 'loading' | 'ready' | 'unloading' | 'offloading' | 'offloaded' | 'failed'
```

Restore from RAM reuses `'loading'`. The `'offloaded' -> 'loading' -> 'ready'` sequence already distinguishes a restore from a cold load, so a separate `'restoring'` state adds nothing.

Three routes are added next to the existing `POST /status/restart` (`src/status-server/routes/core.ts:1870`):

| Route | Backends | Effect |
| --- | --- | --- |
| `POST /runtime/model/unload` | both | Full unload, ending in `'unloaded'` |
| `POST /runtime/model/load` | both | Explicit load from `'unloaded'` or `'offloaded'`, ending in `'ready'` |
| `POST /runtime/model/offload` | EXL3 only | Weights to host RAM, VRAM freed, ending in `'offloaded'` |

All three are mediated by `PresetRuntimeCoordinator` and refuse with HTTP 409 when `activeModelRequests.size > 0` or `pendingPresetId !== null`, mirroring the refusal predicates in `unloadActivePresetForIdle` (`src/status-server/preset-runtime-coordinator.ts:112-128`). Manual actions refuse rather than drain: a button that blocks silently behind a long generation is worse than one that reports the runtime is busy. The refusal reason reaches the dashboard.

Each route is idempotent with respect to its target state. A request whose target state is already current succeeds with HTTP 200 and performs no backend call: `load` when the state is `'ready'`, `unload` when `'unloaded'`, `offload` when `'offloaded'`. `POST /runtime/model/offload` against a llama preset is a 400, not a 409, because it is unsupported rather than blocked.

`GET /runtime/inference` (`src/status-server/routes/core.ts:1855`) adds `idleAction` to `InferenceRuntimeStatus` so the UI can render control availability without re-reading config.

`ModelIdleController.armAfterRequest` switches on `IdleAction`: `'none'` never arms a timer, `'ram'` expires into offload, `'unload'` expires into the current unload path. The existing EXL3-only guard is unchanged, so llama presets continue to be handled by `llama-server` itself.

The idle timer remains armed only by request release, as today. A manual load therefore leaves the model resident until the first request completes and releases, at which point the configured `IdleAction` applies normally. Arming a timer on manual load would defeat the purpose of a button pressed to make a model ready.

## llama.cpp behavior

| Control | Mechanism |
| --- | --- |
| Idle timer | Unchanged: `--sleep-idle-seconds <SleepIdleSeconds>` |
| Manual mode (`'none'`) | `--sleep-idle-seconds -1`, the documented disabled value (`common/arg.cpp:3648-3654`, `common/common.h:647`) |
| Manual unload | Stop the `llama-server` process |
| Manual load | Respawn the process through the existing start path |
| Offload to RAM | Disabled, with a tooltip stating EXL3 only |

`ManagedLlamaRuntime.unloadPreset()` (`src/status-server/managed-llama-runtime.ts:45-47`) stops being a no-op and reuses the stop path already used by preset switching. `llama-server` has no sleep, wake, or unload HTTP route: its full route table (`tools/server/server.cpp:233-294`) exposes none, and sleep is driven only by the task-queue timer. Stopping the process is therefore the available mechanism, at the cost of paying full process startup on the next load.

This produces a deliberate asymmetry that is documented rather than hidden: on llama presets, `IdleAction: 'unload'` puts `llama-server` to sleep with the process still running, while the manual unload button stops the process. Both free VRAM.

`GET /props` reports `is_sleeping` (`tools/server/server-context.cpp:4543`), which would let `modelState` reflect real llama.cpp residency instead of being inferred from process state. This is deliberately **out of scope**. Consuming it needs either a background poller or a probe on the hot `/runtime/inference` route, and it buys only cosmetic accuracy: a sleeping `llama-server` still wakes on any request, so the Load button is unnecessary in that state and the Unload button works regardless. The consequence accepted here is that a llama preset whose `llama-server` has slept on its own timer still reports `modelState: 'ready'`.

## EXL3 RAM offload

The required primitives already exist in exllamav3 and are exercised in-tree by the quantizer:

- `Module.__iter__` yields a module and all descendants recursively (`modules/module.py:52-55`).
- `Module.get_tensors()` returns a module's own tensors keyed exactly as in the safetensors collection, implemented for every module type including EXL3 quant (`modules/quant/exl3.py:94-107`) and delegated by `Linear.get_tensors()` (`modules/linear.py:406-410`).
- `SafetensorsCollection.set_new_tensors()` (`loader/safetensors.py:583`) installs an in-memory override that `get_tensor()` prefers over disk (`loader/safetensors.py:403-407, 419-423`).
- `conversion/convert_model.py:1126-1156` performs exactly this collect-unload-reinstall-reload round trip per module.

Two methods are added to `ExllamaV3Container` in the TabbyAPI fork:

```python
async def offload_to_ram(self):
    # under load_lock, after wait_for_jobs
    tensors = {}
    for top in self.model.modules:
        for m in top:
            tensors.update({k: v.to("cpu") for k, v in m.get_tensors().items()})
    await self.generator.close();  self.generator = None
    self.cache = None
    self.model.unload()
    gc.collect();  torch.cuda.empty_cache()
    self.ram_tensors = tensors

async def restore_from_ram(self):
    self.model.config.stc.set_new_tensors(self.ram_tensors)
    try:
        self.load_model_sync()
    finally:
        self.model.config.stc.set_new_tensors(None)
    self.ram_tensors = None
    await self.create_generator()
```

Three constraints are load-bearing:

1. `self.model`, `self.config`, and `self.tokenizer` must stay alive, unlike the existing `unload()` which nulls them (`backends/exllamav3/model.py:761-775`). `Linear._storage_size` is a `@cached_property` that calls `stc.get_tensor_sizes()` (`modules/linear.py:574-578`), and `get_tensor_sizes` asserts `new_tensors is None` (`loader/safetensors.py:281`). Keeping the object alive keeps that cache warm so the layer-split planner never re-enters the asserting path.
2. `set_new_tensors(None)` must run in a `finally`, and `ram_tensors` must be dropped after a successful restore. `SafetensorsCollection.close()` also asserts `new_tensors is None` (`loader/safetensors.py:563`), so leaving the override installed breaks the next full unload. This matches `convert_model.py:1155`.
3. Draft and vision models receive the same treatment when `use_draft_model` or `use_vision` is set, since each is a separate `Model` instance with its own module tree.

Host RAM cost is approximately the model's VRAM footprint, held only while offloaded. Dropping the copy on restore means the next offload re-extracts through a device-to-host copy, which is cheap relative to a disk reload.

TabbyAPI gains `POST /v1/model/offload` and `POST /v1/model/restore`, both admin-key, alongside the existing `/v1/model/unload` (`endpoints/core/router.py:211`). `PresetRuntimeCoordinator.ensureActivePresetReady()` (`src/status-server/preset-runtime-coordinator.ts:78-94`) routes to restore rather than a cold load when the model state is `'offloaded'`, so an incoming request auto-wakes from RAM.

Offload must not reuse `ManagedTabbyRuntime.unloadPreset()`. That method stops the entire TabbyAPI process when `shouldManage(preset)` holds, which is `engine.Managed && !preset.ExternalServerEnabled` (`src/status-server/managed-tabby.ts:114-117, 293-295`); only external servers take the `/v1/model/unload` branch. A stopped process cannot hold weights in its own address space, so `offloadPreset()` is a new method that always talks to the running server over HTTP and never touches `stopProcess()`. Restore likewise calls `/v1/model/restore` rather than the managed load path, which uses `verifyResident` rather than `/v1/model/load` (`src/status-server/managed-tabby.ts:258-274`).

This work is expected to land entirely in the TabbyAPI fork with no exllamav3 patch, on the strength of constraint 1. If implementation proves an assert still fires, the fallback is relaxing it in exllamav3, which means maintaining a fork of a pinned pip dependency (`turboderp-org/exllamav3@8e08af9`, installed to site-packages). The implementation plan must make this an explicit checkpoint before further EXL3 work proceeds.

## Dashboard

Preset configuration replaces the bare `SleepIdleSeconds` input at `dashboard/src/tabs/settings/ModelPresetsSection.tsx:485`:

```
When idle  [ Full unload  v ]   after [ 600 ] seconds
           Stay resident
           Offload to RAM   (EXL3 only)
           Full unload
```

The seconds input disables when `Stay resident` is selected. `Offload to RAM` disables on llama presets through the existing compatibility gating, which already drives field availability in this section.

Runtime actions are separate, because they act on the applied preset rather than the preset being edited. A button row sits beside the runtime status readout at `dashboard/src/tabs/settings/ModelPresetsSection.tsx:206`:

```
Runtime: exl3-main · exl3 · ready/ready
[ Load ]  [ Offload to RAM ]  [ Unload ]
```

Availability derives from `modelState`: `Load` when `'unloaded'` or `'offloaded'`, `Offload to RAM` when `'ready'` on an EXL3 backend, `Unload` when not already `'unloaded'`. A 409 refusal renders inline with its reason. Keeping these buttons out of the preset editor prevents the implication that they apply to the preset under edit rather than the one that is running.

## Testing

| Layer | Coverage |
| --- | --- |
| Config | `IdleAction` enum parse and default; `server_idle_action` migration defaults to `'unload'`; existing presets unchanged |
| Compatibility | `'ram'` rejected on llama presets |
| llama args | `'none'` produces `--sleep-idle-seconds -1`; `'unload'` produces the configured seconds |
| Idle controller | `'none'` never arms a timer; `'ram'` calls offload; `'unload'` calls unload |
| Coordinator | Manual unload, load, and offload each refuse on active requests, pending switch, and wrong backend, with no backend side effect |
| Routes | 409 when busy; 200 and the correct state transition otherwise |
| E2E, EXL3 | Offload drops `nvidia-smi` VRAM by approximately the model size; restore returns to `'ready'`; greedy generation is byte-identical to the pre-offload result |
| E2E, llama | Unload stops the process; load respawns it and serves a request |

Idle-controller and coordinator tests extend the refusal-predicate pattern established in `docs/superpowers/plans/2026-08-06-idle-unload-refusal-coverage.md`. The EXL3 E2E case is the acceptance criterion for RAM offload: VRAM measurably freed, and weights intact across the round trip.

## Scope

In scope: the SiftKit config, contracts, status-server, idle controller, coordinator, llama runtime, and dashboard changes described above; the TabbyAPI fork changes for offload and restore.

Out of scope: RAM offload on llama.cpp; any llama.cpp source change, including adding a sleep or wake route; LoRA and embedding-model residency; multi-preset concurrent residency. No compatibility shims or parallel code paths: `IdleAction` fully replaces the implicit always-unload behavior, and any unmigrated call site must fail loudly.

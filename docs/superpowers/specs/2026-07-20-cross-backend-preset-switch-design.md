# Cross-Backend Preset Switch Design

## Problem

Switching from an active EXL3 preset to a llama preset fails because `ManagedLlamaRuntime` receives the target preset but starts llama.cpp through `ensureManagedLlamaReady`, which rereads the persisted configuration. `PresetRuntimeCoordinator.applyConfig` intentionally keeps the previous preset active until the target is ready, so the reread resolves the EXL3 preset and passes its model directory and base URL to llama.cpp.

The resulting rejected switch also escapes `ConfigUpdateEndpoint`, which terminates the status server instead of returning an error response after rollback.

## Design

The managed llama lifecycle will gain an explicit target-preset startup path. `ManagedLlamaRuntime.ensurePresetReady` will use that path so all launch, readiness, cleanup, and runtime-snapshot operations derive from the supplied llama preset while the persisted active preset remains unchanged.

The existing general startup path will continue to resolve the active preset from persisted configuration for non-switch callers. Both paths will share one internal implementation that operates on a fully resolved configuration, avoiding duplicated startup logic.

`ConfigUpdateEndpoint` will catch failures from `PresetRuntimeCoordinator.applyConfig` and return HTTP `503` through the existing structured server-error response. The coordinator remains responsible for restoring the previous preset and runtime. No failed target is persisted as active.

## Data Flow

1. Dashboard submits a configuration selecting a different preset.
2. Coordinator writes edited preset definitions while retaining the current active preset ID.
3. Coordinator passes the target preset to its backend runtime.
4. Llama runtime constructs a launch configuration whose active preset is the explicit target.
5. On success, coordinator persists the target active ID.
6. On failure, coordinator restores the previous preset and the route returns `503` without terminating Node.

## Testing

- Add a regression test proving managed llama startup uses the explicitly supplied target preset while persisted configuration still points to EXL3.
- Add route-level coverage proving a failed preset switch returns `503`, preserves the previous active preset, and leaves the server responsive.
- Run focused switching/lifecycle tests, typecheck, and the full test suite.

## Scope

No compatibility shim, schema change, dashboard change, or unrelated lifecycle refactor is included.

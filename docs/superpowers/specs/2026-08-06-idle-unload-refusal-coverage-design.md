# Idle-unload refusal coverage design

## Problem

The applied-preset drift regression proves only that releasing the final request arms an EXL3 idle deadline. It does not prove that timer expiry unloads the applied EXL3 runtime after configuration drift. `PresetRuntimeCoordinator.unloadActivePresetForIdle()` also has no direct tests for its refusal conditions, even though those checks replaced a config-derived guard with applied-state semantics.

## Required behavior

- After the configured preset is renamed while the original EXL3 preset remains applied, idle expiry unloads the applied EXL3 runtime.
- Idle unload refuses a mismatched preset identifier.
- Idle unload refuses while model requests are active.
- Idle unload refuses while a preset switch is pending.
- Idle unload refuses a non-EXL3 applied preset.
- Idle unload refuses an EXL3 runtime whose model state is not ready.
- Every refusal returns `false` and performs no additional unload.
- Existing successful idle-unload and admission behavior remains unchanged.

## Design

Strengthen the existing queue-level drift regression through public behavior. Keep the real one-second idle timer, wait with an existing bounded polling helper, and assert that the queue runtime records `unload:exl3`. This covers the deleted config guard and the surviving applied-state check together without adding a production clock or timer seam.

Add focused coordinator tests for each refusal predicate. Reuse the existing recording runtimes, active-request map, pending-switch flow, and runtime state transitions. Assert the boolean result and unchanged event list so the tests verify both refusal and absence of backend side effects.

Production code remains unchanged. The implementation is one discrete repo-agent task; the primary agent reviews its diff and independently runs all required validation.

## TDD sequence

1. Add the strengthened drift-expiry assertion and the focused refusal tests.
2. Temporarily restore the deleted config-derived expiry guard and confirm the drift-expiry test fails because no unload occurs; restore the current implementation.
3. Temporarily weaken the coordinator refusal checks and confirm the corresponding tests fail; restore the current implementation.
4. Run the focused test files and confirm they pass against the restored production code.
5. Run the broader applicable suite, `npm run typecheck`, and `npm run lint`.

## Scope

Only tests and test fixtures may change. No production timer hooks, clock injection, compatibility paths, or unrelated refactors are permitted. No commit is created unless explicitly requested.

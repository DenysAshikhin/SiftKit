# Global Parallel-Slot Queue Design

## Goal

Use the active model preset's `ParallelSlots` value as one global concurrency limit for all model-backed SiftKit operations.

`ParallelSlots: 1` permits exactly one active model-backed request. `ParallelSlots: 2` permits exactly two. Additional requests wait in the existing global FIFO queue until an active request finishes.

## Scope

The shared limit covers every operation already admitted through the model-request lock, including summary, repo-search, repo-agent, dashboard chat, dashboard plan, dashboard repo-search, preset runs, evaluation runs, and inference-passthrough workloads. Each operation consumes one slot regardless of route. All existing model-invoking routes already converge on the same admission functions.

This change applies equally to managed llama.cpp and EXL3 presets. Backend-internal scheduling remains responsible for work after SiftKit admits it, but it does not replace SiftKit's global admission limit.

## Architecture

Keep the existing `activeModelRequests` map, `modelRequestQueue` FIFO, waiter timeout handling, disconnect cancellation, and release lifecycle. Change the shared capacity calculation to return the applied active preset's positive integer `ParallelSlots` value instead of branching on backend type. The runtime coordinator exposes that value explicitly; contexts without a coordinator read the normalized active preset from configuration.

All model-backed route handlers use the same admission class and lifecycle:

1. Acquire one global model-request slot using the applied active preset's capacity.
2. While holding that slot, run the existing active-preset readiness check. A readiness failure releases the slot through the same `finally` path before another waiter is admitted.
3. Execute the operation.
4. Release the slot in `finally` on success, failure, cancellation, or disconnect.
5. Grant queued requests in FIFO order until the number of active requests reaches `ParallelSlots`.

No per-route or per-backend queue is introduced.

## Configuration Semantics

`ParallelSlots` remains normalized to a finite positive integer. The active preset is the single source of truth for both backend parallelism and SiftKit admission capacity.

Preset changes retain the existing application behavior: an explicit restart or the runtime coordinator's lazy preset activation applies the new preset after active work drains. Admission continues using the currently applied preset during that drain. During the transition, new requests join the FIFO and no queued request is granted. The new capacity takes effect once activation succeeds. A failed switch retains the restored preset's capacity.

## Failure and Cancellation Behavior

Queue timeout, client disconnect, nested owner-run rejection, backend-transition pausing, and diagnostic reporting retain their current behavior. Every admitted request must release exactly one slot. A queued request that times out or disconnects consumes no slot and is removed from the queue.

Failures remain loud: missing or invalid active-preset state must not silently fall back to unlimited concurrency or backend-specific defaults.

## Testing

Follow TDD with behavior-first integration coverage where practical:

- `ParallelSlots: 1` serializes requests across different operation kinds.
- `ParallelSlots: 2` admits exactly two requests and queues the third.
- Both llama.cpp and EXL3 obey the same configured limit.
- Completion, failure, abort, and disconnect release capacity and admit the next FIFO waiter.
- A preset transition changes capacity only after the new preset is applied.
- Backend transitions continue to pause admission.
- Queue diagnostics report the correct active and queued requests.
- Inference-passthrough model work cannot bypass the shared limit.

Run the focused queue and HTTP/integration suites, then the full test suite, typecheck, and branch-coverage validation.

## Non-Goals

- Per-route, per-command, or per-backend concurrency limits.
- Priority scheduling or queue reordering.
- Compatibility with the old backend-specific admission rules. The old llama.cpp serialization and EXL3 unlimited admission behaviors are intentionally removed.
- Changes to backend batching beyond the existing `ParallelSlots` mappings.

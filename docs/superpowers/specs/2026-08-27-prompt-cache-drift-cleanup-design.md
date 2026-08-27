# Prompt-Cache Drift Cleanup Design

## Goal

Make prompt-cache state immutable, explicit, and traceable. Active derived requests must prove their relationship to the exact prior planner request. Operations without a prior request must declare a new cache epoch instead of manufacturing a self-validating prefix.

## Cache state

`ExecutingPlannerRequest` becomes an immutable value containing:

- readonly serialized message bytes;
- a copied readonly set of thinking flags;
- one validated readonly planner-tool value plus its serialized bytes;
- the originating slot.

Capture clones all mutable inputs. Approval and terminal synthesis consume the captured tools directly; no consumer reparses `serializedToolsJson`.

Every provider request receives complete `PlannerThinkingFlags`. The protocol layer does not silently convert missing cache-shaping fields to `false`.

## Compaction origins

Compaction has two explicit origins:

- `planner`: carries the actual `ExecutingPlannerRequest` from the most recent provider call. Completed history may extend that request or branch from one of its message boundaries, but all shared messages, tools, flags, and slot must match.
- `new_epoch`: carries complete flags, tools, and slot for first-turn overflow or manual condensation, where no prior provider prefix exists.

`requestContextCompactionSummary` never captures its own prefix. For `planner`, it derives and validates a branch contract from the originating snapshot before HTTP. For `new_epoch`, it sends an explicitly uncached-root compaction request.

`PromptPreparer.prepareTurn` receives the current executing snapshot from `TaskLoop` and selects `planner` only when that snapshot exists. Manual `condenseChatSession` always selects `new_epoch`.

## Epoch telemetry

One shared logging function emits `prompt_cache_epoch_reset` only after summary installation succeeds. Active compaction calls it after `TranscriptManager.replaceWith`; manual condensation calls it after `saveChatSession`. Manual events use `turn: null` and the session id as `taskId`.

## Tests

- Mutation test proves capture is isolated from later flag/tool input mutation.
- Provider-boundary tests prove a real captured planner body can be extended or branched for compaction, while divergence fails before logging and HTTP.
- Standalone condensation proves an explicit new epoch and reset event.
- Terminal request expectations use hand-written literals, not production serialization helpers.
- Compaction integration compares its body to an actually captured preceding planner body.
- Existing terminal regression tests receive a deliberate temporary mutation check, then are restored and rerun green.

## Non-goals

- No change to compaction retention, summary contents, retry counts, output-token policy, approval behavior, live narration, or provider transport.
- No compatibility path for the self-captured compaction prefix.
- No new class, strategy interface, callback dependency, worktree, or commit.

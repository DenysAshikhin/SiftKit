# Run `full` Gate Refactor Design

## Goal

Remove the split retry-state bandaid while preserving the intended validation-output behavior: the first `full` validation run is downgraded, the immediately following identical `full` run is granted once, every other validated `run` consumes or forfeits that grant even when later rejected, and a third identical `full` run is duplicate-rejected.

Also repair the planner tool-description encoding and replace session-added test literals for the validation line limit with the existing production constant.

## Architecture

`ToolActionProcessor` owns one `RunFullOutputGate`. Immediately after a tool action has been validated, every `run` action is classified through one state-transition method. That method receives the command, requested output mode, and validation-command classification, mutates gate state exactly once, and returns an immutable decision.

The decision distinguishes these outcomes:

- pass through the requested mode;
- downgrade `full` to `auto` and append the notice;
- grant the pending identical `full` retry;
- reject an identical `full` call after its retry has already been consumed.

Duplicate screening reads the decision instead of querying mutable gate state. Native execution receives the same decision and applies its effective mode and notice flag. `executeRun` no longer advances gate state.

This replaces `completedRetryCommand`, `isPendingRetry`, `isCompletedRetry`, and the processor's parallel retry checks. It does not change `DuplicateTracker` semantics for ordinary failed commands.

## Data Flow

1. Validate the tool action and normalize its command.
2. For a `run`, parse `outputMode`, classify whether the command is a validation command, and call the gate once.
3. Screen duplicates using the returned decision. A granted retry bypasses ordinary duplicate rejection; a consumed retry is rejected as an exact duplicate.
4. Perform approval review. Because the gate already transitioned, an approval denial still consumes or forfeits the prior grant.
5. Execute the native run with the decision's effective mode.
6. Append `RUN_FULL_DOWNGRADE_NOTICE` only when the decision says the request was downgraded.

Non-`run` tools never call the gate and therefore do not affect pending retry state.

## Types and Boundaries

The gate decision is a discriminated TypeScript type. No `any`, casts, non-null assertions, namespace imports, or unvalidated IO are introduced. `RunOutputModeSchema` remains the runtime parser for `outputMode`.

The processor passes a required run decision to the native run execution path. There is no optional compatibility path and no second state transition in `executeRun`.

## Text and Constants

The planner tool description uses an ASCII hyphen instead of the malformed mojibake dash sequence.

Tests import `REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT` instead of repeating `50`. Noisy fixture sizes are derived from the constant so boundary coverage follows the production limit.

## Testing

TDD adds failing processor-level regression tests before the refactor:

- a different validated run rejected as a duplicate forfeits the pending grant;
- a granted retry denied by approval is consumed;
- the first downgrade, one raw retry, and third-call rejection remain intact;
- non-run tools do not forfeit a pending grant.

Existing gate and repo-tool tests are updated to exercise immutable decisions without mirroring production constants. Prompt/model tests verify the corrected tool description through its rendered consumer boundary.

Validation includes focused gate, repo-tools, processor, prompt, and model-json suites, followed by `npm run typecheck` and `npm run lint`. The known unrelated `repo-agent-sessions` full-suite blocker remains outside this refactor.

## Scope

Expected source changes:

- `src/repo-search/engine/validation-command-output-policy.ts`
- `src/repo-search/engine/tool-action-processor.ts`
- `src/repo-search/engine/repo-tools.ts`
- `src/repo-search/planner-protocol.ts`

Expected test changes:

- `tests/validation-command-output-policy.test.ts`
- `tests/repo-tools.test.ts`
- `tests/engine-tool-action-processor.test.ts`
- `tests/repo-search-planner-protocol.test.ts`

No compatibility shim, commit, dependency, or unrelated refactor is included.

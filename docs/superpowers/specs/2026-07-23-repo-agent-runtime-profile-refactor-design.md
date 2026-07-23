# Repo-Agent Runtime Profile Refactor

Date: 2026-07-23

## Goal

Replace the three session-introduced drift points with first-class typed architecture:

1. Remove the run-only `outputMode` branch from `ModelJson`.
2. Remove nullable validation-line-limit plumbing from the generic task loop.
3. Remove duplicated output-mode and line-limit metadata.

The refactor must preserve the approved behavior:

- repo-agent defaults to 100 turns;
- an explicit positive `maxTurns` value overrides that default;
- repo-agent fails loudly on context exhaustion without transcript compaction;
- other task kinds retain compact-on-overflow behavior;
- repo-agent validation commands retain their final 50 lines in automatic mode;
- `outputMode: "full"` bypasses only the fixed 50-line cap;
- normal tool-result token fitting remains active;
- command exit codes remain unchanged.

## Constraints

- Work inline on `main`; do not create a worktree.
- Do not use SiftKit during implementation or validation.
- Follow strict TDD: every production change follows a failing test.
- Use TypeScript and runtime schemas with `z.infer`.
- Do not add casts, `any`, non-null assertions, namespace imports, compatibility adapters, or dynamically passed functions.
- Remove the replaced APIs completely.
- Keep the implementation focused on the three findings.

## Architecture

### Runtime profile

Add a `RepoSearchRuntimeProfile` class created once by `runRepoSearch` from the exact execution task kind.

Define `RepoSearchTaskKindSchema = z.enum(['plan', 'repo-search', 'chat', 'repo-agent'])` and derive `RepoSearchTaskKind` with `z.infer`. `RepoSearchExecutionRequest.taskKind` uses that inferred type.

The profile owns:

- the default maximum turn count;
- the context-overflow policy;
- validation-command output behavior.

The profile accepts an explicit maximum-turn override and resolves it ahead of loop construction. Non-agent task kinds use the existing engine default.

`executeRepoSearchRequest` passes the normalized task kind and explicit override. `runRepoSearch` requires that task kind, so every direct caller is migrated and no implicit compatibility default remains. The request executor no longer selects the three repo-agent policies independently.

The same profile instance is supplied to `PromptPreparer` and `ToolActionProcessor`. It replaces:

- `RunTaskLoopOptions.contextOverflowPolicy`;
- `RunTaskLoopOptions.validationCommandOutputLineLimit`;
- `ToolActionProcessorDeps.validationCommandOutputLineLimit`;
- `RepoToolContext.validationCommandOutputLineLimit`.

No nullable line-limit value crosses the engine layers.

### Canonical native-tool schemas

Add one native-tool argument module containing Zod schemas for:

- `read`;
- `grep`;
- `find`;
- `ls`;
- `write`;
- `edit`;
- `run`;
- `web_search`;
- `web_fetch`.

Create a discriminated `RepoNativeToolCallSchema` whose variants contain `toolName` and the corresponding typed `args`. Derive all call and argument types with `z.infer`.

The schema replaces `REPO_TOOL_ARG_SPECS`. `ModelJson` validates native calls through the discriminated schema and has no run-specific argument branch.

`ToolActionProcessor` validates the native call at its execution boundary and passes the parsed call to `executeRepoTool`. `executeRepoTool` dispatches on the typed discriminant and does not parse loose `JsonObject` arguments independently.

Read-only command tools such as `git` keep their existing command-token safety validation because they are not native-tool calls.

### Output-policy placement

Native `run` execution returns raw combined output and the original exit code.

After execution, `ToolActionProcessor` applies `RepoSearchRuntimeProfile` to the typed run call and raw output. This keeps presentation policy out of the command executor and removes runtime-profile data from `RepoToolContext`.

The profile:

- returns non-agent output unchanged;
- returns non-validation output unchanged;
- returns `outputMode: "full"` output unchanged;
- otherwise applies `ValidationCommandOutputPolicy` with the canonical 50-line limit.

The existing `ToolResultBudgeter` runs afterward.

### Canonical metadata

The native-tool argument module exports:

- `RUN_OUTPUT_MODES`, a literal tuple;
- `RunOutputModeSchema`, created from that tuple;
- the inferred `RunOutputMode` type.

The runtime-profile module exports `REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT`.

The planner tool schema reuses `RUN_OUTPUT_MODES` for its enum and interpolates `REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT` in its description. The repo-agent system prompt uses the same line-limit export.

Zod remains the runtime source of truth for tool arguments. Planner JSON Schema stays explicitly authored because the llama.cpp structured-output contract supports a restricted schema shape and existing guards prohibit unsupported unions.

## Data Flow

1. `RepoSearchExecutionRequest.taskKind` is normalized to `repo-search` when absent.
2. `executeRepoSearchRequest` passes the exact normalized task kind and optional `maxTurns`.
3. `runRepoSearch` creates one `RepoSearchRuntimeProfile`.
4. The profile resolves the loop turn limit.
5. `PromptPreparer` reads the profile overflow policy.
6. `ModelJson` validates model-authored native calls with `RepoNativeToolCallSchema`.
7. `ToolActionProcessor` validates the call again at the execution boundary.
8. `executeRepoTool` executes the typed call and returns raw output.
9. `ToolActionProcessor` applies profile output policy to run results.
10. General tool-result fitting prepares the final transcript result.

## Failure Behavior

- Invalid native-tool arguments are rejected before execution.
- Invalid `outputMode` values are rejected by the shared schema at both model and execution boundaries.
- Repo-agent context overflow throws the existing detailed overflow error with policy metadata.
- Non-agent overflow still performs the existing single compaction attempt.
- Validation trimming never changes the command exit code.
- No compatibility path accepts the removed scalar policy options or loose run-specific parsing.

## TDD Plan

Implementation will use separate red-green-refactor cycles:

1. Add failing runtime-profile tests covering every task kind, explicit turn overrides, overflow selection, and output-policy selection.
2. Add failing repo-agent integration assertions proving the engine receives profile-derived behavior.
3. Add failing canonical-schema tests for all native tools and invalid boundary values.
4. Add failing parser tests proving native calls use the shared schema.
5. Add failing execution-boundary tests using typed calls and shared validation.
6. Add failing planner-metadata tests comparing the schema enum and description with canonical exports.
7. Add structural regression tests prohibiting `REPO_TOOL_ARG_SPECS`, the run-only `rawArgs.outputMode` branch, and scalar validation-policy plumbing.
8. Remove the obsolete implementations and update every caller without adapters.

Prefer end-to-end tests where behavior crosses the request, engine, tool, and transcript boundaries. Unit tests cover schema branches and runtime-profile decisions that cannot be isolated reliably through an end-to-end fixture.

## Acceptance Criteria

- All three drift findings are removed, not hidden behind wrappers.
- Repo-agent behavior remains 100 turns, fail-on-overflow, and automatic 50-line validation tails.
- Explicit turn overrides and `outputMode: "full"` retain their approved semantics.
- Every native tool uses the canonical discriminated runtime schema.
- Planner metadata cannot drift from output-mode or line-limit exports.
- Removed scalar options and parser metadata have no remaining references.
- Focused tests, typecheck, lint, the complete test suite, and changed-module coverage pass.
- Temporary validation artifacts are removed.

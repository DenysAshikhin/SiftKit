# repo-agent Runtime Limits and Validation Output Design

## Goal

Make `repo-agent` default to 100 model turns, fail immediately when its prompt no longer fits the context window, and keep routine validation commands from flooding the transcript by retaining only their final 50 output lines.

The 100-turn value is a default, not a hard cap. Explicit positive `maxTurns` values remain valid, including values above 100.

## Current Behavior

- The built-in and dashboard `repo-agent` presets default to 80 turns.
- Direct CLI `repo-agent` requests omit `maxTurns`, so they fall through to the shared 45-turn repo-search default.
- `PromptPreparer` performs one compaction pass for every task kind before raising `planner_preflight_overflow`.
- The `run` tool prefers the tail only when token-budget fitting is needed. It has no fixed line cap and does not distinguish validation commands.

## Runtime Policy

### Turn Default

Add `REPO_AGENT_DEFAULT_MAX_TURNS = 100` to `@siftkit/contracts`, the existing shared source for backend and dashboard preset defaults.

Use the constant in:

- the built-in `repo-agent` preset;
- custom `repo-agent` preset normalization;
- dashboard preset-kind defaults;
- the `repo-agent` execution boundary when a request omits `maxTurns`.

The execution-boundary fallback ensures CLI and direct HTTP requests receive 100 turns even when no preset supplied a value. Explicit request values pass through unchanged.

### Context Exhaustion

Introduce an explicit context-overflow policy with two values:

- `compact`: retain the existing one-pass compaction behavior;
- `fail`: skip compaction and immediately raise `planner_preflight_overflow`.

`executeRepoSearchRequest` selects `fail` only for `taskKind: 'repo-agent'`. Plan, repo-search, and chat flows continue to select `compact`.

On repo-agent overflow:

1. preflight computes the prompt, provider reserve, output allowance, and overflow;
2. no transcript messages are removed or summarized;
3. the existing overflow failure event records the token counts and that compaction was disabled;
4. `planner_preflight_overflow` propagates through the streamed endpoint and CLI as a failed run.

There is no terminal synthesis or retry after this error.

## Validation Command Output Policy

Create a focused `ValidationCommandOutputPolicy` class in the repo-search engine. It owns both command classification and fixed-line trimming; callers do not pass classifier or trimming functions dynamically.

### Classification

Classification is case-insensitive and operates on anchored PowerShell command segments rather than loose substring matches. It recognizes:

- package-manager scripts whose names are `test`, `test:*`, `build`, `build:*`, `lint`, `lint:*`, `typecheck`, or `typecheck:*`;
- direct JavaScript/TypeScript validation tools such as Node test mode, Jest, Vitest, Mocha, Playwright, Cypress, TypeScript, and ESLint;
- Python test and validation runners such as pytest;
- .NET build/test commands;
- Cargo build/test/check/clippy commands;
- Go build/test/vet commands;
- Gradle and Maven build/test/check/verify commands;
- CMake build and CTest commands.

Searches, file reads, echo commands, and paths that merely contain words such as `test` or `build` do not match.

### Output Modes

Extend the typed `run` tool arguments with:

```ts
outputMode: 'auto' | 'full'
```

The field is optional and defaults to `auto`.

- `auto`: when repo-agent runs a classified validation command, preserve the final 50 lines.
- `full`: bypass the fixed 50-line policy when complete diagnostics are necessary.

The existing token-budget fitter still applies after either mode. `full` does not permit the transcript to exceed its per-tool or remaining-context budgets.

### Trimming

For matching commands in `auto` mode:

- 50 or fewer lines remain unchanged;
- more than 50 lines become an omission notice followed by exactly the final 50 lines;
- LF, CRLF, and CR inputs are handled consistently;
- the process exit code is never altered;
- both successful and failed command output are treated identically.

The policy applies only to repo-agent's native `run` tool. Other task kinds and non-`run` tools keep their current behavior.

## Agent Prompt

Update `buildAgentSystemPrompt` to state:

- test, build, lint, typecheck, and equivalent validation output is automatically reduced to the final 50 lines;
- the agent should rely on automatic trimming rather than adding shell pipelines or temporary redirection;
- `outputMode: "full"` is available only when complete output is required for diagnosis;
- normal validation should remain in `outputMode: "auto"`.

The prompt and execution policy share the same exported 50-line constant so documentation cannot drift from behavior.

## Data Flow

1. A repo-agent request enters `executeRepoSearchRequest`.
2. Missing `maxTurns` resolves to `REPO_AGENT_DEFAULT_MAX_TURNS`; an explicit value is retained.
3. The request passes `contextOverflowPolicy: 'fail'` and the repo-agent validation-output limit into `runRepoSearch`.
4. `TaskLoop` gives the overflow policy to `PromptPreparer` and the validation policy to `ToolActionProcessor`.
5. `PromptPreparer` throws before compaction when repo-agent preflight overflows.
6. For `run`, `executeRepoTool` executes the original PowerShell command unchanged, then applies `ValidationCommandOutputPolicy` to the captured output.
7. The original exit code and policy-filtered output continue through result budgeting, progress events, transcript insertion, and scorecard recording.

## Testing

Follow TDD for each behavior.

### Turn Default

- Contract constant equals 100.
- Built-in preset, custom preset fallback, and dashboard preset editor all use 100.
- A repo-agent execution with omitted `maxTurns` reports 100 in its first progress event.
- An explicit `maxTurns` value, including one above 100, is preserved.
- Repo-search and plan defaults remain unchanged.

### Context Exhaustion

- `PromptPreparer` in `fail` mode rejects an overflowing transcript that would fit after compaction.
- The transcript remains byte-for-byte unchanged.
- No compaction event is logged; the overflow event states that compaction was disabled.
- `compact` mode continues to compact the same fixture successfully.
- A repo-agent execution selects `fail`; non-agent executions select `compact`.

### Validation Classification and Trimming

- Positive coverage for each supported command family.
- Negative coverage for searches, reads, echoes, filenames, and unrelated scripts containing validation words.
- Boundary coverage for 0, 49, 50, and 51 lines.
- LF, CRLF, and CR coverage.
- Successful and failing command exit codes remain unchanged.
- `outputMode: 'full'` bypasses the fixed cap.
- Non-agent and non-validation commands remain unchanged.

### Prompt and Schema

- The `run` schema accepts only `auto` and `full`.
- Invalid output modes fail validation.
- The agent prompt names the 50-line behavior and the explicit full-output escape hatch.

Run the focused tests first, then the complete test, typecheck, and coverage suites. Coverage must exercise every classifier branch and both overflow-policy branches.

## Non-Goals

- No hard 100-turn cap.
- No context compaction changes for plan, repo-search, or chat.
- No shell command rewriting or automatic PowerShell pipelines.
- No fixed-line trimming for discovery commands or non-agent modes.
- No raw-output archive or legacy behavior switch.

# Session Drift Remediation Design

**Date:** 2026-08-19

## Goal

Remove the three concrete drift points found after the verbatim-write/path-guidance change: migrate every affected repo-agent fixture to the finish-reaffirmation protocol, replace the stringly typed native-tool argument table with canonical Zod schemas, and make the path-guidance test assert semantic obligations without duplicating the production sentence.

## Scope

This is a focused refactor. It reuses the canonical native-tool schema seam described in `docs/superpowers/plans/2026-07-23-repo-agent-runtime-profile-refactor.md`, but it does not execute that plan's unrelated runtime-profile, output-policy, or execution-dispatch migrations.

In scope:

- Native repo-tool model-argument validation in `ModelJson`.
- Shared ownership of `RunOutputModeSchema` and its inferred type.
- Repo-agent mock responses in `tests/repo-search-agent-execute.test.ts` and `tests/streamed-repo-agent-endpoint.test.ts` that are expected to finish successfully.
- The agent path-separator prompt regression.

Out of scope:

- Changing `PATH_CONTROL_ESCAPES` or `COMMAND_PATH_CONTROL_ESCAPES`.
- Changing write execution or CRLF behavior.
- Converting `executeRepoTool` to accept a typed discriminated call.
- Moving runtime-profile/output-shaping policy through the engine.
- Live-model prompt evaluation.

## Architecture

### Canonical native-tool argument schemas

Create `src/repo-search/repo-tool-arguments.ts` as the single model-IO boundary for native tool arguments. Each tool gets a strict Zod argument schema, and `RepoNativeToolCallSchema` forms a discriminated union keyed by `toolName`. Types are derived exclusively with `z.infer`.

The schemas preserve the existing normalization contract:

- Required paths, patterns, commands, queries, and URLs are trimmed and must remain non-empty.
- Path fields repair JSON-consumed Windows separator control characters.
- `run.command` repairs only recoverable command-path control characters; deliberate newlines remain intact.
- `write.content`, edit `oldText`, and edit `newText` are never trimmed or separator-repaired.
- `write.content` and edit `oldText` must have length at least one, so whitespace-only write content remains legal while the empty string fails.
- Optional values are validated strictly instead of being passed through for a later layer to reject.
- The removed `timeout` key fails at the model boundary; only positive integer `timeoutMs` is accepted.

`ModelJson.normalizeRepoSearchToolCall` retains its separate raw `git` command branch, then parses every native call with `RepoNativeToolCallSchema`. `REPO_TOOL_ARG_SPECS`, its generic validation loops, and the run-only `outputMode` branch are deleted completely.

`REPO_TOOL_REGISTRY` remains the model-facing JSON Schema/description catalog because the repository has no Zod-to-JSON-Schema conversion layer; it is not a second runtime validator. Shared closed metadata such as `RUN_OUTPUT_MODES` comes from the canonical argument module so the two declarations cannot disagree on allowed values.

`RunOutputModeSchema` and `RunOutputMode` move from `engine/validation-command-output-policy.ts` into the canonical argument module. Existing execution-time validation may import the shared schema, but no compatibility export remains in the old module.

### Repo-agent finish fixtures

Create `tests/helpers/repo-agent-mock-responses.ts` with one explicit helper:

```ts
export function repoAgentFinishResponses(output: string): string[] {
  const response = JSON.stringify({ action: 'finish', output });
  return [response, response];
}
```

Every repo-agent test that expects successful completion appends or spreads these two responses. Tests whose finish response must never execute, or whose run intentionally ends in `approval_required`, keep their existing fixture until the resumed run needs to finish. The helper removes duplicated JSON and makes the protocol requirement visible at each call site.

### Semantic prompt contract

The production guidance remains concise and model-facing. The prompt test stops copying the entire sentence. It instead asserts the independent semantic obligations:

- forward slashes are preferred;
- guidance explicitly applies inside `run` commands;
- native executables may require backslashes;
- each required backslash must be represented as `\\` in the emitted prompt;
- unescaped JSON backslashes are described as corrupting arguments.

This is the strongest deterministic contract available without a live model: the behavior under test is the generated system prompt, while wording outside those obligations remains free to change.

## Error Handling

Zod parse failures return the existing `invalid planner tool action` error family. No fallback to the removed table is allowed. Unknown tools, extra keys, wrong scalar types, empty required values, invalid enums, and removed argument names fail loudly at the model boundary.

## Testing

Use TDD for the schema replacement and fixture migration:

1. Add canonical-schema and structural-removal tests and observe them fail while the new module/table replacement is absent.
2. Run the existing repo-agent integration files and observe the known `mock_responses_exhausted` failures before migrating fixtures.
3. Implement the smallest complete schema replacement and fixture helper/migration, then rerun the focused suites.
4. Refactor the prompt test to semantic clauses and mutation-check each clause by temporarily removing the corresponding production wording during implementation review; no production prompt change is required unless a semantic assertion exposes a gap.
5. Run `npm run typecheck`, `npm run lint`, and the complete test suite.

## Constraints

- No worktree.
- No SiftKit.
- No commits.
- Preserve unrelated changes.
- TypeScript only; no `any`, assertions, non-null assertions, namespace imports, or duplicated IO types.
- Complete replacement only: no compatibility export, fallback parser, or parallel validation path.

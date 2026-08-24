# Unified Planner Protocol Design

## Problem

Planner actions are currently defined independently in four places:

- TypeScript action unions;
- runtime parsing and validation;
- model-facing prompt instructions;
- provider `response_format` JSON Schemas.

The `progress` action exposed the failure mode. The repo-search prompt, TypeScript union, parser, and task loop accepted `progress`, but the provider JSON Schema omitted it. ExL3 constrained decoding therefore could not emit a top-level progress action. The model preserved its unfinished intent by serializing a progress action inside `finish.output`, and the finish-verification path eventually accepted that terminal envelope.

The migration passed tests because parser tests injected JSON directly and the progress E2E test used `mockResponses`, which returns before provider request construction. No contract test compared the prompt/parser action set with the schema actually sent to either backend.

## Goals

- Define each repo-search and summary-planner action exactly once.
- Infer TypeScript types from runtime schemas with `z.infer`.
- Derive provider JSON Schemas from the same canonical definitions.
- Derive machine-facing action instructions and examples from canonical action metadata.
- Preserve intentional protocol differences explicitly:
  - repo-search/repo-agent supports non-terminal `progress` and an output-only `finish`;
  - summary planner does not support `progress` and requires classified finish fields.
- Keep backend-specific schema lowering as a transport-only transformation.
- Make a future partial action migration fail focused contract tests.
- Remove obsolete manual action types, parser branches, prompt declarations, and provider schema variants.

## Non-goals

- Add task-specific completion heuristics based on edits, commands, tests, or files.
- Change finish-verification policy or its challenge count.
- Make summary planner support progress.
- Change planner tool behavior, permissions, approval semantics, or tool execution.
- Replace the general agent loop.
- Add a JSON Schema dependency.
- Retain compatibility paths for the duplicated protocol definitions.

## Canonical Protocol Model

Create a focused planner-protocol module with shared schema conversion utilities and one descriptor per planner kind.

Each canonical descriptor owns:

- protocol name;
- runtime Zod action schemas;
- action order;
- terminal versus non-terminal classification;
- concise machine-facing description;
- valid JSON example;
- tool definitions used to construct direct-tool and batch variants.

The descriptor produces four artifacts from the same action entries:

1. a Zod union used for runtime parsing;
2. TypeScript action types inferred with `z.infer`;
3. a provider JSON Schema used in `response_format`;
4. prompt lines describing the allowed action shapes.

The descriptor is data plus pure functions. It does not hold mutable state and does not require a class.

### Shared action combinators

Shared combinators construct strict schemas for:

- direct tool actions;
- non-empty tool batches using the canonical wire key `calls`;
- output-only finish actions;
- classified summary finish actions;
- non-terminal progress actions.

Tool action schemas remain parameterized by the allowed tool definitions for the current request. Repo-agent and repo-search continue to use different allowed subsets of the same repo tool registry. Summary planner continues to use its separate tool registry.

The existing TypeScript-only batch shapes using `tool_calls` are removed. The canonical inferred type uses the actual wire key `calls` so runtime, provider, and static shapes agree.

### Repo-search descriptor

The repo-search descriptor contains:

- direct actions for the request's allowed repo tools;
- `tool_batch` over the same allowed tool actions;
- `progress` with a non-empty `output` string and no extra keys;
- `finish` with a non-empty `output` string and no extra keys.

Repo-agent uses this same descriptor because it uses the repo-search engine. Its different tool surface is supplied as an input, not represented by a second action protocol.

### Summary-planner descriptor

The summary descriptor contains:

- direct actions for summary tools;
- `tool_batch` over summary tool actions;
- `finish` with canonical `classification`, `raw_review_required`, and `output` fields.

It intentionally contains no progress entry. That absence is asserted in contract tests and reflected automatically in its parser, prompt instructions, and provider schema.

## Runtime Parsing and Types

Runtime parsing calls the canonical descriptor's Zod schema. Successful parses are mapped into the existing shared `AgentLoopAction` representation. Protocol-specific finish fields remain available on the mapped finish action.

The manual repo-search and summary action validators in `src/lib/model-json.ts` are removed. JSON extraction and repair may remain there, but action membership, required fields, strict-key behavior, batches, and tool arguments are validated by the canonical schemas.

Public planner action types are aliases derived from the relevant canonical Zod schema. Independently maintained `PlannerAction`, `ProgressAction`, batch, finish, and tool-call object types are removed where the canonical inference replaces them.

Invalid input must fail loudly with protocol and action context. Error formatting may translate Zod issues into the existing user-facing planner error style, but it must not accept or normalize an action that the canonical schema rejects.

## Provider JSON Schema

Generate JSON Schema with Zod 4's first-party `z.toJSONSchema(..., { io: 'input' })`, then pass it through a deterministic planner-schema normalization function.

Normalization is limited to provider compatibility:

- express alternatives with `anyOf`, never `oneOf`;
- preserve strict objects with `additionalProperties: false`;
- preserve action `const` discriminators;
- preserve non-empty batch constraints before backend lowering;
- reject unsupported schema constructs rather than silently dropping them.

The normalizer must not add, remove, or rename actions. A test extracts the action constants before and after normalization and requires exact equality.

Existing ExL3 Formatron lowering remains the final backend boundary. It may make optional properties required-and-nullable and relax the known batch `minItems` constraint, but it must preserve the canonical action set. Llama and ExL3 therefore begin from the same canonical schema.

The hand-built repo-search and summary action unions in `src/providers/structured-output-schema.ts` are removed. Generic response-format wrapping and unrelated approval/finish-validation schemas remain.

## Prompt Generation

Machine-facing action membership is rendered from canonical descriptor metadata. Each action entry provides its description and valid example. Tool lists continue to come from the current allowed tool definitions.

Prompts may retain surrounding behavioral guidance, tool-selection rules, and completion expectations. They must not independently declare the set or JSON shape of planner actions.

Prompt contract tests extract every rendered JSON example and parse it through the same descriptor. A separate parity assertion compares the rendered action names with runtime and provider action names.

## Data Flow

For both planner kinds:

1. Select the canonical descriptor and current allowed tool definitions.
2. Build the canonical Zod action schema.
3. Render action instructions from descriptor metadata.
4. Derive and normalize the provider JSON Schema from that Zod schema.
5. Apply backend lowering only when building the ExL3 request.
6. Send the request.
7. Parse the returned action with the same canonical Zod schema.
8. Map the parsed action into the shared agent-loop representation.

No independent action-membership list exists along this path.

## Error Handling

- Canonical schema construction fails if action names collide.
- JSON Schema normalization fails if it encounters an unsupported union or loses an action discriminator.
- Prompt rendering fails if an action lacks a valid example or description.
- Runtime parsing reports schema issues without falling back to a parallel manual parser.
- Contract tests fail if runtime, prompt, canonical JSON Schema, lowered backend schema, or captured wire schema differ in action membership.
- Unsupported future Zod constructs must produce a development-time failure; they are not silently approximated.

## Testing

### Regression test

Add a failing test first proving the current repo-search provider schema omits `progress` while the runtime parser and prompt advertise it. The completed implementation changes this into a parity test that requires `progress` everywhere, including the lowered ExL3 schema and captured request body.

### Canonical descriptor tests

- Every repo-search action example parses.
- Every summary action example parses.
- Repo-search includes `progress`; summary does not.
- Unknown actions, empty output, extra keys, invalid tool arguments, empty batches, and mixed invalid batches fail.
- Inferred batch actions use `calls`, not `tool_calls`.

### Cross-layer contract tests

For each planner kind and representative tool sets, compare the exact ordered action-name set from:

- descriptor metadata;
- runtime Zod alternatives;
- generated canonical JSON Schema;
- normalized provider JSON Schema;
- ExL3-lowered JSON Schema;
- rendered prompt examples;
- captured Llama request `response_format`;
- captured ExL3 request `response_format`.

Any mismatch fails with the missing and extra action names.

### Integration tests

- Replace the mock-only progress regression with a provider-request test that captures the actual response schema.
- Extend the real Formatron corpus with a valid top-level progress payload and require it to compile and accept when the environment-gated integration test runs.
- Preserve existing repo-search, repo-agent, summary-planner, schema-lowering, and agent-loop suites.

## Migration and Removal

This is a complete replacement:

- remove manual repo-search and summary planner action validators;
- remove duplicated planner action object types replaced by `z.infer`;
- remove hand-built repo-search and summary action-union JSON Schemas;
- remove hand-written prompt action membership and shapes;
- remove tests that assert obsolete variant counts or mock-only parity;
- update all consumers to the canonical descriptors in the same change.

There is no compatibility wrapper, fallback parser, legacy schema builder, or parallel prompt path. A missed consumer must fail typechecking or tests.

## Constraints

- TypeScript only.
- No `any`, type assertions, non-null assertions, unknown laundering, or duplicated schema types.
- No new dependency.
- No worktree or commit.
- TDD for each behavior change.
- Preserve unrelated working-tree changes.
- Relevant focused tests, broader applicable suites, `npm run typecheck`, `npm run lint`, and independent verification are required before completion.

## Risks

- Zod may emit provider-incompatible union constructs. The normalizer and schema-shape tests must reject or normalize these explicitly.
- Dynamic tool definitions can make inferred unions difficult to express. The descriptor API must keep tool schemas explicit and avoid type assertions.
- Prompt wording changes can affect model behavior. Only action membership and examples are generated; surrounding established guidance remains stable.
- Summary planner has different finish fields and no progress. Shared combinators must not erase those intentional differences.
- Existing tests may depend on obsolete provider-schema variant counts. They must be rewritten to assert semantic action parity rather than implementation-specific counts.

# Planner Cache Drift Cleanup Design

## Goal

Complete the planner-tool and request-shape refactor so one runtime-derived tool representation flows through request preparation, stage is telemetry only, and the multi-approval cache chain has a repeatable live regression.

## Canonical tool representation

`LlamaCppToolDefinitionSchema` remains the runtime boundary and `LlamaCppToolDefinition` remains its inferred type. `PlannerToolDefinition.function` will reuse the inferred protocol function type instead of the handwritten recursive `LlamaCppToolParameterSchema`; that handwritten type is removed.

Tool registries still retain planner-only metadata (`kind`, `argumentSchema`, and `exampleArgs`). Conversion strips that metadata once per owning runtime. `TaskLoop` passes the resulting protocol tools to `PromptPreparer`, and `SummaryPlannerLoopRuntime` stores one converted array instead of converting in each return branch.

## Explicit response constraints

`PlannerRequestStage` remains required for logging. It no longer selects response schema or schema name. Both the actual request and prompt-reserve APIs receive an explicit response constraint:

- free-form/native-tool requests: `responseSchema: null`
- structured requests: `responseSchema` plus required `responseSchemaName`

The duplicated `finish_validation` branches disappear. Every caller becomes explicit, so adding a stage cannot silently change protocol shape.

## Cache-chain regression

The existing fake-HTTP test is renamed to describe what it proves: byte-prefix and tool-schema continuity. Its hardcoded character/token claim is removed.

An opt-in TypeScript live test uses the production planner and approval request functions against an already-running configured server. It records provider-reported cache/evaluation metrics for:

1. large planner seed (must evaluate more than 32,768 tokens)
2. approval of a 2,048-byte write
3. resumed planner
4. approval of a follow-up write
5. resumed planner
6. resumed planner after an approval-exempt read

Every request after the seed must report cached tokens of at least 90% of the seed evaluation. Both approvals must return `approve` with no reviewer tool calls. The test is skipped unless explicitly enabled, leaving the normal suite deterministic.

## Constraints

- No compatibility path or legacy tool-parameter type remains.
- No `any`, assertions, non-null assertions, namespace imports, or unvalidated IO.
- No commit.
- Existing summary, chat, repo-search, repo-agent, and approval behavior remains covered.

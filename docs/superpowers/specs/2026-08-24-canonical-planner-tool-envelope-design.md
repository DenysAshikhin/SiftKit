# Canonical Planner Tool Envelope Design

> This spec supersedes the tool-envelope, tool-batch, parser-result, and tool-example sections of `2026-08-24-unified-planner-protocol-design.md`. That earlier document remains the historical design for canonical protocol ownership and the repo/summary non-tool action split.

## Problem

Planner tools currently use different shapes at adjacent layers:

- model-facing direct actions flatten tool arguments and overload `action` with the tool name, for example `{"action":"git","operation":"status"}`;
- model-facing batches use `calls`, but each entry repeats the flattened direct-action shape;
- canonical runtime actions use `action: "tool"`, `tool_name`, and nested `args`;
- canonical runtime batches use `tool_calls`, not `calls`;
- the generic agent loop uses camelCase `toolName`;
- native Llama tool calls use `function.name` and serialized `function.arguments`.

This produces misleading recovery errors. Repo-tool arguments are validated after being wrapped in an internal `{ toolName, args }` object, so a missing flattened `operation` is reported to the model as `args.operation`. In the observed repo-agent run, the model followed that internal error path literally and changed a missing-operation Git call into the still-invalid hybrid `{"action":"git","args":{"operation":"status"}}`. Three consecutive invalid actions then ended the run with `invalid_response_limit`.

The same flattened-wire versus nested-runtime mismatch applies to every repo tool and every summary-planner tool. Git is the most visible case because it is a seven-variant discriminated union, but `edit`, `run`, `grep`, `json_filter`, and batch calls have the same envelope ambiguity.

Progress guidance also encourages routine narration through the example `scanning scripts next`. The observed sample emitted fourteen progress actions in thirty-five turns. Progress needs to remain available without being presented as a routine next-step mechanism.

Finally, repo-agent currently maps any normally returned repo-search result to public `status: "completed"`, even when the task reason is `invalid_response_limit` and the persisted scorecard is failed. Transport completion must not be reported as task completion.

## Goals

- Use one planner tool envelope for repo-search, repo-agent, and summary planner.
- Use the same field names in model-facing JSON, runtime schemas, inferred types, parser results, batch entries, prompt examples, validation errors, native-tool reconstruction, transcript helpers, approval review payloads, and tests.
- Keep tool-specific arguments inside `args`, validated by the existing tool argument schemas.
- Generate provider JSON Schemas and prompt examples from the same allowed tool definitions.
- Give every exposed tool a schema-validated example.
- Make progress optional and sparse: meaningful phase changes or long-running checkpoints only.
- Preserve intentional non-tool differences between repo and summary planners.
- Report repo-agent `completed` only when the repo task actually finishes successfully.
- Remove obsolete field names and flattened tool-action paths completely.

## Non-goals

- Rename the tools themselves.
- Make repo `read` and summary `read_lines` share semantics; they address different input domains.
- Change individual tool execution behavior, permissions, approval policy, output fitting, duplicate detection, or shell semantics.
- Add progress to the summary planner.
- Change repo finish verification or summary classification policy.
- Change the OpenAI-compatible native `tool_calls[].function.name/arguments` transport shape required by inference APIs.
- Retain compatibility parsing for flattened actions, `tool_name`, or `tool_calls`.
- Preserve replay of unfinished persisted planner JSON that uses the removed envelope; missed migrations fail loudly.
- Add a dependency.

## Canonical Wire and Runtime Model

### Direct tool action

All planner kinds use:

```json
{
  "action": "tool",
  "toolName": "git",
  "args": {
    "operation": "status"
  }
}
```

The runtime schema is strict. `action`, `toolName`, and `args` are required; extra envelope keys fail. The selected `toolName` must be present in the current request's allowed tool definitions. `args` must pass that tool's existing runtime schema.

### Tool batch

All planner kinds use:

```json
{
  "action": "tool_batch",
  "calls": [
    {
      "toolName": "read",
      "args": {
        "path": "src/app.ts"
      }
    },
    {
      "toolName": "git",
      "args": {
        "operation": "diff"
      }
    }
  ]
}
```

`calls` is non-empty. Each entry uses the direct tool payload without a redundant `action` field. Every entry is validated against the same allowed tool definitions and argument schemas as a direct call.

### Non-tool actions

Repo-search and repo-agent retain:

```json
{"action":"progress","output":"RED test confirmed; implementing the minimum fix now"}
```

```json
{"action":"finish","output":"Implemented and verified the requested change."}
```

Summary planner retains its existing classified finish wire fields:

```json
{
  "action": "finish",
  "classification": "summary",
  "raw_review_required": false,
  "output": "Final summary"
}
```

Summary finish mapping to camelCase agent-loop data remains an explicit downstream adapter because it is not a tool envelope. Summary planner still has no progress action.

## Canonical Schemas and Types

`src/planner-protocol/parser.ts` owns shared strict envelope schemas:

- `PlannerToolActionEnvelopeSchema` with `action`, `toolName`, and `args`;
- `PlannerBatchCallSchema` with `toolName` and `args`;
- `PlannerToolBatchEnvelopeSchema` with `action: "tool_batch"` and non-empty `calls`.

All exported action types are inferred with `z.infer`. Repo and summary protocol modules compose these shared schemas with their non-tool actions and perform allowed-tool and tool-argument validation. They return the canonical envelope directly; there is no normalized `tool_name`/`tool_calls` copy.

Protocol artifacts expose two distinct ordered sets:

- `actionNames`: envelope discriminators such as `tool`, `tool_batch`, `progress`, and `finish`;
- `toolNames`: the allowed tool names for the current request.

Contract tests compare both sets across runtime parsing, canonical JSON Schema, ExL3-lowered JSON Schema, prompt rendering, and captured provider requests.

## Provider JSON Schema

The shared JSON-schema builder generates one direct variant per allowed tool-parameter variant:

```json
{
  "type": "object",
  "properties": {
    "action": {"const": "tool"},
    "toolName": {"const": "git"},
    "args": {"type": "object", "properties": {}, "required": []}
  },
  "required": ["action", "toolName", "args"],
  "additionalProperties": false
}
```

Batch item variants contain `toolName` and `args` without `action`. Empty tool sets omit both `tool` and `tool_batch` alternatives. Provider lowering may transform optional-property mechanics for Formatron compatibility, but it must preserve exact action and tool-name sets.

Native Llama tool-call responses are reconstructed into the canonical envelope:

- one native call becomes `{"action":"tool","toolName":name,"args":arguments}`;
- multiple native calls become `{"action":"tool_batch","calls":[{"toolName":name,"args":arguments}]}`.

The OpenAI-compatible request/response transport itself remains unchanged.

## Tool Metadata and Examples

Each planner tool definition carries canonical `exampleArgs` metadata beside its name, description, and parameter schema. Protocol construction validates every example against the tool's runtime argument schema and rejects invalid or missing examples during development.

Repo examples cover:

- `read`: path plus a useful window;
- `grep`: required pattern and a scoped glob;
- `find`: a recursive glob;
- `ls`: a directory path;
- `write`: path and content;
- `edit`: path plus one `oldText`/`newText` replacement;
- `run`: command with `outputMode: "auto"`;
- `git`: an explicit `operation: "status"` discriminator;
- `web_search`: query;
- `web_fetch`: URL.

Summary examples cover `find_text`, `read_lines`, `json_filter`, and `json_get`, including the nested filter structure. Prompt examples are rendered through a canonical helper so examples cannot retain obsolete envelope fields.

## Parsing and Errors

JSON extraction and repair remain in `ModelJson`. Planner protocol modules own envelope validation, allowed-tool membership, and tool-argument validation.

Errors use canonical wire paths. Because `args` is now genuinely present in model-facing JSON, paths such as `args.operation` are truthful. Error messages include the rejected call index for batches and a canonical valid example for the selected tool when available. They never describe flattened fields or internal-only names.

No parser accepts both old and new shapes. These fail loudly:

- `{"action":"git","operation":"status"}`;
- `{"action":"git","args":{"operation":"status"}}`;
- `{"action":"tool","tool_name":"git","args":{"operation":"status"}}`;
- `{"action":"tool_batch","tool_calls":[]}`;
- batch entries with `action` instead of `toolName`.

## Agent Loop, Engine, Transcript, and Approval Boundaries

`AgentLoopActionParser` maps canonical tool actions into the existing generic `AgentLoopToolAction` with `kind: "tool"`, `toolName`, and `args`. The generic agent-loop `kind` discriminator remains internal control flow and is not a planner wire format.

Repo engine types and helpers consume camelCase `toolName` directly. `RepoSearchToolAction`, transcript action metadata, pending approval identities, activity summaries, repo-tool execution, and approval review payloads no longer use `tool_name`.

Assistant transcript messages still serialize to the inference API's required `tool_calls[].function.name/arguments` format. The in-memory helper input uses `{ toolName, args }`, and only the serializer knows the OpenAI-compatible transport representation.

Approval review payloads use the canonical direct tool envelope. Chat-grounding examples and persisted command replay use canonical planner fields before conversion to native transcript messages.

## Progress Policy

The canonical progress metadata uses this policy:

> Progress is optional. Use it sparingly, only for a meaningful phase change or a checkpoint after substantial work. Do not narrate routine next steps.

The example represents a real phase boundary, not ordinary navigation. Repo task and repo-agent prompts consume this single canonical policy. The restricted prompt does not add a second progress rule. Tests assert the sparse policy is present once, the old `scanning scripts next` example is absent, and summary prompts do not mention progress.

Progress remains non-terminal and does not decrement the invalid-response streak; successful executed tool actions retain the existing streak-decay behavior.

## Repo-Agent Terminal Status

Repo-agent classifies the returned repo-search scorecard before transitioning its run state:

- `completed`: every task has `reason: "finish"`, `passed: true`, and the aggregate verdict is pass;
- `failed`: a normally returned result contains `invalid_response_limit`, `max_turns`, failed signal checks, command failures, or another non-finish reason;
- `aborted`: the existing explicit abort path;
- approval terminal states remain unchanged.

Failed run state and public result retain both a concise `error` and the terminal synthesized `output` when available. CLI boundary JSON exits non-zero for failed results and exposes both fields. A normally returned engine result is not sufficient by itself to claim completion.

## Data Flow

1. Resolve the exact allowed tool definitions and their validated example arguments.
2. Build canonical runtime tool and batch envelope schemas.
3. Build canonical provider JSON Schema from the same definitions.
4. Render action instructions and per-tool examples from the same definitions.
5. Send the provider request, applying ExL3 lowering only at the final boundary.
6. Extract/repair JSON without changing action shape.
7. Parse the canonical envelope and validate `args` against the selected tool schema.
8. Map the canonical action once into the generic agent-loop representation.
9. Serialize transcript messages only at the native inference boundary.
10. Execute tools and approvals with camelCase `toolName` and nested `args`.
11. Classify the final repo-agent scorecard before publishing terminal run status.

## Migration

This is a complete replacement. The same change removes:

- flattened direct planner actions;
- direct actions whose `action` value is a tool name;
- `tool_name` and `tool_calls` planner/runtime fields;
- batch entries that contain `action` tool discriminators;
- manual prompt examples using removed shapes;
- provider reconstruction of flattened action JSON;
- approval payloads using flattened tool fields;
- tests and fixtures asserting obsolete shapes;
- unconditional repo-agent success mapping.

There is no compatibility parser, alias, shim, fallback, dual schema, or deprecation period. A missed migration must fail typechecking, focused contract tests, captured-wire tests, or the final forbidden-pattern scan.

## Testing

### Canonical contract tests

- Direct and batch examples parse for every repo and summary tool.
- Runtime and canonical JSON Schema expose exact `actionNames` and `toolNames`.
- Empty and reduced tool sets cannot emit unavailable tool names or batches.
- Old flattened, snake_case, and `tool_calls` shapes fail.
- Git missing-operation errors use the canonical path and show a valid canonical example.

### Cross-layer tests

- Captured Llama and ExL3 request schemas match canonical action and tool-name sets.
- Native single and multiple tool-call responses reconstruct canonical JSON.
- Agent-loop mapping preserves `toolName` and `args` without a second planner shape.
- Transcript serialization produces correct native `function.name/arguments` messages.
- Approval review payloads and chat-grounding examples use the canonical envelope.

### Tool-specific coverage

- Repo: read, grep, find, ls, write, edit, run, git, web_search, web_fetch.
- Summary: find_text, read_lines, json_filter, json_get.
- Success, missing required args, extra envelope keys, invalid nested args, empty batch, unavailable tool, and invalid mixed batch.

### Progress coverage

- Repo prompts contain the sparse policy exactly once.
- Restricted and full agent prompts share the canonical policy.
- The routine narration example is absent.
- Summary prompts and schemas contain no progress action.

### Repo-agent status coverage

- Valid finish and passing scorecard produce `completed` and exit zero.
- `invalid_response_limit`, `max_turns`, and failed scorecards produce `failed` and non-zero exit.
- Failed output retains terminal synthesis text.
- Approval and explicit abort behavior remain unchanged.

### Final verification

- Focused protocol, provider, agent-loop, repo-engine, summary-planner, approval, status-server, and prompt suites.
- Full repository test suite.
- `npm run typecheck`.
- `npm run lint`.
- `npm run build`.
- `git diff --check`.
- Forbidden-pattern scan for removed planner fields and flattened action fixtures.
- Independent built-runtime repo-agent probe using `--progress`.

## Constraints

- TypeScript only.
- Runtime IO parsed with Zod; types inferred with `z.infer`.
- No `any`, unknown laundering, type assertions, non-null assertions, namespace imports, or schema-duplicating IO types.
- No new dependency.
- No worktree or commit.
- Inline implementation; no implementation delegation.
- TDD for each behavior change.
- Preserve unrelated working-tree changes.

## Risks

- The provider JSON Schema becomes more deeply nested. Formatron lowering and real-schema integration tests must prove support before completion.
- Prompt size increases when every allowed tool has an example. Tests must measure the resulting prompt and preserve budget headroom.
- Native tool-call reconstruction and transcript serialization use required external shapes. Boundary tests must distinguish those from planner JSON rather than banning native `tool_calls` globally.
- Existing persisted planner JSON becomes invalid by design. Runtime errors must identify the removed shape clearly without accepting it.
- Repo-agent failure classification changes CLI exit behavior for runs that previously returned zero after terminal synthesis. CLI and status-server tests must cover the intentional behavior.

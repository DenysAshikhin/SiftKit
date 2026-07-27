# Auto-Approval Verdict Probe — Design

Date: 2026-07-27  
Status: Approved

## Problem

`repo-agent --approval auto` asks the configured model to approve, deny, or
escalate a proposed action. Testing that judgment through the complete agent
loop risks executing an approved action. Existing mocked tests validate the
control flow but do not reveal how the real configured model judges a realistic
conversation.

The required diagnostic must send a full existing conversation through the
production approval-review path and report the live verdict without providing
any route to tool or command execution.

## Goals

- Replay a realistic existing conversation and proposed action.
- Use the real configured inference backend and model.
- Invoke the production `LlmApprovalGate` and approval-verdict protocol.
- Show the exact messages submitted for review.
- Print the parsed `approve`, `deny`, or `unsure` verdict and reason.
- Make command execution structurally impossible.

## Non-Goals

- Running a complete `repo-agent` task.
- Asking the planner to generate the proposed action.
- Validating tool-action parsing, duplicate screening, or command preparation.
- Executing, mocking, or simulating the proposed command.
- Adding a public server endpoint or changing normal auto-approval behavior.

## Production Semantics

The production path consults the approval gate before appending the current
assistant tool action to the transcript:

1. `ToolActionProcessor` passes `{ turn, toolName, command }` to
   `LlmApprovalGate.request()` (`src/repo-search/engine/tool-action-processor.ts`).
2. `LlmApprovalGate` constructs the production approval question and requests a
   verdict (`src/repo-search/engine/llm-approval-gate.ts`).
3. The verdict requester sends:
   `existing transcript + transient user approval question`
   (`src/repo-search/engine/task-loop.ts`).
4. `requestApprovalVerdict()` calls the configured model with the constrained
   approval schema and `toolDefinitions: []`
   (`src/repo-search/planner-protocol.ts`).

The probe will preserve this ordering. Its recorded conversation represents
only messages already present before the proposed action. The proposed action
is supplied separately and appears only in the transient approval question.

## Architecture

### Replay payload

A JSON payload contains:

- `messages`: the complete pre-action conversation in protocol order.
- `action.turn`: the current turn number.
- `action.toolName`: the proposed production tool name.
- `action.command`: the proposed command or action description.

The payload is validated at the IO boundary with a Zod schema. TypeScript types
are inferred from that schema.

The initial repository fixture will include system, user, assistant, and prior
tool-result context. The action remains fixture-configurable. This initial
fixture will use a mutation-class tool so it cannot take the read-only fast path
and must reach the real model.

### Verdict-only runner

The runner will:

1. Parse the fixture path from the CLI.
2. Load and validate the replay payload.
3. Load the configured backend, base URL, model, and timeout using existing
   configuration helpers.
4. Construct the production `LlmApprovalGate`.
5. Supply a verdict requester that combines the recorded messages with the
   gate's transient question exactly as `TaskLoop.requestApprovalVerdict()`
   does.
6. Call the production `requestApprovalVerdict()` function.
7. Print structured JSON containing the submitted messages, model identity,
   verdict, and reason.
8. Exit without advancing any agent loop.

The command will be exposed as an explicit development script:

```text
npm run probe:auto-approval -- --payload <replay.json>
```

### Execution isolation

The probe must not import or instantiate:

- `TaskLoop`
- `ToolActionProcessor`
- command preparation or execution modules
- shell/process spawning helpers
- filesystem mutation helpers

Its dependency graph ends at `LlmApprovalGate` and
`requestApprovalVerdict()`. The model request has no tool definitions. An
`approve` verdict is printed as data and cannot trigger a follow-up operation.

This boundary intentionally omits the upstream action-processing pipeline. That
pipeline is where an approved action would continue toward execution, so
including it would conflict with the zero-execution requirement.

## Errors and Output

Successful output is JSON with:

- configured backend and model
- exact submitted message array
- proposed action
- parsed verdict
- reviewer reason

Invalid payloads, missing configuration, unavailable inference services,
timeouts, and invalid model responses fail with a non-zero exit code. They are
not converted into an approval. Failures write a concise diagnostic to stderr
and exit with code `1`; no structured approval result is emitted.

## Testing and Validation

Implementation follows TDD:

1. Add failing tests for payload validation.
2. Add a failing runner test proving the recorded transcript is preserved and
   the approval question is appended only for the model request.
3. Add failing tests for structured output and error propagation.
4. Add a dependency-boundary test proving execution modules are absent from the
   runner's imports.
5. Implement the minimum code needed to pass.
6. Run focused tests, type checking, and the full test suite.
7. Invoke the runner once against the real configured model using the recorded
   fixture and report its exact verdict and reason.

Automated tests use an injected verdict requester so they remain deterministic.
The final manual probe is the only live-model validation. Neither path receives
an executor.

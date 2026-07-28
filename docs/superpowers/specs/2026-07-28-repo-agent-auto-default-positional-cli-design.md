# Repo-Agent Agent-Friendly CLI Design

## Goal

Make repo-agent safe and predictable for both humans and calling agents:

```text
siftkit repo-agent "task" [options]
```

Repo-agent defaults to automatic approval. A TTY caller stays in the existing
foreground interactive flow. A non-TTY caller uses a resumable worker that
returns structured JSON at completion or at a manual-approval boundary.

Repo-search remains approval-free by default and does not inherit any
repo-agent worker or approval behavior.

## Public CLI Contract

### Starting a run

Repo-agent accepts exactly one positional task:

```text
siftkit repo-agent "update the parser and run its tests"
```

Supported options:

```text
--model <model>
--log-file <path>
--approval <interactive|auto|off>
--progress
```

The positional task replaces `--prompt` and `-prompt` for repo-agent. Those
flags remain part of the separate repo-search contract.

Options may appear before or after the positional task. The CLI rejects a
missing task, multiple tasks, legacy prompt flags, unknown options, missing
option values, and unsupported approval modes before contacting the server.

### Decisions and status

Non-TTY runs expose:

```text
siftkit repo-agent decide <run-id> approve
siftkit repo-agent decide <run-id> deny --reason "unsafe path"
siftkit repo-agent decide <run-id> abort
siftkit repo-agent status <run-id>
```

`decide` validates and submits one decision for the current pending approval,
then blocks until completion or the next approval boundary. There is no
separate public `wait` command.

`deny` requires a non-empty reason. `approve` and `abort` reject `--reason`.
Unknown, terminal, stale, or already-decided run IDs fail loudly without
changing run state.

`status` never waits or changes state. It returns the current structured state.

## Approval Defaults

When `--approval` is omitted, repo-agent uses `auto`.

The default applies independently at both boundaries:

- the CLI sends `approval: "auto"` to `/repo-agent`;
- `/repo-agent` resolves an omitted approval field to `auto`.

Explicit modes retain their meanings:

- `auto`: the model reviews every approval-required action; reviewer `unsure`
  and reviewer failures escalate to manual approval;
- `interactive`: every approval-required action escalates directly;
- `off`: no approval gate or reviewer is created.

Read-only repo-agent tools retain their existing approval exemption.

## TTY Flow

When `stdin.isTTY === true`, repo-agent runs in the foreground exactly as an
interactive human command:

```text
siftkit repo-agent "task"
  -> POST /repo-agent with approval:"auto"
  -> stream progress
  -> auto reviewer approves or denies
  -> unsure/failure uses the existing approve/deny/abort prompt
  -> print human-readable final output
```

No worker, run-state directory, detached process, or JSON boundary envelope is
created for a TTY run.

`--approval off` remains available in a TTY.

## Non-TTY Flow

When `stdin.isTTY !== true`, repo-agent automatically uses a resumable worker:

```text
siftkit repo-agent "task"
  -> validate arguments
  -> create run ID and atomic request state
  -> launch one detached internal worker
  -> parent waits for a boundary
  -> print exactly one JSON result
```

The worker owns the existing `/repo-agent` SSE connection for the whole run. It
uses the normal `StatusServerApiClient`, server endpoint, approval gate,
automatic reviewer, tool loop, transcript, and artifact pipeline. No second
agent engine or detached server execution API is introduced.

The parent CLI blocks until:

- the run completes;
- a manual approval is required;
- the run fails; or
- the run is aborted.

If approval is required, the worker stays alive and parked on the existing
server approval promise. The parent returns the approval boundary. A later
`decide` invocation writes an atomic decision, waits for the worker to consume
it, and then blocks to the next boundary.

If the original caller exits unexpectedly, the worker continues. `status` or
`decide` can reconnect through the run store.

## JSON Output Contract

Non-TTY stdout contains exactly one JSON object and no prose or ANSI control
sequences. Progress and diagnostics go to stderr.

### Completed

```json
{
  "status": "completed",
  "runId": "uuid",
  "output": "final repo-agent output"
}
```

### Approval required

```json
{
  "status": "approval_required",
  "runId": "uuid",
  "approval": {
    "approvalId": "uuid",
    "toolName": "edit",
    "command": "edit path=\"src/example.ts\" edits=1",
    "reviewPayload": "{\n  \"action\": \"edit\"\n}"
  }
}
```

`reviewPayload` is `string | null`. Edit and write approvals include the
complete existing review payload with no truncation. Other tools use `null`.

### Failed

```json
{
  "status": "failed",
  "runId": "uuid",
  "error": "failure message"
}
```

### Aborted

```json
{
  "status": "aborted",
  "runId": "uuid"
}
```

The result is represented by one Zod discriminated union and its inferred
TypeScript type. The same schema drives state validation, stdout rendering,
status output, and help metadata.

Exit codes:

- `completed`: `0`;
- `approval_required`: `0`, because this is a successful resumable boundary;
- `status` for an active or terminal known run: `0`;
- `failed`, `aborted`, invalid arguments, unknown runs, stale decisions, and
  malformed state: non-zero.

## Components

### `RepoAgentRunStore`

A reusable class owns all run-state paths, Zod parsing, atomic transitions,
decision claiming, and cleanup. Callers never construct paths or edit state
files directly.

It uses the existing atomic filesystem helper and stores runs below:

```text
<SiftKit runtime root>/repo-agent/runs/<run-id>/
```

State is a Zod discriminated union:

- `starting`;
- `running`;
- `approval_required`;
- `completed`;
- `failed`;
- `aborted`.

Every state includes `runId`, `revision`, `updatedAtUtc`, and worker PID where
applicable. Transitions use monotonically increasing revisions so `decide`
cannot submit twice or wait on a stale boundary.

### `RepoAgentWorkerLauncher`

A reusable class starts the internal worker detached and hidden. It receives an
explicit run ID and request path, never shell-concatenated command text.

Tests inject a real fixture worker executable or a narrow process boundary;
production code does not pass dynamically selected spawn functions.

### `RepoAgentWorker`

The worker reads and validates one request, updates state to `running`, and
executes the existing repo-agent streamed request.

It receives approval events through the existing API-client prompter boundary.
It does not instantiate another task loop or submit tools itself.

### `RepoAgentRunApprovalPrompter`

The API client depends on a small explicit interface:

```ts
type ApprovalPrompter = {
  promptDecision(event: JsonObject): Promise<ApprovalDecision>;
};
```

`CliApprovalPrompter` remains the TTY implementation.
`RepoAgentRunApprovalPrompter` is the worker implementation. It:

1. validates the approval event;
2. atomically writes `approval_required` state;
3. waits for a matching decision revision;
4. deletes the consumed pending decision;
5. clears the approval payload from state;
6. returns the existing `ApprovalDecision`.

`StatusServerApiClient` accepts the interface rather than the concrete
TTY-bound class.

### `RepoAgentBoundaryWaiter`

A reusable class waits for a state revision greater than the caller's observed
revision. It returns at `approval_required`, `completed`, `failed`, or
`aborted`.

It detects a dead worker PID and transitions an otherwise-active run to
`failed`. It uses bounded polling with an existing configurable timeout; there
is no indefinite busy loop.

## State Safety and Cleanup

Run-state writes are atomic. A decision includes the run ID, approval ID,
observed revision, decision, and optional denial reason. The worker consumes
only an exact match.

Only `approval_required` state may contain `command` and `reviewPayload`.
Immediately after approve, deny, or abort settles:

- the pending approval content is removed;
- the decision file is removed;
- subsequent state contains no reviewer payload;
- the main transcript retains only its existing original tool call and settled
  result behavior.

Terminal state retains only sanitized metadata, final output or failure, and
timestamps. Terminal run directories use the existing runtime-history
retention setting and pruning lifecycle.

If the status server restarts or the worker loses its SSE request, the run
becomes `failed`; the CLI does not claim durable execution across server or
machine restarts.

Only one decision writer may claim a pending revision. Concurrent or repeated
decisions fail without submitting another approval.

## Agent-Friendly Help

All conventional help forms work without a server, TTY, or run-state access:

```text
siftkit repo-agent --help
siftkit repo-agent -h
siftkit repo-agent help
siftkit help repo-agent
siftkit repo-agent decide --help
siftkit repo-agent decide -h
siftkit repo-agent status --help
siftkit repo-agent status -h
```

Machine-readable help is available through:

```text
siftkit repo-agent --help --json
siftkit repo-agent help --json
siftkit help repo-agent --json
siftkit repo-agent decide --help --json
siftkit repo-agent status --help --json
```

JSON help is validated by a Zod schema and includes:

- canonical invocation;
- subcommands and arguments;
- options and defaults;
- TTY versus non-TTY behavior;
- all output variants;
- exit-code meanings;
- complete examples for starting, inspecting, approving, denying, and aborting.

Unknown repo-agent syntax returns the targeted repo-agent usage and a specific
error. Help detection is structural; a task containing the word `help` is not
misclassified unless the entire command matches a documented help form.

## Repo-Search Isolation

Repo-search does not inherit repo-agent defaults or worker behavior.

Without `--interactive`, repo-search:

- resolves approval mode to `off`;
- creates no `ApprovalGate`;
- creates no `LlmApprovalGate`;
- issues no approval-review model request;
- emits no approval event;
- requires no TTY;
- never creates a repo-agent run-state directory.

`repo-search --interactive` remains its explicit human approval flow. There is
no automatic approval mode or resumable worker for repo-search.

## Error Handling

- Invalid start syntax fails before creating a run directory or contacting the
  server.
- Worker launch failure atomically records `failed` and returns non-zero.
- Malformed or missing state fails closed.
- Unknown run IDs do not create directories.
- A decision against non-pending state fails closed.
- Approval ID or revision mismatch fails closed.
- Deny without a reason fails validation.
- A dead worker cannot leave callers waiting indefinitely.
- Reviewer failure retains the existing one retry followed by manual
  escalation.
- No action executes while automatic or manual review is pending.

## Testing

Strict TDD and end-to-end tests must prove:

1. One positional repo-agent task works with options before or after it.
2. Legacy, missing, multiple, malformed, and unknown syntax fails before side
   effects.
3. CLI and server independently default repo-agent to `auto`.
4. Explicit `interactive`, `auto`, and `off` remain available.
5. A TTY run stays foreground, uses the human prompter on escalation, emits
   human-readable output, and creates no run-state directory.
6. A non-TTY safe run returns one `completed` JSON object from one command.
7. A non-TTY unsure run returns one `approval_required` JSON object with the
   full approval payload and a resumable run ID.
8. `decide approve` resumes the same worker and returns completion or the next
   approval.
9. `decide deny --reason` reaches the transcript without copying the payload.
10. `decide abort` ends the same run.
11. `status` returns every active and terminal state without mutation.
12. Stale, repeated, concurrent, mismatched, and unknown decisions fail closed.
13. Worker launch failure, worker death, malformed state, and server loss
    return `failed` without hanging.
14. Pending payload and decision content disappear immediately after
    settlement and never enter terminal state or persistent run logs.
15. All documented text and JSON help forms work without server startup.
16. JSON help matches the real parser, schemas, defaults, and exit codes.
17. Default repo-search creates no approval or repo-agent worker flow.
18. `repo-search --interactive` retains its explicit human approval path.

## Non-Goals

- A second repo-agent engine.
- Server-side detached execution or SSE replay endpoints.
- Durable resume across status-server or machine restarts.
- Automatic approval for repo-search.
- Automatic approval of manual escalations.
- A public `wait` command.
- A repo-agent command alias.
- Changing the approval safety policy or edit/write payload content.

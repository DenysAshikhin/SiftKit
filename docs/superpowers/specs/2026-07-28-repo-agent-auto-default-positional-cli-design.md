# Repo-Agent Auto Default and Positional CLI Design

## Goal

Make `repo-agent` safe and concise for interactive agent callers:

```text
siftkit repo-agent "task" [options]
```

The command defaults to LLM-backed automatic approval, escalates uncertain
actions to the existing human prompt, and preserves an explicit approval-off
override. `repo-search` remains approval-free by default.

## CLI Contract

`repo-agent` accepts exactly one positional prompt:

```text
siftkit repo-agent "update the parser and run its tests"
```

Supported options remain:

```text
--model <model>
--log-file <path>
--approval <interactive|auto|off>
--progress
```

The positional prompt replaces `--prompt` and `-prompt` for `repo-agent`.
Those flags remain part of the separate `repo-search` contract. This avoids
maintaining two prompt syntaxes for one command.

The parser rejects:

- a missing positional prompt;
- more than one positional prompt;
- `--prompt` or `-prompt` on `repo-agent`;
- an unsupported approval mode;
- an unknown option;
- a missing option value.

The parser must continue accepting option placement before or after the
positional prompt, provided there is exactly one positional prompt.

## Approval Defaults

When `--approval` is omitted, `repo-agent` uses `auto`.

The default applies independently at both boundaries:

- the CLI sends `approval: "auto"` to `/repo-agent`;
- `/repo-agent` resolves an omitted approval field to `auto`.

The server-side default prevents direct interactive API clients from silently
falling back to a different mode than the CLI.

Explicit overrides retain their existing meanings:

- `--approval auto`: the model reviews each approval-required action; `unsure`
  and reviewer failures escalate to the human approval gate;
- `--approval interactive`: every approval-required action goes directly to
  the human approval gate;
- `--approval off`: no approval gate or reviewer is created.

Read-only repo-agent tools retain their existing approval exemption.

## Interactive Caller Requirement

Every `repo-agent` CLI invocation requires an interactive TTY, including
`--approval off`. The CLI rejects a non-TTY invocation before contacting the
server.

This keeps the command intended for supervised callers while preserving the
explicit `off` override for interactive sessions. No machine-readable approval
protocol, background wrapper, or non-interactive fallback is added.

## Repo-Search Isolation

`repo-search` behavior does not inherit the new repo-agent default.

Without `--interactive`, `repo-search` must:

- resolve approval mode to `off`;
- create no `ApprovalGate`;
- create no `LlmApprovalGate`;
- issue no approval-review model request;
- emit no approval event;
- require no TTY.

`repo-search --interactive` remains the explicit opt-in human approval flow.
There is no automatic approval mode for `repo-search`.

## Data Flow

Default repo-agent CLI flow:

```text
siftkit repo-agent "task"
  -> parse one positional prompt
  -> require TTY
  -> POST /repo-agent { prompt, approval: "auto", ... }
  -> server resolves auto
  -> ApprovalGate + LlmApprovalGate
  -> approve or deny automatically
  -> unsure/failure emits approval_request
  -> existing CLI prompt collects approve/deny/abort
```

Default repo-search flow:

```text
siftkit repo-search --prompt "question"
  -> POST /repo-search without interactive approval
  -> server resolves off
  -> no approval gate or reviewer
```

## Error Handling

CLI validation errors are deterministic and occur before server contact.
Messages identify the invalid syntax and show the canonical positional form.

Non-TTY errors state that `repo-agent` requires an interactive terminal. The
message must not suggest `--approval off` as a bypass because all repo-agent
modes now require a TTY.

Approval reviewer failures retain the existing one-retry behavior, followed by
manual escalation. No action executes while either automatic or manual review
is pending.

## Documentation

CLI help, command catalog descriptions, README examples, and agent-facing
usage guidance use:

```text
siftkit repo-agent "task"
```

Examples omit `--approval auto` because it is the default. Documentation still
shows explicit `interactive` and `off` overrides.

Repo-search documentation continues using `--prompt` and explicitly states
that approval is off by default.

## Testing

Tests must prove:

1. `repo-agent "task"` parses and sends the exact prompt.
2. Options work before and after the positional prompt.
3. Missing or multiple prompts fail before server contact.
4. `repo-agent --prompt` and `repo-agent -prompt` are rejected.
5. Omitted repo-agent approval resolves to `auto` in both CLI and server.
6. Explicit `interactive`, `auto`, and `off` overrides remain accepted.
7. Every repo-agent mode fails before server contact when stdin is not a TTY.
8. Default auto approval retains model-review and manual-escalation behavior.
9. Default repo-search creates no approval gate, reviewer request, approval
   event, or TTY requirement.
10. `repo-search --interactive` retains its explicit human approval path.
11. Help and documented examples show the new canonical syntax and correct
    defaults.

Implementation follows strict TDD: each behavior change receives a failing
test that is observed before production code changes.

## Non-Goals

- Adding a non-interactive repo-agent mode.
- Adding a machine-readable approval protocol.
- Adding a `repo-agent` alias.
- Adding automatic approval to `repo-search`.
- Changing approval safety policy or edit/write payload review.
- Changing the dashboard.

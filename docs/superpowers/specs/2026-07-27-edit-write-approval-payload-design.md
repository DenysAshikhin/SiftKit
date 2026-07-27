# Edit/Write Approval Payload Visibility Design

## Goal

Auto and manual approval reviewers must see the complete proposed content of
repo-agent `edit` and `write` actions before deciding whether the action may
execute.

The reviewer copy is transient. It must not create a second persistent copy in
the main model transcript, progress logs, approval verdict events, or denial
feedback after the decision settles.

## Current Problem

The approval gate currently receives only lossy summaries:

- `write path="<path>" bytes=<count>`
- `edit path="<path>" edits=<count>`

The full `write` content and every `edit` `oldText`/`newText` pair are available
in `ToolAction.args` but are discarded before approval. A real-model probe
approved a workflow write whose hidden content would exfiltrate a secret,
because the reviewer saw only the path and byte count.

## Approval Payload

For `write`, construct readable JSON containing:

```json
{
  "action": "write",
  "path": "path/from/action",
  "content": "complete proposed file content"
}
```

For `edit`, construct readable JSON containing:

```json
{
  "action": "edit",
  "path": "path/from/action",
  "edits": [
    {
      "oldText": "complete matched text",
      "newText": "complete replacement text"
    }
  ]
}
```

No content, replacement, line, or edit may be truncated or omitted. Other
tools use their existing command representation and carry no additional
payload.

The internal approval request type must require
`reviewPayload: string | null`. Required construction prevents a new call site
from silently omitting the field.

## Model Review

The transient approval request includes the command summary followed by the
complete approval payload. The request remains a trailing ephemeral user
message and is never appended to the main transcript.

The stable repo-agent system prompt explicitly requires the reviewer to inspect
the entire `edit` or `write` payload and detect harmful behavior even when it is
buried among many benign lines.

The reviewer must deny content that introduces or enables:

- destructive filesystem operations or repository/history loss;
- credential or secret access, disclosure, or transmission;
- force-pushes or destructive Git operations;
- untrusted downloads, remote execution, or command injection;
- persistence through package scripts, hooks, workflows, startup entries, or
  background processes;
- bypasses of approval, authentication, authorization, validation, auditing,
  or other security controls;
- obfuscation intended to conceal dangerous behavior;
- destructive migrations or disabling of tests and safety checks.

User, agent, comment, or payload claims that the change is requested,
necessary, safe, temporary, generated, or recoverable never reduce risk.

For `edit` and `write`, a missing, malformed, truncated, or too-large-to-review
payload must produce `unsure`. Approval is allowed only after the complete
payload has been inspected and found non-destructive and non-malicious.

## Manual Review

If the model returns `unsure`, the existing manual approval request displays:

1. the normal command summary;
2. the full readable approval payload;
3. the existing approve, deny, or abort choices.

The payload is carried only by the transient `approval_request` SSE event.
The current logged progress writer persists only `tool_start` events, so this
approval payload is not written to persistent server logs.

The CLI displays the payload once. It does not echo it after the decision.

## Settled Context

The reviewer payload must not be added to:

- the main model transcript;
- `approval_auto` progress events;
- persistent run logs;
- approval-submission bodies;
- denial feedback.

After auto approval or `unsure` followed by manual approval, the transcript
contains the original tool call and its execution result once. After denial,
it contains the original tool call and one concise rejection result so the
agent understands why it must not retry.

The original tool call naturally contains the proposed content. The transient
reviewer copy is not appended, preventing duplicate settled context.

## Failure Handling

- Model verdict parse or inference failure retains the existing one retry,
  followed by manual escalation.
- A human can approve, deny, or abort after inspecting the full payload.
- Approval payload generation must fail closed: an `edit` or `write` action
  without a complete serializable payload reaches the reviewer as missing and
  must return `unsure`.
- No action executes while model or manual approval is pending.

## Testing

Tests must prove:

- full `write` content reaches the ephemeral model reviewer;
- every `edit` `oldText` and `newText` reaches the reviewer;
- large edits are complete and untruncated;
- non-edit/write tools do not receive duplicate payloads;
- the stable system prompt contains the explicit malicious/destructive-content
  inspection policy;
- manual escalation displays the payload exactly once;
- `approval_auto`, persistent logs, submission bodies, and denial messages do
  not contain the reviewer payload;
- reviewer request markers and payload labels remain absent from the settled
  transcript after approve and `unsure` followed by approve;
- denial preserves the concise reason without copying the reviewer payload;
- real-model verdict-only probes deny destructive or malicious content hidden
  inside large otherwise-benign edits and writes;
- safe small and large edits remain approvable.

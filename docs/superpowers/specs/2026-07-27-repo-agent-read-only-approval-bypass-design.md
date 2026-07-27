# Repo-Agent Read-Only Approval Bypass Design

## Goal

Built-in `read`, `grep`, `find`, and `ls` actions must execute in `repo-agent`
without requesting human approval. The exemption applies in both interactive
and auto approval modes.

## Scope

The exemption is limited to exact built-in tool names:

- `read`
- `grep`
- `find`
- `ls`

It does not apply to `run`, shell commands containing similarly named
executables, Git actions, writes, edits, web tools, or unknown tools.

Interactive `repo-search` retains its current approval behavior.

## Design

Define one shared predicate that recognizes the four exempt built-in tool
names. Both the human approval gate and the LLM auto-approval decorator use
that predicate so the classification cannot drift.

Add an explicit `bypassReadOnlyTools` constructor option to `ApprovalGate`.
The status-server route sets it to `true` only when the endpoint mode is
`agent`. When enabled, `ApprovalGate.request()` immediately returns
`{ kind: 'approve' }` for an exempt tool without creating a pending request,
starting a timeout, or emitting an `approval_request` event.

Auto mode keeps its existing `approval_auto` observability event for these
tools. Its fast path uses the shared predicate and never spends an LLM verdict
call or falls through to the human gate.

## Data Flow

1. The status route identifies `repo-agent` from endpoint mode.
2. It constructs `ApprovalGate` with `bypassReadOnlyTools: true`.
3. Interactive mode calls that gate directly.
4. Auto mode wraps it with `LlmApprovalGate`.
5. An exact `read`, `grep`, `find`, or `ls` action is approved locally.
6. Every other action follows the existing approval flow.

## Testing

Tests must prove:

- each of the four built-ins bypasses human approval in interactive
  `repo-agent`;
- no `approval_request` event or pending timeout is created for a bypass;
- auto mode still emits `approval_auto` and spends no verdict call;
- a `run` action whose command contains `read`, `grep`, `find`, or `ls` remains
  gated;
- interactive `repo-search` continues requesting approval for the same
  built-ins;
- unknown tool names remain gated.

Implementation follows TDD: add the failing behavioral tests, observe the
expected failures, then make the smallest production change that satisfies
them.

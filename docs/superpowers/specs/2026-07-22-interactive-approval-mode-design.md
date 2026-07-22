# Interactive Approval Mode — Design

Date: 2026-07-22
Status: Approved (spec 2; rides on `2026-07-22-streamed-cli-transport-design.md` and its corrections)

## Problem

`siftkit repo-search` executes every planner tool call autonomously. That is fine for
the read-only surface, but the engine already implements `write`, `edit`, and `run`
(`src/repo-search/engine/repo-tools.ts`, deliberately withheld per
`planner-protocol.ts:247`). Exposing them requires a human approval gate: the user must
see and authorize each command before it executes, like Claude Code / Codex CLI.

## Decisions (from brainstorm)

- **Purpose:** the gate is the safety precondition that unlocks `write`/`edit`/`run`.
  Interactive runs offer the full tool surface; non-interactive runs keep today's
  read-only surface — unchanged, no prompts, ever.
- **Gate scope:** every tool call prompts (read-only included).
- **Answers:** Approve / Deny + optional free-text reason / Abort.
- **No answer:** non-TTY stdin + `--interactive` fails fast at CLI startup; an
  unanswered prompt aborts the run after a timeout (default 5 min,
  `SIFTKIT_APPROVAL_TIMEOUT_MS` overrides).
- **Transport:** the existing SSE stream carries `approval_request` progress frames;
  decisions return via a new `POST /repo-search/approval` endpoint.
- **Lock:** the run holds the `repo_search` model lock while the human thinks; the
  approval timeout bounds the stall.

## CLI surface

```
siftkit repo-search --prompt "..." --interactive
```

- `--interactive` with non-TTY stdin → immediate error:
  `--interactive requires a TTY (stdin is not interactive).`
- On each `approval_request` frame the CLI prompts on stderr/stdin:

```
[12:04:11] repo-search t3/24 wants to run: write path=src/x.ts (41 lines)
  [a]pprove  [d]eny  a[b]ort >
```

  Deny asks one follow-up: `reason (enter to skip) >`. The decision is POSTed to
  `/repo-search/approval`; the stream then continues. Heartbeats keep the SSE idle
  timer alive during the wait, so no client timeout fires while prompting.
- stdout remains result-only (pipe-safe); all prompt UI goes to stderr.

## Gate placement (load-bearing)

For native tools, `ToolActionProcessor.runNativeExecution` **executes** the tool before
`prepareCommandToRun` runs (`tool-action-processor.ts:231`). The gate therefore sits in
`processToolAction` **after** `validateToolAction` and `screenWebAndDuplicates`,
**before** `runNativeExecution`:

- invalid and duplicate-rejected calls never prompt;
- the user sees the requested command (`buildRepoToolRequestedCommand` output for
  native tools, the raw command for `git`);
- `evaluateCommandSafety` still runs after approval for `git` — approval is additive,
  an approved-but-unsafe git command is still rejected;
- nothing executes before the decision.

## Components

### `ApprovalGate` — `src/repo-search/engine/approval-gate.ts`

Explicit class, no callbacks; emits through the run's existing
`ProgressWriter<RepoSearchProgressEvent>` family so the SSE writer forwards frames
without new plumbing.

```ts
type ApprovalDecision =
  | { kind: 'approve' }
  | { kind: 'deny'; reason: string }
  | { kind: 'abort' };

class ApprovalGate {
  constructor(options: { progressWriter: ProgressWriter<RepoSearchProgressEvent>; timeoutMs: number });
  request(input: { turn: number; toolName: string; command: string }): Promise<ApprovalDecision>;
  submit(approvalId: string, decision: ApprovalDecision): boolean; // false: unknown/already resolved
}
```

`request()` mints an `approvalId`, emits
`{ kind: 'approval_request', approvalId, turn, toolName, command }`, parks a promise,
arms the timeout. Timeout resolves as `abort` (distinct error text:
`Approval request timed out after <n> ms.`).

`RepoSearchProgressEvent` gains optional `approvalId` and `toolName` fields.

### Engine threading

`RepoSearchExecutionRequest` gains `approvalGate?: ApprovalGate`; it flows into
`ToolActionProcessorDeps`. In `processToolAction`, when a gate is present:

- `approve` → proceed unchanged.
- `deny` → recorded like a safety rejection (`commands.push({ safe: false, reason: 'user denied', ... })`,
  `counters.safetyRejects += 1`) with tool result
  `Rejected command: user denied — <reason>` (or `user denied this command` when no
  reason). The model adapts and continues. A re-request of the same command prompts
  again (denial does not poison the duplicate tracker).
- `abort` / timeout → throw; the run unwinds through the endpoint's existing error
  path (error frame `Aborted by user.` / the timeout message), lock released in
  `finally`.

### Tool surface expansion

`planner-protocol.ts`:

- `INTERACTIVE_REPO_TOOL_NAMES = [...EXPOSED_REPO_TOOL_NAMES, 'write', 'edit', 'run']`.
- `isRepoSearchNativeToolName` widens to full-registry membership;
  `validateToolAction` additionally rejects tools not in the run's
  `allowedPlannerToolNames` (today membership outside the exposed set was the only
  guard). Non-interactive runs keep `EXPOSED_REPO_TOOL_NAMES`, so `write`/`edit`/`run`
  remain invalid actions there — behavior identical to today.
- Interactive repo-search runs pass `INTERACTIVE_REPO_TOOL_NAMES` as allowed tools.

### Server routes

- `POST /repo-search` body gains `interactive?: boolean`. When true, the endpoint
  constructs an `ApprovalGate` wired to the run's SSE progress writer, registers it in
  an `ApprovalGateRegistry` (Map keyed by the run's `requestId`, held on
  `ServerContext`), passes it in the execution request, and removes it in `finally`.
- `POST /repo-search/approval` — plain JSON (not streamed):
  `{ requestId, approvalId, decision: 'approve' | 'deny' | 'abort', reason? }`,
  zod-validated with `z.infer` types. Unknown `requestId` → 404; `submit()` returning
  false (stale/duplicate approvalId) → 409. Success → `{ accepted: true }`.

### CLI client

- `StatusServerApiClient.requestRepoSearch` gains an optional
  `approvalPrompter?: CliApprovalPrompter`. When a frame with
  `kind === 'approval_request'` arrives and a prompter is present, the client awaits
  `prompter.promptDecision(event)` and POSTs it via a new
  `submitRepoSearchApproval(...)` method, then resumes iterating. Without a prompter,
  `approval_request` frames are impossible (the server only gates when the request
  said `interactive: true`); receiving one anyway is a loud error.
- `CliApprovalPrompter` (`src/cli/approval-prompter.ts`): readline-based, explicit
  class; renders the prompt shown above; validates input; loops on unrecognized keys.

## Error handling

| Failure | Behavior |
|---|---|
| `--interactive`, stdin not TTY | CLI exits 1 before any request. |
| Prompt unanswered past timeout | Server aborts run → error frame with timeout message → CLI exits 1. |
| Decision POST for unknown requestId | 404; CLI surfaces and aborts. |
| Stale approvalId (double answer, race) | 409; CLI re-prompts is NOT attempted — treated as already-resolved, stream continues. |
| CLI killed mid-prompt | Socket close → existing disconnect abort → gate discarded with the run. |
| Deny storm (every call denied) | Existing forced-finish / turn-budget machinery ends the run normally. |

## Testing (TDD, E2E-first)

Real-server harness (`tests/helpers/streamed-op-harness.ts`) with mock model:

1. Interactive run: `approval_request` frame arrives before any tool executes;
   approving via `/repo-search/approval` lets the run complete with the normal result.
2. Deny with reason: tool result contains `user denied — <reason>`; model's next mock
   action runs; scorecard records the rejection.
3. Abort: run ends with error frame `Aborted by user.`; lock freed (follow-up run
   proceeds immediately).
4. Timeout (short `SIFTKIT_APPROVAL_TIMEOUT_MS`): error frame with timeout message.
5. Mutating tools: interactive run offers `write`; a `write` mock action prompts,
   approval executes it (file exists after run); the same body **without**
   `interactive` gets `write` rejected as an unsupported tool.
6. Native execution ordering: deny a `read` call → the read never executes (no
   read-window state recorded).
7. Approval endpoint: 404 unknown requestId, 409 stale approvalId.
8. CLI: non-TTY + `--interactive` exits 1; prompter unit test with scripted stdin
   (approve, deny+reason, abort, invalid-key loop).

## Out of scope

- Session-scoped "always allow" (explicitly deferred at brainstorm).
- Dashboard/browser approval UI (frames are already on the stream; UI can come later).
- Interactive mode for summary-family ops (nothing to approve — no tool calls).

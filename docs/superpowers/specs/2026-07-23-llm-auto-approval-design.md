# LLM Auto-Approval Mode for repo-agent — Design

Date: 2026-07-23
Status: Approved (Approach A — decorator gate)

## Goal

Add an `auto` approval mode for repo-agent where the LLM itself reviews each pending
command and returns `approve`, `deny` (with reason), or `unsure`. `unsure` (and any
verdict failure) escalates to the existing human approval flow. The verdict call must
not break llama-cpp prompt caching.

## Key insight: cache preservation via ephemeral messages

llama-cpp prompt caching (`cache_prompt`, `src/providers/llama-cpp.ts:486`) is
prefix-based per slot. The verdict request is built as an **ephemeral message array**
— `transcript.getMessages()` plus synthetic suffix — sent once and discarded.
`TranscriptManager` is never mutated, so:

- The verdict call is a near-full cache hit (existing prefix + small suffix).
- The next real turn shares the same prefix — cache intact.
- No "remove from history" step exists because history never contained the exchange.

## Architecture (Approach A — decorator)

New class `LlmApprovalGate` (`src/repo-search/engine/llm-approval-gate.ts`)
implementing the same `request(input): Promise<ApprovalDecision>` contract as
`ApprovalGate`. `ToolActionProcessor` is unchanged — it keeps calling
`this.deps.approvalGate.request()` (`src/repo-search/engine/tool-action-processor.ts:232-256`)
and does not know whether an LLM or a human answered.

`ToolActionProcessorDeps.approvalGate` becomes the interface type
(`ApprovalRequester`, extracted from the `request()` shape) rather than the concrete
`ApprovalGate` class.

### Construction & wiring

Approval mode is a three-state enum threaded end to end:

```
ApprovalMode = 'interactive' | 'auto' | 'off'
```

1. **CLI** (`src/cli/args.ts`): `--approval <mode>` value flag replaces
   `--no-approval` (removed outright, no alias). Default `interactive`.
   Validation rejects unknown values. `ParsedArgs.noApproval` → `approvalMode`.
2. **Dispatch** (`src/cli/dispatch.ts:53-57`): TTY assertion applies to
   `interactive` and `auto` (auto escalations still prompt via CLI); skipped for `off`.
3. **API body** (`src/status-server/routes/core.ts:873`): `approval: boolean`
   replaced by `approval: ApprovalMode` (zod enum, no boolean accepted).
4. **Gate creation** (`core.ts:878-887`): human `ApprovalGate` is created for
   `interactive` and `auto` (auto needs it as escalation target); `off` creates none.
   `approvalMode` is passed alongside the gate through
   `execute.ts` → `engine.ts` → `RunTaskLoopOptions`.
5. **Wrapping** (`src/repo-search/engine/task-loop.ts` constructor): when
   `approvalMode === 'auto'`, wrap the human gate:
   `new LlmApprovalGate({ humanGate, controller, transcript, progressWriter, requestId })`
   and pass the wrapper to `ToolActionProcessor`. Otherwise pass the human gate
   (or null) as today.

### Verdict call

`LlmApprovalGate.request()`:

1. **Fast path:** if `toolName` is in the static read-only set (the repo-search
   read/search/list tools that cannot mutate state), return `{ kind: 'approve' }`
   immediately — no tokens spent.
2. Build ephemeral messages: `transcript.getMessages()` + placeholder tool-result
   messages ("execution pending approval") for **every** tool call in the pending
   assistant batch (chat templates require results for all `tool_call_id`s) + a
   user-role reviewer question for the one command under review.
3. Call the model through a narrow `ApprovalVerdictController` interface exposed by
   `TaskLoop` (explicit object, no function passing), with a llama-cpp
   `json_schema`-constrained response:
   `{ verdict: 'approve' | 'deny' | 'unsure', reason: string }` (zod schema,
   `z.infer` for the type).
4. Map verdict:
   - `approve` → `{ kind: 'approve' }`
   - `deny` → `{ kind: 'deny', reason }` — flows into the existing
     rejected-tool-call feedback so the agent sees why.
   - `unsure` → delegate to `humanGate.request()` (existing SSE → CLI prompt path).
5. **Fail-safe:** any verdict-call error (inference failure, schema mismatch after
   retry) → delegate to `humanGate.request()`. Auto mode never silently approves on
   failure.

### Reviewer prompt (built-in heuristics, hardcoded)

The user-role question frames the model as an independent reviewer, not the author:

- Approve: read-only or clearly task-scoped commands with no side effects outside
  the repo working area.
- Deny: destructive (`rm -rf`, force-push, credential access, network exfil),
  out-of-scope, or commands unrelated to the stated task.
- Unsure: anything ambiguous — writes outside obvious scope, package installs,
  long-running processes, commands whose effect the reviewer cannot determine.

Bias instruction: when in doubt, prefer `unsure` over `approve`.

### Progress events

New event `approval_auto`:

```
{ kind: 'approval_auto', requestId, turn, toolName, command,
  verdict: 'approve' | 'deny' | 'unsure', reason }
```

Emitted for every LLM verdict (including `unsure`, before escalation, so the UI can
show "escalated by reviewer"). Fast-path approvals emit it with
`reason: 'read-only tool'`. CLI SSE listener prints a one-line summary. Escalations
then emit the existing `approval_request` unchanged.

## Error handling summary

| Failure | Behavior |
| --- | --- |
| Verdict inference error | Escalate to human gate |
| Verdict schema mismatch | One retry, then escalate |
| Human gate timeout (escalated) | Existing timeout error (unchanged) |
| `abort` from human on escalation | Existing abort path (throws) |

## Testing (TDD, E2E-first)

E2E through the engine with a scripted fake model client (existing fake-backend test
pattern), asserting:

1. `auto` + verdict `approve` → command executes; transcript contains no verdict
   exchange; next-turn message prefix byte-identical to pre-verdict state.
2. `auto` + verdict `deny` → rejected-tool-call feedback with reason; agent
   continues.
3. `auto` + verdict `unsure` → `approval_request` emitted; human `approve` executes
   command; `approval_auto` event with `verdict: 'unsure'` precedes it.
4. Verdict call throws → escalates to human gate.
5. Read-only tool → no verdict model call made; `approval_auto` fast-path event.
6. `--approval off` → no gate constructed; `--approval auto` without TTY → dispatch
   error; unknown `--approval` value → validation error.
7. API body with boolean `approval` → zod rejection (old contract fails loudly).

## Out of scope

- Dashboard UI for approval mode selection (no dashboard approval UI exists today;
  API consumers pass `approval` in the POST body).
- Configurable heuristics/rule files.
- Per-command allowlists beyond the static read-only fast path.

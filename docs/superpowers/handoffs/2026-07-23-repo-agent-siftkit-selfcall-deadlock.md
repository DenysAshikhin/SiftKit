# Handoff: repo-agent deadlocks when a `run` command invokes `siftkit`

**Date:** 2026-07-23
**Severity:** High — hangs the whole status server until a queue timeout; observed as a full freeze that required killing the server.
**Context:** Surfaced while dogfooding `repo-agent` on Task 2 of the LLM auto-approval plan. The plan's test-step commands pipe build/test output through `siftkit summary` (per the repo's SiftKit-First command policy). When the *agent itself* ran one, the run froze at turn 13 for 5+ minutes.

---

## What happened

Turn 13's approved `run` command was:

```
npm run build:test 2>&1 | siftkit summary --question "list compile errors with file:line"
```

`build:test` compiled fine, then piped into `siftkit summary`, which is a separate CLI process that POSTs a **summary** operation to the same status server on :4765. The server log showed:

```
st -------- incoming task=summary queue_position=2
```

…and then nothing. The repo-agent run never progressed. `status.running` stayed `true`. The server had to be killed.

## Root cause (single global model lock, held for the whole run)

The status server serialises **all** model-using operations through one global lock, `ctx.activeModelRequest`, plus a single FIFO `ctx.modelRequestQueue`:

- Every streamed operation acquires the lock **before** executing and releases it only in a `finally` **after** the whole operation completes:
  - [`streamed-operation-endpoint.ts:89`](../../../src/status-server/routes/streamed-operation-endpoint.ts#L89) `await acquireModelRequestWithWait(ctx, this.lockKind, req, res)`
  - [`streamed-operation-endpoint.ts:126-127`](../../../src/status-server/routes/streamed-operation-endpoint.ts#L126) `finally { releaseModelRequest(...) }`
- `lockKind` is only a **label**, not a separate lock. `summary`, `chat`, and `repo_search` all contend for the same single `activeModelRequest` slot:
  - repo-agent / repo-search: [`core.ts:838`](../../../src/status-server/routes/core.ts#L838) `lockKind = 'repo_search'`
  - summary: [`core.ts:709`](../../../src/status-server/routes/core.ts#L709) `lockKind = 'summary'`
- `acquireModelRequest` sets the single slot; a second request enqueues and waits:
  - [`server-ops.ts:464`](../../../src/status-server/server-ops.ts#L464), lock stored at [`:473`](../../../src/status-server/server-ops.ts#L473)
  - queue position = `(active?1:0) + queueIndex + 1` → [`server-ops.ts:359-361`](../../../src/status-server/server-ops.ts#L359)

For a repo-agent run, `execute()` **is** the entire multi-turn agent loop — including every `run` tool command it shells out. The model lock is held across all of it, not just during inference.

### The deadlock cycle

1. The repo-agent run holds `activeModelRequest` (kind `repo_search`) for its whole lifetime — it is queue position 1.
2. Turn 13's `run` command spawns `siftkit summary`, a separate process that POSTs a `summary` op to the same server.
3. That summary calls `acquireModelRequestWithWait`, finds the lock held, and enqueues at **`queue_position=2`**.
4. The repo-agent run is blocked synchronously waiting for the `run` command to return.
5. The `run` command can't return because its `siftkit summary` child is blocked in the queue.
6. repo_search never releases → summary never acquires → **deadlock.**

It is a deadlock-until-timeout, not permanent: the queued waiter has a wait timeout ([`readModelRequestQueueTimeoutMs`](../../../src/status-server/server-ops.ts#L55), applied at [`server-ops.ts:604-606`](../../../src/status-server/server-ops.ts#L604)) that eventually cancels the summary, failing the pipe and unblocking the run. But that is minutes of dead air and a confusing partial failure, and it stalls every other server client meanwhile.

## Why this is a footgun, not a one-off

Any `run` command a repo-agent executes that reaches back into the same siftkit server deadlocks — `siftkit summary` and `siftkit repo-search` both do. The repo's **SiftKit-First command policy** actively encourages piping through `siftkit summary`, so plans authored under that policy (this one included) plant the mine. A human running the same command at a terminal is fine (the server is idle); an agent running it *inside its own server-held run* is not.

## Fixes

**Immediate (unblocks Task 2 now, no code change):** repo-agent plans must run build/test commands **raw** — never pipe through `siftkit summary`/`repo-search` or any siftkit subcommand that hits the server. Update the auto-approval plan's Task 2–5 run steps accordingly, and treat "no siftkit calls inside repo-agent `run` commands" as a plan-authoring rule.

**Product fix (recommended, in priority order):**

1. **Fail loud instead of deadlocking.** When the engine spawns a `run` command, set an env marker on the child (e.g. `SIFTKIT_IN_AGENT_RUN=<requestId>`). The `siftkit` CLI checks it and refuses `summary`/`repo-search` immediately with a clear message: "cannot call siftkit from inside a repo-agent run — the model lock is held by the parent run." Cheap, prevents the hang entirely, converts a multi-minute freeze into an instant, legible error.

2. **Hold the model lock only around inference, not around tool/command execution.** Have the repo_search/agent operation release `activeModelRequest` while a `run` command executes (no inference happens then) and re-acquire before the next planner call. This removes the whole-run hold so concurrent summary/other ops can proceed. More invasive — re-acquisition can queue behind newcomers, changing latency — but it is the architecturally correct scope for a lock that exists to serialise GPU/model access.

3. **Detect the deadlock.** At minimum, when a queued waiter's lineage traces to the active run (via the env marker above), reject it rather than waiting out the full timeout.

Recommend shipping (1) now (guardrail) and evaluating (2) if in-run concurrent model calls are ever wanted. (1) alone makes the failure safe and obvious.

## Broader note
Even without self-calls, the single global lock means a second user's `summary` blocks behind any long repo-agent run. That is by design (one model), but the queue-wait timeout and the `queue_position` diagnostics are the only visibility — worth surfacing queue depth/holder in the CLI when a request waits more than a couple of seconds.

## Incident cleanup
Task 2's run was aborted (monitor + driver stopped, stray `siftkit summary` CLI killed, server killed by the operator). Before the deadlock the agent had written `tests/llm-auto-approval.test.ts` at turn 12 as **pure LF** — confirming the CRLF edit-tool fix worked on the write path — but that file is no longer in the working tree (tree is clean on `feat/interactive-approval-mode`); Task 1 remains committed. Task 2 will be re-run from a clean tree with raw, non-siftkit commands once the server is back.

# Session Handoff: LLM auto-approval feature (dogfooded via repo-agent)

**Date:** 2026-07-23
**Branch:** `feat/interactive-approval-mode`
**Goal:** Add an `auto` approval mode to repo-agent where the LLM reviews each pending command (approve / deny / unsure); `unsure` and verdict failures escalate to the existing human approval flow; the verdict call is ephemeral so it never breaks the llama-cpp prompt cache. We are implementing the plan **by driving repo-agent itself** (dogfooding), with a human (Claude) approving each command.

---

## Artifacts (all committed on `feat/interactive-approval-mode`)

| Doc | Path |
| --- | --- |
| Spec | [`docs/superpowers/specs/2026-07-23-llm-auto-approval-design.md`](../specs/2026-07-23-llm-auto-approval-design.md) |
| Plan (5 tasks, verbatim code) | [`docs/superpowers/plans/2026-07-23-llm-auto-approval.md`](../plans/2026-07-23-llm-auto-approval.md) |
| Bug handoff: CRLF edit-matching | [`handoffs/2026-07-23-repo-agent-crlf-edit-matching.md`](2026-07-23-repo-agent-crlf-edit-matching.md) |
| Bug handoff: self-call deadlock | [`handoffs/2026-07-23-repo-agent-siftkit-selfcall-deadlock.md`](2026-07-23-repo-agent-siftkit-selfcall-deadlock.md) |

## Status

| Plan task | State |
| --- | --- |
| **Task 1** — approval-mode enum + verdict JSON schema + `requestApprovalVerdict` | ✅ **Done & committed** (`30858e1`). Red→green→commit clean; 3/3 tests pass. |
| **Task 2** — `LlmApprovalGate` decorator + task-loop wiring + 6 E2E tests | ⛔ **Blocked / not started.** First attempt deadlocked (see below). Test file was written pure-LF at turn 12 then discarded; tree is clean. |
| **Task 3** — thread `approvalMode` through engine→execute→server; reject boolean `approval` | ⬜ Pending |
| **Task 4** — CLI `--approval <interactive\|auto\|off>`, TTY gating, `approval_auto` renderer line | ⬜ Pending |
| **Task 5** — full-suite verification sweep | ⬜ Pending |

## Two product bugs found while dogfooding

1. **CRLF edit-matching hell — FIXED by the operator.** `read` normalized CRLF→LF but `edit` matched `oldText` against raw CRLF, so multi-line edits never matched (Task 1 burned ~10 turns + produced a 1544-line EOL-polluted commit, since repaired to a clean 32-line diff). Fixed in commit `502c88d` (shared `readSourceText` normalizer) + `a53fd7d` (`.gitattributes` `* text=auto eol=lf`). **Verified working** in Task 2: the agent wrote a 206-line test file as pure LF. Both fix commits are on `feat` and compiled into the running server's `dist` (grep `readSourceText` in `src/repo-search/engine/repo-tools.ts` → 3 hits).

2. **repo-agent self-call model-lock deadlock — OPEN.** A `run` command that pipes through `siftkit summary`/`repo-search` deadlocks: the agent run holds the single global model lock for its whole lifetime, and the spawned `siftkit` subprocess enqueues behind it forever (until a queue timeout). Full analysis + fix options in the handoff above. **Immediate mitigation: repo-agent plans must run build/test RAW, never through `siftkit`.**

## Exact repo state
- On `feat/interactive-approval-mode`, working tree clean.
- Key commits present: `30858e1` (Task 1), `0fbf8fe` (CRLF handoff), `c399107` (deadlock handoff). Fix commits `502c88d` + `a53fd7d` present. `main` and `feat` both contain the fixes.
- Server: was killed by the operator after the deadlock. **Must be restarted before resuming** (`npm run start:status:stable` or equivalent; the run executes inside `dist/status-server`, and dist must post-date any src change — rebuild if you touch src).

## The oversight harness (recreate — it lives in ephemeral scratchpad)
Because the CLI needs a TTY we don't have, we talk to the same `/repo-agent` SSE endpoint the CLI uses, with a small Node driver (`agent-driver.mjs`) that:
- POSTs `{prompt, repoRoot, maxTurns}` to `http://127.0.0.1:4765/repo-agent`, parses the SSE stream.
- On each `approval_request` progress event: auto-approves read-only tools (`read/grep/find/ls`); for `write/edit/run/git` writes `pending-<id>.json` into a state dir and waits for the operator to drop `decision-<id>.json` = `{"decision":"approve"|"deny"|"abort","reason"?}`, then POSTs it to `/repo-search/approval`.
- Writes `result.json` / `error.json` on terminal frames.
A `Monitor` bash loop watches the state dir and surfaces each `pending-*.json` as a chat notification so Claude can review the diff and write the decision file. (Scratchpad path this session: `…/scratchpad/agent-driver.mjs`; recreate if gone.)

## How to resume
1. **Restart the status server**; confirm `/health` ok and it's running the fixed dist (server start time must be after the last `dist/repo-search/engine/repo-tools.js` build).
2. Ensure working tree is on `feat/interactive-approval-mode`, clean.
3. Recreate the driver + monitor if the scratchpad is gone.
4. **Re-run Task 2** with a short prompt: "Implement ONLY Task 2 from `docs/superpowers/plans/2026-07-23-llm-auto-approval.md`, following it exactly (TDD). Run all build/test commands RAW — do NOT pipe through `siftkit` (it deadlocks inside a repo-agent run). Only touch Task 2's files." Oversee approvals: verify each edit diff lands clean (LF), approve valid, deny/abort anything destructive or off-plan.
5. Continue Tasks 3→4→5 the same way. Each ends in its own commit with the plan's exact message.

## Open decisions for the operator
- Whether to land the deadlock **product fix** (env-marker guard in the `siftkit` CLI is the cheap win) before continuing, or defer and just keep commands raw.
- Whether to also patch the **plan doc** so Tasks 3–5 test steps are raw (they currently show `| siftkit summary`, inherited from the SiftKit-First policy — a footgun for repo-agent execution).

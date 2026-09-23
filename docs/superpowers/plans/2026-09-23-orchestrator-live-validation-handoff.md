# Orchestrator live validation handoff

**Status: plan only. Nothing here has been run yet.**

**Goal:** run the orchestrator against real models on all three surfaces (CLI, HTTP, web dashboard). Monitor SiftKit while it runs and confirm the whole flow behaves as designed. Every automated test so far uses scripted model responses; this is the first run against real models.

**Your role:** you run the scenarios and record the results. Do not fix code during validation. If something fails, record it using the finding format in section 7, then continue with the next independent scenario. Fixes are a separate, later task.

---

## 1. Current state

- Commit `ddb4b068` holds the orchestrator (O1–O8, including O5b) and model routing (M1–M7).
- On top of that, there are **uncommitted** drift fixes: 38 modified files plus the new file `src/lib/repository-key.ts`. Run `git status` to see them. They add:
  - **Per-check approval.** Before each plan check command runs:
    - `interactive` asks the person;
    - `auto` has the orchestrator's model decide;
    - `off` runs the command directly.
    A denied check does not run, which fails the attempt.
  - **Two pending-approval kinds:**
    - `{ kind: 'child', approvalId, childRunId, taskId, toolName, command, reviewPayload }`
    - `{ kind: 'check', approvalId, taskId|null, command, cwd }`
  - **Decide request** = `RepoAgentDecision` plus `runId` and `approvalId`.
  - **Structured evidence.** A passing review must cite evidence as `{ path, line, snippet }`, and the host checks that the snippet is at that line.
  - **Pinned config.** A run keeps the config it started with. Editing presets mid-run does not affect it.
  - **Stream frames.** Each SSE `progress` frame is `{ events: [...], state }`. The final frame is a `result` frame carrying the terminal state.
  - **Schema 79.** `orchestrator_runs.repo_key` holds the canonical repository identity, and `GET /orchestrator/runs?repoRoot=` looks up runs by that identity.
  - `/preset/run` rejects orchestrator presets and unknown presets before a model is admitted.
- Last verified: `npm test` 4216 tests (4212 pass, 0 fail, 4 skipped), `npm run test:dashboard` 543 of 543, `npm run typecheck` and `npm run lint` clean.
- Open items from the plan's "Delivery status" section, which this validation should cover where it can:
  - the plan is not rehashed before each dispatch;
  - no test cases for which drift findings the review should accept or reject;
  - the combined run views don't show which model each step used;
  - the three-reader cap, model capability, and cross-surface lifecycle rows are uncovered.

Reference docs:
- `docs/superpowers/plans/2026-09-22-orchestrator-preset.md` (the design, and the source of truth for intended behavior)
- `docs/superpowers/plans/2026-09-22-model-routing-orchestration-handoff.md`
- The orchestrator section of `README.md`

## 2. Preconditions (check these before any run)

1. **Back up the runtime DB.** The runtime root is the repo-local `.siftkit/`, not `~/.siftkit`.
   - The live `.siftkit/runtime.sqlite` is at **schema 76**. The first server start upgrades it in place: 76→77 adds the orchestrator preset, 77→78 adds the run tables, 78→79 adds `repo_key`.
   - Copy `runtime.sqlite`, `-wal` and `-shm` into `.siftkit/backups/pre-orchestrator-<date>/` first. Confirm the copy exists.
   - A preset with the ID `orchestrator` already in the catalog aborts the upgrade on purpose. The catalog currently holds summary, repo-search, chat, plan and repo-agent, so no conflict is expected.
2. **Build:** run `npm run build`.
3. **Start the server and dashboard:** run `npm start` (it runs `scripts/start-dev.ts`). The status server is on port `4765`. Check that `GET http://127.0.0.1:4765/status` answers.
4. **Models.** The configured model presets are all exl3 with `ParallelSlots` 1:
   - `exl3-3-8-27b`
   - `exl3-3-8-27b-2`
   - `exl3-3-8-27b-5bpw`

   In Settings, set up:
   - `orchestrator` preset → model A (for example `exl3-3-8-27b`)
   - `repo-agent` preset → model B (for example `exl3-3-8-27b-5bpw`)
   - `repo-search` → inherit (`null`), or model A

   Record the exact assignments in the results. With one slot, every A↔B switch is a real unload and load, which is what the approval flow has to exercise.
5. **Sandbox repositories.** Never point the orchestrator at the SiftKit checkout. Create throwaway git repos under `c:\tmp\rsx\` (already an allowed working directory):
   - `orch-small`: a minimal TypeScript package with one source file, `package.json` whose `"test"` is a quick `node --test`, one passing test, and an initial commit.
   - `orch-multi`: the same, plus three independent read-only questions to answer (for the cap scenario).
   - Keep one plan file per scenario under `docs/` in the sandbox (used for `--plan`).
6. Set **Maximum concurrent subagents** to 1 unless a scenario says otherwise.

## 3. What to watch while a run is live

| Signal | How to read it | What it confirms |
|---|---|---|
| Committed events and state | CLI: `siftkit orchestrator attach <runId>` (events print to stderr, the final JSON to stdout). HTTP: `POST /orchestrator/events {runId, afterSequence}`, SSE `progress` frames `{events, state}` | Phase and task transitions, approvals, attempts |
| Snapshot | `siftkit orchestrator status <runId>` or `GET /orchestrator/status?runId=` | Phase, pending approval, `failure` |
| Model queue and loads | `GET /status` → `modelRequests` (active and queued owners, loaded model) | The parent holds no model while a child runs; the load order for approvals |
| Durable store | Read-only SQLite on `.siftkit/runtime.sqlite`: tables `orchestrator_runs`, `orchestrator_attempts`, `orchestrator_events` | Revisions, attempt reservations (≤2 per purpose), event sequence with no gaps |
| Child transcripts | `.siftkit/repo-agent/runs/<childRunId>` (use the `find-logs` skill) | What each worker was told and did, and its approvals |
| Run artifacts | `<sandbox>/.siftkit/orchestrator/<runId>/plan.md` and `scratch/` | The generated plan; scratch is empty after completion |
| Workspace | `git -C <sandbox> status --porcelain` and `git diff` | Changes stay inside the task's `writePaths` |
| Server logs | `.siftkit/logs/` (the start-dev console) | Errors, lock timeouts, restarts |

Useful read-only queries:

```sql
SELECT run_id, phase, revision, repo_key FROM orchestrator_runs ORDER BY created_at_utc DESC LIMIT 5;
SELECT task_id, purpose, attempt, child_run_id, json_extract(attempt_json,'$.status') FROM orchestrator_attempts WHERE run_id = ?;
SELECT sequence, json_extract(event_json,'$.phase'), json_extract(event_json,'$.message') FROM orchestrator_events WHERE run_id = ? ORDER BY sequence;
```

Timing: real-model phases take minutes. Wait on the event stream, or poll `status` every 30–60 s. Do not tight-loop.

## 4. Scenarios

Each scenario lists its setup, the action, and **pass criteria**. Record evidence for every criterion: run ID, event sequence numbers, and a DB row or log line.

### S1. CLI read-only, `off`, generated plan (smoke)
- Action: in `orch-small`, run `siftkit orchestrator --approval off "Report which file exports the main function and its test command"`.
- Pass:
  - the phases go `preparing_plan → validating_plan → executing → verifying → cleaning → completed`;
  - `plan.md` is written by the host under `.siftkit/orchestrator/<runId>/`;
  - one implementation attempt on a `repo-search` worker;
  - no drift review (no code changed);
  - exit code 0, and the final stdout JSON has `status: completed`;
  - `scratch/` is empty.

### S2. CLI write task, `off`, drift review
- Action: `siftkit orchestrator --approval off "Add a greet(name) function with a unit test"`.
- Pass:
  - the task runs on `repo-agent` with exclusive repository ownership;
  - the plan's check commands really ran (`checks[].executed = true` in `attempt_json`);
  - the drift review runs, and its evidence is `{path,line,snippet}` that resolves to the changed lines;
  - if the review is actionable, a `drift_fix` attempt follows and a fresh review happens;
  - changes stay within `writePaths` (no `scopeViolations`);
  - the run completes and `npm test` passes in the sandbox.

### S3. `auto`: subagent approval decided by the orchestrator, one model slot
- Setup: as in §2.4 (orchestrator on A, repo-agent on B, one slot).
- Action: run the S2 task with `--approval auto`.
- Pass:
  - when a child escalates an approval, the child's model is released;
  - the orchestrator's model loads and its prompt says it is deciding a subagent's permission request;
  - after the decision, the child's model reloads and the **same** `childRunId` continues (no new attempt row);
  - `GET /status` model loads over time show B → A → B around each escalation;
  - each plan check command gets its **own** orchestrator decision phase (prompt: "decide whether to run one verification command"). Approved checks run and denied ones show `Not run: orchestrator: …`.

### S4. `interactive` from the CLI
- Action: `siftkit orchestrator --approval interactive "<S2 task>"` in one terminal, then `siftkit orchestrator status <runId>` in another.
- Pass:
  - `approval_required` shows the pending approval, with ready-made `decide` commands in the JSON;
  - a child approval has `kind: child`;
  - each check command is its own `kind: check` approval showing `command` and `cwd`;
  - a wrong `approvalId` gets 409;
  - `deny --reason` on a check means it never runs and the attempt fails with "never ran";
  - `approve` lets it continue.

### S5. Web dashboard: start, approve, reload
- Action: in the chat tab, turn on orchestrator mode and start with `interactive` for `orch-small`.
- Pass:
  - the panel shows the phase, plan path, task status and attempt label (`Implementation attempt n of 2`);
  - approval cards distinguish "Subagent for <task> requests <tool>" from "Orchestrator check in <cwd>";
  - Deny is disabled until a reason is entered;
  - **reloading the page mid-run reattaches** to the latest run (it is found by repository identity) and live updates resume;
  - no repeated `/orchestrator/status` requests appear in the browser network log (state arrives in the frames);
  - a failed attempt lists only command-check failures, never an unreviewed evidence check.

### S6. Cross-surface lifecycle (a previously uncovered row)
- Action: start in the web UI, then `siftkit orchestrator attach <runId> --after 0` and `status` from the CLI, answer one approval from the CLI, then reload the web UI.
- Pass:
  - the CLI replays all events with contiguous sequence numbers;
  - an approval decided from the CLI clears in the web UI;
  - the reloaded web UI shows the same state;
  - also try `repoRoot` spelled with a trailing slash, or in different case on Windows, and check that the web list still finds the run.

### S7. Supplied plan (`--plan`)
- Action: write a good plan to `docs/plan.md` in the sandbox, then `siftkit orchestrator --approval off --plan docs/plan.md`.
- Pass:
  - `planPath` is `docs/plan.md` and no second `plan.md` is generated;
  - the child instruction mentions `from plan docs/plan.md`.
- Also run it with a missing plan path. Expected: failure `plan_not_found` before any child starts.

### S8. Failure paths
- a. **Retry with evidence.** Make the plan's check fail (for example, require a file the task won't create). Expected:
  - attempt 2's prompt includes the real failed-check output from attempt 1 and its diff;
  - after 2 failures: `implementation_failed`, and dependent tasks stay `pending`.
- b. **Unresolved drift.** A task whose drift keeps coming back. Expected: at most 2 `drift_fix` attempts, then `drift_unresolved` with `findingIds`.
- c. **Denied check in `auto`.** Include a check that writes files (for example `Set-Content x.txt y`). Expected: the orchestrator's model should deny it and the file must not exist. This is a judgement call by the model, so record what the model decided and why.

### S9. Abort and restart
- a. While a child is running, run `siftkit orchestrator abort <runId>`. Expected:
  - the phase becomes `aborted`, the child is aborted, no approval is left pending;
  - `status` afterwards is still `aborted`;
  - reattaching reports the terminal state.
- b. Stop the server mid-run and restart it. Expected:
  - the run is `interrupted`, and is **not** redispatched;
  - its attempt rows are kept.

### S10. Subagent cap with parallel readers (a previously uncovered row)
- Setup: cap = 3, `orch-multi`, three independent read-only tasks.
- Pass:
  - up to 3 `repo-search` children overlap (check the task `running` statuses and the model queue);
  - a write task, if one is included, runs alone.
- With one model slot, children may queue behind each other for the model. Record the real overlap in repository ownership versus model ownership.

### S11. Pinned configuration
- Action: while S4 is waiting at its first approval, change the `repo-search` preset's allowed tools in Settings.
- Pass:
  - the rest of the run uses the tools it started with; check the later children's `allowedTools` in their transcripts;
  - a new run afterwards uses the new config.

### S12. Model capability (a previously uncovered row; exploratory)
- If one of the exl3 presets has a notably smaller context, assign it to `orchestrator` and run S2.
- Record how plan preparation, review prompts with a large diff, or an oversized plan are handled: a loud failure is acceptable, silent truncation is not.

## 5. Cross-cutting checks (apply to every run)

- Event `sequence` is contiguous from 1. The final `result` state matches `status`.
- Each `(task, purpose)` has at most 2 attempt rows. Every `childRunId` has exactly one transcript.
- The orchestrator's phases never overlap with its own child on the same model slot, and the orchestrator never holds a model while waiting for a child.
- No files are changed outside the task scope. Pre-existing dirty files in the sandbox are preserved; test this once with an uncommitted edit left in place before the run.
- Cleanup leaves `scratch/` empty. `plan.md` stays.

## 6. Order and time budget

Run in this order:
1. **S1 → S2 → S3.** Stop and report if S1 fails.
2. **S4 → S5 → S6.**
3. **S7 → S8 → S9.**
4. **S10 → S11 → S12.**

Expect roughly 5–20 minutes per real-model scenario. If a phase has made no progress for more than 15 minutes (no new events and no activity in the model queue), record it as a hang: capture `status`, `GET /status` and the tail of the server log, then abort the run.

## 7. Recording results

Create `docs/superpowers/plans/2026-09-2x-orchestrator-live-validation-results.md` with:
- the environment: commit, dirty-tree note, model assignments, slots, cap;
- a table with one row per scenario: `Scenario | Run ID | Result (pass/fail/partial) | Evidence | Finding IDs`;
- one block per finding:
  - `ID`
  - `scenario`
  - `expected` (quote the plan or README)
  - `observed`
  - `evidence` (event sequence numbers, SQL rows, log lines, `file:line`)
  - `severity`
  - `suspected area`: a file path. Do not propose a fix.

## 8. Rules for the next agent

- Follow `CLAUDE.md`. SiftKit may be used for log and output summarisation (`siftkit summary`) and fact extraction (`repo-search`). The orchestrator runs themselves are the thing being tested, so drive them with `siftkit orchestrator …` as described above.
- Do not change code, config defaults, or tests during this pass. You may change Settings (model assignments, cap) as the scenarios require, and record each change.
- Do not commit. Do not delete runtime DB rows. The backup from §2.1 is the rollback.
- At the end, restore the original Settings, stop the dev processes, and delete the sandbox repos unless a finding needs one kept (say which in the results doc).

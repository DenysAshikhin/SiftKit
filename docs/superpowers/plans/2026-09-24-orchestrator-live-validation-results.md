# Orchestrator live validation results

Handoff: `docs/superpowers/plans/2026-09-23-orchestrator-live-validation-handoff.md`. Date: 2026-09-24.

## Summary

- 13 runs across S1–S11. The durable mechanics hold on real models:
  - contiguous events and CLI/HTTP replay;
  - ≤2 attempts per task and purpose;
  - no scope violations and preserved dirty files;
  - approvals over the CLI and HTTP, including 409 on a wrong ID;
  - pinned config;
  - repository-identity lookup;
  - abort, and interrupt without redispatch;
  - `plan_not_found`;
  - parallel readers under the cap.
- **3 of 6 real-model write runs failed** (S2, S3, S4). In each failure the worker's code was correct; the run failed on the orchestrator's side.
  - **High:** F5 (strict plan-answer parsing), F10 (an unparsable auto decision is treated as a deny), F11 (`auto` children approve their own actions; the parent never decides child approvals), F13 (TabbyAPI VRAM crashes during model switches become denied checks or failed attempts), F14 (shell-incompatible check commands pass validation and can't be recovered from).
  - **Medium or higher:** F4 (every model switch loads target → previous → target), F6 (the parent's bad evidence citations burn the worker's attempts), F7 (every review needs a second phase), F8 (stale `plan.md` artifacts mislead the planner), F2, F15.
- Not covered: S5 and the web half of S6 (Chrome extension not connected), S8b (drift couldn't be provoked), and S12 (no smaller-context preset).

## Cleanup

- Settings were restored through `PUT /config`, and `app_config` matches the pre-validation copy with no field differences:
  - `orchestrator`, `repo-agent`, and `repo-search` `modelPresetId` = null;
  - cap = 1;
  - `repo-search.allowedTools` = `read,grep,find,ls,git`;
  - active preset `exl3-3-8-27b-5bpw`. The routing had auto-persisted `exl3-3-8-27b` and `runtime_model` during the runs.
- The dev server, dashboard, and engine were stopped.
- The sandboxes `c:\tmp\rsx\orch-small`, `c:\tmp\rsx\orch-multi`, and the scratch dir `c:\tmp\rsx\orch-val` (logs, helper scripts, timeline) were deleted; no finding needs a sandbox. The `c:\tmp\rsx\orch-val\…` paths cited below no longer exist.
- The durable evidence stays in `.siftkit/runtime.sqlite`: `orchestrator_*`, `run_logs`, `inference_runs`, and `inference_run_log_chunks`. It is also in `.siftkit/repo-agent/runs/<childRunId>/`.
- DB backup: `.siftkit/backups/pre-orchestrator-20260924/`. No DB rows were deleted, and no code or config defaults were changed.

## Environment

- Commit `6692d029` with a clean tree. The drift fixes that the handoff calls "uncommitted" are now committed (`a6026bea`).
- Runtime DB `.siftkit/runtime.sqlite` was **already at schema 79** before the first start (the handoff expected 76), with no orchestrator runs in it. A backup is in `.siftkit/backups/pre-orchestrator-20260924/`.
- The global `siftkit` CLI (`%APPDATA%\npm\node_modules\siftkit`) is byte-identical to the local `dist/` after `npm run build`.
- Server: `npm start`, status server on `:4765`, dashboard on `:6876`.
- Settings changes (made via `PUT /config`; originals saved at `c:\tmp\rsx\orch-val\app_config.orig.json`):
  - `orchestrator.modelPresetId`: null → `exl3-3-8-27b` (model A, 170k ctx)
  - `repo-agent.modelPresetId`: null → `exl3-3-8-27b-5bpw` (model B, 149k ctx)
  - `repo-search.modelPresetId`: null (inherit). **In practice, repo-search children ran on A** (run_logs `model_preset_id`).
  - Active model preset: `exl3-3-8-27b-5bpw`. All presets use `ParallelSlots` 1.
  - Cap `orchestrator.maxSubagents` = 1 (the default).
- Sandboxes: `c:\tmp\rsx\orch-small` and `c:\tmp\rsx\orch-multi` (`"test": "node --test"`, 1 passing test, initial commit).
- Model-queue timeline: `c:\tmp\rsx\orch-val\model-timeline.log`, sampled from `GET /status` once per second and logged on change.

## Results

| Scenario | Run ID | Result | Evidence | Finding IDs |
|---|---|---|---|---|
| S1 | `73f3c2a2-e17f-4c67-ab87-82b4d0b0f4a4` | pass (with findings) | exit 0, 643 s; events 1–34 contiguous; phases preparing_plan→validating_plan→executing→verifying→cleaning→completed; `plan.md` written by the host; 3 repo-search tasks, 1 attempt each, drift `not_required`; `scratch/` absent | F1, F2, F3, F4 |
| S2 | `eea5ab1b-d4f2-423d-9a2f-bffd99962af9` | **fail** | `plan_invalid` after 2 plan attempts (a bare fenced plan, then an extra `notes` key); 450 s, exit 1 | F5, F1 |
| S2 (rerun) | `da307314-c5a0-4ce3-8956-37d171b5467e` | pass (with findings) | exit 0, 2089 s; events 1–53 contiguous; 4 tasks. `implement-greet` and `add-greet-test` ran on repo-agent (model B), `checks[].executed=true` (`npm test` exit 0 plus a `node -e` contract check); drift reviews `clean`; `scopeViolations` `[]`; changes only in `src/main.js` and `test/greet.test.js`; dirty `README.md` preserved (hash unchanged); sandbox `npm test` 2/2; `scratch/` empty | F6, F7, F8, F9, F4 |
| S3 | `e7313524-cb6b-42c4-9fdf-9b31980fe577` | **fail** | exit 1, 1873 s; `implementation_failed` on `implement-greet-in-src-main`. Both attempts wrote a correct `greet` (diff verified), but one check each was "never ran" (attempt 1: an unparsable decision; attempt 2: TabbyAPI crash during the decision's model switch), and the attempt-2 evidence review was rejected for a `notes` key. Dependent tasks stayed `pending` (correct). Events 1–45 contiguous; ≤2 attempts per task. **No child approval ever reached the parent** | F11, F10, F13, F5, F6, F12, F4 |
| S4 | `24392c36-9fb7-404a-9941-7736b9703dcc` | partial (approval criteria pass; run **failed**) | 23 approvals answered from the CLI (`c:\tmp\rsx\orch-val\s4.driver.log`). `phase=approval_required` with the pending approval; `status` JSON contains ready-made `decide … approve / deny --reason / abort` commands. `kind: child` has `toolName`, `command`, `childRunId`, `taskId`, and `reviewPayload` (edit diff). Each check is its own `kind: check` with `command` and `cwd`. A wrong `approvalId` gets 409 via HTTP and CLI. `deny --reason` on a check → `Not run: validation S4: …`, the check `executed:false`, finding "… never ran.", attempt 1 `failed`. Attempt 2's prompt quotes the failure. `approve` continues. The run failed on `add-greet-unit-test`: an unrunnable check | F14, F3 |
| S7 (missing plan) | `1c6b0a5b-801e-4caf-a275-2bc036af98c7` | pass | `failed` `plan_not_found` ("Plan 'docs/missing.md' is not a file inside the repository.") at event #2, 0 s, `phaseRunIds: []`, no child started. `4492a064…` reproduced it accidentally | — |
| S7 | `e7f52839…` | pass (with findings) | exit 0, 637 s. `planPath: docs/plan.md`; no `.siftkit/orchestrator/<runId>/plan.md` generated. The child instruction reads "Implement ONLY task 'add-farewell' … from plan docs/plan.md (hash 40cc6564…)". Attempt 1 failed only because TabbyAPI crashed under the worker ("The evidence review failed: TabbyAPI exited unexpectedly"); attempt 2 passed; the drift review was clean | F13 |
| S8a | (S4 `24392c36…`, S3 `e7313524…`) | pass | Attempt 2's prompt (`request.json` of `c63f2026…`) contains "The previous attempt failed … fix exactly this:", the observed check results with real output (`Not run: validation S4: …`, the other check's `exit 0` output), "Files it changed", and the attempt-1 diff. After 2 failures: `implementation_failed`, and dependent tasks stayed `pending` (S3: `add-greet-unit-test`, `verify-scope-and-regression`) | — |
| S8b | `cddefea7-c53f-48c0-a41e-85f37005355b` | not reproduced | A supplied plan (`docs/plan-s8.md`) required `shout` to be a verbatim copy of `main` (drift bait). The drift review returned `clean`: it accepted the duplication because the plan mandates it (`resolutions[0]`: "The duplication is explicitly mandated by the accepted plan …"). No `drift_fix` attempt happened, so the `drift_unresolved` path is still unverified live | F6 |
| S8c | `cddefea7-c53f-48c0-a41e-85f37005355b` | pass (model judgement at plan time) | The supplied plan had a `Set-Content x.txt y` check on a read-only task. The planner answered `status: generated` and **removed** the check (issue: "verification used the PowerShell-only command 'Set-Content x.txt y' … Task 2 is assigned the read-only repo-search preset … yet its verification writes x.txt"), replacing it with a read-only export check. So it never reached a parent check decision. `x.txt` does not exist. The auto check decisions for the remaining checks all approved and ran. Run completed, exit 0, 1436 s. Note the planner's claim that the sandbox is "POSIX"; checks actually run in PowerShell (see F14). Attempt 1 of `add-shout-duplicate` failed only on "Provider returned an invalid task review payload: expected JSON object" (the parent's formatting) | F14, F6 |
| S9a | `be74b96c-4e32-410e-9cc9-11b15b76dcf5` | pass (with finding) | `siftkit orchestrator abort` while child `b94a1833…` was running (queued for its model) returned in 1 s, exit 0. Phase `aborted`, failure `aborted` "Aborted by user.", `approval: null`, child `state.json` → `aborted`, the model queue empty afterwards. `status` stayed `aborted`. `attach --after 8` replays #9 `aborted` and prints the terminal JSON. But the task stays `running` and the attempt `passed: null` | F15 |
| S9b | `b9d9078c-54da-470a-98eb-6dc8a63b78f6` | pass (with finding) | Killed `dist/status-server/main.js` (PID 39608) while child `f9fe487e…` held model B. The CLI detached with "SiftKit status/config server is not reachable …", exit 1. After the restart: phase `interrupted`, failure `interrupted` "The server restarted while this run was active; uncertain work was not redispatched.", event #9. No new attempt or child (not redispatched). The attempt row was kept. Reattach reports `interrupted` (exit 1). The attempt row `status` and the child `state.json` stay `running` | F15 |
| S10 | `844a673a…` (orch-multi) | pass | Cap set to 3 (`PUT /config`). Three independent repo-search tasks went `running` together (events #6–#8) and all three children started at 23:14:57Z. **Repository ownership overlapped (3 at once), but model ownership was serialized** by the single slot: timeline `active=1, queued=2` (23:14:58–23:18:51); children and parent reviews queued behind each other. The dependent `summary` task ran after all three. The parent never held the model while waiting for a child. Exit 0, 908 s, events 1–40 contiguous. No write task was included | — |
| S11 | (S6 `2aed4a88…`, S10 run) | pass | Changing tools mid-run in S4 had no later repo-search child to observe, so the check was redone in S10. At the first child start (23:14:57Z), `repo-search.allowedTools` was changed from `read,grep,find,ls` to `read,grep,find,ls,git`. The later `summary` child (`b5526a5b…`, 23:22:25Z) still had `read, grep, find, ls` (pinned). A **new** run after a change (S6, after the S4-time change dropped `git`) used the new list: `037c7c63…`/`d8b6565e…` `tools: read, grep, find, ls` | — |
| S12 | — | not applicable | No exl3 preset has a notably smaller context (`exl3-3-8-27b` 170k, `-2` 155k, `-5bpw` 149k). Not run | — |
| S5 | — | **blocked** | The Claude-in-Chrome extension was not connected, so the dashboard UI couldn't be driven. Not run | — |
| S6 | `2aed4a88-c409-4a1d-8279-0e0904dd003a` | partial (CLI/HTTP pass; web UI blocked) | Started via `POST /orchestrator` (the web UI's endpoint). A second POST with the same `submissionId` returned the same runId (idempotent). `siftkit orchestrator attach --after 0` replayed events 1–30 contiguously and exited 0 with the terminal state. Both `kind: check` approvals were decided from the CLI, and the approval cleared (`approval: null`). The run completed. `GET /orchestrator/runs?repoRoot=` finds runs for `c:\TMP\rsx\ORCH-small\`, `C:/tmp/rsx/orch-small/`, and `…\orch-small\.` (tested earlier). The web-UI clear-on-decide and reload checks were not run | — |

### Cross-cutting checks (§5), all 13 runs (`c:\tmp\rsx\orch-val\xcut.cjs`)
- Event `sequence` is contiguous from 1 in every run (2–133 events). For S1, S6, and S9 the final `result` / stdout state matched `status`.
- Every `(task, purpose)` has ≤2 attempt rows. Every `childRunId` has one `.siftkit/repo-agent/runs/<id>/` directory, but repo-search transcripts are not keyed by it (F3).
- The parent never held a model while a child ran, and parent and child never overlapped on the slot (timeline across all runs).
- `scopeViolations` is 0 in all attempts. The pre-existing dirty `README.md` was preserved in every orch-small run (hash unchanged in S2; `M README.md` throughout).
- `scratch/` is absent or empty after every completed run. It was left populated after the failed S3 (F12). `plan.md` stays.

### S1 notes
- The model split the question into 3 read-only tasks (`locate-main-export`, `identify-test-command`, `compose-final-answer`), so there was one implementation attempt **per task**, not one in total. That is the model's choice, not a defect.
- Model queue: the parent and child never overlapped. Active owners alternated orchestrator ↔ repo_search, with `ownerRunId` = `childRunId` (timeline 17:34:20–17:39:39).
- Evidence checks were recorded as `executed: false` and command checks were absent from the tasks. The final `npm test` check was in `finalVerification`.

### S2 notes
- Drift evidence as `{path,line,snippet}` exists only on actionable drift **findings** (`OrchestratorDriftFindingSchema`). Clean reviews carry free-text `resolutions` by design. No actionable finding came up, so the `drift_fix` path and structured-evidence check were not exercised here (see S8b).
- Pre-existing dirty-file check (§5): `README.md` was edited before the run and not committed. It was preserved byte-for-byte, and the planner and workers respected it explicitly.
- Before S3, the sandbox was reset: `src/main.js` restored, `test/greet.test.js` removed, the README edit kept, and the prior `.siftkit/orchestrator/*` artifacts moved to `c:\tmp\rsx\orch-val\artifacts\` to stop F8 compounding.

## Findings

### F1: A plan-preparation phase error is swallowed with no event
- scenario: S1
- expected: every phase and transition is observable in the committed events (handoff §3, "Phase and task transitions").
- observed: event #2 and event #3 are both `preparing_plan: Parent phase started.`, with nothing between them explaining the retry. The first phase `0be9b06f` finished `verdict=pass`, but its answer added an extra `evidence` key to every step, which the plan schema does not define. The error was only fed into the second phase's prompt (1847 → 3147 prompt chars).
- evidence: `orchestrator_events` seq 2–3 for run `73f3c2a2`; `run_logs` `0be9b06f…` final output; server log `13:32:36 rs f2321f65 start prompt_chars=3147`.
- severity: medium (diagnosability)
- suspected area: `src/orchestrator/run.ts:235-238` (the `catch` sets `previousErrors` and continues without `commit`)

### F2: The final result of a read-only run does not contain the answer
- scenario: S1
- expected: a read-only "Report …" task gives the caller the report.
- observed: the stdout JSON and the `status` snapshot contain only the status, tasks, and attempts (`passed: true`). The answer exists only in `orchestrator_attempts.attempt_json.result.workerOutput` and in the child `state.json`.
- evidence: `c:\tmp\rsx\orch-val\s1.out`; attempt `21944dbf…` `result.workerOutput`.
- severity: medium (usability of read-only runs)
- suspected area: `src/cli/run-orchestrator.ts` / the orchestrator status projection

### F3: Repo-search child transcripts are not keyed by `childRunId`
- scenario: S1
- expected: "Every `childRunId` has exactly one transcript" (handoff §5).
- observed: `.siftkit/repo-agent/runs/<childRunId>/` holds only `request.json` and `state.json`. The actual repo-search transcript is in `run_logs` under a different ID (for example child `d56d0b16…` → run_log `3da38f1c…`), and neither side references the other. The two can only be linked by timing.
- evidence: `run_logs` rows where `operation_preset_id='repo-search'` after 17:34Z; `instr(repo_search_json,'d56d0b16') = 0`.
- severity: low–medium (auditability)
- suspected area: the repo-search worker dispatch in `src/orchestrator/` → `src/repo-search/execute.ts` (request ID not propagated)

### F5: Strict plan parsing plus 2 attempts regularly fails plan preparation on a real model
- scenario: S2 (run `eea5ab1b-d4f2-423d-9a2f-bffd99962af9`); also S1 attempt 1 (see F1)
- expected: S2 reaches `executing` with a generated plan (handoff §4 S2).
- observed: `failed`, `plan_invalid`, "No valid plan after 2 attempts: Unrecognized key: \"notes\"", 450 s, exit 1.
  - Attempt 1 (`0cf7e72d…`) returned the plan object **bare**, inside a ```` ```json ```` fence, without the `{status, plan}` wrapper. The error was "Invalid discriminator value" on `status`.
  - Attempt 2 (`438e2f7b…`) was correct apart from an extra top-level `notes` key.
  - In S1, attempt 1 added `evidence` to every step.
  - So 3 of the 4 plan answers seen so far were rejected only for shape (extra keys or a missing wrapper); the plan content itself was sound. The failure message also shows only the last error, not the first.
- evidence: `run_logs` final outputs of `0cf7e72d…` and `438e2f7b…`; the retry prompt includes "Your previous answer was rejected: … invalid_union".
- severity: high (makes plan generation on real models a coin flip; blocks the write scenarios)
- suspected area: the plan-answer schema (`.strict()` objects) used by `src/orchestrator/` phase parsing; `PLAN_PREPARATION_ATTEMPTS` in `src/orchestrator/run.ts`

### F6: A bad evidence citation from the parent review fails the worker's attempt
- scenario: S2 rerun (run `da307314-c5a0-4ce3-8956-37d171b5467e`), task `baseline-recon`, attempt 1 (`b58c3e63…`)
- expected: the host checks that a snippet is at its cited line (handoff §1). A failed attempt should reflect the worker's work.
- observed: the worker completed correctly. Both command checks passed (`npm test` exit 0, `git status` exit 0). The parent's pass review cited 20 evidence items, and 2 of them had the parent's own commentary appended, for example `"export function main(args) {  // only \`export\` occurrence …"`. The host rejected those 2 (findings: "src/main.js:1 does not contain the cited snippet", "README.md:5 …"). The attempt was marked `failed` and a retry was spent (event #11 "Settled implementation attempt 1: failed", #12 retry pending).
- evidence: `attempt_json.result.findings` for `b58c3e63…`; the review phase final output (2nd phaseRunId).
- severity: medium-high (the parent's formatting errors use up the worker's 2-attempt budget)
- suspected area: `src/orchestrator/run.ts` implementation review / evidence verification (the code that maps an evidence mismatch to `passed: false`)

### F7: Every drift review needs a second parent phase because the first answer is rejected
- scenario: S2 rerun (`da307314…`), tasks `implement-greet` and `add-greet-test`
- expected: one drift-review phase per changed digest, unless the model truly fails.
- observed: each drift review ran 2 parent phases (events #27/#28 and #38/#39, both "Parent phase started." with no reason given). The first answers were plain prose (`f31bb4b3…`: "Confirmed: `greet` exists only at …") and a ```` ```json ```` fenced object (`d29961e6…`). The retries (`b5eb2d94…` and `4034e689…`) were accepted. Implementation reviews have the same shape: `baseline-recon` needed 2 reviews, although that was F6. So this is the F1/F5 pattern again, now on review phases: rejections are silent, and fenced JSON is not tolerated.
- evidence: `run_logs` final outputs for the phaseRunIds of run `da307314…` (index 4–5 and 7–8); `c:\tmp\rsx\orch-val\phaselist.cjs`.
- severity: medium (doubles review cost and latency, about 1–2 min per phase; one more rejection would fail the run)
- suspected area: phase answer parsing in `src/orchestrator/phase-runner.ts`

### F8: Earlier runs' `plan.md` artifacts appear in later runs' repository listing and mislead the planner
- scenario: S2 rerun (`da307314…`) in the same sandbox after S1
- expected: run artifacts under `<repo>/.siftkit/orchestrator/<runId>/` are host-owned and do not feed into later planning (the "Repository file listing (respects ignore policy)").
- observed: the plan phase's system prompt listed `.siftkit/orchestrator/73f3c2a2…/plan.md`, although `.siftkit/` is git-ignored (via the global excludes file, `check-ignore` confirms). The planner read it (turn 2), treated it as "the supplied plan", and spent 5 `issues` rejecting it ("The supplied plan … targets a different goal entirely") even though `Supplied plan: none`.
- evidence: `run_logs` `9bedb8f2…` transcript (the system listing and the turn-2 `read path=".siftkit/orchestrator/73f3c2a2…/plan.md"`); the final output's `issues`.
- severity: medium (the planner is confused by stale state; it will get worse as runs accumulate in a repo)
- suspected area: the repository file listing / ignore policy used by `includeRepoFileListing` (the repo-search prompt context), in combination with the artifact dir from `orchestratorArtifactDir` in `src/orchestrator/`

### F9: Repo-agent children appear as `kind: repo_search` in the model queue
- scenario: S2 rerun
- expected: the model queue identifies what holds the model (handoff §3).
- observed: the `implement-greet` child (worker `repo-agent`, model B) appears as `{"owner":"repo_search","kind":"repo_search","ownerRunId":"05e32a83…"}`.
- evidence: `model-timeline.log` 18:03:14Z.
- severity: low (misleading observability)
- suspected area: model-request owner labelling for orchestrator children in `src/orchestrator/` child start → the model request queue

### F10: An unparsable auto decision becomes a silent denial that fails a correct attempt
- scenario: S3 (run `e7313524-cb6b-42c4-9fdf-9b31980fe577`), task `implement-greet-in-src-main`, attempt 1
- expected: "each plan check command gets its own orchestrator decision phase … Approved checks run and denied ones show `Not run: orchestrator: …`" (handoff §4 S3).
- observed: decision phase `a59e7111…` answered with prose followed by a valid `{"decision":"approve","reason":…}`. The host rejected it ("Provider returned an invalid approval decision payload: expected JSON object") and `decideOnParentModel` turned that into a **deny**. The check was recorded as `Not run: The orchestrator could not decide this request: …`, the attempt got finding "Check … never ran." and was `failed`, and the retry was spent. The worker's change was correct. There is no retry for a decision phase, and the event log only says "Approval resolved." (#26, #29), with no decision or reason.
- evidence: `attempt_json.result.checks[1].output` of attempt 1; `run_logs` `a59e7111…` final output; events #24–#31.
- severity: high (auto mode fails correct work on a formatting slip; the outcome can't be seen in events)
- suspected area: `src/orchestrator/run.ts:457-465` (`decideOnParentModel` catch → deny); approval payload parsing in `src/orchestrator/phase-runner.ts`; the "Approval resolved." commit at `run.ts:448`

### F11: In `auto` mode, children approve their own tool calls; the parent never decides child approvals
- scenario: S3
- expected: "With `auto`, the parent's `decideChildApproval` phase loads the parent model and answers. The child then re-queues for its own model and continues the same attempt." (orchestrator-preset.md:684). Handoff S3 expects B → A → B around each escalation.
- observed: children get `approvalMode: request.approval`, so in `auto` they are started with `approval=auto` (`request.json` of `e8622ee1…`, `8257de67…`, `017f38a2…`, `101442ee…`). The repo-agent's built-in auto-approver answered every edit, write, run, and git call on the **child's** model (server log `14:38:09 rs cdf6ccd1 auto-approval t3 approve: edit …` through `14:38:40 … approve: git`). No `kind: child` approval or "decide a subagent's permission request" phase occurred. No B→A→B load pattern around child approvals was seen. Only the check approvals went to the parent.
- evidence: server log 14:38:02–14:38:44; `orchestrator_events` for `e7313524…` contain only `Approval requested: run <check>` events.
- severity: high (the design's parent-decided child approvals are not in effect for `auto`; the §2.4 model-switch scenario cannot be exercised)
- suspected area: `src/orchestrator/workers.ts:27` (`approvalMode: request.approval`)

### F12: A failed run leaves `scratch/` populated
- scenario: S3
- expected: "Cleanup leaves `scratch/` empty" (handoff §5).
- observed: after `failed`, `.siftkit/orchestrator/e7313524…/scratch/main.before.js` (written by the worker) remains. The `cleaning` phase only runs on success.
- evidence: `check.cjs` output `scratch [ 'main.before.js' ]`.
- severity: low
- suspected area: `src/orchestrator/run.ts` terminal handling (the failure path skips cleanup)

### F13: A model switch crashes TabbyAPI (insufficient VRAM), and the orchestrator turns the error into a denied check
- scenario: S3
- expected: a model switch either succeeds or fails loudly. A parent phase that fails on infrastructure should not be counted as a model decision.
- observed: engine runs `051d880a…` (18:44:23) and `8dae9dea…` (18:46:08) failed with `RuntimeError: Insufficient VRAM in split for model and cache (autosplit: cuda:0 has 720 MiB of physical headroom left …)` → `TabbyAPI exited unexpectedly (code=1)` → `preset-switch` error, rollback "Kept the newer saved selection". The second one hit the parent's decision phase for check `node --check src/main.js`, which `decideOnParentModel` converted into a deny ("Not run: The orchestrator could not decide this request: TabbyAPI exited unexpectedly …"). That failed attempt 2 of a correct change.
- evidence: `inference_runs` rows 051d880a…/8dae9dea… (`status=failed`); engine log tail; `model-timeline.log` 18:45:30 and 18:47:17; attempt 2 `checks[0].output`.
- severity: high (infrastructure flakiness becomes task failure)
- suspected area: `src/status-server/preset-runtime-coordinator.ts:344-385` (`executeSwitch`: unload → immediate load, no VRAM settle); `src/orchestrator/run.ts:457-465`

### F14: The plan accepts shell-incompatible check commands, and the worker can't recover because checks are fixed
- scenario: S4 (`24392c36…`), task `add-greet-unit-test`
- expected: plan validation ensures "exact verification checks" can run. A retry can fix a real failure.
- observed: the generated plan's check was `node --test --test-reporter=spec 2>&1 | grep -E 'greet greets by name'`. Checks run under PowerShell, where `grep` doesn't exist (`CommandNotFoundException`), so the check exits 1. Both attempts wrote a correct test (`npm test` 2/2 pass in both), and both failed on this check. The run failed `implementation_failed`. The worker can't change the plan's check, so the retry was certain to fail.
- evidence: attempt `checks[1].output` for both `add-greet-unit-test` attempts; `s4.out` failure.
- severity: high (a planner slip ends the run on Windows; nothing validates it and there's no way back)
- suspected area: `validateOrchestratorPlan` in `src/orchestrator/plan.ts` (no shell or tool check) and the plan-prep prompt in `src/orchestrator/prompts.ts` (it doesn't name the check shell); `src/orchestrator/verification.ts` (shell used)

### F15: After an abort or interruption, task, attempt, and child states stay "running"
- scenario: S9a, S9b
- expected: the task states include `aborted` (orchestrator-preset.md:220). A terminal parent should not show live work.
- observed: S9a: the parent is `aborted`, but `tasks[add-farewell].status = running` and the attempt `passed: null`. S9b: the parent is `interrupted`, but the task is `running`, `orchestrator_attempts.attempt_json.status = running`, and the child `.siftkit/repo-agent/runs/f9fe487e…/state.json` says `status: running`, even though its process died with the server.
- evidence: `siftkit orchestrator status be74b96c…` / `b9d9078c…`; the attempt row query; the child `state.json`.
- severity: medium (the dashboard or panel will show running tasks under a terminal run; repo-agent runs are never reconciled)
- suspected area: the abort and interrupt paths in `src/orchestrator/run.ts` (the `aborted` commit at 181) and startup reconciliation in `src/orchestrator/run-store.ts`

### F4: Every A↔B model switch loads the target, the previous model, then the target again
- scenario: all (S1–S3)
- expected: one unload plus one load per switch (§2.4: "every A↔B switch is a real unload and load").
- observed: every switch follows the same `inference_runs` pattern: target starts and logs "Model loaded"/"Serving" (~50–57 s) → stopped → the previous model starts (~15 s) → stopped → the target starts again and stays. Example: 17:28:56 A (`0bc40ea7`, loaded 13:29:53 local) → 17:29:53 B (`6fd12632`, loaded) → 17:30:09 A (`496a3d66`, kept). The same appears at 18:01:44, 18:03:31, 18:10:22, 18:13:03, 18:36:22, and 18:38:45. `/runtime/inference` shows no `error` or `rollback` for these (for example 18:39:40 `A/stopping/ready` → 18:39:42 `A/starting` → 18:39:56 `B/starting`), so this is not the rollback path. Each switch costs about 75–130 s instead of about 60 s, and the extra load is when the VRAM crash in F13 happens.
- evidence: `inference_runs` since 17:25Z (all `exit_code=1`, `status=stopped`); `model-timeline.log` (rt= columns from 18:25Z).
- severity: medium-high (doubles switch latency; likely contributes to F13)
- suspected area: residency / active-preset reconciliation in `src/status-server/preset-runtime-coordinator.ts` (`ensureActivePresetReady` vs `ensureRequestPresetReady`, `persistAppliedModelSelection` ordering) and the `GET /config` handler that calls `ensureActivePresetReady` (`src/status-server/routes/server-admin.ts:184-212`). Unconfirmed which caller re-applies the previous preset.

# Orchestrator run e85529c8: 4.18bpw orchestrator, 27B worker

**Setup.** Orchestrator on `exl3-3-8-next-4-18bpw-f16` (Qwen3.8 Flash-Next 4.18bpw, NcpuMoe 424, MTP draft 3, prompt-lookup 5, 200k context). Workers on `exl3-3-8-27b-5bpw`. Same task, repository, and `auto` approval as baseline run 60dc585d (3.5bpw orchestrator, 27B worker), which completed in 456 min with 12 tasks and 18 attempts. Default budget: 720 min, 80 dispatches. The orchestrator code also changed since the baseline (run budget, approaches, retiring tasks), so this is not a pure model comparison.

## Outcome

**Aborted by request at 23:08Z, after 423 min** (the machine was needed). 13 of 16 tasks were completed, plus one retired and split. `dash-agent-panes` was mid-attempt; `dash-flow-prompt`, `dash-live-agents`, and final verification never ran. Run totals:

- 19 attempts: 13 implementations passed, 4 fixes passed, 1 not submitted (the compaction failure), 1 aborted.
- Reviews: 13 passed, 4 failed. Every fail found a real defect: tool-result matching, missing 409 and live-fallback tests, the refetch flicker plus a duplicate test file, and the prompt-part block parsing.
- 55 engine sessions (model loads).
- The server's changes are left uncommitted in `C:\tmp\rsx\siftkit-compare-fresh` (branch `safety-run`).

**Against the 3.5bpw baseline (60dc585d, 456 min, all 12 done):** the reviews were at least as good (each fail was a real bug, and it caught a spec path mismatch in its own earlier work). It recovered well from a failed worker by retiring and splitting the task. But the first plan was less complete (prompt-part constants added later), planning was slower, and tool use was sloppier. At abort it was on course for about 8.5 h. The overrun came mostly from the harness: 11 min of re-exploration after the first compaction, 9 approval escalations at about 80 s each, one 23-min attempt lost to the compaction overflow, and one cold 165k re-prefill from the RAM disk wipe. Worker thinking spikes added more. This run does not show the 4.18bpw orchestrator to be better than the 3.5bpw. A fair comparison needs both runs on the same harness after fixes 4–17.

## Where the time went (measured after the run)

From `run_logs` transcripts and the engine log. The 423 min break down as:

| Bucket | Min | Notes |
|---|---|---|
| Worker model time (27B) | 200 | 1.28M tokens generated at 109.5 tok/s; 900k of them thinking (70%) |
| Orchestrator model time (Flash) | 120 | 352k generated (200k thinking) at about 65 tok/s decode, 26.6 min prefill |
| Approval reviewer calls | 25 | 419 calls, median 3.2 s, nearly all routine edits and test runs |
| Engine starts (model swaps) | 22 | 55 starts: Flash 27 × 35 s, 27B 28 × 13.5 s |
| Worker tool execution | 22 | mostly test, typecheck, and lint runs |
| Worker compactions | 10 | 5 compactions |
| Orchestrator `run_check` | 5 | |

**Thinking spikes.** 39 of the 1,280 27B requests generated 8k tokens or more, and took 79 min: 36% of the worker model time. The 24 turns above 10k share one pattern. The model drafts the whole test or implementation file inside its thinking, hits one detail it is unsure of, and ends with "let me check X". 20 of the 24 then issue a read, grep, or run rather than the write, and the next turn drafts again. Across those 24 turns there are 302 "Wait"s and 264 "Actually"s. A per-turn cap of 8k (fix 16) bounds this at about 29 min saved, plus the context growth that drove compactions. So does a prompt line: once a file is drafted, write it and let typecheck find the details.

**Lost outright, about 1.7 h:**
- `agent-endpoints`: 23 min attempt, no output (fixes 11, 12, 16).
- `live-flow-sources` review: 22.4 min against a usual 2–5 (fixes 8, 9).
- Re-exploration and refused `save_plan`s after compactions: about 15 min (fixes 4, 5).
- Orchestrator-caused rework: the duplicate test file fix cycle and the `agent-flow-path` correction, about 20 min (fix 14, and reviewing routes against the spec).
- 9 escalations: about 12 min (fix 6).
- The dashboard restructure: 16 min, of which about 10 was refused `update_tasks` calls (fix 13).
- RAM disk wipe: about 2.5 min (fix 7).

**Reducible, about 1 h:** thinking spikes (up to 29 min), routine approval calls (most of 25 min via rule-based approval of in-scope edits and repository test commands), and repeated full-suite runs by workers (part of 22 min, fix 17).

**Observability bug.** `run_logs.model` records the model loaded when a run finishes, not the one it ran on. Three 27B workers are labelled Flash because the swap back had started, and the orchestrator run is labelled 27B.

## All fixes at a glance

| # | Fix | Kind | Cost seen |
|---|---|---|---|
| 1 | Batch independent reads | prompt | 1 call per turn while planning |
| 2 | Read the named spec first, in order | prompt | spec read at turn 30 |
| 3 | Default omitted plan list fields to empty | harness | 1 round trip, about 7k tokens |
| 4 | Keep planning findings (anchors, pitfalls) in `plan.md` | harness | 11 min of re-exploration (16:24:44Z to 16:35:44Z) |
| 5 | After compaction: plan is saved, read `plan.md`, dispatch the next ready task | prompt and harness | `save_plan` refused twice; 55 turns before the first dispatch |
| 6 | Safety reviewer judges safety only; approve benign edits | prompt | 9 escalations, two swaps each, about 12 min |
| 7 | RAM disk wipes a full cache at a swap | harness bug | a cold 165k re-prefill (about 3 min) |
| 8 | Say that changes are uncommitted; give the diff command | prompt | invented commit hash, wrong diff bases |
| 9 | Review only the reported task; `run_check` is not for reading | prompt and harness | a 38-turn, 21-min review |
| 10 | Targeted reads for workers; put line anchors in instructions | prompt | 115k of context before a first edit |
| 11 | Compaction must always fit (margin, shrink, no identical retry) | harness bug | a 23-min attempt lost |
| 12 | First-edit deadline for workers | prompt or harness | 93 turns of reading only |
| 13 | One-call plan restructures | harness | 5 refused `update_tasks` calls |
| 14 | Check new plan paths against existing files | prompt or harness | duplicate test file, a review fail |
| 15 | Review before the next dispatch | harness | a review 34 min late |
| 16 | Cap worker thinking per turn | harness | turns of 12–21k thinking; about half of every fix |
| 17 | Gate owns the full checks; workers run targeted tests | prompt | 9–14 runs per fix |

Also noted: the write-path limit is not enforced (Plan quality); instruction text keeps self-corrections; small cache-break warnings are noise.

## Prompt fixes to make after the run

### 1. Batch independent reads

**Seen.** The orchestrator made exactly one tool call per turn: 50 calls in 50 turns before its plan, at about 13 s per turn. The 3.5bpw baseline averaged about 1.6 calls per turn (66 calls by turn 42, when it saved its plan).

**Fix.** Tell the orchestrator to issue independent reads, greps, and finds together in one turn, and to call one at a time only when the next call depends on the result. The prompt says nothing about this today.

### 2. Read the spec or plan first

**Seen.** It explored code for 29 turns before opening the design spec at turn 30. It then read the spec out of order: the end first, then the start, then the middle.

**Fix.** Rule 1 in `src/orchestrator/prompts.ts` already says "Read the requirements: the task and any spec or plan it names", and the model did not follow it. Make the order explicit: read the whole named spec or plan, start to end, before any other exploration.

### 3. Default omitted list fields in save_plan (harness)

**Seen.** At turn 54, the first `save_plan` failed validation because the first task had no `temporaryPaths` ("expected array, received undefined"). The resend at turn 55 worked. The round trip cost about 7k tokens of context, right at the plan deadline.

**Fix.** Treat an omitted list field in a plan task (`temporaryPaths`, `readPaths`, `dependsOn`) as an empty list. Keep rejecting wrong types.

## Plan quality

- The first `save_plan` held 4 tasks, the most one call allows: `contracts-phase-runs` (§1.1), `schema-upgrade-84` (§1.4), `review-criteria-results` (§1.2 and §1.3), and `flow-contracts-live-flows` (§2.2 and §2.3). Endpoints (§2.1) and the dashboard board (§3) are left for `update_tasks`.
- **Good.** Every task maps to a section of the spec, the dependency order is right, acceptance criteria name real symbols, and every task has check commands. The final verification covers the orchestrator unit tests, the e2e and chat-sessions process tests, the dashboard suite, typecheck, and lint.
- **Rule broken.** `contracts-phase-runs` has 12 write paths and `review-criteria-results` has 8. The prompt allows "at most about 6 write paths … Split anything larger". Nothing in the code enforces that limit, so it could be checked in `validateOrchestratorPlan`.

## Other observations

- **Baseline test runs before planning.** It ran a unit subset twice, the full dashboard suite twice, the e2e process test, and `npm run typecheck`. Rule 1 explicitly asks for baselines, so this was prompted behaviour, not drift. One of the dashboard runs was a safety reject, because it piped the output through `Select-Object`.
- **Context before the plan.** It had used 141k of its 200k context with no plan saved. A compaction before `save_plan` would leave the digest with no plan to carry over, so the exploration would be lost.
- **The plan deadline fired.** At turn 52 an `ls` of `tests` took the prompt from 149k to 158.5k tokens, past the 75% plan deadline (150k; `ORCHESTRATOR_PLAN_DEADLINE_SHARE` in `turn-budget.ts`). Its next grep was refused, and from then on only `save_plan` is accepted. That leaves about 20k tokens before compaction at about 180k to write the first plan call. The safety net works, but the plan is written under pressure. Fixes 1 and 2 should get it to the plan well before the deadline.
- **Speed.** Orchestrator decode ran at a median of 65.6 tok/s, against 72–74 tok/s for the 3.5bpw. Prefill ran at a median of 753 tok/s, and still 764 tok/s at 137k context, so no VRAM spillover.

## After the plan

- **Plan finished in three calls.** `save_plan` (4 tasks), then two `update_tasks` calls added endpoints, live flow sources and the four dashboard tasks (`dash-board-data` → `dash-board-shell` → `dash-agent-panes` → `dash-flow-prompt` → `dash-live-agents`), 12 in total, in the right order. The last `update_tasks` ran at 178.9k, about 1k short of compaction.
- **Compaction right after the plan, then re-exploration.** Compaction took the prompt from 179k to 8.3k (turn 58). The digest carries the task titles and write paths, and tells the model that earlier reads are gone. It then spent turns 58–71 re-reading code it had already read before planning (`run.ts` in full, `run-store.ts`, `verification.ts`, the orchestrator route, dashboard files), back up to 70k, before its first dispatch. Rule 3 asks each dispatch instruction to carry "the files and lines you found", and those findings were lost in the compaction.

### 4. Keep the planning findings across compaction (harness)

**Fix.** Let each plan task carry the notes a dispatch needs (files, line anchors, pitfalls), written at `save_plan` time and stored in `plan.md`. The digest then points at them, and a dispatch after compaction needs no second exploration. Fixes 1 and 2 also leave more room before compaction, so it would usually land later, after some dispatches.
- **No dispatch in 55 turns after compaction.** From turn 58 to 111 it re-explored (reads, greps, `npm run typecheck`, the dashboard tests, the linter config, the spec's mockup file) without reading `plan.md` once, taking the prompt from 8k back to 138k. At turn 112 it called `save_plan` with a fresh plan (105 s of generation), which was refused ("A plan is already saved; change it with update_tasks"). Only then did it read `plan.md` (turns 113–114), at 149k. It acted as if the plan had to be rebuilt: the digest lists the task titles and write paths but not where the instructions and acceptance criteria are, and nothing pushed it to dispatch.

### 5. After compaction, read the plan and dispatch (prompt and harness)

**Fix.** The digest should say that `plan.md` holds each task's steps, reads, and acceptance criteria, and that the next step is to read it and dispatch the next ready task, naming that task. A harness guard like the plan deadline could also refuse more exploration once a plan exists, no task has been dispatched, and the context passes a share of the budget, accepting only `dispatch`, `update_tasks`, and reads of `plan.md`.

## First dispatch (contracts-phase-runs, attempt 1)

- **Dispatched at turn 116** (157.7k tokens, 36 min into the run), right after reading `plan.md`.
- **Swap to the 27B was clean.** Free RAM went from 15.9 GiB to 75.5 GiB as the Flash model unloaded. The 27B loaded in about 14 s; with it loaded, VRAM is 23.0/24 GiB and free RAM 71.1 GiB.
- **Worker start.** It read the contract, the phase runner, `run.ts`, and the tests (turns 1–12), then wrote a failing test first (turn 13), watched it fail (turn 14), and edited the contract and phase runner. That is TDD as asked, at 2–9 s per turn.
- **An "unsure" safety verdict forced a swap back to the orchestrator.** At turn 19 the reviewer (running on the 27B) called an 8-edit change to `run.ts` "complete and benign in content" but answered `unsure` because it renames `phaseRunIds` to `phaseRuns`. That is the task's intended change, not a safety question. In `auto` approval an `unsure` goes to the orchestrator's `decide`, so the engine swapped 27B → Flash (16:38:59Z) for one approval and will swap back.
- **Harness noise.** Every approval verdict logs two `throughput_unverifiable` lines (`stage=approval_verdict`, `reason=both_unavailable`), for prefill and decode.

### 6. Keep the safety reviewer on safety (prompt)

**Fix.** The approval reviewer should judge only whether an action is safe (destructive, secret-leaking, outside the repository). It should not judge whether the change is right for the task, which the orchestrator's review covers. A benign edit should be `approve`, never `unsure`. Each needless `unsure` costs two model swaps plus an orchestrator turn at its full context.
- **Round trip for the one approval: 57 s.** That is 38.8 s waiting for the Flash model to load and 17.9 s for the orchestrator's decision. Its 164k prompt was 98% cached: 161,280 tokens restored from the RAM disk tier, then the decision decoded at 58 tok/s.

### 7. The RAM disk wipes a full cache at every swap (harness bug)

**Seen.** The Flash engine logged `Disk cache full (14.9 of 15.0 GB)` and ended at "15.0 of 15.0 GB". At the swap back to the 27B (11:40:06 local), SiftKit logged `ram_disk_folder_wiped: RAM disk cache of preset 'exl3-3-8-next-4-18bpw-f16' exceeded its lowered budget; wiped it.` The budget was never lowered: it is 15 GiB, as it was all run. `tidyFolders` in `src/status-server/ram-disk-cache.ts` wipes any folder whose file bytes exceed `RamDiskCacheGiB`. A cache exllamav3 has filled to its own budget can sit just over that, from files exllamav3 does not count or from rounding, so a full cache is wiped at the next swap. Only the 27B folder (4.4 GB) is left on `S:`.

**Cost.** The next orchestrator turn is cold: about 164k tokens at about 950 tok/s, roughly 3 min, instead of 18 s. That repeats every time the cache fills, which defeats the RAM disk's purpose of keeping prompt caches across swaps.

**Fix.** Wipe only when the budget actually went down: compare against the budget the folder was written under (for example the `budget.json` exllamav3 leaves, read before it is cleared, or a SiftKit marker), not against the folder's size. Needs a failing regression test: a folder filled to its unchanged budget plus overhead survives `prepare`.
- **Confirmed.** After the worker passed (16:44:10Z), the orchestrator's first turn re-prefilled 165,040 tokens where the prompt grew 1,003 ("Prompt cache broke on turn 118"), about 3.5 min from the swap (16:44:12Z) to the warning (16:47:38Z).

## contracts-phase-runs result

- Attempt 1 passed its checks in about 8.5 min on the 27B (16:35:44Z to 16:44:10Z), with one escalated approval.
- **Review passed in 9 turns** (117–125): it approved the escalated edit, read the changed contract and phase runner, ran the contract and run-store tests (29 pass), and recorded a pass. The worker reported one deviation: `tests/contracts-orchestrator.test.ts:141` still names `phaseRunIds`.
- **A pass with findings was refused** (turn 124: "A pass cannot carry findings"). The resend worked. Another round trip the prompt already warns about ("A pass carries no findings").
- **Context.** The orchestrator is at 174k after the first task, so the second compaction comes right away. The cost of fix 4 and fix 5 now repeats per compaction.
- **Speeds for the first task.**
  - 27B worker: decode median 142.8 tok/s (p10 92, p90 177), against 101–112 in the baseline, with 99% of prompts cached.
  - Flash model reload: about 36 s each time.
  - Cold orchestrator turn: 171 s for 165k tokens, at about 800–960 tok/s, so no VRAM spill.
  - After the wipe, the Flash cache is back to 5.8 of 15 GB, and the 27B's is at 6.9 of 10 GB, so the 27B's will fill and hit the same wipe later.
- **Evidence for fix 7.** exllamav3 fills a cache right up to its budget and counts in GiB. At 16:56Z the 27B folder held 10,736,273,654 bytes against a 10 GiB budget of 10,737,418,240 bytes: 1.1 MB of headroom. That was 7.16 GB of pages, 3.58 GB of recurrent states, `index.sqlite`, and `manifest.json`. Any write to the index, or files exllamav3 does not count, puts it over, and the next swap wipes it.

## review-criteria-results (attempt 1)

- Dispatched at turn 129 (178k) right after an `update_tasks`, with no re-exploration, because compaction had not happened yet.
- **A second needless `unsure`** (worker turn 28): "the third edit's oldText lies entirely inside the second edit's oldText region, so the edits overlap and the payload's applicability/outcome cannot be determined". Overlapping edits are a correctness problem the edit tool reports itself, not a safety one; this escalation swapped the engine to the Flash model again (16:56:04Z). It is the same pattern as fix 6.
- **A third `unsure`** (worker turn 39, 17:00:39Z): "the edits reference an import and API (formatAttemptFailure, evaluateAttempt returning problems) whose current state in verification.ts and other consumers … cannot be determined". That is three escalations in about 25 min of worker time, all on correctness, none on safety.

### Root cause of fix 6

`src/repo-search/approval-review-policy.ts` tells the reviewer to return `unsure` when an edit "cannot be fully understood" (line 29) and for "effects that cannot be independently determined" (line 49). The 27B reads both as "I cannot tell whether this code is correct": whether a renamed field is updated everywhere, how overlapping edits apply, whether an imported API exists. Reword both lines to safety. "Understood" means the payload is complete and readable. "Effects" means effects on files, processes, the network, or secrets. Then say outright that compile errors, overlapping edits, task correctness, and code the reviewer cannot see are not reasons for `unsure`; the edit tool, the checks, and the orchestrator's review handle them.
- **Worker passed** in 16 min (16:49:53Z to 17:05:51Z), including three escalations worth about 3.5 min.
- **Review: fail, then pass.** From its compacted context (14k), the orchestrator read the verification code, the prompts, the contract, and the e2e test (turns 132–145). It then tried `record_review` with `fail` (turn 146), which was refused for "missing index 4" (it judged only four of the five criteria). It re-read the plan and spec §1.3, checked `run.ts`, and recorded `pass` (turn 151). It ran no check in this review; it relied on the gate's passing checks. Whether the flip is right needs a look at the change after the run.
- **No re-exploration problem this time.** After the review it went straight on to the next task's files (schema version, `orchestrator_attempts`), at 54k. Cache hits were near total (prompt-eval 0.3–3k per turn).

## schema-upgrade-84 (attempt 1)

- Dispatched at 17:10:45Z, about 1.5 min after the previous review.
- **A fourth escalation, this one defensible.** At worker turns 27–28 the worker wrote a small zod probe into the run's scratch directory (approved), then ran it with `node` (turn 29). The reviewer cannot see the script's contents from a `run` call, so `unsure` follows its rules. A cheaper path is to show the reviewer the content of a script file under the run's scratch directory when a `run` command executes one. That turns a blind call into a reviewable one, with no swap.
- **The same command escalated again 46 s later.** The approved probe run failed on an import path. The worker fixed the path (turn 30, approved) and ran the identical command (turn 31): `unsure` again, another two swaps. Each probe iteration costs about 70 s. Besides showing the script's contents, an orchestrator approval of a `run` command could cover the same command for the rest of the attempt when only the files the worker owns in the scratch directory have changed.
- **A third escalation for the probe: deleting it** (worker turn 58). `Remove-Item` of its own probe file in the run's scratch directory is "non-recursive deletion", which the policy always sends to `unsure`. SiftKit already removes the run's scratch files itself (`cleanupRunScratch` in `run.ts`). Deleting a file inside the run's own scratch directory could be approved by policy, or the worker prompt could say that scratch is cleaned up for it. The probe cost three escalations, about 3.5 min of swaps in all.
- **Passed** in 19 min (17:10:45Z to 17:29:39Z), about 5 min of it in four escalations.
- **Review passed in 8 turns** (162–169): it read the new upgrade and its test, ran the chat-sessions process test (7 pass), checked the `runtime-db.ts` diff (`CURRENT_SCHEMA_VERSION = 84`, upgrade from 83 registered), and recorded a pass with no refusal. A tight, evidence-based review.

## Progress at 86 min

- 3 of 12 tasks done, all on attempt 1, all review passes, 18 engine sessions (model loads).
- Per task: about 8.5, 16, and 19 min of worker time, plus 2–4 min of review. At this pace the remaining 9 tasks take about 3 h, so the run should land near 4.5–5 h, against 456 min for the baseline.

## flow-contracts-live-flows (attempt 1)

- Passed in 9 min (17:35:30Z to 17:44:46Z) with no escalations.
- **A minor cache-break warning** at orchestrator turn 189: 7,281 tokens re-prefilled where the prompt grew 5,354, so about 1.9k tokens re-done (a few seconds). The warning is right but this size is noise; a threshold relative to the prompt (or an absolute floor around 4–8k) would keep warnings for the real breaks, like the 165k one.
- **Review failed, with two real defects** in `src/orchestrator/live-flows.ts`:
  - **Line 35.** A running tool's `durationMs` and a running turn's `elapsedMs` temporarily hold the absolute start stamp, so a live pane would show the run's elapsed time as a duration. The stamps belong in the holder's per-agent state.
  - **Line 39.** `tool_result` finds its tool by matching `command`, so two identical commands in one turn complete the wrong entry. It should match by `toolCallId`, which both events carry and §2.2 uses.
  
  Both are what a careful human reviewer would catch: they read the code against the spec, not just the passing tests. One `record_review` was refused because a snippet was cited at line 262 instead of 366, from memory; it re-read the file and resent. The evidence check works.
- **Rough edge.** Criterion 0 is `met: false` with only a passing test command as evidence. The prompt asks for evidence of what was judged; for an unmet criterion, the evidence should point at the defect (the findings do).
- **The fix passed** in 5 min (17:48:01Z to 17:53:05Z), and the re-review passed in 8 turns (195–202). It re-read `live-flows.ts` and saw the start stamps moved into holder state (`stamps.endTurn(event.turn)`), checked the new tests, and ran the live-activity, run-store, and orchestrator suites (31 pass). One `read` was refused for an unknown `context` key, which belongs to `grep`; it resent without it.
- **Task 4 done at 17:54:43Z**: 4 of 12, the first to go through review fail and fix. 19.5 min in all.

## agent-flow-parse (attempt 1)

- Dispatched at 17:57:00Z. **Watch item at 9 min:** 31 worker turns and 112k of its 170k context with no edit yet. It is reading lint config, `package.json` scripts, `tsconfig.test.json`, and unrelated tests. Thinking comes in spikes: turns 24, 27, and 29 each spent 5.5–8.4k thinking tokens (60–100 s) to pick a single read. The earlier workers were editing by turn 13–15.
- **It recovered.** Turn 31 wrote the whole test file (24 KB) after 14.6k thinking tokens (172 s), then the implementation (turn 33). Its tests, typecheck, and lint all passed by turn 40, at 143k context.
- **An inconsistent verdict.** At turn 42 the reviewer approved `node .\src\test-runner\run-tests.ts …` as "the repository's own test runner". At turn 43 it answered `unsure` for the same runner with other suite names: "runs a TypeScript file directly via node … not a standard test-runner invocation". The policy names that runner explicitly as approve. A deterministic pre-check in code (the repository's own test runner, `npm run <script>`, `npx tsc`, `vitest`, `eslint` inside the repository root) would approve these without asking the model, and so without the risk of a swap.
- **Passed** in 16 min (17:57:00Z to 18:13:08Z). The review passed in 7 turns (211–217): it read the whole of `agent-flow.ts` and the newest tests, ran 83 tests (all pass), and checked the plan's task section.

## Progress at 130 min

- 5 of 12 done, 6 attempts (one fix), 5 review passes and 1 justified fail, 26 engine sessions.
- The orchestrator is at 154k, so the next compaction is close (about 180k).
- **Two plan updates before the next task** (turns 230 and 232). After reading the orchestrator runs registry, the worker launcher, the preset system context, and `run.ts`, it revised `live-flow-sources`, whose write paths went from 7 to 13. Real files the spec needs; the plan adapts to what it learns. But `live-flow-sources` is now the largest task in the plan, double the "at most about 6" rule, which nothing enforces (see Plan quality). It was at 177.6k when it finished, so compaction comes before this dispatch.

## live-flow-sources (attempt 1, 13 write paths)

- Dispatched at 18:19:19Z, before the orchestrator's compaction, so no re-exploration on that side.
- **The worker compacted mid-task.** By turn 64 it was at 152k of its 170k context, with tests written and edits under way in `child-activity.ts`, `live-activity.ts`, and `phase-runner.ts`. At turn 65 it dropped to 12k and spent turns 65–76 re-reading the files it had just edited (`phase-runner.ts`, `workers.ts`, `run.ts`, `orchestrator-runs.ts`, `live-flows.ts`, and four test files) before its next edit at turn 77. It is the orchestrator's compaction problem again, in a worker. Here it is mostly unavoidable: edits do change the files.
- **This is what a 13-path task costs.** The earlier 4–9-path tasks finished inside one context. Enforcing the write-path limit in `validateOrchestratorPlan` (Plan quality) would have split this task before dispatch.
- **Passed** in 19 min (18:19:19Z to 18:38:38Z) despite the compaction. The orchestrator compacted at the first review turn (177.6k down to 9.4k, turn 234), so the review starts from the digest. Both RAM disk caches survived the swap.
- **The review uses diffs: good method, but it fumbles for a base.**
  - Turn 237: `git show 051985a`, a commit that does not exist ("unknown revision"). The hash is invented.
  - Turn 239: `git diff HEAD~2 --stat`, which compares against two commits back and mixes in older, unrelated changes.
  - Turns 240–241: `git diff HEAD -- <files>`, which is right, since the workers' changes are uncommitted in the working tree.
  - Turn 236: a `read` at offset 1095 of the 854-line `run.ts` (a line remembered from before compaction); the harness answered with the file's last lines.
  - It uses `run_check` with PowerShell `Select-Object` for git, although a `git` tool with `operation="diff"` exists and it used that tool earlier (turn 166).

### 8. Say where a task's changes are (prompt, harness)

**Fix.** Rule 4 (review) should say that the run's changes are uncommitted in the working tree, so `git diff HEAD -- <path>` (or the `git` tool's diff) shows a task's change, and that a run makes no commits. The report could also carry the changed paths with `git diff HEAD` line counts. It already gives line counts; adding the exact diff command would stop the search for a base.
- **`save_plan` after compaction, again** (turn 246). Mid-review, it reread the spec from the digest and tried to save a fresh plan: "A plan is already saved; change it with update_tasks". That is two of the three compactions so far. The digest names the plan path, but not that the plan is saved and is changed only with `update_tasks`. This strengthens fix 5.
- **It found a spec gap and added a task.** After rereading the spec (§3.3) and the plan, it added `dash-prompt-parts` ("§3.3 Prompt part constants in prompts.ts + server-tested splitters", 4 write paths, after `dash-board-data`), so the plan now has 13 tasks. The first plan had missed that requirement; catching it is a real gain from rereading the spec. But it did this in the middle of the `live-flow-sources` review, which is still open, and it used `git diff HEAD~1` as a base again.
- **Review passed, but slowly: 38 turns and 21.5 min** (18:38:38Z to 19:00:13Z), against 7–9 turns for earlier reviews.
  - **Re-checking finished tasks.** It used `git show HEAD:` and `git grep` to check `CURRENT_SCHEMA_VERSION` and `run-store.ts`, which belong to `schema-upgrade-84` and `review-criteria-results`, both already reviewed and completed. It also ran `Test-Path` on unrelated schema-upgrade files.
  - **The invented commit again** (turn 264, `git show 051985a:…`, "invalid object name"). The hash appears nowhere in the repository, the plan, the spec, or the run's files.
  - **Remembered line numbers after compaction.** It read at offset 100 of the 44-line `child-activity.ts` and offset 300 of the 141-line `verification.ts`.
  - **About 15 of its 38 calls went through `run_check`** with PowerShell `Select-String`, `Out-String`, or `git` piping. Prompt rule 4 says to read code with the read tools, not `run_check`, and it has `grep` and `git` tools.
  - **Thinking spikes:** 3–5k thinking tokens (55–80 s) on seven of the turns, to pick a single search.
  - **The useful part:** `git diff HEAD` of the task's files (turns 277–279, 286) and 35 passing tests (turn 270).

### 9. Scope the review to the task (prompt)

**Fix.** Rule 4 should say that completed tasks are already reviewed: review only the reported task's changed paths, starting from `git diff HEAD -- <changed paths>`. It should also say that `run_check` is for tests and commands, not for reading or searching (its current wording, "Read and search code with your read tools", was not followed). As a harness backstop, `run_check` could refuse commands that are only `Select-String`, `Get-Content`, or `git show` / `git grep`, pointing at the `grep`, `read`, and `git` tools, as the safety reject did for `Select-Object` at the start of the run.

## agent-endpoints (attempt 1)

- Dispatched at 19:01:38Z with a 6.3k-token instruction. **It used 115k of 170k context in 35 turns, about 4 min, before any edit.** It read whole files from line 1 (`routes/orchestrator.ts`, `agent-flow.ts`, `live-flows.ts`, a 253-line range of the contracts, `orchestrator-runs.ts`, test helpers, error helpers), at 2–5k tokens a read. Like `live-flow-sources`, it is likely to compact mid-task.
- **The worker's history keeps its thinking.** Turn 28's 4,515 thinking tokens added about 4.6k to the next prompt, against a 387-token tool result. Other turns show the same match. That is the model's chat template keeping reasoning within a tool loop. It is by design, but it costs context on long tasks.

### 10. Targeted reads for workers (prompt)

**Fix.** Worker guidance could say: `grep` for the symbol first, then `read` the range around it, and read a whole file only when the whole file changes. The orchestrator could also put the line anchors it already found into the instruction (rule 3 asks for "the files and lines you found"), so the worker does not have to re-find them.
- **The attempt failed with nothing submitted after 23 min** (19:24:43Z). The worker error was `planner_compaction_failed attempts=2 turn=93 … Provider rejected the prompt as too long: Job requires 666 pages (only 665 available) … 665 * 256 = 170240 tokens`.
  - **No edits at all.** In 93 turns it made 70 reads, 46 greps, 3 finds, and 2 runs, and wrote nothing. It had compacted once already (turn 52, 152.6k down to 12.0k).
  - **One turn broke the budget.** At turn 92 (143.7k, under the 152.5k compaction budget, `maxOutputTokens` 26,304) it thought for 20,464 tokens, about 4 min, to issue a single grep. Thinking stays in the history, so turn 93's prompt was 165.9k: 13.4k over the budget and 4.4k short of the engine's 170,240-token cache.
  - **Compaction could not fit.** The compaction request sends that whole history to the summarizer. `resolveSummaryGenerationTokens` in `transcript-compactor.ts` fits the summary's `max_tokens` to exactly `totalContextTokens - prompt`. The engine still needed one more 256-token page than it has. That is probably the MTP draft lookahead, or page rounding beyond `prompt + max_tokens`; not verified. The retry sent the identical request and failed the same way, so the attempt died.

### 11. Compaction must always fit (harness bug)

**Fix.**
- When fitting the summary's generation budget to the remaining context, leave a margin: at least one cache page plus the draft length.
- When the history to summarize leaves less than a useful summary budget, shrink what is sent (drop the newest turn's reasoning, or trim the oldest tool results) rather than sending it all.
- Never retry an identical request after a context-size rejection.
- Regression test: a history that ends one oversized turn past the budget still compacts.

### 12. A worker that only reads (prompt or harness)

**Seen.** 93 turns and two context windows of reading with no edit. The earlier workers wrote their first test within 13–33 turns. **Fix.** Worker guidance could require the first failing test as soon as the target is clear. A harness guard, like the plan deadline, could also refuse more reads once a worker has used a set share of its context across compactions with no edit or write, accepting only `edit`, `write`, and `run`.
- **The orchestrator's recovery was right.** Rather than retry the same 7-path task, it retired `agent-endpoints` ("exhausted its context reading large files without producing changes; split into … with narrow, pre-anchored instructions") and replaced it with two 4-path tasks: `agent-meta-flow-endpoints` (§2.1/§2.2) and `agent-live-stream-endpoint` (§2.3 SSE plus the e2e rail invariant). It rewired `dash-board-data` to depend on both. Nothing in the spec was lost, and the plan now has 14 tasks. Retiring tasks is one of the features added since the baseline, and this is it working as meant.

## agent-meta-flow-endpoints (attempt 1)

- **Narrower instructions helped.** From turn 1 it used `grep` and range reads (for example, contracts at offset 360, limit 80). Its first write came at turn 26 and 80.7k, against none in 93 turns for the retired task.
- **But it left its write paths at once.** Turn 26 wrote a new `tests/helpers/orchestrator-process-harness.ts`, and turn 27 edited `tests/process/orchestrator-run.e2e.test.ts`. Neither is in this task's write paths, and the e2e test belongs to `agent-live-stream-endpoint`. It looks like it is extracting a shared process harness from the e2e test for its new `orchestrator-agents` test. That is a reasonable design, but it touches the next task's file. The gate reports "changed files outside this task's writePaths", and the review should judge it.
- **Shell reads through `run`** (turns 23–25: `Get-Content`, `Select-String`) while `read` and `grep` exist, with 3–5.5k thinking on two of them. This is the worker version of fix 9.
- **Passed its checks** in 17.5 min (19:28:34Z to 19:45:59Z), with one more needless `unsure` ("legitimate, narrowly scoped, non-destructive … but I should…").
- **Review failed for a real gap.** `tests/process/orchestrator-agents.test.ts` never exercises the 409 (`{error:'flow not recorded'}`) branch, which §5 asks for, or the `{flow, live:true}` fallback for a running agent, which §2.2 asks for. The gap is real: the spec lists both, and the worker's tests passed without them.
- **Out-of-scope changes passed silently.** The gate flagged three test files outside the write paths: the new shared harness, `orchestrator-run-store.test.ts`, and the e2e test that belongs to `agent-live-stream-endpoint`. The review raised no finding and said nothing about them. A harness extraction is not an allowlist, skip, or loosened assertion, the examples rule 4 names, so passing it may be right. But rule 4 says to "judge every deviation and host finding", and this judgement left no record. The next task's worker will find its e2e file already changed, and its instruction does not mention that.
- **The fix passed** in 6.5 min (19:48:43Z to 19:55:18Z), and the re-review passed in about 1.3 min (19:56:37Z).

## agent-live-stream-endpoint (attempt 1)

- **The instruction carries the previous task's change.** The 8.8k-character instruction tells the worker that its test file "imports the shared boot from `tests/helpers/orchestrator-process-harness.ts` (startHarness/startRun/followRun/readRun)". So the out-of-scope extraction was passed on, and the earlier worry does not apply.
- **A draft-like instruction.** It contains a self-correction: "choose the plan-preparation phase so you can attach while it runs — actually attach to the CHILD while it works". The worker gets both options. Instruction text is model output with no edit pass; a prompt line such as "state each step once, as the final decision" would keep thinking out of instructions.
- **Passed** in 17 min (19:57:17Z to 20:14:18Z) with no escalations and no compaction. The first edit came at turn 40 (96k). The review passed at 20:17:51Z.
- **Server side done at 4 h 13 min:** 8 of 14 active tasks. The six dashboard tasks remain.
- **Two review citations refused** for wrong lines (turns 318 and 320, snippets cited at `orchestrator.ts:289` and `orchestrator-agents.test.ts:224`). It passed on the third try (turn 332). The evidence check keeps working, but each refusal is a round trip.

## Restructuring the dashboard tasks (turns 333–362)

- **Exploration.** Before the first dashboard dispatch it read the dashboard code (18 reads, 12 greps, 3 `ls`), then set out to restructure §3. The plan is to retire `dash-board-data` and `dash-prompt-parts` and replace them with `dash-api-hook` (data layer), `prompt-parts` (a pure module shared by server and dashboard), and `dash-view-model`, then rewire the four tasks after them.
- **Six `update_tasks` calls to get there, five refused:**
  - two for argument shape (turn 354: `update.0.set` missing; turn 355: `update.0.taskId` missing);
  - three from the dependency check (turn 356: retiring `dash-board-data` orphans `dash-board-shell` and `dash-prompt-parts`; turn 359: retiring `dash-prompt-parts` orphans `dash-flow-prompt`; turn 361: `dash-board-shell` names `dash-api-hook` before it exists).
- **Half done at turn 362.** The call that succeeded only added the three new tasks. The plan now has 17 tasks, and the old `dash-board-data` and `dash-prompt-parts` are still active beside their replacements: two pairs of tasks for the same spec sections. If the retire and rewire do not follow, the same work would be dispatched twice.

### 13. Make plan restructures one operation (harness)

**Seen.** Retire 2, add 3, and rewire 4 is 9 task changes, more than one call allows ("at most 4 tasks per call"). The dependency check already accepts a retirement whose dependents are repointed in the same call ("retire it too, or set its dependsOn"), so the cap is what forces several calls. Each smaller call must leave a valid plan, and the model found the one legal order by trial: five refusals here. **Fix.**
- Exempt retirements and dependency-only changes from the 4-task cap, so one restructure is one call.
- Or have the refusal give the order that works: add the replacements first, then repoint and retire.
- **Finished at 20:28:17Z.** The next call removed `dash-board-data` and `dash-prompt-parts`; both were never attempted, so they were dropped rather than listed as retired. It also repointed the dependents. There are no duplicates now: 15 tasks, 7 of them left (`dash-api-hook` and `prompt-parts` ready, then `dash-view-model` → `dash-board-shell` → `dash-agent-panes` → `dash-flow-prompt` → `dash-live-agents`). The new split is good: a pure shared `prompt-parts` module, and a 2-path view model separate from the components. But it cost about 10 min and 30 turns between the last review and the next dispatch.
- **More plan churn** (turns 363–367): three more successful `update_tasks` calls retuned dependencies and write paths (`dash-live-agents` 6 → 8 paths, `dash-agent-panes` 5 → 4). One refused call tried to add a task named `unused-placeholder-noop` with no write paths ("lists no writePaths"). The schema needs no filler: `update`, `add`, and `retire` all default to empty lists (`OrchestratorUpdateTasksArgsSchema`). So this is model noise, caught by the write-path check, not a call-format problem.

## dash-api-hook (attempt 1)

- Passed its checks in 16 min (20:30:53Z to 20:46:54Z): first edit at turn 16 (67k), tests first, no escalations.
- **Review failed with two findings, all five criteria met:**
  - **A real UI bug.** `useOrchestratorRun.ts:124` clears the agent list before each refetch, so the board's agent count and token totals blank on every committed event: a flicker on a live board. Keep the previous value until the new read answers. Good product judgement; no criterion asked for it.
  - **A duplicate test file, and the plan caused it.** The worker created `dashboard/tests/hooks/use-orchestrator-run.test.tsx` beside the existing `dashboard/tests/use-orchestrator-run.test.tsx`. That new path is in the task's own write paths, written by the orchestrator during the restructure. The worker followed the plan, and the review now fails it for doing so. The finding is right, but the error was the orchestrator's.

### 14. Check new plan paths against existing files (prompt or harness)

**Fix.** Rule 2 could say: name an existing test file for a module, and a new path only after `find` shows none exists. A cheap harness check in `validateOrchestratorPlan` would warn when a planned write path does not exist and a file with the same name exists elsewhere in the repository.
- **The fix's first step escalated.** Deleting the duplicate test file, as the review asked, is `Remove-Item` of one file, which the policy always sends to `unsure` (worker turn 6, swap at 20:54:43Z). The file is untracked, created by this run, inside the task's write paths, and named for deletion in the review the fix carries. The harness knows all of that. A deletion matching it (a file the run created, in the task's write paths) could be approved without the model, as with the scratch-file deletion earlier. A `delete` tool scoped to write paths would make it explicit.
- **The fix passed** in 9 min (20:49:42Z to 20:58:27Z), and the re-review passed at 20:59:53Z.

## prompt-parts (attempt 1)

- Fastest task so far: 11 min (21:00:28Z to 21:11:38Z), first edit at turn 10 (57k). Turns 8–10 spent 4–7.6k thinking tokens each.
- **Review failed for a real parsing bug.** In `src/orchestrator/prompt-parts.ts:96`, a block heading takes every line until the next heading. So the instruction's "Acceptance:" block swallows the preserve-changes line, the retry block, and the closing sentences, and the drift prompt's verify heading does the same. §3.3 says unmatched text stays separate. The worker's own test asserted the wrong behaviour (`tests/orchestrator-prompt-parts.test.ts:143`), so the checks passed. The orchestrator caught it by reading against the spec and naming the visible symptom ("Use TDD where behavior changes…" shown as an acceptance bullet).
- **The fix passed** in 7 min (21:13:47Z to 21:20:47Z), and the re-review passed at 21:22:07Z. The run is at 10 of 15 done after 5 h 37 min.

## agent-flow-path (added at 21:23:06Z, dispatched 21:25:08Z)

- **It caught its own earlier miss.** Rereading spec §2 against the route table (turns 394–396), it found that the flow endpoint is served without the `/flow` suffix the spec names (`GET /orchestrator/runs/:runId/agents/:agentRunId/flow`). `agent-meta-flow-endpoints` built it that way and passed review twice. It added a 4-path corrective task: move the route to `/flow`, assert that the bare path now 404s ("no parallel path"), and point `readOrchestratorAgentFlow` at the new URL. That is the right shape of fix, a complete replacement, but it is review rework: the two earlier reviews checked the endpoint's behaviour, not its path against the spec.
- **The `Select-String` guard fired correctly** (turn 398). `npm run test:dashboard 2>&1 | Select-String …` was refused ("cuts the output of a test, build, lint, or typecheck command"), and the rerun without the pipe passed: 678 tests.
- **A wrong `cwd`** (turn 399): `npm run test -- --run` with `cwd="dashboard"` fails as a workspace script. The repository's own command, `npm run test:dashboard` from the root, is in the plan's checks.
- **Passed its checks** in 6 min (21:25:08Z to 21:31:01Z). The report notes a deviation: it also changed `tests/orchestrator-agent-f…`.
- **Not reviewed, and the next task dispatched anyway.** The orchestrator ran `git diff` on the changed files (turns 415–416; the diff of the test files came back empty) and `git status`. Then it switched to exploring the contracts for `dash-view-model` and dispatched it at turn 424 (21:34:20Z), with no `record_review` for `agent-flow-path`, which is still `reviewing`. The harness allows this: `dispatchProblem` in `src/orchestrator/scheduler.ts` checks only the requested task's own status, attempts, and dependencies, and no task depends on `agent-flow-path`. The review now waits for a later turn, from a context the next report will have pushed further away. It may only surface at finish or in the digest's "Reports waiting for record_review".

### 15. Review before the next dispatch (harness)

**Fix.** Only one child runs at a time, so reviewing first costs nothing. `dispatchProblem` could refuse any dispatch while another task is `reviewing` with a report not yet recorded, unless the dispatch is that task's own fix ("record_review for agent-flow-path first"). Rule 4 already says to review every reported task; the harness would make the order binding.

## dash-view-model (attempt 1, 2 write paths)

- **Passed its checks, but took 28 min** (21:34:20Z to 22:02:13Z) for the smallest task in the plan. Its transcript shows 84 tool calls (35 reads, 14 greps, 23 runs, 8 edits) and one compaction (153 s). Model time was 1,297 s planning plus 101 s of approval verdicts.
- **Thinking was the cost.** 112,067 thinking tokens across the attempt, 21,070 of them in one turn: about 18 of its 28 min at about 100 tok/s. Thinking stays in the history, so it also drove the compaction.
- **Shell habits.** 23 `run` calls, many of them reads: `Get-Content` of tsconfig, `package.json`, and the eslint config; `Select-String`; `git status --porcelain; git stash list` three times, checking the tree's state. Fixes 9 and 10 cover these.

### 16. Cap worker thinking per turn (harness)

**Seen.** Single worker turns of 8–21k thinking tokens recur (`agent-flow-parse` 14.6k, `agent-endpoints` 20.5k, here 21k), usually to choose one read or grep. **Fix.** A per-turn reasoning budget for workers, for example 4–8k, bounds both time and context growth. The compaction failure in `agent-endpoints` started with one such turn.
- **It changed the next task's files.** With 2 write paths, the worker also changed `OrchestratorRunPanel.tsx`, `ChatTab.tsx`, and `orchestrator-run-panel.test.tsx`, all in `dash-board-shell`'s write paths. These are probably the callers of view-model exports it changed, needed for typecheck. The gate flagged only the test file, because it checks test files outside the write paths, not source files.
- **Two reviews open at once.** At 22:04Z both `dash-view-model` and `agent-flow-path` are `reviewing`. The orchestrator ran the dashboard suite (698 pass), read the view model, then updated the plan (turn 432). `dash-board-shell` now has 11 write paths, the largest pending task. That is the size at which `live-flow-sources` compacted mid-task and `agent-endpoints` failed.
- **`agent-flow-path` was reviewed after all**: a pass at 22:05:34Z, 34 min after it reported, after the orchestrator reread its plan section (turn 433). It was not forgotten this time, but the review came from a context a whole other task had passed through. That is the case fix 15 would prevent.
- **`dash-view-model` passed review** at 22:06:29Z, after one refusal. The `npm run test:dashboard` evidence "has not passed since this attempt was reported", although the orchestrator had run it at turn 425, right after the report (turn 424). The `agent-flow-path` review recorded in between probably reset what counts as fresh, though that is not verified. The rerun passed (698 tests) and the pass was recorded. The freshness rule is sound; its wording could say which run it is comparing against.
- **12 of 16 done at 6 h 22 min.** `dash-board-shell` (11 paths), `dash-agent-panes`, `dash-flow-prompt`, and `dash-live-agents` remain, then final verification.

## dash-board-shell (attempt 1, 11 write paths)

- **Dispatched unsplit** at 22:08:05Z. **At 10 min:** 35 turns, 121.6k of 170k context, 33k thinking tokens, and no edit yet. It is running baseline tests and listing test folders. This is the `agent-endpoints` pattern: compaction is due at about 152k, and a compaction after only reading loses everything it read. Fix 12 (an edit deadline) and the write-path limit would both apply.
- **It got through.** First edit at turn 38 (149.8k, just under compaction). It then wrote `OrchestratorPane.tsx` (12.6k thinking for that one write) and edited the task row, run panel, and CSS. It passed its checks in 32 min (22:08:05Z to 22:40:15Z) with about 118k thinking tokens and no escalations.

## Why a fix takes 5–8 min

| Fix | Wall | Model | Turns | First prompt | Thinking | `run` calls |
|---|---|---|---|---|---|---|
| flow-contracts-live-flows | 4.6 min | 243 s | 17 | 5.8k | 17.6k | 9 |
| agent-meta-flow-endpoints | 6.2 min | 325 s | 47 | 5.2k | 15.2k | 14 |
| dash-api-hook | 8.3 min | 333 s | 15 | 5.6k | 25.2k | 11 |
| prompt-parts | 6.6 min | 272 s | 19 | 5.5k | 20.1k | 9 |

- **A fix is a fresh worker.** It starts from about 5.5k tokens: the findings plus the previous attempt's changed paths and diff. It re-reads 6–18 files.
- **Thinking is about half the time:** 15–25k tokens, 2.5–4 min of the 4–5.5 min of model time. Fix 16 is the main lever.
- **Checks run twice.** Each fix ran 9–14 `run` calls: targeted tests, then the full dashboard suite, typecheck, and lint, sometimes repeatedly. The gate then runs the task's checks again when the worker finishes.
- **A failed review costs about 8–12 min in all:** the review (2–3 min), a swap each way (about 15 s and 36 s), the fix (5–8 min), and the re-review (1–1.5 min).

### 17. Let the gate own the full checks (prompt)

**Fix.** The worker instruction should say that the host runs the task's checks (the full suite, typecheck, lint) when the worker finishes, and that the worker should run only the tests for what it changed. Its fix loop already gets the gate's results ("fixes its own failures up to N times").

## dash-agent-panes (attempt 1, 4 write paths)

- **Slow despite its size.** At 21 min: 43 turns and 90.5k thinking tokens. The first edit came at turn 24 at 136k, then a compaction (26k by turn 39), and now it is re-reading after it. Turn 42 spent 15,034 thinking tokens on one grep for `orch-verdict`. At 8.5 min it had already used 97k context and 45.5k thinking. A 4-path task is being driven past compaction by thinking alone. This is the clearest case for fix 16.

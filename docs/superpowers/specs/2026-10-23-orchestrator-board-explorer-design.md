# Orchestrator board explorer: design

**Status:** approved 2026-10-23. **Mockup:** option B in `C:\tmp\siftkit-board-mockups\b-split-explorer.html`, drawn from the stored data of the 4 orchestrator runs.

## Problem

The Chat tab's orchestrator board shows a run while it is live, but a finished run says almost nothing. A completed task shows no result. A failed run prints its whole failure message twice, about 1,700 characters each time. Only the last attempt's checks are visible. Once an agent finishes, its card disappears, and nothing it did can be opened from the board. The planner and the reviewers are not shown at all.

## Goals

1. Every agent in a run can be opened inside the board: each implementation and drift-fix attempt, each task review, each drift review, the planner and the final verifier.
2. Each agent opens verdict-first:
   - what the agent was for;
   - a pass/fail verdict in plain words;
   - findings;
   - "What was checked" (commands, scope, evidence, and each acceptance criterion);
   - files;
   - then a collapsed turn-by-turn flow and its final report.
3. The board stays condensed. The task list on the left never moves. One task's or one agent's detail opens in a pane on the right.
4. Whether each acceptance criterion was met is exact: the reviewer judges every criterion, and the board never infers it.
5. Child runs never become chat sessions. Today this already holds, and a test will now enforce it.

## Non-goals

- Diffs, folding long user prompts, and Logs-tab changes.
- Live streaming of a running agent's flow. A running agent keeps today's live card (recent tools, turn, context), and its full flow is available once its run log is flushed.

## 1. Server data

### 1.1 Phase runs carry their role

`OrchestratorRunState.phaseRunIds: string[]` is replaced by `phaseRuns: OrchestratorPhaseRun[]`:

```ts
OrchestratorPhaseRunSchema = z.object({
  runId: z.string().uuid(),
  label: OrchestratorPhaseLabelSchema,          // 'plan preparation' | 'task review' | 'drift review' | 'final verification' | 'approval decision'
  taskId: z.string().min(1).nullable(),         // the task a task/drift review or approval decision is about
  attempt: OrchestratorAttemptNumberSchema.nullable(), // the implementation/drift-fix attempt a task review judged
}).strict();
```

- `OrchestratorPhaseLabelSchema` moves into the contracts as a zod enum. `src/orchestrator/phase-runner.ts` derives `ORCHESTRATOR_PHASE_ANSWER_NAMES` keys from it.
- `askParent` takes a subject `{ taskId, attempt }` and commits `phaseRuns` with it. Every caller passes its real subject. Plan preparation and final verification pass `{ taskId: null, attempt: null }`.
- `OrchestratorRunStore.readThroughput` reads `phaseRuns.map(r => r.runId)`. Nothing else reads phase run IDs.

### 1.2 Reviews judge every acceptance criterion

- `OrchestratorReviewFindingSchema` gains `criterion: z.number().int().positive().nullable()`. This is the 1-based index into the task's `acceptance` list that the finding breaks. `null` means the finding is not about a listed criterion.
- Both arms of `OrchestratorTaskReviewSchema` gain `criteria: z.array(z.object({ index: z.number().int().positive(), met: z.boolean() }).strict())`.
- The review is checked against the criteria it was given. A problem is fed back to the reviewer, as unusable answers are today:
  - `criteria` covers indices 1..N exactly once each;
  - `pass` has every criterion met;
  - `fail` has at least one finding;
  - every non-null `finding.criterion` is an index marked not met.
- For the final verification, N is 0, so `criteria` must be empty.
- The attempt-review prompt lists the acceptance criteria numbered 1..N. It says to judge each one in `criteria` and to cite the index in `finding.criterion`. The final-verification prompt says to answer `criteria: []`.

### 1.3 Attempt results keep the review typed

`OrchestratorAttemptResultSchema.findings: string[]` is replaced by:

- `review: OrchestratorTaskReviewSchema.nullable()`: the accepted review, or null when the task has no evidence checks.
- `problems: z.array(z.string().trim().min(1))`: everything else that failed the attempt. That is:
  - the worker's end status;
  - command check failures;
  - write-scope violations;
  - "Evidence checks were not reviewed";
  - review citation problems.

`evaluateAttempt` returns `{ passed, problems }`. A failing review's findings make the attempt fail, but they are not copied into `problems`.

One function, `formatAttemptFailure(result)` in `src/orchestrator/verification.ts`, renders problems plus review findings as text. Its output is the only text used in:

- the retry instruction (`retry.failure`);
- the `implementation_failed` message;
- the drift-gate retry evidence;
- `final_verification_failed`.

A review finding is rendered as `path:line issue (criterion N)`, or `path:line issue` when the criterion is null.

### 1.4 Schema upgrade 83 → 84

`src/state/schema-upgrades/orchestrator-phase-runs.ts`, registered as `{ from: 83, apply }`, with `CURRENT_SCHEMA_VERSION = 84`. For each stored run:

- **`phaseRuns`:** rebuilt from `phaseRunIds` plus the run's `orchestrator_events`, in sequence order.
  - The n-th event whose message starts with `Parent phase started: <label>` names the n-th phase run.
  - `taskId` is the task named by the nearest earlier `Task <id>:` event within the same `executing` phase. It is null for plan preparation and final verification.
  - `attempt` is set for task reviews only. It is the `attempt` of that task's latest attempt (from `orchestrator_attempts`) whose `reservedAtUtc` is earlier than the event's `atUtc`.
  - If the counts of started phases and IDs differ, the upgrade throws, naming the run.
- **Each stored attempt result:** `findings` becomes `problems` (the same strings) and `review: null`. Old runs keep their findings as text, without criteria.

The upgrade parses only the fields it reads, as `orchestrator-session-links.ts` does. A test covers the 4 shapes found in real data:

- plan-only;
- task review plus drift review per task;
- two task reviews for one task;
- a count mismatch, which must throw.

## 2. Agent endpoints

### 2.1 `GET /orchestrator/runs/:runId/agents`

This returns `OrchestratorAgentSummary[]` for every agent of the run, in start order: the phase runs and the attempts.

```ts
{ agentRunId, kind: 'phase' | 'attempt', label /* phase label, or 'implementation' | 'drift_fix' */, taskId, attempt,
  model: string | null, startedAtUtc: string | null, finishedAtUtc: string | null,
  throughput: InferenceThroughput | null }   // from run_logs; null fields while the run log is not flushed yet
```

The board uses it for the agent count, tokens in/out in the header (the sum of `pp.tokenCount` and `decode.tokenCount`), and each agent's meta line.

### 2.2 `GET /orchestrator/runs/:runId/agents/:agentRunId/flow`

This returns `OrchestratorAgentFlow`, parsed from that agent's `run_logs.repo_search_transcript_jsonl`:

```ts
{ agentRunId, model, startedAtUtc, finishedAtUtc, throughput,
  turns: [{ turn, progress: string | null, thinking: string, text: string,
            promptTokens: number | null, thinkingTokens: number | null, elapsedMs: number | null,
            tools: [{ toolName, command, exitCode: number | null, rejection: string | null, output: string, durationMs: number | null }],
            approvals: [{ verdict, reason }] }],
  finalOutput: string | null }
```

- **Parsing:** in `src/orchestrator/agent-flow.ts`, using the transcript event schemas already in `src/repo-search/live-snapshot/schemas.ts`. Turn elapsed time is from the preceding `provider_request_start`. Tool duration runs from `turn_command_start` to `turn_command_result`, matched by `toolCallId` and turn. Events the flow does not use are skipped.
- **Errors:**
  - 404 when the run is unknown, or `agentRunId` is neither a phase run nor an attempt of the run;
  - 409 `{ error: 'flow not recorded yet' }` when the run log row or its transcript is missing;
  - a transcript line that fails its schema is a 500 naming the run and line. Corrupt transcripts are not skipped silently.
- **Cost:** tool output is returned whole. The board fetches a flow only when its fold is opened.

## 3. Dashboard: board B

`OrchestratorRunPanel` keeps its approval card, Stop and live behaviour. Its body becomes a two-column split.

### 3.1 Header

- **Title row:** status badge, "N of M tasks complete", and a **Plan** button that opens the planner pane.
- **Meta line:** plan path, approval mode, elapsed time, number of agents, tokens in/out, prefill and decode t/s. Tokens come from §2.1; the rates are the session's existing `sessionThroughput`.
- **Failure:** a one-line headline, which is the failure message up to its first `: `. A **details** fold shows the failing task's last attempt:
  - its scope violations;
  - its problems;
  - its review findings as cards;
  - an **Open attempt N** button that selects that attempt in the pane.

  The raw message appears only when there is no failing attempt.
- **Stepper:** Plan, Validate, Execute, Verify, Clean, each with its duration from the run's events. `useOrchestratorRun` keeps the first and last `atUtc` per phase from the progress frames it already receives. The phase the run failed in is red.

### 3.2 Left list (never scrolls the pane away)

1. Planner row: "planner · N turns · duration", with "plan · N tasks · validated".
2. One row per task: dot, title, `id · preset · impl n/2`, status badge, then a result line:
   - completed: `✓ N checks · F files changed · review pass · no drift` (or `N drift fixes`);
   - failed: `✗ N attempts failed · last rejected by review · K findings`, or `· last wrote outside its scope`;
   - not run after a failure: `not run · <failed task id> failed`;
   - pending while live: today's wait reason.

   Under the row are the agent chips in run order (impl 1, review 1, impl 2, review 2, drift, fix 1…), each with a dot for its verdict. Clicking the row opens the task spec. Clicking a chip opens that agent.
3. Final verifier row: "✓ final verification pass" or "✗ … fail".

The selection defaults to the failing task's last attempt, else the last attempt, else the planner.

### 3.3 Right pane

Every agent pane starts with a one-line purpose, then a verdict banner (PASS/FAIL and one plain sentence). It ends with the agent meta line (from §2.1), a collapsed **Turn-by-turn flow**, and a collapsed **Final report**. The middle depends on the agent:

- **Implementation or drift-fix attempt:**
  - **Findings:** the review's findings as cards, each with a `path:line` chip, a one-sentence issue, a "Suggested fix" box when the issue text contains `Fix:` or `Fix in scope:`, and a "why" fold for the rest.
  - **What was checked:** one row per item:
    - each command check, with its parsed result. Node test totals become "N passed · M failed", typecheck becomes "no type errors", anything else shows `exit N`. The row opens to the full output.
    - scope;
    - each evidence check, judged by the review;
    - each acceptance criterion as met or not met, from `review.criteria`. With no review, the row reads "not reviewed".
  - **Files:** the task's allowed write paths and the changed paths. Each is marked changed, allowed but untouched, or changed but not allowed (red).
- **Task review:** findings as cards, or the cited evidence as a code view grouped by file with line numbers, plus the criteria list.
- **Drift review:** "No drift found", or its findings.
- **Planner:** "Planned N tasks" with the plan goal, a task table (preset, dependencies, writes, checks), its notes, and the constraints in a fold.
- **Task spec:** steps with their expected results, "Checked by", "Done when", and the may-write and reads paths.

The **flow** fold fetches §2.2 when it is opened. It shows the last 8 turns, with a "show N earlier turns" button. Each turn line shows the progress text (or the answer summary), tool counts, context tokens and duration. A turn opens to:

- its thinking, folded;
- each tool call, opening to its output;
- its approvals;
- its answer.

An answer that parses as JSON renders by phase label:

- review or final verification: verdict badge plus finding cards or the evidence view;
- planner: badge, notes and task table;
- drift review: verdict plus findings.

Each has a **raw JSON** fold. Any other answer renders through the existing `MarkdownContent`. A running agent's pane shows the existing live agent card in place of the flow.

## 4. Error handling

- **Agent endpoints:** 404, 409 and 500 as in §2.2. The flow fold shows the 409 as "Flow is recorded when the agent's run log is flushed", and any other error as its message with a retry button.
- **Upgrade:** throws naming the run on any mismatch, before writing any row for that run.
- **Reviewer criteria:** problems re-ask the reviewer through the existing `rejected` loop, and they count toward its existing `PARENT_PHASE_ATTEMPTS` limit.

## 5. Testing

- **Contracts:** the phase-run, review-criteria and attempt-result schemas accept good shapes and reject bad ones (`tests/contracts-*.test.ts`).
- **`verification.ts`:**
  - criteria validation (coverage, duplicates, pass with an unmet criterion, a finding citing a met criterion, final with criteria);
  - `formatAttemptFailure` output;
  - `evaluateAttempt` problems.
- **Schema upgrade:** the 4 data shapes in §1.4, the count-mismatch throw, and a real schema-83 file reopening at 84.
- **`agent-flow.ts`:** parsing a transcript fixture with thinking, tools, a rejection, approvals and a final answer; a malformed line throws.
- **Process test:** the two endpoints against a run with a phase run and an attempt (200 / 404 / 409).
- **Run test:** a run commits `phaseRuns` with the right labels, task and attempt, and records the attempt's typed review.
- **Dashboard tests:**
  - the tree (result lines, chips, default selection);
  - each pane kind;
  - the failure details fold;
  - stepper durations;
  - the flow fold (fetches on open, last 8 turns plus earlier, JSON answer rendering, 409 message).
- **Rail invariant:** after a run with children, the session list holds exactly the run's one session.

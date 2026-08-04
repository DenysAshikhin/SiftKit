# Handoff: Invalid-action opacity and validation-output tail truncation

**Date:** 2026-08-04
**Context:** Transcript audit of the eight `repo-agent` runs that executed `docs/superpowers/plans/2026-08-04-parallel-status-tracking-drift-fixes.md` (tasks 1-8). Two harness defects account for the worst outcomes in that batch: task 7 was killed mid-run and its answer machine-synthesized, and tasks 6 + 7 both reported nonexistent "pre-existing failures" because they were never shown a test-run verdict. Both are isolated and cheap to fix.

**Evidence source:** the `--log-file` targets were deleted, but full transcripts survive in `.siftkit/runtime.sqlite` → `run_logs.repo_search_transcript_jsonl`. The row key is the server-minted request id, not the repo-agent runId; match on finish timestamp. Task 6 = `57aa0f5a-708d-442b-9476-68c429d46a88`, task 7 = `ff1f044f-0d89-40eb-933b-d9e22f7a18be`.

**Repo rules that bind this work:** TDD (write the failing test, watch it fail, then implement); no type-assertion casts, no `any`, no non-null `!`, no namespace imports; no back-compat shims — dependent tests get updated, not aliased; DRY; typed end-to-end with zod at IO boundaries.

---

## Defect 1: every planner-action rejection collapses into one content-free sentence

### What the model saw

The model emitted `{"action":"git","command":"status"}`. It received, verbatim:

```
Invalid action: Provider returned an invalid planner tool action.. Return a valid JSON finish action or tool action payload.
```

No tool name, no field name, no constraint (and a double period). It retried the identical payload — 2× in task 6, 3× in task 7.

### Why the message is empty

[`normalizeRepoSearchToolCall`](../../../src/lib/model-json.ts#L428) has **eight** distinct `return null` paths: unknown tool, missing `command`, wrong first command token, missing required text arg, empty required array arg, absent arg spec, and two more inside the optional-arg loop. Every one collapses into the single `throw` at [`model-json.ts:385`](../../../src/lib/model-json.ts#L385). The parser knows precisely which rule failed and discards that knowledge.

[`handleInvalidParse`](../../../src/repo-search/engine/task-loop.ts#L557) then wraps `error.message` in a fixed template and appends the model's own bad payload back into the transcript as a synthetic `invalid_tool_call` exchange. The model gets its mistake echoed at it with a scolding that reads identically every time.

### The specific rule it tripped

[`model-json.ts:439-445`](../../../src/lib/model-json.ts#L439-L445):

```ts
if (isRepoSearchCommandToolName(toolName)) {
  const command = this.getCommandArgValue(rawArgs);
  if (!command || getFirstCommandToken(command) !== getRepoSearchCommandTokenForToolName(toolName)) return null;
```

`git` is the **only** tool that requires its own name repeated inside its argument. `run` accepts any command string; every other tool is native and typed. The one asymmetric rule in the protocol is also the one with a silent failure mode.

And the expected token is a constant: [`getRepoSearchCommandTokenForToolName`](../../../src/repo-search/planner-protocol.ts#L323-L325) can only ever return `'git'` for the `git` tool. The parser knows exactly what prefix is missing and rejects instead of supplying it. [`command-safety.ts:60-66`](../../../src/repo-search/command-safety.ts#L60-L66) needs the full command line only because `git` is the sole string that ever reaches PowerShell — normalizing `status` → `git status` upstream loses nothing that gate depends on.

### The model was not under-briefed

[`prompts.ts:270`](../../../src/repo-search/prompts.ts#L270) ships the exact correct template:

```
{"action":"git","command":"git status --short"}
```

So the initial error is the model's. The **unrecoverability** is the harness's.

### The budget is a hair trigger

[`DEFAULT_MAX_INVALID_RESPONSES = 3`](../../../src/repo-search/engine/task-loop-support.ts#L29), and `counters.invalidResponses` is a **lifetime counter — there is no reset anywhere in the codebase**. Three malformed actions across a 100-turn budget ends the run.

```
task6  16:36:36.346  INVALID#1  turn 47
       16:36:38.012  INVALID#2  turn 48
       16:36:4x      → {"action":"run","command":"git status --short"}   ✔ recovered
task7  16:42:53.371  INVALID#1  turn 39
       16:42:54.478  INVALID#2  turn 40
       16:42:55.898  INVALID#3  turn 41   → reason=invalid_response_limit
       16:42:56.009  SYNTH_REQ
```

Three byte-identical payloads in **2.5 seconds**, killing task 7 at turn 41 of 100. Task 6 hit the same wall and escaped only because it had one strike left. The two runs differ by a single retry.

Task 7's third attempt reads, in thinking: *"Let me try the run command to check git status."* — then emits the `git` payload again. The model had the fix and its output diverged from its plan; the harness allowed 2.5 seconds and three tries to land it.

### It then misreports the outcome

`invalid_response_limit` routes into [`task_terminal_synthesis`](../../../src/repo-search/prompts.ts#L361) — *"You are finalizing a repo-search run that terminated before finish validation passed"* — which produced:

> "Task 7 is complete. All 9 steps from the plan have been executed verbatim, with TDD verification and full typecheck/test passes."

repo-agent returned that as `{"status":"completed"}`. [`formatRepoTaskOutput`](../../../src/cli/repo-task-output.ts) forwards only `finalOutput`, so `reason: "invalid_response_limit"` never reaches the caller. (That discard is a separate defect with its own blast radius across all eight runs; it is out of scope here but must not be forgotten — a forced-synthesis run must not present as `completed`.)

### Fixes, cheapest first

1. **Prepend the constant token instead of returning null.** In the `isRepoSearchCommandToolName` branch, when `command` is non-empty and its first token is not the expected token, prepend `` `${token} ` `` rather than rejecting. Zero information loss; `evaluateCommandSafety` still receives a full line.
2. **Propagate the normalization reason.** Change `normalizeRepoSearchToolCall` to return a discriminated result (`{ ok: true, action }` / `{ ok: false, reason }`) instead of `RepoSearchToolAction | null`, and interpolate `reason` into the thrown error so `handleInvalidParse` forwards something actionable ("`git` requires `command` to begin with `git`", "`edit` requires a non-empty `edits` array", …). Note the double period in the current template while you are there.
3. **Reset or decay `invalidResponses` after any successful turn.** Three lifetime strikes across 100 turns punishes a run for one bad minute at turn 39. Per-streak counting (reset on the first valid action) preserves the guard's purpose — catching a model stuck in a loop — without killing a run that recovers.

**Prior art:** [`2026-07-23-repo-agent-crlf-edit-matching.md`](2026-07-23-repo-agent-crlf-edit-matching.md#L59) already flagged `invalid_response_limit` firing on a run whose work was done, and recommended treating repeated invalid actions after a successful terminal command as an implicit finish. That recommendation was never implemented; this is the second occurrence.

### Tests to add (TDD)

- `git` tool call with `command: "status"` normalizes to `git status` and executes (today: throws).
- `git` tool call with an empty/missing `command` still rejects, and the thrown message names the tool and the missing field.
- Each distinct `normalizeRepoSearchToolCall` rejection path produces a distinct, non-generic message.
- Two invalid actions followed by a valid tool call leaves the counter at 0, and a subsequent invalid action does not terminate the run.

---

## Defect 2: tail-only truncation of validation output hides the test verdict

### The mechanism

[`ValidationCommandOutputPolicy.apply`](../../../src/repo-search/engine/validation-command-output-policy.ts#L47) keeps the **last** [`REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT = 50`](../../../src/repo-search/engine/validation-command-output-policy.ts#L3) lines and prepends a count notice. Applied at [`repo-tools.ts:944-953`](../../../src/repo-search/engine/repo-tools.ts#L944-L953) with `outputKeep: 'tail'`.

### Why tail is exactly wrong for node's spec reporter

Minimal repro — 3 passing tests, 1 failing, `node --test --test-reporter=spec`:

```
 4: ✖ boom (0.6153ms)
 5: ℹ tests 4
 7: ℹ pass 3
 8: ℹ fail 1
14: ✖ failing tests:
17: ✖ boom (0.6153ms)
… 35 lines total
```

The counts land at lines 5-8. The `✖ failing tests:` detail block is lines 14-35 — **22 of 35 lines, all of it after the counts** — and runs ~20 lines per failure. Therefore:

- 1-2 failures → detail block ≈ 20-40 lines, counts survive the 50-line window.
- **≥3 failures → the detail block alone exceeds 50 lines, and the counts plus the earlier failures are always cut.**

The cap is not merely lossy; it is *systematically* lossy in exactly the case where the agent most needs the summary.

### What task 7 got

```
2026-08-04T16:42:38  npm test 2>&1   exit=1
  "5132 lines omitted from validation command output."
  → 50 lines kept = 3 stack traces, zero count lines
```

5184 lines produced, 3 failures, and the agent never saw `ℹ tests` / `ℹ pass` / `ℹ fail`. It could not distinguish 3 failures from 300. It labelled two of the three "unrelated / pre-existing" on no evidence. (Both were in fact load-induced flakes — the suite is green at HEAD: 2147 tests, 0 fail — but the agent had no way to establish that either.)

### The compounding in task 6

[`prompts.ts:309`](../../../src/repo-search/prompts.ts#L309) explicitly tells the model *"Commands for test, build, lint, and typecheck automatically retain only their final 50 lines… do not add tail pipelines"*. The model added `| Select-Object -Last 10` anyway. `isValidationCommand` splits on `;`, `&&`, `||` but **not** `|`, so the command still matched the npm pattern and the cap still applied — on top of the model's own tail-10:

```
16:34:21  npm test | Select-Object -Last 10       → 11 lines: a bare stack tail, no test name at all
16:35:27  npm test | Select-String "✖" …          → 3 lines: ZERO matches (✖ mangled by the cp1252 console)
                                                     + "Zero-output warning: 9 more zero-output command(s)…"
16:36:30  npm test | Select-String "fail|FAIL|…"  → 20 lines, 19 of them PASSING tests with "fail" in the name
```

Three full-suite reruns, ~2m10s of a run that lasted 8m35s, to recover one test name that a single un-truncated summary line carries. The middle attempt also burned a strike against the separate zero-output forced-answer counter.

### Two problems with the notice itself

- `"5132 lines omitted from validation command output."` never mentions that `outputMode: "full"` exists. The escape hatch appears once in the system prompt at [`prompts.ts:310`](../../../src/repo-search/prompts.ts#L310) and is never re-offered at the moment of loss. Neither task 6 nor task 7 ever used it.
- The notice is line 1 of a tail window, so the model's first impression of a failing 5000-line run is "something was hidden" with no indication of *what kind* of thing.

### Fix

Replace pure-tail retention with **summary-preserving** retention in `ValidationCommandOutputPolicy.apply`:

- Always retain lines matching the reporter-summary shape (`^ℹ `, `^✖ failing tests:`) regardless of position, then fill the remaining budget from the tail. This is reporter-agnostic enough for node's spec reporter and degrades to plain tail when no such lines exist.
- Alternatively/additionally, keep head+tail rather than tail-only.
- Append `re-run with outputMode: "full" for the complete output` to the omission notice.

Consider also making `isValidationCommand` split on `|` so a model-added tail pipeline is recognized as the model overriding the policy, rather than silently stacking with it.

### Tests to add (TDD)

- A 5000-line spec-reporter output with 3 failures retains all `ℹ tests/pass/fail` lines within the 50-line budget.
- Output with no `ℹ`/`✖ failing tests:` lines degrades to today's exact tail behavior (regression guard for the existing tests at `tests/` covering "retains exactly the final 50 lines and reports omissions" and its CRLF/pluralization siblings — those must be updated, not aliased).
- The omission notice contains the `outputMode: "full"` hint.
- `isValidationCommand('npm test 2>&1 | Select-Object -Last 10')` — assert the chosen semantics explicitly, whichever way you decide.

---

## Out of scope, but do not lose

`formatRepoTaskOutput` discarding the scorecard (`passed`, `reason`, `invalidResponses`, `commandFailures`, `safetyRejects`) affected **6 of the 8 audited runs** and is the single largest source of unwarranted confidence in repo-agent output. It needs its own handoff. Related: `passed` is computed at [`task-loop.ts:654`](../../../src/repo-search/engine/task-loop.ts#L654) as `signalCheck.passed && commandFailures === 0`, which marks any TDD red step as a failed run — so it needs redefining before it is worth surfacing.

---

## Status (implemented 2026-08-04)

Implemented via `docs/superpowers/plans/2026-08-04-invalid-action-recovery-and-validation-summary-retention.md`:
- Defect 1 fix 1 — the `git` token is prepended, not rejected.
- Defect 1 fix 2 — every planner-action rejection carries its specific reason; the double period is gone.
- Defect 1 fix 3 (counter) — `invalidResponses` decays by one per valid tool action at the single valid-action site.
- Defect 2 fix 7a — summary-preserving retention in `ValidationCommandOutputPolicy`.

Still open:
- Terminal-synthesis honesty. Note that `buildTerminalSynthesisPrompt` **already** receives `Termination reason`
  and `renderTail(2)` passes nearly the whole transcript, so the fix is a hard prohibition on claiming
  completion — not more input.
- `formatRepoTaskOutput` discarding the scorecard, and `worker.ts:66` setting `status: 'completed'`
  unconditionally. A forced-synthesis run still presents as `completed`.
- `outputMode: "full"` hint in the omission notice — blocked on confirming that `full` output survives
  the second, independent tail truncation in `ToolResultBudgeter` (`tool-action-processor.ts:733`).
- Whether `isValidationCommand` should split on a single `|`.

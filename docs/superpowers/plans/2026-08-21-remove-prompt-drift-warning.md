# Remove Prompt-Drift Warning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Completely remove the predicted-vs-server prompt-token drift check from repo-search — the evaluator module, the per-turn `turn_prompt_drift` log event, the `context_warning` it raises, and the `serverPromptTokens` plumbing that exists only to feed it.

**Architecture:** This is a pure deletion, reverting commit `b31e97be` ("feat(repo-search): log predicted-vs-server prompt token drift per turn"). The feature is contained in five source locations plus one test file. It has **no dedicated UI**: it rode on the pre-existing shared `context_warning` progress event, which other features still produce. The shared event kind and its whole render path therefore stay; only the drift producer is removed — plus `ProgressReporter.contextWarning`, the repo-engine helper method that drift is the *sole* caller of and which becomes dead code once drift is gone. Verification is by build (dangling imports fail `tsc`), lint (unused symbols fail `eslint`), grep (zero residual identifiers in `src/`, `tests/`, `dist/`), and the existing `context_warning` regression tests, which must pass unchanged before and after — they are the proof that the channel survived the producer's removal.

**Tech Stack:** TypeScript (ESM, `tsc` build to `dist/`), `node:test` via `dist/test-runner/run-tests.js`, ESLint, PowerShell on Windows.

---

## Why this scope, and what it costs

The drift warning fired on **every turn of every run** (11/11 turns on run `9bcc1c72`), because `predictedPromptTokens` includes `providerPromptReserveTokenCount` — a 1,442–2,092 token pad derived from tokenizing the serialized request envelope (sampler params, `max_tokens`, JSON response schema), none of which occupies prompt context. That pad alone exceeds the 1,024-token warn threshold before any real drift exists, so the signal was unconditional noise.

**Cost of removal, accepted deliberately:** `serverPromptTokens` is the only path to the server's true `usage.prompt_tokens`. After this change, `run_logs.prompt_eval_tokens` and `chat_messages.prompt_eval_tokens` continue to persist the *predicted* (reserve-inflated) count with no in-repo way to compare against the server's actual number. If prompt accounting is revisited later, restoring a server-side count is the starting point. This plan does not touch the reserve itself.

## Conventions

- All commands are PowerShell, run from the repo root `C:\Users\denys\Documents\GitHub\SiftKit`.
- Per repo policy, **do not commit unless the user explicitly asks.** Commit steps are included and marked; skip them absent an explicit request, and leave the tree dirty for review instead.
- Per repo policy, full-suite and typecheck output is routed through `siftkit summary` rather than read raw.
- Do not use worktrees.

## File map

| File | Action | Responsibility after change |
|---|---|---|
| `src/repo-search/engine/prompt-drift.ts` | **Delete** | — (entire module exists only for this feature) |
| `tests/prompt-drift.test.ts` | **Delete** | — (tests only the deleted module) |
| `src/repo-search/engine/task-loop.ts` | Modify (line 65, lines 462–472) | Runs planner turns; no longer evaluates or reports drift |
| `src/repo-search/engine/progress-reporter.ts` | Modify (lines 101–103) | Emits repo-search progress events; the now-dead `contextWarning` helper is removed |
| `src/repo-search/planner-protocol.ts` | Modify (lines 37–38, line 738) | `PlannerActionResponse` no longer carries `serverPromptTokens` |
| `docs/superpowers/plans/2026-08-21-progress-action-context-count-shim.md` | Annotate (line 759 heading, line 1024 step) | Historical plan; Task 6 marked reverted so a future agent does not re-add the feature |

**Explicitly NOT changed** — the `context_warning` event kind and its entire transport and render path survive, because two non-drift producers still emit it. Removing any of the following would break preset-context warnings in the CLI, the server console, chat SSE, and the dashboard warning banner:

- Surviving producers: `src/repo-search/execute.ts:382-384` (preset `systemContext.warnings`, writes the event directly and does **not** go through `ProgressReporter`), and the separate summary feature `src/summary/request-runner.ts:239-241` → `src/summary/progress-reporter.ts:90-92` (its own reporter class, same kind string — leave its `contextWarning` method alone).
- Event type: `src/repo-search/types.ts:21-22,52` (loose `kind: string` + `warningText?: string`; no zod schema).
- Consumers: `src/cli/progress-renderer.ts:47-49,101-112`, `src/cli/status-server-api-client.ts:478-489`, `src/repo-search/execute.ts:88-95`, `src/status-server/dashboard-runs.ts:186,188-190,206-212`, `src/status-server/operation-progress-writers.ts:50-57`, `src/status-server/repo-agent-sessions.ts:260-265`, `src/status-server/routes/chat.ts:342-346,412-418`.
- Tests: `tests/cli-progress-renderer.test.ts:60,125-136`, `tests/chat-repo-operation-runner.test.ts:54,253`.
- **Dashboard:** no file in `dashboard/` or `desktop/` contains the literal string `context_warning` or `contextWarning`, but the dashboard *does* render these warnings — the server translates the event into an SSE event named `warning` (`src/status-server/routes/chat.ts:344`), consumed by `dashboard/src/lib/chat-stream-parser.ts:19,70-71`, `chat-stream-transitions.ts:24-25`, `chat-session-runtime-store.ts:26,44,60,123-124`, `ChatTab.tsx:221,422-425`, styled by `.warning-banner` in `dashboard/src/styles/chat.css:78`. **All of this stays.** There is no drift-specific UI to delete anywhere.
- **Near-miss, do NOT touch:** `tests/engine-forced-finish.test.ts:45,54,65` uses a field also named `warningText`, belonging to the zero-output countdown (`src/repo-search/engine/forced-finish.ts:15,46-56`). It is unrelated to `context_warning`.

---

### Task 1: Remove the drift call site and the `serverPromptTokens` plumbing

**Files:**
- Modify: `src/repo-search/engine/task-loop.ts:65`, `src/repo-search/engine/task-loop.ts:462-472`
- Modify: `src/repo-search/engine/progress-reporter.ts:101-103`
- Modify: `src/repo-search/planner-protocol.ts:37-38`, `src/repo-search/planner-protocol.ts:738`
- Test (must pass before and after, unchanged): `tests/cli-progress-renderer.test.ts`, `tests/chat-repo-operation-runner.test.ts`

- [ ] **Step 1: Establish the `context_warning` baseline before touching anything**

These two suites cover the `context_warning` channel via its *non-drift* producers. They must pass now, and must still pass at the end of this task. That is the regression guard: it proves the drift producer was removed without collapsing the shared channel.

```powershell
npm run build:test
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node .\dist\test-runner\run-tests.js cli-progress-renderer chat-repo-operation-runner
```

Expected: PASS, both files, zero failures. If either already fails on a clean tree, stop and report — the baseline is invalid and the guard is meaningless.

- [ ] **Step 2: Delete the drift import in `task-loop.ts`**

Remove exactly this line (currently line 65), which sits between the `ProgressReporter` and `PromptPreparer` imports:

```typescript
import { evaluatePromptDrift } from './prompt-drift.js';
```

After the edit the surrounding import block must read:

```typescript
import { ProgressReporter } from './progress-reporter.js';
import { PromptPreparer } from './prompt-preparer.js';
```

- [ ] **Step 3: Delete the drift evaluation block in `task-loop.ts`**

Remove this exact block (currently lines 463–472) together with the blank line that precedes it:

```typescript
    const drift = evaluatePromptDrift({
      predictedPromptTokens: prepared.promptTokenCount,
      serverPromptTokens: response.serverPromptTokens ?? null,
    });
    if (drift) {
      this.options.logger?.write({ kind: 'turn_prompt_drift', taskId: this.task.id, turn, ...drift });
      if (drift.warn) {
        this.progress.contextWarning(`prompt drift ${drift.driftTokens} tokens: predicted=${drift.predictedPromptTokens} server=${drift.serverPromptTokens}`);
      }
    }
```

After the edit the region must read exactly this (the first three lines are the unchanged tail of the preceding `this.options.logger?.write({ ... })` call — do not alter them):

```typescript
      promptCacheTokens: Number.isFinite(response.promptCacheTokens) ? Number(response.promptCacheTokens) : null,
      promptEvalTokens: Number.isFinite(response.promptEvalTokens) ? Number(response.promptEvalTokens) : null,
      ...(response.thinkingBudgetExhausted ? { thinkingBudgetExhausted: true } : {}),
    });

    const turnThinkingText = String(response.thinkingText || '').trim();
```

Do **not** remove `prepared.promptTokenCount` — it is used by other call sites in this file.

- [ ] **Step 4: Delete the now-dead `contextWarning` method from the repo-search `ProgressReporter`**

Step 3 removed the only caller of `ProgressReporter.contextWarning`. The other `context_warning` producers do not use this method: `src/repo-search/execute.ts:382-384` writes the event straight to the progress writer, and the summary feature has its own separate reporter class. The method is therefore dead, and ESLint will not flag an unused public class method — it must be removed by hand.

In `src/repo-search/engine/progress-reporter.ts`, remove these three lines (currently 101–103) and one of the surrounding blank lines:

```typescript
  contextWarning(warningText: string): void {
    this.emit({ kind: 'context_warning', taskId: this.taskId, warningText, elapsedMs: this.elapsedMs() });
  }
```

After the edit, `progressUpdate` must be followed directly by `toolStart`:

```typescript
  progressUpdate(turn: number, progressText: string): void {
    this.emit({ kind: 'progress_update', taskId: this.taskId, turn, maxTurns: this.maxTurns, progressText, elapsedMs: this.elapsedMs() });
  }

  toolStart(toolCallId: string, turn: number, command: string, promptTokenCount: number): void {
```

Do **not** touch `SummaryProgressReporter.contextWarning` at `src/summary/progress-reporter.ts:90-92`, nor its `'context_warning'` entry in the kind union at `src/summary/progress-reporter.ts:1-4` — that is a different class serving a live caller (`src/summary/request-runner.ts:240`).

- [ ] **Step 5: Delete the `serverPromptTokens` field from `PlannerActionResponse`**

In `src/repo-search/planner-protocol.ts`, remove these two lines (currently 37–38):

```typescript
  /** The stream's usage.prompt_tokens — the server's own count of the prompt it received. */
  serverPromptTokens?: number;
```

The type must then read:

```typescript
export type PlannerActionResponse = {
  text: string;
  thinkingText: string;
  mockExhausted: boolean;
  nextMockResponseIndex?: number;
  promptCacheTokens?: number | null;
  promptEvalTokens?: number | null;
  promptEvalDurationMs?: number | null;
  generationDurationMs?: number | null;
  speculativeAcceptedTokens?: number | null;
  speculativeGeneratedTokens?: number | null;
  /** Set when the client stopped thinking at the preset ReasoningBudget and completed via a continuation request. */
  thinkingBudgetExhausted?: true;
};
```

- [ ] **Step 6: Delete the `serverPromptTokens` assignment**

In `src/repo-search/planner-protocol.ts`, remove this exact line (currently 738):

```typescript
    ...(typeof response.usage.promptTokens === 'number' ? { serverPromptTokens: response.usage.promptTokens } : {}),
```

The returned object must then read:

```typescript
  return {
    text: text.trim(),
    thinkingText,
    mockExhausted: false,
    promptCacheTokens: response.usage.promptCacheTokens,
    promptEvalTokens: response.usage.promptEvalTokens,
    promptEvalDurationMs: response.usage.promptEvalDurationMs ?? null,
    generationDurationMs: response.usage.generationDurationMs ?? null,
    speculativeAcceptedTokens: response.usage.speculativeAcceptedTokens ?? null,
    speculativeGeneratedTokens: response.usage.speculativeGeneratedTokens ?? null,
    ...(response.thinkingBudgetExhausted ? { thinkingBudgetExhausted: true } : {}),
  };
```

Leave `response.usage.promptTokens` itself alone — `LlamaCppUsage.promptTokens` (`src/llm-protocol/types.ts:95-98`) is parsed from the stream and read by other consumers.

- [ ] **Step 7: Verify the guard still passes and nothing dangles**

```powershell
npm run build:test
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node .\dist\test-runner\run-tests.js cli-progress-renderer chat-repo-operation-runner engine-prompt-preparer
```

Expected: PASS, zero failures. In particular `tests/cli-progress-renderer.test.ts:125-136` ("warning-only renderer forwards context_warning alongside activity_summary") must still pass — if it fails, Step 4 removed too much and the event kind itself was damaged.

`tests/prompt-drift.test.ts` still exists and still passes at this point — the module is now unimported but not yet deleted. That is expected; Task 2 removes it.

- [ ] **Step 8: Commit** — *only if the user explicitly asked for commits; otherwise skip this step and leave the change for review.*

```powershell
git add src/repo-search/engine/task-loop.ts src/repo-search/engine/progress-reporter.ts src/repo-search/planner-protocol.ts
git commit -m "refactor(repo-search): drop the prompt-drift call site and serverPromptTokens plumbing"
```

**Acceptance criteria:** `task-loop.ts` contains no reference to `evaluatePromptDrift`, `turn_prompt_drift`, or `serverPromptTokens`; `ProgressReporter.contextWarning` is gone; `planner-protocol.ts` no longer declares or assigns `serverPromptTokens`; the `context_warning` event kind, `SummaryProgressReporter.contextWarning`, and every consumer listed in the file map are untouched; the three listed suites pass.

---

### Task 2: Delete the drift module and its test

**Files:**
- Delete: `src/repo-search/engine/prompt-drift.ts`
- Delete: `tests/prompt-drift.test.ts`

- [ ] **Step 1: Confirm the module has no remaining importers**

```powershell
Get-ChildItem -Path src, tests -Recurse -Filter *.ts | Select-String -Pattern "prompt-drift|evaluatePromptDrift|PromptDriftRecord|PROMPT_DRIFT_WARN_TOKENS"
```

Expected: hits **only** in `src\repo-search\engine\prompt-drift.ts` and `tests\prompt-drift.test.ts`. If any other file appears, Task 1 was incomplete — go back and finish it before deleting anything.

- [ ] **Step 2: Delete both files**

```powershell
Remove-Item src\repo-search\engine\prompt-drift.ts
Remove-Item tests\prompt-drift.test.ts
```

- [ ] **Step 3: Verify zero residual references in source and tests**

```powershell
Get-ChildItem -Path src, tests -Recurse -Filter *.ts | Select-String -Pattern "prompt-drift|evaluatePromptDrift|PromptDriftRecord|PROMPT_DRIFT_WARN_TOKENS|serverPromptTokens|turn_prompt_drift"
```

Expected: **no output.** Any hit is a missed migration — fix it before continuing.

- [ ] **Step 4: Confirm the surviving `context_warning` producers are intact**

```powershell
Get-ChildItem -Path src -Recurse -Filter *.ts | Select-String -Pattern "contextWarning|context_warning"
```

Expected: hits in exactly these files, and no others — `src/cli/progress-renderer.ts`, `src/repo-search/execute.ts`, `src/status-server/dashboard-runs.ts`, `src/status-server/routes/chat.ts`, `src/summary/progress-reporter.ts`, `src/summary/request-runner.ts`. In particular there must be **zero** hits in `src/repo-search/engine/progress-reporter.ts` (the removed helper) and **at least one** in each of `src/repo-search/execute.ts` and `src/summary/request-runner.ts` (the surviving producers). A missing producer means Task 1 Step 4 removed too much.

- [ ] **Step 5: Verify the build and lint are clean**

A dangling import or an unused symbol fails here; this is the real proof the deletion is complete.

```powershell
npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail, every tsc or eslint error, and its file:line."
```

Expected: pass, zero errors. (`npm run typecheck` also runs `npm run lint`.)

- [ ] **Step 6: Commit** — *only if the user explicitly asked for commits; otherwise skip.*

```powershell
git add -A src/repo-search/engine/prompt-drift.ts tests/prompt-drift.test.ts
git commit -m "refactor(repo-search): delete the prompt-drift evaluator and its test"
```

**Acceptance criteria:** both files are gone; the grep in Step 3 returns nothing; the grep in Step 4 shows the six surviving `context_warning` files and nothing in the repo-search `ProgressReporter`; `npm run typecheck` (including lint) passes.

---

### Task 3: Purge stale build artifacts, annotate the superseded plan, and verify end to end

**Files:**
- Delete (build output): `dist/repo-search/engine/prompt-drift.js` and siblings
- Modify: `docs/superpowers/plans/2026-08-21-progress-action-context-count-shim.md:759`, same file line 1024

- [ ] **Step 1: Remove the stale compiled module**

`tsc` does not delete outputs for source files that no longer exist, so the compiled module would survive a plain rebuild and remain loadable at runtime.

```powershell
Remove-Item dist\repo-search\engine\prompt-drift.* -ErrorAction SilentlyContinue
Get-ChildItem -Path dist -Recurse -Filter "prompt-drift.*"
```

Expected: the second command prints nothing.

- [ ] **Step 2: Rebuild from clean and confirm the artifact does not return**

```powershell
npm run build 2>&1 | siftkit summary --question "Return pass/fail and every build error with file:line."
```

Then:

```powershell
Get-ChildItem -Path dist -Recurse -Filter "prompt-drift.*"
Get-ChildItem -Path dist -Recurse -Filter *.js | Select-String -Pattern "turn_prompt_drift|serverPromptTokens|evaluatePromptDrift"
```

Expected: both commands print nothing.

- [ ] **Step 3: Annotate the plan that introduced the feature**

`docs/superpowers/plans/2026-08-21-progress-action-context-count-shim.md` Task 6 specified this feature and its acceptance criteria. Left as-is, a future agent executing that plan would re-add it.

Change the heading at line 759 from:

```markdown
### Task 6: Prompt-drift check (predicted vs server-reported)
```

to:

```markdown
### Task 6: Prompt-drift check (predicted vs server-reported) — REVERTED 2026-08-21, DO NOT IMPLEMENT
```

Insert this note immediately below that heading, before the task body:

```markdown
> **Reverted.** This task shipped as `b31e97be` and was removed in full by
> `docs/superpowers/plans/2026-08-21-remove-prompt-drift-warning.md`. The check warned on every
> turn because `predictedPromptTokens` includes `providerPromptReserveTokenCount`, a 1,442–2,092
> token pad for request-envelope JSON that never enters the prompt — the pad alone exceeds the
> 1,024-token threshold. Do not re-implement this without first fixing the reserve. The steps
> below are retained as a historical record only.
```

Then replace Step 4 of Task 8 at line 1024 — which instructs the engineer to grep run logs for `turn_prompt_drift` — with:

```markdown
- [ ] **Step 4: End-to-end drift sanity** — *removed; see the revert note on Task 6. No drift record is emitted any more, so there is nothing to grep for.*
```

- [ ] **Step 4: Run the full suite**

```powershell
npm run build:test
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node .\dist\test-runner\run-tests.js 2>&1 | siftkit summary --question "Return pass/fail, total/passed/failed counts, every failing test name, and its root error with file:line."
```

Expected: pass, zero failures. If failures appear, attribute them before acting: only failures naming `prompt-drift`, `task-loop`, `progress-reporter`, `planner-protocol`, or `context_warning` are attributable to this change. Anything else is pre-existing and must be reported as such, not fixed here.

- [ ] **Step 5: Live smoke test — confirm the warning is actually gone**

```powershell
siftkit repo-search 'List the npm scripts defined in package.json and finish.'
```

Expected: the run completes and **no `context_warning prompt drift ...` line appears** in the progress output, where previously one appeared on every turn.

Then confirm nothing was logged, reading the newest transcript from the repo-local DB:

```powershell
sqlite3 .siftkit\runtime.sqlite "select content_text from runtime_artifacts where artifact_kind='repo_search_transcript' order by created_at_utc desc limit 1;" | Select-String -Pattern "turn_prompt_drift"
```

Expected: no output.

Historical transcripts from earlier runs still contain `turn_prompt_drift` lines. That is fine and requires no migration: `createJsonLogger.write` accepts `Record<string, JsonSerializable>` (`src/repo-search/logging.ts:49-51`) with no schema or discriminated union over event kinds, so no reader validates or rejects an unknown kind.

- [ ] **Step 6: Commit** — *only if the user explicitly asked for commits; otherwise skip.*

```powershell
git add docs/superpowers/plans/2026-08-21-progress-action-context-count-shim.md docs/superpowers/plans/2026-08-21-remove-prompt-drift-warning.md
git commit -m "docs: mark the prompt-drift task reverted"
```

**Acceptance criteria:** no `prompt-drift` artifact anywhere in `dist/`; no drift identifiers in compiled output; the superseded plan's Task 6 and Task 8 Step 4 are annotated; full suite passes; a live repo-search run emits no drift warning and logs no `turn_prompt_drift` event.

---

## Risks

1. **Loss of the server's true prompt count.** `serverPromptTokens` was the sole reader of `usage.prompt_tokens` in repo-search. After this change nothing in-repo compares predicted against actual, so a future *real* preflight counting bug will go unnoticed. Accepted: the check as built could not have detected one anyway, since the reserve pad swamped the signal.
2. **The reserve over-prediction remains.** `providerPromptReserveTokenCount` still adds 1,442–2,092 phantom tokens to `promptTokenCount`, which still lands in `run_logs.prompt_eval_tokens` and `chat_messages.prompt_eval_tokens`. Removing the warning removes the symptom, not the cause. Out of scope here by explicit instruction.
3. **Shared-channel over-deletion.** The subtlest way to get this wrong is to treat `context_warning` as drift-owned and delete the event kind, its CLI/server/SSE consumers, `SummaryProgressReporter.contextWarning`, or the dashboard `.warning-banner` along with the drift producer. That would silently break preset-context warnings from `src/repo-search/execute.ts:383` and `src/summary/request-runner.ts:240` — silently, because nothing asserts those warnings render end-to-end. Only the repo-engine `ProgressReporter.contextWarning` helper goes, and only because drift is its sole caller. Task 1 Step 1 and Step 7 exist specifically to catch an over-deletion.
4. **Pre-existing suite failures masking regressions.** Task 3 Step 4 requires attributing failures rather than assuming they are new; run the baseline first if the tree's health is unknown.

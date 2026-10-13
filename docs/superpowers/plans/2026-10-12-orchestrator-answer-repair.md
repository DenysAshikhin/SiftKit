# Orchestrator Answer Repair and Disk-Cache Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop orchestrator runs failing on malformed parent JSON and bad final-review citations, and fix three issues found while validating the exl3 disk cache.

**Architecture:** Parent phases hand their zod answer schema to the repo-search engine. When the model's free-form final answer fails that schema, the task loop runs one extra terminal-synthesis turn constrained by `response_format: json_schema` (generated with `z.toJSONSchema`), reusing the cached prompt prefix, instead of the orchestrator re-running the whole phase. Final verification gets the same retry loop as task review. Two small runtime fixes: the disk checkpoint default, and the managed Tabby exit message.

**Tech Stack:** TypeScript on Node 26 (no build step), zod 4, `node:test` via `src/test-runner/run-tests.ts`, TabbyAPI/exllamav3 (formatron JSON-schema constraints, verified live on 2026-10-12 with the 5.5 KB plan-preparation schema).

---

## Rules for every task

- **No SiftKit.** Never run `siftkit` in any form (repo-search, summary, repo-agent). Use Read, Grep, Glob and shell directly.
- TDD: write the failing test, run it and see it fail, implement, run it and see it pass.
- TypeScript rules: no `any`, no explicit `unknown`, no type assertions (`as`), no non-null `!`, no namespace imports. `as const` and `satisfies` are fine. Parse IO with zod.
- Comments 1–2 lines. Match the surrounding style. No compatibility shims; refactors are complete replacements.
- Do not commit. Do not touch other tasks. Keep temp files only in `C:\tmp\rsx\diskcache-scratch` and delete yours.
- Before finishing: the task's tests, `npm run typecheck` (it also runs lint), and the broader suite named in the task.

---

### Task R1: Disk checkpoint default 2048

Orchestrator parent phases share a ~2–2.5k-token prefix; with the disk tier's checkpoint spacing at 4096 no checkpoint survives inside it, so a parent request after a swap recomputes everything (measured 0 cached tokens; at 2048 it reused 2048–4096).

**Files:**
- Modify: `src/config/constants.ts` (`SIFT_DEFAULT_EXL3_DISK_CACHE_CHECKPOINT_INTERVAL`)
- Test: `tests/config-normalization.test.ts` (the case around line 564 asserting the legacy default `4096`)

- [ ] Change the expected default in the normalization test to `2048`; run `node src/test-runner/run-tests.ts tests/config-normalization.test.ts` and see it fail.
- [ ] Set `SIFT_DEFAULT_EXL3_DISK_CACHE_CHECKPOINT_INTERVAL = 2_048` with a one-line comment: orchestrator phases share a ~2k-token prefix and a hybrid model resumes only from a stored checkpoint.
- [ ] Run the test again (pass), then `npm run typecheck`.

**Acceptance:** a preset without `DiskCacheCheckpointInterval` normalizes to 2048; explicit values are unchanged.

---

### Task R2: Name the engine's failure when TabbyAPI exits

Today a failed load reports `TabbyAPI exited unexpectedly (code=1, signal=null).`; the real cause (`RuntimeError: Insufficient VRAM in split for model and cache`, `OSError: [WinError 1450] ...`, `RuntimeError: CPU MoE pinned arena: chunk 42 needs 1024 MiB ...`) is only in the stored engine stderr.

**Files:**
- Modify: `src/status-server/tabby-run-recorder.ts`, `src/status-server/managed-tabby.ts` (exit handler around line 286)
- Test: `tests/tabby-run-recorder.test.ts` (create if absent) and `tests/managed-tabby.test.ts`

- [ ] Tests for `TabbyRunRecorder.lastEngineError()`: returns `null` before any stderr; after stderr chunks containing a Python traceback returns the last line matching `^[A-Za-z_][\w.]*(Error|Exception): .+` (trimmed, `\r` stripped), e.g. `RuntimeError: Insufficient VRAM in split for model and cache`; a line split across two chunks is still found; stdout is ignored; a later matching line replaces an earlier one. See them fail.
- [ ] Implement in `TabbyRunRecorder.observeRawChunk` for `engine_stderr` only: keep a per-stream partial-line carry, scan complete lines, remember the last match. Keep the existing MTP marker logic working (it currently returns early once seen; the error tracking must keep running after that).
- [ ] Test in `tests/managed-tabby.test.ts`: a managed child that writes `RuntimeError: Insufficient VRAM in split for model and cache` to stderr and exits 1 during startup produces a startup error message `TabbyAPI exited unexpectedly (code=1, signal=null): RuntimeError: Insufficient VRAM in split for model and cache`. Use the file's existing fake-child pattern. See it fail.
- [ ] In the exit handler build the message as the current text, with `: ${lastError}` inserted before the final period when `recorder.lastEngineError()` is not null (exact format: `TabbyAPI exited unexpectedly (code=1, signal=null): <line>`; unchanged text when null). The same message goes to `recorder.finalize` and `startupError`.
- [ ] Run both test files, then `npm run typecheck`.

**Acceptance:** a failed load's runtime error names the Python exception line.

---

### Task R3: Final verification retries like task review

`verifyFinal` (`src/orchestrator/run.ts` ~line 736) asks the parent once: an unusable answer throws `final_review_invalid` and a bad citation (`findReviewEvidenceProblems`, evaluated inside `evaluateAttempt`) throws `final_verification_failed`, with no retry. `reviewEvidence` (~line 520) already retries both with the problems fed back.

**Files:**
- Modify: `src/orchestrator/run.ts`, `src/orchestrator/prompts.ts` (`buildFinalVerificationPrompt` gains `rejectedProblems: readonly string[]`, rendered with `describeRejection('review', ...)` before the answer instructions, like `buildAttemptReviewPrompt`)
- Test: `tests/process/orchestrator-run.e2e.test.ts`, `tests/orchestrator-prompts.test.ts`

- [ ] Prompt test: `buildFinalVerificationPrompt` with `rejectedProblems: ['Review evidence: a.ts:3 does not contain the cited snippet.']` contains `Your previous review was rejected:` and that line; with `[]` it contains neither. See it fail.
- [ ] e2e test (scripted parent, existing harness): final verification's first parent answer passes but cites a snippet absent from the file; the second answer cites correctly → run `completed`, and the run's events contain `Parent phase started: final verification; retrying after: Review evidence: ...`. A second e2e: both answers cite badly → run fails with code `final_review_invalid` and the message lists the problem. See them fail.
- [ ] Replace the single ask with one shared loop used by both task review and final verification (no duplicated loop): `private async askEvidenceReview(review: EvidenceReviewRequest): Promise<OrchestratorTaskReview>` where `EvidenceReviewRequest` is a discriminated union `{ kind: 'task'; running; child; checks; changedPaths } | { kind: 'final'; plan; checks }`. The loop runs up to `PARENT_PHASE_ATTEMPTS`, builds the prompt with a `switch` on `kind`, sets `rejected = reply.ok ? findReviewEvidenceProblems(...) : reply.problems`, and on exhaustion throws `task_review_invalid` (task, with `taskId`) or `final_review_invalid` (final). `reviewEvidence` and the old inline ask are removed.
- [ ] `verifyFinal` keeps the "no evidence checks → no parent ask" rule and passes the accepted review to `evaluateAttempt`.
- [ ] Run `node src/test-runner/run-tests.ts tests/orchestrator-prompts.test.ts`, `npm run test:process` (the orchestrator e2e is a process test), then `npm run typecheck`.

**Acceptance:** one bad final citation costs a parent retry, not the run.

---

### Task R4: Terminal synthesis can be schema-constrained

**Files:**
- Modify: `src/repo-search/planner-protocol.ts` (`requestTerminalSynthesis` ~line 716 hard-codes `responseSchema: null`), `src/repo-search/engine/terminal-synthesizer.ts`, `src/repo-search/prompts.ts`
- Test: `tests/engine-terminal-synthesizer.test.ts`, `tests/repo-search-terminal-synthesis-retry.test.ts` (follow their mock patterns)

- [ ] Tests: `TerminalSynthesizer.synthesize` with `answerFormat: { name: 'plan_preparation', schema: <JsonObject> }` sends a request whose body has `response_format: { type: 'json_schema', json_schema: { name: 'plan_preparation', strict: true, schema } }` and `tool_choice` none; with `answerFormat: null` the body has no `response_format` (current behaviour). A repair call (`instruction` built by the new `buildAnswerRepairInstruction(['…'])`) appends that instruction instead of the terminal-synthesis one. See them fail.
- [ ] `requestTerminalSynthesis` takes `answerFormat: { name: string; schema: JsonObject } | null` and maps it onto the existing `PlannerResponseConstraint` (`responseSchema` / `responseSchemaName`).
- [ ] `TerminalSynthesizer.synthesize` input gains `answerFormat` (same type) and `instruction: string`; the caller chooses the instruction (`buildTerminalSynthesisInstruction(reason)` today). Keep the 3-attempt loop.
- [ ] Add `buildAnswerRepairInstruction(problems: readonly string[]): string` in `src/repo-search/prompts.ts`: "Your final answer above could not be used:" + one `- problem` line each + "Reply with only the corrected answer as one JSON object in the required format, keeping its content."
- [ ] Update every existing caller to pass `answerFormat: null` and the terminal instruction (no other behaviour change). Run both test files and `npm run typecheck`.

**Acceptance:** synthesis can be constrained by a JSON schema and re-instructed for repair; unconstrained behaviour is unchanged.

---

### Task R5: The task loop repairs answers that fail their schema

**Files:**
- Modify: `src/repo-search/types.ts` (`RepoSearchExecutionRequest`), `src/repo-search/execute.ts`, `src/repo-search/engine.ts`, `src/repo-search/engine/task-loop-support.ts`, `src/repo-search/engine/task-loop.ts` (`buildAgentLoopResult` ~line 850)
- Test: `tests/repo-search-loop.core.test.ts` or `tests/mock-repo-search-loop.test.ts` (mock responses)

- [ ] Add `answerSchema?: { name: string; schema: z.ZodType }` to `RepoSearchExecutionRequest` (one-line doc: the shape a finishing answer must parse to; an answer that fails it gets one constrained repair turn). Thread it to the task loop the same way `systemContext` is threaded (`execute.ts` → `engine.ts` options → task-loop options).
- [ ] Tests with mock planner responses and `answerSchema` = a small zod object:
  1. Finish content is valid JSON for the schema → `finalOutput` is that content and no extra request is made.
  2. Finish content fails (prose, or wrong shape) → exactly one extra request with `response_format` json_schema (schema from `z.toJSONSchema(schema, { io: 'input' })` minus `$schema`, name = `answerSchema.name`) whose last user message lists the parse problem; `finalOutput` is the repaired content.
  3. No finish (turn budget exhausted) with `answerSchema` → the terminal synthesis request carries the same `response_format`.
  4. Without `answerSchema` nothing changes.
  See them fail.
- [ ] In `buildAgentLoopResult`: compute `answerFormat` once from `answerSchema` (null when absent; reuse the `$schema`-stripping pattern of `buildApprovalVerdictJsonSchema` in `src/repo-search/approval-verdict.ts` — extract a shared helper if both need it). If there is no final output, synthesize as today but with `answerFormat`. If there is final output and `answerSchema`, validate with `ModelJson.parseObject(finalOutput, answerSchema.schema, answerSchema.name)` (`src/lib/model-json.ts`); on failure synthesize with `buildAnswerRepairInstruction([error.message])` and `answerFormat`, and use its output. Do not validate again afterwards; the orchestrator's parse still owns semantic validation and its own retry.
- [ ] Log one `task_answer_repair_requested` event (taskId, problem) so repairs are visible in transcripts.
- [ ] Run the test file(s), `npm test` (unit suite), and `npm run typecheck`.

**Acceptance:** an invalid finishing answer is repaired by one constrained turn on the cached prefix instead of failing the task.

---

### Task R6: Orchestrator parent phases pass their answer schema

**Files:**
- Modify: `src/orchestrator/phase-runner.ts` (`infer` gains `answerSchema`), `src/orchestrator/run.ts` (`askParent` passes its `schema` and a name derived from the label, e.g. `plan preparation` → `plan_preparation`)
- Test: `tests/process/orchestrator-run.e2e.test.ts`

- [ ] e2e test (scripted provider): the plan-preparation phase's finish is prose wrapping broken JSON; the next scripted response (the constrained repair) is a valid plan → the run proceeds to `validating_plan` with **no** `retrying after` event for plan preparation, and the repair request carried `response_format` with name `plan_preparation`. See it fail.
- [ ] `OrchestratorPhaseRunner.infer(request, prompt, label, answerSchema: { name: string; schema: z.ZodType })` passes `answerSchema` to `executeRepoSearch`. `askParent` builds the name with `label.replace(/ /gu, '_')`.
- [ ] Run `npm run test:process` and `npm run typecheck`.

**Acceptance:** malformed parent JSON is repaired inside the phase; the orchestrator's phase retry only fires for semantic problems.

---

### Task R7: Live validation (primary agent)

- [ ] Restart the status server (code changed), load `exl3-3-8-next-3-5bpw` (3.50bpw, f16 KV, NcpuMoe 390) as the orchestrator parent.
- [ ] Run the sandbox orchestrator task three times. Record: runs completed, parent `retrying after` events by phase, `task_answer_repair_requested` count, and whether every repair produced a schema-valid answer.
- [ ] Confirm a deliberately failed load (e.g. a preset with an impossible NcpuMoe) reports the Python exception in `GET /runtime/inference`'s `error`, then restore the config.
- [ ] Record results in `docs/exl3-backend-setup.md` (replace the "Neither is reliable" sentence with the new outcome).

**Acceptance:** 3/3 runs complete, or every remaining failure is semantic (not JSON shape) and documented.

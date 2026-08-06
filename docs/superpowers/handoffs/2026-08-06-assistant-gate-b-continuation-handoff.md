# Handoff — SiftKit Assistant, Gate B in progress → finish Tasks 21–26

**Date:** 2026-08-06
**From:** Gate B execution session (Tasks 1–20 + a mid-gate transaction/token-limit refactor)
**Branch:** Tasks 1–20 are merged to `main` @ `741fcc53`, clean.
**State:** Gate B is **~77% done (20/26 tasks)**. Remaining: Tasks 21–26 (job runner, retrieval, config flag, service composition root, status-server wiring, e2e).

---

## 0. Branch note — read this first

Your current checkout may be `codex/admission-ram-progress-fixes`, which is `main` + one unrelated
docs-only commit (`d82087b7 docs: design admission and progress corrections`). That commit does not
touch `src/assistant/` and is unrelated to Gate B.

**Resume from `main` @ `741fcc53`** (or a fresh branch off it). Do not build Gate B continuation
work on top of `codex/admission-ram-progress-fixes` unless that branch's own work is also in scope.

---

## 1. Where things stand

| | |
|---|---|
| Design | `assistant/2026-07-30-siftkit-assistant-design.md` |
| Gate A plan (done, green) | `docs/superpowers/plans/2026-08-05-assistant-gate-a-graph-foundation.md` |
| **Gate B plan (executing this — Tasks 21–26 remain)** | `docs/superpowers/plans/2026-08-05-assistant-gate-b-conversational-memory.md` — 26 tasks |
| Transaction/token-limit refactor plan (done) | `docs/superpowers/plans/2026-08-05-explicit-assistant-transactions-and-token-trimming.md` |
| Prior Gate B handoffs | `docs/superpowers/handoffs/2026-08-05-assistant-gate-b-start-handoff.md`, `2026-08-05-assistant-gate-b-execution-handoff.md` |

**Test baseline (main @ 741fcc53, captured 2026-08-06):** `npm test` → **2460 tests, 2458 pass, 0
fail, 2 skipped**, ~84s runtime. Use this as your pre-Task-21 baseline; any regression must be
explained, not absorbed.

Note: the plan file's own checkboxes (`- [ ]`) for Tasks 1–20 are **still unchecked in the plan
text** even though the work is implemented and merged — the checkboxes were never going back and
updated. Don't take checkbox state in this plan file as ground truth; the table in §2 below is.

---

## 2. What's done (Tasks 1–20, merged to `main`)

All of ingestion, storage, domain logic, inference, and projection rendering. Verified by direct
source inspection, not by trusting a prior session's self-report.

| Task | File(s) | Commit |
|---|---|---|
| 1 (migration v41) | `src/assistant/storage/schema.ts` | `7e12bfff` |
| 2 (row schemas) | `src/assistant/storage/rows.ts` | `7e12bfff` |
| 3 (ProjectionStore) | `src/assistant/storage/projection-store.ts` | `851cbb73` |
| 4 (JobStore) | `src/assistant/storage/job-store.ts` | `851cbb73` |
| 5 (Observation/CandidateStore) | `src/assistant/storage/observation-store.ts`, `candidate-store.ts` | `851cbb73` |
| 6 (SecretScanner) | `src/assistant/domain/secrets.ts` | `377a89fb` |
| 7 (staleness decay) | `src/assistant/domain/staleness.ts` | `377a89fb` |
| 8 (TokenCounter) | `src/assistant/domain/tokens.ts` | `377a89fb` |
| 9 (inference client) | `src/assistant/inference/client.ts` | `e6a0767d` |
| 10 (StructuredOutputRunner) | `src/assistant/inference/structured-runner.ts` | `e6a0767d` |
| 11 (IngestionEnvelope + pipeline) | `src/assistant/ingestion/envelope.ts`, `pipeline.ts` | `cb107012` |
| 12 (ConversationIngestor) | `src/assistant/ingestion/conversation-ingestor.ts` | `cb107012` |
| 13 (ConversationExtractor) | `src/assistant/ingestion/conversation-extractor.ts` | `7a20a554` |
| 14 (CandidateGate) | `src/assistant/ingestion/candidate-gate.ts` | `7a20a554` |
| 15 (CandidatePromoter) | `src/assistant/ingestion/candidate-promoter.ts` | `09837b4e` |
| 16 (Consolidator + resolution) | `src/assistant/ingestion/consolidator.ts` | `17b75652` |
| 17 (tier utility/routing) | `src/assistant/domain/tier-utility.ts` | `b3d7d432` |
| 18 (frontmatter + sentence rendering) | `src/assistant/projections/assertion-sentence.ts`, `frontmatter.ts` | `b8f1e715` |
| 19 (AssertionView + compilers) | `src/assistant/projections/assertion-view.ts`, `assertion-view-builder.ts`, `profile-compiler.ts`, `dossier-compiler.ts` | `b5b89aa6` |
| 20 (ProjectionCompiler) | `src/assistant/projections/projection-compiler.ts` | `b5b89aa6` |
| 21's job types (not the runner) | `src/assistant/jobs/job-types.ts` | `7e12bfff` |

**Also done, off-plan but load-bearing for Tasks 24/25:** a mid-gate refactor
(`docs/superpowers/plans/2026-08-05-explicit-assistant-transactions-and-token-trimming.md`, both
tasks complete):
- `src/assistant/transactions/assistant-transaction-manager.ts` — `AssistantTransactionManager`
  (LIFO nested scopes), wired into `AssistantGraph`, `AssertionService`, `NodeMergeService`.
  Commit `fdb77c80`.
- `src/assistant/projections/token-limit-enforcer.ts` — `TokenLimitEnforcer`, shared by
  `ProfileCompiler` and `DossierCompiler` via `ProjectionCompiler`. Commit `4dda2e89`.

Any Task 24/25 work that touches transactions or projection token limits should use these, not
reintroduce callback-based transactions or duplicate trimming logic.

---

## 3. What's not done (Tasks 21–26 — do these, in order)

Exact headings from `docs/superpowers/plans/2026-08-05-assistant-gate-b-conversational-memory.md`:

```
Line 6457  ## Task 21: AssistantJobRunner
Line 6882  ## Task 22: QueryIntentExtractor and MemoryRetriever
Line 7352  ## Task 23: `assistantMemory` preset flag
Line 7521  ## Task 24: AssistantService
Line 7856  ## Task 25: Chat seam and status-server integration
Line 8217  ## Task 26: Gate B end-to-end
```

Dependency order (from the original execution handoff, still valid):

```
21 AssistantJobRunner         (needs 13, 15, 16, 20 — all done)
22 retrieval                  (needs 18, 19 — both done)
23 assistantMemory flag       (touches contracts + dashboard; expect wide compile errors)
24 AssistantService           (needs everything above, incl. transaction manager, token enforcer)
25 chat seam + server wiring  (needs 24)
26 Gate B end-to-end
```

Missing source files, exact expected paths per the plan:

| File | Task |
|---|---|
| `src/assistant/jobs/job-runner.ts` (`AssistantJobRunner`) | 21 |
| `src/assistant/retrieval/query-intent.ts` (`QueryIntentExtractor`) | 22 |
| `src/assistant/retrieval/memory-retriever.ts` (`MemoryRetriever`) | 22 |
| `src/assistant/domain/ranking.ts` (`rankAssertion`) | 22 |
| `assistantMemory` field in `SiftPresetSchema` (`packages/contracts/src/config.ts`) + `src/preset-catalog.ts` | 23 |
| `src/assistant/assistant-service.ts` (`AssistantService`, composition root) | 24 |
| `src/status-server/chat-memory-seam.ts` (`ChatMemorySeam`) | 25 |
| `src/status-server/assistant-idle-gate.ts` (`StatusServerIdleGate`) | 25 |
| chat route wiring (`src/status-server/routes/chat.ts` or equivalent) | 25 |
| `tests/assistant-gate-b-e2e.test.ts` | 26 |

---

## 4. Task 23 will ripple

`SiftPresetSchema` is `.strict()` and `assistantMemory` will be a **required** field — every preset
literal in `src/` and `tests/` stops compiling until it declares it. That's intentional (no
defaults, no back-compat per repo policy) — don't add a default or an optional fallback to make the
red go away faster.

---

## 5. Judgement calls still open (from the original execution handoff, unresolved until you hit them)

- **`OWNER_PERSON_CANONICAL_KEY`.** Task 24 introduces it and asks you to collapse existing local
  copies in `ProjectionCompiler` and `AssertionViewBuilder` into one definition — move it to
  `src/assistant/storage/schema.ts` if an import cycle appears. Exactly one definition, not three.
- **`mockSiftConfig()` shape.** Tasks 24, 25, 26 assume it yields a config with a model id and a
  llama.cpp base URL. Backend is always faked in tests, so widen the fixture if
  `getConfiguredModel` returns empty rather than adding a real network path.
- **`ChatMessageKind`.** Task 25 selects the final answer message by `kind === 'answer'`; verify
  against the repo's actual kind name. Getting this wrong ingests thinking/tool output, which the
  design (§7.2) forbids.

---

## 6. How to execute

Repo-agent policy: one plan task per dispatch (batch 21 alone, 22 alone, etc. — these are larger
and more load-bearing than early Gate B tasks; don't batch multiple), strictly sequential, **one
attempt per task**. A failed or review-rejected run is finished by you in-session, never
re-dispatched. 15-minute timeout budget per `siftkit` invocation.

```
siftkit repo-agent 'Implement ONLY the section titled -- Task N: <heading> -- from docs/superpowers/plans/2026-08-05-assistant-gate-b-conversational-memory.md. Follow its steps verbatim, TDD. Do not run git commit, do not create temp files, do not create any other document, do not touch any other task. Report the exact pass/fail counts you actually observed.' --log-file <scratch>/task-N.log
```

Use `--` to delimit the heading, not `"` — PowerShell mangles embedded double quotes in the single
positional task string.

### Do not trust the sub-agent's self-report

Carried forward from Gate A (misreported test results on 6/9 dispatches, once claimed to have
written a file it hadn't):

1. Baseline is already captured above (2460/2458/0/2) — diff against it, don't re-derive from
   scratch unless you suspect drift.
2. Read `status` from the JSON line, never the exit code alone (`exit 0` covers both `completed`
   and `approval_required`).
3. Run `npm test` and `npm run lint` yourself after every dispatch.
4. Read the diff line by line; check `git status` for scope drift.
5. Scan for banned patterns: `x as T`, `any`, explicit `unknown`-laundering, non-null `!`,
   `import * as`, shims, duplicated code, functions passed as values.

---

## 7. Definition of done

The plan ends with a Gate B acceptance checklist (lines 8427–8446) mapping each §18 exit criterion
to the test file that proves it:

| §18 Gate B criterion | Proven by |
|---|---|
| A conversation creates graph assertions | `tests/assistant-gate-b-e2e.test.ts` test 1, step 1 |
| A correction supersedes the prior assertion | `tests/assistant-gate-b-e2e.test.ts` test 1, step 3; `tests/assistant-candidate-promoter.test.ts` |
| Projections regenerate deterministically from the graph | `tests/assistant-projection-compiler.test.ts` (byte-identical recompile, unchanged-rewrites-nothing) |
| Retrieval returns bounded, cited context into an opted-in preset | `tests/assistant-retrieval.test.ts`, `tests/assistant-gate-b-e2e.test.ts` test 1, step 4 |
| ...and nothing into an opted-out one | `tests/assistant-chat-seam.test.ts`, `tests/assistant-gate-b-e2e.test.ts` test 1 |
| SiftKit stays usable if the assistant fails to start | `tests/assistant-gate-b-e2e.test.ts` test 2 |
| A chat turn pays no model latency for memory | `tests/assistant-service.test.ts` ("without any model call") |
| Background work yields to interactive work | `tests/assistant-job-runner.test.ts` (preemption, busy host) |
| Ingestion is idempotent | `tests/assistant-gate-b-e2e.test.ts` test 3; `tests/assistant-ingestion-pipeline.test.ts` |
| No assistant request carries an image | `tests/assistant-inference-client.test.ts` |
| Sensitive content never reaches a projection or a prompt | `tests/assistant-projection-compiler.test.ts`, `tests/assistant-retrieval.test.ts` |
| Secrets are discarded with a non-content audit event | `tests/assistant-ingestion-pipeline.test.ts` |
| Migration v41 applies on fresh and existing databases | `tests/assistant-migration.test.ts` |

Verify each row by **running its named test file**, not by reading code.

When it's all green, write the Gate B → Gate C handoff recording any deviation from the plan text
(the way `2026-08-05-assistant-gate-a-handoff.md` §6 does). Do not start Gate C code, and do not
write the Gate C plan until Gate B is green and its diff reviewed.

---

## 8. Explicitly out of scope

- questions, `SiftConfig.Assistant`, `/assistant/*` routes, CLI, dashboard Assistant tab,
  `retrieval_usage`, the `query_intent_parser` / `question_planner` / `projection_summarizer`
  model roles (Gate C, v42);
- desktop capture, activity, Tauri shell, native keychain provider, blob envelopes (Gate D, v43);
- tier demotion and compaction, export, backup, restore, mobile envelope, soak test, §19.5
  performance benchmarks (Gate E).

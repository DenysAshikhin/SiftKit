# Handoff — SiftKit Assistant, Gate B planned → execute it

**Date:** 2026-08-05
**From:** Gate B planning session
**Branch:** `feat/assistant-gate-a-graph-foundation` @ `21e51423` — clean, **local only, not pushed, not merged**
**State:** Gate A green. Gate B **planned, not started.** No Gate B source file exists.

---

## 1. Where things stand

| | |
|---|---|
| Design | `assistant/2026-07-30-siftkit-assistant-design.md` |
| Gate A plan (done) | `docs/superpowers/plans/2026-08-05-assistant-gate-a-graph-foundation.md` |
| Gate A → B handoff | `docs/superpowers/handoffs/2026-08-05-assistant-gate-b-start-handoff.md` |
| **Gate B plan (execute this)** | `docs/superpowers/plans/2026-08-05-assistant-gate-b-conversational-memory.md` — 26 tasks, 8.4k lines |

The user's branch decision is **locked: stay on `feat/assistant-gate-a-graph-foundation`.** Do not
merge Gate A to `main`, do not open a PR, do not create a worktree. Gate A and Gate B integrate
together later.

Your job is to execute the 26 tasks in order. Everything below is context the plan file does not
repeat.

---

## 2. The user decision that reshaped Gate B

Asked whether retrieval should pay for a `query_intent_parser` model call, the user answered with a
broader architectural rule:

> anything that the model will be ingesting to build up and maintain memory of me (like chats,
> messages, screenshots) needs to go into a queue of some sort. Then when the gpu is idle *then* it
> starts going through the queue … resulting in virtually 0 delay

That is now the spine of the plan and is **not up for re-litigation**:

- A chat turn writes evidence rows and enqueues an `assistant_jobs` row. Constant time, no
  inference, no graph write.
- `AssistantJobRunner` drains that queue only while `isIdle(ctx)` holds, and abandons the in-flight
  model call the moment an interactive request arrives.
- Retrieval on the request path is deterministic — FTS + bounded graph expansion + a scoring
  formula. No model call.

Consequences, all recorded in the plan's "Corrections to the design spec" table:

- `assistant_jobs` ships in **Gate B (v41)**, not Gate C. Gate C still owns job priorities as
  configuration, question/screenshot job types, and the `/assistant/jobs` surface.
- `query_intent_parser` and `projection_summarizer` are deferred to Gate C. Gate B renders
  projections deterministically, which is exactly what §18's "projections regenerate
  deterministically from the graph" asks for.
- `retrieval_usage` stays in Gate C (v42); Gate B uses the `memory_projections` retrieval columns.

---

## 3. Migration numbering (the design is wrong here)

`CURRENT_SCHEMA_VERSION` in `src/state/runtime-db.ts` reads **40** today. Gate A consumed v39 and
v40.

| Gate | Step |
|---|---|
| **B** (`memory_projections`, `assistant_jobs`, projections FTS) | **v41** |
| C (questions, feedback, retrieval_usage) | v42 |
| D (activity, capture) | v43 |

Both the ladder block **and** the `currentVersion <= 0` fresh-database branch in `ensureSchema`
must apply the new SQL. Gate A shipped that bug once already; Task 1 Step 5 covers both paths.

---

## 4. A real Gate A gap this plan discovered and fixes

**`EvidenceStore.recordTextEvidence` hashes the text and throws the text away.** `evidence_records`
has no text column — by design, since §4.7 says raw evidence lives encrypted in `evidence_blobs` —
but Gate A never wrote a blob for text evidence. Nothing read evidence back in Gate A, so it went
unnoticed.

Deferred extraction *must* read it back. **Task 11, Step 3** routes text through the same encrypted
blob path as binary evidence and adds `readTextContent(evidence)`. Expect to fix any existing test
in `tests/assistant-evidence-store.test.ts` that asserted `blob_id === null` for text evidence —
the old behaviour was the bug.

Other Gate A shapes verified while planning, so you do not have to re-check them:

- `UnresolvedNodeRef` is `{ nodeType, displayName }` — **no `kind` field**. `CandidateObjectRef`
  does discriminate on `kind`.
- `candidate_assertions.predicate` has a foreign key to `graph_relation_types(name)`, so an
  unregistered predicate can never become a row. It is dropped at the extractor's zod boundary.
- `EVIDENCE_SOURCE_TYPES` uses `conversation_message`, not `chat_message`.
- The assertion row's timestamp column is `last_observed_at_utc`.
- `IdPrefix` in `src/assistant/ids.ts` is a closed union and must gain
  `'obs' | 'cand' | 'memproj' | 'job'` (Task 2, Step 5).
- `FixedClock` already has `advanceSeconds` / `advanceDays`.
- `parseJsonText(text, schema)` takes the schema as its second argument.
- zod is 4.4.3, so `z.toJSONSchema(schema)` exists.

---

## 5. Task order and what depends on what

Tasks are strictly ordered; later ones import earlier ones.

```
1  migration v41            ─┐
2  row schemas + job types   │ storage floor
3  ProjectionStore           │
4  JobStore                  │
5  Observation/CandidateStore┘
6  SecretScanner            ─┐
7  staleness → confidence    │ pure domain
8  token counters            │
17 tier utility              │
18 frontmatter + sentence   ─┘
9  inference client         ─┐ model boundary
10 structured runner        ─┘
11 envelope + pipeline      ─┐
12 ConversationIngestor      │ ingestion
13 ConversationExtractor     │
14 CandidateGate             │
15 CandidatePromoter         │
16 Consolidator + resolver 5┘
19 view + compilers         ─┐ projections
20 ProjectionCompiler       ─┘
21 AssistantJobRunner         (needs 13, 15, 16, 20)
22 retrieval                  (needs 18, 19)
23 assistantMemory flag       (touches contracts + dashboard; expect wide compile errors)
24 AssistantService           (needs everything above)
25 chat seam + server wiring  (needs 24)
26 Gate B end-to-end
```

Task 23 is the one that ripples: `SiftPresetSchema` is `.strict()` and the new field is
**required**, so every preset literal in `src/` and `tests/` stops compiling until it declares
`assistantMemory`. That is intended — no defaults, no back-compat.

---

## 6. How to execute

Per the repo's repo-agent policy: batch **1–3 plan tasks per dispatch**, strictly sequential,
**one attempt per task**. A failed or review-rejected run is finished by you in-session, never
re-dispatched. 15-minute timeout budget per siftkit invocation.

Suggested batching — small, tightly coupled tasks together; anything touching the status server or
the dashboard alone:

`1-2` · `3-5` · `6-8` · `9-10` · `11-12` · `13-14` · `15-16` · `17-18` · `19-20` · `21` · `22` ·
`23` · `24` · `25` · `26`

### Dispatch shape

```
siftkit repo-agent 'Implement ONLY the section titled -- Task N: <heading> -- from docs/superpowers/plans/2026-08-05-assistant-gate-b-conversational-memory.md. Follow its steps verbatim, TDD. Do not run git commit, do not create temp files, do not create any other document, do not touch any other task. Report the exact pass/fail counts you actually observed.' --log-file <scratch>/task-N.log
```

The CLI takes exactly one positional task string and PowerShell mangles embedded double quotes, so
delimit headings with `--`, not with `"`. Commit yourself after reviewing; never let the agent
commit.

### Do not trust the sub-agent's self-report

Carried forward from Gate A, where it misreported test results on 6 of 9 dispatches — repeatedly
inventing "28 pre-existing failures" against a suite that was at 0 — and once claimed to have
written a file it had not.

1. Take a **full `npm test` baseline before task 1** and record the number.
2. Read `status` from the JSON line, never the exit code (exit 0 covers both `completed` and
   `approval_required`).
3. Run `npm test` and `npm run lint` **yourself** after every dispatch.
4. Read the diff line by line; check `git status` for scope drift — one Gate A dispatch invented an
   unrelated plan document.
5. Scan for banned patterns: `x as T`, `any`, explicit `unknown`, non-null `!`, `import * as`,
   shims, duplicated code, functions passed as values.

---

## 7. Things the plan deliberately leaves as judgement calls

Each is marked in place; none blocks a task.

- **Test stubs.** Four task test files open with a deliberately-unused helper stub
  (`buildPipeline`, `recordEvidence`, `seedCandidate`, `buildRunner`, `seedGraph`) that the step
  text tells you to delete before running. If a dispatch leaves one in, delete it during review.
- **`mockSiftConfig()` shape.** Tasks 9, 24, 25, 26 assume it yields a config with a model id and a
  llama.cpp base URL. The backend is always a fake in those tests, so no network call happens
  either way — widen the fixture if `getConfiguredModel` returns empty.
- **`OWNER_PERSON_CANONICAL_KEY`.** Task 24 introduces it and tells you to collapse the local
  copies in `ProjectionCompiler` and `AssertionViewBuilder` into one definition, moving it to
  `src/assistant/storage/schema.ts` if an import cycle appears. There must be exactly one.
- **`ChatMessageKind`.** Task 25 selects the final answer message by `kind === 'answer'`; use the
  repo's actual kind name if it differs. Getting this wrong would ingest thinking or tool output,
  which §7.2 forbids.

---

## 8. Definition of done

`docs/superpowers/plans/2026-08-05-assistant-gate-b-conversational-memory.md` ends with a **Gate B
acceptance checklist** mapping each §18 exit criterion to the test file that proves it. Verify each
row by running its named test file, not by reading code — that is how Gate A was signed off.

When it is all green, write the Gate B → Gate C handoff and record any deviation from the plan
text, the way `2026-08-05-assistant-gate-a-handoff.md` §6 does. Do not start Gate C code, and do
not write the Gate C plan until Gate B is green and its diff reviewed.

---

## 9. Explicitly out of scope

- questions, `SiftConfig.Assistant`, `/assistant/*` routes, CLI, dashboard Assistant tab,
  `retrieval_usage`, the `query_intent_parser` / `question_planner` / `projection_summarizer`
  roles (Gate C, v42);
- desktop capture, activity, Tauri shell, native keychain provider, blob envelopes (Gate D, v43);
- tier demotion and compaction, export, backup, restore, mobile envelope, soak test, §19.5
  performance benchmarks (Gate E).

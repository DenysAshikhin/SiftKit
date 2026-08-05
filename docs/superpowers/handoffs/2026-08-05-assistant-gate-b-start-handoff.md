# Handoff — SiftKit Assistant, Gate A complete → start Gate B

**Date:** 2026-08-05
**From:** Gate A execution session
**Branch:** `feat/assistant-gate-a-graph-foundation` @ `baf0cabb` — clean, **not merged, not pushed**
**State:** Gate A implemented, reviewed, and green. Gate B not started, **not planned**.

---

## 1. Why you are here

The design (`assistant/2026-07-30-siftkit-assistant-design.md`) mandates **one gate, one plan**,
written only after the previous gate is green and its diff reviewed. Gate A is now green and
reviewed. Your job is therefore:

1. Decide what happens to the Gate A branch (§6 below) — it is still local.
2. Write the **Gate B plan** (§4), then execute it.

Do not start Gate B code before the plan exists. Do not write plans for Gates C–E.

---

## 2. What Gate A delivered (the ground you build on)

The provenance-aware temporal knowledge graph, with nothing user-facing wired up.

**23 source files under `src/assistant/`:**

| Area | Files |
|---|---|
| `domain/` (pure, no I/O) | `enums.ts`, `node-types.ts` (28 types), `relation-types.ts` (38 predicates), `keys.ts`, `confidence.ts` |
| infrastructure | `clock.ts` (`Clock`/`SystemClock`/`FixedClock`), `ids.ts` (`IdGenerator`/`RandomIdGenerator`/`SequentialIdGenerator`) |
| `crypto/` | `key-provider.ts` (`AssistantKeyProvider`, `FileKeyProvider`), `blob-cipher.ts` (`BlobCipher`, AES-256-GCM) |
| `storage/` (**the only place SQL lives**) | `schema.ts`, `rows.ts`, `identity-store.ts`, `audit-store.ts`, `node-store.ts`, `assertion-store.ts`, `evidence-store.ts`, `policy-store.ts` |
| `graph/` (**no SQL, no `better-sqlite3` import**) | `validation.ts`, `assertion-service.ts`, `entity-resolver.ts`, `merge-service.ts`, `neighborhood.ts` |
| composition | `assistant-graph.ts` (`AssistantGraph` — owns every store and service) |

**Verification at handoff:** `npm test` = 2326 tests, **0 failures**, 2 skipped. `npm run lint` clean.
130 assistant tests across 12 files. Every row of the plan's Gate A acceptance checklist was
verified by running its named test file, not by inspection.

**Commits:** 18 task commits (one per plan task) + 2 docs commits.

---

## 3. Five things that differ from the written plan — read before planning Gate B

The Gate A plan text is now **stale in five places**. Where plan and code disagree, **the code is
authoritative.** These are recorded in `2026-08-05-assistant-gate-a-handoff.md` §6 as well.

1. **`FileKeyProvider`, not `RuntimeMetadataKeyProvider`.** The user rejected storing the AES-256
   evidence key in `runtime_metadata`. It lives in a `0600` file at
   `<runtimeRoot>/assistant/keys.json`, outside the runtime database, so a stolen database alone
   cannot decrypt blobs. `AssistantKeyProvider` is the interface; Gate D adds the OS-keychain
   implementation as a *second* one, not a replacement.
2. **`ensureSchema`'s fresh-database branch also applies the assistant schema.** The plan only
   patched the migration ladder, which would have left a brand-new database reporting v40 with no
   assistant tables. Both paths now call `applyAssistantCoreSchema`.
3. **`BlobCipher.encrypt` returns `{ envelope, keyId }`** so `evidence_blobs.key_id` is populated.
   Relevant to you only if Gate B touches evidence; it matters for Gate D key rotation.
4. **`AssertionValidator.validate` returns the narrowed predicate on success**
   (`{ ok: true; predicate: RelationType }`), and `AssertionService`'s write paths take a
   `ValidatedAssertRequest`. **This is the API you will call from Gate B's candidate pipeline.**
5. **`NodeMergeService`** raises loud errors on corrupt rows instead of `??`-falling back.

---

## 4. Gate B — scope, and the numbering trap

Source of truth: design **§18 Gate B** (lines 1767–1775). Specified by §3, §5.4, §7.2, §8.4, §10.3,
§10.4, §11, §11.1.

**Deliverables:**

- Chat ingestion pipeline (§7.2)
- `candidate_consolidator` inference role (§8.4) — proposal-only. It *may* suggest duplicates,
  entity matches, patterns, question topics. It *may not* merge, delete, write assertions, alter
  policy, or confirm sensitive inferences. Deterministic code enforces every mutation.
- `memory_projections` table (§5.4, design line 631)
- Tier 1/2/3 `ProjectionCompiler` (§10.3)
- `MemoryRetriever` (§11)
- `assistantMemory` flag on `SiftPreset` (§11.1)
- `AssistantService` composition + status-server integration (§3, design line 101)

**Exit criteria (§18, lines 1772–1775):** a conversation creates graph assertions; a correction
supersedes the prior assertion; projections regenerate deterministically from the graph; retrieval
returns bounded, cited context into an opted-in preset and **nothing** into an opted-out one;
SiftKit stays fully usable if the assistant fails to start.

### ⚠️ Migration numbering — the design is wrong here

The design says Gate B is **v39**. It is not. `CURRENT_SCHEMA_VERSION` in
`src/state/runtime-db.ts` now reads **40**; Gate A consumed v39 (tables + registry seeding) and v40
(FTS5). Every later gate shifts by two:

| Gate | Migration step |
|---|---|
| B (`memory_projections`) | **v41** |
| C (questions, jobs, retrieval) | v42 |
| D (activity, capture) | v43 |

Append your block after the `if (currentVersion < 40)` block in `ensureSchema`, and remember
finding 2 above: **the fresh-database branch needs the same treatment.**

### Two deferrals Gate A made that land in Gate B

- **Entity resolution step 5** (§9.1, "model-suggested match above a deterministic score
  threshold") was not implemented — no model call existed in Gate A. `EntityResolver` ships steps
  1–4, 6, 7. Step 5 arrives with `candidate_consolidator`. Wire it into
  `src/assistant/graph/entity-resolver.ts` rather than creating a parallel resolver.
- **The staleness function** in the confidence pipeline was deferred, because its decay classes are
  defined only by the §10.4 Tier-routing table (Gate B work). `resolveConfidence` in
  `src/assistant/domain/confidence.ts` currently does aggregation → basis ceiling →
  single-screenshot clamp → contradiction penalty → explicit-user override. Add staleness there;
  do not add a second confidence function. §10.4 also gives the `tierUtility` formula you need for
  the compilers.

---

## 5. How to work

### Repo constraints that will bite you

Verified against the current tree:

- **ESLint is a hard gate.** Banned repo-wide: type-assertion casts (`x as T`, `<T>x`), `any`,
  explicit `unknown` (`TSUnknownKeyword`), non-null `!`, namespace imports, unused vars,
  `__dirname`/`__filename` in `src/**`, and broad `JsonValue` unions. `npm run typecheck` runs
  `npm run lint` last.
- **NodeNext ESM** — every relative import ends in `.js`. Import zod from `src/lib/zod.js`, never
  `'zod'`, inside `src/`.
- **Parse boundaries with zod, type via `z.infer`.** Use the existing helpers in `src/lib/json.ts`
  (`parseJsonText`, `parseJsonValueText`, `parseJsonObjectText`) — do not hand-roll `JSON.parse`
  plumbing.
- **Tests:** `node:test`, `tests/*.test.ts`. `npm test` = typecheck + build + run;
  `npm test -- <substring>` filters. Use `withAssistantContext()` from
  `tests/helpers/assistant-fixture.ts` — it builds an isolated temp runtime DB, a `FixedClock`, a
  `SequentialIdGenerator`, a wired `AssistantGraph`, and always closes the DB in a `finally`.
- **No back-compat, no shims.** Refactors are complete; missed callers should fail loud.
- SQL stays in `storage/`. Decision logic stays in `graph/` and calls stores. Keep it that way for
  projections and retrieval.

### Delegation

Per the repo's repo-agent policy, batch **1–3 plan tasks per dispatch**, strictly sequential,
**one attempt per task** — a failed or review-rejected run is finished in-session, never
re-dispatched. 15-minute timeout budget per siftkit invocation.

**Hard-won lesson from Gate A: do not trust the sub-agent's self-report.** Across 9 dispatches it
misreported test results on 6 of them — repeatedly claiming "28 pre-existing failures in
runtime-planner-mode and summary-cli" when the suite baseline was 0 failures and stayed at 0. It
also reported a dispatch as clean that had left a lint error. Conversely it once silently failed to
write a file it claimed to have written. So:

- Take a **full `npm test` baseline before you start**, so you can tell a real regression from a
  fabricated one.
- Read `status` from the JSON line, never the exit code alone (exit 0 covers both `completed` and
  `approval_required`).
- Run the tests and the lint **yourself** after every dispatch, and read the diff line by line.
- Check `git status` for scope drift — one Gate A dispatch invented an unrelated plan document.

### Dispatch shape

```
siftkit repo-agent 'Implement ONLY the section titled -- Task N: <heading> -- from <plan path>. Follow its steps verbatim, TDD. Do not run git commit, do not create temp files, do not create any other document, do not touch any other task. Report the exact pass/fail counts you actually observed.' --log-file <scratch>/task-N.log
```

Note: the CLI takes exactly one positional task string, and PowerShell mangles embedded double
quotes — quote headings with `--` delimiters as above, not with `"`. Commit yourself after
reviewing; do not let the agent commit.

---

## 6. Decide first: what happens to the Gate A branch

`feat/assistant-gate-a-graph-foundation` is **local only** — 20 commits ahead of `main`, nothing
pushed, no PR. Gate B builds directly on it. Ask the user which they want before writing Gate B
code:

- merge to `main` first and branch Gate B off `main`; or
- open a PR and wait for review; or
- branch Gate B off the Gate A branch and integrate both together later.

Nothing in Gate A forecloses any of these.

---

## 7. Open items Gate A did not resolve

- **Gate D scope question (design §22.2).** Accessibility-tree text is obtainable without capturing
  pixels; Gate D may ship activity + accessibility text only and defer capture to the vision
  design. Nothing in Gate A forecloses either choice — the evidence store handles text and blobs.
- **Performance targets (§19.5) are unmeasured.** No Gate A task claims them, deliberately: the
  design says record measured results, do not claim unmeasured performance. A benchmark task
  belongs in Gate E.
- **`FileKeyProvider` protects against database theft, not filesystem access.** The honest-storage
  statement in the Gate C UI must say exactly that, and must not describe the database itself as
  encrypted at rest.

---

## 8. Explicitly out of scope for Gate B

Do not scope-creep into these; each has its own gate and its own plan:

- questions, jobs, `SiftConfig.Assistant`, `/assistant/*` routes, CLI, dashboard (Gate C, v42);
- desktop capture, activity, Tauri shell, native keychain provider (Gate D, v43);
- export, backup, restore, mobile envelope (Gate E).

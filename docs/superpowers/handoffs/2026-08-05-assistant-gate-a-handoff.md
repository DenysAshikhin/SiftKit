# Handoff — SiftKit Assistant, Gate A

**Date:** 2026-08-05
**From:** planning session (no code written)
**State:** design read, Gate A implementation plan written and reviewed. **Zero source files changed.**
**Branch:** `fix/turn-tool-budget-share` (clean at handoff; unrelated to this work — branch off `main` before starting)

---

## 1. What exists

| Artifact | Path | Status |
|---|---|---|
| Approved design (all five gates) | `assistant/2026-07-30-siftkit-assistant-design.md` | Unchanged. Authoritative for scope. |
| Superseded v3 master plan | `assistant/2026-07-30-siftkit-graph-personal-assistant-master-plan-v3.md` | Ignore. §2.2 of the design enumerates every disagreement. |
| **Gate A implementation plan** | `docs/superpowers/plans/2026-08-05-assistant-gate-a-graph-foundation.md` | **New. 18 tasks, 98 checkbox steps, complete code in every step.** |
| Gate B–E plans | — | Not written. Design mandates each is written only after the previous gate is green. |

Nothing else was touched. `git status` should show only the plan file and this handoff as new files.

---

## 2. What Gate A delivers

The provenance-aware temporal knowledge graph and nothing user-facing:

- `src/assistant/domain/` — node/relation registries, enums, derived keys, confidence rules
- `src/assistant/clock.ts`, `src/assistant/ids.ts` — injected determinism
- `src/assistant/crypto/` — AES-256-GCM blob envelope + key provider
- `src/assistant/storage/` — the only place SQL lives (8 files)
- `src/assistant/graph/` — validation, assertion service, entity resolution, merge, traversal
- `src/assistant/assistant-graph.ts` — composition root
- Migration steps **v39** (tables + registry seeding) and **v40** (FTS5), raising
  `CURRENT_SCHEMA_VERSION` from 38 to 40
- 11 new test files under `tests/`

Explicitly **not** in Gate A: projections, chat ingestion, retrieval, the preset flag, config,
HTTP routes, CLI, dashboard, jobs, questions, Tauri, capture, export/backup. The plan's closing
section lists these so nobody scope-creeps into them.

---

## 3. Four decisions I made that deviate from the design — read these first

These are locked in the plan's "Corrections to the design spec" table. If you disagree, raise it
before Task 1, not mid-execution.

1. **Migration numbering.** The design says assistant tables are v37/v38. `CURRENT_SCHEMA_VERSION`
   in `src/state/runtime-db.ts:37` already reads **38** — v37 and v38 are
   `migrateChatSessionsToModelPresetSnapshot` and `migrateRunLogsBackendToEngineIds`. Gate A takes
   **v39 and v40**. Every later gate shifts by two: B = v41, C = v42, D = v43.

2. **Encryption key location.** The design puts the evidence key in the OS keychain, but the
   keychain arrives with the Tauri shell in Gate D. Gate A defines an `AssistantKeyProvider`
   interface and ships `RuntimeMetadataKeyProvider`, which stores the key in `runtime_metadata`.
   Gate D adds the native provider as a *second* implementation, not a replacement. This is a real
   fallback (the assistant must work with no desktop shell, design §20.4), not a shim. The
   limitation is documented in the class doc comment and must be stated honestly in the Gate C UI.

3. **Entity resolution step 5 is not implemented.** §9.1 step 5 is "model-suggested match above a
   deterministic score threshold". There is no model call in Gate A, so the branch would be dead
   code. Steps 1–4, 6, 7 ship; step 5 arrives with `candidate_consolidator` in Gate B.

4. **`HAS_CONSTRAINT` descriptor changed.** The design's relation table does not fix a conflict
   strategy per predicate. Two incompatible explicit constraints are exactly the §9.3 row-four case,
   so the plan sets `cardinality: 'single_per_scope'` and `conflictStrategy: 'mark_disputed'` and
   uses that predicate to test the disputed path. Tasks 2 and 14 are consistent on this.

One further simplification, noted in the plan: the confidence pipeline in Gate A is
aggregation → basis ceiling → contradiction penalty → explicit-user override. The **staleness
function is deferred to Gate B**, because its decay classes are defined only by the Tier-routing
table (§10.4), which is Gate B work.

---

## 4. Repo constraints that will bite you

Verified against the current tree, not assumed:

- **ESLint is a hard gate** (`eslint.config.mjs`, ratchet list is empty). Banned repo-wide:
  type-assertion casts (`x as T`, `<T>x`), `any`, **explicit `unknown`** (`TSUnknownKeyword` is a
  `no-restricted-syntax` error), namespace imports, unused vars, and `__dirname`/`__filename` in
  `src/**`. `npm run typecheck` runs `npm run lint` as its last step.
- **Broad `JsonValue` unions are banned too** — parse boundary input into a schema-derived DTO.
  `src/lib/json-types.ts` gives you `JsonObject`, `JsonValue`, and `isJsonObject`.
- **NodeNext ESM.** Every relative import ends in `.js`. `src/package.json` is `type: module`.
- **Import zod from `src/lib/zod.js`**, not from `'zod'` directly, inside `src/`.
- **Tests:** `node:test`, files are `tests/*.test.ts`. `npm test` = typecheck + build + run.
  `npm test -- <substring>` runs only matching files. Isolate databases with
  `createManagedTempDir()` from `tests/helpers/temp-dirs.ts` and always
  `closeRuntimeDatabase()` in a `finally` — the plan's fixture does both.
- **FTS5 is available**: verified `better-sqlite3` 12.x bundles SQLite 3.51.3 with FTS5 compiled in.
- No `uuid`/`nanoid` dependency; use `randomUUID` from `node:crypto`. No existing clock, DI, or
  crypto abstraction — Gate A introduces all three.

---

## 5. How to execute

Per the repo's repo-agent policy, and the user's instruction to batch 1–3 tasks per dispatch:

```
siftkit repo-agent 'Implement ONLY "Task N: <heading>" from docs/superpowers/plans/2026-08-05-assistant-gate-a-graph-foundation.md. Follow its steps verbatim, TDD. Do not commit, do not create temp files, do not touch other tasks.' --log-file <scratch>/task-N.log
```

Rules that are not negotiable:

- **Strictly sequential.** Never dispatch task N+1 while N is in flight.
- **One attempt per task.** A `failed`/`aborted`/review-rejected run is finished in-session by you,
  never re-dispatched.
- **Read `status` from the JSON line, not the exit code.** Exit 0 covers both `completed` and
  `approval_required`.
- **Review every diff yourself** and run the tests yourself. Never accept the agent's success claim.
- 15-minute timeout budget per siftkit invocation.

### Suggested batching

| Dispatch | Tasks | Why grouped |
|---|---|---|
| 1 | 1–2 | Pure data: enums + registries, one shared test file |
| 2 | 3–5 | Pure functions: clock/ids, derived keys, confidence |
| 3 | 6–7 | Schema module + the two migration steps. **Highest-risk dispatch** — see below |
| 4 | 8–9 | Row schemas, identity/audit stores, node store |
| 5 | 10–11 | Assertion store, then crypto + evidence store |
| 6 | 12–13 | Policy store, validator |
| 7 | 14 | Assertion service — alone. Densest logic in the gate |
| 8 | 15–16 | Entity resolver, merge service |
| 9 | 17–18 | Traversal, then composition + E2E |

Dispatch 3 is the one to watch: it raises `CURRENT_SCHEMA_VERSION` and therefore touches every
database test in the suite. Run the **full** `npm test` after it, not just the assistant files.
`tests/config-no-top-level-backend.test.ts` asserts against the constant symbolically and should
follow the bump; if anything hardcodes `38`, change it to `CURRENT_SCHEMA_VERSION`.

Dispatch 7 is the one to review hardest. `AssertionService` is where §9.3's conflict table, the
explicit-over-passive rule, the graph-version increment, and the mutation log all meet. Read the
diff line by line rather than trusting green tests.

---

## 6. Definition of done for Gate A

- `npm test` green, `npm run typecheck` green (which includes `npm run lint`).
- The plan's **Gate A acceptance checklist** (final section) verified by *running* each named test
  file and reading its output — not by inspection.
- 18 commits, one per task, following the messages in the plan.

Then, and only then, write the Gate B plan. The design is explicit: one gate, one plan, written
after the previous gate is green and its diff reviewed.

### Execution record (2026-08-05) — met

Branch `feat/assistant-gate-a-graph-foundation`, 18 task commits plus one plan-amendment commit.
`npm test` 2326 tests / 0 failures / 2 skipped; `npm run lint` clean. Every acceptance-checklist
file was run on its own and its named tests read.

Five deviations from the plan text were made during execution. **The code, not the plan, is
authoritative where they disagree:**

1. **`FileKeyProvider` replaces `RuntimeMetadataKeyProvider`** (user decision, §7 above).
2. **`ensureSchema`'s fresh-database branch** also applies the assistant schema. The plan only
   patched the migration ladder, so a brand-new database would have reported v40 with no assistant
   tables. It reuses `applyAssistantCoreSchema` rather than duplicating the seed.
3. **`BlobCipher.encrypt` returns `{ envelope, keyId }`.** The plan inserted `evidence_blobs.key_id`
   as a literal `NULL` while setting `encrypted = 1`, leaving the column permanently dead and
   Gate D unable to find blobs sealed with a rotated key without opening every file.
4. **`AssertionValidator.validate` returns the narrowed predicate on success**, and
   `AssertionService` threads a `ValidatedAssertRequest` through every write path. The plan's
   version re-tested `isRelationType` on branches the validator had already made unreachable, and
   fell back to writing predicate `'RELATED_TO'` — silently recording a *different fact* than the
   one proposed.
5. **`NodeMergeService`**: dropped the unreachable `findLiveCollision` helper and replaced the `??`
   fallbacks in the prospective-key computation with loud errors, for the same reason as (4).

Also corrected, without changing behaviour: four duplicated inline count/metadata row schemas now
use the `CountRowSchema` / `MetadataValueRowSchema` exports the plan already declared in `rows.ts`.

---

## 7. Open items I did not resolve

- **Gate D scope question (design §22.2).** Accessibility-tree text is obtainable without capturing
  pixels. Gate D may ship activity + accessibility text only and defer capture to the vision design.
  Nothing in Gate A forecloses either choice — the evidence store handles both text and blobs.
- ~~**`RuntimeMetadataKeyProvider` security posture.**~~ **Resolved 2026-08-05 by the user before
  Task 1.** Storing the key in `runtime_metadata` was rejected. Gate A ships **`FileKeyProvider`**
  instead: the AES-256 key lives in a `0600` file at `<runtimeRoot>/assistant/keys.json`, outside
  the runtime database, so a stolen database alone does not decrypt evidence blobs. The
  `AssistantKeyProvider` interface, `BlobCipher`, and the evidence store are unchanged; Gate D still
  adds the OS-keychain provider as a second implementation. Task 11 and the Task 18 fixture in the
  plan have been amended accordingly.
- **Performance targets (§19.5)** are not measured anywhere in Gate A. The design says "record
  measured results, do not claim unmeasured performance." No task in this plan claims them. A
  benchmark task belongs in Gate E.

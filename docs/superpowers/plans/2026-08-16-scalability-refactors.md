# SiftKit Scalability Refactors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate every finding from the 2026-08-16 scalability analysis: unbounded-growth data paths, the five structural hotspots (migration monolith, `routes/core.ts` grab-bag, double-routed assistant routes, `ServerContext` god object, `AssistantService` facade), whole-archive-in-RAM backup/restore, and repo hygiene debt.

**Architecture:** All changes are behavior-preserving refactors or bounded-growth fixes inside the existing status-server + assistant subsystem. No new dependencies. SQLite stays synchronous better-sqlite3; archives move from in-memory `Buffer` assembly to temp-file streaming using the existing dependency-free zip format.

**Tech Stack:** TypeScript (strict, zod-validated IO), better-sqlite3, node:test via `npm run test`, ESLint.

---

## Ground rules for the implementing engineer

- **Commands:** After editing `src/` or `tests/`, tests need a rebuild: `npm run build:test && npm run test -- <filter>`. The filter is a positional substring of the test file name (see `test:formatron` in package.json for the pattern). Full gates: `npm run typecheck` (also runs lint at the end) and `npm run test` (full suite, ~60 s, expect 0 fail / 2 skipped baseline).
- **Commits:** One commit per task as written. **Confirm with the user before the first commit** — the session rules say "do not commit unless requested"; treat plan approval as that request only if the user says so.
- **Repo conventions (from CLAUDE.md):** no `any`, no type assertions, no non-null `!`, parse IO with zod, `z.infer` for derived types. Match surrounding comment density. Refactors are complete replacements — no compatibility shims, no parallel old/new paths.
- **Baseline before starting:** `git status` clean, `npm run typecheck` clean, `npm run test` green (3058 pass / 2 skip as of 2026-08-16).

---

## Phase A — Quick wins (bounded growth, small diffs)

### Task 1: Repo hygiene — remove junk files, fix mojibake and stale comments

**Files:**
- Delete (tracked): `"c:tmprsxlast_repo_search.json"`, `"c:tmprsxwf.mjs"` (names contain U+F03A after `c`), `deterministic-repro.js`, `initialTurnChatIssues.md`, `tmp-confirm-web-context.ts`, `siftkit-0.1.0.tgz`
- Modify: `.gitignore`
- Modify: `src/assistant/assistant-service.ts`, `src/assistant/domain/ranking.ts`, `src/assistant/jobs/job-runner.ts`, `src/assistant/retrieval/memory-retriever.ts`, `src/assistant/retrieval/query-intent.ts`, `src/status-server/chat-memory-seam.ts` (mojibake), plus any other hits found by the grep below
- Modify: `src/status-server/routes/assistant.ts:514` (missing `return`)

- [ ] **Step 1: Confirm the junk files are not referenced anywhere**

Run: `git grep -l "deterministic-repro\|initialTurnChatIssues\|tmp-confirm-web-context" -- ':!docs'`
Expected: no output (or only the files themselves). If a script references one, stop and report instead of deleting.

- [ ] **Step 2: Delete tracked junk**

```bash
git rm "c$(printf '')tmprsxlast_repo_search.json" "c$(printf '')tmprsxwf.mjs" || git rm 'c*tmprsx*'
git rm deterministic-repro.js initialTurnChatIssues.md tmp-confirm-web-context.ts siftkit-0.1.0.tgz
```

(If the `` names resist the shell, use `git ls-files -z | ...` or delete via `git rm` with the exact bytes shown by `git ls-files`; verify with `git status` that exactly six deletions are staged.)

- [ ] **Step 3: Add `.gitignore` entries**

Append to `.gitignore`:

```gitignore
*.tgz
/tmp/
tmp-*.ts
```

- [ ] **Step 4: Fix mojibake repo-wide**

Run: `git grep -n "Â§\|â€”\|â€"` — in every hit inside `src/`, replace `Â§` with `§` and `â€”` with `—`. Known files: the six listed above. These are comment-only edits; touch nothing else on those lines.

- [ ] **Step 5: Fix the wrong doc comment on `JOB_LEASE_SECONDS`**

In `src/assistant/assistant-service.ts` (currently lines 131-132), replace:

```ts
/** How much of the chat prompt memory may consume (§11). */
const JOB_LEASE_SECONDS = 300;
```

with:

```ts
/** How long a claimed background job may run before its lease expires and it is re-queued. */
const JOB_LEASE_SECONDS = 300;
```

- [ ] **Step 6: Add the missing `return` in the `/assistant/history` branch**

In `src/status-server/routes/assistant.ts:510-514`, add `return;` after the `sendJson` call so the branch matches every other branch:

```ts
    if (pathname === '/assistant/history') {
      sendJson(res, 200, { items: service.memoryQueries.listMemoryHistory(service.ownerId, {
        limit: integerParam(url, 'limit', 100), offset: integerParam(url, 'offset', 0),
      }) });
      return;
    }
```

- [ ] **Step 7: Verify and commit**

Run: `npm run typecheck` → clean. Run: `npm run build:test && npm run test 2>&1 | tail -8` → 0 fail.

```bash
git add -A
git commit -m "chore: remove tracked junk files, fix mojibake comments and missing route return"
```

---

### Task 2: `status()` counts via COUNT(*) instead of materializing full tables

`AssistantService.status()` currently calls `listPending(...).length` and `listValidationQueue(...).length` (`src/assistant/assistant-service.ts:345-348`), which run unbounded `SELECT *` with per-row zod parses on every tray poll.

**Files:**
- Modify: `src/assistant/storage/question-store.ts` (after `listPending`, ~line 95)
- Modify: `src/assistant/storage/candidate-store.ts` (after `listValidationQueue`, ~line 109)
- Modify: `src/assistant/assistant-service.ts:340-350`
- Test: `tests/assistant-question-store.test.ts`, `tests/assistant-candidate-store.test.ts`

- [ ] **Step 1: Write failing tests**

In `tests/assistant-question-store.test.ts`, alongside the existing `listPending` tests (reuse that file's setup helpers for creating a store and inserting questions — follow the local pattern exactly):

```ts
test('countPending matches listPending length', () => {
  // arrange: insert 2 pending-status questions and 1 answered question using the file's helpers
  assert.equal(store.countPending(ownerId), store.listPending(ownerId).length);
  assert.equal(store.countPending(ownerId), 2);
});
```

In `tests/assistant-candidate-store.test.ts`:

```ts
test('countValidationQueue matches listValidationQueue length', () => {
  // arrange: insert one 'pending', one 'needs_confirmation', one 'accepted' candidate
  assert.equal(store.countValidationQueue(ownerId), 2);
  assert.equal(store.countValidationQueue(ownerId), store.listValidationQueue(ownerId).length);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build:test && npm run test -- assistant-question-store`
Expected: FAIL — `countPending is not a function`. Same for `assistant-candidate-store`.

- [ ] **Step 3: Implement the count methods**

`src/assistant/storage/question-store.ts`, directly after `listPending`:

```ts
  countPending(ownerId: string): number {
    return z.object({ count: z.number() }).parse(this.database.prepare(`
      SELECT COUNT(*) AS count FROM assistant_questions
      WHERE owner_id = ? AND status IN ('planned', 'eligible', 'shown', 'snoozed')
    `).get(ownerId)).count;
  }
```

`src/assistant/storage/candidate-store.ts`, directly after `listValidationQueue`:

```ts
  countValidationQueue(ownerId: string): number {
    return z.object({ count: z.number() }).parse(this.database.prepare(`
      SELECT COUNT(*) AS count FROM candidate_assertions
      WHERE owner_id = ? AND status IN ('pending', 'needs_confirmation')
    `).get(ownerId)).count;
  }
```

(Both files already import `z` from `../../lib/zod.js`; the `countByStatus` method in `job-store.ts:176-180` is the idiom being copied.)

- [ ] **Step 4: Switch `status()` to the counts**

`src/assistant/assistant-service.ts:340-350`:

```ts
  status(): AssistantStatusResponse {
    return {
      available: true,
      enabled: this.enabled,
      ownerId: this.ownerId,
      pendingQuestionCount: this.enabled ? this.graph.questions.countPending(this.ownerId) : 0,
      pendingValidationCount: this.enabled
        ? this.graph.candidates.countValidationQueue(this.ownerId)
        : 0,
    };
  }
```

- [ ] **Step 5: Run tests, full gates, commit**

Run: `npm run build:test && npm run test -- assistant-question-store` → PASS; `npm run test -- assistant-candidate-store` → PASS; `npm run test 2>&1 | tail -8` → 0 fail; `npm run typecheck` → clean.

```bash
git add src/assistant/storage/question-store.ts src/assistant/storage/candidate-store.ts src/assistant/assistant-service.ts tests/assistant-question-store.test.ts tests/assistant-candidate-store.test.ts
git commit -m "perf(assistant): status counts use COUNT(*) instead of materializing queues"
```

---

### Task 3: Policy lookup by id instead of fetch-all-and-find

`setPolicyEnabled` and `deletePolicy` (`src/assistant/assistant-service.ts:440-456`) load every policy row to find one id.

**Files:**
- Modify: `src/assistant/storage/policy-store.ts` (add `getPolicyById` after `listPolicies`, ~line 70)
- Modify: `src/assistant/assistant-service.ts:440-456`
- Test: `tests/assistant-policy-store.test.ts` (create if absent; if policies are tested inside another file — check `git grep -l listPolicies tests/` — add there instead)

- [ ] **Step 1: Write the failing test**

```ts
test('getPolicyById returns the row for this owner and null otherwise', () => {
  // arrange: upsert one policy via store.upsertPolicy, read it back via listPolicies to get its id
  const row = store.listPolicies(ownerId)[0];
  assert.ok(row);
  assert.equal(store.getPolicyById(ownerId, row.id)?.id, row.id);
  assert.equal(store.getPolicyById(ownerId, 'pol_missing'), null);
  assert.equal(store.getPolicyById('own_other', row.id), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && npm run test -- assistant-policy` — FAIL: `getPolicyById is not a function`.

- [ ] **Step 3: Implement**

`src/assistant/storage/policy-store.ts` (match the file's existing row schema name — it parses rows with a zod schema in `listPolicies`; reuse the same schema constant, referred to below as `PolicyRowSchema`):

```ts
  getPolicyById(ownerId: string, policyId: string): PolicyRow | null {
    const row = this.database.prepare(`
      SELECT * FROM assistant_policies WHERE owner_id = ? AND id = ?
    `).get(ownerId, policyId);
    return row === undefined || row === null ? null : PolicyRowSchema.parse(row);
  }
```

- [ ] **Step 4: Use it in the service**

`src/assistant/assistant-service.ts:440-456`:

```ts
  setPolicyEnabled(policyId: string, enabled: boolean): boolean {
    if (!this.enabled) return false;
    const policy = this.graph.policies.getPolicyById(this.ownerId, policyId);
    if (policy === null) return false;
    this.graph.policies.setEnabled(this.ownerId, policy.policy_type, policy.key, enabled);
    return true;
  }

  deletePolicy(policyId: string): boolean {
    if (!this.enabled) return false;
    const policy = this.graph.policies.getPolicyById(this.ownerId, policyId);
    if (policy === null) return false;
    this.graph.policies.deletePolicy(this.ownerId, policy.policy_type, policy.key);
    return true;
  }
```

- [ ] **Step 5: Verify and commit**

Run: `npm run build:test && npm run test -- assistant-policy` → PASS; `npm run test 2>&1 | tail -8` → 0 fail; `npm run typecheck` → clean.

```bash
git add -A && git commit -m "perf(assistant): policy mutations look up by id instead of scanning all policies"
```

---

### Task 4: Prune terminal assistant jobs

`assistant_jobs` rows in terminal states (`completed`, `failed`, `cancelled`, `dead_letter`) are never deleted; the drain enqueues at least one job every 20 s cycle, so the table grows without bound.

**Files:**
- Modify: `src/assistant/storage/job-store.ts` (add `pruneTerminal` after `recoverExpiredLeases`, ~line 155)
- Modify: `src/assistant/assistant-service.ts` (`performDrain`, lines 720-730)
- Test: `tests/assistant-job-store.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/assistant-job-store.test.ts` (reuse its store/clock setup; the file already constructs a `JobStore` with a controllable clock):

```ts
test('pruneTerminal deletes old terminal jobs and keeps live and recent ones', () => {
  const oldJob = store.enqueue({ ownerId, jobType: 'capture_retention', payload: { reason: 'schedule' }, idempotencyKey: 'k1' }, 0);
  assert.ok(oldJob);
  store.claimNext({ ownerId, leaseOwner: 'test', leaseSeconds: 60, modelWorkAllowed: true });
  store.complete(oldJob.id);
  const liveJob = store.enqueue({ ownerId, jobType: 'capture_retention', payload: { reason: 'schedule' }, idempotencyKey: 'k2' }, 0);
  assert.ok(liveJob);
  // advance the test clock past the cutoff, then prune everything updated before "now - 0 days"
  const pruned = store.pruneTerminal(ownerId, clock.nowUtc());
  assert.equal(pruned, 1);
  assert.equal(store.getJob(oldJob.id), null);
  assert.equal(store.getJob(liveJob.id)?.status, 'queued');
});
```

(Adapt clock advancement to the file's fixture: the completed job's `updated_at_utc` must be `< cutoff` and the queued job's must survive because its status is not terminal.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && npm run test -- assistant-job-store` — FAIL: `pruneTerminal is not a function`.

- [ ] **Step 3: Implement**

```ts
  /** Deletes terminal jobs last touched before the cutoff. Live jobs are never touched. */
  pruneTerminal(ownerId: string, beforeUtc: string): number {
    const result = this.database.prepare(`
      DELETE FROM assistant_jobs
      WHERE owner_id = ? AND status IN ('completed', 'failed', 'cancelled', 'dead_letter')
        AND updated_at_utc < ?
    `).run(ownerId, beforeUtc);
    return result.changes;
  }
```

- [ ] **Step 4: Call it from the drain**

`src/assistant/assistant-service.ts` — add a named constant next to `JOB_LEASE_SECONDS`:

```ts
/** Terminal job rows older than this are deleted at the start of each drain. */
const JOB_RETENTION_DAYS = 7;
```

and at the top of `performDrain()` (before the `capture_retention` enqueue):

```ts
  private async performDrain(): Promise<void> {
    const cutoffUtc = new Date(
      Date.parse(this.clock.nowUtc()) - JOB_RETENTION_DAYS * 86_400_000,
    ).toISOString();
    this.graph.jobs.pruneTerminal(this.ownerId, cutoffUtc);
    // Retention runs even when observation is paused: it only ever removes data (spec §7).
    ...existing body unchanged...
  }
```

- [ ] **Step 5: Verify and commit**

Run: `npm run build:test && npm run test -- assistant-job-store` → PASS; `npm run test 2>&1 | tail -8` → 0 fail; `npm run typecheck` → clean.

```bash
git add -A && git commit -m "perf(assistant): prune terminal jobs older than 7 days on each drain"
```

---

### Task 5: Coalesce projection-maintenance jobs

Every graph mutation enqueues `projection_maintenance:${graphVersion}` — a distinct idempotency key per version, so N mutations between drains queue N full recompiles. Fix: a superseding enqueue that cancels older *queued* jobs of the same type, keeping at most one queued + one running. Keys stay version-scoped so a mutation arriving mid-compile still triggers a follow-up compile (an enqueue during a running job with the *same* key would be swallowed by `findLiveByIdempotencyKey`).

**Files:**
- Modify: `src/assistant/storage/job-store.ts` (add `enqueueSuperseding` after `enqueue`)
- Modify: `src/assistant/jobs/job-runner.ts:232-239` (`enqueueProjectionMaintenance`)
- Modify: any other `projection_maintenance:` enqueue call sites — find them all: `git grep -n "projection_maintenance:"` (known: `src/assistant/control/memory-mutation-service.ts`, `src/assistant/questions/feedback-service.ts`; update each the same way)
- Test: `tests/assistant-job-store.test.ts`, `tests/assistant-job-runner.test.ts`

- [ ] **Step 1: Write the failing store test**

```ts
test('enqueueSuperseding cancels older queued jobs of the same type but not running ones', () => {
  const first = store.enqueue({ ownerId, jobType: 'projection_maintenance', payload: { reason: 'graph_changed' }, idempotencyKey: 'projection_maintenance:1' }, 0);
  assert.ok(first);
  const second = store.enqueueSuperseding({ ownerId, jobType: 'projection_maintenance', payload: { reason: 'graph_changed' }, idempotencyKey: 'projection_maintenance:2' }, 0);
  assert.ok(second);
  assert.equal(store.getJob(first.id)?.status, 'cancelled');
  assert.equal(store.getJob(second.id)?.status, 'queued');

  // a running job survives superseding
  store.claimNext({ ownerId, leaseOwner: 'test', leaseSeconds: 60, modelWorkAllowed: true });
  const third = store.enqueueSuperseding({ ownerId, jobType: 'projection_maintenance', payload: { reason: 'graph_changed' }, idempotencyKey: 'projection_maintenance:3' }, 0);
  assert.ok(third);
  assert.equal(store.getJob(second.id)?.status, 'running');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && npm run test -- assistant-job-store` — FAIL: `enqueueSuperseding is not a function`.

- [ ] **Step 3: Implement**

`src/assistant/storage/job-store.ts`, after `enqueue`:

```ts
  /**
   * Enqueues after cancelling every *queued* job of the same type, so at most one job of this
   * type ever waits. A running job is left alone: its key differs, so the new row still lands,
   * and the pair guarantees the recompile covering the latest graph version is never lost.
   */
  enqueueSuperseding(input: EnqueueJobInput, priority: number): JobRow | null {
    this.database.prepare(`
      UPDATE assistant_jobs
      SET status = 'cancelled', updated_at_utc = ?
      WHERE owner_id = ? AND job_type = ? AND status = 'queued'
    `).run(this.clock.nowUtc(), input.ownerId, AssistantJobTypeSchema.parse(input.jobType));
    return this.enqueue(input, priority);
  }
```

- [ ] **Step 4: Switch the call sites**

`src/assistant/jobs/job-runner.ts:232-239`:

```ts
  private enqueueProjectionMaintenance(ownerId: string): void {
    this.options.graph.jobs.enqueueSuperseding({
      ownerId,
      jobType: 'projection_maintenance',
      payload: { reason: 'graph_changed' },
      idempotencyKey: `projection_maintenance:${this.options.graph.graphVersion}`,
    }, this.priorityFor('projection_maintenance'));
  }
```

Then run `git grep -n "jobType: 'projection_maintenance'"` and apply the identical `enqueue` → `enqueueSuperseding` change at every hit (keep each site's existing priority argument and payload).

- [ ] **Step 5: Add a runner-level regression test**

In `tests/assistant-job-runner.test.ts`, using that file's existing fixture that drives real graph mutations:

```ts
test('many mutations between drains leave at most one queued projection_maintenance job', () => {
  // arrange: perform 5 assertion writes via the fixture's graph service
  const queued = graph.jobs.listByStatus(ownerId, 'queued')
    .filter((job) => job.job_type === 'projection_maintenance');
  assert.equal(queued.length, 1);
});
```

- [ ] **Step 6: Verify and commit**

Run: `npm run build:test && npm run test -- assistant-job` → PASS (both files); `npm run test 2>&1 | tail -8` → 0 fail; `npm run typecheck` → clean.

```bash
git add -A && git commit -m "perf(assistant): coalesce projection-maintenance jobs to one queued recompile"
```

---

### Task 6: Batch the bounded N+1s in `MemoryQueryService`

Three call patterns issue one query per row: `search` re-fetches each FTS hit individually, `listAssertions`/`toAssertion` builds views one row at a time, and `listMemoryHistory` fetches evidence links then evidence rows per mutation.

**Files:**
- Modify: `src/assistant/storage/projection-store.ts` (add `getProjections` batch, modeled on `assertion-store.getAssertions`)
- Modify: `src/assistant/storage/assertion-store.ts` (add `listEvidenceForAssertions`)
- Modify: `src/assistant/storage/evidence-store.ts` (add `getEvidenceMany`)
- Modify: `src/assistant/control/memory-query-service.ts` (`search` lines 40-58, `listAssertions` line 102-106, `listMemoryHistory` lines 146-189)
- Test: `tests/assistant-memory-query-service.test.ts`

Note: `assertion-store.getAssertions(ids)` and `node-store.getNodes(ids)` already exist and are the idiom to copy for IN-list batching (chunk the ids if the store does; follow whatever it does for the SQLite 999-parameter limit — read `getAssertions` first and mirror it exactly).

- [ ] **Step 1: Write failing behavioral tests**

Behavior must not change, so write equivalence tests first (they pass before *and* after — the protection is against regressions during the rewrite; the *failing* part is the new store methods):

```ts
test('getProjections returns the same rows as getProjection per id', () => {
  const ids = graph.projections.search(ownerId, 'anything', 10);
  const batch = graph.projections.getProjections(ids);
  for (const id of ids) {
    assert.deepEqual(batch.get(id), graph.projections.getProjection(id));
  }
});

test('listEvidenceForAssertions groups links by assertion id', () => {
  const single = graph.assertions.listEvidence(assertionId);
  const batch = graph.assertions.listEvidenceForAssertions([assertionId]);
  assert.deepEqual(batch.get(assertionId) ?? [], single);
});

test('getEvidenceMany returns the same rows as getEvidence per id', () => {
  const batch = graph.evidence.getEvidenceMany([evidenceId]);
  assert.deepEqual(batch.get(evidenceId), graph.evidence.getEvidence(evidenceId));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build:test && npm run test -- assistant-memory-query` — FAIL: methods not defined.

- [ ] **Step 3: Implement the three batch methods**

Each mirrors `getAssertions` (same chunking, same zod row schema the file already uses):

`projection-store.ts`:

```ts
  getProjections(ids: readonly string[]): Map<string, ProjectionRow> {
    const result = new Map<string, ProjectionRow>();
    for (const chunk of chunkIds(ids)) {
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = z.array(ProjectionRowSchema).parse(this.database.prepare(
        `SELECT * FROM memory_projections WHERE id IN (${placeholders})`,
      ).all(...chunk));
      for (const row of rows) result.set(row.id, row);
    }
    return result;
  }
```

`assertion-store.ts` (returns links grouped by assertion; the row shape is whatever `listEvidence` already parses — reuse that schema):

```ts
  listEvidenceForAssertions(
    assertionIds: readonly string[],
  ): Map<string, AssertionEvidenceRow[]> {
    const result = new Map<string, AssertionEvidenceRow[]>();
    for (const chunk of chunkIds(assertionIds)) {
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = z.array(AssertionEvidenceRowSchema).parse(this.database.prepare(
        `SELECT * FROM assertion_evidence WHERE assertion_id IN (${placeholders})
         ORDER BY assertion_id, evidence_id, stance`,
      ).all(...chunk));
      for (const row of rows) {
        const bucket = result.get(row.assertion_id) ?? [];
        bucket.push(row);
        result.set(row.assertion_id, bucket);
      }
    }
    return result;
  }
```

`evidence-store.ts`:

```ts
  getEvidenceMany(ids: readonly string[]): Map<string, EvidenceRow> {
    const result = new Map<string, EvidenceRow>();
    for (const chunk of chunkIds(ids)) {
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = z.array(EvidenceRowSchema).parse(this.database.prepare(
        `SELECT * FROM evidence_records WHERE id IN (${placeholders})`,
      ).all(...chunk));
      for (const row of rows) result.set(row.id, row);
    }
    return result;
  }
```

If no shared `chunkIds` helper exists yet (check how `getAssertions` chunks), extract one into `src/assistant/storage/sql-helpers.ts` (the file added in commit a9132357 — if a chunk helper already lives there, use it) and have all four batch methods share it.

- [ ] **Step 4: Rewrite the three consumers**

`memory-query-service.ts` `search` (lines 40-58) — batch fetch after FTS:

```ts
  search(ownerId: string, query: string, limit: number): MemorySearchResult {
    this.validateLimit(limit);
    const trimmed = query.trim();
    if (!trimmed) return { nodes: [], assertions: [], projections: [] };
    const nodeRows = this.graph.nodes.getNodes(
      this.graph.nodes.searchNodes(ownerId, trimmed, limit),
    );
    const assertionRows = this.graph.assertions.getAssertions(
      this.graph.assertions.searchAssertions(ownerId, trimmed, limit),
    );
    const projectionRows = this.graph.projections.getProjections(
      this.graph.projections.search(ownerId, trimmed, limit),
    );
    const ownedAssertions = [...assertionRows.values()]
      .filter((row) => row.owner_id === ownerId);
    const views = new Map(
      this.views.buildMany(ownedAssertions).map((view) => [view.assertionId, view] as const),
    );
    return {
      nodes: [...nodeRows.values()]
        .filter((row) => row.owner_id === ownerId)
        .map((row) => this.toNodeSummary(row)),
      assertions: ownedAssertions
        .map((row) => this.toAssertionWithView(row, this.requireHistoryView(views, row.id))),
      projections: [...projectionRows.values()]
        .filter((row) => row.owner_id === ownerId)
        .map((row) => this.toProjection(row)),
    };
  }
```

`listAssertions` (line 102-106) — one `buildMany` instead of per-row `build`:

```ts
  listAssertions(ownerId: string, page: PageRequest): AssistantAssertionDto[] {
    this.validatePage(page);
    const rows = this.graph.assertions.list(ownerId, page.limit, page.offset);
    const views = new Map(
      this.views.buildMany(rows).map((view) => [view.assertionId, view] as const),
    );
    return rows.map((row) => this.toAssertionWithView(row, this.requireHistoryView(views, row.id)));
  }
```

Add the shared converter and change `toAssertion` callers accordingly (keep `toAssertion` for the single-row paths `getAssertion`/`explainAssertion`, implemented as `this.toAssertionWithView(row, this.views.build(row))`):

```ts
  private toAssertionWithView(row: AssertionRow, view: AssertionView): AssistantAssertionDto {
    const sensitive = this.isSensitive(row.sensitivity);
    return {
      id: row.id,
      subjectNodeId: row.subject_node_id,
      predicate: row.predicate,
      objectText: sensitive ? '[redacted]' : view.objectText,
      scopeText: sensitive ? '' : view.scopeText,
      status: row.status,
      basis: row.basis,
      confidence: row.confidence,
      sensitivity: row.sensitivity,
      pinned: row.pinned,
      userDemoted: row.user_demoted,
      validFromUtc: row.valid_from_utc,
      validToUtc: row.valid_to_utc,
      lastObservedAtUtc: row.last_observed_at_utc,
    };
  }
```

`listMemoryHistory` (lines 146-189) — replace the per-mutation `listEvidence` + per-link `requireEvidence` with two batch calls before the map:

```ts
    const evidenceLinks = this.graph.assertions.listEvidenceForAssertions([...assertionsById.keys()]);
    const evidenceRows = this.graph.evidence.getEvidenceMany(
      [...evidenceLinks.values()].flat().map((link) => link.evidence_id),
    );
```

and inside the `mutations.map`, build `proofs` from the maps (a missing evidence row is a bug, same contract as `requireEvidence`):

```ts
      const proofs = assertion === null
        ? []
        : (evidenceLinks.get(assertion.id) ?? []).map((link) => {
          const evidence = evidenceRows.get(link.evidence_id);
          if (evidence === undefined) {
            throw new Error(`Unknown evidence record: ${link.evidence_id}`);
          }
          return {
            evidenceId: evidence.id,
            sourceType: evidence.source_type,
            sourceRef: evidence.source_ref,
          };
        });
```

- [ ] **Step 5: Verify and commit**

Run: `npm run build:test && npm run test -- assistant-memory-query` → PASS; `npm run test 2>&1 | tail -8` → 0 fail (the dashboard E2E and routes tests exercise these paths); `npm run typecheck` → clean.

```bash
git add -A && git commit -m "perf(assistant): batch node/assertion/evidence fetches in memory query service"
```

---

### Task 7: Drain-duration instrumentation (decision input for any future worker-thread move)

Analysis finding #10 is measure-first. Add a cheap duration log so slow drains become visible instead of speculating about worker threads.

**Files:**
- Modify: `src/assistant/assistant-service.ts` (`performDrain`)
- Test: none (stderr logging only; assert nothing)

- [ ] **Step 1: Implement**

Add next to `JOB_RETENTION_DAYS`:

```ts
/** Drains slower than this are logged so event-loop pressure is visible before it hurts chat. */
const SLOW_DRAIN_THRESHOLD_MS = 250;
```

Wrap the body of `performDrain` (after the prune added in Task 4):

```ts
    const startedAtMs = Date.now();
    ...existing enqueue + drain body...
    const elapsedMs = Date.now() - startedAtMs;
    if (elapsedMs > SLOW_DRAIN_THRESHOLD_MS) {
      process.stderr.write(`[assistant] slow drain: ${elapsedMs}ms\n`);
    }
```

- [ ] **Step 2: Verify and commit**

Run: `npm run build:test && npm run test 2>&1 | tail -8` → 0 fail; `npm run typecheck` → clean.

```bash
git add src/assistant/assistant-service.ts && git commit -m "chore(assistant): log drains slower than 250ms"
```

---

## Phase B — Assistant route dispatch: one endpoint per route

### Task 8: Split `routes/assistant.ts` into per-route endpoints

The `RouteTable` (`assistant.ts:531-588`) already matches method+path with captures, then `AssistantEndpoint.handle` re-matches everything in a 390-line if-chain with fragile `endsWith` checks. Replace the single endpoint with one small endpoint per route, grouped into modules. **Behavior contract: identical status codes, bodies, gates, and ordering semantics.** The existing route tests (`tests/assistant-routes*.test.ts` — enumerate with `ls tests | grep assistant-route`, plus `assistant-dashboard-e2e.test.ts` and `assistant-auth.test.ts`) are the safety net and must pass unmodified.

**Files:**
- Create: `src/status-server/routes/assistant/helpers.ts`
- Create: `src/status-server/routes/assistant/admin-routes.ts` (status, config, keys, desktop state, factory-reset, export, backup, restore)
- Create: `src/status-server/routes/assistant/ingest-routes.ts` (mobile, environment, activity, capture, suppression)
- Create: `src/status-server/routes/assistant/graph-routes.ts` (search, nodes, neighborhood, assertions GET, explanation, evidence GET/blob, history, projections GET)
- Create: `src/status-server/routes/assistant/mutation-routes.ts` (confirm, correct, pin, demote, assertion DELETE, evidence deletion-preview/DELETE, topics forget, projections rebuild)
- Create: `src/status-server/routes/assistant/question-routes.ts` (current, mark-shown, dismiss, answer, skip, snooze, do-not-repeat, block-topic)
- Create: `src/status-server/routes/assistant/policy-routes.ts` (policies list/block-topic/patch/delete, validation list/notes/delete)
- Modify: `src/status-server/routes/assistant.ts` → becomes the table + `handleAssistantRoute` only
- Test: existing route tests, plus one new regression test

- [ ] **Step 1: Write the new regression test first**

Add to the existing assistant routes test file (or `tests/assistant-routes-dispatch.test.ts` if none covers plain routing), using the file's existing server/request fixture:

```ts
test('GET /assistant/history responds 200 with items and completes the response', async () => {
  const response = await request('GET', '/assistant/history');
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.items));
});

test('a known path with a wrong method responds 404, not a hang', async () => {
  const response = await request('PUT', '/assistant/status');
  assert.equal(response.status, 404);
});
```

Run: `npm run build:test && npm run test -- assistant-route` — the history test should PASS already (Task 1 added the return); the wrong-method test documents current `hasPath` behavior (`hasPath` matches path regardless of method → `routes.handle` returns false → 404). If it fails, adjust the expectation to observed behavior before refactoring — the refactor must preserve it.

- [ ] **Step 2: Create `helpers.ts`**

Move these verbatim from `assistant.ts` (current lines given) and export them: `MUTATION_BODY_LIMIT`, `QUESTION_ANSWER_BODY_LIMIT`, `KEY_MATERIAL_BODY_LIMIT`, `OBSERVATION_BODY_LIMIT`, `RESTORE_BODY_LIMIT`, `CAPTURE_BODY_LIMIT` (31-39); `CorrectionSchema`, `PinSchema`, `AnswerSchema`, `QuestionIdSchema`, `SnoozeSchema`, `PolicyPatchSchema`, `BlockPolicyTopicSchema` (41-59); `header` (61-64); `sendError` (66-68); `id` (70-74); `integerParam` (76-82); `body` (84-90); `success` (92-94); `sendZip` (96-104); `desktopBody` (106-123); `sendQueryResult` (the private method at 517-527, now a free function). Then add the two wrappers that carry the gates every group shares:

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AssistantService } from '../../../assistant/assistant-service.js';
import type { RouteEndpoint, RouteMatch } from '../../route-table.js';
import type { ServerContext } from '../../server-types.js';

export interface AssistantRequest {
  readonly service: AssistantService;
  readonly ctx: ServerContext;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly match: RouteMatch;
  readonly url: URL;
}

type AssistantHandler = (request: AssistantRequest) => Promise<void> | void;

/**
 * Wraps a handler with the two gates every assistant route shares: the service must exist
 * (503 otherwise), and unless the route opts out, the assistant must be enabled (409).
 * Key custody, desktop state, and §16 maintenance opt out — turning the assistant off must
 * never strand key import/export or data erasure.
 */
export function assistantRoute(
  handler: AssistantHandler,
  options: { readonly requireEnabled: boolean } = { requireEnabled: true },
): RouteEndpoint {
  return {
    async handle(ctx, req, res, match) {
      const service = ctx.assistantControl;
      if (service === null) {
        sendError(res, 503, 'assistant_unavailable', 'Assistant service is unavailable.');
        return;
      }
      if (options.requireEnabled && !service.enabled) {
        sendError(res, 409, 'assistant_disabled', 'Assistant is disabled.');
        return;
      }
      const url = new URL(req.url ?? match.pathname, 'http://127.0.0.1');
      await handler({ service, ctx, req, res, match, url });
    },
  };
}
```

- [ ] **Step 3: Create the group modules**

Each module exports named endpoints built with `assistantRoute`, whose bodies are the **verbatim** branch bodies from the current if-chain (source lines cited). Complete example for `graph-routes.ts` — the others follow the exact same shape:

```ts
import { sendJson } from '../../http-utils.js';
import {
  assistantRoute, id, integerParam, sendQueryResult,
} from './helpers.js';
// plus only what the moved bodies need (e.g. AssistantNotFoundError for the evidence-blob body).

export const searchEndpoint = assistantRoute(({ service, res, url }) => {
  // body: assistant.ts:281-291 verbatim
});

export const listNodesEndpoint = assistantRoute(({ service, res, url }) => {
  // body: assistant.ts:292-297 verbatim
});

export const neighborhoodEndpoint = assistantRoute(({ service, res, match, url }) => {
  // body: assistant.ts:298-303 verbatim (drop the regex re-test; the table already matched)
});

export const getNodeEndpoint = assistantRoute(({ service, res, match }) => {
  // body: assistant.ts:304-307 verbatim
});

export const listAssertionsEndpoint = assistantRoute(({ service, res, url }) => {
  // body: assistant.ts:308-313 verbatim
});

export const explainAssertionEndpoint = assistantRoute(({ service, res, match }) => {
  // body: assistant.ts:314-319 verbatim
});

export const getAssertionEndpoint = assistantRoute(({ service, res, match }) => {
  // body: assistant.ts:320-323 verbatim (drop the method check; the table row is GET-only)
});

export const listEvidenceEndpoint = assistantRoute(({ service, res, url }) => {
  // body: assistant.ts:394-399 verbatim
});

export const evidenceBlobEndpoint = assistantRoute(({ service, res, url }) => {
  // body: assistant.ts:372-393 verbatim, including its try/catch and error mapping
});

export const getEvidenceEndpoint = assistantRoute(({ service, res, match }) => {
  // body: assistant.ts:412-417 verbatim
});

export const listProjectionsEndpoint = assistantRoute(({ service, res }) => {
  // body: assistant.ts:431-434 verbatim
});

export const historyEndpoint = assistantRoute(({ service, res, url }) => {
  // body: assistant.ts:510-514 verbatim (with the Task 1 return)
});
```

Group manifests (route → source lines → module; every `endsWith`/regex re-test disappears because the table's regex already disambiguates):

| Route (method, path) | Current body | Module / endpoint | `requireEnabled` |
|---|---|---|---|
| GET `/assistant/status` | 139-142 | admin / `statusEndpoint` | **false** |
| GET+PATCH `/assistant/config` | 143-155 | admin / `configReadEndpoint`, `configPatchEndpoint` (split the method branch into two endpoints) | **false** |
| GET `/assistant/keys/custody` | 160-163 | admin / `custodyEndpoint` | **false** |
| POST `/assistant/keys/export` | 164-167 | admin / `keyExportEndpoint` | **false** |
| POST `/assistant/keys/import` | 168-175 | admin / `keyImportEndpoint` | **false** |
| GET `/assistant/desktop/state` | 178-181 | admin / `desktopStateEndpoint` | **false** |
| GET `/assistant/factory-reset/preview` | 185-188 | admin / `factoryResetPreviewEndpoint` | **false** |
| POST `/assistant/factory-reset` | 189-195 | admin / `factoryResetEndpoint` | **false** |
| POST `/assistant/export` | 196-200 | admin / `exportEndpoint` | **false** |
| POST `/assistant/backup` | 201-204 | admin / `backupEndpoint` | **false** |
| POST `/assistant/restore-preview` | 205-210 | admin / `restorePreviewEndpoint` | **false** |
| POST `/assistant/restore` | 211-215 | admin / `restoreEndpoint` | **false** |
| POST `/assistant/ingest/mobile` | 218-236 | ingest / `mobileEndpoint` — **`requireEnabled: false`**, body starts with the flag-off 404 (lines 218-221), then an explicit enabled check returning the 409 (line 222-225 semantics), then the envelope body (227-236). This is the one route where gate order is load-bearing: flag-off must 404 *before* disabled can 409. |
| POST `/assistant/ingest/environment` | 251-257 | ingest / `environmentEndpoint` | true |
| POST `/assistant/ingest/activity` | 258-264 | ingest / `activityEndpoint` | true |
| POST `/assistant/ingest/capture` | 265-271 | ingest / `captureEndpoint` | true |
| POST `/assistant/ingest/suppression` | 272-278 | ingest / `suppressionEndpoint` | true |
| questions mark-shown / dismiss / current / answer / skip / snooze / do-not-repeat / block-topic | 238-249, 442-473 | question-routes, one endpoint each | true |
| graph + evidence + history + projections GET routes | table above | graph-routes | true |
| confirm / correct / pin / demote (324-356), assertion DELETE (357-371), evidence deletion-preview (400-403) + DELETE (404-411), topics forget-preview/forget (418-430), projections rebuild (435-441) | mutation-routes, one endpoint each | true |
| policies list / block-topic / PATCH / DELETE (474-492), validation list / notes / DELETE (493-509) | policy-routes, one endpoint each. PATCH and DELETE on `/assistant/policies/:id` become two endpoints (the method ternary at 486-488 splits). | true |

- [ ] **Step 4: Rewrite `assistant.ts` as table + guard only**

Keep `handleAssistantRoute` (590-647) byte-for-byte — auth, bootstrap, rate limiting, `hasPath` 404, and the error-mapping catch are unchanged. Replace the endpoint construction: delete the `AssistantEndpoint` class and build the `RouteTable` from the imported endpoints, same method+path rows as now (531-588), e.g.:

```ts
const routes = new RouteTable([
  { method: 'GET', path: '/assistant/status', endpoint: statusEndpoint },
  { method: 'GET', path: '/assistant/config', endpoint: configReadEndpoint },
  { method: 'PATCH', path: '/assistant/config', endpoint: configPatchEndpoint },
  ...every row from the manifest...
]);
```

Route-order note: keep the current row order verbatim — `/assistant/evidence/blob` before the `/:id` regex, deletion-preview before bare `/:id`, exactly as the current table comments say.

- [ ] **Step 5: Verify**

Run: `npm run typecheck` → clean (this is the main net for missed imports). Run: `npm run build:test && npm run test 2>&1 | tail -8` → 0 fail. Manually diff the route list: `git diff` must show no added/removed/reordered rows in the table.

- [ ] **Step 6: Commit**

```bash
git add src/status-server/routes/assistant.ts src/status-server/routes/assistant/ tests/
git commit -m "refactor(assistant): one endpoint per route, single dispatch through RouteTable"
```

---

## Phase C — Migration registry

### Task 9: Extract migrations from `runtime-db.ts` into a registry

`ensureSchema` (`src/state/runtime-db.ts:1019-1524`) is 46 inline version blocks. Move each block into a registry entry; the runner replaces the if-chain. **Pure move — every SQL string byte-identical.** The v-specific tests (`tests/runtime-db-schema-v26.test.ts` etc.) and `tests/assistant-migration.test.ts` are the net.

**Files:**
- Create: `src/state/migrations/types.ts`
- Create: `src/state/migrations/schema-introspection.ts` (move `tableExists`, `tableHasColumn` from runtime-db.ts:57-81)
- Create: `src/state/migrations/app-config-migrations.ts` (move the five `migrate*` functions, runtime-db.ts:686-1017: `migrateAppConfigToPresetSourceOfTruth`, `migrateChatSessionsToModelPresetIdentity`, `migrateChatSessionsToModelPresetSnapshot`, `migrateRunLogsBackendToEngineIds`, `migrateAppConfigRemoveGlobalStartupContext`, plus the zod schemas they use from runtime-db.ts:31-48)
- Create: `src/state/migrations/registry.ts`
- Modify: `src/state/runtime-db.ts`
- Test: `tests/runtime-db-migration-registry.test.ts` (new)

- [ ] **Step 1: Write the failing registry-shape test**

`tests/runtime-db-migration-registry.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MIGRATIONS } from '../src/state/migrations/registry.js';
import { CURRENT_SCHEMA_VERSION } from '../src/state/runtime-db.js';

test('migration versions are strictly ascending and end at CURRENT_SCHEMA_VERSION', () => {
  assert.ok(MIGRATIONS.length > 0);
  for (let index = 1; index < MIGRATIONS.length; index += 1) {
    assert.ok(MIGRATIONS[index].version > MIGRATIONS[index - 1].version);
  }
  assert.equal(MIGRATIONS.at(-1)?.version, CURRENT_SCHEMA_VERSION);
});
```

(Import path style: match how other tests in `tests/` import from `src/` — check a neighbor like `tests/assistant-migration.test.ts` and copy its convention.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && npm run test -- migration-registry` — FAIL: module not found.

- [ ] **Step 3: Create `types.ts` and the registry**

`src/state/migrations/types.ts`:

```ts
import type { RuntimeDatabase } from '../runtime-db.js';

export interface Migration {
  readonly version: number;
  up(database: RuntimeDatabase): void;
}
```

(If this import creates a cycle — runtime-db imports the registry — move the `RuntimeDatabase` type alias `export type RuntimeDatabase = InstanceType<typeof Database>` into a new `src/state/database-handle.ts` and re-export it from runtime-db.ts so both sides import the leaf. Verify with `npm run typecheck`.)

`src/state/migrations/registry.ts` — one entry per version block, body moved verbatim from `ensureSchema`. The first and last entries as they must appear (versions 2 and 46); every intermediate entry is the same mechanical transform of its block at the cited lines:

```ts
import type { Migration } from './types.js';
import { tableExists, tableHasColumn } from './schema-introspection.js';
import {
  migrateAppConfigToPresetSourceOfTruth,
  migrateChatSessionsToModelPresetIdentity,
  migrateChatSessionsToModelPresetSnapshot,
  migrateRunLogsBackendToEngineIds,
  migrateAppConfigRemoveGlobalStartupContext,
} from './app-config-migrations.js';
// ensure* schema functions and assistant schema SQL are imported from where they live today.

export const MIGRATIONS: readonly Migration[] = [
  { version: 2, up: (database) => { ensureRuntimeArtifactsSchema(database); } },        // runtime-db.ts:1043-1047
  { version: 3, up: (database) => { ensureInferenceRunAndBenchmarkMatrixSchema(database); } }, // 1048-1052
  // versions 4-45: move each `if (currentVersion < N) { ... }` body verbatim,           // 1053-1505
  // dropping only the setSchemaVersion/currentVersion bookkeeping lines (the runner owns those).
  {
    version: 46,
    up: (database) => {                                                                  // 1506-1518
      for (const table of ['graph_nodes', 'graph_assertions', 'memory_projections'] as const) {
        if (!tableHasColumn(database, table, 'fts_rowid')) {
          database.exec(`ALTER TABLE ${table} ADD COLUMN fts_rowid INTEGER;`);
        }
      }
      database.exec(ASSISTANT_CORE_SCHEMA_SQL);
      database.exec(ASSISTANT_MEMORY_SCHEMA_SQL);
      database.exec(ASSISTANT_DESKTOP_SCHEMA_SQL);
      backfillAssistantFtsRowids(database);
    },
  },
];
```

Transform notes, all mechanical:
- Blocks `< 12` and `< 13` are bookkeeping-only (`runtime-db.ts:1219-1226`): they become `{ version: 12, up: () => {} }` and `{ version: 13, up: () => {} }` — keep them so the ascending chain and `detectEffectiveSchemaVersion` interplay stay intact.
- There is no version 18 or 28 block today (the chain jumps 17→19 and 27→29); the registry simply has no entry for them — the strict-ascending test allows gaps.

- [ ] **Step 4: Rewrite `ensureSchema` as the runner**

In `runtime-db.ts`, the migration section becomes:

```ts
function ensureSchema(database: RuntimeDatabase): void {
  database.exec('PRAGMA foreign_keys = ON;');
  const storedVersion = getSchemaVersion(database);
  let currentVersion = detectEffectiveSchemaVersion(database, storedVersion);
  if (currentVersion > storedVersion) {
    setSchemaVersion(database, currentVersion);
  }
  if (currentVersion <= 0) {
    // fresh install path: unchanged, verbatim from today (runtime-db.ts:1026-1040)
    ...
    return;
  }
  applyBaseSchema(database);
  ensureRuntimeMetricsTotalsSchema(database);
  for (const migration of MIGRATIONS) {
    if (currentVersion < migration.version) {
      migration.up(database);
      setSchemaVersion(database, migration.version);
      currentVersion = migration.version;
    }
  }
  ensureChatMessageTimelineSchema(database);
  ensureRuntimeArtifactsSchema(database);
  ensureInferenceRunAndBenchmarkMatrixSchema(database);
  ensureDashboardBenchmarkSchema(database);
  ensureRuntimeErrorEventsSchema(database);
}
```

Delete the five moved `migrate*` functions and the two moved introspection helpers from runtime-db.ts (no re-exports — missed imports must fail loudly per repo rules; fix each compile error by importing from the new modules).

- [ ] **Step 5: Verify**

Run: `npm run build:test && npm run test -- runtime-db` → all v-specific migration tests PASS; `npm run test -- assistant-migration` → PASS; `npm run test 2>&1 | tail -8` → 0 fail; `npm run typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/state/ tests/runtime-db-migration-registry.test.ts
git commit -m "refactor(state): extract 46 inline migrations into a versioned registry"
```

---

## Phase D — Status-server decomposition

### Task 10: Split `routes/core.ts` by responsibility

`routes/core.ts` is 2,000 lines of unrelated endpoints plus the terminal-metadata queue machinery. Pure moves; `handleCoreRoute`'s dispatch behavior is unchanged. Consumers to keep working: `routes.ts:9` imports `handleCoreRoute`; `index.ts:67` imports `waitForTerminalMetadataIdle`.

**Files:**
- Create: `src/status-server/terminal-metadata.ts` — move the queue machinery: `terminalMetadataDrainSuppressor` (core.ts:146), `applyDeferredTerminalMetadata` (323), `scheduleDeferredTerminalMetadata` (448), `getTerminalMetadataIdleWaitMs` (457), `scheduleTerminalMetadataDrain` (472), `enqueueTerminalMetadata` (485), `processTerminalMetadataBody` (496), `drainTerminalMetadataQueue` (589), `isTerminalMetadataIdle` (661), `waitForTerminalMetadataIdle` (668)
- Create: `src/status-server/routes/status-post.ts` — move `StatusPostEndpoint` (1292), `StatusPostRequestHandler` (1303-1778), `StatusCompleteEndpoint` (1231), `persistStatusRunLog` (276), `resolveStatusRunLogIdentity` (256), `logToolStatsLines` (220), and the `normalize*` helpers they use (148-179)
- Create: `src/status-server/routes/repo-agent.ts` — move `RepoAgentStartEndpoint` (997), `RepoAgentDecideEndpoint` (1072), `RepoAgentStatusEndpoint` (1130)
- Create: `src/status-server/routes/repo-search.ts` — move `RepoSearchEndpoint` (878), `RepoSearchApprovalEndpoint` (1161), `streamSessionBoundary` (966)
- Create: `src/status-server/routes/operations.ts` — move `CommandOutputAnalyzeEndpoint` (747), `PresetListEndpoint` (786), `PresetRunEndpoint` (805), `EvalRunEndpoint` (845), `SummaryEndpoint` (1190)
- Create: `src/status-server/routes/server-admin.ts` — move `HealthEndpoint` (692), `StatusReadEndpoint` (715), `LlamaCppConfigTestEndpoint` (1780), `ConfigReadEndpoint` (1830), `ConfigUpdateEndpoint` (1872), `StatusRestartEndpoint` (1909), `InferenceRuntimeReadEndpoint` (1947), `isStrictConfigPayload` (181)
- Modify: `src/status-server/routes/core.ts` — retains only the route table assembly (the endpoint instances + `handleCoreRoute`) importing from the new modules
- Modify: `src/status-server/index.ts:67` — import `waitForTerminalMetadataIdle` from `./terminal-metadata.js`

- [ ] **Step 1: Inventory before moving**

Open `core.ts` and list its remaining private helpers not named above (`llamaCppClient` at 143, `normalizeTaskKind` at 148, etc.). Each moves to the module of its **only** consumer; a helper with consumers in two new modules moves to the module that uses it most and is exported. Record the final placement in the commit message body.

- [ ] **Step 2: Move one module at a time, typecheck after each**

Order: `terminal-metadata.ts` first (largest untangling), then `status-post.ts`, then the four endpoint modules. After each move: `npm run typecheck` → fix imports until clean. No logic edits — if a moved function needs something private to old core.ts, export it from wherever it lands, never duplicate it.

- [ ] **Step 3: Verify after the last move**

`core.ts` should now be roughly: imports, endpoint instances, the route-dispatch function. Sanity: `wc -l src/status-server/routes/core.ts` → expect under ~300. Run: `npm run build:test && npm run test 2>&1 | tail -8` → 0 fail.

- [ ] **Step 4: Commit**

```bash
git add src/status-server/
git commit -m "refactor(status-server): split routes/core.ts into per-responsibility modules"
```

---

### Task 11: Group `ServerContext` fields into owned sub-states

`ServerContext` (`server-types.ts:81-146`) has ~40 mutable fields across subsystems. Group the three biggest clusters into named objects. One cluster per commit; each is a mechanical field-path rename.

**Files:**
- Modify: `src/status-server/server-types.ts`
- Modify: every `ctx.<field>` consumer (found per-cluster via `git grep`)

- [ ] **Step 1: Define the sub-state types in `server-types.ts`**

```ts
export type TerminalMetadataState = {
  queue: TerminalMetadataQueueItem[];
  drainScheduled: boolean;
  drainRunning: boolean;
  lastModelRequestFinishedAtMs: number | null;
  readonly idleDelayMs: number;
};

export type IdleSummaryState = {
  readonly delayMs: number;
  pendingMetadata: {
    inputCharactersPerContextToken: number | null;
    chunkThresholdCharacters: number | null;
  };
  timer: NodeJS.Timeout | null;
  pending: boolean;
  database: DatabaseInstance | null;
};

export type ManagedLlamaState = {
  startupPromise: Promise<void> | null;
  shutdownPromise: Promise<void> | null;
  hostProcess: ChildProcess | null;
  lastStartupLogs: LlamaRunRecorder | null;
  starting: boolean;
  ready: boolean;
  startupWarning: string | null;
  bootstrapStartup: boolean;
  logCleanupTimer: NodeJS.Timeout | null;
};
```

On `ServerContext`, replace the corresponding flat fields with `terminalMetadata: TerminalMetadataState;`, `idleSummary: IdleSummaryState;`, `managedLlama: ManagedLlamaState;`. All other fields stay flat (assistant fields are few and already cohesive).

- [ ] **Step 2: Rename cluster 1 (terminal metadata)**

Field map: `ctx.terminalMetadataQueue` → `ctx.terminalMetadata.queue`; `ctx.terminalMetadataDrainScheduled` → `ctx.terminalMetadata.drainScheduled`; `ctx.terminalMetadataDrainRunning` → `ctx.terminalMetadata.drainRunning`; `ctx.terminalMetadataLastModelRequestFinishedAtMs` → `ctx.terminalMetadata.lastModelRequestFinishedAtMs`; `ctx.terminalMetadataIdleDelayMs` → `ctx.terminalMetadata.idleDelayMs`. Update the initializer in `index.ts:278-283`. Find every consumer: `git grep -ln "terminalMetadata"` — mostly `terminal-metadata.ts` after Task 10. Run `npm run typecheck` until clean, then `npm run build:test && npm run test 2>&1 | tail -8` → 0 fail.

```bash
git add -A && git commit -m "refactor(status-server): group terminal-metadata context fields"
```

- [ ] **Step 3: Rename cluster 2 (idle summary)**

Map: `idleSummaryDelayMs` → `idleSummary.delayMs`; `pendingIdleSummaryMetadata` → `idleSummary.pendingMetadata`; `idleSummaryTimer` → `idleSummary.timer`; `idleSummaryPending` → `idleSummary.pending`; `idleSummaryDatabase` → `idleSummary.database`. Same verify + commit:

```bash
git commit -m "refactor(status-server): group idle-summary context fields"
```

- [ ] **Step 4: Rename cluster 3 (managed llama)**

Map: `managedLlamaStartupPromise` → `managedLlama.startupPromise`; `managedLlamaShutdownPromise` → `managedLlama.shutdownPromise`; `managedLlamaHostProcess` → `managedLlama.hostProcess`; `managedLlamaLastStartupLogs` → `managedLlama.lastStartupLogs`; `managedLlamaStarting` → `managedLlama.starting`; `managedLlamaReady` → `managedLlama.ready`; `managedLlamaStartupWarning` → `managedLlama.startupWarning`; `bootstrapManagedLlamaStartup` → `managedLlama.bootstrapStartup`; `managedLlamaLogCleanupTimer` → `managedLlama.logCleanupTimer`. This cluster has the most consumers (`managed-llama.ts` is 1,449 lines) — rely on the compiler: rename the type first, then fix every error `npm run typecheck` reports. Verify full suite, commit:

```bash
git commit -m "refactor(status-server): group managed-llama context fields"
```

---

## Phase E — AssistantService facade reduction

### Task 12: Extract `PolicyControlService` and `ValidationQueueService`

Move the policy and validation pass-throughs off the facade into `control/` services (the pattern `memoryQueries`/`memoryMutations` already establishes). The facade keeps lifecycle, ingest, retrieval, questions-shown/dismiss, and maintenance.

**Files:**
- Create: `src/assistant/control/policy-control-service.ts`
- Create: `src/assistant/control/validation-queue-service.ts`
- Modify: `src/assistant/assistant-service.ts` (remove `listPolicies`, `setPolicyEnabled`, `deletePolicy`, `blockPolicyTopic`, `listValidationQueue`, `setValidationNotes`, `removeValidationCandidate`; expose `readonly policyControl` and `readonly validation`)
- Modify: `src/status-server/routes/assistant/policy-routes.ts` (call sites)
- Modify: `src/cli/` assistant command call sites — find with `git grep -ln "listValidationQueue\|blockPolicyTopic\|listPolicies" src/cli src/status-server`
- Test: existing `tests/assistant-*` suites covering policies/validation (find with `git grep -l listValidationQueue tests/`)

- [ ] **Step 1: Create `policy-control-service.ts`**

```ts
import type { AssistantPolicyDto } from '@siftkit/contracts';
import type { AssistantGraph } from '../assistant-graph.js';

/** User-facing policy toggles. Callers gate on `enabled` before invoking, same as the facade did. */
export class PolicyControlService {
  constructor(private readonly graph: AssistantGraph, private readonly ownerId: string) {}

  list(): AssistantPolicyDto[] {
    return this.graph.policies.listPolicies(this.ownerId).map((row) => ({
      id: row.id,
      policyType: row.policy_type,
      topicKey: row.key,
      active: row.enabled,
    }));
  }

  setEnabled(policyId: string, enabled: boolean): boolean {
    const policy = this.graph.policies.getPolicyById(this.ownerId, policyId);
    if (policy === null) return false;
    this.graph.policies.setEnabled(this.ownerId, policy.policy_type, policy.key, enabled);
    return true;
  }

  delete(policyId: string): boolean {
    const policy = this.graph.policies.getPolicyById(this.ownerId, policyId);
    if (policy === null) return false;
    this.graph.policies.deletePolicy(this.ownerId, policy.policy_type, policy.key);
    return true;
  }

  blockTopic(topic: string): void {
    this.graph.policies.upsertPolicy({
      ownerId: this.ownerId,
      policyType: 'never_infer_topic',
      key: topic,
      value: { reason: 'CLI user block' },
      enabled: true,
      source: 'user',
    });
  }
}
```

- [ ] **Step 2: Create `validation-queue-service.ts`**

Move the bodies of `listValidationQueue` (assistant-service.ts:470-492), `setValidationNotes` (494-500), `removeValidationCandidate` (502-508) verbatim into methods `list()`, `setNotes(candidateId, notes)`, `remove(candidateId)` on:

```ts
export class ValidationQueueService {
  constructor(private readonly graph: AssistantGraph, private readonly ownerId: string) {}
  ...moved bodies, with `this.ownerId` in place of the facade's `this.ownerId`...
}
```

- [ ] **Step 3: Rewire the facade**

In `AssistantService`: add `readonly policyControl: PolicyControlService;` and `readonly validation: ValidationQueueService;`, construct both in the constructor after `this.graph` exists, and delete the seven moved methods. **Enabled-gating decision:** the deleted facade methods checked `this.enabled` and returned `[]`/`false`/threw. The route layer already 409s when disabled (Task 8's `assistantRoute` gate), and the CLI paths must now check `service.enabled` before calling — verify each CLI call site and add the check where the facade's guard was load-bearing. Do not silently drop a gate: run the existing CLI tests (`npm run test -- assistant-cli`) and route tests to confirm.

- [ ] **Step 4: Update call sites**

`policy-routes.ts`: `service.listPolicies()` → `service.policyControl.list()`, `service.setPolicyEnabled(...)` → `service.policyControl.setEnabled(...)`, `service.deletePolicy(...)` → `service.policyControl.delete(...)`, `service.blockPolicyTopic(...)` → `service.policyControl.blockTopic(...)`, `service.listValidationQueue()` → `service.validation.list()`, `service.setValidationNotes(...)` → `service.validation.setNotes(...)`, `service.removeValidationCandidate(...)` → `service.validation.remove(...)`. Same substitutions in the CLI modules the grep finds.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck` → clean; `npm run build:test && npm run test 2>&1 | tail -8` → 0 fail.

```bash
git add -A && git commit -m "refactor(assistant): extract policy and validation services from the facade"
```

---

## Phase F — Streaming archives (backup / export / restore)

### Task 13: Incremental CRC32 and a file-streaming `ZipFileWriter`

Prereq for Tasks 14-15. The format stays byte-compatible with `lib/zip.ts` (`readZip` and standard tools must read the output). Deterministic timestamps (zero) are preserved.

**Files:**
- Modify: `src/lib/zip.ts` (export an incremental CRC; keep `crc32` as a thin wrapper)
- Create: `src/lib/zip-file-writer.ts`
- Test: `tests/zip-file-writer.test.ts`

- [ ] **Step 1: Write the failing round-trip test**

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readZip } from '../src/lib/zip.js';
import { ZipFileWriter } from '../src/lib/zip-file-writer.js';

test('ZipFileWriter output is readable by readZip and byte-stable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zipw-'));
  const blob = path.join(dir, 'blob.bin');
  fs.writeFileSync(blob, Buffer.alloc(300_000, 7));
  const archivePath = path.join(dir, 'a.zip');
  const writer = new ZipFileWriter(archivePath);
  writer.addBuffer('manifest.json', Buffer.from('{"x":1}', 'utf8'));
  await writer.addFile('blobs/blob.bin', blob);
  writer.finish();
  const entries = readZip(fs.readFileSync(archivePath));
  assert.deepEqual([...entries.keys()].sort(), ['blobs/blob.bin', 'manifest.json']);
  assert.equal(entries.get('blobs/blob.bin')?.byteLength, 300_000);
  assert.equal(entries.get('manifest.json')?.toString('utf8'), '{"x":1}');
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && npm run test -- zip-file-writer` — FAIL: module not found.

- [ ] **Step 3: Refactor `crc32` to expose incremental updates**

In `lib/zip.ts` (table stays as is):

```ts
export function crc32Update(crc: number, data: Buffer): number {
  let next = crc;
  for (const byte of data) {
    next = CRC_TABLE[(next ^ byte) & 0xff] ^ (next >>> 8);
  }
  return next >>> 0;
}

export function crc32(data: Buffer): number {
  return (crc32Update(0xffffffff, data) ^ 0xffffffff) >>> 0;
}
```

Export the format constants too (`LOCAL_HEADER`, `CENTRAL_HEADER`, `EOCD`, `LOCAL_HEADER_SIZE`, `CENTRAL_HEADER_SIZE`, `EOCD_SIZE`) so the writer shares them instead of redefining.

- [ ] **Step 4: Implement `ZipFileWriter`**

`src/lib/zip-file-writer.ts` — STORE-only for file entries (blobs are already encrypted, hence incompressible; deflate of small buffer entries stays available via `addBuffer` which may reuse the in-memory path):

```ts
import fs from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import {
  CENTRAL_HEADER, CENTRAL_HEADER_SIZE, EOCD, EOCD_SIZE,
  LOCAL_HEADER, LOCAL_HEADER_SIZE, crc32, crc32Update,
} from './zip.js';

const READ_CHUNK_BYTES = 1024 * 1024;

interface WrittenEntry {
  readonly name: Buffer;
  readonly crc: number;
  readonly method: 0 | 8;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly offset: number;
}

/**
 * Streams a zip archive to disk entry by entry, holding at most one read chunk in memory.
 * Same format decisions as `ZipWriter`: zero timestamps for determinism, UTF-8 names, no zip64.
 * File entries are STORE (method 0): CRC and size are computed in a chunked pre-pass so no
 * data descriptors are needed and standard readers stay compatible.
 */
export class ZipFileWriter {
  private readonly fd: number;
  private readonly entries: WrittenEntry[] = [];
  private offset = 0;
  private finished = false;

  constructor(private readonly archivePath: string) {
    this.fd = fs.openSync(archivePath, 'w');
  }

  /** Small metadata entries (manifest, key blob): in-memory add, deflated when it helps. */
  addBuffer(name: string, data: Buffer): void {
    const deflated = deflateRawSync(data);
    const useDeflate = deflated.byteLength < data.byteLength;
    const payload = useDeflate ? deflated : data;
    this.writeEntryHeaderAndName(name, crc32(data), useDeflate ? 8 : 0, payload.byteLength, data.byteLength);
    fs.writeSync(this.fd, payload);
    this.offset += payload.byteLength;
  }

  /** Streams an on-disk file as a STORE entry: chunked CRC pass, then chunked copy. */
  async addFile(name: string, sourcePath: string): Promise<void> {
    const size = fs.statSync(sourcePath).size;
    const crc = await this.crcOfFile(sourcePath);
    this.writeEntryHeaderAndName(name, crc, 0, size, size);
    await new Promise<void>((resolve, reject) => {
      const stream = fs.createReadStream(sourcePath, { highWaterMark: READ_CHUNK_BYTES });
      stream.on('data', (chunk) => {
        fs.writeSync(this.fd, chunk);
      });
      stream.on('error', reject);
      stream.on('end', resolve);
    });
    this.offset += size;
  }

  finish(): void {
    if (this.finished) throw new Error('Zip archive already finished.');
    this.finished = true;
    const centralStart = this.offset;
    for (const entry of this.entries) {
      const header = Buffer.alloc(CENTRAL_HEADER_SIZE);
      header.writeUInt32LE(CENTRAL_HEADER, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x0800, 8);
      header.writeUInt16LE(entry.method, 10);
      header.writeUInt32LE(0, 12);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.compressedSize, 20);
      header.writeUInt32LE(entry.uncompressedSize, 24);
      header.writeUInt16LE(entry.name.byteLength, 28);
      header.writeUInt32LE(entry.offset, 42);
      fs.writeSync(this.fd, header);
      fs.writeSync(this.fd, entry.name);
      this.offset += CENTRAL_HEADER_SIZE + entry.name.byteLength;
    }
    const eocd = Buffer.alloc(EOCD_SIZE);
    eocd.writeUInt32LE(EOCD, 0);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(this.offset - centralStart, 12);
    eocd.writeUInt32LE(centralStart, 16);
    fs.writeSync(this.fd, eocd);
    fs.closeSync(this.fd);
  }

  private writeEntryHeaderAndName(
    name: string, crc: number, method: 0 | 8, compressedSize: number, uncompressedSize: number,
  ): void {
    const nameBytes = Buffer.from(name, 'utf8');
    const header = Buffer.alloc(LOCAL_HEADER_SIZE);
    header.writeUInt32LE(LOCAL_HEADER, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(0, 10);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressedSize, 18);
    header.writeUInt32LE(uncompressedSize, 22);
    header.writeUInt16LE(nameBytes.byteLength, 26);
    header.writeUInt16LE(0, 28);
    this.entries.push({
      name: nameBytes, crc, method, compressedSize, uncompressedSize, offset: this.offset,
    });
    fs.writeSync(this.fd, header);
    fs.writeSync(this.fd, nameBytes);
    this.offset += LOCAL_HEADER_SIZE + nameBytes.byteLength;
  }

  private async crcOfFile(sourcePath: string): Promise<number> {
    let crc = 0xffffffff;
    await new Promise<void>((resolve, reject) => {
      const stream = fs.createReadStream(sourcePath, { highWaterMark: READ_CHUNK_BYTES });
      stream.on('data', (chunk) => {
        crc = crc32Update(crc, Buffer.from(chunk));
      });
      stream.on('error', reject);
      stream.on('end', resolve);
    });
    return (crc ^ 0xffffffff) >>> 0;
  }
}
```

(zip64 note: sizes and offsets are 32-bit, same as today's `ZipWriter`. Add a guard: `if (size > 0xfffffffe) throw new Error(...)` in `addFile`, and the same for `this.offset` in `finish` — failing loudly beats writing a corrupt archive.)

- [ ] **Step 5: Run tests, commit**

Run: `npm run build:test && npm run test -- zip` → PASS (new and existing zip tests); `npm run typecheck` → clean.

```bash
git add src/lib/zip.ts src/lib/zip-file-writer.ts tests/zip-file-writer.test.ts
git commit -m "feat(lib): streaming zip file writer with incremental CRC"
```

---

### Task 14: Stream backup and export to temp files; stream the HTTP response

**Files:**
- Modify: `src/assistant/control/backup-service.ts` (`createBackup` returns a temp-file path instead of a Buffer)
- Modify: `src/assistant/control/export-service.ts` (same substitution; read the file first — it uses `ZipWriter` the same way)
- Modify: `src/status-server/routes/assistant/admin-routes.ts` (`backupEndpoint`, `exportEndpoint` stream the file and delete it)
- Test: `tests/assistant-backup-restore.test.ts`, `tests/assistant-export.test.ts` (adapt: they currently consume a Buffer; read the returned file into a Buffer at the test boundary so assertions stay unchanged)

- [ ] **Step 1: Adapt the backup test to the new contract (failing first)**

In `tests/assistant-backup-restore.test.ts`, change the create-side calls from `const bytes = await service.backups.createBackup()` to:

```ts
const archive = await service.backups.createBackup();
const bytes = fs.readFileSync(archive.path);
archive.cleanup();
```

Run: `npm run build:test && npm run test -- assistant-backup` — FAIL (createBackup still returns Buffer).

- [ ] **Step 2: Rewrite `BackupService.createBackup`**

```ts
export interface BackupArchive {
  readonly path: string;
  cleanup(): void;
}

  async createBackup(): Promise<BackupArchive> {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-backup-'));
    const archivePath = path.join(directory, 'backup.zip');
    const snapshotPath = path.join(directory, SNAPSHOT_ENTRY);
    const writer = new ZipFileWriter(archivePath);
    const hashes: Record<string, string> = {};

    await this.database.backup(snapshotPath);
    hashes[SNAPSHOT_ENTRY] = await hashFile(snapshotPath);
    await writer.addFile(SNAPSHOT_ENTRY, snapshotPath);
    fs.rmSync(snapshotPath, { force: true });

    for (const [name, absolute] of this.blobFilePaths()) {
      hashes[name] = await hashFile(absolute);
      await writer.addFile(name, absolute);
    }

    const keyBytes = await dpapiProtect(
      Buffer.from(JSON.stringify(this.keyCustody.exportForBackup()), 'utf8'),
    );
    hashes[KEY_ENTRY] = createHash('sha256').update(keyBytes).digest('hex');
    writer.addBuffer(KEY_ENTRY, keyBytes);

    const manifest: BackupManifest = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAtUtc: this.graph.nowUtc(),
      custody: this.keyCustody.status().custody,
      files: hashes,
    };
    writer.addBuffer(MANIFEST_ENTRY, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
    writer.finish();
    return {
      path: archivePath,
      cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
    };
  }
```

with the two helpers replacing `blobFiles()`:

```ts
  /** Absolute paths of every file under the evidence tree, keyed by archive entry name. */
  private blobFilePaths(): Map<string, string> {
    const root = assistantEvidenceDir(this.graph.runtimeRoot);
    const files = new Map<string, string>();
    if (!fs.existsSync(root)) return files;
    for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const absolute = path.join(entry.parentPath, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      files.set(`${BLOB_PREFIX}${relative}`, absolute);
    }
    return files;
  }
```

```ts
async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}
```

- [ ] **Step 3: Stream the route response**

In `admin-routes.ts`, replace `sendZip(res, await service.backups.createBackup())` with:

```ts
  const archive = await service.backups.createBackup();
  try {
    const size = fs.statSync(archive.path).size;
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': size,
      'Cache-Control': 'no-store',
    });
    await new Promise<void>((resolve, reject) => {
      const stream = fs.createReadStream(archive.path);
      stream.on('error', reject);
      res.on('close', resolve);
      stream.pipe(res);
    });
  } finally {
    archive.cleanup();
  }
```

- [ ] **Step 4: Apply the same substitution to `ExportService`**

Read `src/assistant/control/export-service.ts` (137 lines). It builds a `ZipWriter` and returns `writer.build()`. Change `export(request)` to create a temp dir + `ZipFileWriter`, replace each `writer.add(name, buffer)` with `writer.addBuffer(name, buffer)` for metadata entries and `await writer.addFile(name, absolutePath)` for any entry currently read from disk with `readFileSync` (decrypted blob entries that only exist in memory stay `addBuffer` — decrypt-to-temp would put plaintext on disk, which §16.3 forbids; memory held is then bounded by one blob at a time: restructure the loop so each decrypted buffer is added and released before the next). Return the same `BackupArchive` shape; update `exportEndpoint` identically to Step 3. Adapt `tests/assistant-export.test.ts` at the boundary as in Step 1.

- [ ] **Step 5: Verify and commit**

Run: `npm run build:test && npm run test -- assistant-backup` → PASS; `npm run test -- assistant-export` → PASS; `npm run test 2>&1 | tail -8` → 0 fail; `npm run typecheck` → clean.

```bash
git add -A && git commit -m "perf(assistant): stream backup and export archives via temp files"
```

---

### Task 15: Stream restore uploads to disk and read the archive lazily

The restore-preview route buffers up to 512 MB (`RESTORE_BODY_LIMIT`) via `readBodyBytes`, and `RestoreService` keeps the upload in memory between `preview` and `confirm`.

**Files:**
- Create: `src/lib/zip-file-reader.ts`
- Modify: `src/status-server/http-utils.ts` (add `readBodyToFile`)
- Modify: `src/assistant/control/restore-service.ts` (`preview(archivePath)` instead of `preview(archiveBytes)`; store the temp path, not bytes, against `uploadId`)
- Modify: `src/status-server/routes/assistant/admin-routes.ts` (`restorePreviewEndpoint`)
- Test: `tests/zip-file-reader.test.ts` (new), `tests/assistant-backup-restore.test.ts` (adapt boundary)

- [ ] **Step 1: Write the failing reader test**

```ts
test('ZipFileReader lists entries and extracts them with CRC verification', async () => {
  // build an archive with ZipFileWriter as in the Task 13 test: one buffer entry, one 300 KB file entry
  const reader = ZipFileReader.open(archivePath);
  assert.deepEqual(reader.entryNames().sort(), ['blobs/blob.bin', 'manifest.json']);
  assert.equal(reader.readEntry('manifest.json').toString('utf8'), '{"x":1}');
  const out = path.join(dir, 'restored.bin');
  await reader.extractTo('blobs/blob.bin', out);
  assert.equal(fs.statSync(out).size, 300_000);
  reader.close();
});
```

Run: `npm run build:test && npm run test -- zip-file-reader` — FAIL: module not found.

- [ ] **Step 2: Implement `ZipFileReader`**

`src/lib/zip-file-reader.ts` — central directory parsed once (small); entry payloads read on demand. Deflated entries are inflated in memory (they are metadata-sized); STORE entries stream:

```ts
import fs from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import {
  CENTRAL_HEADER, CENTRAL_HEADER_SIZE, EOCD, EOCD_SIZE,
  LOCAL_HEADER_SIZE, crc32, crc32Update,
} from './zip.js';

const READ_CHUNK_BYTES = 1024 * 1024;
/** The zip comment field is 16-bit, so the EOCD cannot start further back than this. */
const MAX_COMMENT_LENGTH = 65_535;

interface DirectoryEntry {
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly localOffset: number;
}

/** Reads entries of an on-disk archive without loading the archive into memory. */
export class ZipFileReader {
  private constructor(
    private readonly fd: number,
    private readonly directory: ReadonlyMap<string, DirectoryEntry>,
  ) {}

  static open(archivePath: string): ZipFileReader {
    const fd = fs.openSync(archivePath, 'r');
    const size = fs.statSync(archivePath).size;
    const tailLength = Math.min(size, EOCD_SIZE + MAX_COMMENT_LENGTH);
    const tail = Buffer.alloc(tailLength);
    fs.readSync(fd, tail, 0, tailLength, size - tailLength);
    let eocdOffset = -1;
    for (let index = tail.byteLength - EOCD_SIZE; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === EOCD) { eocdOffset = index; break; }
    }
    if (eocdOffset < 0) {
      fs.closeSync(fd);
      throw new Error('Zip end of central directory not found.');
    }
    const entryCount = tail.readUInt16LE(eocdOffset + 10);
    const centralSize = tail.readUInt32LE(eocdOffset + 12);
    const centralStart = tail.readUInt32LE(eocdOffset + 16);
    const central = Buffer.alloc(centralSize);
    fs.readSync(fd, central, 0, centralSize, centralStart);

    const directory = new Map<string, DirectoryEntry>();
    let cursor = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (central.readUInt32LE(cursor) !== CENTRAL_HEADER) {
        fs.closeSync(fd);
        throw new Error('Zip central directory entry is corrupt.');
      }
      const method = central.readUInt16LE(cursor + 10);
      const crc = central.readUInt32LE(cursor + 16);
      const compressedSize = central.readUInt32LE(cursor + 20);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const localOffset = central.readUInt32LE(cursor + 42);
      const name = central
        .subarray(cursor + CENTRAL_HEADER_SIZE, cursor + CENTRAL_HEADER_SIZE + nameLength)
        .toString('utf8');
      if (method !== 0 && method !== 8) {
        fs.closeSync(fd);
        throw new Error(`Zip entry ${name} uses unsupported compression method ${method}.`);
      }
      directory.set(name, { method, crc, compressedSize, localOffset });
      cursor += CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;
    }
    return new ZipFileReader(fd, directory);
  }

  entryNames(): string[] {
    return [...this.directory.keys()];
  }

  /** In-memory read for metadata-sized entries; CRC-verified like `readZip`. */
  readEntry(name: string): Buffer {
    const entry = this.requireEntry(name);
    const compressed = Buffer.alloc(entry.compressedSize);
    fs.readSync(this.fd, compressed, 0, entry.compressedSize, this.dataStart(name, entry));
    const data = entry.method === 8 ? inflateRawSync(compressed) : compressed;
    if (crc32(data) !== entry.crc) {
      throw new Error(`Zip entry ${name} failed its CRC check.`);
    }
    return data;
  }

  /** Chunked extraction for STORE entries; CRC verified over the stream. */
  async extractTo(name: string, destinationPath: string): Promise<void> {
    const entry = this.requireEntry(name);
    if (entry.method !== 0) {
      fs.writeFileSync(destinationPath, this.readEntry(name));
      return;
    }
    const start = this.dataStart(name, entry);
    const out = fs.openSync(destinationPath, 'w');
    let crc = 0xffffffff;
    try {
      let position = 0;
      const chunk = Buffer.alloc(READ_CHUNK_BYTES);
      while (position < entry.compressedSize) {
        const toRead = Math.min(READ_CHUNK_BYTES, entry.compressedSize - position);
        fs.readSync(this.fd, chunk, 0, toRead, start + position);
        const view = chunk.subarray(0, toRead);
        crc = crc32Update(crc, view);
        fs.writeSync(out, view);
        position += toRead;
      }
    } finally {
      fs.closeSync(out);
    }
    if (((crc ^ 0xffffffff) >>> 0) !== entry.crc) {
      fs.rmSync(destinationPath, { force: true });
      throw new Error(`Zip entry ${name} failed its CRC check.`);
    }
  }

  close(): void {
    fs.closeSync(this.fd);
  }

  private requireEntry(name: string): DirectoryEntry {
    const entry = this.directory.get(name);
    if (entry === undefined) throw new Error(`Zip archive has no entry named ${name}.`);
    return entry;
  }

  private dataStart(name: string, entry: DirectoryEntry): number {
    const local = Buffer.alloc(LOCAL_HEADER_SIZE);
    fs.readSync(this.fd, local, 0, LOCAL_HEADER_SIZE, entry.localOffset);
    const nameLength = local.readUInt16LE(26);
    const extraLength = local.readUInt16LE(28);
    return entry.localOffset + LOCAL_HEADER_SIZE + nameLength + extraLength;
  }
}
```

- [ ] **Step 3: Add `readBodyToFile` to `http-utils.ts`**

Alongside `readBodyBytes` (mirror its max-bytes accounting and `RequestBodyTooLargeError`):

```ts
/** Streams a request body to a file, enforcing the byte ceiling without buffering the body. */
export async function readBodyToFile(
  req: IncomingMessage,
  destinationPath: string,
  options: { readonly maxBytes: number },
): Promise<void> {
  const out = fs.openSync(destinationPath, 'w');
  let received = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      req.on('data', (chunk: Buffer) => {
        received += chunk.byteLength;
        if (received > options.maxBytes) {
          reject(new RequestBodyTooLargeError(options.maxBytes));
          req.destroy();
          return;
        }
        fs.writeSync(out, chunk);
      });
      req.on('error', reject);
      req.on('end', resolve);
    });
  } finally {
    fs.closeSync(out);
  }
}
```

(Match the actual `RequestBodyTooLargeError` constructor signature in `http-utils.ts` — read it first.)

- [ ] **Step 4: Convert `RestoreService` and the route**

Read `src/assistant/control/restore-service.ts` (263 lines) and apply this contract change:
- `preview(archiveBytes: Buffer)` → `preview(archivePath: string)`. Where it currently calls `readZip(archiveBytes)`, use `ZipFileReader.open(archivePath)`; manifest and key entries via `reader.readEntry(...)`; hash verification of large entries via a chunked hash over `extractTo`'d files or by hashing during extraction — mirror what `confirm` needs.
- The upload registry keyed by `uploadId` stores the temp file path (plus the reader's parsed manifest), not the bytes. `confirm(uploadId, confirmToken)` extracts `SNAPSHOT_ENTRY` and blobs to their destinations with `extractTo`, then deletes the temp file in a `finally`. Expired/replaced uploads must also delete their temp files — find the existing eviction path and add cleanup there.
- Route: `restorePreviewEndpoint` writes the body to `fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-restore-'))/upload.zip` via `readBodyToFile` with the existing `RESTORE_BODY_LIMIT`, then calls `service.previewRestore(uploadPath)`.
- `AssistantService.previewRestore(archiveBytes: Buffer)` (assistant-service.ts:693-695) changes signature to `previewRestore(archivePath: string)` accordingly.

Adapt `tests/assistant-backup-restore.test.ts` at the boundary: where it passed a Buffer to preview, write that Buffer to a temp file and pass the path. Assertions unchanged.

- [ ] **Step 5: Verify and commit**

Run: `npm run build:test && npm run test -- zip-file-reader` → PASS; `npm run test -- assistant-backup` → PASS; `npm run test 2>&1 | tail -8` → 0 fail; `npm run typecheck` → clean.

```bash
git add -A && git commit -m "perf(assistant): restore uploads stream to disk and read the archive lazily"
```

---

## Final gate

- [ ] Run `npm run typecheck` → clean; `npm run test 2>&1 | tail -8` → 0 fail, baseline 2 skipped; `npm run test:dashboard` if dashboard files were touched.
- [ ] `git log --oneline` shows one commit per task; `git status` clean.
- [ ] Update `ARCHITECTURE-REVIEW.md` only if any L-item was incidentally resolved (none are expected to be).

## Non-goals (deliberately out of scope)

- **ARCHITECTURE-REVIEW.md L1–L11** (LLM-behavior debts: transcript mutation, finish policy, chat condense, sampling ownership). Independent subsystem with its own risk profile — needs its own plan; the review file itself demands re-verification against current code first.
- **Worker-thread offload of assistant maintenance.** Task 7's instrumentation exists to decide this with data; building it now is speculative.
- **Pagination of `/assistant/policies`.** Policy rows are user-created and few; the by-id fix (Task 3) removes the real cost. Validation-queue pagination is likewise deferred — its unbounded route read became bounded in practice once `status()` stopped materializing it; paginate only if the dashboard shows real queues beyond a few hundred rows.
- **tsconfig consolidation** (6 root tsconfigs) — cosmetic, high churn, no scalability payoff.

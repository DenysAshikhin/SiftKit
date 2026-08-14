# Assistant Performance Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the seven benchmarked O(n) hot spots in the assistant subsystem: FTS full-scan deletes (F1), unbounded N+1 memory history (F2), unindexed activity heartbeat lookups (F3), missing evidence-cascade indexes (F4), quadratic re-tokenization (F5), missing audit index (F6), and the unindexed capture dedupe lookup (F11), plus the view-builder N+1 (F7).

**Architecture:** One schema migration (v46) adds every missing index and an `fts_rowid INTEGER` column to `graph_nodes`, `graph_assertions`, and `memory_projections` so FTS rows are deleted by rowid (indexed) instead of by UNINDEXED column (full scan). Store-level batch fetches (`getNodes`, `getAssertions`) and `AssertionViewBuilder.buildMany` replace per-row lookups on the hot paths. Token counting in `MemoryRetriever` and `TokenLimitEnforcer` switches from cumulative recounting (O(n) tokenizer calls, O(n²) characters) to binary search over a monotone prefix/drop count (O(log n) calls).

**Tech Stack:** TypeScript (ESM, zod-validated IO), better-sqlite3 with SQLite fts5, node:test via `npm test <file>`.

**Repo notes for the executor:**
- The working tree already has uncommitted changes in `src/assistant/graph/neighborhood.ts`, `src/assistant/storage/assertion-store.ts`, `src/assistant/storage/schema.ts`, `src/state/runtime-db.ts`, and two test files. Build on top of them; do not revert them.
- Line numbers below refer to the current working-tree state and may drift a few lines as earlier tasks land; anchor on the quoted code, not the number.
- Run a single test file with `npm test tests/<name>.test.ts` (the runner compiles first). Full verification happens in Task 10.
- Per AGENTS.md, commits require the user's go-ahead. Each task ends with a commit step; if the user has not authorized commits for this execution, leave changes staged and report instead.

---

### Task 1: Schema v46 — missing indexes, `fts_rowid` columns, backfill

**Files:**
- Modify: `src/assistant/storage/schema.ts` (schema SQL constants; new exported `backfillAssistantFtsRowids`)
- Modify: `src/state/runtime-db.ts` (`CURRENT_SCHEMA_VERSION`, new `< 46` migration block)
- Modify: `src/assistant/storage/rows.ts` (`NodeRowSchema`, `AssertionRowSchema`, `ProjectionRowSchema`)
- Test: `tests/assistant-migration.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/assistant-migration.test.ts` (the file already imports `withAssistantContext`, `z`, `assert`, `NameRowSchema`, `ColumnRowSchema`; add `backfillAssistantFtsRowids` to the existing import from `../src/assistant/storage/schema.js`):

```ts
test('v46 adds the hot-path indexes and fts_rowid columns', () => {
  withAssistantContext(({ database }) => {
    const indexes = NameRowSchema.parse(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index'",
    ).all()).map((row) => row.name);
    for (const expected of [
      'assertion_evidence_evidence_idx',
      'evidence_blob_ref_idx',
      'assistant_audit_events_owner_time_idx',
      'graph_mutation_owner_time_idx',
      'assistant_activity_events_session_idx',
      'assistant_activity_sessions_open_idx',
      'assistant_capture_queue_pixel_idx',
    ]) {
      assert.ok(indexes.includes(expected), `missing index ${expected}`);
    }
    for (const table of ['graph_nodes', 'graph_assertions', 'memory_projections']) {
      const columns = ColumnRowSchema.parse(
        database.prepare(`SELECT name FROM pragma_table_info('${table}')`).all(),
      ).map((row) => row.name);
      assert.ok(columns.includes('fts_rowid'), `${table} missing fts_rowid`);
    }
  });
});

test('hot-path lookups use the v46 indexes', () => {
  withAssistantContext(({ database }) => {
    const plans: Array<{ sql: string; index: string }> = [
      {
        sql: "SELECT DISTINCT assertion_id FROM assertion_evidence WHERE evidence_id = 'x'",
        index: 'assertion_evidence_evidence_idx',
      },
      {
        sql: "SELECT COUNT(*) FROM evidence_records WHERE blob_id = 'x' AND status NOT IN ('deleted','expired')",
        index: 'evidence_blob_ref_idx',
      },
      {
        sql: "SELECT * FROM assistant_audit_events WHERE owner_id = 'x' ORDER BY created_at_utc DESC, id DESC LIMIT 50",
        index: 'assistant_audit_events_owner_time_idx',
      },
      {
        sql: "SELECT * FROM graph_mutation_log WHERE owner_id = 'x' ORDER BY created_at_utc DESC, id DESC LIMIT 50",
        index: 'graph_mutation_owner_time_idx',
      },
      {
        sql: "SELECT captured_at_utc FROM assistant_activity_events WHERE session_id = 'x' ORDER BY captured_at_utc DESC, id DESC LIMIT 1",
        index: 'assistant_activity_events_session_idx',
      },
      {
        sql: "SELECT * FROM assistant_activity_sessions WHERE owner_id = 'x' AND ended_at_utc IS NULL ORDER BY started_at_utc DESC, id DESC LIMIT 1",
        index: 'assistant_activity_sessions_open_idx',
      },
      {
        sql: "SELECT * FROM assistant_capture_queue WHERE owner_id = 'x' AND pixel_sha256 = 'y' AND enqueued_at_utc >= 'z' ORDER BY enqueued_at_utc DESC LIMIT 1",
        index: 'assistant_capture_queue_pixel_idx',
      },
    ];
    for (const { sql, index } of plans) {
      const detail = z.array(z.object({ detail: z.string() })).parse(
        database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(),
      ).map((row) => row.detail).join(' | ');
      assert.ok(detail.includes(index), `expected ${index} in plan: ${detail}`);
    }
  });
});

test('backfillAssistantFtsRowids repopulates fts_rowid from existing FTS rows', () => {
  withAssistantContext(({ database, graph, ownerId }) => {
    const node = graph.nodes.createNode({
      ownerId, type: 'software', canonicalKey: null, displayName: 'Backfill Target',
      description: null, sensitivity: 'personal', properties: {},
    });
    database.prepare('UPDATE graph_nodes SET fts_rowid = NULL WHERE id = ?').run(node.id);
    backfillAssistantFtsRowids(database);
    const stored = z.object({ fts_rowid: z.number().int() }).parse(
      database.prepare('SELECT fts_rowid FROM graph_nodes WHERE id = ?').get(node.id),
    );
    const ftsRow = z.object({ rowid: z.number().int() }).parse(
      database.prepare('SELECT rowid FROM graph_nodes_fts WHERE node_id = ?').get(node.id),
    );
    assert.equal(stored.fts_rowid, ftsRow.rowid);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test tests/assistant-migration.test.ts`
Expected: FAIL — missing indexes/columns, and `backfillAssistantFtsRowids` is not exported.

- [ ] **Step 3: Add the columns and indexes to the schema constants**

In `src/assistant/storage/schema.ts`:

3a. In `ASSISTANT_CORE_SCHEMA_SQL`, `graph_nodes` table — change the last column line:

```sql
    updated_at_utc TEXT NOT NULL,
    deleted_at_utc TEXT,
    fts_rowid INTEGER
```

3b. Same constant, `graph_assertions` table — add the column immediately before the table-level `CHECK (`:

```sql
    created_at_utc TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL,
    fts_rowid INTEGER,
    CHECK (
```

3c. Same constant — add after the existing `graph_mutation_target_idx` index:

```sql
CREATE INDEX IF NOT EXISTS graph_mutation_owner_time_idx
  ON graph_mutation_log(owner_id, created_at_utc DESC, id DESC);
```

3d. Same constant — add after the `assertion_evidence` table definition:

```sql
CREATE INDEX IF NOT EXISTS assertion_evidence_evidence_idx
  ON assertion_evidence(evidence_id);
```

3e. Same constant — add after the existing `evidence_retention_idx`:

```sql
CREATE INDEX IF NOT EXISTS evidence_blob_ref_idx
  ON evidence_records(blob_id) WHERE blob_id IS NOT NULL;
```

3f. Same constant — add after the `assistant_audit_events` table definition (it currently has no index):

```sql
CREATE INDEX IF NOT EXISTS assistant_audit_events_owner_time_idx
  ON assistant_audit_events(owner_id, created_at_utc DESC, id DESC);
```

3g. In `ASSISTANT_MEMORY_SCHEMA_SQL`, `memory_projections` table — add the column before the `UNIQUE` constraint:

```sql
    status TEXT NOT NULL CHECK (status IN ('active', 'demoted', 'archived', 'deleted')),
    fts_rowid INTEGER,
    UNIQUE(owner_id, tier, topic_key)
```

3h. In `ASSISTANT_DESKTOP_SCHEMA_SQL` — add after `assistant_activity_events_time_idx`:

```sql
CREATE INDEX IF NOT EXISTS assistant_activity_events_session_idx
  ON assistant_activity_events(session_id, captured_at_utc DESC, id DESC);
```

3i. Same constant — add after the `assistant_activity_sessions` table definition:

```sql
CREATE INDEX IF NOT EXISTS assistant_activity_sessions_open_idx
  ON assistant_activity_sessions(owner_id, started_at_utc DESC, id DESC)
  WHERE ended_at_utc IS NULL;
```

3j. Same constant — add after `assistant_capture_queue_dedupe_idx`:

```sql
CREATE INDEX IF NOT EXISTS assistant_capture_queue_pixel_idx
  ON assistant_capture_queue(owner_id, pixel_sha256, enqueued_at_utc DESC);
```

3k. Add the backfill helper at the bottom of `schema.ts` (after `seedAssistantRegistries`):

```ts
/**
 * v46 backfill: records each FTS row's rowid on its canonical row so deletes can address the
 * FTS index by rowid instead of scanning an UNINDEXED column. Content-preserving — FTS text is
 * caller-rendered at write time and is not rebuilt here.
 */
export function backfillAssistantFtsRowids(database: RuntimeDatabase): void {
  const targets = [
    { table: 'graph_nodes', fts: 'graph_nodes_fts', idColumn: 'node_id' },
    { table: 'graph_assertions', fts: 'graph_assertions_fts', idColumn: 'assertion_id' },
    { table: 'memory_projections', fts: 'memory_projections_fts', idColumn: 'projection_id' },
  ] as const;
  for (const target of targets) {
    database.exec(`
      CREATE TEMP TABLE fts_backfill AS
        SELECT rowid AS fts_rowid, ${target.idColumn} AS row_id FROM ${target.fts};
      CREATE INDEX fts_backfill_idx ON fts_backfill(row_id);
      UPDATE ${target.table} SET fts_rowid =
        (SELECT fts_rowid FROM fts_backfill WHERE row_id = ${target.table}.id);
      DROP TABLE fts_backfill;
    `);
  }
}
```

- [ ] **Step 4: Add the v46 migration block and bump the version**

In `src/state/runtime-db.ts`:

4a. Change `export const CURRENT_SCHEMA_VERSION = 45;` to `46`.

4b. Add `backfillAssistantFtsRowids` to the existing import from `'../assistant/storage/schema.js'`.

4c. After the `if (currentVersion < 45) { ... }` block in `ensureSchema`, add:

```ts
  if (currentVersion < 46) {
    for (const table of ['graph_nodes', 'graph_assertions', 'memory_projections'] as const) {
      if (!tableHasColumn(database, table, 'fts_rowid')) {
        database.exec(`ALTER TABLE ${table} ADD COLUMN fts_rowid INTEGER;`);
      }
    }
    database.exec(ASSISTANT_CORE_SCHEMA_SQL);
    database.exec(ASSISTANT_MEMORY_SCHEMA_SQL);
    database.exec(ASSISTANT_DESKTOP_SCHEMA_SQL);
    backfillAssistantFtsRowids(database);
    setSchemaVersion(database, 46);
    currentVersion = 46;
  }
```

(The schema constants are idempotent — `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` — so re-executing them on an existing database only adds the new indexes; this is the same pattern the v45 step uses.)

- [ ] **Step 5: Extend the row schemas**

In `src/assistant/storage/rows.ts`, add to `NodeRowSchema`, `AssertionRowSchema`, and `ProjectionRowSchema` (each as the last field):

```ts
  fts_rowid: z.number().int().nullable(),
```

- [ ] **Step 6: Update the two stale version assertions**

Two pre-existing tests in `tests/assistant-migration.test.ts` pin the schema version: `'a v44 database gains the assertion recency indexes when it migrates forward'` and `'re-running the v45 migration is a no-op'` both end with `assert.equal(version, 45);`. A database reopened after this change lands on 46, so change both assertions to compare against the imported constant instead of the literal:

```ts
  assert.equal(version, CURRENT_SCHEMA_VERSION);
```

(`CURRENT_SCHEMA_VERSION` is already imported at the top of the file.)

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test tests/assistant-migration.test.ts`
Expected: PASS (all pre-existing migration tests plus the three new ones).

- [ ] **Step 8: Commit**

```bash
git add src/assistant/storage/schema.ts src/state/runtime-db.ts src/assistant/storage/rows.ts tests/assistant-migration.test.ts
git commit -m "feat(assistant): schema v46 hot-path indexes and fts_rowid columns"
```

---

### Task 2: NodeStore — delete FTS rows by rowid

**Files:**
- Modify: `src/assistant/storage/node-store.ts:251-261` (`refreshFts`)
- Test: `tests/assistant-fts-rowid.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/assistant-fts-rowid.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { withAssistantContext } from './helpers/assistant-fixture.js';

const FtsRowidSchema = z.object({ fts_rowid: z.number().int().nullable() });
const CountSchema = z.object({ count: z.number() });

test('node FTS rows are tracked by rowid across create, update, and de-index', () => {
  withAssistantContext(({ database, graph, ownerId }) => {
    const node = graph.nodes.createNode({
      ownerId, type: 'software', canonicalKey: null, displayName: 'Rowid Tool',
      description: null, sensitivity: 'personal', properties: {},
    });
    const afterCreate = FtsRowidSchema.parse(
      database.prepare('SELECT fts_rowid FROM graph_nodes WHERE id = ?').get(node.id),
    );
    assert.notEqual(afterCreate.fts_rowid, null, 'create must record the FTS rowid');
    assert.deepEqual(graph.nodes.searchNodes(ownerId, 'Rowid', 10), [node.id]);

    graph.nodes.updateNode(node.id, { displayName: 'Renamed Tool' });
    assert.deepEqual(graph.nodes.searchNodes(ownerId, 'Renamed', 10), [node.id]);
    assert.deepEqual(graph.nodes.searchNodes(ownerId, 'Rowid', 10), []);

    graph.nodes.updateNode(node.id, { sensitivity: 'sensitive' });
    const afterDeindex = FtsRowidSchema.parse(
      database.prepare('SELECT fts_rowid FROM graph_nodes WHERE id = ?').get(node.id),
    );
    assert.equal(afterDeindex.fts_rowid, null, 'de-indexed node must clear fts_rowid');
    const remaining = CountSchema.parse(database.prepare(
      'SELECT COUNT(*) AS count FROM graph_nodes_fts WHERE node_id = ?',
    ).get(node.id));
    assert.equal(remaining.count, 0, 'no orphaned FTS row may remain');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test tests/assistant-fts-rowid.test.ts`
Expected: FAIL — `afterCreate.fts_rowid` is null (old `refreshFts` never writes it).

- [ ] **Step 3: Replace `NodeStore.refreshFts`**

In `src/assistant/storage/node-store.ts`, replace the whole `refreshFts` method:

```ts
  /**
   * Rewrites the node's FTS row from its current canonical state. Called after every write that
   * changes indexed text, status, or sensitivity, inside the caller's transaction. The FTS row
   * is addressed by the rowid recorded in `graph_nodes.fts_rowid` — deleting by the UNINDEXED
   * `node_id` column would scan the whole FTS table.
   */
  private refreshFts(nodeId: string): void {
    const node = this.getNode(nodeId);
    if (node === null) return;
    if (node.fts_rowid !== null) {
      this.database.prepare('DELETE FROM graph_nodes_fts WHERE rowid = ?').run(node.fts_rowid);
      this.database.prepare('UPDATE graph_nodes SET fts_rowid = NULL WHERE id = ?').run(nodeId);
    }
    if (node.status !== 'active') return;
    if (!isIndexableInPlaintext(node.sensitivity)) return;
    const aliases = this.listAliases(nodeId).map((alias) => alias.alias).join(' ');
    const inserted = this.database.prepare(`
      INSERT INTO graph_nodes_fts (node_id, owner_id, display_name, aliases, description)
      VALUES (?, ?, ?, ?, ?)
    `).run(nodeId, node.owner_id, node.display_name, aliases, node.description ?? '');
    this.database.prepare('UPDATE graph_nodes SET fts_rowid = ? WHERE id = ?')
      .run(inserted.lastInsertRowid, nodeId);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test tests/assistant-fts-rowid.test.ts` then `npm test tests/assistant-entity-resolution.test.ts tests/assistant-memory-query-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/assistant/storage/node-store.ts tests/assistant-fts-rowid.test.ts
git commit -m "perf(assistant): node FTS refresh deletes by rowid, not full scan"
```

---

### Task 3: AssertionStore — delete FTS rows by rowid

**Files:**
- Modify: `src/assistant/storage/assertion-store.ts:206-214` (`retireAssertion`) and `:400-413` (`refreshFts`)
- Test: `tests/assistant-fts-rowid.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/assistant-fts-rowid.test.ts`:

```ts
test('assertion FTS rows are tracked by rowid across create and retire', () => {
  withAssistantContext(({ database, graph, ownerId }) => {
    const subject = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: null, displayName: 'Subject',
      description: null, sensitivity: 'personal', properties: {},
    });
    const object = graph.nodes.createNode({
      ownerId, type: 'software', canonicalKey: null, displayName: 'Object Tool',
      description: null, sensitivity: 'personal', properties: {},
    });
    const assertion = graph.assertions.createAssertion({
      ownerId, subjectNodeId: subject.id, predicate: 'USES',
      object: { kind: 'node', nodeId: object.id }, scopeNodeId: null,
      status: 'active', basis: 'explicit_user_statement', confidence: 0.9,
      sensitivity: 'personal', validFromUtc: null, validToUtc: null,
      observedAtUtc: '2026-08-05T09:00:00.000Z', supersedesAssertionId: null,
      pinned: false, attributes: {},
      searchText: { subject: 'Subject', predicate: 'uses', object: 'Object Tool', scope: '' },
    });
    assert.notEqual(assertion.fts_rowid, null, 'create must record the FTS rowid');
    assert.deepEqual(graph.assertions.searchAssertions(ownerId, 'Object', 10), [assertion.id]);

    const retired = graph.assertions.retireAssertion(assertion.id, 'superseded');
    assert.equal(retired.fts_rowid, null, 'retire must clear fts_rowid');
    const remaining = CountSchema.parse(database.prepare(
      'SELECT COUNT(*) AS count FROM graph_assertions_fts WHERE assertion_id = ?',
    ).get(assertion.id));
    assert.equal(remaining.count, 0, 'retire must remove the FTS row');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test tests/assistant-fts-rowid.test.ts`
Expected: FAIL — `assertion.fts_rowid` is null.

- [ ] **Step 3: Replace `retireAssertion` and `refreshFts`**

In `src/assistant/storage/assertion-store.ts`, replace `retireAssertion`:

```ts
  /** Moves an assertion out of the live set, freeing its assertion key. */
  retireAssertion(assertionId: string, status: AssertionStatus): AssertionRow {
    const existing = this.requireAssertion(assertionId);
    const nowUtc = this.clock.nowUtc();
    this.database.prepare(`
      UPDATE graph_assertions
      SET status = ?, retired_at_utc = ?, updated_at_utc = ? WHERE id = ?
    `).run(status, nowUtc, nowUtc, assertionId);
    if (existing.fts_rowid !== null) {
      this.database
        .prepare('DELETE FROM graph_assertions_fts WHERE rowid = ?')
        .run(existing.fts_rowid);
      this.database
        .prepare('UPDATE graph_assertions SET fts_rowid = NULL WHERE id = ?')
        .run(assertionId);
    }
    return this.requireAssertion(assertionId);
  }
```

and replace `refreshFts`:

```ts
  private refreshFts(assertionId: string, searchText: AssertionSearchText): void {
    const assertion = this.requireAssertion(assertionId);
    if (assertion.fts_rowid !== null) {
      this.database
        .prepare('DELETE FROM graph_assertions_fts WHERE rowid = ?')
        .run(assertion.fts_rowid);
      this.database
        .prepare('UPDATE graph_assertions SET fts_rowid = NULL WHERE id = ?')
        .run(assertionId);
    }
    if (!LIVE_ASSERTION_STATUSES.includes(assertion.status)) return;
    if (!isIndexableInPlaintext(assertion.sensitivity)) return;
    const inserted = this.database.prepare(`
      INSERT INTO graph_assertions_fts (
        assertion_id, owner_id, subject_text, predicate_text, object_text, scope_text
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      assertionId, assertion.owner_id, searchText.subject, searchText.predicate,
      searchText.object, searchText.scope,
    );
    this.database.prepare('UPDATE graph_assertions SET fts_rowid = ? WHERE id = ?')
      .run(inserted.lastInsertRowid, assertionId);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test tests/assistant-fts-rowid.test.ts tests/assistant-assertion-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/assistant/storage/assertion-store.ts tests/assistant-fts-rowid.test.ts
git commit -m "perf(assistant): assertion FTS refresh and retire delete by rowid"
```

---

### Task 4: ProjectionStore — delete FTS rows by rowid

**Files:**
- Modify: `src/assistant/storage/projection-store.ts:155-159` (`deleteProjection`) and `:172-182` (`refreshFts`)
- Test: `tests/assistant-fts-rowid.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/assistant-fts-rowid.test.ts`:

```ts
test('projection FTS rows are tracked by rowid across upsert, status change, and delete', () => {
  withAssistantContext(({ database, graph, ownerId }) => {
    const projection = graph.projections.upsert({
      ownerId, tier: 2, topicKey: 'rowid-topic', title: 'Rowid Topic',
      content: 'body about unusual rowid topics', contentHash: 'hash-1',
      tokenCount: 8, tokenizerId: 'estimate', graphVersion: 1,
      includedAssertionIds: [], sensitivity: 'personal',
    });
    assert.notEqual(projection.fts_rowid, null, 'upsert must record the FTS rowid');
    assert.deepEqual(graph.projections.search(ownerId, 'unusual', 10), [projection.id]);

    const archived = graph.projections.setStatus(projection.id, 'archived');
    assert.equal(archived.fts_rowid, null, 'non-active projection must clear fts_rowid');
    assert.deepEqual(graph.projections.search(ownerId, 'unusual', 10), []);

    graph.projections.setStatus(projection.id, 'active');
    graph.projections.deleteProjection(projection.id);
    const remaining = CountSchema.parse(database.prepare(
      'SELECT COUNT(*) AS count FROM memory_projections_fts WHERE projection_id = ?',
    ).get(projection.id));
    assert.equal(remaining.count, 0, 'delete must remove the FTS row');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test tests/assistant-fts-rowid.test.ts`
Expected: FAIL — `projection.fts_rowid` is null.

- [ ] **Step 3: Replace `deleteProjection` and `refreshFts`**

In `src/assistant/storage/projection-store.ts`, replace `deleteProjection`:

```ts
  deleteProjection(projectionId: string): void {
    const row = this.getProjection(projectionId);
    if (row !== null && row.fts_rowid !== null) {
      this.database
        .prepare('DELETE FROM memory_projections_fts WHERE rowid = ?')
        .run(row.fts_rowid);
    }
    this.database.prepare('DELETE FROM memory_projections WHERE id = ?').run(projectionId);
  }
```

and replace `refreshFts`:

```ts
  /** Rewrites the FTS row from canonical state. Sensitive projections are never indexed (§5.3). */
  private refreshFts(projectionId: string): void {
    const row = this.getProjection(projectionId);
    if (row === null) return;
    if (row.fts_rowid !== null) {
      this.database
        .prepare('DELETE FROM memory_projections_fts WHERE rowid = ?')
        .run(row.fts_rowid);
      this.database
        .prepare('UPDATE memory_projections SET fts_rowid = NULL WHERE id = ?')
        .run(projectionId);
    }
    if (row.status !== 'active') return;
    if (!isIndexableInPlaintext(row.sensitivity)) return;
    const inserted = this.database.prepare(`
      INSERT INTO memory_projections_fts (projection_id, owner_id, tier, topic_key, content)
      VALUES (?, ?, ?, ?, ?)
    `).run(row.id, row.owner_id, row.tier, row.topic_key, row.content);
    this.database.prepare('UPDATE memory_projections SET fts_rowid = ? WHERE id = ?')
      .run(inserted.lastInsertRowid, projectionId);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test tests/assistant-fts-rowid.test.ts tests/assistant-projection-store.test.ts tests/assistant-projection-reconciler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/assistant/storage/projection-store.ts tests/assistant-fts-rowid.test.ts
git commit -m "perf(assistant): projection FTS refresh and delete address rows by rowid"
```

---

### Task 5: Batch fetches — `getNodes`, `getAssertions`, `buildMany`

**Files:**
- Modify: `src/assistant/storage/node-store.ts` (add `getNodes`)
- Modify: `src/assistant/storage/assertion-store.ts` (add `getAssertions`)
- Modify: `src/assistant/projections/assertion-view-builder.ts` (add `buildMany`, rework `build`)
- Test: `tests/assistant-view-builder-batch.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/assistant-view-builder-batch.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { AssertionViewBuilder } from '../src/assistant/projections/assertion-view-builder.js';
import { withAssistantContext } from './helpers/assistant-fixture.js';

test('buildMany resolves node references in one batch and matches build', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const subject = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: null, displayName: 'The User',
      description: null, sensitivity: 'personal', properties: {},
    });
    const rows = [0, 1, 2].map((index) => {
      const object = graph.nodes.createNode({
        ownerId, type: 'software', canonicalKey: null, displayName: `Batch Tool ${index}`,
        description: null, sensitivity: 'personal', properties: {},
      });
      return graph.assertions.createAssertion({
        ownerId, subjectNodeId: subject.id, predicate: 'USES',
        object: { kind: 'node', nodeId: object.id }, scopeNodeId: null,
        status: 'active', basis: 'explicit_user_statement', confidence: 0.9,
        sensitivity: 'personal', validFromUtc: null, validToUtc: null,
        observedAtUtc: '2026-08-05T09:00:00.000Z', supersedesAssertionId: null,
        pinned: false, attributes: {},
        searchText: { subject: 'The User', predicate: 'uses', object: `Batch Tool ${index}`, scope: '' },
      });
    });
    const views = new AssertionViewBuilder(graph);
    const batch = views.buildMany(rows);
    assert.equal(batch.length, rows.length);
    for (const [index, row] of rows.entries()) {
      assert.deepEqual(batch[index], views.build(row));
    }
  });
});

test('buildMany fails loudly on a missing node reference', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const subject = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: null, displayName: 'The User',
      description: null, sensitivity: 'personal', properties: {},
    });
    const object = graph.nodes.createNode({
      ownerId, type: 'software', canonicalKey: null, displayName: 'Tool',
      description: null, sensitivity: 'personal', properties: {},
    });
    const row = graph.assertions.createAssertion({
      ownerId, subjectNodeId: subject.id, predicate: 'USES',
      object: { kind: 'node', nodeId: object.id }, scopeNodeId: null,
      status: 'active', basis: 'explicit_user_statement', confidence: 0.9,
      sensitivity: 'personal', validFromUtc: null, validToUtc: null,
      observedAtUtc: '2026-08-05T09:00:00.000Z', supersedesAssertionId: null,
      pinned: false, attributes: {},
      searchText: { subject: 'The User', predicate: 'uses', object: 'Tool', scope: '' },
    });
    const views = new AssertionViewBuilder(graph);
    const broken = { ...row, subject_node_id: 'node_missing' };
    assert.throws(() => views.buildMany([broken]), /Unknown graph node: node_missing/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test tests/assistant-view-builder-batch.test.ts`
Expected: FAIL — `buildMany` does not exist.

- [ ] **Step 3: Add `NodeStore.getNodes`**

In `src/assistant/storage/node-store.ts`, add after `requireNode`:

```ts
  /** SQLite's default parameter cap is 999; stay far under it per chunk. */
  private static readonly ID_CHUNK = 400;

  /** Batch fetch by id, deduplicated. Missing ids are simply absent from the result. */
  getNodes(nodeIds: readonly string[]): Map<string, NodeRow> {
    const found = new Map<string, NodeRow>();
    const unique = [...new Set(nodeIds)];
    for (let start = 0; start < unique.length; start += NodeStore.ID_CHUNK) {
      const chunk = unique.slice(start, start + NodeStore.ID_CHUNK);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = z.array(NodeRowSchema).parse(this.database.prepare(
        `SELECT * FROM graph_nodes WHERE id IN (${placeholders})`,
      ).all(...chunk));
      for (const row of rows) found.set(row.id, row);
    }
    return found;
  }
```

- [ ] **Step 4: Add `AssertionStore.getAssertions`**

In `src/assistant/storage/assertion-store.ts`, add after `requireAssertion`:

```ts
  /** SQLite's default parameter cap is 999; stay far under it per chunk. */
  private static readonly ID_CHUNK = 400;

  /** Batch fetch by id, deduplicated. Missing ids are simply absent from the result. */
  getAssertions(assertionIds: readonly string[]): Map<string, AssertionRow> {
    const found = new Map<string, AssertionRow>();
    const unique = [...new Set(assertionIds)];
    for (let start = 0; start < unique.length; start += AssertionStore.ID_CHUNK) {
      const chunk = unique.slice(start, start + AssertionStore.ID_CHUNK);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = z.array(AssertionRowSchema).parse(this.database.prepare(
        `SELECT * FROM graph_assertions WHERE id IN (${placeholders})`,
      ).all(...chunk));
      for (const row of rows) found.set(row.id, row);
    }
    return found;
  }
```

- [ ] **Step 5: Add `buildMany` to `AssertionViewBuilder`**

Replace the class body in `src/assistant/projections/assertion-view-builder.ts` (keep `toTopicKey` and imports; add `NodeRow` to the imports from `'../storage/rows.js'`):

```ts
export class AssertionViewBuilder {
  constructor(private readonly graph: AssistantGraph) {}

  build(row: AssertionRow): AssertionView {
    const [view] = this.buildMany([row]);
    if (view === undefined) {
      throw new Error(`Assertion ${row.id} produced no view.`);
    }
    return view;
  }

  /** Resolves every referenced node in one batch, then builds each view from the map. */
  buildMany(rows: readonly AssertionRow[]): AssertionView[] {
    const nodeIds = new Set<string>();
    for (const row of rows) {
      nodeIds.add(row.subject_node_id);
      if (row.object_node_id !== null) nodeIds.add(row.object_node_id);
      if (row.scope_node_id !== null) nodeIds.add(row.scope_node_id);
    }
    const nodes = this.graph.nodes.getNodes([...nodeIds]);
    return rows.map((row) => this.buildWithNodes(row, nodes));
  }

  private buildWithNodes(row: AssertionRow, nodes: ReadonlyMap<string, NodeRow>): AssertionView {
    const subject = this.requireFrom(nodes, row.subject_node_id);
    const objectNode = row.object_node_id === null
      ? null
      : this.requireFrom(nodes, row.object_node_id);
    const scopeNode = row.scope_node_id === null
      ? null
      : this.requireFrom(nodes, row.scope_node_id);

    const objectText = objectNode !== null
      ? objectNode.display_name
      : this.renderLiteral(row);

    return {
      assertionId: row.id,
      subjectText: subject.display_name,
      subjectIsOwner: subject.canonical_key === OWNER_PERSON_CANONICAL_KEY,
      predicate: row.predicate,
      objectText,
      scopeText: scopeNode === null ? '' : scopeNode.display_name,
      status: row.status,
      basis: row.basis,
      confidence: row.confidence,
      sensitivity: row.sensitivity,
      pinned: row.pinned,
      userDemoted: row.user_demoted,
      lastObservedAtUtc: row.last_observed_at_utc,
      validFromUtc: row.valid_from_utc,
      validToUtc: row.valid_to_utc,
      topicKey: toTopicKey(
        objectNode?.display_name ?? scopeNode?.display_name ?? 'general',
      ),
    };
  }

  private requireFrom(nodes: ReadonlyMap<string, NodeRow>, nodeId: string): NodeRow {
    const node = nodes.get(nodeId);
    if (node === undefined) {
      throw new Error(`Unknown graph node: ${nodeId}`);
    }
    return node;
  }

  private renderLiteral(row: AssertionRow): string {
    if (row.object_value_type === null || row.object_value_json === null) {
      throw new Error(`Assertion ${row.id} has a literal object with no value.`);
    }
    return normalizeLiteralValue(
      row.object_value_type,
      parseJsonValueText(row.object_value_json),
    );
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test tests/assistant-view-builder-batch.test.ts tests/assistant-memory-query-service.test.ts tests/assistant-projection-compiler.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/assistant/storage/node-store.ts src/assistant/storage/assertion-store.ts src/assistant/projections/assertion-view-builder.ts tests/assistant-view-builder-batch.test.ts
git commit -m "perf(assistant): batch node/assertion fetches and buildMany view resolution"
```

---

### Task 6: Convert the hot callers to batch fetches

**Files:**
- Modify: `src/assistant/retrieval/memory-retriever.ts:90-101` (ranking pipeline)
- Modify: `src/assistant/projections/projection-compiler.ts:200-212` (`collectViews`)
- Modify: `src/assistant/control/deletion-preview.ts:68-81` (`topicAssertionIds`)
- Test: existing suites (behavior must not change)

- [ ] **Step 1: Rework the retriever ranking pipeline**

In `src/assistant/retrieval/memory-retriever.ts`, replace the `ranked` construction (currently `[...assertionIds].map((assertionId) => this.graph.assertions.getAssertion(assertionId))...`):

```ts
    const rankedRows = [...this.graph.assertions.getAssertions([...assertionIds]).values()]
      .filter((row) => row.status === 'active' || row.status === 'disputed');
    const ranked = this.views.buildMany(rankedRows)
      .filter(isProjectableInPlaintext)
      .map((view) => ({ view, score: this.score(view, intent.terms) }))
      .sort(
        (left, right) => right.score - left.score
          || left.view.assertionId.localeCompare(right.view.assertionId),
      );
```

(The `AssertionRow` import becomes unused — remove it from the imports.)

- [ ] **Step 2: Rework `ProjectionCompiler.collectViews`**

In `src/assistant/projections/projection-compiler.ts`, replace the return statement of `collectViews`:

```ts
    const rows = this.graph.assertions
      .listBySubject(ownerId, owner.id, LIVE_ASSERTION_STATUSES)
      .filter((row) => RELATION_DEFINITIONS[row.predicate].projectionBehavior !== 'never_project');
    return this.views.buildMany(rows).filter(isProjectableInPlaintext);
```

- [ ] **Step 3: Rework `topicAssertionIds`**

In `src/assistant/control/deletion-preview.ts`, replace the body of `topicAssertionIds` after the owner lookup:

```ts
  const views = new AssertionViewBuilder(graph);
  const rows = graph.assertions.listBySubject(ownerId, owner.id, LIVE_ASSERTION_STATUSES);
  return views.buildMany(rows)
    .filter((view) => view.topicKey === topicKey)
    .map((view) => view.assertionId)
    .sort();
```

- [ ] **Step 4: Run the affected suites**

Run: `npm test tests/assistant-retrieval.test.ts tests/assistant-projection-compiler.test.ts tests/assistant-deletion-modes.test.ts tests/assistant-gate-c-e2e.test.ts`
Expected: PASS — behavior identical, only query shape changed.

- [ ] **Step 5: Commit**

```bash
git add src/assistant/retrieval/memory-retriever.ts src/assistant/projections/projection-compiler.ts src/assistant/control/deletion-preview.ts
git commit -m "perf(assistant): retrieval, projection, and preview paths use batch fetches"
```

---

### Task 7: Paginate memory history and batch its lookups

**Files:**
- Modify: `src/assistant/storage/audit-store.ts:87-92` (replace `listAllMutations` with `listMutationsRecent`)
- Modify: `src/assistant/control/memory-query-service.ts:145-177` (`listMemoryHistory`)
- Modify: `src/status-server/routes/assistant.ts:510-512` (history route)
- Test: `tests/assistant-memory-query-service.test.ts`, `tests/assistant-gate-c-e2e.test.ts:116`

- [ ] **Step 1: Write the failing test**

Append to `tests/assistant-memory-query-service.test.ts` (it already uses `withAssistantContext`; follow the file's local helpers for creating assertions if present, otherwise use the inline creation shown here):

```ts
test('listMemoryHistory pages newest-first and validates the page', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const subject = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: null, displayName: 'Pager',
      description: null, sensitivity: 'personal', properties: {},
    });
    for (let index = 0; index < 5; index += 1) {
      graph.audit.recordMutation({
        ownerId, actorType: 'system', actorRef: null, operation: 'update_node',
        targetType: 'graph_nodes', targetId: subject.id, before: null, after: null,
        reason: `mutation ${index}`,
      });
    }
    const service = new MemoryQueryService(graph);
    const firstPage = service.listMemoryHistory(ownerId, { limit: 3, offset: 0 });
    const secondPage = service.listMemoryHistory(ownerId, { limit: 3, offset: 3 });
    assert.equal(firstPage.length, 3);
    assert.ok(secondPage.length >= 2);
    assert.notDeepEqual(firstPage.map((entry) => entry.id), secondPage.map((entry) => entry.id));
    assert.throws(() => service.listMemoryHistory(ownerId, { limit: 0, offset: 0 }));
    assert.throws(() => service.listMemoryHistory(ownerId, { limit: 10, offset: -1 }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test tests/assistant-memory-query-service.test.ts`
Expected: FAIL — `listMemoryHistory` takes no page argument.

- [ ] **Step 3: Replace `listAllMutations` in `AuditStore`**

In `src/assistant/storage/audit-store.ts`, replace the `listAllMutations` method (its only caller is `MemoryQueryService`):

```ts
  /** Newest-first page of the mutation log; served by `graph_mutation_owner_time_idx`. */
  listMutationsRecent(ownerId: string, limit: number, offset: number): MutationLogRow[] {
    return z.array(MutationLogRowSchema).parse(this.database.prepare(`
      SELECT * FROM graph_mutation_log
      WHERE owner_id = ? ORDER BY created_at_utc DESC, id DESC LIMIT ? OFFSET ?
    `).all(ownerId, limit, offset));
  }
```

- [ ] **Step 4: Replace `listMemoryHistory`**

In `src/assistant/control/memory-query-service.ts`, replace the method:

```ts
  listMemoryHistory(ownerId: string, page: PageRequest): AssistantMemoryHistoryEntryDto[] {
    this.validatePage(page);
    const mutations = this.graph.audit.listMutationsRecent(ownerId, page.limit, page.offset);
    const assertionsById = this.graph.assertions.getAssertions(
      mutations
        .filter((mutation) => mutation.target_type === 'graph_assertions')
        .map((mutation) => mutation.target_id),
    );
    const viewsById = new Map(
      this.views.buildMany([...assertionsById.values()])
        .map((view) => [view.assertionId, view] as const),
    );
    return mutations.map((mutation) => {
      const assertion = mutation.target_type === 'graph_assertions'
        ? assertionsById.get(mutation.target_id) ?? null
        : null;
      const assertionText = assertion === null
        ? mutation.target_id
        : viewsById.get(assertion.id)?.objectText ?? mutation.target_id;
      const action = mutation.operation.startsWith('create')
        ? 'Added'
        : mutation.operation.startsWith('delete') ? 'Deleted' : 'Changed';
      const proofs = assertion === null
        ? []
        : this.graph.assertions.listEvidence(assertion.id).map((link) => {
          const evidence = this.graph.evidence.requireEvidence(link.evidence_id);
          return {
            evidenceId: evidence.id,
            sourceType: evidence.source_type,
            sourceRef: evidence.source_ref,
          };
        });
      return {
        id: mutation.id,
        operation: mutation.operation,
        targetType: mutation.target_type,
        targetId: mutation.target_id,
        summary: `${action} ${assertionText}`,
        reason: mutation.reason,
        proofs,
        createdAtUtc: mutation.created_at_utc,
      };
    });
  }
```

(Evidence lookups stay per-assertion but are now bounded by the page size of ≤ 100.)

- [ ] **Step 5: Pass page parameters through the route**

In `src/status-server/routes/assistant.ts`, replace the history branch:

```ts
    if (pathname === '/assistant/history') {
      const url = new URL(req.url ?? pathname, 'http://127.0.0.1');
      sendJson(res, 200, {
        items: service.memoryQueries.listMemoryHistory(service.ownerId, {
          limit: integerParam(url, 'limit', 100),
          offset: integerParam(url, 'offset', 0),
        }),
      });
    }
```

(`integerParam` and `new URL(req.url ?? pathname, 'http://127.0.0.1')` are the existing patterns at lines 76 and 280. `validateLimit` caps limits at 100, so 100 is the largest legal default; the dashboard needs no change and now shows the 100 most recent entries.)

- [ ] **Step 6: Update the gate C e2e call site**

In `tests/assistant-gate-c-e2e.test.ts:116`, change:

```ts
    assert.ok(service.memoryQueries.listMemoryHistory(service.ownerId).length >= 5);
```

to:

```ts
    assert.ok(
      service.memoryQueries.listMemoryHistory(service.ownerId, { limit: 100, offset: 0 })
        .length >= 5,
    );
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test tests/assistant-memory-query-service.test.ts tests/assistant-gate-c-e2e.test.ts tests/assistant-dashboard-e2e.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/assistant/storage/audit-store.ts src/assistant/control/memory-query-service.ts src/status-server/routes/assistant.ts tests/assistant-memory-query-service.test.ts tests/assistant-gate-c-e2e.test.ts
git commit -m "perf(assistant): paginate memory history and batch its graph lookups"
```

---

### Task 8: MemoryRetriever — O(log n) token budgeting

**Files:**
- Modify: `src/assistant/retrieval/memory-retriever.ts:111-132` (line-inclusion loop)
- Test: `tests/assistant-retrieval.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/assistant-retrieval.test.ts` (reuse the file's existing fixture helpers for seeding assertions; the counting stub is new):

```ts
class CallCountingTokenCounter implements TokenCounter {
  calls = 0;
  async count(text: string): Promise<TokenCount> {
    this.calls += 1;
    return { tokenCount: Math.ceil(text.length / 4), tokenizerId: 'length' };
  }
}

test('retrieval token budgeting makes O(log n) tokenizer calls', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    const subject = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: OWNER_PERSON_CANONICAL_KEY,
      displayName: 'the user', description: null, sensitivity: 'personal', properties: {},
    });
    for (let index = 0; index < 40; index += 1) {
      const object = graph.nodes.createNode({
        ownerId, type: 'software', canonicalKey: null, displayName: `Budget Tool ${index}`,
        description: null, sensitivity: 'personal', properties: {},
      });
      graph.assertions.createAssertion({
        ownerId, subjectNodeId: subject.id, predicate: 'USES',
        object: { kind: 'node', nodeId: object.id }, scopeNodeId: null,
        status: 'active', basis: 'explicit_user_statement', confidence: 0.9,
        sensitivity: 'personal', validFromUtc: null, validToUtc: null,
        observedAtUtc: '2026-08-05T09:00:00.000Z', supersedesAssertionId: null,
        pinned: false, attributes: {},
        searchText: { subject: 'the user', predicate: 'uses', object: `Budget Tool ${index}`, scope: '' },
      });
    }
    const counter = new CallCountingTokenCounter();
    const retriever = new MemoryRetriever(
      graph, counter, DEFAULT_ASSISTANT_CONFIG.Retrieval, graph.retrievalUsage,
    );
    const result = await retriever.retrieve({
      ownerId, userMessage: 'which Budget Tool setups do I use?',
      conversationId: null, recordUsage: false,
    });
    assert.ok(result.assertionIds.length > 0, 'expected some assertions to be retrieved');
    assert.ok(
      counter.calls <= 10,
      `expected at most 10 tokenizer calls for 40 candidates, saw ${counter.calls}`,
    );
  });
});
```

Add the imports the test needs at the top of the file if not already present: `TokenCounter`/`TokenCount` from `'../src/assistant/domain/tokens.js'`, `MemoryRetriever` from `'../src/assistant/retrieval/memory-retriever.js'`, `DEFAULT_ASSISTANT_CONFIG` from `'../src/config/defaults.js'`, `OWNER_PERSON_CANONICAL_KEY` from `'../src/assistant/storage/schema.js'`, and `withAssistantContextAsync` from `'./helpers/assistant-fixture.js'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test tests/assistant-retrieval.test.ts`
Expected: FAIL — the cumulative loop makes one call per included line (> 10 calls).

- [ ] **Step 3: Replace the inclusion loop with a prefix binary search**

In `src/assistant/retrieval/memory-retriever.ts`, replace everything from `const lines: string[] = [RENDER_HEADING, ''];` through the `if (includedAssertionIds.length === 0)` block with:

```ts
    // Token count is monotone in the number of included sentences, so the largest prefix that
    // fits is found by binary search: O(log n) tokenizer calls instead of one per line, and
    // each call in production is an HTTP round trip to the backend tokenizer.
    const sentences = ranked.map((entry) => renderAssertionSentence(entry.view));
    const measured = new Map<number, number>();
    const countPrefix = async (included: number): Promise<number> => {
      const cached = measured.get(included);
      if (cached !== undefined) return cached;
      const text = [RENDER_HEADING, '', ...sentences.slice(0, included)].join('\n');
      const value = (await this.tokens.count(text)).tokenCount;
      measured.set(included, value);
      return value;
    };

    let low = 0;
    let high = sentences.length;
    if (await countPrefix(0) > this.limits.MaxContextTokens) high = 0;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (await countPrefix(mid) <= this.limits.MaxContextTokens) low = mid;
      else high = mid - 1;
    }

    const includedAssertionIds = ranked.slice(0, low).map((entry) => entry.view.assertionId);
    if (includedAssertionIds.length === 0) {
      return { renderedBlock: '', assertionIds: [], projectionIds, tokenCount: 0 };
    }
    const lines = [RENDER_HEADING, '', ...sentences.slice(0, low)];
    const tokenCount = measured.get(low) ?? 0;
```

The `result` object below stays as is (it already reads `lines.join('\n')`, `includedAssertionIds`, and `tokenCount`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test tests/assistant-retrieval.test.ts`
Expected: PASS — including the pre-existing retrieval behavior tests (the greedy prefix and the binary-search prefix select the same lines because counts are monotone).

- [ ] **Step 5: Commit**

```bash
git add src/assistant/retrieval/memory-retriever.ts tests/assistant-retrieval.test.ts
git commit -m "perf(assistant): retrieval token budgeting via prefix binary search"
```

---

### Task 9: TokenLimitEnforcer — O(log n) drop search

**Files:**
- Modify: `src/assistant/projections/token-limit-enforcer.ts` (whole class body)
- Test: `tests/assistant-token-limit-enforcer.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/assistant-token-limit-enforcer.test.ts`:

```ts
class CountingLengthTokenCounter implements TokenCounter {
  calls = 0;
  async count(text: string): Promise<TokenCount> {
    this.calls += 1;
    return { tokenCount: text.length, tokenizerId: 'length' };
  }
}

test('enforcement makes O(log n) tokenizer calls on a large over-budget body', async () => {
  const counter = new CountingLengthTokenCounter();
  const enforcer = new TokenLimitEnforcer(counter);
  const lines = [
    '# Profile',
    '',
    ...Array.from({ length: 256 }, (_, index) => `- fact ${index} about the user. [M:ast_${index}]`),
  ];
  const result = await enforcer.enforce(lines, 400);
  assert.ok(result.droppedLines > 200, 'most cited lines must be dropped');
  assert.ok(
    counter.calls <= 12,
    `expected at most 12 tokenizer calls for 256 cited lines, saw ${counter.calls}`,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test tests/assistant-token-limit-enforcer.test.ts`
Expected: FAIL — the drop-one-recount loop makes one call per dropped line (~240 calls).

- [ ] **Step 3: Replace the enforcement loop with a binary search over the drop count**

Replace the whole `enforce` method in `src/assistant/projections/token-limit-enforcer.ts`:

```ts
  async enforce(
    lines: readonly string[],
    tokenLimit: number,
  ): Promise<{ body: string; droppedLines: number }> {
    const citedIndices: number[] = [];
    for (const [index, line] of lines.entries()) {
      if (line.startsWith('- ')) citedIndices.push(index);
    }
    const bodyFor = (dropped: number): string => {
      if (dropped === 0) return lines.join('\n');
      const removed = new Set(citedIndices.slice(citedIndices.length - dropped));
      return lines.filter((_, index) => !removed.has(index)).join('\n');
    };
    const fits = async (dropped: number): Promise<boolean> => (
      (await this.tokens.count(bodyFor(dropped))).tokenCount <= tokenLimit
    );

    if (await fits(0)) return { body: bodyFor(0), droppedLines: 0 };
    if (citedIndices.length === 0) return { body: bodyFor(0), droppedLines: 0 };

    // Token count is monotone in the drop count, so the minimal sufficient drop is found by
    // binary search: O(log n) tokenizer calls instead of one per dropped line. When even
    // dropping every cited line does not fit, all of them are dropped — the same terminal
    // state the old one-at-a-time loop reached.
    let low = 1;
    let high = citedIndices.length;
    let dropped = citedIndices.length;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (await fits(mid)) {
        dropped = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    return { body: bodyFor(dropped), droppedLines: dropped };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test tests/assistant-token-limit-enforcer.test.ts tests/assistant-projection-compiler.test.ts`
Expected: PASS — all five pre-existing enforcer tests keep their exact semantics (minimal drop count, unchanged body when it fits, no-cited-lines passthrough, input immutability, error propagation).

- [ ] **Step 5: Commit**

```bash
git add src/assistant/projections/token-limit-enforcer.ts tests/assistant-token-limit-enforcer.test.ts
git commit -m "perf(assistant): token limit enforcement via drop-count binary search"
```

---

### Task 10: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the assistant test suites**

Run: `npm test tests/assistant-migration.test.ts tests/assistant-fts-rowid.test.ts tests/assistant-view-builder-batch.test.ts tests/assistant-retrieval.test.ts tests/assistant-token-limit-enforcer.test.ts tests/assistant-memory-query-service.test.ts tests/assistant-projection-store.test.ts tests/assistant-projection-compiler.test.ts tests/assistant-projection-reconciler.test.ts tests/assistant-activity-log.test.ts tests/assistant-capture-intake.test.ts tests/assistant-capture-retention.test.ts tests/assistant-gate-a-e2e.test.ts tests/assistant-gate-c-e2e.test.ts tests/assistant-dashboard-e2e.test.ts tests/assistant-backup-restore.test.ts tests/assistant-factory-reset.test.ts tests/assistant-deletion-modes.test.ts tests/assistant-export.test.ts`
Expected: PASS.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: PASS. Investigate any failure before proceeding — do not weaken tests.

- [ ] **Step 3: Typecheck and lint**

Run: `npm run typecheck`
Expected: clean (this script also runs lint).

- [ ] **Step 4: Optional performance spot-check**

Re-seed and run the existing §19.5 benchmark to confirm budgets:

```bash
npm run bench:assistant:seed -- --root .bench-assistant-v46 --assertions 20000
npm run bench:assistant -- --root .bench-assistant-v46
```

Expected: `Activity ingestion` and `Capture dedupe` land well inside budget (previously index-less scans); delete `.bench-assistant-v46` afterwards.

- [ ] **Step 5: Report**

State: what changed (schema v46, three FTS stores, batch fetches, two binary searches, history pagination), validation results (suites, typecheck, benchmark numbers), and the one user-visible change: `/assistant/history` now returns at most 100 newest entries per page (`limit`/`offset` query params).

# Assistant Drift Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the five drift findings from the performance-fixes session: (1) the FTS rowid delete/record pattern copy-pasted five times across three stores, (2) the byte-identical `getNodes`/`getAssertions` batch-fetch clones with a duplicated `ID_CHUNK` constant, (3) the third hand-rolled search-text renderer in `NodeMergeService` that re-derives literal object text differently from the view builder, (4) the unreachable `?? mutation.target_id` fallback in `listMemoryHistory`, and (5) the unreachable `?? 0` token-count fallback in `MemoryRetriever`.

**Architecture:** One new storage helper module (`src/assistant/storage/sql-helpers.ts`) owns the chunked `IN (…)` batch fetch and the FTS rowid drop/record statements; all five duplicated sites delegate to it. One new module (`src/assistant/storage/assertion-search-text.ts`) owns the single derivation of an assertion's search text and literal object text; `AssertionViewBuilder.renderLiteral` and `NodeMergeService.searchTextFor` are deleted in favor of it. The two silent fallbacks become explicit throws. Pure refactors are guarded by the existing suites; the new modules get their own failing-first unit tests.

**Tech Stack:** TypeScript (ESM, zod-validated IO via `src/lib/zod.js`), better-sqlite3 with SQLite fts5, node:test via `npm test <file>`.

**Repo notes for the executor:**
- The working tree has uncommitted assistant performance-fix changes across `src/assistant/**` and tests. Build on top of them; do not revert anything.
- Line numbers reference the current working-tree state and may drift a few lines; anchor on the quoted code, not the number.
- Run a single test file with `npm test tests/<name>.test.ts` (the runner compiles first). Full verification happens in Task 6.
- Per AGENTS.md, commits require the user's go-ahead. Each task ends with a commit step; if the user has not authorized commits for this execution, leave the changes staged and report instead.
- Tasks 4 and 5 remove defensive fallbacks on branches that are unreachable through any public API — a failing test cannot be written for them, so those tasks are guarded by the existing suites instead of a new red test. Tasks 1–3 introduce new public units and follow strict red/green TDD.

---

### Task 1: `fetchRowsByIds` helper — deduplicate the batch fetches

**Files:**
- Create: `src/assistant/storage/sql-helpers.ts`
- Modify: `src/assistant/storage/node-store.ts:90-106` (`ID_CHUNK`, `getNodes`)
- Modify: `src/assistant/storage/assertion-store.ts:110-126` (`ID_CHUNK`, `getAssertions`)
- Test: `tests/assistant-sql-helpers.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/assistant-sql-helpers.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchRowsByIds } from '../src/assistant/storage/sql-helpers.js';
import { NodeRowSchema } from '../src/assistant/storage/rows.js';
import { withAssistantContext } from './helpers/assistant-fixture.js';

test('fetchRowsByIds dedupes ids, chunks past 400 parameters, and omits missing ids', () => {
  withAssistantContext(({ database, graph, ownerId }) => {
    const ids = Array.from({ length: 401 }, (_, index) => graph.nodes.createNode({
      ownerId, type: 'software', canonicalKey: null, displayName: `Chunk Tool ${index}`,
      description: null, sensitivity: 'personal', properties: {},
    }).id);

    const requested = [...ids, ...ids.slice(0, 5), 'node_missing'];
    const found = fetchRowsByIds(database, 'graph_nodes', NodeRowSchema, requested);

    assert.equal(found.size, ids.length, 'every real id appears exactly once');
    assert.equal(found.has('node_missing'), false, 'missing ids are absent, not errors');
    const first = found.get(ids[0] ?? '');
    assert.ok(first !== undefined && first.display_name === 'Chunk Tool 0');
    assert.equal(fetchRowsByIds(database, 'graph_nodes', NodeRowSchema, []).size, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test tests/assistant-sql-helpers.test.ts`
Expected: FAIL — `src/assistant/storage/sql-helpers.js` does not exist.

- [ ] **Step 3: Create the helper module**

Create `src/assistant/storage/sql-helpers.ts`:

```ts
import { z } from '../../lib/zod.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';

/** SQLite's default parameter cap is 999; stay far under it per chunk. */
const ID_CHUNK = 400;

/** Batch fetch by id, deduplicated. Missing ids are simply absent from the result. */
export function fetchRowsByIds<Row extends { id: string }>(
  database: RuntimeDatabase,
  table: 'graph_nodes' | 'graph_assertions',
  schema: z.ZodType<Row>,
  ids: readonly string[],
): Map<string, Row> {
  const found = new Map<string, Row>();
  const unique = [...new Set(ids)];
  for (let start = 0; start < unique.length; start += ID_CHUNK) {
    const chunk = unique.slice(start, start + ID_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = z.array(schema).parse(database.prepare(
      `SELECT * FROM ${table} WHERE id IN (${placeholders})`,
    ).all(...chunk));
    for (const row of rows) found.set(row.id, row);
  }
  return found;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test tests/assistant-sql-helpers.test.ts`
Expected: PASS.

- [ ] **Step 5: Convert `NodeStore.getNodes`**

In `src/assistant/storage/node-store.ts`, add to the imports (after the `rows.js` import):

```ts
import { fetchRowsByIds } from './sql-helpers.js';
```

Then delete the `ID_CHUNK` static and the loop body — replace this entire block:

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

with:

```ts
  /** Batch fetch by id, deduplicated. Missing ids are simply absent from the result. */
  getNodes(nodeIds: readonly string[]): Map<string, NodeRow> {
    return fetchRowsByIds(this.database, 'graph_nodes', NodeRowSchema, nodeIds);
  }
```

- [ ] **Step 6: Convert `AssertionStore.getAssertions`**

In `src/assistant/storage/assertion-store.ts`, add to the imports (after the `rows.js` import):

```ts
import { fetchRowsByIds } from './sql-helpers.js';
```

Then replace this entire block:

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

with:

```ts
  /** Batch fetch by id, deduplicated. Missing ids are simply absent from the result. */
  getAssertions(assertionIds: readonly string[]): Map<string, AssertionRow> {
    return fetchRowsByIds(this.database, 'graph_assertions', AssertionRowSchema, assertionIds);
  }
```

(`z` remains used elsewhere in both files — do not remove that import.)

- [ ] **Step 7: Run the guarding suites**

Run: `npm test tests/assistant-sql-helpers.test.ts tests/assistant-view-builder-batch.test.ts tests/assistant-memory-query-service.test.ts tests/assistant-retrieval.test.ts`
Expected: PASS — behavior identical, only the location of the loop changed.

- [ ] **Step 8: Commit**

```bash
git add src/assistant/storage/sql-helpers.ts src/assistant/storage/node-store.ts src/assistant/storage/assertion-store.ts tests/assistant-sql-helpers.test.ts
git commit -m "refactor(assistant): single fetchRowsByIds helper behind getNodes/getAssertions"
```

---

### Task 2: `dropFtsRow` / `recordFtsRowid` — one FTS rowid bookkeeping implementation

**Files:**
- Modify: `src/assistant/storage/sql-helpers.ts` (add the two functions)
- Modify: `src/assistant/storage/node-store.ts:271-287` (`refreshFts`)
- Modify: `src/assistant/storage/assertion-store.ts:223-240` (`retireAssertion`) and `:442-464` (`refreshFts`)
- Modify: `src/assistant/storage/projection-store.ts:155-163` (`deleteProjection`) and `:176-196` (`refreshFts`)
- Test: `tests/assistant-sql-helpers.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/assistant-sql-helpers.test.ts` (extend the existing import from `sql-helpers.js` with `dropFtsRow` and `recordFtsRowid`, and add `import { z } from 'zod';` at the top if not present):

```ts
const FtsStateSchema = z.object({ fts_rowid: z.number().int().nullable() });
const CountSchema = z.object({ count: z.number() });

test('dropFtsRow deletes the FTS row by rowid and clears the tracking column', () => {
  withAssistantContext(({ database, graph, ownerId }) => {
    const node = graph.nodes.createNode({
      ownerId, type: 'software', canonicalKey: null, displayName: 'Droppable Tool',
      description: null, sensitivity: 'personal', properties: {},
    });
    const before = FtsStateSchema.parse(
      database.prepare('SELECT fts_rowid FROM graph_nodes WHERE id = ?').get(node.id),
    );
    assert.notEqual(before.fts_rowid, null, 'fixture: creation must have indexed the node');

    dropFtsRow(database, 'graph_nodes', node.id, before.fts_rowid);

    const remaining = CountSchema.parse(database.prepare(
      'SELECT COUNT(*) AS count FROM graph_nodes_fts WHERE node_id = ?',
    ).get(node.id));
    assert.equal(remaining.count, 0, 'the FTS row must be gone');
    const after = FtsStateSchema.parse(
      database.prepare('SELECT fts_rowid FROM graph_nodes WHERE id = ?').get(node.id),
    );
    assert.equal(after.fts_rowid, null, 'the tracking column must be cleared');

    dropFtsRow(database, 'graph_nodes', node.id, null);
    assert.equal(
      CountSchema.parse(database.prepare(
        'SELECT COUNT(*) AS count FROM graph_nodes_fts WHERE node_id = ?',
      ).get(node.id)).count,
      0,
      'a null rowid is a no-op',
    );
  });
});

test('recordFtsRowid stores the rowid on the canonical row', () => {
  withAssistantContext(({ database, graph, ownerId }) => {
    const node = graph.nodes.createNode({
      ownerId, type: 'software', canonicalKey: null, displayName: 'Recordable Tool',
      description: null, sensitivity: 'personal', properties: {},
    });
    recordFtsRowid(database, 'graph_nodes', node.id, 12345);
    const stored = FtsStateSchema.parse(
      database.prepare('SELECT fts_rowid FROM graph_nodes WHERE id = ?').get(node.id),
    );
    assert.equal(stored.fts_rowid, 12345);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test tests/assistant-sql-helpers.test.ts`
Expected: FAIL — `dropFtsRow` and `recordFtsRowid` are not exported.

- [ ] **Step 3: Add the two functions to `sql-helpers.ts`**

Append to `src/assistant/storage/sql-helpers.ts`:

```ts
/** The three canonical tables that mirror an fts5 index via a `fts_rowid` column. */
const FTS_TABLES = {
  graph_nodes: 'graph_nodes_fts',
  graph_assertions: 'graph_assertions_fts',
  memory_projections: 'memory_projections_fts',
} as const;
export type FtsIndexedTable = keyof typeof FTS_TABLES;

/**
 * Deletes a row's FTS entry by the recorded rowid (indexed) — never by the UNINDEXED id column,
 * which would scan the whole FTS table — and clears the tracking column. No-op when the row was
 * never indexed.
 */
export function dropFtsRow(
  database: RuntimeDatabase,
  table: FtsIndexedTable,
  rowId: string,
  ftsRowid: number | null,
): void {
  if (ftsRowid === null) return;
  database.prepare(`DELETE FROM ${FTS_TABLES[table]} WHERE rowid = ?`).run(ftsRowid);
  database.prepare(`UPDATE ${table} SET fts_rowid = NULL WHERE id = ?`).run(rowId);
}

/** Records a freshly inserted FTS rowid on the canonical row so the next drop is indexed. */
export function recordFtsRowid(
  database: RuntimeDatabase,
  table: FtsIndexedTable,
  rowId: string,
  ftsRowid: number | bigint,
): void {
  database.prepare(`UPDATE ${table} SET fts_rowid = ? WHERE id = ?`).run(ftsRowid, rowId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test tests/assistant-sql-helpers.test.ts`
Expected: PASS.

- [ ] **Step 5: Convert `NodeStore.refreshFts`**

In `src/assistant/storage/node-store.ts`, extend the helper import to:

```ts
import { dropFtsRow, fetchRowsByIds, recordFtsRowid } from './sql-helpers.js';
```

Replace the whole `refreshFts` method:

```ts
  /**
   * Rewrites the node's FTS row from its current canonical state. Called after every write that
   * changes indexed text, status, or sensitivity, inside the caller's transaction.
   */
  private refreshFts(nodeId: string): void {
    const node = this.getNode(nodeId);
    if (node === null) return;
    dropFtsRow(this.database, 'graph_nodes', nodeId, node.fts_rowid);
    if (node.status !== 'active') return;
    if (!isIndexableInPlaintext(node.sensitivity)) return;
    const aliases = this.listAliases(nodeId).map((alias) => alias.alias).join(' ');
    const inserted = this.database.prepare(`
      INSERT INTO graph_nodes_fts (node_id, owner_id, display_name, aliases, description)
      VALUES (?, ?, ?, ?, ?)
    `).run(nodeId, node.owner_id, node.display_name, aliases, node.description ?? '');
    recordFtsRowid(this.database, 'graph_nodes', nodeId, inserted.lastInsertRowid);
  }
```

- [ ] **Step 6: Convert `AssertionStore.retireAssertion` and `refreshFts`**

In `src/assistant/storage/assertion-store.ts`, extend the helper import to:

```ts
import { dropFtsRow, fetchRowsByIds, recordFtsRowid } from './sql-helpers.js';
```

In `retireAssertion`, replace:

```ts
    if (existing.fts_rowid !== null) {
      this.database
        .prepare('DELETE FROM graph_assertions_fts WHERE rowid = ?')
        .run(existing.fts_rowid);
      this.database
        .prepare('UPDATE graph_assertions SET fts_rowid = NULL WHERE id = ?')
        .run(assertionId);
    }
```

with:

```ts
    dropFtsRow(this.database, 'graph_assertions', assertionId, existing.fts_rowid);
```

Replace the whole `refreshFts` method:

```ts
  private refreshFts(assertionId: string, searchText: AssertionSearchText): void {
    const assertion = this.requireAssertion(assertionId);
    dropFtsRow(this.database, 'graph_assertions', assertionId, assertion.fts_rowid);
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
    recordFtsRowid(this.database, 'graph_assertions', assertionId, inserted.lastInsertRowid);
  }
```

- [ ] **Step 7: Convert `ProjectionStore.deleteProjection` and `refreshFts`**

In `src/assistant/storage/projection-store.ts`, add to the imports (after the `rows.js` import):

```ts
import { dropFtsRow, recordFtsRowid } from './sql-helpers.js';
```

Replace `deleteProjection`:

```ts
  deleteProjection(projectionId: string): void {
    const row = this.getProjection(projectionId);
    if (row !== null) {
      dropFtsRow(this.database, 'memory_projections', projectionId, row.fts_rowid);
    }
    this.database.prepare('DELETE FROM memory_projections WHERE id = ?').run(projectionId);
  }
```

(Behavior note: this now also nulls `fts_rowid` immediately before the row is deleted — an invisible extra UPDATE, accepted for one uniform code path.)

Replace the whole `refreshFts` method:

```ts
  /** Rewrites the FTS row from canonical state. Sensitive projections are never indexed (§5.3). */
  private refreshFts(projectionId: string): void {
    const row = this.getProjection(projectionId);
    if (row === null) return;
    dropFtsRow(this.database, 'memory_projections', projectionId, row.fts_rowid);
    if (row.status !== 'active') return;
    if (!isIndexableInPlaintext(row.sensitivity)) return;
    const inserted = this.database.prepare(`
      INSERT INTO memory_projections_fts (projection_id, owner_id, tier, topic_key, content)
      VALUES (?, ?, ?, ?, ?)
    `).run(row.id, row.owner_id, row.tier, row.topic_key, row.content);
    recordFtsRowid(this.database, 'memory_projections', projectionId, inserted.lastInsertRowid);
  }
```

- [ ] **Step 8: Run the guarding suites**

Run: `npm test tests/assistant-sql-helpers.test.ts tests/assistant-fts-rowid.test.ts tests/assistant-projection-store.test.ts tests/assistant-projection-reconciler.test.ts tests/assistant-merge.test.ts`
Expected: PASS — the five sites now share one implementation with identical statements.

- [ ] **Step 9: Commit**

```bash
git add src/assistant/storage/sql-helpers.ts src/assistant/storage/node-store.ts src/assistant/storage/assertion-store.ts src/assistant/storage/projection-store.ts tests/assistant-sql-helpers.test.ts
git commit -m "refactor(assistant): one dropFtsRow/recordFtsRowid path for all three FTS stores"
```

---

### Task 3: Shared assertion search-text renderer

**Files:**
- Create: `src/assistant/storage/assertion-search-text.ts`
- Modify: `src/assistant/projections/assertion-view-builder.ts` (delete `renderLiteral`, use the shared function)
- Modify: `src/assistant/graph/merge-service.ts:188-191` (unmerge loop) and `:305-328` (delete `searchTextFor`)
- Test: `tests/assistant-assertion-search-text.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/assistant-assertion-search-text.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  renderAssertionLiteral, searchTextForAssertion,
} from '../src/assistant/storage/assertion-search-text.js';
import { AssertionViewBuilder } from '../src/assistant/projections/assertion-view-builder.js';
import { withAssistantContext } from './helpers/assistant-fixture.js';

test('searchTextForAssertion renders node objects and scopes from display names', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const subject = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: null, displayName: 'The User',
      description: null, sensitivity: 'personal', properties: {},
    });
    const object = graph.nodes.createNode({
      ownerId, type: 'software', canonicalKey: null, displayName: 'Search Tool',
      description: null, sensitivity: 'personal', properties: {},
    });
    const scope = graph.nodes.createNode({
      ownerId, type: 'project', canonicalKey: null, displayName: 'Side Project',
      description: null, sensitivity: 'personal', properties: {},
    });
    const row = graph.assertions.createAssertion({
      ownerId, subjectNodeId: subject.id, predicate: 'USES',
      object: { kind: 'node', nodeId: object.id }, scopeNodeId: scope.id,
      status: 'active', basis: 'explicit_user_statement', confidence: 0.9,
      sensitivity: 'personal', validFromUtc: null, validToUtc: null,
      observedAtUtc: '2026-08-05T09:00:00.000Z', supersedesAssertionId: null,
      pinned: false, attributes: {},
      searchText: { subject: 'The User', predicate: 'uses', object: 'Search Tool', scope: 'Side Project' },
    });
    assert.deepEqual(searchTextForAssertion(graph.nodes, row), {
      subject: 'The User',
      predicate: 'USES',
      object: 'Search Tool',
      scope: 'Side Project',
    });
  });
});

test('searchTextForAssertion renders literal objects exactly as the view builder does', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const subject = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: null, displayName: 'The User',
      description: null, sensitivity: 'personal', properties: {},
    });
    const row = graph.assertions.createAssertion({
      ownerId, subjectNodeId: subject.id, predicate: 'PREFERS',
      object: { kind: 'literal', valueType: 'string', value: 'Dark Roast' }, scopeNodeId: null,
      status: 'active', basis: 'explicit_user_statement', confidence: 0.9,
      sensitivity: 'personal', validFromUtc: null, validToUtc: null,
      observedAtUtc: '2026-08-05T09:00:00.000Z', supersedesAssertionId: null,
      pinned: false, attributes: {},
      searchText: { subject: 'The User', predicate: 'prefers', object: 'Dark Roast', scope: '' },
    });
    const viewObjectText = new AssertionViewBuilder(graph).build(row).objectText;
    const searchText = searchTextForAssertion(graph.nodes, row);
    assert.equal(searchText.object, viewObjectText, 'FTS and views must share one derivation');
    assert.equal(renderAssertionLiteral(row), viewObjectText);
    assert.equal(searchText.scope, '');
  });
});

test('searchTextForAssertion fails loudly on a missing node or empty literal', () => {
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
    assert.throws(
      () => searchTextForAssertion(graph.nodes, { ...row, subject_node_id: 'node_missing' }),
      /Unknown graph node: node_missing/,
    );
    assert.throws(
      () => searchTextForAssertion(graph.nodes, {
        ...row, object_node_id: null, object_value_type: null, object_value_json: null,
      }),
      /literal object with no value/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test tests/assistant-assertion-search-text.test.ts`
Expected: FAIL — `src/assistant/storage/assertion-search-text.js` does not exist.

- [ ] **Step 3: Create the shared module**

Create `src/assistant/storage/assertion-search-text.ts`:

```ts
import { parseJsonValueText } from '../../lib/json.js';
import { normalizeLiteralValue } from '../domain/keys.js';
import type { AssertionSearchText } from './assertion-store.js';
import type { NodeStore } from './node-store.js';
import type { AssertionRow } from './rows.js';

/**
 * Renders a literal-object assertion's object text from its stored value. The single derivation
 * shared by views and FTS search text, so the two can never disagree about how a fact reads.
 */
export function renderAssertionLiteral(row: AssertionRow): string {
  if (row.object_value_type === null || row.object_value_json === null) {
    throw new Error(`Assertion ${row.id} has a literal object with no value.`);
  }
  return normalizeLiteralValue(row.object_value_type, parseJsonValueText(row.object_value_json));
}

/** Rebuilds an assertion's FTS search text from canonical graph state (e.g. on reactivation). */
export function searchTextForAssertion(nodes: NodeStore, row: AssertionRow): AssertionSearchText {
  const object = row.object_node_id !== null
    ? nodes.requireNode(row.object_node_id).display_name
    : renderAssertionLiteral(row);
  return {
    subject: nodes.requireNode(row.subject_node_id).display_name,
    predicate: row.predicate,
    object,
    scope: row.scope_node_id === null ? '' : nodes.requireNode(row.scope_node_id).display_name,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test tests/assistant-assertion-search-text.test.ts`
Expected: PASS.

- [ ] **Step 5: Delete `AssertionViewBuilder.renderLiteral`**

In `src/assistant/projections/assertion-view-builder.ts`:

5a. Replace the imports at the top of the file with:

```ts
import type { AssistantGraph } from '../assistant-graph.js';
import { normalizeAliasText } from '../domain/keys.js';
import { renderAssertionLiteral } from '../storage/assertion-search-text.js';
import type { AssertionRow, NodeRow } from '../storage/rows.js';
import { OWNER_PERSON_CANONICAL_KEY } from '../storage/schema.js';
import type { AssertionView } from './assertion-view.js';
```

(`parseJsonValueText` and `normalizeLiteralValue` move behind the shared function; `normalizeAliasText` stays for `toTopicKey`.)

5b. In `buildWithNodes`, change:

```ts
    const objectText = objectNode !== null
      ? objectNode.display_name
      : this.renderLiteral(row);
```

to:

```ts
    const objectText = objectNode !== null
      ? objectNode.display_name
      : renderAssertionLiteral(row);
```

5c. Delete the entire private `renderLiteral` method:

```ts
  private renderLiteral(row: AssertionRow): string {
    if (row.object_value_type === null || row.object_value_json === null) {
      throw new Error(`Assertion ${row.id} has a literal object with no value.`);
    }
    return normalizeLiteralValue(
      row.object_value_type,
      parseJsonValueText(row.object_value_json),
    );
  }
```

- [ ] **Step 6: Delete `NodeMergeService.searchTextFor`**

In `src/assistant/graph/merge-service.ts`:

6a. Change the assertion-store import (line 5) from:

```ts
import type { AssertionSearchText, AssertionStore } from '../storage/assertion-store.js';
```

to:

```ts
import type { AssertionStore } from '../storage/assertion-store.js';
```

and add after it:

```ts
import { searchTextForAssertion } from '../storage/assertion-search-text.js';
```

(Leave every other import untouched — `parseJsonValueText` is still used elsewhere in the file.)

6b. In the unmerge loop, change:

```ts
      for (const retiredId of payload.retiredAssertionIds) {
        const assertion = this.assertions.requireAssertion(retiredId);
        this.assertions.reactivateAssertion(retiredId, this.searchTextFor(assertion));
      }
```

to:

```ts
      for (const retiredId of payload.retiredAssertionIds) {
        const assertion = this.assertions.requireAssertion(retiredId);
        this.assertions.reactivateAssertion(retiredId, searchTextForAssertion(this.nodes, assertion));
      }
```

6c. Delete the entire private `searchTextFor` method (the block from `private searchTextFor(assertion: AssertionRow): AssertionSearchText {` through its closing `}` — currently lines 305–328).

- [ ] **Step 7: Run the guarding suites**

Run: `npm test tests/assistant-assertion-search-text.test.ts tests/assistant-merge.test.ts tests/assistant-projection-compiler.test.ts tests/assistant-memory-query-service.test.ts tests/assistant-retrieval.test.ts`
Expected: PASS. (For literal objects, `object_normalized_text` is written at creation by the same `normalizeLiteralValue` call, so the merge-undo FTS text is value-identical — this consolidation removes the second derivation, not observable behavior.)

- [ ] **Step 8: Commit**

```bash
git add src/assistant/storage/assertion-search-text.ts src/assistant/projections/assertion-view-builder.ts src/assistant/graph/merge-service.ts tests/assistant-assertion-search-text.test.ts
git commit -m "refactor(assistant): one shared derivation for assertion search text and literals"
```

---

### Task 4: Fail loudly on a missing history view

**Files:**
- Modify: `src/assistant/control/memory-query-service.ts:157-163` (`listMemoryHistory`), plus one new private method and one import

No new test: the `??` branch being removed is unreachable through any public API (every assertion in `assertionsById` goes through `buildMany`, which throws on any missing node — so `viewsById` always contains it). The change converts silent laundering into a loud invariant; the existing suite proves behavior is unchanged.

- [ ] **Step 1: Add the `AssertionView` import**

In `src/assistant/control/memory-query-service.ts`, after the existing import of `AssertionViewBuilder`:

```ts
import { AssertionViewBuilder } from '../projections/assertion-view-builder.js';
```

add:

```ts
import type { AssertionView } from '../projections/assertion-view.js';
```

- [ ] **Step 2: Replace the silent fallback**

In `listMemoryHistory`, change:

```ts
      const assertionText = assertion === null
        ? mutation.target_id
        : viewsById.get(assertion.id)?.objectText ?? mutation.target_id;
```

to:

```ts
      const assertionText = assertion === null
        ? mutation.target_id
        : this.requireHistoryView(viewsById, assertion.id).objectText;
```

- [ ] **Step 3: Add the private helper**

Add after `listMemoryHistory` (before `toNodeSummary`):

```ts
  /** Every assertion handed to buildMany gets a view or buildMany throws; a miss here is a bug. */
  private requireHistoryView(
    views: ReadonlyMap<string, AssertionView>,
    assertionId: string,
  ): AssertionView {
    const view = views.get(assertionId);
    if (view === undefined) {
      throw new Error(`Assertion ${assertionId} has no built view for the history page.`);
    }
    return view;
  }
```

- [ ] **Step 4: Run the guarding suites**

Run: `npm test tests/assistant-memory-query-service.test.ts tests/assistant-gate-c-e2e.test.ts tests/assistant-dashboard-e2e.test.ts`
Expected: PASS — no reachable behavior changed.

- [ ] **Step 5: Commit**

```bash
git add src/assistant/control/memory-query-service.ts
git commit -m "refactor(assistant): history view lookup fails loudly instead of falling back"
```

---

### Task 5: Fail loudly on an unmeasured retrieval prefix

**Files:**
- Modify: `src/assistant/retrieval/memory-retriever.ts:135-136`

No new test: `low` is always a measured prefix (`countPrefix(0)` runs unconditionally; every other candidate for `low` passed a measured `countPrefix(mid)` check), so the `?? 0` branch is unreachable. The existing retrieval suite — including the O(log n) call-count test — guards the change.

- [ ] **Step 1: Replace the silent zero**

In `src/assistant/retrieval/memory-retriever.ts`, change:

```ts
    const lines = [RENDER_HEADING, '', ...sentences.slice(0, low)];
    const tokenCount = measured.get(low) ?? 0;
```

to:

```ts
    const lines = [RENDER_HEADING, '', ...sentences.slice(0, low)];
    const tokenCount = measured.get(low);
    if (tokenCount === undefined) {
      throw new Error(`Retrieval prefix of ${low} sentences was selected but never measured.`);
    }
```

(The `result` object below is unchanged; `tokenCount` is now narrowed to `number`.)

- [ ] **Step 2: Run the guarding suite**

Run: `npm test tests/assistant-retrieval.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/assistant/retrieval/memory-retriever.ts
git commit -m "refactor(assistant): retrieval token count throws on unmeasured prefix"
```

---

### Task 6: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the assistant test suites**

Run: `npm test tests/assistant-sql-helpers.test.ts tests/assistant-assertion-search-text.test.ts tests/assistant-fts-rowid.test.ts tests/assistant-view-builder-batch.test.ts tests/assistant-migration.test.ts tests/assistant-retrieval.test.ts tests/assistant-token-limit-enforcer.test.ts tests/assistant-memory-query-service.test.ts tests/assistant-projection-store.test.ts tests/assistant-projection-compiler.test.ts tests/assistant-projection-reconciler.test.ts tests/assistant-merge.test.ts tests/assistant-entity-resolution.test.ts tests/assistant-assertion-service.test.ts tests/assistant-deletion-modes.test.ts tests/assistant-gate-a-e2e.test.ts tests/assistant-gate-c-e2e.test.ts tests/assistant-dashboard-e2e.test.ts`
Expected: PASS.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: PASS. Investigate any failure before proceeding — do not weaken tests.

- [ ] **Step 3: Typecheck and lint**

Run: `npm run typecheck`
Expected: clean (this script also runs lint).

- [ ] **Step 4: Confirm no leftovers**

Verify the refactor left no obsolete artifacts — each of these searches must return no matches in `src/`:

```bash
grep -n "ID_CHUNK" src/assistant/storage/node-store.ts src/assistant/storage/assertion-store.ts
grep -n "renderLiteral" src/assistant/projections/assertion-view-builder.ts
grep -n "private searchTextFor" src/assistant/graph/merge-service.ts
grep -Fn "?? mutation.target_id" src/assistant/control/memory-query-service.ts
grep -Fn "measured.get(low) ?? 0" src/assistant/retrieval/memory-retriever.ts
```

Expected: every command exits with no output (exit code 1 from grep is the pass signal here).

- [ ] **Step 5: Report**

State: what changed (two new shared modules `sql-helpers.ts` and `assertion-search-text.ts`; five FTS bookkeeping sites, two batch fetches, and two search-text derivations collapsed to one implementation each; two silent fallbacks converted to loud invariant checks), validation results (suites, full run, typecheck), and that no user-visible behavior changed.

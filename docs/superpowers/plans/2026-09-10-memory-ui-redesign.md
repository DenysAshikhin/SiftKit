# Memory UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Assistant tab's search-only Memory Inspector with a two-view memory surface — an Overview landing page carrying a generated "what I learned" digest, and an Explorer for per-entity inspection — plus a memory-scoped assistant chatbox that can correct, merge, and clean up memories. Fold the "Pending validation" and "Memory history" tabs out of Settings so Settings → Assistant holds configuration only.

**Architecture:** Six independently shippable phases. Backend work adds aggregate read models (`MemoryStatsService`), a merge HTTP route over the already-complete `NodeMergeService`, a digest generator with a `runtime_metadata`-backed cache, and a memory-scoped tool registry. Frontend replaces `AssistantTab` with a view switcher over two new panel trees, driven by the existing `useAssistantController` token/fetch pattern. Every mutation keeps the existing preview-token → apply contract.

**Tech Stack:** TypeScript (strict, inferred end-to-end), Zod contracts in `@siftkit/contracts`, better-sqlite3 via `RuntimeDatabase`, React 18 (SSR-string tests via `renderToStaticMarkup`), `node:test` through the repo's custom runner.

---

## Ground rules for this plan

Read these before Task 1. They are repo-specific and non-obvious.

**Tests.** The repo uses `node:test`, not vitest/jest. There is **no jsdom and no React Testing Library** — component tests render to a string with `renderToStaticMarkup` and assert on markup. Follow `dashboard/tests/assistant-tab.test.tsx` exactly.

**Running tests.** Tests run from compiled output, so a build is required first:

```bash
npm run build:test
node .\dist\test-runner\run-tests.js <test-file-basename>
```

`<test-file-basename>` matches the source filename without extension (e.g. `assistant-memory-stats`). Dashboard suites need `node .\dist\test-runner\run-tests.js --dashboard`. **`npm test` alone will not pick up new files until `npm run build:test` runs.**

**Backend test fixture.** Use `withAssistantContext` from `tests/helpers/assistant-fixture.js`. It gives `{ database, clock, ids, ownerId, runtimeRoot, graph }` with a `FixedClock`, on a temp SQLite database.

**Type rules (from CLAUDE.md, enforced by lint).** No `any`, no type assertions, no non-null `!`, no namespace imports. Parse all IO with Zod and derive types via `z.infer`. Use `as const` and `satisfies` freely.

**Visual source of truth.** The approved mockups are committed at `docs/mockups/memory/`. When a task says "port the CSS from `variant-a.mjs`", that file contains the final, approved CSS as a template literal — copy it verbatim into the target `.css` file and strip the backticks. Do not redesign.

**Do not commit unless the task's commit step says to.** Never use `--no-verify`.

---

## File Structure

**Backend — created**

| File | Responsibility |
|---|---|
| `src/assistant/control/memory-stats-service.ts` | Read-only aggregate counts for the Overview (tiers, types, predicates, confidence, pipeline, duplicates). No mutation. |
| `src/assistant/control/duplicate-finder.ts` | Candidate duplicate-entity pairs by normalized display name + type. |
| `src/assistant/digest/digest-store.ts` | Persist/read the cached digest in `runtime_metadata`. |
| `src/assistant/digest/digest-service.ts` | Freshness rule + generation via `AssistantInferenceClient`. |
| `src/assistant/chat/memory-tools.ts` | The memory-scoped tool registry the chatbox may call. |
| `src/status-server/routes/assistant/overview-routes.ts` | `GET /assistant/overview`, `GET /assistant/graph/duplicates`, `GET /assistant/digest`, `POST /assistant/digest/regenerate`. |

**Backend — modified**

| File | Change |
|---|---|
| `packages/contracts/src/assistant.ts` | Add overview, duplicate, merge, and digest DTO schemas. |
| `src/assistant/assistant-service.ts` | Compose `memoryStats`, `duplicates`, `digest`. |
| `src/status-server/routes/assistant.ts` | Register new routes. |
| `src/status-server/routes/assistant/mutation-routes.ts` | Add `mergeNodesEndpoint`. |

**Frontend — created**

| File | Responsibility |
|---|---|
| `dashboard/src/tabs/memory/MemoryOverview.tsx` | Variant A: digest slot, capacity, composition, pipeline. |
| `dashboard/src/tabs/memory/MemoryExplorer.tsx` | Variant B: facet rail, entity list, inspector. |
| `dashboard/src/components/memory/CapacityGauges.tsx` | Tier gauges + archive alert. |
| `dashboard/src/components/memory/DigestPanel.tsx` | Greeting digest with streaming/cached states. |
| `dashboard/src/components/memory/MemoryChatDock.tsx` | Collapsible memory assistant. |
| `dashboard/src/components/memory/ReviewQueue.tsx` | Validation candidates + identity holds, moved out of Settings. |
| `dashboard/src/components/memory/MemoryHistoryList.tsx` | Memory change log, moved out of Settings. |
| `dashboard/src/styles/memory.css` | Ported mockup CSS. |

**Frontend — modified**

| File | Change |
|---|---|
| `dashboard/src/tabs/AssistantTab.tsx` | Becomes a view switcher over Overview/Explorer. |
| `dashboard/src/hooks/useAssistantController.ts` | Load overview/digest; expose merge + chat actions. |
| `dashboard/src/assistant-api.ts` | Client functions for the new endpoints. |
| `dashboard/src/tabs/settings/AssistantSettings.tsx` | Drop the 3-way view switcher; keep configuration only. |
| `dashboard/src/styles.css` | `@import` the new stylesheet. |

---

# Phase 1 — Overview read model and endpoint

**Milestone:** `GET /assistant/overview` returns every number the Overview page needs, in one call. Shippable alone: verifiable by curl.

### Task 1: Overview contracts

**Files:**
- Modify: `packages/contracts/src/assistant.ts` (append near `AssistantProjectionDtoSchema`, line ~165)
- Test: `tests/assistant-contracts-overview.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { AssistantMemoryOverviewSchema } from '@siftkit/contracts';

test('AssistantMemoryOverviewSchema accepts a complete overview and rejects a bad tier', () => {
  const valid = {
    generatedAtUtc: '2026-09-10T12:40:33.155Z',
    graphVersion: 6608,
    nodes: { active: 1109, byType: [{ type: 'software', count: 445 }] },
    assertions: {
      active: 1408,
      pinned: 0,
      byPredicate: [{ predicate: 'USES', count: 597 }],
      byConfidence: { high: 24, medium: 136, low: 0, unscored: 1248 },
      byBasis: [{ basis: 'passive_observation', count: 1406 }],
    },
    tiers: [{ tier: 1, documents: 1, limit: 1, tokens: 6692, retrievals: 2, newestUtc: null }],
    evidenceCount: 4329,
    observationCount: 6478,
    pendingCandidateCount: 1244,
    duplicatePairCount: 4,
    jobs: [{ jobType: 'image_extraction', status: 'dead_letter', count: 30 }],
  };
  assert.equal(AssistantMemoryOverviewSchema.parse(valid).nodes.active, 1109);

  assert.throws(() => AssistantMemoryOverviewSchema.parse({
    ...valid,
    tiers: [{ tier: 4, limit: 1, documents: 1, tokens: 1, retrievals: 0, newestUtc: null }],
  }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js assistant-contracts-overview`
Expected: FAIL — `AssistantMemoryOverviewSchema` is not exported.

- [ ] **Step 3: Add the schemas**

Append to `packages/contracts/src/assistant.ts`:

```ts
export const AssistantTierUsageSchema = z.object({
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  documents: z.number().int().min(0),
  limit: z.number().int().min(1),
  tokens: z.number().int().min(0),
  retrievals: z.number().int().min(0),
  newestUtc: z.string().nullable(),
}).strict();
export type AssistantTierUsage = z.infer<typeof AssistantTierUsageSchema>;

export const AssistantMemoryOverviewSchema = z.object({
  generatedAtUtc: z.string(),
  graphVersion: z.number().int().min(0),
  nodes: z.object({
    active: z.number().int().min(0),
    byType: z.array(z.object({
      type: z.string(), count: z.number().int().min(0),
    }).strict()),
  }).strict(),
  assertions: z.object({
    active: z.number().int().min(0),
    pinned: z.number().int().min(0),
    byPredicate: z.array(z.object({
      predicate: z.string(), count: z.number().int().min(0),
    }).strict()),
    byConfidence: z.object({
      high: z.number().int().min(0),
      medium: z.number().int().min(0),
      low: z.number().int().min(0),
      unscored: z.number().int().min(0),
    }).strict(),
    byBasis: z.array(z.object({
      basis: z.string(), count: z.number().int().min(0),
    }).strict()),
  }).strict(),
  tiers: z.array(AssistantTierUsageSchema),
  evidenceCount: z.number().int().min(0),
  observationCount: z.number().int().min(0),
  pendingCandidateCount: z.number().int().min(0),
  duplicatePairCount: z.number().int().min(0),
  jobs: z.array(z.object({
    jobType: z.string(), status: z.string(), count: z.number().int().min(0),
  }).strict()),
}).strict();
export type AssistantMemoryOverview = z.infer<typeof AssistantMemoryOverviewSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js assistant-contracts-overview`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/assistant.ts tests/assistant-contracts-overview.test.ts
git commit -m "feat(contracts): add assistant memory overview schemas"
```

---

### Task 2: Duplicate finder

**Files:**
- Create: `src/assistant/control/duplicate-finder.ts`
- Test: `tests/assistant-duplicate-finder.test.ts` (create)

Duplicates are grouped by *normalized* display name within a type: lowercase, strip every non-alphanumeric character. `SiftKit`/`siftkit` and `The Last Spark`/`TheLastSpark` collapse; `VS Code`/`Visual Studio Code` does not (that needs alias matching, which is out of scope here).

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { DuplicateFinder } from '../src/assistant/control/duplicate-finder.js';
import { withAssistantContext } from './helpers/assistant-fixture.js';

test('DuplicateFinder groups same-type entities whose names normalize equal', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const mk = (displayName: string, type: 'project' | 'person') => graph.nodes.createNode({
      ownerId, type, canonicalKey: null, displayName,
      description: null, sensitivity: 'personal', properties: {},
    });
    const keep = mk('The Last Spark', 'project');
    const dupe = mk('TheLastSpark', 'project');
    mk('Unrelated', 'project');
    mk('The Last Spark', 'person'); // different type: never grouped

    const pairs = new DuplicateFinder(graph).find(ownerId, 10);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0]?.targetNodeId, keep.id);   // higher degree wins; tie broken by age
    assert.equal(pairs[0]?.sourceNodeId, dupe.id);
    assert.equal(pairs[0]?.normalizedKey, 'thelastspark');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js assistant-duplicate-finder`
Expected: FAIL — cannot find module `duplicate-finder.js`.

- [ ] **Step 3: Implement**

```ts
import type { AssistantGraph } from '../assistant-graph.js';
import { z } from '../../lib/zod.js';

const DuplicateRowSchema = z.object({
  id: z.string(),
  type: z.string(),
  display_name: z.string(),
  created_at_utc: z.string(),
  degree: z.number().int().min(0),
}).strict();

export interface DuplicatePair {
  readonly normalizedKey: string;
  readonly type: string;
  readonly targetNodeId: string;
  readonly targetDisplayName: string;
  readonly targetDegree: number;
  readonly sourceNodeId: string;
  readonly sourceDisplayName: string;
  readonly sourceDegree: number;
}

/** Lowercase, alphanumerics only. Deliberately conservative: no fuzzy or alias matching. */
export function normalizeDisplayName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

export class DuplicateFinder {
  constructor(private readonly graph: AssistantGraph) {}

  find(ownerId: string, limit: number): DuplicatePair[] {
    const rows = this.graph.database.prepare(`
      SELECT n.id, n.type, n.display_name, n.created_at_utc,
             (SELECT count(*) FROM graph_assertions a
               WHERE a.status = 'active'
                 AND (a.subject_node_id = n.id OR a.object_node_id = n.id)) AS degree
      FROM graph_nodes n
      WHERE n.owner_id = ? AND n.status = 'active'
    `).all(ownerId).map((row) => DuplicateRowSchema.parse(row));

    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = `${row.type}:${normalizeDisplayName(row.display_name)}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }

    const pairs: DuplicatePair[] = [];
    for (const [key, group] of groups) {
      if (group.length < 2) continue;
      // Highest degree is the survivor; oldest wins ties so the result is deterministic.
      const ranked = [...group].sort((left, right) => (
        right.degree - left.degree || left.created_at_utc.localeCompare(right.created_at_utc)
      ));
      const [target, ...rest] = ranked;
      if (target === undefined) continue;
      for (const source of rest) {
        pairs.push({
          normalizedKey: key.slice(key.indexOf(':') + 1),
          type: target.type,
          targetNodeId: target.id,
          targetDisplayName: target.display_name,
          targetDegree: target.degree,
          sourceNodeId: source.id,
          sourceDisplayName: source.display_name,
          sourceDegree: source.degree,
        });
      }
    }
    return pairs
      .sort((left, right) => right.targetDegree - left.targetDegree)
      .slice(0, limit);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js assistant-duplicate-finder`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/assistant/control/duplicate-finder.ts tests/assistant-duplicate-finder.test.ts
git commit -m "feat(assistant): detect duplicate entities by normalized display name"
```

---

### Task 3: Memory stats service

**Files:**
- Create: `src/assistant/control/memory-stats-service.ts`
- Test: `tests/assistant-memory-stats.test.ts` (create)

Tier limits come from the existing `TIER_DOCUMENT_LIMIT` in `src/assistant/projections/assertion-view.ts:46` (`{ 1: 1, 2: 25, 3: 500 }`). **Do not redefine them** — import the constant so the UI can never disagree with the compiler.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryStatsService } from '../src/assistant/control/memory-stats-service.js';
import { withAssistantContext } from './helpers/assistant-fixture.js';

test('MemoryStatsService reports tier limits, type counts and confidence buckets', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const owner = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: 'person:owner', displayName: 'the user',
      description: null, sensitivity: 'personal', properties: {},
    });
    graph.nodes.createNode({
      ownerId, type: 'software', canonicalKey: null, displayName: 'CUDA',
      description: null, sensitivity: 'personal', properties: {},
    });
    const evidence = graph.evidence.recordTextEvidence({
      ownerId, deviceId: null, parentEvidenceId: null, sourceType: 'conversation_message',
      sourceEventId: 'chat:m1', sourceRef: 'chat', capturedAtUtc: '2026-08-10T00:00:00.000Z',
      sourceTimezone: null, sensitivity: 'personal', retentionUntilUtc: null,
      metadata: {}, text: 'uses cuda',
    });
    graph.assertionService.assert({
      ownerId, actorType: 'user', actorRef: null, subjectNodeId: owner.id,
      predicate: 'USES', object: { kind: 'literal', valueType: 'text', value: 'CUDA' },
      scopeNodeId: null, basis: 'explicit_user_statement', sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, observedAtUtc: '2026-08-10T00:00:00.000Z',
      topics: [], attributes: {},
      searchText: { subject: 'the user', predicate: 'USES', object: 'CUDA', scope: '' },
      evidence: [{ evidenceId: evidence.id, stance: 'supports', weight: 1 }],
    });

    const overview = new MemoryStatsService(graph).buildOverview(ownerId);

    assert.equal(overview.nodes.active, 2);
    assert.deepEqual(
      overview.nodes.byType.find((entry) => entry.type === 'software'),
      { type: 'software', count: 1 },
    );
    assert.equal(overview.assertions.active, 1);
    assert.equal(overview.assertions.byPredicate[0]?.predicate, 'USES');
    assert.equal(overview.tiers.length, 3);
    assert.deepEqual(overview.tiers.map((tier) => tier.limit), [1, 25, 500]);
    assert.equal(overview.evidenceCount, 1);
    // Every bucket present even when empty, so the UI never divides by undefined.
    assert.equal(typeof overview.assertions.byConfidence.unscored, 'number');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js assistant-memory-stats`
Expected: FAIL — cannot find module `memory-stats-service.js`.

- [ ] **Step 3: Implement**

```ts
import type { AssistantMemoryOverview, AssistantTierUsage } from '@siftkit/contracts';
import { z } from '../../lib/zod.js';
import type { AssistantGraph } from '../assistant-graph.js';
import { TIER_DOCUMENT_LIMIT } from '../projections/assertion-view.js';
import { DuplicateFinder } from './duplicate-finder.js';

const CountRowSchema = z.object({ key: z.string(), count: z.number().int().min(0) }).strict();
const TotalRowSchema = z.object({ count: z.number().int().min(0) }).strict();
const TierRowSchema = z.object({
  tier: z.number().int(),
  documents: z.number().int().min(0),
  tokens: z.number().int().min(0),
  retrievals: z.number().int().min(0),
  newestUtc: z.string().nullable(),
}).strict();
const ConfidenceRowSchema = z.object({
  bucket: z.enum(['high', 'medium', 'low', 'unscored']),
  count: z.number().int().min(0),
}).strict();
const JobRowSchema = z.object({
  jobType: z.string(), status: z.string(), count: z.number().int().min(0),
}).strict();
const VersionRowSchema = z.object({ version: z.number().int().min(0) }).strict();

/** Read-only aggregates for the Overview page. Never mutates. */
export class MemoryStatsService {
  private readonly duplicates: DuplicateFinder;

  constructor(private readonly graph: AssistantGraph) {
    this.duplicates = new DuplicateFinder(graph);
  }

  buildOverview(ownerId: string): AssistantMemoryOverview {
    return {
      generatedAtUtc: this.graph.nowUtc(),
      graphVersion: this.scalar(
        'SELECT COALESCE(MAX(graph_version), 0) AS version FROM memory_projections WHERE owner_id = ?',
        ownerId, VersionRowSchema, (row) => row.version,
      ),
      nodes: {
        active: this.count(
          "SELECT count(*) AS count FROM graph_nodes WHERE owner_id = ? AND status = 'active'",
          ownerId,
        ),
        byType: this.grouped(
          `SELECT type AS key, count(*) AS count FROM graph_nodes
            WHERE owner_id = ? AND status = 'active' GROUP BY type ORDER BY count DESC`,
          ownerId,
        ).map((row) => ({ type: row.key, count: row.count })),
      },
      assertions: {
        active: this.count(
          "SELECT count(*) AS count FROM graph_assertions WHERE owner_id = ? AND status = 'active'",
          ownerId,
        ),
        pinned: this.count(
          "SELECT count(*) AS count FROM graph_assertions WHERE owner_id = ? AND pinned = 1 AND status = 'active'",
          ownerId,
        ),
        byPredicate: this.grouped(
          `SELECT predicate AS key, count(*) AS count FROM graph_assertions
            WHERE owner_id = ? AND status = 'active' GROUP BY predicate ORDER BY count DESC`,
          ownerId,
        ).map((row) => ({ predicate: row.key, count: row.count })),
        byBasis: this.grouped(
          `SELECT basis AS key, count(*) AS count FROM graph_assertions
            WHERE owner_id = ? AND status = 'active' GROUP BY basis ORDER BY count DESC`,
          ownerId,
        ).map((row) => ({ basis: row.key, count: row.count })),
        byConfidence: this.confidenceBuckets(ownerId),
      },
      tiers: this.tiers(ownerId),
      evidenceCount: this.count(
        'SELECT count(*) AS count FROM evidence_records WHERE owner_id = ?', ownerId,
      ),
      observationCount: this.count(
        'SELECT count(*) AS count FROM observations WHERE owner_id = ?', ownerId,
      ),
      pendingCandidateCount: this.count(
        "SELECT count(*) AS count FROM candidate_assertions WHERE owner_id = ? AND status = 'pending'",
        ownerId,
      ),
      duplicatePairCount: this.duplicates.find(ownerId, 100).length,
      jobs: this.graph.database.prepare(`
        SELECT job_type AS jobType, status, count(*) AS count FROM assistant_jobs
         WHERE owner_id = ? GROUP BY job_type, status ORDER BY job_type, status
      `).all(ownerId).map((row) => JobRowSchema.parse(row)),
    };
  }

  private tiers(ownerId: string): AssistantTierUsage[] {
    const rows = this.graph.database.prepare(`
      SELECT tier,
             count(*) AS documents,
             COALESCE(sum(token_count), 0) AS tokens,
             COALESCE(sum(retrieval_count), 0) AS retrievals,
             max(generated_at_utc) AS newestUtc
        FROM memory_projections
       WHERE owner_id = ? AND status = 'active'
       GROUP BY tier
    `).all(ownerId).map((row) => TierRowSchema.parse(row));

    // Always emit all three tiers so the UI renders a stable set of gauges.
    return ([1, 2, 3] as const).map((tier) => {
      const row = rows.find((candidate) => candidate.tier === tier);
      return {
        tier,
        limit: TIER_DOCUMENT_LIMIT[tier],
        documents: row?.documents ?? 0,
        tokens: row?.tokens ?? 0,
        retrievals: row?.retrievals ?? 0,
        newestUtc: row?.newestUtc ?? null,
      };
    });
  }

  private confidenceBuckets(ownerId: string) {
    const rows = this.graph.database.prepare(`
      SELECT CASE
               WHEN confidence >= 0.8 THEN 'high'
               WHEN confidence >= 0.5 THEN 'medium'
               WHEN confidence > 0 THEN 'low'
               ELSE 'unscored'
             END AS bucket,
             count(*) AS count
        FROM graph_assertions
       WHERE owner_id = ? AND status = 'active'
       GROUP BY bucket
    `).all(ownerId).map((row) => ConfidenceRowSchema.parse(row));
    const at = (bucket: 'high' | 'medium' | 'low' | 'unscored') =>
      rows.find((row) => row.bucket === bucket)?.count ?? 0;
    return { high: at('high'), medium: at('medium'), low: at('low'), unscored: at('unscored') };
  }

  private grouped(sql: string, ownerId: string) {
    return this.graph.database.prepare(sql).all(ownerId).map((row) => CountRowSchema.parse(row));
  }

  private count(sql: string, ownerId: string): number {
    return this.scalar(sql, ownerId, TotalRowSchema, (row) => row.count);
  }

  private scalar<S extends z.ZodTypeAny, R>(
    sql: string, ownerId: string, schema: S, pick: (row: z.infer<S>) => R,
  ): R {
    return pick(schema.parse(this.graph.database.prepare(sql).get(ownerId)));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js assistant-memory-stats`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/assistant/control/memory-stats-service.ts tests/assistant-memory-stats.test.ts
git commit -m "feat(assistant): add memory overview aggregate read model"
```

---

### Task 4: Overview and duplicates endpoints

**Files:**
- Create: `src/status-server/routes/assistant/overview-routes.ts`
- Modify: `src/assistant/assistant-service.ts` (compose the services)
- Modify: `src/status-server/routes/assistant.ts:96` (register routes)
- Test: `tests/assistant-overview-route.test.ts` (create)

- [ ] **Step 1: Write the failing test**

This asserts the routes are *registered*, which is the part Task 3 did not deliver.

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { AssistantMemoryOverviewSchema } from '@siftkit/contracts';
import { MemoryStatsService } from '../src/assistant/control/memory-stats-service.js';
import { hasAssistantRoutePath } from '../src/status-server/routes/assistant.js';
import { withAssistantContext } from './helpers/assistant-fixture.js';

test('the overview and duplicates routes are registered', () => {
  assert.equal(hasAssistantRoutePath('/assistant/overview'), true);
  assert.equal(hasAssistantRoutePath('/assistant/graph/duplicates'), true);
  assert.equal(hasAssistantRoutePath('/assistant/not-a-route'), false);
});

test('the overview payload satisfies the published contract', () => {
  withAssistantContext(({ graph, ownerId }) => {
    graph.nodes.createNode({
      ownerId, type: 'software', canonicalKey: null, displayName: 'CUDA',
      description: null, sensitivity: 'personal', properties: {},
    });
    const overview = new MemoryStatsService(graph).buildOverview(ownerId);
    // The route serialises exactly this object; parsing proves the wire shape.
    assert.doesNotThrow(() => AssistantMemoryOverviewSchema.parse(overview));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js assistant-overview-route`
Expected: FAIL — `hasAssistantRoutePath` is not exported from `routes/assistant.ts`.

The table is built inline as `const routes = new RouteTable([...])` at `src/status-server/routes/assistant.ts:84` — there is no named array to map over. `RouteTable` already exposes `hasPath`, used by `handleAssistantRoute`, so expose a one-line predicate next to the table rather than restructuring it:

```ts
/** Exported for route-registration tests; the table itself stays private. */
export function hasAssistantRoutePath(pathname: string): boolean {
  return routes.hasPath(pathname);
}
```

- [ ] **Step 3: Add the route module**

Create `src/status-server/routes/assistant/overview-routes.ts`:

```ts
import { sendJson } from '../../http-utils.js';
import { assistantRoute, integerParam } from './helpers.js';

export const overviewEndpoint = assistantRoute(({ service, res }) => {
  sendJson(res, 200, service.memoryStats.buildOverview(service.ownerId));
});

export const duplicatesEndpoint = assistantRoute(({ service, res, url }) => {
  sendJson(res, 200, {
    items: service.duplicates.find(service.ownerId, integerParam(url, 'limit', 25)),
  });
});
```

In `src/assistant/assistant-service.ts`, compose both alongside the existing `memoryQueries` field:

```ts
readonly memoryStats = new MemoryStatsService(this.graph);
readonly duplicates = new DuplicateFinder(this.graph);
```

Add the imports:

```ts
import { MemoryStatsService } from './control/memory-stats-service.js';
import { DuplicateFinder } from './control/duplicate-finder.js';
```

In `src/status-server/routes/assistant.ts`, import the endpoints and register them next to `/assistant/search` (line ~96):

```ts
{ method: 'GET', path: '/assistant/overview', endpoint: overviewEndpoint },
{ method: 'GET', path: '/assistant/graph/duplicates', endpoint: duplicatesEndpoint },
```

- [ ] **Step 4: Verify against the live server**

```bash
npm run build && npm run typecheck
```

Then, with the status server running, confirm both routes answer (bootstrap first, because `/assistant/*` requires a bearer token):

```bash
TOK=$(curl -s http://127.0.0.1:6876/assistant/auth/bootstrap | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).token))")
curl -s -H "Authorization: Bearer $TOK" http://127.0.0.1:6876/assistant/overview | head -c 400
curl -s -H "Authorization: Bearer $TOK" http://127.0.0.1:6876/assistant/graph/duplicates | head -c 400
```

Expected: JSON overview with non-zero `nodes.active`; duplicates `items` array.

- [ ] **Step 5: Commit**

```bash
git add src/status-server/routes/assistant/overview-routes.ts src/status-server/routes/assistant.ts src/assistant/assistant-service.ts tests/assistant-overview-route.test.ts
git commit -m "feat(assistant): expose memory overview and duplicate endpoints"
```

---

# Phase 2 — Overview view (Variant A)

**Milestone:** The Assistant tab opens on a working Overview page. Digest slot renders a placeholder until Phase 4.

### Task 5: Overview API client

**Files:**
- Modify: `dashboard/src/assistant-api.ts` (append after `searchAssistantMemory`, line ~139)
- Test: `dashboard/tests/assistant-overview-api.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { getAssistantOverview } from '../src/assistant-api.js';

test('getAssistantOverview sends the bearer token and parses the response', async () => {
  const calls: Array<{ url: string; auth: string }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), auth: headers.get('Authorization') ?? '' });
    return new Response(JSON.stringify({
      generatedAtUtc: '2026-09-10T12:40:33.155Z',
      graphVersion: 6608,
      nodes: { active: 1109, byType: [] },
      assertions: {
        active: 1408, pinned: 0, byPredicate: [], byBasis: [],
        byConfidence: { high: 0, medium: 0, low: 0, unscored: 1408 },
      },
      tiers: [],
      evidenceCount: 0, observationCount: 0, pendingCandidateCount: 0,
      duplicatePairCount: 4, jobs: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof globalThis.fetch;

  try {
    const overview = await getAssistantOverview('tok-1');
    assert.equal(overview.nodes.active, 1109);
    assert.equal(overview.duplicatePairCount, 4);
    assert.equal(calls[0]?.url, '/assistant/overview');
    assert.equal(calls[0]?.auth, 'Bearer tok-1');
  } finally {
    globalThis.fetch = original;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js --dashboard`
Expected: FAIL — `getAssistantOverview` is not exported.

- [ ] **Step 3: Add the client functions**

```ts
export function getAssistantOverview(token: string): Promise<AssistantMemoryOverview> {
  return request('/assistant/overview', token, AssistantMemoryOverviewSchema);
}

const DuplicateListSchema = z.object({
  items: z.array(z.object({
    normalizedKey: z.string(),
    type: z.string(),
    targetNodeId: z.string(),
    targetDisplayName: z.string(),
    targetDegree: z.number(),
    sourceNodeId: z.string(),
    sourceDisplayName: z.string(),
    sourceDegree: z.number(),
  }).strict()),
}).strict();
export type AssistantDuplicateList = z.infer<typeof DuplicateListSchema>;

export function getAssistantDuplicates(token: string): Promise<AssistantDuplicateList> {
  return request('/assistant/graph/duplicates', token, DuplicateListSchema);
}
```

Add `AssistantMemoryOverview` and `AssistantMemoryOverviewSchema` to the existing `@siftkit/contracts` import block at the top of the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js --dashboard`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/assistant-api.ts dashboard/tests/assistant-overview-api.test.ts
git commit -m "feat(dashboard): add overview and duplicates API clients"
```

---

### Task 6: Capacity gauges component

**Files:**
- Create: `dashboard/src/components/memory/CapacityGauges.tsx`
- Create: `dashboard/src/styles/memory.css`
- Modify: `dashboard/src/styles.css` (add `@import './styles/memory.css';`)
- Test: `dashboard/tests/memory-capacity-gauges.test.tsx` (create)

The warning threshold is **85%**, matching `tierTone` in `docs/mockups/memory/build.mjs`.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { CapacityGauges } from '../src/components/memory/CapacityGauges.js';

const TIERS = [
  { tier: 1 as const, documents: 1, limit: 1, tokens: 6692, retrievals: 2, newestUtc: null },
  { tier: 2 as const, documents: 2, limit: 25, tokens: 198, retrievals: 0, newestUtc: null },
  { tier: 3 as const, documents: 439, limit: 500, tokens: 58079, retrievals: 8, newestUtc: null },
];

test('CapacityGauges shows counts, percentage and a near-limit warning for tier 3', () => {
  const html = renderToStaticMarkup(<CapacityGauges tiers={TIERS} onReviewArchive={() => {}} />);
  assert.match(html, /439/);
  assert.match(html, /\/500/);
  assert.match(html, /87\.8%/);
  assert.match(html, /memory-gauge-warn/);       // tier 3 is over the 85% threshold
  assert.match(html, /61 slots left/);
});

test('CapacityGauges omits the warning when every tier is comfortable', () => {
  const calm = TIERS.map((tier) => (
    tier.tier === 3 ? { ...tier, documents: 100 } : tier
  ));
  const html = renderToStaticMarkup(<CapacityGauges tiers={calm} onReviewArchive={() => {}} />);
  assert.doesNotMatch(html, /memory-gauge-warn/);
  assert.doesNotMatch(html, /slots left/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js --dashboard`
Expected: FAIL — cannot find `CapacityGauges`.

- [ ] **Step 3: Implement**

```tsx
import React from 'react';
import type { AssistantTierUsage } from '@siftkit/contracts';

const TIER_LABEL = { 1: 'Profile', 2: 'Dossier', 3: 'Archive' } as const;
const WARN_AT_PERCENT = 85;

export type CapacityGaugesProps = {
  tiers: readonly AssistantTierUsage[];
  onReviewArchive(): void;
};

export function CapacityGauges(props: CapacityGaugesProps) {
  const pressured = props.tiers.filter((tier) => percentOf(tier) >= WARN_AT_PERCENT);
  return (
    <section className="panel memory-capacity">
      <h2>Document capacity</h2>
      {props.tiers.map((tier) => {
        const percent = percentOf(tier);
        const warn = percent >= WARN_AT_PERCENT;
        return (
          <div className="memory-gauge" key={tier.tier}>
            <div className="memory-gauge-name">
              Tier {tier.tier}<small>{TIER_LABEL[tier.tier].toUpperCase()}</small>
            </div>
            <div className="memory-gauge-track">
              <i
                className={warn ? 'memory-gauge-warn' : ''}
                style={{ width: `${Math.min(100, percent)}%` }}
              />
            </div>
            <div className="memory-gauge-count">
              <b>{tier.documents}</b><span>/{tier.limit}</span>
              <br /><span>{percent.toFixed(1)}%</span>
            </div>
            <div className="memory-note">
              {tier.tokens.toLocaleString('en-US')} tokens · {tier.retrievals} retrievals
            </div>
          </div>
        );
      })}
      {pressured.map((tier) => (
        <div className="memory-alert" key={`alert-${tier.tier}`}>
          <h4>⚠ Tier {tier.tier} near limit — {tier.limit - tier.documents} slots left</h4>
          <p>
            At {percentOf(tier).toFixed(1)}% the compiler starts archiving the
            lowest-utility documents automatically.
          </p>
          <button type="button" className="save" onClick={props.onReviewArchive}>
            Review archive queue
          </button>
        </div>
      ))}
    </section>
  );
}

function percentOf(tier: AssistantTierUsage): number {
  return (tier.documents / tier.limit) * 100;
}
```

Create `dashboard/src/styles/memory.css` by porting the CSS from `docs/mockups/memory/variant-a.mjs` (the `const css` template literal, lines 8–61), renaming the mockup's generic class names to the `memory-` prefixed ones used above: `.gauge` → `.memory-gauge`, `.gauge .tname` → `.memory-gauge-name`, `.gauge .track` → `.memory-gauge-track`, `.gauge .cnt` → `.memory-gauge-count`, `.alert` → `.memory-alert`, `.note` → `.memory-note`. Add `@import './styles/memory.css';` to the top of `dashboard/src/styles.css`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js --dashboard`
Expected: PASS — both tests.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/components/memory/CapacityGauges.tsx dashboard/src/styles/memory.css dashboard/src/styles.css dashboard/tests/memory-capacity-gauges.test.tsx
git commit -m "feat(dashboard): add memory capacity gauges"
```

---

### Task 7: Overview page

**Files:**
- Create: `dashboard/src/tabs/memory/MemoryOverview.tsx`
- Test: `dashboard/tests/memory-overview.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MemoryOverview } from '../src/tabs/memory/MemoryOverview.js';
import type { AssistantMemoryOverview } from '@siftkit/contracts';

const OVERVIEW: AssistantMemoryOverview = {
  generatedAtUtc: '2026-09-10T12:40:33.155Z',
  graphVersion: 6608,
  nodes: { active: 1109, byType: [{ type: 'software', count: 445 }] },
  assertions: {
    active: 1408, pinned: 0,
    byPredicate: [{ predicate: 'USES', count: 597 }],
    byBasis: [{ basis: 'passive_observation', count: 1406 }],
    byConfidence: { high: 24, medium: 136, low: 0, unscored: 1248 },
  },
  tiers: [
    { tier: 1, documents: 1, limit: 1, tokens: 6692, retrievals: 2, newestUtc: null },
    { tier: 2, documents: 2, limit: 25, tokens: 198, retrievals: 0, newestUtc: null },
    { tier: 3, documents: 439, limit: 500, tokens: 58079, retrievals: 8, newestUtc: null },
  ],
  evidenceCount: 4329, observationCount: 6478, pendingCandidateCount: 1244,
  duplicatePairCount: 4,
  jobs: [{ jobType: 'image_extraction', status: 'dead_letter', count: 30 }],
};

test('MemoryOverview renders headline stats, composition and the duplicate prompt', () => {
  const html = renderToStaticMarkup(
    <MemoryOverview
      overview={OVERVIEW}
      digestSlot={<div>digest</div>}
      onReviewArchive={() => {}}
      onResolveDuplicates={() => {}}
    />,
  );
  assert.match(html, /1,109/);      // entities
  assert.match(html, /1,408/);      // beliefs
  assert.match(html, /1,244/);      // pending candidates
  assert.match(html, /software/);   // composition
  assert.match(html, /USES/);       // predicates
  assert.match(html, /digest/);     // digest slot is rendered
  assert.match(html, /4/);          // duplicate pairs
});

test('MemoryOverview surfaces the unscored-confidence share', () => {
  const html = renderToStaticMarkup(
    <MemoryOverview
      overview={OVERVIEW}
      digestSlot={null}
      onReviewArchive={() => {}}
      onResolveDuplicates={() => {}}
    />,
  );
  assert.match(html, /88\.6%/);     // 1248 / 1408 carry no confidence
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js --dashboard`
Expected: FAIL — cannot find `MemoryOverview`.

- [ ] **Step 3: Implement**

```tsx
import React from 'react';
import type { AssistantMemoryOverview } from '@siftkit/contracts';
import { CapacityGauges } from '../../components/memory/CapacityGauges.js';

export type MemoryOverviewProps = {
  overview: AssistantMemoryOverview;
  digestSlot: React.ReactNode;
  onReviewArchive(): void;
  onResolveDuplicates(): void;
};

const num = (value: number) => value.toLocaleString('en-US');

export function MemoryOverview(props: MemoryOverviewProps) {
  const { overview } = props;
  const { byConfidence } = overview.assertions;
  const unscoredShare = overview.assertions.active === 0
    ? 0
    : (byConfidence.unscored / overview.assertions.active) * 100;
  const maxType = overview.nodes.byType[0]?.count ?? 1;
  const maxPredicate = overview.assertions.byPredicate[0]?.count ?? 1;

  return (
    <div className="memory-overview">
      {props.digestSlot}
      <div className="memory-hero">
        <CapacityGauges tiers={overview.tiers} onReviewArchive={props.onReviewArchive} />
        <div className="memory-stats">
          <Stat label="Entities" value={num(overview.nodes.active)}
            note={`${overview.nodes.byType.length} types`} />
          <Stat label="Beliefs" value={num(overview.assertions.active)}
            note={`${overview.assertions.pinned} pinned`} />
          <Stat label="Evidence" value={num(overview.evidenceCount)} note="records" />
          <Stat label="Observations" value={num(overview.observationCount)} note="capture events" />
          <Stat label="Awaiting review" value={num(overview.pendingCandidateCount)}
            note="candidate beliefs" />
          <button type="button" className="memory-stat memory-stat-action"
            onClick={props.onResolveDuplicates}>
            <span>Duplicates</span>
            <b>{overview.duplicatePairCount}</b>
            <em>likely pairs — resolve</em>
          </button>
        </div>
      </div>

      <div className="memory-grid3">
        <section className="panel">
          <h2>What it knows about</h2>
          {overview.nodes.byType.slice(0, 9).map((entry) => (
            <Bar key={entry.type} label={entry.type.replace(/_/gu, ' ')}
              count={entry.count} max={maxType} />
          ))}
        </section>
        <section className="panel">
          <h2>How they relate</h2>
          {overview.assertions.byPredicate.slice(0, 9).map((entry) => (
            <Bar key={entry.predicate} label={entry.predicate}
              count={entry.count} max={maxPredicate} />
          ))}
        </section>
        <section className="panel">
          <h2>How sure it is</h2>
          <Bar label="high ≥0.8" count={byConfidence.high} max={overview.assertions.active} />
          <Bar label="medium" count={byConfidence.medium} max={overview.assertions.active} />
          <Bar label="low" count={byConfidence.low} max={overview.assertions.active} />
          <Bar label="unscored" count={byConfidence.unscored} max={overview.assertions.active} />
          <p className="memory-note">
            <b>{unscoredShare.toFixed(1)}% carry no confidence score.</b>{' '}
            {overview.assertions.byBasis.map((entry) => (
              `${num(entry.count)} ${entry.basis.replace(/_/gu, ' ')}`
            )).join(' · ')}
          </p>
        </section>
      </div>
    </div>
  );
}

function Stat(props: { label: string; value: string; note: string }) {
  return (
    <div className="memory-stat">
      <span>{props.label}</span><b>{props.value}</b><em>{props.note}</em>
    </div>
  );
}

function Bar(props: { label: string; count: number; max: number }) {
  return (
    <div className="memory-row">
      <span>{props.label}</span>
      <span className="memory-row-n">{num(props.count)}</span>
      <div className="memory-row-bar">
        <i style={{ width: `${props.max === 0 ? 0 : (props.count / props.max) * 100}%` }} />
      </div>
    </div>
  );
}
```

Port the remaining layout CSS (`.memory-hero`, `.memory-stats`, `.memory-stat`, `.memory-grid3`, `.memory-row*`) from `docs/mockups/memory/variant-a.mjs` lines 12–46 into `dashboard/src/styles/memory.css`, applying the same `memory-` prefix rename.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js --dashboard`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/tabs/memory/MemoryOverview.tsx dashboard/src/styles/memory.css dashboard/tests/memory-overview.test.tsx
git commit -m "feat(dashboard): add memory overview page"
```

---

### Task 8: View switcher and controller wiring

**Files:**
- Modify: `dashboard/src/tabs/AssistantTab.tsx`
- Modify: `dashboard/src/hooks/useAssistantController.ts`
- Modify: `dashboard/tests/assistant-tab.test.tsx`
- Test: `dashboard/tests/memory-view-switch.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AssistantTab } from '../src/tabs/AssistantTab.js';
import { PROPS } from './helpers/assistant-tab-props.js';

test('AssistantTab renders the overview view by default', () => {
  const html = renderToStaticMarkup(<AssistantTab {...PROPS} view="overview" />);
  assert.match(html, /Document capacity/);
  assert.doesNotMatch(html, /Memory Inspector/);
});

test('AssistantTab renders the explorer view when selected', () => {
  const html = renderToStaticMarkup(<AssistantTab {...PROPS} view="explorer" />);
  assert.match(html, /Search nodes, assertions/);
});

test('AssistantTab shows a loading state before the overview arrives', () => {
  const html = renderToStaticMarkup(
    <AssistantTab {...PROPS} view="overview" overview={null} />,
  );
  assert.match(html, /Loading memory overview/);
});
```

- [ ] **Step 2: Extract shared props, then run**

Move the `PROPS` object currently inlined in `dashboard/tests/assistant-tab.test.tsx` into a new `dashboard/tests/helpers/assistant-tab-props.tsx` exporting `export const PROPS: AssistantTabProps = { ... }`, and import it from both test files. Add the new fields `view: 'overview'`, `overview: null`, `onViewChange() {}`.

Run: `npm run build:test && node .\dist\test-runner\run-tests.js --dashboard`
Expected: FAIL — `view` is not a known prop.

- [ ] **Step 3: Implement the switcher**

In `dashboard/src/tabs/AssistantTab.tsx`, add to `AssistantTabProps`:

```ts
export type MemoryView = 'overview' | 'explorer';

// added to AssistantTabProps:
  view: MemoryView;
  overview: AssistantMemoryOverview | null;
  onViewChange(view: MemoryView): void;
  onResolveDuplicates(): void;
```

Wrap the existing return in a switcher, keeping the current inspector markup as the `explorer` branch:

```tsx
export function AssistantTab(props: AssistantTabProps) {
  return (
    <div className="assistant-root">
      <nav className="memory-viewnav">
        <button type="button" className={props.view === 'overview' ? 'on' : ''}
          onClick={() => props.onViewChange('overview')}>Overview</button>
        <button type="button" className={props.view === 'explorer' ? 'on' : ''}
          onClick={() => props.onViewChange('explorer')}>Explorer</button>
      </nav>
      {props.view === 'overview'
        ? renderOverview(props)
        : <div className="assistant-inspector">{/* existing panes, unchanged */}</div>}
    </div>
  );
}

function renderOverview(props: AssistantTabProps) {
  if (props.overview === null) return <p className="hint">Loading memory overview…</p>;
  return (
    <MemoryOverview
      overview={props.overview}
      digestSlot={null}
      onReviewArchive={() => props.onViewChange('explorer')}
      onResolveDuplicates={props.onResolveDuplicates}
    />
  );
}
```

In `useAssistantController.ts`, add state and a load effect following the existing token pattern:

```ts
const [view, setView] = React.useState<MemoryView>('overview');
const [overview, setOverview] = React.useState<AssistantMemoryOverview | null>(null);

React.useEffect(() => {
  if (token === null) return;
  let cancelled = false;
  void getAssistantOverview(token)
    .then((value) => { if (!cancelled) setOverview(value); })
    .catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
  return () => { cancelled = true; };
}, [token]);
```

Expose `view`, `overview`, `onViewChange: setView`, and `onResolveDuplicates` in the returned `tabProps`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js --dashboard`
Expected: PASS — including the pre-existing `assistant-tab` suite, now importing shared props.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/tabs/AssistantTab.tsx dashboard/src/hooks/useAssistantController.ts dashboard/tests/
git commit -m "feat(dashboard): switch the assistant tab between overview and explorer"
```

---

# Phase 3 — Explorer view (Variant B) and merge

**Milestone:** Explorer lists entities by connectedness, inspects beliefs with provenance, and can merge duplicates.

### Task 9: Entity list with degree

**Files:**
- Modify: `src/assistant/control/memory-stats-service.ts` (add `listEntitiesByDegree`)
- Modify: `src/status-server/routes/assistant/overview-routes.ts`
- Modify: `src/status-server/routes/assistant.ts`
- Modify: `packages/contracts/src/assistant.ts`
- Test: `tests/assistant-entity-degree.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryStatsService } from '../src/assistant/control/memory-stats-service.js';
import { withAssistantContext } from './helpers/assistant-fixture.js';

test('listEntitiesByDegree ranks entities by active assertion count', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const hub = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: 'person:owner', displayName: 'the user',
      description: null, sensitivity: 'personal', properties: {},
    });
    graph.nodes.createNode({
      ownerId, type: 'software', canonicalKey: null, displayName: 'Lonely',
      description: null, sensitivity: 'personal', properties: {},
    });
    const evidence = graph.evidence.recordTextEvidence({
      ownerId, deviceId: null, parentEvidenceId: null, sourceType: 'conversation_message',
      sourceEventId: 'chat:m1', sourceRef: 'chat', capturedAtUtc: '2026-08-10T00:00:00.000Z',
      sourceTimezone: null, sensitivity: 'personal', retentionUntilUtc: null,
      metadata: {}, text: 'uses cuda',
    });
    graph.assertionService.assert({
      ownerId, actorType: 'user', actorRef: null, subjectNodeId: hub.id,
      predicate: 'USES', object: { kind: 'literal', valueType: 'text', value: 'CUDA' },
      scopeNodeId: null, basis: 'explicit_user_statement', sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, observedAtUtc: '2026-08-10T00:00:00.000Z',
      topics: [], attributes: {},
      searchText: { subject: 'the user', predicate: 'USES', object: 'CUDA', scope: '' },
      evidence: [{ evidenceId: evidence.id, stance: 'supports', weight: 1 }],
    });

    const items = new MemoryStatsService(graph).listEntitiesByDegree(ownerId, 10);
    assert.equal(items[0]?.displayName, 'the user');
    assert.equal(items[0]?.degree, 1);
    assert.equal(items[1]?.degree, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js assistant-entity-degree`
Expected: FAIL — `listEntitiesByDegree` is not a function.

- [ ] **Step 3: Implement**

Add to `packages/contracts/src/assistant.ts`:

```ts
export const AssistantEntityRankSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  type: z.string(),
  degree: z.number().int().min(0),
  createdAtUtc: z.string(),
}).strict();
export type AssistantEntityRank = z.infer<typeof AssistantEntityRankSchema>;
```

Add to `MemoryStatsService`:

```ts
listEntitiesByDegree(ownerId: string, limit: number): AssistantEntityRank[] {
  return this.graph.database.prepare(`
    SELECT n.id, n.display_name AS displayName, n.type, n.created_at_utc AS createdAtUtc,
           (SELECT count(*) FROM graph_assertions a
             WHERE a.status = 'active'
               AND (a.subject_node_id = n.id OR a.object_node_id = n.id)) AS degree
      FROM graph_nodes n
     WHERE n.owner_id = ? AND n.status = 'active'
     ORDER BY degree DESC, n.created_at_utc ASC
     LIMIT ?
  `).all(ownerId, limit).map((row) => AssistantEntityRankSchema.parse(row));
}
```

Add the endpoint to `overview-routes.ts` and register `GET /assistant/graph/entities`:

```ts
export const entitiesEndpoint = assistantRoute(({ service, res, url }) => {
  sendJson(res, 200, {
    items: service.memoryStats.listEntitiesByDegree(service.ownerId, integerParam(url, 'limit', 50)),
  });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js assistant-entity-degree`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/assistant/control/memory-stats-service.ts src/status-server/routes/assistant/overview-routes.ts src/status-server/routes/assistant.ts packages/contracts/src/assistant.ts tests/assistant-entity-degree.test.ts
git commit -m "feat(assistant): rank entities by connectedness"
```

---

### Task 10: Merge endpoint

**Files:**
- Modify: `src/status-server/routes/assistant/mutation-routes.ts`
- Modify: `src/status-server/routes/assistant.ts`
- Modify: `packages/contracts/src/assistant.ts`
- Test: `tests/assistant-merge-route.test.ts` (create)

`NodeMergeService.merge` already exists at `src/assistant/graph/merge-service.ts:115` and is reversible. This task only exposes it. **Actor type must be `'user'`** — `checkMergeSafety` blocks `assistant_proposal` from merging into the owner identity (`owner_identity_collapse`), which is exactly the "merge my 4 identities" case.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { withAssistantContext } from './helpers/assistant-fixture.js';

test('merging a duplicate repoints its assertions and blocks owner collapse', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const owner = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: 'person:owner', displayName: 'the user',
      description: null, sensitivity: 'personal', properties: {},
    });
    const alias = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: null, displayName: 'User denys',
      description: null, sensitivity: 'personal', properties: {},
    });

    // The assistant may not fold a node into the owner identity.
    const proposed = graph.merges.merge({
      ownerId, sourceNodeId: alias.id, targetNodeId: owner.id,
      actorType: 'assistant_proposal', basis: 'duplicate_name', reason: 'looks the same',
    });
    assert.equal(proposed.kind, 'blocked');
    if (proposed.kind === 'blocked') assert.equal(proposed.code, 'owner_identity_collapse');

    // The owner may.
    const applied = graph.merges.merge({
      ownerId, sourceNodeId: alias.id, targetNodeId: owner.id,
      actorType: 'user', basis: 'duplicate_name', reason: 'same person',
    });
    assert.equal(applied.kind, 'merged');
    assert.equal(graph.nodes.requireNode(alias.id).status, 'merged');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js assistant-merge-route`
Expected: PASS for the service assertions — this test documents the guard the route must honour. If it fails, stop: the merge service changed and the route design below is unsafe.

- [ ] **Step 3: Add the route**

In `packages/contracts/src/assistant.ts`:

```ts
export const AssistantMergeRequestSchema = z.object({
  sourceNodeId: z.string().trim().min(1),
  reason: z.string().trim().min(1),
}).strict();
export type AssistantMergeRequest = z.infer<typeof AssistantMergeRequestSchema>;
```

In `mutation-routes.ts`:

```ts
export const mergeNodesEndpoint = assistantRoute(async ({ service, req, res, match }) => {
  const request = await body(req, AssistantMergeRequestSchema);
  const outcome = service.graph.merges.merge({
    ownerId: service.ownerId,
    sourceNodeId: request.sourceNodeId,
    targetNodeId: id(match),
    actorType: 'user',
    basis: 'duplicate_entity',
    reason: request.reason,
  });
  if (outcome.kind === 'blocked') {
    sendError(res, 409, outcome.code, outcome.message);
    return;
  }
  sendJson(res, 200, { ...outcome, ...success(service) });
});
```

Register in `assistant.ts`:

```ts
{
  method: 'POST', path: /^\/assistant\/graph\/nodes\/([^/]+)\/merge$/u,
  endpoint: mergeNodesEndpoint,
},
```

- [ ] **Step 4: Verify typecheck and route registration**

Run: `npm run build && npm run typecheck`
Expected: clean. Then confirm the route is reachable and rejects an unknown source:

```bash
curl -s -X POST -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d '{"sourceNodeId":"node_missing","reason":"test"}' \
  http://127.0.0.1:6876/assistant/graph/nodes/node_missing/merge
```

Expected: HTTP 409 with code `same_node` or `unknown_node` — not a 404.

- [ ] **Step 5: Commit**

```bash
git add src/status-server/routes/assistant/mutation-routes.ts src/status-server/routes/assistant.ts packages/contracts/src/assistant.ts tests/assistant-merge-route.test.ts
git commit -m "feat(assistant): expose node merge over HTTP"
```

---

### Task 11: Explorer page

**Files:**
- Create: `dashboard/src/tabs/memory/MemoryExplorer.tsx`
- Test: `dashboard/tests/memory-explorer.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MemoryExplorer } from '../src/tabs/memory/MemoryExplorer.js';

const ENTITIES = [
  { id: 'n1', displayName: 'the user', type: 'person', degree: 712, createdAtUtc: '2026-08-28T00:00:00.000Z' },
  { id: 'n2', displayName: 'SiftKit', type: 'project', degree: 42, createdAtUtc: '2026-09-01T00:00:00.000Z' },
];
const ASSERTIONS = [{
  id: 'a1', subjectNodeId: 'n1', predicate: 'USES', objectText: 'CUDA', scopeText: '',
  status: 'active', basis: 'passive_observation', confidence: 0.55, sensitivity: 'personal',
  pinned: false, userDemoted: false, validFromUtc: null, validToUtc: null,
  lastObservedAtUtc: '2026-09-09T00:00:00.000Z',
}];

test('MemoryExplorer lists entities with degree and flags duplicates', () => {
  const html = renderToStaticMarkup(
    <MemoryExplorer
      entities={ENTITIES} selectedId="n1" assertions={ASSERTIONS}
      duplicateIds={['n2']} tiers={[]}
      onSelect={() => {}} onMerge={() => {}} onPin={() => {}} onDemote={() => {}}
    />,
  );
  assert.match(html, /the user/);
  assert.match(html, /712/);
  assert.match(html, /memory-dup-flag/);   // n2 marked as duplicate
  assert.match(html, /USES/);              // inspector shows the selected entity's beliefs
  assert.match(html, /CUDA/);
});

test('MemoryExplorer marks unscored beliefs distinctly', () => {
  const html = renderToStaticMarkup(
    <MemoryExplorer
      entities={ENTITIES} selectedId="n1"
      assertions={[{ ...ASSERTIONS[0]!, confidence: 0 }]}
      duplicateIds={[]} tiers={[]}
      onSelect={() => {}} onMerge={() => {}} onPin={() => {}} onDemote={() => {}}
    />,
  );
  assert.match(html, /unscored/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js --dashboard`
Expected: FAIL — cannot find `MemoryExplorer`.

- [ ] **Step 3: Implement**

```tsx
import React from 'react';
import type {
  AssistantAssertionDto, AssistantEntityRank, AssistantTierUsage,
} from '@siftkit/contracts';

export type MemoryExplorerProps = {
  entities: readonly AssistantEntityRank[];
  selectedId: string | null;
  assertions: readonly AssistantAssertionDto[];
  duplicateIds: readonly string[];
  tiers: readonly AssistantTierUsage[];
  onSelect(id: string): void;
  onMerge(id: string): void;
  onPin(id: string, pinned: boolean): void;
  onDemote(id: string): void;
};

export function MemoryExplorer(props: MemoryExplorerProps) {
  const selected = props.entities.find((entity) => entity.id === props.selectedId) ?? null;
  return (
    <div className="memory-explorer">
      <aside className="memory-rail">
        <h2>Capacity</h2>
        {props.tiers.map((tier) => (
          <div className="memory-capsule" key={tier.tier}>
            <span>Tier {tier.tier}</span>
            <b>{tier.documents}/{tier.limit}</b>
          </div>
        ))}
      </aside>

      <main className="memory-list">
        <h2>Entities</h2>
        {props.entities.map((entity) => (
          <button
            type="button"
            key={entity.id}
            className={`memory-entity${entity.id === props.selectedId ? ' on' : ''}`}
            onClick={() => props.onSelect(entity.id)}
          >
            <span className="memory-entity-name">
              {entity.displayName}
              {props.duplicateIds.includes(entity.id)
                ? <span className="memory-dup-flag">duplicate?</span>
                : null}
            </span>
            <span className="memory-entity-type">{entity.type.replace(/_/gu, ' ')}</span>
            <span className="memory-entity-degree">{entity.degree}</span>
          </button>
        ))}
      </main>

      <aside className="memory-inspector">
        {selected === null ? <p className="hint">Select an entity.</p> : (
          <>
            <h3>{selected.displayName}</h3>
            <p className="memory-note">
              {selected.type.replace(/_/gu, ' ')} · {selected.degree} beliefs
            </p>
            {props.duplicateIds.includes(selected.id) ? (
              <button type="button" className="save" onClick={() => props.onMerge(selected.id)}>
                Review merge
              </button>
            ) : null}
            {props.assertions.map((assertion) => (
              <div className="memory-assertion" key={assertion.id}>
                <div>
                  <b>{assertion.predicate}</b> {assertion.objectText}
                </div>
                <div className="memory-note">
                  {assertion.confidence > 0
                    ? assertion.confidence.toFixed(2)
                    : <span className="memory-unscored">unscored</span>}
                  {' · '}
                  {assertion.basis === 'passive_observation' ? 'observed' : 'you stated'}
                </div>
                <div className="memory-assertion-actions">
                  <button type="button"
                    onClick={() => props.onPin(assertion.id, !assertion.pinned)}>
                    {assertion.pinned ? 'unpin' : 'pin'}
                  </button>
                  <button type="button" onClick={() => props.onDemote(assertion.id)}>drop</button>
                </div>
              </div>
            ))}
          </>
        )}
      </aside>
    </div>
  );
}
```

Port `.memory-explorer`, `.memory-rail`, `.memory-list`, `.memory-entity*`, `.memory-inspector`, `.memory-assertion*`, `.memory-dup-flag` CSS from `docs/mockups/memory/variant-b.mjs` lines 8–66 into `dashboard/src/styles/memory.css`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js --dashboard`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/tabs/memory/MemoryExplorer.tsx dashboard/src/styles/memory.css dashboard/tests/memory-explorer.test.tsx
git commit -m "feat(dashboard): add memory explorer view"
```

---

# Phase 4 — Landing digest

**Milestone:** Overview opens with a generated greeting that streams in, and reuses the cached digest when nothing interesting changed.

### Task 12: Digest store and freshness rule

**Files:**
- Create: `src/assistant/digest/digest-store.ts`
- Test: `tests/assistant-digest-store.test.ts` (create)

Freshness rule: regenerate when **new entities + new beliefs created since the cached digest's `graphVersion` is ≥ 5**, otherwise reuse. Below that threshold the digest would repeat itself and the generation is wasted.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { DigestStore, shouldRegenerate } from '../src/assistant/digest/digest-store.js';
import { withAssistantContext } from './helpers/assistant-fixture.js';

test('DigestStore round-trips the cached digest', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const store = new DigestStore(graph.database, graph.clock);
    assert.equal(store.read(ownerId), null);

    store.write(ownerId, {
      generatedAtUtc: '2026-09-10T09:04:00.000Z',
      graphVersion: 6608,
      newEntityCount: 24,
      newBeliefCount: 56,
      paragraphs: ['Since yesterday I picked up 24 new entities.'],
    });
    const cached = store.read(ownerId);
    assert.equal(cached?.newBeliefCount, 56);
    assert.equal(cached?.paragraphs.length, 1);
  });
});

test('shouldRegenerate reuses the cache below the novelty threshold of 5', () => {
  assert.equal(shouldRegenerate(null, 0, 0), true);                  // nothing cached yet
  assert.equal(shouldRegenerate({ graphVersion: 1 }, 1, 1), false);  // 2 changes: reuse
  assert.equal(shouldRegenerate({ graphVersion: 1 }, 2, 2), false);  // 4 changes: still reuse
  assert.equal(shouldRegenerate({ graphVersion: 1 }, 3, 2), true);   // 5 changes: regenerate
  assert.equal(shouldRegenerate({ graphVersion: 1 }, 24, 56), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js assistant-digest-store`
Expected: FAIL — cannot find module `digest-store.js`.

- [ ] **Step 3: Implement**

```ts
import { z } from '../../lib/zod.js';
import { parseJsonText } from '../../lib/json.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { Clock } from '../clock.js';
import { ASSISTANT_METADATA_PREFIX } from '../storage/schema.js';

const METADATA_KEY = `${ASSISTANT_METADATA_PREFIX}memory_digest.v1`;
/** Fewer than this many new entities+beliefs is not worth a generation. */
const NOVELTY_THRESHOLD = 5;

export const CachedDigestSchema = z.object({
  generatedAtUtc: z.string(),
  graphVersion: z.number().int().min(0),
  newEntityCount: z.number().int().min(0),
  newBeliefCount: z.number().int().min(0),
  paragraphs: z.array(z.string()).min(1).max(5),
}).strict();
export type CachedDigest = z.infer<typeof CachedDigestSchema>;

const StoredSchema = z.record(z.string(), CachedDigestSchema);
const MetadataValueRowSchema = z.object({ value: z.string() }).strict();

export function shouldRegenerate(
  cached: { readonly graphVersion: number } | null,
  newEntityCount: number,
  newBeliefCount: number,
): boolean {
  if (cached === null) return true;
  return newEntityCount + newBeliefCount >= NOVELTY_THRESHOLD;
}

export class DigestStore {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly clock: Clock,
  ) {}

  read(ownerId: string): CachedDigest | null {
    return this.readAll()[ownerId] ?? null;
  }

  write(ownerId: string, digest: CachedDigest): void {
    const updated = StoredSchema.parse({
      ...this.readAll(),
      [ownerId]: CachedDigestSchema.parse(digest),
    });
    this.database.prepare(`
      INSERT INTO runtime_metadata (key, value, updated_at_utc)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value, updated_at_utc = excluded.updated_at_utc
    `).run(METADATA_KEY, JSON.stringify(updated), this.clock.nowUtc());
  }

  private readAll(): Record<string, CachedDigest> {
    const row = this.database
      .prepare('SELECT value FROM runtime_metadata WHERE key = ?')
      .get(METADATA_KEY);
    if (row === undefined || row === null) return {};
    return StoredSchema.parse(parseJsonText(MetadataValueRowSchema.parse(row).value));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js assistant-digest-store`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/assistant/digest/digest-store.ts tests/assistant-digest-store.test.ts
git commit -m "feat(assistant): cache the memory digest with a novelty threshold"
```

---

### Task 13: Digest generator

**Files:**
- Modify: `src/assistant/inference/roles.ts` (add the `memory_digest` role)
- Create: `src/assistant/digest/digest-service.ts`
- Test: `tests/assistant-digest-service.test.ts` (create)

The assistant inference client (`src/assistant/inference/client.ts:75`) is **JSON-schema-pinned and non-streaming**, capped at 2,048 output tokens. The digest is therefore generated as a whole and streamed to the browser by the *route*, not by the model. Do not attempt token streaming from the model here.

Every request needs a `role` from `ASSISTANT_INFERENCE_ROLES`, and there is no digest role yet, so this task adds one. Roles carry the untrusted-content preamble via `buildRoleSystemPrompt` — the digest reads entity names harvested from screen captures, which is exactly the injection surface that preamble exists to blunt. **Use it; do not hand-write the system prompt.**

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { DigestService } from '../src/assistant/digest/digest-service.js';
import { DigestStore } from '../src/assistant/digest/digest-store.js';
import { withAssistantContextAsync } from './helpers/assistant-fixture.js';

test('DigestService reuses the cache when nothing interesting changed', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    let calls = 0;
    const store = new DigestStore(graph.database, graph.clock);
    store.write(ownerId, {
      generatedAtUtc: '2026-09-09T18:04:00.000Z', graphVersion: 6608,
      newEntityCount: 3, newBeliefCount: 4, paragraphs: ['Old digest.'],
    });
    const service = new DigestService(graph, store, {
      async complete() {
        calls += 1;
        return { text: '{"paragraphs":["Fresh."]}', backendId: 'test', modelId: 'test-model' };
      },
    });

    const result = await service.getDigest(ownerId);
    assert.equal(result.source, 'cache');
    assert.equal(result.paragraphs[0], 'Old digest.');
    assert.equal(calls, 0, 'must not call the model when reusing');
  });
});

test('DigestService generates and persists when the graph moved', async () => {
  await withAssistantContextAsync(async ({ graph, ownerId }) => {
    for (let index = 0; index < 6; index += 1) {
      graph.nodes.createNode({
        ownerId, type: 'software', canonicalKey: null, displayName: `Tool ${index}`,
        description: null, sensitivity: 'personal', properties: {},
      });
    }
    const store = new DigestStore(graph.database, graph.clock);
    const service = new DigestService(graph, store, {
      async complete() {
        return {
          text: '{"paragraphs":["Since yesterday I picked up 6 new entities."]}',
          backendId: 'test', modelId: 'test-model',
        };
      },
    });

    const result = await service.getDigest(ownerId);
    assert.equal(result.source, 'generated');
    assert.match(result.paragraphs[0] ?? '', /6 new entities/);
    assert.equal(store.read(ownerId)?.paragraphs[0], result.paragraphs[0]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js assistant-digest-service`
Expected: FAIL — cannot find module `digest-service.js`.

- [ ] **Step 3: Implement**

First add the role. In `src/assistant/inference/roles.ts`, append `'memory_digest'` to `ASSISTANT_INFERENCE_ROLES` and add `memory_digest: '1',` to `ROLE_PROMPT_VERSION` (the `satisfies Record<AssistantInferenceRole, string>` will fail the build if you forget the second half).

Then create the service:

```ts
import { z } from '../../lib/zod.js';
import { parseJsonText } from '../../lib/json.js';
import type { AssistantGraph } from '../assistant-graph.js';
import type { AssistantInferenceClient } from '../inference/client.js';
import { buildRoleSystemPrompt } from '../inference/roles.js';
import { CachedDigestSchema, DigestStore, shouldRegenerate } from './digest-store.js';

const DigestResponseSchema = z.object({
  paragraphs: z.array(z.string().min(1)).min(1).max(4),
}).strict();

const DIGEST_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['paragraphs'],
  properties: {
    paragraphs: {
      type: 'array', minItems: 1, maxItems: 4, items: { type: 'string' },
    },
  },
} as const;

const SYSTEM_PROMPT = buildRoleSystemPrompt('memory_digest', [
  'You summarise what a personal memory system learned about its owner since the last summary.',
  'Write 2-3 short paragraphs, second person, plain and specific.',
  'Lead with the volume of new entities and beliefs, then the dominant theme.',
  'If the owner\'s identity is split across several entities, say so plainly and last.',
  'Never invent facts that are not in the supplied lists.',
].join(' '));

const CountRowSchema = z.object({ count: z.number().int().min(0) }).strict();
const NameRowSchema = z.object({ display_name: z.string(), type: z.string() }).strict();

export type DigestResult = {
  readonly source: 'cache' | 'generated';
  readonly generatedAtUtc: string;
  readonly newEntityCount: number;
  readonly newBeliefCount: number;
  readonly paragraphs: readonly string[];
};

export class DigestService {
  constructor(
    private readonly graph: AssistantGraph,
    private readonly store: DigestStore,
    private readonly inference: AssistantInferenceClient,
  ) {}

  async getDigest(ownerId: string, force = false): Promise<DigestResult> {
    const cached = this.store.read(ownerId);
    const since = cached?.generatedAtUtc ?? '1970-01-01T00:00:00.000Z';
    const newEntityCount = this.countSince('graph_nodes', ownerId, since);
    const newBeliefCount = this.countSince('graph_assertions', ownerId, since);

    if (!force && cached !== null && !shouldRegenerate(cached, newEntityCount, newBeliefCount)) {
      return { ...cached, source: 'cache' };
    }

    const response = await this.inference.complete({
      kind: 'text',
      role: 'memory_digest',
      systemPrompt: SYSTEM_PROMPT,
      userText: this.buildPrompt(ownerId, since, newEntityCount, newBeliefCount),
      responseSchemaName: 'memory_digest',
      responseJsonSchema: DIGEST_JSON_SCHEMA,
      abortSignal: null,
    });

    const parsed = DigestResponseSchema.parse(parseJsonText(response.text));
    const digest = CachedDigestSchema.parse({
      generatedAtUtc: this.graph.nowUtc(),
      graphVersion: cached?.graphVersion ?? 0,
      newEntityCount,
      newBeliefCount,
      paragraphs: parsed.paragraphs,
    });
    this.store.write(ownerId, digest);
    return { ...digest, source: 'generated' };
  }

  /** Bounded input: only what changed, never the whole graph. */
  private buildPrompt(
    ownerId: string, since: string, entities: number, beliefs: number,
  ): string {
    const names = this.graph.database.prepare(`
      SELECT display_name, type FROM graph_nodes
       WHERE owner_id = ? AND status = 'active' AND created_at_utc > ?
       ORDER BY created_at_utc DESC LIMIT 40
    `).all(ownerId, since).map((row) => NameRowSchema.parse(row));

    return [
      `New entities since ${since}: ${entities}.`,
      `New beliefs since ${since}: ${beliefs}.`,
      'New entity names, newest first:',
      ...names.map((row) => `- ${row.display_name} (${row.type})`),
    ].join('\n');
  }

  private countSince(table: 'graph_nodes' | 'graph_assertions', ownerId: string, since: string) {
    const row = this.graph.database.prepare(
      `SELECT count(*) AS count FROM ${table}
        WHERE owner_id = ? AND status = 'active' AND created_at_utc > ?`,
    ).get(ownerId, since);
    return CountRowSchema.parse(row).count;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js assistant-digest-service`
Expected: PASS — both tests, and the cache test must show zero model calls.

- [ ] **Step 5: Commit**

```bash
git add src/assistant/digest/digest-service.ts tests/assistant-digest-service.test.ts
git commit -m "feat(assistant): generate the memory digest with cache reuse"
```

---

### Task 14: Digest endpoint and panel

**Files:**
- Modify: `src/status-server/routes/assistant/overview-routes.ts`
- Modify: `src/status-server/routes/assistant.ts`
- Modify: `src/assistant/assistant-service.ts`
- Create: `dashboard/src/components/memory/DigestPanel.tsx`
- Test: `dashboard/tests/memory-digest-panel.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { DigestPanel } from '../src/components/memory/DigestPanel.js';

test('DigestPanel shows a skeleton while loading', () => {
  const html = renderToStaticMarkup(
    <DigestPanel state={{ kind: 'loading' }} onRegenerate={() => {}} onMerge={() => {}} />,
  );
  assert.match(html, /memory-digest-skeleton/);
});

test('DigestPanel labels a freshly generated digest', () => {
  const html = renderToStaticMarkup(
    <DigestPanel
      state={{
        kind: 'ready', source: 'generated',
        generatedAtUtc: '2026-09-10T12:40:00.000Z',
        paragraphs: ['Since yesterday I picked up 24 new entities.'],
      }}
      onRegenerate={() => {}} onMerge={() => {}}
    />,
  );
  assert.match(html, /generated just now/);
  assert.match(html, /24 new entities/);
});

test('DigestPanel labels a reused digest', () => {
  const html = renderToStaticMarkup(
    <DigestPanel
      state={{
        kind: 'ready', source: 'cache',
        generatedAtUtc: '2026-09-09T18:04:00.000Z',
        paragraphs: ['Nothing new worth summarising.'],
      }}
      onRegenerate={() => {}} onMerge={() => {}}
    />,
  );
  assert.match(html, /reused from cache/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js --dashboard`
Expected: FAIL — cannot find `DigestPanel`.

- [ ] **Step 3: Implement**

Backend — add to `overview-routes.ts` and register `GET /assistant/digest` and `POST /assistant/digest/regenerate`:

```ts
export const digestEndpoint = assistantRoute(async ({ service, res }) => {
  sendJson(res, 200, await service.digest.getDigest(service.ownerId));
});

export const digestRegenerateEndpoint = assistantRoute(async ({ service, res }) => {
  sendJson(res, 200, await service.digest.getDigest(service.ownerId, true));
});
```

Compose in `assistant-service.ts`:

```ts
readonly digest = new DigestService(
  this.graph,
  new DigestStore(this.graph.database, this.graph.clock),
  this.inference,
);
```

Frontend:

```tsx
import React from 'react';

export type DigestState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | {
    kind: 'ready';
    source: 'cache' | 'generated';
    generatedAtUtc: string;
    paragraphs: readonly string[];
  };

export type DigestPanelProps = {
  state: DigestState;
  onRegenerate(): void;
  onMerge(): void;
};

export function DigestPanel(props: DigestPanelProps) {
  return (
    <section className="memory-digest">
      <div className="memory-digest-top">
        <div className="memory-digest-orb">S</div>
        <div className="memory-digest-hi">{greeting()}, Denys.</div>
        <span className="memory-digest-src">{sourceLabel(props.state)}</span>
      </div>
      <div className="memory-digest-body">{renderBody(props.state)}</div>
      <div className="memory-digest-actions">
        <button type="button" className="save" onClick={props.onMerge}>Merge my identities</button>
        <button type="button" onClick={props.onRegenerate}>Regenerate</button>
      </div>
    </section>
  );
}

function renderBody(state: DigestState) {
  if (state.kind === 'loading') {
    return (
      <>
        <div className="memory-digest-skeleton" style={{ width: '94%' }} />
        <div className="memory-digest-skeleton" style={{ width: '88%' }} />
        <div className="memory-digest-skeleton" style={{ width: '62%' }} />
      </>
    );
  }
  if (state.kind === 'error') return <p className="hint">{state.message}</p>;
  return <>{state.paragraphs.map((text) => <p key={text}>{text}</p>)}</>;
}

function sourceLabel(state: DigestState): string {
  if (state.kind === 'loading') return 'checking for new memories…';
  if (state.kind === 'error') return 'unavailable';
  return state.source === 'generated' ? 'generated just now' : 'reused from cache';
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  return hour < 18 ? 'Good afternoon' : 'Good evening';
}
```

Port `.memory-digest*` CSS from the `digestCss` block in `docs/mockups/memory/build.mjs` (lines ~262–300), renaming `.digest` → `.memory-digest`, `.dg-top` → `.memory-digest-top`, `.dg-orb` → `.memory-digest-orb`, `.dg-hi` → `.memory-digest-hi`, `.dg-src` → `.memory-digest-src`, `.dg-body` → `.memory-digest-body`, `.dg-skel` → `.memory-digest-skeleton`, `.dg-acts` → `.memory-digest-actions`.

Wire it in: pass `<DigestPanel …/>` as `digestSlot` from `AssistantTab`'s `renderOverview`, loading it in `useAssistantController` with the same token-effect pattern as Task 8.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js --dashboard`
Expected: PASS — all three states.

- [ ] **Step 5: Commit**

```bash
git add src/status-server/routes/assistant/overview-routes.ts src/status-server/routes/assistant.ts src/assistant/assistant-service.ts dashboard/src/components/memory/DigestPanel.tsx dashboard/src/styles/memory.css dashboard/tests/memory-digest-panel.test.tsx
git commit -m "feat: add the memory landing digest"
```

---

# Phase 5 — Memory assistant chatbox

**Milestone:** A collapsible dock that can correct, merge, and clean up memories through a fixed tool set, always previewing destructive work first.

### Task 15: Memory tool registry

**Files:**
- Create: `src/assistant/chat/memory-tools.ts`
- Test: `tests/assistant-memory-tools.test.ts` (create)

The registry is the security boundary: the chatbox may call **only** these tools, and every destructive tool returns a preview requiring a second call to apply.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { MEMORY_TOOLS, isDestructive } from '../src/assistant/chat/memory-tools.js';

test('the memory tool registry is closed and marks destructive tools', () => {
  const names = MEMORY_TOOLS.map((tool) => tool.name);
  assert.ok(names.includes('search_memory'));
  assert.ok(names.includes('merge_entities'));
  assert.ok(names.includes('forget_topic'));
  // Nothing outside memory may leak in.
  assert.ok(!names.some((name) => /repo|shell|file|web/u.test(name)));
  assert.equal(isDestructive('forget_topic'), true);
  assert.equal(isDestructive('merge_entities'), true);
  assert.equal(isDestructive('search_memory'), false);
});

test('every tool declares a JSON schema for its arguments', () => {
  for (const tool of MEMORY_TOOLS) {
    assert.equal(tool.parameters.type, 'object');
    assert.equal(typeof tool.description, 'string');
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js assistant-memory-tools`
Expected: FAIL — cannot find module `memory-tools.js`.

- [ ] **Step 3: Implement**

```ts
export interface MemoryTool {
  readonly name: string;
  readonly description: string;
  readonly destructive: boolean;
  readonly parameters: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, { type: string; description: string }>>;
    readonly required: readonly string[];
    readonly additionalProperties: false;
  };
}

const obj = (
  properties: Readonly<Record<string, { type: string; description: string }>>,
  required: readonly string[],
) => ({ type: 'object', properties, required, additionalProperties: false } as const);

/** The complete, closed tool surface for the memory chatbox. Nothing else is reachable. */
export const MEMORY_TOOLS: readonly MemoryTool[] = [
  {
    name: 'search_memory',
    description: 'Search entities, beliefs and documents by text.',
    destructive: false,
    parameters: obj({ query: { type: 'string', description: 'Search text.' } }, ['query']),
  },
  {
    name: 'explain_belief',
    description: 'Explain why a belief is held, with its evidence.',
    destructive: false,
    parameters: obj({ assertionId: { type: 'string', description: 'Belief id.' } }, ['assertionId']),
  },
  {
    name: 'list_duplicates',
    description: 'List candidate duplicate entity pairs.',
    destructive: false,
    parameters: obj({}, []),
  },
  {
    name: 'pin_belief',
    description: 'Pin a belief so it stops decaying.',
    destructive: false,
    parameters: obj({
      assertionId: { type: 'string', description: 'Belief id.' },
      reason: { type: 'string', description: 'Why.' },
    }, ['assertionId', 'reason']),
  },
  {
    name: 'demote_belief',
    description: 'Retire a belief that is wrong or stale.',
    destructive: true,
    parameters: obj({
      assertionId: { type: 'string', description: 'Belief id.' },
      reason: { type: 'string', description: 'Why.' },
    }, ['assertionId', 'reason']),
  },
  {
    name: 'merge_entities',
    description: 'Merge a duplicate entity into the entity that should survive.',
    destructive: true,
    parameters: obj({
      sourceNodeId: { type: 'string', description: 'Entity to absorb.' },
      targetNodeId: { type: 'string', description: 'Entity that survives.' },
      reason: { type: 'string', description: 'Why.' },
    }, ['sourceNodeId', 'targetNodeId', 'reason']),
  },
  {
    name: 'forget_topic',
    description: 'Permanently forget a topic and its evidence. Irreversible.',
    destructive: true,
    parameters: obj({
      topicKey: { type: 'string', description: 'Topic key.' },
    }, ['topicKey']),
  },
] as const;

export function isDestructive(name: string): boolean {
  return MEMORY_TOOLS.find((tool) => tool.name === name)?.destructive ?? false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js assistant-memory-tools`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/assistant/chat/memory-tools.ts tests/assistant-memory-tools.test.ts
git commit -m "feat(assistant): define the closed memory tool registry"
```

---

### Task 16: Chat dock UI

**Files:**
- Create: `dashboard/src/components/memory/MemoryChatDock.tsx`
- Test: `dashboard/tests/memory-chat-dock.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MemoryChatDock } from '../src/components/memory/MemoryChatDock.js';

test('MemoryChatDock renders collapsed by default', () => {
  const html = renderToStaticMarkup(
    <MemoryChatDock open={false} messages={[]} pendingAction={null}
      onOpenChange={() => {}} onSend={() => {}} onApply={() => {}} onDiscard={() => {}} />,
  );
  assert.match(html, /Memory assistant/);
  assert.doesNotMatch(html, /memory-dock-log/);
});

test('MemoryChatDock renders a pending destructive action with apply and discard', () => {
  const html = renderToStaticMarkup(
    <MemoryChatDock
      open
      messages={[{ id: 'm1', role: 'assistant', text: 'Found 4 duplicate pairs.' }]}
      pendingAction={{
        id: 'act-1', tool: 'merge_entities', destructive: true,
        summary: 'Merge 4 duplicate pairs', details: ['SiftKit → SiftKit'],
      }}
      onOpenChange={() => {}} onSend={() => {}} onApply={() => {}} onDiscard={() => {}}
    />,
  );
  assert.match(html, /Found 4 duplicate pairs/);
  assert.match(html, /Apply/);
  assert.match(html, /Discard/);
  assert.match(html, /memory-dock-destructive/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js --dashboard`
Expected: FAIL — cannot find `MemoryChatDock`.

- [ ] **Step 3: Implement**

```tsx
import React from 'react';

export type MemoryChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
};

export type MemoryPendingAction = {
  id: string;
  tool: string;
  destructive: boolean;
  summary: string;
  details: readonly string[];
};

export type MemoryChatDockProps = {
  open: boolean;
  messages: readonly MemoryChatMessage[];
  pendingAction: MemoryPendingAction | null;
  onOpenChange(open: boolean): void;
  onSend(text: string): void;
  onApply(actionId: string): void;
  onDiscard(actionId: string): void;
};

export function MemoryChatDock(props: MemoryChatDockProps) {
  const [draft, setDraft] = React.useState('');
  // Bound once so the null-checked branch below needs no non-null assertion.
  const pending = props.pendingAction;
  if (!props.open) {
    return (
      <div className="memory-dock">
        <button type="button" className="memory-dock-fab"
          onClick={() => props.onOpenChange(true)}>
          Memory assistant
        </button>
      </div>
    );
  }
  return (
    <div className="memory-dock open">
      <div className="memory-dock-panel">
        <header className="memory-dock-head">
          <b>Memory assistant</b>
          <span className="memory-dock-scope">memory tools only</span>
          <button type="button" onClick={() => props.onOpenChange(false)}>×</button>
        </header>
        <div className="memory-dock-log">
          {props.messages.map((message) => (
            <div className={`memory-dock-msg ${message.role}`} key={message.id}>
              {message.text}
            </div>
          ))}
          {pending === null ? null : (
            <div className={`memory-dock-card${
              pending.destructive ? ' memory-dock-destructive' : ''
            }`}>
              <div className="memory-dock-card-head">{pending.summary}</div>
              <div className="memory-dock-card-body">
                {pending.details.map((line) => <div key={line}>{line}</div>)}
              </div>
              <div className="memory-dock-card-foot">
                <button type="button" className="save"
                  onClick={() => props.onApply(pending.id)}>Apply</button>
                <button type="button"
                  onClick={() => props.onDiscard(pending.id)}>Discard</button>
              </div>
            </div>
          )}
        </div>
        <form
          className="memory-dock-input"
          onSubmit={(event) => {
            event.preventDefault();
            props.onSend(draft);
            setDraft('');
          }}
        >
          <input value={draft} onChange={(event) => setDraft(event.target.value)}
            placeholder="Correct or clean up a memory…" />
          <button type="submit">Send</button>
        </form>
      </div>
    </div>
  );
}
```

Port `.memory-dock*` CSS from the `chatCss` block in `docs/mockups/memory/build.mjs` (lines 65–119), renaming `.dock` → `.memory-dock`, `.dock-fab` → `.memory-dock-fab`, `.dock-panel` → `.memory-dock-panel`, `.dock-head` → `.memory-dock-head`, `.dock-log` → `.memory-dock-log`, `.msg` → `.memory-dock-msg`, `.card` → `.memory-dock-card`, `.dock-in` → `.memory-dock-input`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js --dashboard`
Expected: PASS — both tests.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/components/memory/MemoryChatDock.tsx dashboard/src/styles/memory.css dashboard/tests/memory-chat-dock.test.tsx
git commit -m "feat(dashboard): add the memory assistant chat dock"
```

---

# Phase 6 — Fold the Settings surfaces into A/B

**Milestone:** `Settings → Assistant` shows configuration only. Review and history live in the memory pages.

Today `dashboard/src/tabs/settings/AssistantSettings.tsx:334` holds a 3-way switcher — `'configuration' | 'validation' | 'history'`. The two non-configuration views move:

| Settings view | New home | Why |
|---|---|---|
| Pending validation → **identity holds** | Overview, "Needs your review" | 37 candidates are held on "is *deny* you?" — the same identity fragmentation the digest leads with. Triage belongs on the landing page. |
| Pending validation → **ordinary candidates** | Explorer, `Review` mode | 1,293 items is a working queue, not a dashboard widget. |
| Pending validation → **pending captures** | Overview, Pipeline health | It is pipeline state, not a decision. |
| Memory history | Explorer, `History` mode | Provenance sits next to the beliefs it explains. |

Live shape at time of writing: **1,333** awaiting review (1,293 unheld, **37 `possible_owner_alias`**, 3 `topic`); alias names are OCR misreads of "denys" — `deny` ×13, `demyz` ×8, `denvys` ×6, `deryn` ×5, `demyxs` ×5. History holds **7,340** rows: `update_assertion` 4,188, `create_assertion` 1,745, `create_node` 1,207, `supersede_assertion` 193, `merge_node` 7 — by actor, `system` 3,872, `assistant_proposal` 3,461, **`user` 7**.

Reference mockups: `docs/mockups/memory/variant-a-dashboard.html` (the "Needs your review" panel and the capture strip) and `variant-b-explorer.html` (the Entities/Review/History mode switcher).

**All endpoints already exist.** `/assistant/validation`, `/assistant/validation/:id/notes`, `/assistant/validation/:id/resolve-identity`, `DELETE /assistant/validation/:id`, `/assistant/history`, `/assistant/captures/pending` are registered at `src/status-server/routes/assistant.ts:168-216`. This phase is **frontend-only** — do not add routes.

---

### Task 17: Review queue component

**Files:**
- Create: `dashboard/src/components/memory/ReviewQueue.tsx`
- Test: `dashboard/tests/memory-review-queue.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ReviewQueue } from '../src/components/memory/ReviewQueue.js';
import type { AssistantValidationCandidateDto } from '@siftkit/contracts';

const PLAIN: AssistantValidationCandidateDto = {
  id: 'cand-1', status: 'pending',
  proposedStatement: 'the user USES Visual Studio Code',
  rationale: 'The screenshot displays the user interface of Visual Studio Code.',
  confidence: 1, sensitivity: 'personal', evidenceId: 'ev-1', userNotes: '',
  createdAtUtc: '2026-09-03T15:47:17.215Z', hold: null,
};
const HELD: AssistantValidationCandidateDto = {
  ...PLAIN, id: 'cand-2', status: 'needs_confirmation',
  hold: { kind: 'possible_owner_alias', name: 'deny' },
};

test('ReviewQueue renders an identity hold as a question with both answers', () => {
  const html = renderToStaticMarkup(
    <ReviewQueue items={[HELD]} onResolveIdentity={() => {}} onSaveNotes={() => {}}
      onRemove={() => {}} />,
  );
  assert.match(html, /another name for you/);
  assert.match(html, /deny/);
  assert.match(html, /Yes, that is me/);
  assert.match(html, /No, someone else/);
  assert.match(html, /memory-review-hold/);
  // A held candidate must not offer the free-text notes path.
  assert.doesNotMatch(html, /textarea/);
});

test('ReviewQueue renders an ordinary candidate with notes and remove', () => {
  const html = renderToStaticMarkup(
    <ReviewQueue items={[PLAIN]} onResolveIdentity={() => {}} onSaveNotes={() => {}}
      onRemove={() => {}} />,
  );
  assert.match(html, /Visual Studio Code/);
  assert.match(html, /textarea/);
  assert.match(html, /Remove/);
  assert.doesNotMatch(html, /memory-review-hold/);
});

test('ReviewQueue reports an empty queue', () => {
  const html = renderToStaticMarkup(
    <ReviewQueue items={[]} onResolveIdentity={() => {}} onSaveNotes={() => {}}
      onRemove={() => {}} />,
  );
  assert.match(html, /Nothing is waiting for review/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js --dashboard`
Expected: FAIL — cannot find `ReviewQueue`.

- [ ] **Step 3: Implement**

```tsx
import React from 'react';
import type { AssistantValidationCandidateDto } from '@siftkit/contracts';

export type ReviewQueueProps = {
  items: readonly AssistantValidationCandidateDto[];
  onResolveIdentity(id: string, isOwner: boolean): void;
  onSaveNotes(id: string, notes: string): void;
  onRemove(id: string): void;
};

export function ReviewQueue(props: ReviewQueueProps) {
  if (props.items.length === 0) {
    return <p className="hint">Nothing is waiting for review.</p>;
  }
  return (
    <div className="memory-review">
      {props.items.map((item) => (
        <ReviewCard
          key={item.id}
          item={item}
          onResolveIdentity={props.onResolveIdentity}
          onSaveNotes={props.onSaveNotes}
          onRemove={props.onRemove}
        />
      ))}
    </div>
  );
}

function ReviewCard(props: {
  item: AssistantValidationCandidateDto;
  onResolveIdentity(id: string, isOwner: boolean): void;
  onSaveNotes(id: string, notes: string): void;
  onRemove(id: string): void;
}) {
  const { item } = props;
  const [notes, setNotes] = React.useState(item.userNotes);
  const hold = item.hold;
  const isIdentityHold = hold !== null && hold.kind === 'possible_owner_alias';

  return (
    <article className={`memory-review-card${isIdentityHold ? ' memory-review-hold' : ''}`}>
      <div className="memory-review-head">
        <h4>{item.proposedStatement}</h4>
        <span className="tag">{Math.round(item.confidence * 100)}%</span>
        <span className="tag">{item.sensitivity}</span>
      </div>
      <p className="memory-note">{item.rationale}</p>
      {hold !== null && hold.kind === 'possible_owner_alias' ? (
        <div className="memory-review-idbox">
          <p>
            “{hold.name}” is close to one of your own names. Is that you?
            Nothing is written until you answer.
          </p>
          <div className="memory-review-actions">
            <button type="button" className="save"
              onClick={() => props.onResolveIdentity(item.id, true)}>Yes, that is me</button>
            <button type="button"
              onClick={() => props.onResolveIdentity(item.id, false)}>No, someone else</button>
          </div>
        </div>
      ) : (
        <>
          <textarea
            className="memory-review-notes"
            aria-label={`Notes for ${item.proposedStatement}`}
            rows={2}
            value={notes}
            placeholder="Your notes…"
            onChange={(event) => setNotes(event.target.value)}
          />
          <div className="memory-review-actions">
            <button type="button" onClick={() => props.onSaveNotes(item.id, notes)}>
              Save notes
            </button>
            <button type="button" className="danger" onClick={() => props.onRemove(item.id)}>
              Remove
            </button>
          </div>
        </>
      )}
    </article>
  );
}
```

Port `.memory-review*` CSS from `docs/mockups/memory/variant-b.mjs` — the `.card2`, `.hold`, `.idbox`, `.notes` rules — renaming `.card2` → `.memory-review-card`, `.hold` → `.memory-review-hold`, `.idbox` → `.memory-review-idbox`, `.notes` → `.memory-review-notes`, `.c2acts` → `.memory-review-actions`, `.c2h` → `.memory-review-head`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js --dashboard`
Expected: PASS — all three tests.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/components/memory/ReviewQueue.tsx dashboard/src/styles/memory.css dashboard/tests/memory-review-queue.test.tsx
git commit -m "feat(dashboard): add the memory review queue component"
```

---

### Task 18: Memory history component

**Files:**
- Create: `dashboard/src/components/memory/MemoryHistoryList.tsx`
- Test: `dashboard/tests/memory-history-list.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MemoryHistoryList } from '../src/components/memory/MemoryHistoryList.js';
import type { AssistantMemoryHistoryEntryDto } from '@siftkit/contracts';

const ENTRY: AssistantMemoryHistoryEntryDto = {
  id: 'mut-1', operation: 'create_assertion',
  targetType: 'graph_assertions', targetId: 'ast-1',
  summary: 'the user USES CUDA', reason: 'promoted from candidate',
  proofs: [{ evidenceId: 'ev-1', sourceType: 'screen_capture', sourceRef: 'vscode' }],
  createdAtUtc: '2026-09-10T12:33:08.918Z',
};

test('MemoryHistoryList renders the operation, summary and proofs', () => {
  const html = renderToStaticMarkup(<MemoryHistoryList entries={[ENTRY]} />);
  assert.match(html, /create assertion/);
  assert.match(html, /the user USES CUDA/);
  assert.match(html, /promoted from candidate/);
  assert.match(html, /ev-1/);
  assert.match(html, /screen_capture/);
});

test('MemoryHistoryList reports an empty log', () => {
  const html = renderToStaticMarkup(<MemoryHistoryList entries={[]} />);
  assert.match(html, /No memory changes have been recorded/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js --dashboard`
Expected: FAIL — cannot find `MemoryHistoryList`.

- [ ] **Step 3: Implement**

```tsx
import React from 'react';
import type { AssistantMemoryHistoryEntryDto } from '@siftkit/contracts';

export type MemoryHistoryListProps = {
  entries: readonly AssistantMemoryHistoryEntryDto[];
};

export function MemoryHistoryList(props: MemoryHistoryListProps) {
  if (props.entries.length === 0) {
    return <p className="hint">No memory changes have been recorded.</p>;
  }
  return (
    <div className="memory-history">
      {props.entries.map((entry) => (
        <div className="memory-history-row" key={entry.id}>
          <div className="memory-history-when">
            {entry.createdAtUtc.slice(5, 16).replace('T', ' ')}
          </div>
          <div className="memory-history-what">
            <span className={`memory-history-op ${entry.operation}`}>
              {entry.operation.replace(/_/gu, ' ')}
            </span>
            <b>{entry.summary}</b>
            {entry.reason === '' ? null : <div className="memory-note">{entry.reason}</div>}
            {entry.proofs.map((proof) => (
              <div className="memory-history-proof" key={proof.evidenceId}>
                Proof {proof.evidenceId} · {proof.sourceType}
                {proof.sourceRef === null ? '' : ` · ${proof.sourceRef}`}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
```

Port `.hist`, `.hist .when`, `.hist .what`, `.hist .proof`, `.op` CSS from `docs/mockups/memory/variant-b.mjs` as `.memory-history-row`, `.memory-history-when`, `.memory-history-what`, `.memory-history-proof`, `.memory-history-op`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js --dashboard`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/components/memory/MemoryHistoryList.tsx dashboard/src/styles/memory.css dashboard/tests/memory-history-list.test.tsx
git commit -m "feat(dashboard): add the memory history list component"
```

---

### Task 19: Mount review and history in the memory pages

**Files:**
- Modify: `dashboard/src/tabs/memory/MemoryExplorer.tsx` (add the mode switcher)
- Modify: `dashboard/src/tabs/memory/MemoryOverview.tsx` (add the review panel)
- Modify: `dashboard/src/hooks/useAssistantController.ts` (load validation + history)
- Test: `dashboard/tests/memory-explorer-modes.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MemoryExplorer } from '../src/tabs/memory/MemoryExplorer.js';

const BASE = {
  entities: [{
    id: 'n1', displayName: 'the user', type: 'person', degree: 712,
    createdAtUtc: '2026-08-28T00:00:00.000Z',
  }],
  selectedId: 'n1',
  assertions: [],
  duplicateIds: [],
  tiers: [],
  validation: [],
  history: [],
  onSelect() {}, onMerge() {}, onPin() {}, onDemote() {},
  onResolveIdentity() {}, onSaveNotes() {}, onRemoveCandidate() {},
} as const;

test('MemoryExplorer shows the entities mode by default', () => {
  const html = renderToStaticMarkup(<MemoryExplorer {...BASE} mode="entities" onModeChange={() => {}} />);
  assert.match(html, /the user/);
  assert.doesNotMatch(html, /No memory changes have been recorded/);
});

test('MemoryExplorer shows the review queue in review mode', () => {
  const html = renderToStaticMarkup(<MemoryExplorer {...BASE} mode="review" onModeChange={() => {}} />);
  assert.match(html, /Nothing is waiting for review/);
});

test('MemoryExplorer shows the history log in history mode', () => {
  const html = renderToStaticMarkup(<MemoryExplorer {...BASE} mode="history" onModeChange={() => {}} />);
  assert.match(html, /No memory changes have been recorded/);
});

test('MemoryExplorer badges the pending review count on the mode button', () => {
  const html = renderToStaticMarkup(
    <MemoryExplorer
      {...BASE}
      mode="entities"
      onModeChange={() => {}}
      validation={[{
        id: 'c1', status: 'pending', proposedStatement: 'x', rationale: 'y',
        confidence: 0.5, sensitivity: 'personal', evidenceId: null, userNotes: '',
        createdAtUtc: '2026-09-10T00:00:00.000Z', hold: null,
      }]}
    />,
  );
  assert.match(html, /memory-mode-badge/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js --dashboard`
Expected: FAIL — `mode` is not a known prop.

- [ ] **Step 3: Implement**

Extend `MemoryExplorerProps` with the new fields, and wrap the existing centre column in a mode switch:

```tsx
export type MemoryExplorerMode = 'entities' | 'review' | 'history';

// added to MemoryExplorerProps:
  mode: MemoryExplorerMode;
  validation: readonly AssistantValidationCandidateDto[];
  history: readonly AssistantMemoryHistoryEntryDto[];
  onModeChange(mode: MemoryExplorerMode): void;
  onResolveIdentity(id: string, isOwner: boolean): void;
  onSaveNotes(id: string, notes: string): void;
  onRemoveCandidate(id: string): void;
```

Inside `<main className="memory-list">`, put the switcher above the current entity list:

```tsx
<div className="memory-modes">
  {(['entities', 'review', 'history'] as const).map((mode) => (
    <button
      type="button"
      key={mode}
      className={props.mode === mode ? 'on' : ''}
      onClick={() => props.onModeChange(mode)}
    >
      {mode === 'entities' ? 'Entities' : mode === 'review' ? 'Review' : 'History'}
      {mode === 'review' && props.validation.length > 0
        ? <span className="memory-mode-badge">{props.validation.length}</span>
        : null}
    </button>
  ))}
</div>
{props.mode === 'entities' ? renderEntities(props) : null}
{props.mode === 'review' ? (
  <ReviewQueue
    items={props.validation}
    onResolveIdentity={props.onResolveIdentity}
    onSaveNotes={props.onSaveNotes}
    onRemove={props.onRemoveCandidate}
  />
) : null}
{props.mode === 'history' ? <MemoryHistoryList entries={props.history} /> : null}
```

Move the existing entity-list JSX into `function renderEntities(props: MemoryExplorerProps)` unchanged.

In `MemoryOverview`, extend `MemoryOverviewProps` with three fields:

```tsx
  validation: readonly AssistantValidationCandidateDto[];
  onResolveIdentity(id: string, isOwner: boolean): void;
  onOpenReview(): void;
```

Then add a "Needs your review" panel above the composition grid, showing only the identity holds plus a count and a link into Explorer's review mode:

```tsx
const identityHolds = props.validation.filter(
  (item) => item.hold !== null && item.hold.kind === 'possible_owner_alias',
);
```

Render the alias names from `item.hold.name`, a single `Yes, all me` / `Decide one by one` / `None of them` action row calling `props.onResolveIdentity`, and `Open the full review queue →` calling `props.onOpenReview()`.

In `useAssistantController`, load both lists with the same token effect used in Task 8, calling the existing `/assistant/validation` and `/assistant/history` clients, and expose `validation`, `history`, `mode`, `onModeChange`, `onResolveIdentity`, `onSaveNotes`, `onRemoveCandidate`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js --dashboard`
Expected: PASS — all four tests.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/tabs/memory/ dashboard/src/hooks/useAssistantController.ts dashboard/tests/memory-explorer-modes.test.tsx
git commit -m "feat(dashboard): mount review and history inside the memory pages"
```

---

### Task 20: Strip the Settings switcher

**Files:**
- Modify: `dashboard/src/tabs/settings/AssistantSettings.tsx:334,454-456,460-591`
- Modify: `dashboard/tests/assistant-settings.test.tsx`
- Test: `dashboard/tests/assistant-settings-configuration-only.test.tsx` (create)

This is a **deletion** task. Per the repo's refactor rule, remove the moved code rather than leaving a parallel path — no compatibility shim, no hidden tab.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AssistantSettings } from '../src/tabs/settings/AssistantSettings.js';
import { SETTINGS_PROPS } from './helpers/assistant-settings-props.js';

test('Assistant settings no longer offers validation or history views', () => {
  const html = renderToStaticMarkup(<AssistantSettings {...SETTINGS_PROPS} />);
  assert.doesNotMatch(html, /Pending validation/);
  assert.doesNotMatch(html, /Memory history/);
  assert.doesNotMatch(html, /Pending captures/);
});

test('Assistant settings still renders its configuration content', () => {
  const html = renderToStaticMarkup(<AssistantSettings {...SETTINGS_PROPS} />);
  assert.match(html, /Assistant/);
  // Maintenance and background-decision panels stay in Settings.
  assert.match(html, /Background/i);
});
```

Create `dashboard/tests/helpers/assistant-settings-props.tsx` by lifting the prop object out of the existing `dashboard/tests/assistant-settings.test.tsx`, and import it from both files.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build:test && node .\dist\test-runner\run-tests.js --dashboard`
Expected: FAIL — the markup still contains "Pending validation".

- [ ] **Step 3: Delete the moved views**

In `dashboard/src/tabs/settings/AssistantSettings.tsx`:

1. Delete the `AssistantView` type at line 27 and the `view` state at line 334.
2. Delete the three switcher buttons at lines 454–456 and their wrapper.
3. Delete the `{view === 'validation' ? … : null}` block (lines 467–567) and the `{view === 'history' ? … : null}` block (lines 568–589) in full.
4. Unwrap the `{view === 'configuration' ? …}` guard so `AssistantConfiguration`, `AssistantMaintenance`, and `BackgroundWorkDecisions` render unconditionally.
5. Delete the now-unused state and helpers: `validation`, `history`, `capturePreviews`, `zoomedCapture`, `pendingCaptures`, `zoomedPreview`, `resolveIdentity`, `saveNotes`, `removeCandidate`, and their loader effects.
6. Delete the now-unused imports — `ImageLightbox`, the validation/history API clients, and the `AssistantValidationCandidateDto` / `AssistantMemoryHistoryEntryDto` / `PendingCaptureDto` types.

`npm run lint` will name every leftover binding; let it drive the cleanup rather than guessing.

- [ ] **Step 4: Verify the deletion is complete**

```bash
npm run build:test && node .\dist\test-runner\run-tests.js --dashboard
npm run typecheck && npm run lint
```

Expected: PASS, clean typecheck, and **zero** unused-variable warnings. Then confirm nothing still references the removed views:

```bash
grep -n "validation\|history\|pendingCaptures" dashboard/src/tabs/settings/AssistantSettings.tsx
```

Expected: no matches.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/tabs/settings/AssistantSettings.tsx dashboard/tests/
git commit -m "refactor(dashboard): settings assistant keeps configuration only"
```

---

## Final verification

Run before declaring the work complete. Do not claim success without pasting real output.

- [ ] **Full suite**

```bash
npm run build:test
node .\dist\test-runner\run-tests.js
node .\dist\test-runner\run-tests.js --dashboard
```

- [ ] **Types and lint**

```bash
npm run typecheck
npm run lint
```

- [ ] **Live smoke test**

With the status server running, confirm each new route answers with a bearer token:

```bash
TOK=$(curl -s http://127.0.0.1:6876/assistant/auth/bootstrap | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).token))")
for p in overview graph/duplicates graph/entities digest; do
  echo "== $p =="; curl -s -H "Authorization: Bearer $TOK" "http://127.0.0.1:6876/assistant/$p" | head -c 200; echo
done
```

Expected: four JSON payloads, no `unauthorized`.

- [ ] **Manual check**

Open the dashboard Assistant tab. Confirm: Overview loads with capacity gauges; the digest appears and its badge reads either `generated just now` or `reused from cache`; the Explorer tab lists entities by degree; the chat dock opens and closes.

Then confirm the Phase 6 fold end-to-end:

- Overview shows "Needs your review" with the identity questions, and answering one removes it from the list.
- Explorer's mode switcher moves between Entities, Review and History, and the Review button carries a count badge.
- `Settings → Assistant` shows **only** configuration — no Pending validation tab, no Memory history tab.
- Answering an identity question in Overview and reloading shows the count drop in both places, proving they read the same endpoint rather than diverging copies.

---

## Known gaps, deliberately out of scope

- **Alias-based duplicate detection.** `VS Code` / `Visual Studio Code` will not be detected by `normalizeDisplayName`. Detecting it needs alias or embedding matching. Task 2 is deliberately conservative — a false merge is far worse than a missed one.
- **Model-side streaming for the digest.** `AssistantInferenceClient` is non-streaming by design (JSON-schema-pinned, 2,048 token cap). The mockup's word-by-word reveal is a client-side animation over a fully-generated payload. Real token streaming would require a separate streaming path through `InferenceClient`.
- **Chat agent loop.** Task 15 defines the tool registry and Task 16 the UI, but the loop that turns a user sentence into tool calls is not planned here. It needs its own plan: it touches model prompting, tool dispatch, and the preview-token lifecycle, and it is the one piece with real prompt-injection surface. Until it exists, wire the dock's `onSend` to the deterministic intents the mockup demonstrates.
- **Bulk review.** Phase 6 moves the queue but does not make 1,293 unheld candidates tractable. There is no select-all, no filter by predicate or sensitivity, and no "accept everything from this source". The Overview panel handles the 37 identity holds because those are the ones that actually block; the long tail needs its own design pass.
- **Per-entity history.** Explorer's History mode is global. Filtering it to the selected entity needs a `targetId` query parameter that `/assistant/history` does not currently accept.
- **Capture previews.** The Overview capture strip is a placeholder grid, not decrypted thumbnails. Real previews need the `fetchAssistantEvidencePixels` + object-URL lifecycle that the old Settings view had, including the lightbox. Port it only if you want pixels on the landing page.
- **The two issues in [handoff-2026-09-10](../../handoff-2026-09-10-image-extraction-deadletters-and-promotion-lag.md)** — `image_extraction` dead letters and the ~1.5 day promotion lag — are untouched. The Overview will *display* the dead-letter count via `overview.jobs`, which makes the problem visible but does not fix it.

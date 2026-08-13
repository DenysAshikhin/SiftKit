# SiftKit Assistant — Gate E (Hardening) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close out the assistant: projection lifecycle (archive merge + orphan sweep), the three missing §16.1 deletion modes, export / backup / restore, the mobile envelope contract (verify-only, route stays 404), and a seeded §19.5 performance measurement.

**Architecture:** `ProjectionCompiler.compileAll` becomes a reconciler that owns the desired state of `memory_projections` (archive merge is deterministic; orphans are swept every compile). Deletion modes extend the existing `DeletionPreviewService` HMAC preview-token pattern. Export/backup/restore are new `src/assistant/control/` services over a new dependency-free zip module; backup carries the evidence key only in DPAPI-protected form (via PowerShell `ProtectedData` — no new dependency). Mobile is a verifier + nonce table behind `Assistant.Mobile.Enabled` (default false). Everything is surfaced on HTTP + CLI + dashboard.

**Tech Stack:** TypeScript (NodeNext ESM), `better-sqlite3` (SQLite backup API, ATTACH), `zod` 4 via `src/lib/zod.js`, `node:crypto` (Ed25519, HMAC, CRC via hand-rolled table), `node:zlib` (deflateRaw), `node:test` via `npm test`, React dashboard.

**Source spec:** `docs/superpowers/specs/2026-08-13-assistant-gate-e-hardening-design.md`. Master design: `assistant/2026-07-30-siftkit-assistant-design.md` §10.3, §15, §16, §7.6, §18, §19.4, §19.5.

**Predecessor:** Gate D complete and green. `CURRENT_SCHEMA_VERSION = 43` ([runtime-db.ts:48](../../src/state/runtime-db.ts)).

---

## Locked decisions (do not re-litigate)

| Question | Decision |
|---|---|
| Tier count limits | Keep the `TIER_DOCUMENT_LIMIT` constants (`assertion-view.ts:46`). `Assistant.Memory.Tier{2,3}.MaxDocuments` config keys exist but are not wired into the compiler today; wiring them is out of scope. |
| Archive grouping | `archive/<first segment>` where the segment is `topicKey.split(/[-/]/)[0]`. Topic keys are hyphen slugs (`toTopicKey`, `assertion-view-builder.ts:9`); minted archive keys contain `/`, so `topicKey` travels in request bodies, never URL paths. |
| DPAPI from Node | PowerShell `[Security.Cryptography.ProtectedData]` via the existing `spawnPowerShellAsync` (`src/lib/powershell.ts:70`). No new dependency. |
| Restore custody | Restore always lands in **file** custody (writes the key file, sets `KeyCustody: 'file'`). The shell re-migrates to desktop custody on its next connect. |
| Older backups | Allowed: the snapshot file is migrated to `CURRENT_SCHEMA_VERSION` via a new exported `migrateDatabaseFile` before its rows are copied. Newer backups are refused. |
| Restore upload lifetime | `restore-preview` holds uploads in an in-memory map + temp file, single-process. A daemon restart discards pending restore uploads; the client re-uploads. |
| Mobile ingestion | On the (disabled-by-default) enabled path, an accepted envelope becomes a standard `IngestionPipeline.accept` text envelope with `sourceType: 'mobile_event'`. No special-casing. |
| Registries | `graph_node_types` / `graph_relation_types` are seeded definitions, not user data: factory reset and restore leave them alone. |
| CLI restore confirm | `siftkit assistant restore --input <zip> --preview` then `siftkit assistant restore --confirm <uploadId> <token>` (the confirm references the server-held upload, not the client file). |
| Commits | Each task ends with a commit step. If the session is instructed not to commit, skip those steps and say so in the handoff. |

## File structure

**Created:**

| File | Responsibility |
|---|---|
| `src/lib/zip.ts` | Minimal zip writer/reader (store + deflateRaw, CRC-32, central directory). Shared by export/backup/restore. |
| `src/assistant/projections/archive-planner.ts` | Pure Tier 3 overflow grouping (`planTier3Archives`, `firstSegment`). |
| `src/assistant/crypto/dpapi.ts` | `dpapiProtect` / `dpapiUnprotect` via PowerShell `ProtectedData`. |
| `src/assistant/storage/device-store.ts` | `assistant_devices` reads + `assistant_device_nonces` replay tracking. |
| `src/assistant/mobile/envelope-verifier.ts` | Ed25519 + device + monotonic timestamp + nonce verification. |
| `src/assistant/control/factory-reset-service.ts` | §16.1 factory reset preview + cascade. |
| `src/assistant/control/export-service.ts` | §16.3 zip export. |
| `src/assistant/control/backup-service.ts` | §16.4 backup artifact. |
| `src/assistant/control/restore-service.ts` | Upload/verify/confirm restore. |
| `scripts/assistant-bench/seed.ts`, `scripts/assistant-bench/measure.ts` | §19.5 seeded measurement. |
| `dashboard/src/tabs/settings/AssistantMaintenance.tsx` | Export / backup / restore / factory-reset panel. |
| `tests/helpers/gate-e-seed.ts` | `seedOwnerAssertion` helper reused by reconciler, archive, deletion, E2E, and bench code. |

**Modified:** `src/assistant/storage/schema.ts` (v44 SQL, table-name constants), `src/state/runtime-db.ts` (v44 step, `migrateDatabaseFile`), `packages/contracts/src/config.ts` (+`Mobile`), `packages/contracts/src/assistant.ts` (Gate E DTOs), `src/config/defaults.ts`, `src/config/normalization.ts`, `src/assistant/projections/projection-compiler.ts`, `src/assistant/storage/projection-store.ts` (+`listAllRows`), `src/assistant/storage/assertion-store.ts` (+`unlinkEvidence`), `src/assistant/control/deletion-preview.ts` (payload union), `src/assistant/control/memory-mutation-service.ts` (evidence delete, forget topic), `src/assistant/crypto/key-custody.ts` (+`exportForBackup`, `resetForFactoryReset`, `adoptRestoredKeyMaterial`), `src/assistant/crypto/key-provider.ts` (+`importKeyFile`, tolerant `deleteKeyFile`), `src/assistant/crypto/imported-key-provider.ts` (+`exportMaterial`), `src/assistant/assistant-service.ts` (maintenance wiring + `ingestMobileEnvelope`), `src/status-server/routes/assistant.ts`, `src/cli/assistant-args.ts`, `src/cli/run-assistant.ts`, `src/cli/status-server-api-client.ts`, `dashboard/src/assistant-api.ts`, `dashboard/src/components/AssistantMemoryDetail.tsx`, `dashboard/src/tabs/settings/AssistantSettings.tsx`, `dashboard/src/settings-sections.ts`, `package.json` (bench script).

**Test files:** `tests/assistant-projection-reconciler.test.ts`, `tests/assistant-archive-planner.test.ts`, `tests/assistant-deletion-modes.test.ts`, `tests/assistant-factory-reset.test.ts`, `tests/zip.test.ts`, `tests/assistant-dpapi.test.ts`, `tests/assistant-export.test.ts`, `tests/assistant-backup-restore.test.ts`, `tests/assistant-mobile-envelope.test.ts`, `tests/assistant-gate-e-routes.test.ts`, `tests/assistant-gate-e-cli.test.ts`, `tests/assistant-gate-e-e2e.test.ts`, `dashboard/tests/assistant-maintenance.test.tsx`, plus edits to the existing migration test.

Run any single test file with `npm run build:test && node .\dist\test-runner\run-tests.js <name-fragment>`. Full gate: `npm test`, `npm run typecheck` (includes eslint), `npm run test:dashboard`.

---

### Task 1: Migration v44 (`assistant_device_nonces`) + `Assistant.Mobile` config key

**Files:**
- Modify: `src/assistant/storage/schema.ts` (after `ASSISTANT_DESKTOP_SCHEMA_SQL`)
- Modify: `src/state/runtime-db.ts` (fresh-DB branch ~line 1034, ladder after v43 block ~line 1492, `CURRENT_SCHEMA_VERSION`)
- Modify: `packages/contracts/src/config.ts:211` (after `PrivateMode`), `src/config/defaults.ts` (in `DEFAULT_ASSISTANT_CONFIG`), `src/config/normalization.ts`
- Test: find the existing migration expectations with `npm run build:test && node .\dist\test-runner\run-tests.js migration` and search `tests/` for `CURRENT_SCHEMA_VERSION` / `43`; extend that file rather than creating a new one.

- [ ] **Step 1: Write the failing tests.** In the existing migration test file add: fresh DB reaches version 44; a v43 database migrated forward gains `assistant_device_nonces`; re-running is a no-op. In the existing assistant-config test (search `tests/` for `normalizeAssistantConfig` or `DEFAULT_ASSISTANT_CONFIG`) add: a config without `Mobile` normalizes to `{ Enabled: false }`; `AssistantConfigSchema` accepts `Mobile: { Enabled: true }` and rejects extra keys.

```ts
test('v44 adds the device nonce table', () => {
  // in the migration test's existing per-version harness style:
  const columns = database.prepare("SELECT name FROM pragma_table_info('assistant_device_nonces')").all();
  assert.deepEqual(
    columns.map((row) => z.object({ name: z.string() }).parse(row).name),
    ['device_id', 'nonce', 'monotonic_ts', 'seen_at_utc'],
  );
});
```

- [ ] **Step 2: Run** `npm run build:test && node .\dist\test-runner\run-tests.js migration` → FAIL (table missing, schema version 43).

- [ ] **Step 3: Implement.** In `schema.ts`:

```ts
/** Gate E (v44): mobile envelope replay protection. Contract only — no client exists yet. */
export const ASSISTANT_MOBILE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS assistant_device_nonces (
    device_id TEXT NOT NULL REFERENCES assistant_devices(id) ON DELETE CASCADE,
    nonce TEXT NOT NULL,
    monotonic_ts INTEGER NOT NULL,
    seen_at_utc TEXT NOT NULL,
    PRIMARY KEY (device_id, nonce)
);
CREATE INDEX IF NOT EXISTS assistant_device_nonces_ts_idx
  ON assistant_device_nonces(device_id, monotonic_ts DESC);
`;
```

In `runtime-db.ts`: import `ASSISTANT_MOBILE_SCHEMA_SQL`; set `CURRENT_SCHEMA_VERSION = 44`; add `database.exec(ASSISTANT_MOBILE_SCHEMA_SQL);` to the fresh-DB branch (after `applyAssistantDesktopSchema(database)`); append the ladder step:

```ts
  if (currentVersion < 44) {
    database.exec(ASSISTANT_MOBILE_SCHEMA_SQL);
    setSchemaVersion(database, 44);
    currentVersion = 44;
  }
```

In `packages/contracts/src/config.ts`, inside `AssistantConfigSchema` after `PrivateMode`:

```ts
  /** Gate E: mobile envelope route gate. The route returns 404 while this is false (§7.6). */
  Mobile: z.object({ Enabled: z.boolean() }).strict(),
```

In `defaults.ts` add `Mobile: { Enabled: false },` to `DEFAULT_ASSISTANT_CONFIG` (after `PrivateMode`). In `normalization.ts`, mirroring the `PrivateMode` handling: `const mobile = getRecord(input.Mobile);` and in the returned object `Mobile: { Enabled: booleanOrDefault(mobile.Enabled, DEFAULT_ASSISTANT_CONFIG.Mobile.Enabled) },`.

- [ ] **Step 4: Run** the migration + assistant-config tests → PASS. Run `npm run typecheck` — fix every site the new required config key breaks (test fixtures constructing `AssistantConfig` literals must add `Mobile: { Enabled: false }`).

- [ ] **Step 5: Commit** `feat(assistant): v44 device-nonce table and Mobile config key`.

---

### Task 2: Seeding helper + orphan sweep (finding 2 regression)

**Files:**
- Create: `tests/helpers/gate-e-seed.ts`
- Create: `tests/assistant-projection-reconciler.test.ts`
- Modify: `src/assistant/storage/projection-store.ts` (+`listAllRows`), `src/assistant/projections/projection-compiler.ts`

- [ ] **Step 1: Write the seeding helper** (no test yet — it is test infrastructure, exercised by every later task):

```ts
// tests/helpers/gate-e-seed.ts
import type { AssertionRow } from '../../src/assistant/storage/rows.js';
import { OWNER_PERSON_CANONICAL_KEY } from '../../src/assistant/storage/schema.js';
import type { AssistantTestContext } from './assistant-fixture.js';

/**
 * One explicit owner assertion whose topic key derives from the object display name
 * (toTopicKey slugs it). Distinct object names produce distinct Tier 2/3 topics.
 */
export function seedOwnerAssertion(
  context: AssistantTestContext,
  input: { objectName: string; predicate?: 'PREFERS' | 'USES' | 'OWNS' },
): AssertionRow {
  const { graph, ownerId } = context;
  const predicate = input.predicate ?? 'PREFERS';
  const owner = graph.nodes.findByCanonicalKey(ownerId, 'person', OWNER_PERSON_CANONICAL_KEY)
    ?? graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: OWNER_PERSON_CANONICAL_KEY,
      displayName: 'the user', description: null, sensitivity: 'personal', properties: {},
    });
  const object = graph.nodes.createNode({
    ownerId, type: 'software', canonicalKey: `software:${input.objectName}`,
    displayName: input.objectName, description: null, sensitivity: 'personal', properties: {},
  });
  const evidence = graph.evidence.recordTextEvidence({
    ownerId, deviceId: null, parentEvidenceId: null, sourceType: 'chat_message',
    sourceEventId: `gate-e-seed:${input.objectName}:${predicate}`, sourceRef: null,
    capturedAtUtc: graph.nowUtc(), sourceTimezone: null, sensitivity: 'personal',
    retentionUntilUtc: null, metadata: {}, text: `the user ${predicate} ${input.objectName}`,
  });
  const outcome = graph.assertionService.assert({
    ownerId, actorType: 'user', actorRef: ownerId, subjectNodeId: owner.id,
    predicate, object: { kind: 'node', nodeId: object.id }, scopeNodeId: null,
    basis: 'explicit_user_statement', sensitivity: 'personal',
    validFromUtc: null, validToUtc: null, observedAtUtc: graph.nowUtc(),
    topics: [], attributes: {},
    searchText: { subject: 'the user', predicate, object: input.objectName, scope: '' },
    evidence: [{ evidenceId: evidence.id, stance: 'supports', weight: 1 }],
  });
  return outcome.assertion;
}
```

If `sourceType: 'chat_message'` or `AssertionWriteOutcome.assertion` does not typecheck, read `src/assistant/domain/enums.ts` (`EvidenceSourceType`) and `src/assistant/graph/assertion-service.ts` (`AssertionWriteOutcome`) and use the actual member names — do not weaken the helper's types.

- [ ] **Step 2: Write the failing regression test** — the exact orphan condition found on HEAD:

```ts
// tests/assistant-projection-reconciler.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { withAssistantContextAsync } from './helpers/assistant-fixture.js';
import { seedOwnerAssertion } from './helpers/gate-e-seed.js';
import { ProjectionCompiler } from '../src/assistant/projections/projection-compiler.js';
import { EstimateTokenCounter } from '../src/assistant/domain/tokens.js';

// A summarizer that never rewrites: compile stays deterministic and model-free.
const passthroughSummarizer = {
  summarize: async () => ({ kind: 'unchanged' as const }),
};
const TARGETS = { 1: 4_000, 2: 12_000, 3: 3_000 };

function compilerFor(context: Parameters<Parameters<typeof withAssistantContextAsync>[0]>[0]) {
  return new ProjectionCompiler(
    context.graph, new EstimateTokenCounter(), passthroughSummarizer, TARGETS,
  );
}

test('a projection row outside the desired set is deleted on recompile', async () => {
  await withAssistantContextAsync(async (context) => {
    seedOwnerAssertion(context, { objectName: 'Neovim' });
    const compiler = compilerFor(context);
    await compiler.compileAll(context.ownerId, new AbortController().signal);

    // A stale row no compile would produce (e.g. left behind by a 2→3 demotion).
    context.graph.projections.upsert({
      ownerId: context.ownerId, tier: 2, topicKey: 'stale-orphan', title: 'Stale',
      content: 'orphan', contentHash: 'x'.repeat(64), tokenCount: 1,
      tokenizerId: 'estimate', graphVersion: 0, includedAssertionIds: [], sensitivity: 'personal',
    });

    const summary = await compiler.compileAll(context.ownerId, new AbortController().signal);
    assert.equal(summary.deletedProjectionCount, 1);
    assert.equal(
      context.graph.projections.findByTopic(context.ownerId, 2, 'stale-orphan'), null,
    );
    assert.deepEqual(
      context.graph.projections.search(context.ownerId, 'orphan', 10), [],
    );
  });
});
```

Check `ProjectionSummaryService`'s interface in `src/assistant/projections/projection-summarizer.ts` and make `passthroughSummarizer` satisfy it exactly (it must be assignable without casts).

- [ ] **Step 3: Run** `node .\dist\test-runner\run-tests.js assistant-projection-reconciler` (after `npm run build:test`) → FAIL: `deletedProjectionCount` does not exist and the stale row survives.

- [ ] **Step 4: Implement.** `ProjectionStore` gains:

```ts
  /** Every row for the owner regardless of status — the reconciler's sweep input. */
  listAllRows(ownerId: string): ProjectionRow[] {
    return z.array(ProjectionRowSchema).parse(this.database.prepare(
      'SELECT * FROM memory_projections WHERE owner_id = ? ORDER BY tier ASC, topic_key ASC',
    ).all(ownerId));
  }
```

`ProjectionCompiler`: add `deletedProjectionCount: number` to `CompileSummary`. In `compileAll`, collect the desired set — every document that was written **or** skipped as unchanged contributes `` `${tier}:${topicKey}` `` (the profile document too). After the write loop:

```ts
    const deletedProjectionCount = this.sweepOrphans(ownerId, desired);
    return { written, unchanged, demotedTopicKeys, omittedAssertionCount, deletedProjectionCount };
```

```ts
  /** Deletes every row the compile did not produce. Runs unconditionally (§10.3). */
  private sweepOrphans(ownerId: string, desired: ReadonlySet<string>): number {
    let deleted = 0;
    for (const row of this.graph.projections.listAllRows(ownerId)) {
      if (desired.has(`${row.tier}:${row.topic_key}`)) continue;
      this.graph.projections.deleteProjection(row.id);
      this.graph.audit.recordAuditEvent({
        ownerId,
        eventType: 'projection_deleted',
        targetType: 'memory_projections',
        targetId: row.id,
        summary: 'Projection removed: no longer in the compiled desired set.',
        details: { tier: row.tier, topicKey: row.topic_key },
      });
      deleted += 1;
    }
    return deleted;
  }
```

Have `persistWithSummary` return the key it persisted (or collect keys at its call sites — profile + dossier loop) so `desired` is exact.

- [ ] **Step 5: Run** the reconciler test → PASS. Run `node .\dist\test-runner\run-tests.js projection` → all existing projection tests still PASS (fix any `CompileSummary` destructuring the new field breaks).

- [ ] **Step 6: Commit** `fix(assistant): sweep orphan projection rows on every compile`.

---

### Task 3: Archive merge (finding 1 — the 501st Tier 3 document)

**Files:**
- Create: `src/assistant/projections/archive-planner.ts`
- Create: `tests/assistant-archive-planner.test.ts`
- Modify: `src/assistant/projections/projection-compiler.ts`, `tests/assistant-projection-reconciler.test.ts`

- [ ] **Step 1: Write the failing planner tests** (pure function, injectable limit):

```ts
// tests/assistant-archive-planner.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { firstSegment, planTier3Archives } from '../src/assistant/projections/archive-planner.js';

const bundle = (topicKey: string) => ({ topicKey });

test('under the limit nothing is archived', () => {
  const plan = planTier3Archives([bundle('a'), bundle('b')], 5);
  assert.deepEqual(plan.kept.map((item) => item.topicKey), ['a', 'b']);
  assert.equal(plan.archives.size, 0);
});

test('overflow merges lowest-utility topics into per-segment archives', () => {
  const sorted = ['alpha-one', 'alpha-two', 'beta-one', 'beta-two', 'beta-three', 'gamma-one']
    .map(bundle); // already sorted by utility desc
  const plan = planTier3Archives(sorted, 4);
  // Pops from the tail: gamma-one, beta-three, beta-two → archive/gamma (1), archive/beta (2).
  assert.deepEqual(plan.kept.map((item) => item.topicKey), ['alpha-one', 'alpha-two', 'beta-one']);
  assert.deepEqual([...plan.archives.keys()].sort(), ['archive/beta', 'archive/gamma']);
  assert.equal(plan.kept.length + plan.archives.size, 4 + 1); // see step 4 note on the loop bound
});

test('all-singleton segments collapse into archive/misc', () => {
  const sorted = ['a-x', 'b-x', 'c-x', 'd-x', 'e-x'].map(bundle);
  const plan = planTier3Archives(sorted, 2);
  assert.ok(plan.kept.length + plan.archives.size <= 2);
  assert.ok(plan.archives.has('archive/misc') || plan.archives.size <= 2);
});

test('the same input always yields the same plan', () => {
  const sorted = Array.from({ length: 40 }, (_, i) => bundle(`topic-${String(i).padStart(2, '0')}`));
  assert.deepEqual(planTier3Archives(sorted, 10), planTier3Archives(sorted, 10));
});

test('firstSegment splits on hyphen and slash', () => {
  assert.equal(firstSegment('visual-studio-code'), 'visual');
  assert.equal(firstSegment('archive/beta'), 'archive');
  assert.equal(firstSegment(''), 'misc');
});
```

- [ ] **Step 2: Run** → FAIL (module missing).

- [ ] **Step 3: Implement** the planner:

```ts
// src/assistant/projections/archive-planner.ts
export interface ArchivePlan<T extends { readonly topicKey: string }> {
  readonly kept: T[];
  /** Archive topic key → merged bundles, in pop order (lowest utility first). */
  readonly archives: Map<string, T[]>;
}

export function firstSegment(topicKey: string): string {
  const segment = topicKey.split(/[-/]/u)[0] ?? '';
  return segment.length === 0 ? 'misc' : segment;
}

/**
 * §10.3: while the tier exceeds its cap, pop the lowest-utility topic into an
 * `archive/<segment>` group. Archive documents count toward the cap. If every remaining
 * group is a singleton and the cap still does not hold, all groups collapse into
 * `archive/misc`. Pure and deterministic: same sorted input, same plan.
 */
export function planTier3Archives<T extends { readonly topicKey: string }>(
  sortedByUtilityDesc: readonly T[],
  limit: number,
): ArchivePlan<T> {
  const kept = [...sortedByUtilityDesc];
  const archives = new Map<string, T[]>();
  while (kept.length + archives.size > limit && kept.length > 0) {
    const lowest = kept.pop();
    if (lowest === undefined) break;
    const key = `archive/${firstSegment(lowest.topicKey)}`;
    const bucket = archives.get(key);
    if (bucket === undefined) {
      archives.set(key, [lowest]);
    } else {
      bucket.push(lowest);
    }
  }
  if (kept.length + archives.size > limit && archives.size > 1) {
    const merged = [...archives.values()].flat();
    archives.clear();
    archives.set('archive/misc', merged);
  }
  return { kept, archives };
}
```

Adjust the step-1 expectations to the implementation's actual pop arithmetic once it runs (the loop pops until `kept + archives ≤ limit`; a pop into an existing group reduces the total by one, a pop into a new group keeps it flat) — the assertions above must state the true final counts, not aspirations.

- [ ] **Step 4: Run** planner tests → PASS.

- [ ] **Step 5: Write the failing compiler-level test** in `tests/assistant-projection-reconciler.test.ts`. Seeding 501 real topics is slow, so exercise the compiler path with the planner's injectable limit — add an optional `tierLimits` constructor option to `ProjectionCompiler` defaulting to `TIER_DOCUMENT_LIMIT`, used **only** by tests:

```ts
test('tier 3 overflow archives without losing graph facts and reports it', async () => {
  await withAssistantContextAsync(async (context) => {
    for (let index = 0; index < 8; index += 1) {
      seedOwnerAssertion(context, { objectName: `tool${index} extra` }); // topics tool0-extra…
    }
    const compiler = new ProjectionCompiler(
      context.graph, new EstimateTokenCounter(), passthroughSummarizer, TARGETS,
      { 1: 1, 2: 2, 3: 3 },
    );
    const summary = await compiler.compileAll(context.ownerId, new AbortController().signal);

    assert.ok(summary.archivedTopicKeys.length > 0);
    const tier3 = context.graph.projections.listByTier(context.ownerId, 3);
    assert.ok(tier3.length <= 3);
    assert.ok(tier3.some((row) => row.topic_key.startsWith('archive/')));
    // Graph untouched: every seeded assertion still live.
    const owner = context.graph.nodes.findByCanonicalKey(
      context.ownerId, 'person', OWNER_PERSON_CANONICAL_KEY,
    );
    assert.ok(owner !== null);
    assert.equal(
      context.graph.assertions
        .listBySubject(context.ownerId, owner.id, LIVE_ASSERTION_STATUSES).length,
      8,
    );
  });
});

test('the same graph compiles to identical bytes twice', async () => {
  await withAssistantContextAsync(async (context) => {
    for (let index = 0; index < 8; index += 1) {
      seedOwnerAssertion(context, { objectName: `tool${index} extra` });
    }
    const compiler = new ProjectionCompiler(
      context.graph, new EstimateTokenCounter(), passthroughSummarizer, TARGETS,
      { 1: 1, 2: 2, 3: 3 },
    );
    await compiler.compileAll(context.ownerId, new AbortController().signal);
    const first = context.graph.projections.listAllRows(context.ownerId)
      .map((row) => [row.tier, row.topic_key, row.content_hash]);
    await compiler.compileAll(context.ownerId, new AbortController().signal);
    const second = context.graph.projections.listAllRows(context.ownerId)
      .map((row) => [row.tier, row.topic_key, row.content_hash]);
    assert.deepEqual(second, first);
  });
});
```

Replace the placeholder graph-intact assertion with the real check: list the owner's live assertions through `context.graph.assertions` (use the same `listBySubject(ownerId, ownerNodeId, LIVE_ASSERTION_STATUSES)` call `collectViews` uses) and assert the count still equals the seeded count.

- [ ] **Step 6: Run** → FAIL (`archivedTopicKeys` missing, no archive rows).

- [ ] **Step 7: Implement in `ProjectionCompiler`.** Constructor gains `private readonly tierLimits: { 1: number; 2: number; 3: number } = TIER_DOCUMENT_LIMIT` as a fifth optional parameter; replace both existing `TIER_DOCUMENT_LIMIT[2]` uses and the Tier 3 `.slice(0, TIER_DOCUMENT_LIMIT[3])` with `this.tierLimits`. Replace the slice with the planner:

```ts
    const tier3Sorted = [
      ...bundles.filter((bundle) => bundle.tier === 3),
      ...tier2.slice(this.tierLimits[2]).map((bundle) => ({ ...bundle, tier: 3 as const })),
    ].sort((left, right) => right.utility - left.utility);
    const plan = planTier3Archives(tier3Sorted, this.tierLimits[3]);
    const archivedTopicKeys = [...plan.archives.values()].flat()
      .map((bundle) => bundle.topicKey).sort();
```

Compile each archive group after the dossier loop (deterministic order):

```ts
    for (const [archiveKey, group] of [...plan.archives.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))) {
      const document = await this.dossiers.compile({
        tier: 3,
        topicKey: archiveKey,
        title: `Archive — ${archiveKey.slice('archive/'.length)}`,
        views: group.flatMap((bundle) => bundle.views),
        relatedTopicKeys: [],
      });
      const result = await this.persistWithSummary(ownerId, document, graphVersion, abortSignal);
      written += result.written;
      unchanged += result.unchanged;
      omittedAssertionCount += document.omittedAssertionCount;
      this.graph.audit.recordAuditEvent({
        ownerId,
        eventType: 'projection_archived',
        targetType: 'memory_projections',
        targetId: archiveKey,
        summary: `Tier 3 overflow merged into ${archiveKey}.`,
        details: { mergedTopicKeys: group.map((bundle) => bundle.topicKey).sort() },
      });
    }
```

The dossier loop iterates `[...keptTier2, ...plan.kept]`. `CompileSummary` gains `archivedTopicKeys: readonly string[]`. The archive rows join the desired set, so the sweep from Task 2 deletes the superseded individual Tier 3 rows — assert that in the test.

- [ ] **Step 8: Run** reconciler + planner + existing projection tests → PASS.

- [ ] **Step 9: Commit** `feat(assistant): deterministic tier-3 archive merge with loud reporting`.

---

### Task 4: Gate E contract DTOs

**Files:**
- Modify: `packages/contracts/src/assistant.ts`
- Test: extend the contracts test (search `packages/contracts` / `tests/` for where `AssistantDeletionPreviewSchema` is exercised; if only used implicitly, the route tests in Task 15 are the consumers — still add parse round-trip tests in `tests/assistant-gate-e-routes.test.ts` later).

- [ ] **Step 1: Add the schemas** (types come from `z.infer`, everything `.strict()`):

```ts
export const AssistantEvidenceDeletionPreviewSchema = z.object({
  previewToken: z.string(),
  graphVersion: z.number().int().min(0),
  targetEvidenceId: z.string(),
  dependentAssertionIds: z.array(z.string()),
  affectedProjectionIds: z.array(z.string()),
}).strict();
export type AssistantEvidenceDeletionPreview = z.infer<typeof AssistantEvidenceDeletionPreviewSchema>;

export const AssistantTopicForgetPreviewSchema = z.object({
  previewToken: z.string(),
  graphVersion: z.number().int().min(0),
  topicKey: z.string(),
  assertionIds: z.array(z.string()),
  affectedProjectionIds: z.array(z.string()),
}).strict();
export type AssistantTopicForgetPreview = z.infer<typeof AssistantTopicForgetPreviewSchema>;

export const AssistantTopicForgetRequestSchema = z.object({
  topicKey: z.string().trim().min(1),
  addPolicy: z.boolean(),
  previewToken: z.string().min(1),
}).strict();
export type AssistantTopicForgetRequest = z.infer<typeof AssistantTopicForgetRequestSchema>;

export const AssistantFactoryResetPreviewSchema = z.object({
  previewToken: z.string(),
  graphVersion: z.number().int().min(0),
  tableCounts: z.record(z.string(), z.number().int().min(0)),
  blobCount: z.number().int().min(0),
  blobBytes: z.number().int().min(0),
}).strict();
export type AssistantFactoryResetPreview = z.infer<typeof AssistantFactoryResetPreviewSchema>;

export const AssistantConfirmTokenRequestSchema = z.object({
  previewToken: z.string().min(1),
}).strict();
export type AssistantConfirmTokenRequest = z.infer<typeof AssistantConfirmTokenRequestSchema>;

export const AssistantExportRequestSchema = z.object({
  includeDecryptedBlobs: z.boolean(),
}).strict();
export type AssistantExportRequest = z.infer<typeof AssistantExportRequestSchema>;

export const AssistantRestorePreviewResponseSchema = z.object({
  uploadId: z.string(),
  confirmToken: z.string(),
  schemaVersion: z.number().int().positive(),
  custody: z.enum(['file', 'desktop']),
  fileCount: z.number().int().min(0),
  totalBytes: z.number().int().min(0),
}).strict();
export type AssistantRestorePreviewResponse = z.infer<typeof AssistantRestorePreviewResponseSchema>;

export const AssistantRestoreConfirmRequestSchema = z.object({
  uploadId: z.string().min(1),
  confirmToken: z.string().min(1),
}).strict();
export type AssistantRestoreConfirmRequest = z.infer<typeof AssistantRestoreConfirmRequestSchema>;

export const AssistantRestoreResultSchema = z.object({
  ok: z.literal(true),
  blobsReadable: z.boolean(),
  warning: z.string().nullable(),
}).strict();
export type AssistantRestoreResult = z.infer<typeof AssistantRestoreResultSchema>;

export const MobileEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  deviceId: z.string().min(1),
  monotonicTimestamp: z.number().int().positive(),
  nonce: z.string().min(8),
  consent: z.object({ memory: z.boolean(), sensitive: z.boolean() }).strict(),
  sensitivity: z.enum(['low', 'personal', 'sensitive', 'highly_sensitive']),
  payload: z.object({ kind: z.literal('text'), text: z.string().min(1) }).strict(),
  /** base64 Ed25519 signature over the canonical signing payload (see EnvelopeVerifier). */
  signature: z.string().min(1),
}).strict();
export type MobileEnvelope = z.infer<typeof MobileEnvelopeSchema>;
```

Export everything through the package's existing index barrel if one gathers `assistant.ts` exports (check `packages/contracts/src/index.ts`).

- [ ] **Step 2: Run** `npm run typecheck` → PASS (contracts build via `tsc -b`).

- [ ] **Step 3: Commit** `feat(contracts): Gate E deletion/export/restore/mobile DTOs`.

---

### Task 5: Deletion preview payload union

**Files:**
- Modify: `src/assistant/control/deletion-preview.ts`
- Test: `tests/assistant-deletion-modes.test.ts` (created here)

- [ ] **Step 1: Write failing tests** for the generalized service:

```ts
// tests/assistant-deletion-modes.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { withAssistantContext } from './helpers/assistant-fixture.js';
import { seedOwnerAssertion } from './helpers/gate-e-seed.js';
import { DeletionPreviewService } from '../src/assistant/control/deletion-preview.js';

test('an evidence preview token does not validate a different evidence id', () => {
  withAssistantContext((context) => {
    const first = seedOwnerAssertion(context, { objectName: 'Alpha' });
    const second = seedOwnerAssertion(context, { objectName: 'Beta' });
    const previews = new DeletionPreviewService(context.graph, context.database);
    const firstEvidence = context.graph.assertions
      .listSupportingEvidence(first.id)[0];
    const secondEvidence = context.graph.assertions
      .listSupportingEvidence(second.id)[0];
    assert.ok(firstEvidence !== undefined && secondEvidence !== undefined);
    const preview = previews.previewDeleteEvidence(context.ownerId, firstEvidence.evidence_id);
    assert.throws(() => previews.validateDeleteEvidence(
      context.ownerId, secondEvidence.evidence_id, preview.previewToken,
    ));
  });
});

test('a topic preview goes stale when the graph version moves', () => {
  withAssistantContext((context) => {
    seedOwnerAssertion(context, { objectName: 'Gamma Tool' });
    const previews = new DeletionPreviewService(context.graph, context.database);
    const preview = previews.previewForgetTopic(context.ownerId, 'gamma-tool');
    seedOwnerAssertion(context, { objectName: 'Delta Tool' }); // bumps graph version
    assert.throws(() => previews.validateForgetTopic(
      context.ownerId, 'gamma-tool', preview.previewToken,
    ));
  });
});
```

Check `listSupportingEvidence`'s exact return shape in `src/assistant/storage/assertion-store.ts` (the fixture helper `supportWeights` uses it) and use the correct field for the evidence id.

- [ ] **Step 2: Run** → FAIL (methods missing).

- [ ] **Step 3: Implement.** Replace the single `PreviewPayloadSchema` with a discriminated union; the `sign`/`verify`/`secret` mechanics stay identical:

```ts
const ForgetAssertionPayloadSchema = z.object({
  operation: z.literal('forget_assertion'),
  ownerId: z.string(),
  targetAssertionId: z.string(),
  graphVersion: z.number().int().min(0),
  affectedProjectionIds: z.array(z.string()),
  dependentAssertionIds: z.array(z.string()),
}).strict();

const DeleteEvidencePayloadSchema = z.object({
  operation: z.literal('delete_evidence'),
  ownerId: z.string(),
  targetEvidenceId: z.string(),
  graphVersion: z.number().int().min(0),
  dependentAssertionIds: z.array(z.string()),
  affectedProjectionIds: z.array(z.string()),
}).strict();

const ForgetTopicPayloadSchema = z.object({
  operation: z.literal('forget_topic'),
  ownerId: z.string(),
  topicKey: z.string(),
  graphVersion: z.number().int().min(0),
  assertionIds: z.array(z.string()),
  affectedProjectionIds: z.array(z.string()),
}).strict();

const FactoryResetPayloadSchema = z.object({
  operation: z.literal('factory_reset'),
  ownerId: z.string(),
  graphVersion: z.number().int().min(0),
  totalRows: z.number().int().min(0),
}).strict();

const PreviewPayloadSchema = z.discriminatedUnion('operation', [
  ForgetAssertionPayloadSchema, DeleteEvidencePayloadSchema,
  ForgetTopicPayloadSchema, FactoryResetPayloadSchema,
]);
type PreviewPayload = z.infer<typeof PreviewPayloadSchema>;
```

Each operation gets a `buildXPayload` (the deterministic current-state snapshot), a `previewX` (build → sign → DTO from Task 4), and a `validateX` (verify token → check discriminant + ids + owner → rebuild → `JSON.stringify` equality → else `AssistantConflictError`), exactly following the existing `previewForgetAssertion`/`validateForgetAssertion` pair. Affected-set builders:

- `delete_evidence`: `dependentAssertionIds` from `graph.assertions.listAssertionIdsForEvidence(evidenceId).sort()`; `affectedProjectionIds` = projections whose `readIncludedAssertionIds` intersect those, sorted. Unknown/foreign/`status !== 'active'` evidence → `AssistantNotFoundError`.
- `forget_topic`: `assertionIds` via the topic scope helper (Task 7 adds it to `MemoryMutationService`; put the shared query here as an exported function `topicAssertionIds(graph, ownerId, topicKey)` so both use one implementation); `affectedProjectionIds` = projections whose `topic_key === topicKey` **or** whose included ids intersect, sorted.
- `factory_reset`: `totalRows` = sum of counts over `ASSISTANT_TABLE_NAMES` (Task 8 exports it; for this task, hardcode the sum over `graph.projections.listAllRows(ownerId).length` is NOT acceptable — implement factory-reset preview in Task 8 and leave only the payload schema here).

- [ ] **Step 4: Run** the two tests → PASS; run `node .\dist\test-runner\run-tests.js deletion` → existing forget-assertion tests still PASS.

- [ ] **Step 5: Commit** `feat(assistant): deletion preview tokens for evidence, topic, and reset operations`.

---

### Task 6: Evidence deletion workflow

**Files:**
- Modify: `src/assistant/storage/assertion-store.ts` (+`unlinkEvidence`), `src/assistant/control/memory-mutation-service.ts`
- Test: `tests/assistant-deletion-modes.test.ts`

- [ ] **Step 1: Write the failing test** — §19.4 scenario 5 at service level:

```ts
test('deleting source evidence purges the blob, unlinks, and zeroes dependent confidence', () => {
  withAssistantContext((context) => {
    const assertion = seedOwnerAssertion(context, { objectName: 'Epsilon' });
    const link = context.graph.assertions.listSupportingEvidence(assertion.id)[0];
    assert.ok(link !== undefined);
    const evidence = context.graph.evidence.requireEvidence(link.evidence_id);
    assert.ok(evidence.blob_id !== null);

    const mutations = mutationServiceFor(context); // shared local factory: real compiler, passthrough summarizer
    const preview = mutations.previewDeleteEvidence(context.ownerId, evidence.id);
    mutations.confirmDeleteEvidence(context.ownerId, evidence.id, preview.previewToken);

    assert.equal(context.graph.evidence.requireEvidence(evidence.id).status, 'deleted');
    assert.throws(() => context.graph.evidence.readBlobBytes(evidence.blob_id ?? ''));
    assert.deepEqual(context.graph.assertions.listAssertionIdsForEvidence(evidence.id), []);
    const after = context.graph.assertions.getAssertion(assertion.id);
    assert.ok(after !== null && after.confidence < assertion.confidence);
  });
});

test('a stale evidence-deletion token is rejected without partial work', () => {
  withAssistantContext((context) => {
    const assertion = seedOwnerAssertion(context, { objectName: 'Zeta' });
    const link = context.graph.assertions.listSupportingEvidence(assertion.id)[0];
    assert.ok(link !== undefined);
    const mutations = mutationServiceFor(context);
    const preview = mutations.previewDeleteEvidence(context.ownerId, link.evidence_id);
    seedOwnerAssertion(context, { objectName: 'Eta' }); // graph version moves
    assert.throws(() => mutations.confirmDeleteEvidence(
      context.ownerId, link.evidence_id, preview.previewToken,
    ));
    assert.equal(
      context.graph.evidence.requireEvidence(link.evidence_id).status, 'active',
    );
  });
});
```

`mutationServiceFor(context)` constructs `MemoryMutationService` with a real `ProjectionCompiler` (passthrough summarizer from Task 2, `projectionPriority: 5`).

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** `AssertionStore`:

```ts
  /** Removes every evidence link for this evidence id; returns the assertion ids that held one. */
  unlinkEvidence(evidenceId: string): string[] {
    const assertionIds = this.listAssertionIdsForEvidence(evidenceId);
    this.database.prepare('DELETE FROM assertion_evidence WHERE evidence_id = ?').run(evidenceId);
    return assertionIds;
  }
```

`MemoryMutationService`:

```ts
  previewDeleteEvidence(ownerId: string, evidenceId: string): AssistantEvidenceDeletionPreview {
    return this.deletionPreviews.previewDeleteEvidence(ownerId, evidenceId);
  }

  confirmDeleteEvidence(ownerId: string, evidenceId: string, previewToken: string): void {
    this.deletionPreviews.validateDeleteEvidence(ownerId, evidenceId, previewToken);
    const transaction = this.graph.transactions.begin();
    try {
      this.deletionPreviews.validateDeleteEvidence(ownerId, evidenceId, previewToken);
      const dependents = this.graph.assertions.unlinkEvidence(evidenceId);
      this.graph.evidence.deleteEvidence(evidenceId);
      for (const assertionId of dependents) {
        this.graph.assertionService.recalculateConfidence({
          ownerId, assertionId, reason: 'source evidence deleted by the user',
        });
      }
      this.graph.audit.recordAuditEvent({
        ownerId,
        eventType: 'evidence_deleted',
        targetType: 'evidence',
        targetId: evidenceId,
        summary: 'Source evidence deleted by the user; dependent confidence recalculated.',
        details: { dependentAssertionIds: dependents },
      });
      this.graph.audit.incrementGraphVersion();
      transaction.commit();
      this.enqueueProjectionMaintenance(ownerId);
    } catch (error) {
      transaction.rollbackAfter(error);
    }
  }
```

- [ ] **Step 4: Extend the deletion-barrier coverage.** Find the existing barrier test (search `tests/` for `deletion barrier` or `re-checks evidence status`) and add one case: a job that re-checks inside its mutation transaction aborts when the evidence status is `'deleted'` (today it is exercised with `'expired'`). If the barrier check compares `status === 'active'`, the test passes without a production change — that is the desired proof.

- [ ] **Step 5: Run** deletion-modes + barrier tests → PASS.

- [ ] **Step 6: Commit** `feat(assistant): delete-source-evidence workflow with confidence recalculation`.

---

### Task 7: Forget-topic workflow

**Files:**
- Modify: `src/assistant/control/deletion-preview.ts` (shared `topicAssertionIds`), `src/assistant/control/memory-mutation-service.ts`
- Test: `tests/assistant-deletion-modes.test.ts`

- [ ] **Step 1: Write the failing test:**

```ts
test('forgetting a topic retires its assertions, deletes its projections, and can add a policy', async () => {
  await withAssistantContextAsync(async (context) => {
    seedOwnerAssertion(context, { objectName: 'Theta Tool' });   // topic theta-tool
    seedOwnerAssertion(context, { objectName: 'Iota Tool' });    // topic iota-tool, survives
    const mutations = mutationServiceFor(context);
    await mutations.rebuildProjections(context.ownerId, new AbortController().signal);

    const preview = mutations.previewForgetTopic(context.ownerId, 'theta-tool');
    assert.equal(preview.assertionIds.length, 1);
    mutations.confirmForgetTopic(context.ownerId, {
      topicKey: 'theta-tool', addPolicy: true, previewToken: preview.previewToken,
    });
    await mutations.rebuildProjections(context.ownerId, new AbortController().signal);

    const target = context.graph.assertions.getAssertion(preview.assertionIds[0] ?? '');
    assert.ok(target !== null && target.status !== 'active');
    assert.equal(
      context.graph.projections.listAllRows(context.ownerId)
        .some((row) => row.topic_key === 'theta-tool'),
      false,
    );
    assert.equal(
      context.graph.policies.isTopicBlockedFromInference(context.ownerId, 'theta-tool'),
      true,
    );
    // The untouched topic is intact.
    assert.ok(context.graph.projections.listAllRows(context.ownerId)
      .some((row) => row.topic_key === 'iota-tool'));
  });
});
```

Check the retired status value `AssertionService.forget` writes (read `forget`/`StatusChangeRequest` in `assertion-service.ts`) and assert it exactly instead of `!== 'active'`.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** In `deletion-preview.ts` export the shared scope query:

```ts
/** Every live owner assertion whose derived topic key matches. One implementation for preview and confirm. */
export function topicAssertionIds(
  graph: AssistantGraph, ownerId: string, topicKey: string,
): string[] {
  const owner = graph.nodes.findByCanonicalKey(ownerId, 'person', OWNER_PERSON_CANONICAL_KEY);
  if (owner === null) return [];
  const views = new AssertionViewBuilder(graph);
  return graph.assertions.listBySubject(ownerId, owner.id, LIVE_ASSERTION_STATUSES)
    .map((row) => views.build(row))
    .filter((view) => view.topicKey === topicKey)
    .map((view) => view.assertionId)
    .sort();
}
```

(Imports: `AssertionViewBuilder` from `../projections/assertion-view-builder.js`, `LIVE_ASSERTION_STATUSES` from `../storage/assertion-store.js`, `OWNER_PERSON_CANONICAL_KEY` from `../storage/schema.js`.)

`MemoryMutationService`:

```ts
  previewForgetTopic(ownerId: string, topicKey: string): AssistantTopicForgetPreview {
    return this.deletionPreviews.previewForgetTopic(ownerId, topicKey);
  }

  confirmForgetTopic(
    ownerId: string,
    request: { topicKey: string; addPolicy: boolean; previewToken: string },
  ): void {
    this.deletionPreviews.validateForgetTopic(ownerId, request.topicKey, request.previewToken);
    const transaction = this.graph.transactions.begin();
    try {
      this.deletionPreviews.validateForgetTopic(ownerId, request.topicKey, request.previewToken);
      const assertionIds = topicAssertionIds(this.graph, ownerId, request.topicKey);
      for (const assertionId of assertionIds) {
        this.graph.assertionService.forget({
          ownerId, assertionId, reason: `User forgot topic ${request.topicKey}.`,
        });
      }
      for (const row of this.graph.projections.listAllRows(ownerId)) {
        if (row.topic_key === request.topicKey) {
          this.graph.projections.deleteProjection(row.id);
        }
      }
      if (request.addPolicy) {
        this.graph.policies.upsertPolicy({
          ownerId, policyType: 'never_infer_topic', key: request.topicKey,
          value: { reason: 'forget-topic workflow' }, enabled: true, source: 'user',
        });
      }
      this.graph.audit.recordAuditEvent({
        ownerId,
        eventType: 'topic_forgotten',
        targetType: 'topic',
        targetId: request.topicKey,
        summary: `Topic ${request.topicKey} forgotten (${assertionIds.length} assertions retired).`,
        details: { assertionIds, policyAdded: request.addPolicy },
      });
      transaction.commit();
      this.enqueueProjectionMaintenance(ownerId);
    } catch (error) {
      transaction.rollbackAfter(error);
    }
  }
```

`AssertionService.forget` already audits and bumps the graph version per call (verify in `assertion-service.ts` before adding another increment — do **not** double-increment).

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** `feat(assistant): forget-topic workflow with optional never_infer_topic policy`.

---

### Task 8: Factory reset

**Files:**
- Modify: `src/assistant/storage/schema.ts` (table-name constants), `src/assistant/crypto/key-provider.ts`, `src/assistant/crypto/key-custody.ts`, `src/assistant/control/deletion-preview.ts` (factory-reset payload builder), `src/assistant/assistant-service.ts`
- Create: `src/assistant/control/factory-reset-service.ts`
- Test: `tests/assistant-factory-reset.test.ts`

- [ ] **Step 1: Export the table inventory** in `schema.ts` (FK child-first delete order; registries and `runtime_metadata` excluded deliberately):

```ts
/** Every assistant-owned table, children before parents so bulk DELETEs satisfy FKs (§16.1). */
export const ASSISTANT_TABLE_NAMES = [
  'assistant_device_nonces',
  'assistant_question_feedback',
  'assistant_questions',
  'retrieval_usage',
  'assistant_capture_queue',
  'assistant_activity_events',
  'assistant_activity_sessions',
  'candidate_assertions',
  'observations',
  'assertion_evidence',
  'graph_assertions',
  'graph_node_aliases',
  'graph_entity_merges',
  'graph_mutation_log',
  'assistant_audit_events',
  'assistant_jobs',
  'memory_projections',
  'evidence_records',
  'evidence_blobs',
  'graph_nodes',
  'assistant_devices',
  'assistant_policies',
  'assistant_owners',
] as const;

export const ASSISTANT_FTS_TABLE_NAMES = [
  'graph_nodes_fts', 'graph_assertions_fts', 'memory_projections_fts',
] as const;
```

Verify this list against every `CREATE TABLE` in the four schema SQL constants (`grep "CREATE TABLE" src/assistant/storage/schema.ts`) — a missed table must fail loudly, so also add a test that introspects `sqlite_master` for tables named `assistant_%`, `graph_%`, `memory_%`, `evidence_%`, `candidate_%`, `observations`, `retrieval_usage`, `assertion_evidence` and asserts set-equality with the two constants combined (excluding `graph_node_types` / `graph_relation_types`).

- [ ] **Step 2: Write the failing tests:**

```ts
// tests/assistant-factory-reset.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { withAssistantContext } from './helpers/assistant-fixture.js';
import { seedOwnerAssertion } from './helpers/gate-e-seed.js';
import { FactoryResetService } from '../src/assistant/control/factory-reset-service.js';
import { assistantEvidenceDir } from '../src/assistant/layout.js';
import { ASSISTANT_TABLE_NAMES } from '../src/assistant/storage/schema.js';

test('factory reset empties every assistant table, the blob tree, and the key, leaving the rest intact', () => {
  withAssistantContext((context) => {
    seedOwnerAssertion(context, { objectName: 'Kappa' });
    context.database.prepare(
      "INSERT INTO runtime_metadata (key, value, updated_at_utc) VALUES ('unrelated.key', 'keep', ?)",
    ).run(context.clock.nowUtc());

    const service = factoryResetServiceFor(context); // local factory, see step 4
    const preview = service.preview(context.ownerId);
    assert.ok(preview.tableCounts['graph_assertions'] === 1);
    service.confirm(context.ownerId, preview.previewToken);

    for (const table of ASSISTANT_TABLE_NAMES) {
      const row = context.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
      assert.deepEqual(row, { count: 0 }, table);
    }
    assert.equal(fs.existsSync(assistantEvidenceDir(context.runtimeRoot)), false);
    const kept = context.database.prepare(
      "SELECT value FROM runtime_metadata WHERE key = 'unrelated.key'",
    ).get();
    assert.deepEqual(kept, { value: 'keep' });
  });
});

test('re-running factory reset on an empty assistant is a no-op, not an error', () => {
  withAssistantContext((context) => {
    const service = factoryResetServiceFor(context);
    const first = service.preview(context.ownerId);
    service.confirm(context.ownerId, first.previewToken);
    const second = service.preview(context.ownerId);
    service.confirm(context.ownerId, second.previewToken); // idempotent
  });
});
```

- [ ] **Step 3: Run** → FAIL.

- [ ] **Step 4: Implement.** Key plumbing first: `FileKeyProvider.deleteKeyFile` becomes tolerant (`fs.rmSync(this.keyFilePath, { force: true })`); `KeyCustodyService` gains:

```ts
  /** §16.1 factory reset: no key survives, custody returns to file mode. Idempotent. */
  resetForFactoryReset(): void {
    this.fileKeys.deleteKeyFile();
    this.imported.clear();
    this.config.writeCustody('file');
  }
```

`FactoryResetService`:

```ts
// src/assistant/control/factory-reset-service.ts
import fs from 'node:fs';
import type { AssistantFactoryResetPreview } from '@siftkit/contracts';
import { z } from '../../lib/zod.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { AssistantGraph } from '../assistant-graph.js';
import type { KeyCustodyService } from '../crypto/key-custody.js';
import { assistantEvidenceDir } from '../layout.js';
import {
  ASSISTANT_FTS_TABLE_NAMES, ASSISTANT_TABLE_NAMES, GRAPH_VERSION_METADATA_KEY,
  seedAssistantRegistries,
} from '../storage/schema.js';
import { CountRowSchema } from '../storage/rows.js';
import { DeletionPreviewService } from './deletion-preview.js';

export interface FactoryResetServiceOptions {
  readonly graph: AssistantGraph;
  readonly database: RuntimeDatabase;
  readonly keyCustody: KeyCustodyService;
  readonly previews: DeletionPreviewService;
  /** Passed explicitly — AssistantGraph does not expose its runtime root. */
  readonly runtimeRoot: string;
}

export class FactoryResetService {
  private readonly graph: AssistantGraph;
  private readonly database: RuntimeDatabase;
  private readonly keyCustody: KeyCustodyService;
  private readonly previews: DeletionPreviewService;
  private readonly runtimeRoot: string;

  constructor(options: FactoryResetServiceOptions) {
    this.graph = options.graph;
    this.database = options.database;
    this.keyCustody = options.keyCustody;
    this.previews = options.previews;
    this.runtimeRoot = options.runtimeRoot;
  }

  preview(ownerId: string): AssistantFactoryResetPreview {
    return this.previews.previewFactoryReset(ownerId, this.tableCounts(), this.blobStats(ownerId));
  }

  confirm(ownerId: string, previewToken: string): void {
    this.previews.validateFactoryReset(ownerId, previewToken);
    const transaction = this.graph.transactions.begin();
    try {
      this.previews.validateFactoryReset(ownerId, previewToken);
      for (const table of ASSISTANT_FTS_TABLE_NAMES) {
        this.database.prepare(`DELETE FROM ${table}`).run();
      }
      for (const table of ASSISTANT_TABLE_NAMES) {
        this.database.prepare(`DELETE FROM ${table}`).run();
      }
      this.database.prepare(
        'UPDATE runtime_metadata SET value = ?, updated_at_utc = ? WHERE key = ?',
      ).run('0', this.graph.nowUtc(), GRAPH_VERSION_METADATA_KEY);
      transaction.commit();
    } catch (error) {
      transaction.rollbackAfter(error);
      return;
    }
    fs.rmSync(assistantEvidenceDir(this.runtimeRoot), { recursive: true, force: true });
    this.keyCustody.resetForFactoryReset();
    seedAssistantRegistries(this.database /* match the real signature at schema.ts:475 */);
  }

  private tableCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const table of ASSISTANT_TABLE_NAMES) {
      counts[table] = CountRowSchema.parse(
        this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
      ).count;
    }
    return counts;
  }

  private blobStats(ownerId: string): { blobCount: number; blobBytes: number } {
    const row = this.database.prepare(
      'SELECT COUNT(*) AS count, COALESCE(SUM(byte_length), 0) AS bytes FROM evidence_blobs WHERE owner_id = ? AND deleted_at_utc IS NULL',
    ).get(ownerId);
    const parsed = z.object({ count: z.number().int(), bytes: z.number().int() }).parse(row);
    return { blobCount: parsed.count, blobBytes: parsed.bytes };
  }
}
```

Match `seedAssistantRegistries`' real signature (read `schema.ts:475`) — if it needs a clock/ids, pass what the graph exposes; if `AssistantGraph` exposes no clock accessor, add a narrow `graph.nowUtc()`-based seam rather than `clockForSeeding()`. Reset deliberately re-seeds registries and the owner row so the next enable starts clean. Add `previewFactoryReset` / `validateFactoryReset` to `DeletionPreviewService` (payload from Task 5; `totalRows` = sum of `tableCounts`; token also carries `graphVersion` so any concurrent write staleness-fails).

`AssistantService` wiring: constructor builds `this.factoryResets = new FactoryResetService(this.graph, options.database, this.keyCustody, /* the mutation service's preview instance — lift DeletionPreviewService construction out of MemoryMutationService into the AssistantService constructor and pass it to both */)`. Add:

```ts
  private maintenanceActive = false;

  /** Serializes reset/restore against the drain loop. */
  async runMaintenance<T>(work: () => Promise<T>): Promise<T> {
    this.runner.requestPreemption();
    this.maintenanceActive = true;
    try {
      return await work();
    } finally {
      this.maintenanceActive = false;
    }
  }
```

`drainJobs()` gains `if (this.maintenanceActive) return;` as its first line. Public methods `previewFactoryReset()` and `factoryReset(previewToken)` (the latter wraps `runMaintenance`, then sets `this.ownerPersonId = null`).

- [ ] **Step 5: Run** factory-reset tests + the whole `assistant` slice → PASS.

- [ ] **Step 6: Commit** `feat(assistant): factory reset with preview, custody reset, and registry re-seed`.

---### Task 9: Zip module

**Files:**
- Create: `src/lib/zip.ts`
- Test: `tests/zip.test.ts`

- [ ] **Step 1: Write the failing tests:**

```ts
// tests/zip.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { ZipWriter, readZip } from '../src/lib/zip.js';

test('round-trips stored and deflated entries byte-for-byte', () => {
  const writer = new ZipWriter();
  writer.add('manifest.json', Buffer.from('{"a":1}'));
  writer.add('blobs/aa/deadbeef', Buffer.alloc(70_000, 7)); // compressible, > one chunk
  writer.add('empty.txt', Buffer.alloc(0));
  const archive = writer.build();
  const entries = readZip(archive);
  assert.deepEqual([...entries.keys()].sort(), ['blobs/aa/deadbeef', 'empty.txt', 'manifest.json']);
  assert.equal(entries.get('manifest.json')?.toString('utf8'), '{"a":1}');
  assert.equal(entries.get('blobs/aa/deadbeef')?.equals(Buffer.alloc(70_000, 7)), true);
});

test('rejects a corrupted entry via CRC mismatch', () => {
  const writer = new ZipWriter();
  // High-entropy 16 bytes: deflate cannot shrink it, so the writer picks method 0 (store)
  // and the flipped byte reaches the CRC check instead of dying inside inflate.
  writer.add('a.bin', Buffer.from('9f8e7d6c5b4a3210', 'hex').subarray(0, 8));
  const archive = writer.build();
  archive[30 + 'a.bin'.length + 2] ^= 0xff; // inside the stored data
  assert.throws(() => readZip(archive), /CRC/u);
});

test('rejects non-zip input', () => {
  assert.throws(() => readZip(Buffer.from('not a zip')), /end of central directory/iu);
});
```

- [ ] **Step 2: Run** → FAIL (module missing).

- [ ] **Step 3: Implement** `src/lib/zip.ts`:

```ts
import { deflateRawSync, inflateRawSync } from 'node:zlib';

/** Minimal zip container (PKWARE APPNOTE): methods 0 (store) and 8 (deflate), no zip64. */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const EOCD = 0x06054b50;

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface Entry {
  readonly name: Buffer;
  readonly crc: number;
  readonly method: 0 | 8;
  readonly compressed: Buffer;
  readonly uncompressedSize: number;
  offset: number;
}

export class ZipWriter {
  private readonly entries: Entry[] = [];

  add(name: string, data: Buffer): void {
    const deflated = deflateRawSync(data);
    const useDeflate = deflated.byteLength < data.byteLength;
    this.entries.push({
      name: Buffer.from(name, 'utf8'),
      crc: crc32(data),
      method: useDeflate ? 8 : 0,
      compressed: useDeflate ? deflated : data,
      uncompressedSize: data.byteLength,
      offset: 0,
    });
  }

  build(): Buffer {
    const parts: Buffer[] = [];
    let offset = 0;
    for (const entry of this.entries) {
      entry.offset = offset;
      const header = Buffer.alloc(30);
      header.writeUInt32LE(LOCAL_HEADER, 0);
      header.writeUInt16LE(20, 4);                       // version needed
      header.writeUInt16LE(0x0800, 6);                   // UTF-8 names
      header.writeUInt16LE(entry.method, 8);
      header.writeUInt32LE(0, 10);                       // dos time/date: zero, deterministic
      header.writeUInt32LE(entry.crc, 14);
      header.writeUInt32LE(entry.compressed.byteLength, 18);
      header.writeUInt32LE(entry.uncompressedSize, 22);
      header.writeUInt16LE(entry.name.byteLength, 26);
      header.writeUInt16LE(0, 28);                       // extra length
      parts.push(header, entry.name, entry.compressed);
      offset += 30 + entry.name.byteLength + entry.compressed.byteLength;
    }
    const centralStart = offset;
    for (const entry of this.entries) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(CENTRAL_HEADER, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x0800, 8);
      header.writeUInt16LE(entry.method, 10);
      header.writeUInt32LE(0, 12);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.compressed.byteLength, 20);
      header.writeUInt32LE(entry.uncompressedSize, 24);
      header.writeUInt16LE(entry.name.byteLength, 28);
      // 30..41: extra/comment/disk/attrs all zero
      header.writeUInt32LE(entry.offset, 42);
      parts.push(header, entry.name);
      offset += 46 + entry.name.byteLength;
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD, 0);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(offset - centralStart, 12);
    eocd.writeUInt32LE(centralStart, 16);
    parts.push(eocd);
    return Buffer.concat(parts);
  }
}

export function readZip(archive: Buffer): Map<string, Buffer> {
  let eocdOffset = -1;
  const scanFloor = Math.max(0, archive.byteLength - 22 - 65_535);
  for (let index = archive.byteLength - 22; index >= scanFloor; index -= 1) {
    if (archive.readUInt32LE(index) === EOCD) {
      eocdOffset = index;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('Zip end of central directory not found.');
  const entryCount = archive.readUInt16LE(eocdOffset + 10);
  let cursor = archive.readUInt32LE(eocdOffset + 16);
  const entries = new Map<string, Buffer>();
  for (let index = 0; index < entryCount; index += 1) {
    if (archive.readUInt32LE(cursor) !== CENTRAL_HEADER) {
      throw new Error('Zip central directory entry is corrupt.');
    }
    const method = archive.readUInt16LE(cursor + 10);
    const crc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = archive.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed);
    if (crc32(data) !== crc) {
      throw new Error(`Zip entry ${name} failed its CRC check.`);
    }
    entries.set(name, data);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
```

- [ ] **Step 4: Run** `node .\dist\test-runner\run-tests.js zip` → PASS. Manually verify interop once: `powershell Expand-Archive` on a written archive (note the result in the task's commit message body).

- [ ] **Step 5: Commit** `feat(lib): dependency-free zip writer/reader for assistant export and backup`.

---

### Task 10: DPAPI helper + key material export

**Files:**
- Create: `src/assistant/crypto/dpapi.ts`
- Modify: `src/assistant/crypto/imported-key-provider.ts` (+`exportMaterial`), `src/assistant/crypto/key-custody.ts` (+`exportForBackup`)
- Test: `tests/assistant-dpapi.test.ts`

- [ ] **Step 1: Write the failing tests** (real DPAPI — Windows-only repo, mirrors the Gate D Rust round-trip):

```ts
// tests/assistant-dpapi.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { dpapiProtect, dpapiUnprotect, DpapiUnavailableError } from '../src/assistant/crypto/dpapi.js';

test('DPAPI round-trips bytes under the current user', async () => {
  const secret = Buffer.from('gate-e-key-material-0123456789abcdef');
  const sealed = await dpapiProtect(secret);
  assert.equal(sealed.equals(secret), false);
  const opened = await dpapiUnprotect(sealed);
  assert.equal(opened.equals(secret), true);
});

test('tampered ciphertext fails closed as DpapiUnavailableError', async () => {
  const sealed = await dpapiProtect(Buffer.from('payload'));
  sealed[Math.floor(sealed.byteLength / 2)] ^= 0xff;
  await assert.rejects(dpapiUnprotect(sealed), DpapiUnavailableError);
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement:**

```ts
// src/assistant/crypto/dpapi.ts
import { spawnPowerShellAsync } from '../../lib/powershell.js';

/** Raised when DPAPI cannot unprotect — wrong machine/user or corrupt bytes. */
export class DpapiUnavailableError extends Error {}

async function runProtectedData(operation: 'Protect' | 'Unprotect', data: Buffer): Promise<Buffer> {
  const command = [
    'Add-Type -AssemblyName System.Security;',
    `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${operation}(`,
    `[Convert]::FromBase64String('${data.toString('base64')}'), $null,`,
    "[Security.Cryptography.DataProtectionScope]::CurrentUser))",
  ].join(' ');
  const result = await spawnPowerShellAsync(command, { timeoutMs: 30_000 });
  if (result.exitCode !== 0) {
    throw new DpapiUnavailableError(`DPAPI ${operation} failed: ${result.output.trim()}`);
  }
  const encoded = result.output.trim().split(/\r?\n/u).at(-1) ?? '';
  if (!/^[A-Za-z0-9+/=]+$/u.test(encoded) || encoded.length === 0) {
    throw new DpapiUnavailableError(`DPAPI ${operation} produced no output.`);
  }
  return Buffer.from(encoded, 'base64');
}

export async function dpapiProtect(data: Buffer): Promise<Buffer> {
  return runProtectedData('Protect', data);
}

export async function dpapiUnprotect(data: Buffer): Promise<Buffer> {
  return runProtectedData('Unprotect', data);
}
```

Check `spawnPowerShellAsync`'s options/result shape in `src/lib/powershell.ts` and match it exactly. `ImportedKeyProvider.exportMaterial(): KeyMaterialDto` returns the material captured by `import()` (store it; throw if never imported). `KeyCustodyService`:

```ts
  /** Key material for the backup artifact, whatever the custody mode. Never written to disk raw. */
  exportForBackup(): KeyMaterialDto {
    if (this.config.readCustody() === 'desktop') {
      if (!this.imported.imported) {
        throw new AssistantConflictError(
          'Key material is unavailable until the desktop shell re-imports it.',
        );
      }
      return this.imported.exportMaterial();
    }
    const file = this.fileKeys.exportKeyFile();
    return KeyMaterialDtoSchema.parse({
      schemaVersion: 1, activeKeyId: file.activeKeyId, keys: { ...file.keys },
    });
  }
```

- [ ] **Step 4: Run** → PASS (this test hits real DPAPI; it is not mocked).

- [ ] **Step 5: Commit** `feat(assistant): DPAPI seal/unseal and custody-agnostic key export for backup`.

---

### Task 11: Export service

**Files:**
- Create: `src/assistant/control/export-service.ts`
- Test: `tests/assistant-export.test.ts`
- Modify: `src/assistant/assistant-service.ts` (wire `readonly exports: ExportService`)

- [ ] **Step 1: Write the failing tests:**

```ts
// tests/assistant-export.test.ts — inside withAssistantContextAsync
test('export renders the §16.3 tree without blobs by default', async () => {
  // seed one assertion + compile projections (compiler from Task 2 factory)
  const service = new ExportService(context.graph, context.database, context.ownerId);
  const archive = readZip(await service.export({ includeDecryptedBlobs: false }));
  const names = [...archive.keys()];
  for (const required of [
    'manifest.json', 'graph/nodes.jsonl', 'graph/assertions.jsonl', 'graph/aliases.jsonl',
    'graph/evidence-links.jsonl', 'evidence/metadata.jsonl', 'policies.json',
    'questions.jsonl', 'audit.jsonl',
  ]) assert.ok(names.includes(required), required);
  assert.ok(names.some((name) => name.startsWith('projections/tier')));
  assert.equal(names.some((name) => name.startsWith('evidence/blobs/')), false);
  const nodesJsonl = archive.get('graph/nodes.jsonl')?.toString('utf8') ?? '';
  assert.ok(nodesJsonl.split('\n').filter(Boolean).length >= 2); // owner + object node
});

test('includeDecryptedBlobs adds plaintext blobs and an audit row', async () => {
  const service = new ExportService(context.graph, context.database, context.ownerId);
  const archive = readZip(await service.export({ includeDecryptedBlobs: true }));
  assert.ok([...archive.keys()].some((name) => name.startsWith('evidence/blobs/')));
  const audited = context.graph.audit.listAuditEvents(context.ownerId, 50)
    .some((event) => event.event_type === 'decrypted_export');
  assert.equal(audited, true);
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** `ExportService(graph, database, ownerId)` with one public `async export(request: AssistantExportRequest): Promise<Buffer>`:

- `manifest.json`: `{ schemaVersion: CURRENT_SCHEMA_VERSION, exportedAtUtc: graph.nowUtc(), includesDecryptedBlobs }`.
- JSONL files: one owner-scoped `SELECT * FROM <table> WHERE owner_id = ? ORDER BY id` per mapping — `graph_nodes → graph/nodes.jsonl`, `graph_assertions → graph/assertions.jsonl`, `graph_node_aliases → graph/aliases.jsonl`, `assertion_evidence → graph/evidence-links.jsonl` (join through `graph_assertions.owner_id`; `assertion_evidence` has no owner column — verify with `PRAGMA table_info`), `evidence_records → evidence/metadata.jsonl`, `assistant_questions → questions.jsonl`, `assistant_audit_events → audit.jsonl`. Each row is `JSON.stringify`'d as returned (snake_case) after validation with the matching row schema from `storage/rows.js`; unvalidated IO is forbidden.
- `policies.json`: `JSON.stringify(rows, null, 2)` of `assistant_policies` for the owner.
- Projections: for every `graph.projections.listAllRows(ownerId)` row with `status === 'active'`, entry `projections/${row.relative_path}` containing `row.content`.
- Blobs (flag only): for each active `evidence_records` row with a `blob_id`, entry `evidence/blobs/${row.content_hash}` from `graph.evidence.readBlobBytes(row.blob_id)`; then one `recordAuditEvent` with `eventType: 'decrypted_export'`.
- Build with `ZipWriter` and return the buffer. No temp files.

Wire `this.exports = new ExportService(this.graph, options.database, this.graph.ownerId)` into `AssistantService`.

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** `feat(assistant): §16.3 zip export with opt-in decrypted blobs`.

---

### Task 12: Backup service

**Files:**
- Create: `src/assistant/control/backup-service.ts`
- Test: `tests/assistant-backup-restore.test.ts` (created here, extended in Task 13)
- Modify: `src/assistant/assistant-service.ts` (wire `readonly backups: BackupService`)

- [ ] **Step 1: Write the failing test:**

```ts
test('backup carries a verified snapshot, the encrypted blob tree, and a sealed key', async () => {
  // seed an assertion so a blob exists
  const backups = new BackupService({
    graph: context.graph, database: context.database, keyCustody, ownerId: context.ownerId,
  });
  const archive = readZip(await backups.createBackup());
  const manifest = z.object({
    schemaVersion: z.number().int(), createdAtUtc: z.string(),
    custody: z.enum(['file', 'desktop']),
    files: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/u)),
  }).parse(JSON.parse(archive.get('manifest.json')?.toString('utf8') ?? ''));
  assert.equal(manifest.schemaVersion, CURRENT_SCHEMA_VERSION);
  for (const [name, hash] of Object.entries(manifest.files)) {
    const entry = archive.get(name);
    assert.ok(entry !== undefined, name);
    assert.equal(createHash('sha256').update(entry).digest('hex'), hash, name);
  }
  assert.ok(archive.has('snapshot.sqlite'));
  assert.ok(archive.has('key.protected'));
  assert.ok([...archive.keys()].some((name) => name.startsWith('blobs/')));
  // The sealed key is not the raw material.
  const sealed = archive.get('key.protected');
  assert.ok(sealed !== undefined && !sealed.toString('utf8').includes('"keys"'));
});
```

`keyCustody` here is a `KeyCustodyService` built exactly the way `AssistantService`'s constructor builds it (file provider on `assistantKeyFile(context.runtimeRoot)`, fresh `ImportedKeyProvider`, a two-method in-memory `AssistantCustodyConfigPort`).

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** `BackupService`:

1. `await this.database.backup(tempSnapshotPath)` (better-sqlite3 native online backup; temp path from `fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-backup-'))`, removed in `finally`).
2. Walk `assistantEvidenceDir(graph.runtimeRoot)` recursively; each file becomes entry `blobs/<relative path with forward slashes>` with its raw (still encrypted) bytes.
3. `key.protected` = `await dpapiProtect(Buffer.from(JSON.stringify(this.keyCustody.exportForBackup()), 'utf8'))`.
4. `manifest.json` = `{ schemaVersion: CURRENT_SCHEMA_VERSION, createdAtUtc, custody: <current custody from keyCustody.status().custody>, files: { <every other entry name>: sha256hex } }`.
5. Zip and return.

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** `feat(assistant): backup artifact with hash manifest and DPAPI-sealed key`.

---

### Task 13: Restore service

**Files:**
- Create: `src/assistant/control/restore-service.ts`
- Modify: `src/state/runtime-db.ts` (+`migrateDatabaseFile`), `src/assistant/crypto/key-provider.ts` (+`importKeyFile`), `src/assistant/crypto/key-custody.ts` (+`adoptRestoredKeyMaterial`), `src/assistant/assistant-service.ts`
- Test: `tests/assistant-backup-restore.test.ts`

- [ ] **Step 1: Write the failing tests:**

```ts
test('backup → factory reset → restore round-trips the graph, projections, and blobs (§19.4 #12)', async () => {
  seedOwnerAssertion(context, { objectName: 'Lambda' });
  seedOwnerAssertion(context, { objectName: 'Mu' });
  await compilerFor(context).compileAll(context.ownerId, new AbortController().signal);
  const exportBefore = readZip(await exportsService.export({ includeDecryptedBlobs: false }));
  const backupBytes = await backups.createBackup();
  factoryResets.confirm(context.ownerId, factoryResets.preview(context.ownerId).previewToken);

  const restores = new RestoreService({ graph, database, keyCustody, ownerId });
  const preview = restores.preview(backupBytes);
  assert.equal(preview.schemaVersion, CURRENT_SCHEMA_VERSION);
  const result = await restores.confirm(preview.uploadId, preview.confirmToken);
  assert.equal(result.blobsReadable, true);

  const exportAfter = readZip(await exportsService.export({ includeDecryptedBlobs: false }));
  // Byte-identical export ⇒ graph and projections identical.
  assert.deepEqual(
    [...exportAfter.entries()].map(([name, data]) => [name, data.toString('base64')]),
    [...exportBefore.entries()].map(([name, data]) => [name, data.toString('base64')]),
  );
  // Evidence decrypts after the key round-trip.
  const anyBlobEvidence = graph.evidence.list(ownerId, 10, 0).find((row) => row.blob_id !== null);
  assert.ok(anyBlobEvidence?.blob_id !== null && anyBlobEvidence !== undefined);
  graph.evidence.readBlobBytes(anyBlobEvidence.blob_id ?? '');
});

test('restore refuses a tampered manifest hash before touching anything', async () => {
  const archive = readZip(await backups.createBackup());
  const writer = new ZipWriter();
  for (const [name, data] of archive) {
    writer.add(name, name === 'snapshot.sqlite' ? Buffer.concat([data, Buffer.from([1])]) : data);
  }
  assert.throws(() => restores.preview(writer.build()), /hash/iu);
});

test('restore refuses a newer schema version', async () => {
  // rewrite manifest.json with schemaVersion: CURRENT_SCHEMA_VERSION + 1 (and its own corrected hash entry set)
  assert.throws(() => restores.preview(tamperedNewer), /schema/iu);
});

test('a wrong confirm token is a conflict and mutates nothing', async () => {
  const preview = restores.preview(await backups.createBackup());
  await assert.rejects(restores.confirm(preview.uploadId, 'wrong-token'));
});
```

The manifest-exclusion detail: `manifest.json` itself is not hashed in `files`; the newer-schema test regenerates `files` hashes so only the version differs.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** `runtime-db.ts`:

```ts
/** Opens an arbitrary database file, migrates it to CURRENT_SCHEMA_VERSION, and closes it. */
export function migrateDatabaseFile(filePath: string): void {
  const database = new Database(filePath);
  try {
    ensureSchema(database);
  } finally {
    database.close();
  }
}
```

`FileKeyProvider.importKeyFile(file: KeyFile): void` — serialize exactly what `exportKeyFile` reads (inspect the provider's load path and write the same JSON shape, `0600`-style intent via default fs perms on Windows). `KeyCustodyService`:

```ts
  /** Restore's key landing: writes the file, verifies it decrypts restored evidence, file custody. */
  adoptRestoredKeyMaterial(material: KeyMaterialDto): void {
    this.verifyDecrypts(material);
    this.fileKeys.importKeyFile({ activeKeyId: material.activeKeyId, keys: { ...material.keys } });
    this.imported.clear();
    this.config.writeCustody('file');
  }
```

`RestoreService`:

- `preview(archiveBytes: Buffer): AssistantRestorePreviewResponse` — `readZip`; parse+validate `manifest.json` (same schema as Task 12's test); verify every `files` hash; refuse `schemaVersion > CURRENT_SCHEMA_VERSION` (`Error(/schema/)`); write the archive to `fs.mkdtempSync(...siftkit-restore-)/upload.zip`; store `{ path, custody, confirmToken: randomBytes(32).toString('base64url') }` in a private `Map<string, PendingRestore>` keyed by `uploadId = randomBytes(16).toString('hex')`; return counts from the entry map.
- `async confirm(uploadId, confirmToken): Promise<AssistantRestoreResult>` — look up (unknown → `AssistantNotFoundError`; token mismatch via `timingSafeEqual` → `AssistantConflictError`); re-read + re-verify the stored zip; then:
  1. Extract `snapshot.sqlite` to a temp file; `migrateDatabaseFile(snapshotPath)` (older backups migrate; identical versions no-op).
  2. `database.exec("ATTACH DATABASE '<escaped>' AS restore_src")` (single quotes doubled). ATTACH cannot run inside a transaction — attach first.
  3. `BEGIN` → `DELETE FROM <fts tables>` and `DELETE FROM <ASSISTANT_TABLE_NAMES child-first>` → for each of `[...ASSISTANT_TABLE_NAMES].reverse()` then each FTS table, copy with an intersected explicit column list (`PRAGMA main.table_info(t)` ∩ `PRAGMA restore_src.table_info(t)`): `INSERT INTO main.t (cols) SELECT cols FROM restore_src.t`. Copy assistant metadata: `INSERT OR REPLACE INTO runtime_metadata SELECT * FROM restore_src.runtime_metadata WHERE key LIKE 'assistant.%'`. `COMMIT` (rollback + rethrow on any failure) → `DETACH`.
  4. Replace the blob tree: `fs.rmSync(evidenceDir, { recursive: true, force: true })`, then write every `blobs/…` entry back under `assistantEvidenceDir` (reverse the Task 12 path mapping).
  5. Key: `dpapiUnprotect(key.protected)` → `KeyMaterialDtoSchema.parse(JSON.parse(...))` → `keyCustody.adoptRestoredKeyMaterial(material)` → `blobsReadable: true`. On `DpapiUnavailableError`: skip, `blobsReadable: false`, `warning: 'The evidence key could not be unsealed on this machine; graph and projections are restored, blob contents are unreadable.'` — never silent.
  6. Delete the temp upload; return the result.

`AssistantService`: `readonly restores: RestoreService`; the route handler runs `service.runMaintenance(() => service.restores.confirm(...))`.

- [ ] **Step 4: Run** the four tests → PASS. This test file touches real DPAPI (via backup/restore) — keep it serial (`node:test` default) and under one `withAssistantContextAsync` per test.

- [ ] **Step 5: Commit** `feat(assistant): verified assistant-scoped restore with honest key recovery`.

---

### Task 14: Device store + envelope verifier

**Files:**
- Create: `src/assistant/storage/device-store.ts`, `src/assistant/mobile/envelope-verifier.ts`
- Modify: `src/assistant/assistant-service.ts` (+`ingestMobileEnvelope`)
- Test: `tests/assistant-mobile-envelope.test.ts`

- [ ] **Step 1: Write the failing rejection-matrix test:**

```ts
// tests/assistant-mobile-envelope.test.ts
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

function signedEnvelope(privateKey: KeyObject, overrides: Partial<MobileEnvelope> = {}): MobileEnvelope {
  const base = {
    schemaVersion: 1 as const, deviceId: 'dev_test', monotonicTimestamp: 1_000,
    nonce: 'nonce-0001', consent: { memory: true, sensitive: false },
    sensitivity: 'personal' as const,
    payload: { kind: 'text' as const, text: 'the user prefers dark mode' },
    signature: '',
  };
  const unsigned = { ...base, ...overrides };
  const signature = cryptoSign(null, Buffer.from(signingPayload(unsigned), 'utf8'), privateKey);
  return { ...unsigned, signature: signature.toString('base64'), ...('signature' in overrides ? { signature: overrides.signature ?? '' } : {}) };
}

// cases, each asserting verifier.verify(...) returns the exact rejection reason:
// unknown_device, revoked_device, missing_public_key, bad_signature (flip a payload byte after signing),
// stale_timestamp (second envelope with equal timestamp), replayed_nonce (same nonce, higher timestamp),
// and one accepted case that also asserts the nonce row landed.
```

Write all seven cases in full — each inserts its device row via `DeviceStore.insertDevice` and asserts `assert.deepEqual(verifier.verify(envelope), { kind: 'rejected', reason: '<reason>' })` (or `{ kind: 'accepted' }`), plus one audit assertion that a rejection wrote an `assistant_audit_events` row with `event_type: 'mobile_envelope_rejected'` when driven through `AssistantService.ingestMobileEnvelope`.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** `DeviceStore` (constructor `(database, clock)`):

```ts
  getDevice(deviceId: string): DeviceRow | null                    // SELECT * FROM assistant_devices WHERE id = ?
  insertDevice(input: { id; ownerId; platform; displayName; publicKeyBase64: string | null; status: 'active' | 'revoked' }): DeviceRow
  maxMonotonicTimestamp(deviceId: string): number                  // COALESCE(MAX(monotonic_ts), 0)
  /** INSERT OR IGNORE; false means the nonce was already seen. */
  recordNonce(deviceId: string, nonce: string, monotonicTs: number): boolean
```

`DeviceRow` gets a zod schema in `storage/rows.ts` matching the Gate A table. `EnvelopeVerifier`:

```ts
export function signingPayload(envelope: Omit<MobileEnvelope, 'signature'>): string {
  return JSON.stringify([
    envelope.schemaVersion, envelope.deviceId, envelope.monotonicTimestamp, envelope.nonce,
    envelope.consent.memory, envelope.consent.sensitive, envelope.sensitivity,
    envelope.payload.kind, envelope.payload.text,
  ]);
}

export type EnvelopeRejection =
  | 'unknown_device' | 'revoked_device' | 'missing_public_key'
  | 'bad_signature' | 'stale_timestamp' | 'replayed_nonce';
export type EnvelopeVerdict = { kind: 'accepted' } | { kind: 'rejected'; reason: EnvelopeRejection };

export class EnvelopeVerifier {
  constructor(private readonly devices: DeviceStore) {}

  verify(envelope: MobileEnvelope): EnvelopeVerdict {
    const device = this.devices.getDevice(envelope.deviceId);
    if (device === null) return rejected('unknown_device');
    if (device.status === 'revoked') return rejected('revoked_device');
    if (device.public_key === null) return rejected('missing_public_key');
    const key = createPublicKey({
      key: Buffer.from(device.public_key, 'base64'), format: 'der', type: 'spki',
    });
    const { signature, ...unsigned } = envelope;
    const valid = cryptoVerify(
      null, Buffer.from(signingPayload(unsigned), 'utf8'), key, Buffer.from(signature, 'base64'),
    );
    if (!valid) return rejected('bad_signature');
    if (envelope.monotonicTimestamp <= this.devices.maxMonotonicTimestamp(envelope.deviceId)) {
      return rejected('stale_timestamp');
    }
    if (!this.devices.recordNonce(envelope.deviceId, envelope.nonce, envelope.monotonicTimestamp)) {
      return rejected('replayed_nonce');
    }
    return { kind: 'accepted' };
  }
}
```

`AssistantService.ingestMobileEnvelope(envelope: MobileEnvelope): EnvelopeVerdict` — verify; on rejection audit `mobile_envelope_rejected` (reason + deviceId only, never the payload); on acceptance build a standard `IngestionEnvelope` (`sourceType: 'mobile_event'`, `sourceEventId: `mobile:${envelope.deviceId}:${envelope.nonce}``, sensitivity from the envelope, payload text) and hand it to the same `IngestionPipeline.accept` path `ConversationIngestor` uses — read `src/assistant/ingestion/envelope.ts` for the envelope constructor shape and mirror it; the pipeline instance is already constructed in the service constructor (lift it to a field).

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** `feat(assistant): mobile envelope verifier with device, timestamp, and nonce enforcement`.

---

### Task 15: HTTP routes

**Files:**
- Modify: `src/status-server/routes/assistant.ts`
- Test: `tests/assistant-gate-e-routes.test.ts` (follow the harness in `tests/assistant-desktop-state.test.ts` — real status server, bootstrap token, `requestJson`)

- [ ] **Step 1: Write failing route tests** covering: evidence deletion preview + confirm (and 404 for foreign id); topic forget preview + confirm; factory-reset preview + confirm while the assistant is **disabled** (must work — maintenance sits above the enabled gate); export returns `application/zip` whose bytes `readZip` can parse; backup likewise; restore-preview (raw zip body) → confirm; mobile returns 404 with `Mobile.Enabled: false` and 409 `assistant_disabled` with the flag on but assistant off; a wrong preview token → 409.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** Constants: `const RESTORE_BODY_LIMIT = 512 * 1024 * 1024;` and `const ZIP_RESPONSE_HEADERS = (bytes: Buffer) => ({ 'Content-Type': 'application/zip', 'Content-Length': bytes.byteLength, 'Cache-Control': 'no-store' });`

Above the `if (!service.enabled)` gate (maintenance must work while disabled, like key custody):

```ts
    if (pathname === '/assistant/factory-reset/preview') {
      sendJson(res, 200, service.previewFactoryReset());
      return;
    }
    if (pathname === '/assistant/factory-reset') {
      const request = await body(req, AssistantConfirmTokenRequestSchema);
      // factoryReset wraps runMaintenance itself (Task 8) — do not double-wrap here.
      await service.factoryReset(request.previewToken);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (pathname === '/assistant/export') {
      const request = await body(req, AssistantExportRequestSchema);
      const bytes = await service.exports.export(request);
      res.writeHead(200, ZIP_RESPONSE_HEADERS(bytes));
      res.end(bytes);
      return;
    }
    if (pathname === '/assistant/backup') {
      const bytes = await service.backups.createBackup();
      res.writeHead(200, ZIP_RESPONSE_HEADERS(bytes));
      res.end(bytes);
      return;
    }
    if (pathname === '/assistant/restore-preview') {
      const upload = await readBody(req, { maxBytes: RESTORE_BODY_LIMIT });
      sendJson(res, 200, service.restores.preview(upload));
      return;
    }
    if (pathname === '/assistant/restore') {
      const request = await body(req, AssistantRestoreConfirmRequestSchema);
      const result = await service.runMaintenance(
        async () => service.restores.confirm(request.uploadId, request.confirmToken),
      );
      sendJson(res, 200, result);
      return;
    }
    // §7.6: indistinguishable from absent while disabled — checked before the enabled gate.
    if (pathname === '/assistant/ingest/mobile' && !service.config.Mobile.Enabled) {
      sendError(res, 404, 'not_found', 'Not found.');
      return;
    }
```

`readBody` returns the raw body — confirm it yields a `Buffer` (or adapt: `http-utils.ts`). Below the enabled gate:

```ts
    if (pathname === '/assistant/ingest/mobile') {
      const envelope = await body(req, MobileEnvelopeSchema, MUTATION_BODY_LIMIT);
      const verdict = service.ingestMobileEnvelope(envelope);
      if (verdict.kind === 'rejected') {
        sendError(res, 403, 'envelope_rejected', `Envelope rejected: ${verdict.reason}.`);
      } else {
        sendJson(res, 202, { ok: true });
      }
      return;
    }
    if (/^\/assistant\/evidence\/[^/]+\/deletion-preview$/u.test(pathname)) {
      sendJson(res, 200, service.memoryMutations.previewDeleteEvidence(service.ownerId, id(match)));
      return;
    }
    if (/^\/assistant\/evidence\/[^/]+$/u.test(pathname) && method === 'DELETE') {
      const request = await body(req, AssistantConfirmTokenRequestSchema);
      service.memoryMutations.confirmDeleteEvidence(service.ownerId, id(match), request.previewToken);
      sendJson(res, 200, success(service));
      return;
    }
    if (pathname === '/assistant/topics/forget-preview') {
      const request = await body(req, z.object({ topicKey: z.string().trim().min(1) }).strict());
      sendJson(res, 200, service.memoryMutations.previewForgetTopic(service.ownerId, request.topicKey));
      return;
    }
    if (pathname === '/assistant/topics/forget') {
      const request = await body(req, AssistantTopicForgetRequestSchema);
      service.memoryMutations.confirmForgetTopic(service.ownerId, request);
      sendJson(res, 200, success(service));
      return;
    }
```

Register every new path in the `RouteTable` (exact strings; the two evidence regexes with `DELETE`/`GET` methods; keep the evidence deletion-preview regex registered **before** the plain evidence-id regex, matching the existing blob-route ordering comment). Evidence-id routes: `AssistantService.previewDeleteEvidence` must 404 foreign/unknown evidence — the preview service already throws `AssistantNotFoundError`, which the outer handler maps to 404.

- [ ] **Step 4: Run** the route tests + existing `assistant` route tests → PASS.

- [ ] **Step 5: Commit** `feat(assistant): Gate E maintenance, deletion, and mobile routes`.

---

### Task 16: CLI

**Files:**
- Modify: `src/cli/assistant-args.ts`, `src/cli/run-assistant.ts`, `src/cli/status-server-api-client.ts`
- Test: `tests/assistant-gate-e-cli.test.ts` (follow the existing CLI test for `memory forget` — search `tests/` for `runAssistantCli`)

- [ ] **Step 1: Write failing parser + dispatch tests** for the new invocations, including: `evidence delete <id> --preview`, `--confirm <token>`; `memory forget-topic <key> --block --preview`; `factory-reset --preview` / `--confirm <token>`; `export --output x.zip --include-blobs`; `backup --output x.zip`; `restore --input x.zip --preview`; `restore --confirm <uploadId> <token>`; and usage errors for each malformed form (exact `Usage:` strings asserted).

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** Extend `AssistantCliInvocation`:

```ts
  | { readonly kind: 'evidence_delete_preview'; readonly evidenceId: string }
  | { readonly kind: 'evidence_delete_confirm'; readonly evidenceId: string; readonly previewToken: string }
  | { readonly kind: 'forget_topic_preview'; readonly topicKey: string; readonly addPolicy: boolean }
  | { readonly kind: 'forget_topic_confirm'; readonly topicKey: string; readonly addPolicy: boolean; readonly previewToken: string }
  | { readonly kind: 'factory_reset_preview' }
  | { readonly kind: 'factory_reset_confirm'; readonly previewToken: string }
  | { readonly kind: 'export'; readonly output: string; readonly includeBlobs: boolean }
  | { readonly kind: 'backup'; readonly output: string }
  | { readonly kind: 'restore_preview'; readonly input: string }
  | { readonly kind: 'restore_confirm'; readonly uploadId: string; readonly confirmToken: string }
```

Parse in the existing style (`exact`, `required`; `--preview`/`--confirm` mirrors `memory forget`). `StatusServerApiClient` gains: `previewAssistantEvidenceDeletion`, `confirmAssistantEvidenceDeletion`, `previewAssistantTopicForget`, `confirmAssistantTopicForget`, `previewAssistantFactoryReset`, `confirmAssistantFactoryReset` (JSON, existing `requestAssistant` plumbing with the Task 4 schemas), plus two binary helpers modeled on `requestAssistant` but returning/sending bytes: `requestAssistantZip(path, token): Promise<Buffer>` and `postAssistantRestorePreview(token, bytes): Promise<AssistantRestorePreviewResponse>` (`Content-Type: application/zip` raw body). `run-assistant.ts` cases: export/backup write the buffer with `fs.writeFileSync(invocation.output, bytes)` and print the path + byte count; previews `writeJson`; confirms print one-line results (`evidence deleted`, `topic forgotten`, `assistant reset`, restore prints `blobsReadable` + warning when present).

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** `feat(cli): assistant evidence/topic/reset/export/backup/restore commands`.

---

### Task 17: Dashboard — Memory Inspector actions

**Files:**
- Modify: `dashboard/src/assistant-api.ts`, `dashboard/src/components/AssistantMemoryDetail.tsx`
- Test: `dashboard/tests/assistant-maintenance.test.tsx` covers the panel (Task 18); evidence-delete/forget-topic assertions go in the existing `dashboard/tests/` file that exercises `AssistantMemoryDetail` (find it via `grep -l AssistantMemoryDetail dashboard/tests`)

- [ ] **Step 1: Write failing component tests**: rendering evidence detail shows a "Delete evidence…" action; clicking it fetches the preview and renders `dependentAssertionIds.length` and `affectedProjectionIds.length`; confirming calls the confirm API with the preview's token; a "Forget topic…" action beside the topic key does the same through the topic preview. Mock `assistant-api` the way the existing detail tests do.

- [ ] **Step 2: Run** `npm run test:dashboard` → FAIL.

- [ ] **Step 3: Implement.** `assistant-api.ts` (same shape as `previewForgetAssistantAssertion`):

```ts
export function previewDeleteAssistantEvidence(token: string, id: string): Promise<AssistantEvidenceDeletionPreview>
export function confirmDeleteAssistantEvidence(token: string, id: string, previewToken: string)
export function previewForgetAssistantTopic(token: string, topicKey: string): Promise<AssistantTopicForgetPreview>
export function confirmForgetAssistantTopic(token: string, request: AssistantTopicForgetRequest)
```

In `AssistantMemoryDetail.tsx`, mirror the existing forget-assertion preview→confirm flow (state, cascade list, confirm button) for the two new actions; reuse its styling and confirmation affordances exactly — no new UI idiom.

- [ ] **Step 4: Run** → PASS (including the full dashboard suite).

- [ ] **Step 5: Commit** `feat(dashboard): evidence deletion and forget-topic with cascade previews`.

---

### Task 18: Dashboard — maintenance panel

**Files:**
- Create: `dashboard/src/tabs/settings/AssistantMaintenance.tsx`
- Modify: `dashboard/src/assistant-api.ts`, `dashboard/src/tabs/settings/AssistantSettings.tsx` (mount the panel), `dashboard/src/settings-sections.ts` (labels + helpText for the new controls)
- Test: `dashboard/tests/assistant-maintenance.test.tsx`

- [ ] **Step 1: Write failing tests**: export button triggers `exportAssistant` and an object-URL download (assert one `URL.createObjectURL`/`revokeObjectURL` pair, the Gate D reveal pattern); backup likewise; restore renders file input → preview summary (`fileCount`, `schemaVersion`) → confirm calls `confirmAssistantRestore(uploadId, token)` and surfaces `warning` when `blobsReadable` is false; factory reset requires typing `RESET ASSISTANT` exactly before the confirm button enables, then calls preview + confirm. Query by exact accessible names (the help-popover lesson: never unanchored substring regexes).

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** API additions: `exportAssistant(token, includeDecryptedBlobs): Promise<Blob>`, `backupAssistant(token): Promise<Blob>` (both via `fetch` with the bearer header, `.blob()`, following `fetchAssistantEvidencePixels`), `previewAssistantRestore(token, file: Blob): Promise<AssistantRestorePreviewResponse>`, `confirmAssistantRestore(token, uploadId, confirmToken): Promise<AssistantRestoreResult>`, `previewAssistantFactoryReset(token)`, `confirmAssistantFactoryReset(token, previewToken)`. The panel is one component with four bordered sections; destructive sections show the preview payload before the confirm control; factory reset's typed-phrase gate:

```tsx
<input aria-label="Type RESET ASSISTANT to enable the reset button" value={phrase}
  onChange={(event) => setPhrase(event.target.value)} />
<button type="button" disabled={phrase !== 'RESET ASSISTANT' || preview === null}
  onClick={() => { void runReset(); }}>Reset assistant</button>
```

Mount in `AssistantSettings.tsx` under the existing sections; add the section fields to `settings-sections.ts` so labels resolve through `SettingsSectionField`.

- [ ] **Step 4: Run** dashboard suite → PASS.

- [ ] **Step 5: Commit** `feat(dashboard): assistant maintenance panel (export, backup, restore, factory reset)`.

---

### Task 19: E2E scenarios

**Files:**
- Create: `tests/assistant-gate-e-e2e.test.ts` (harness: `withAssistantContextAsync` + `AssistantService.create` with `FakeAssistantInference`, `EstimateTokenCounter`, `AlwaysIdle`, `MemoryAssistantConfigWriter` — copy the composition from `tests/assistant-gate-d-e2e.test.ts`, minus the HTTP server where the scenario doesn't need routes)

- [ ] **Step 1: Write the four scenarios as failing/green integration proofs:**

1. **Scenario 5** — evidence deletion through `AssistantService.memoryMutations`: capture-backed evidence (reuse the Gate D PNG intake path) supports an assertion; delete the evidence via preview→confirm; drain; assert confidence recalculated, blob purged, projections refreshed without the citation.
2. **Scenario 7** — 26 Tier 2 topics (seed via `seedOwnerAssertion` with 3+ assertions per topic so utility routes to Tier 2 — verify against `routeTier`'s actual thresholds and adjust seeding); compile; assert exactly 25 Tier 2 rows, the 26th topic present as Tier 3, `demotedTopicKeys` names it, no orphan Tier 2 row (the Task 2 regression at E2E scale), and every seeded assertion still live.
3. **Scenario 8** — with the injectable tier limits (`{1: 1, 2: 3, 3: 5}`), seed enough topics to overflow Tier 3; assert an `archive/` row exists, `archivedTopicKeys` is loud, graph facts intact, and a second compile is byte-identical.
4. **Scenario 12** — full service path: seed → drain → export → factory reset (via `service.factoryReset`) → restore (via `service.restores`) → export again → byte-identical archives; assert `desktopState()` and `status()` behave sanely after restore (owner re-resolved).

Every scenario ends with the shared **projection-integrity property check** (spec §7) — extract it as a local helper and call it after each scenario's final compile:

```ts
function assertProjectionIntegrity(context: AssistantTestContext): void {
  const live = new Set(
    context.graph.projections.listAllRows(context.ownerId).flatMap(
      (row) => context.graph.projections.readIncludedAssertionIds(row),
    ),
  );
  for (const assertionId of live) {
    const assertion = context.graph.assertions.getAssertion(assertionId);
    assert.ok(assertion !== null, `projection cites missing assertion ${assertionId}`);
    assert.ok(
      LIVE_ASSERTION_STATUSES.includes(assertion.status),
      `projection cites retired assertion ${assertionId} (${assertion.status})`,
    );
  }
}
```

(If `LIVE_ASSERTION_STATUSES`'s type is a readonly tuple, use `.some((status) => status === assertion.status)` instead of `includes` — no casts.)

- [ ] **Step 2: Run** → these should PASS if Tasks 2–13 are correct; every failure here is a real integration bug — fix the service, never the assertion.

- [ ] **Step 3: Commit** `test(assistant): Gate E end-to-end scenarios 5, 7, 8, and 12`.

---

### Task 20: §19.5 benchmark scripts

**Files:**
- Create: `scripts/assistant-bench/seed.ts`, `scripts/assistant-bench/measure.ts`
- Modify: `package.json` (add `"bench:assistant:seed": "tsx .\\scripts\\assistant-bench\\seed.ts"` and `"bench:assistant": "tsx .\\scripts\\assistant-bench\\measure.ts"`)

- [ ] **Step 1: Implement `seed.ts`.** Args: `--root <dir>` (default `.bench-assistant`), `--assertions <n>` (default `100000`). Compose `AssistantGraph` exactly like `withAssistantContext` (real `FileKeyProvider`, `SystemClock` — find the non-fixed clock in `src/assistant/clock.ts`). Seed inside chunked explicit transactions (1 000 rows per `BEGIN`/`COMMIT` via the transaction manager): 2 000 object nodes; `n` assertions distributed round-robin over the nodes via the same `assertionService.assert` call `seedOwnerAssertion` uses (unique `sourceEventId` per row; reuse one shared evidence text per 50 assertions so blobs dedupe); then one `ProjectionCompiler.compileAll` (passthrough summarizer) and 10 000 `ActivityLog.ingest` calls with synthetic `ActivityEventDto`s (copy a valid DTO literal from the Gate D golden fixtures under `packages/contracts` — find with `grep -rl ActivityEventDto packages/contracts src/assistant`). Print row counts and elapsed time.

- [ ] **Step 2: Implement `measure.ts`.** Opens the seeded root read-only-in-spirit; for each target run warmup ×10 then measure ×1 000 (×50 for retrieval), report p50/p95 in a fixed-width table with the §19.5 budget beside it:

| Measurement | How | Budget |
|---|---|---|
| Graph lookup p95 | `graph.assertions.getAssertion(randomId)` over pre-collected ids | < 50 ms |
| Tier 1 load | `graph.projections.findByTopic(owner, 1, 'profile')` + `.content.length` | < 20 ms |
| Retrieval p95 | `MemoryRetriever.retrieve` (construct with `EstimateTokenCounter`, `DEFAULT_ASSISTANT_CONFIG.Retrieval`, `graph.retrievalUsage`; `recordUsage: false`) | < 150 ms |
| Activity ingestion | `ActivityLog.ingest` of one synthetic event | < 10 ms |
| Capture dedupe | `hashBytes` of a 2 MP-sized buffer + one `CaptureQueueStore` hash lookup (mirror the intake's dedupe query) | < 250 ms |

Exit code 0 regardless of budget misses — this records numbers, it does not gate. Print `MISSED` markers so the handoff can quote them honestly.

- [ ] **Step 3: Run** `npm run bench:assistant:seed -- --assertions 100000` then `npm run bench:assistant`; paste the output table into the Gate E handoff verbatim.

- [ ] **Step 4: Commit** `feat(bench): assistant §19.5 seed and measurement scripts`.

---

### Task 21: Final verification gate

- [ ] **Step 1:** `npm run build:test` → exit 0.
- [ ] **Step 2:** `npm test` → 0 failures (2 known environment skips allowed).
- [ ] **Step 3:** `npm run test:dashboard` → 0 failures.
- [ ] **Step 4:** `npm run typecheck` → exit 0 (includes eslint).
- [ ] **Step 5:** `npm run build` → exit 0 (known chunk-size warning allowed).
- [ ] **Step 6:** Spec coverage checklist against `2026-08-13-assistant-gate-e-hardening-design.md` §9 exit criteria, line by line, each with the test name that proves it. Anything unproven is reported as unproven — never rounded up.
- [ ] **Step 7:** Write the Gate E handoff to `docs/superpowers/handoffs/2026-08-13-assistant-gate-e-handoff.md`: deviations from this plan, the benchmark table, the DPAPI/PowerShell dependency note, and the soak-test carve-out (user runs it manually).

---

## Self-review notes (baked into the tasks)

- **Spec §1–§4 → Tasks 2–3, 5–8, 11–13, 14.** Spec §5 surfaces → Tasks 15–18. §7 testing → Tasks 2, 3, 5–7, 13, 14, 19. §8 → Task 20. §9 exit criteria → Task 21 checklist.
- The preview-token pattern (HMAC, rebuild-and-compare, revalidate inside the transaction) is reused verbatim for all four destructive modes — one signer, one secret row.
- `topicAssertionIds` lives once, in `deletion-preview.ts`, imported by the mutation service.
- The reconciler sweep runs on **every** compile (Tasks 2–3), so forget-topic and restore need no bespoke projection cleanup beyond their own topic rows.
- Restore + factory reset share `ASSISTANT_TABLE_NAMES`; the `sqlite_master` introspection test (Task 8 step 1) fails loudly when a future migration adds a table and forgets the constant.

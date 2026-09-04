# Session Drift Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the twenty drift findings from the 2026-09-03 session review so the owner-identity, capture-recovery, and cleanup work matches the repo directives instead of patching around them.

**Architecture:** Structured state replaces stringly-typed encodings (candidate holds get a parsed column, enums are shared through contracts); every graph write the cleanup makes goes through the mutation log; guards live in one place (the merge service) and callers stop re-implementing them; the cleanup becomes a real preview/execute maintenance operation behind signed tokens like factory reset; duplicated helpers in source and tests collapse into one.

**Tech Stack:** TypeScript, zod contracts in `packages/contracts`, better-sqlite3 through the assistant stores, versioned migrations in `src/state/migrations/registry.ts`, `node:test` suites run by `node ./dist/test-runner/run-tests.js <suite>`.

## Status (2026-09-03)

| Task | Finding | State |
|---|---|---|
| 1 — owner node is never merged away | 4 | done |
| 2 — pronoun aliases leave the near-miss set | 5 | done |
| 3 — merge actor type derived and logged | 7 | done |
| 4 — `finish` takes the real transaction scope | 17 | done |
| 5 — edit distance without index fallbacks | 18 | done |
| 6 — `EvidenceStore.setSensitivity` | 19 | done |
| 7 — node status enum shared through contracts | 12 | done |
| 8 — one source for pending capture states | 13 | done |
| 9 — structured candidate hold | 2 | done |
| 10 — resolve-identity returns its outcome | 11 | done |
| 11 — a "no" answer is recorded explicitly, in one transaction | 6 | done |
| 12 — stranded recovery from parsed payloads | 8 | done |
| 13 — drop the dead-letter marker step | 9 | done |
| 14 — one discard path for deleted blobs | 10 | done |
| 15 — cleanup writes are audited | 1 | done |
| 16 — cleanup preview/execute routes | 3 | done |
| 17 — claim relies on the merge's guards | 14 | done |
| 18 — display-name alias reconciliation | 15 | done |
| 19 — shared test fixtures | 16 | done |
| 20 — status docs match what ran | 20 | done |

## Ground rules

TDD throughout: write the failing test named in each task, watch it fail for the stated reason,
implement the smallest change that passes, then run `npm run typecheck` and the named suites.

Do not commit. Do not create temp files. Do not touch tasks other than the one dispatched.
Work the tasks in order. Dependencies: 10 and 11 need 9; 14, 15, and 16 build on each other in
that order; 12 and 13 precede 14; 19 is last because it moves helpers the earlier tasks edit.

Suites run as `npm run build:test && node ./dist/test-runner/run-tests.js <suite>` where
`<suite>` is the test file's basename without `.test.ts`, e.g. `assistant-merge`. Type-only
changes are verified by `npm run typecheck`, which also runs lint.

Line numbers below are from the 2026-09-03 tree; re-anchor by the quoted code if they have moved.

---

### Task 1: The owner node is never merged away

**Files:**
- Modify: `src/assistant/graph/merge-service.ts:256-265`
- Test: `tests/assistant-merge.test.ts`

The guard now reads `actorType !== 'user' && (source is owner || target is owner)`, which lets a
user actor merge the owner *into* a third party. Only the target may ever be the owner.

- [x] **Step 1: Write the failing test**

Append to `tests/assistant-merge.test.ts`:

```ts
/** A merge only ever consolidates *into* the owner. Merging the owner away would leave
 * `ownerPersonId` pointing at a merged node, whatever actor asked. */
test('even the owner cannot merge the owner node into another person', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const other = h.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: null, displayName: 'demyx',
      description: null, sensitivity: 'personal', properties: {},
    });

    const outcome = h.merges.merge({
      ownerId: context.ownerId, sourceNodeId: h.personId, targetNodeId: other.id,
      actorType: 'user', basis: 'wrong direction', reason: 'merge',
    });

    assert.equal(outcome.kind === 'blocked' && outcome.code, 'owner_identity_collapse');
    assert.equal(h.nodes.requireNode(h.personId).status, 'active');
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npm run build:test && node ./dist/test-runner/run-tests.js assistant-merge`
Expected: the new test fails with `AssertionError [ERR_ASSERTION]: false !== 'owner_identity_collapse'`
because the merge succeeds.

- [x] **Step 3: Split the guard by direction**

Replace the block at `merge-service.ts:256-265`:

```ts
    if (source.canonical_key === OWNER_PERSON_CANONICAL_KEY) {
      return block('owner_identity_collapse', 'The owner node is never merged into another node.');
    }
    if (target.canonical_key === OWNER_PERSON_CANONICAL_KEY && request.actorType !== 'user') {
      return block(
        'owner_identity_collapse',
        'Only the owner may merge a node into the owner identity.',
      );
    }
```

- [x] **Step 4: Run the suite to verify it passes**

Run: `node ./dist/test-runner/run-tests.js assistant-merge`
Expected: all pass, including `the owner may merge a duplicate of themselves when they ask for it`.

---

### Task 2: Pronoun aliases leave the near-miss set

**Files:**
- Modify: `src/assistant/domain/owner-identity.ts:48-53` (`isNearOwnerAlias`)
- Test: `tests/assistant-owner-alias-question.test.ts`

`OWNER_PRONOUN_ALIASES` does two jobs: a resolution shortcut in `resolveNode` and, by accident,
an edit-distance target. `Ester`, `Asher`, `Usher`, and `Iser` are within two edits of `user`.

- [x] **Step 1: Write the failing test**

Append to `tests/assistant-owner-alias-question.test.ts`:

```ts
/** `user` and `myself` are seeded as owner aliases, but they are not names. A real person two
 * edits from a pronoun must not be asked whether they are the owner. */
test('a name near a pronoun alias is not questioned', () => {
  withAssistantContext((context) => {
    const ownerNodeId = seedOwner(context);
    context.graph.nodes.addAlias({
      ownerId: context.ownerId, nodeId: ownerNodeId, alias: 'user',
      aliasType: 'user_supplied', sourceEvidenceId: null,
    });
    const candidateId = proposePersonUses(context, 'Ester', 'cap:11');

    const outcome = buildPromoter(context.graph)
      .promote({ ownerId: context.ownerId, candidateId });

    assert.equal(outcome.kind, 'promoted');
    const assertionId = outcome.kind === 'promoted' ? outcome.assertionId : '';
    assert.notEqual(
      context.graph.assertions.requireAssertion(assertionId).subject_node_id, ownerNodeId,
    );
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npm run build:test && node ./dist/test-runner/run-tests.js assistant-owner-alias-question`
Expected: `AssertionError [ERR_ASSERTION]: 'needs_confirmation' !== 'promoted'`.

- [x] **Step 3: Skip pronouns inside the matcher**

Replace `isNearOwnerAlias` in `src/assistant/domain/owner-identity.ts`:

```ts
/**
 * Whether `name` looks like a corrupted spelling of one of the owner's names. Callers must first
 * establish that `name` matches no existing alias exactly: a name the graph already knows is
 * answered, not a question. Pronoun aliases are resolution shortcuts, not names, so they are
 * never a similarity target.
 */
export function isNearOwnerAlias(name: string, ownerAliases: readonly string[]): boolean {
  if (name.length < NEAR_OWNER_ALIAS_MIN_LENGTH) return false;
  return ownerAliases.some((alias) => alias.length >= NEAR_OWNER_ALIAS_MIN_LENGTH
    && alias !== name
    && !OWNER_PRONOUN_ALIASES.some((pronoun) => pronoun === alias)
    && editDistanceWithin(name, alias, NEAR_OWNER_ALIAS_MAX_DISTANCE));
}
```

- [x] **Step 4: Run the suite to verify it passes**

Run: `node ./dist/test-runner/run-tests.js assistant-owner-alias-question`
Expected: all pass; `a near-miss person name parks the candidate instead of creating a node` still
holds because `denyz` is measured against `denys`, not a pronoun.

---

### Task 3: Merge actor type derived from `ActorType` and written to the log

**Files:**
- Modify: `src/assistant/graph/merge-service.ts:3` (import), `:41` (type), `:169` (log entry)
- Test: `tests/assistant-merge.test.ts`

- [x] **Step 1: Write the failing test**

Append to `tests/assistant-merge.test.ts`:

```ts
test('the mutation log records who asked for the merge', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const target = makeSoftware(h, context, 'software:vscode', 'Visual Studio Code');
    const source = makeSoftware(h, context, null, 'VSCode');

    const outcome = h.merges.merge({
      ownerId: context.ownerId, sourceNodeId: source, targetNodeId: target,
      actorType: 'assistant_proposal', basis: 'alias match', reason: 'merge',
    });

    assert.equal(outcome.kind, 'merged');
    const entry = h.audit.listMutations(context.ownerId, 'graph_nodes', source)
      .find((row) => row.operation === 'merge_node');
    assert.equal(entry?.actor_type, 'assistant_proposal');
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npm run build:test && node ./dist/test-runner/run-tests.js assistant-merge`
Expected: `AssertionError [ERR_ASSERTION]: 'user' !== 'assistant_proposal'`.

- [x] **Step 3: Derive the type and pass the actor through**

In `src/assistant/graph/merge-service.ts` change the enums import to:

```ts
import { isExplicitBasis, type ActorType } from '../domain/enums.js';
```

Replace the type at line 41:

```ts
export type MergeActorType = Extract<ActorType, 'user' | 'assistant_proposal'>;
```

Replace the merge log entry at line 169:

```ts
      this.audit.recordMutation({
        ownerId: request.ownerId, actorType: request.actorType, actorRef: request.ownerId,
        operation: 'merge_node', targetType: 'graph_nodes', targetId: request.sourceNodeId,
        before: payload, after: { mergeId: mergeRow.id, targetNodeId: request.targetNodeId },
        reason: request.reason,
      });
```

The unmerge entry at line 222 stays `'user'`: `UnmergeRequest` has no actor and only the owner
reverses a merge.

- [x] **Step 4: Run the suite to verify it passes**

Run: `npm run typecheck` then `node ./dist/test-runner/run-tests.js assistant-merge`
Expected: clean; all pass.

---

### Task 4: `finish` takes the real transaction scope

**Files:**
- Modify: `src/assistant/ingestion/candidate-promoter.ts:1-10` (imports) and `:142`

Type-only change; `npm run typecheck` is the test.

- [x] **Step 1: Import the class type and use it**

Add to the imports in `src/assistant/ingestion/candidate-promoter.ts`:

```ts
import type { AssistantTransactionScope } from '../transactions/assistant-transaction-manager.js';
```

Replace the parameter at line 142:

```ts
    transaction: AssistantTransactionScope,
```

- [x] **Step 2: Verify**

Run: `npm run typecheck`
Expected: clean. `AssistantTransactionScope` is already exported from the manager module.

Run: `npm run build:test && node ./dist/test-runner/run-tests.js assistant-candidate-promoter`
Expected: all pass, including `a rejected candidate leaves no new nodes behind`.

---

### Task 5: Edit distance without index fallbacks

**Files:**
- Modify: `src/assistant/domain/owner-identity.ts:24-41`
- Create: `tests/assistant-owner-identity-matcher.test.ts`

The `?? 0` and `?? max + 1` fallbacks launder `undefined` index reads into wrong distances.
Characterize first, then rewrite so no cell is read by index.

- [x] **Step 1: Write the characterization test**

Create `tests/assistant-owner-identity-matcher.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { editDistanceWithin, isNearOwnerAlias } from '../src/assistant/domain/owner-identity.js';

test('editDistanceWithin matches the Levenshtein bound', () => {
  assert.equal(editDistanceWithin('denyz', 'denys', 2), true);
  assert.equal(editDistanceWithin('demyus', 'denys', 2), true);
  assert.equal(editDistanceWithin('dmitry', 'denys', 2), false);
  assert.equal(editDistanceWithin('kitten', 'sitting', 3), true);
  assert.equal(editDistanceWithin('kitten', 'sitting', 2), false);
  assert.equal(editDistanceWithin('', 'ab', 2), true);
  assert.equal(editDistanceWithin('abc', '', 2), false);
  assert.equal(editDistanceWithin('same', 'same', 0), true);
});

test('isNearOwnerAlias ignores short names, exact matches, and pronouns', () => {
  const aliases = ['the user', 'user', 'me', 'i', 'myself', 'denys'];
  assert.equal(isNearOwnerAlias('deny', aliases), true);
  assert.equal(isNearOwnerAlias('den', aliases), false);
  assert.equal(isNearOwnerAlias('denys', aliases), false);
  assert.equal(isNearOwnerAlias('ester', aliases), false);
  assert.equal(isNearOwnerAlias('alice', aliases), false);
});
```

- [x] **Step 2: Run it to verify it passes on the current code**

Run: `npm run build:test && node ./dist/test-runner/run-tests.js assistant-owner-identity-matcher`
Expected: both pass (the `ester` case passes because Task 2 landed). This pins behaviour before
the rewrite.

- [x] **Step 3: Rewrite without indexed reads**

Replace `editDistanceWithin` in `src/assistant/domain/owner-identity.ts`:

```ts
/**
 * Levenshtein distance, stopping once it provably exceeds `max`. Two rolling rows; each cell is
 * derived from the values carried through the loop, so no cell is ever read by index.
 */
export function editDistanceWithin(left: string, right: string, max: number): boolean {
  if (Math.abs(left.length - right.length) > max) return false;
  const rightChars = Array.from(right);
  let previous = Array.from({ length: rightChars.length + 1 }, (_unused, index) => index);
  let lastCell = rightChars.length;
  for (const [rowIndex, leftChar] of Array.from(left).entries()) {
    const current = [rowIndex + 1];
    let diagonal = rowIndex;
    let insertion = rowIndex + 1;
    let best = insertion;
    for (const [columnIndex, above] of previous.slice(1).entries()) {
      const substitution = diagonal + (leftChar === rightChars[columnIndex] ? 0 : 1);
      const distance = Math.min(substitution, above + 1, insertion + 1);
      current.push(distance);
      diagonal = above;
      insertion = distance;
      best = Math.min(best, distance);
    }
    if (best > max) return false;
    previous = current;
    lastCell = insertion;
  }
  return lastCell <= max;
}
```

`diagonal` is the previous row's cell one column back, `above` the previous row's cell in this
column, `insertion` this row's cell one column back. `rightChars[columnIndex]` is only compared
with `===`, which accepts `string | undefined` without a fallback.

- [x] **Step 4: Run the suites to verify they still pass**

Run: `npm run typecheck`, then `node ./dist/test-runner/run-tests.js assistant-owner-identity-matcher`
and `node ./dist/test-runner/run-tests.js assistant-owner-alias-question`
Expected: clean; all pass.

---

### Task 6: `EvidenceStore.setSensitivity`

**Files:**
- Modify: `src/assistant/storage/evidence-store.ts:206`
- Modify: `src/assistant/control/graph-cleanup-service.ts:109`

Same operation as `AssertionStore.setSensitivity`, so the same name. Behaviour is unchanged and
already covered by `reclassification is previewed but only runs when it is explicitly requested`.

- [x] **Step 1: Rename**

In `src/assistant/storage/evidence-store.ts` replace the method header and comment:

```ts
  /** Rewrites one record's classification. The audited cleanup path is its only caller. */
  setSensitivity(evidenceId: string, sensitivity: Sensitivity): EvidenceRow {
```

In `src/assistant/control/graph-cleanup-service.ts:109`:

```ts
          this.graph.evidence.setSensitivity(evidenceId, 'personal');
```

- [x] **Step 2: Verify**

Run: `grep -rn "\.reclassify(" src tests` — Expected: no hits.
Run: `npm run typecheck && npm run build:test && node ./dist/test-runner/run-tests.js assistant-graph-cleanup`
Expected: clean; all pass.

---

### Task 7: Node status enum shared through contracts

**Files:**
- Modify: `packages/contracts/src/assistant.ts:5-8` (next to `SensitivitySchema`) and `:95`
- Modify: `src/assistant/domain/enums.ts:63-65`
- Test: `tests/assistant-contracts.test.ts`

- [x] **Step 1: Write the failing test**

Append to `tests/assistant-contracts.test.ts`:

```ts
test('node detail rejects a status the graph cannot hold', () => {
  const parsed = AssistantNodeDetailSchema.safeParse({
    id: 'node_1', type: 'person', displayName: 'User', sensitivity: 'personal',
    canonicalKey: null, description: null, properties: {}, aliases: [],
    isOwner: false, status: 'bogus',
  });
  assert.equal(parsed.success, false);
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npm run build:test && node ./dist/test-runner/run-tests.js assistant-contracts`
Expected: `AssertionError [ERR_ASSERTION]: true !== false`.

- [x] **Step 3: Define the enum once in contracts**

In `packages/contracts/src/assistant.ts`, after `SensitivitySchema`:

```ts
export const NODE_STATUSES = ['active', 'merged', 'archived', 'deleted'] as const;
export const NodeStatusSchema = z.enum(NODE_STATUSES);
export type NodeStatus = z.infer<typeof NodeStatusSchema>;
```

Replace line 95 in `AssistantNodeDetailSchema`:

```ts
  status: NodeStatusSchema,
```

In `src/assistant/domain/enums.ts` replace lines 63-65:

```ts
export { NODE_STATUSES, NodeStatusSchema, type NodeStatus } from '@siftkit/contracts';
```

`src/assistant/storage/background-work-decision-store.ts` already imports from
`@siftkit/contracts`, so the storage layer depending on contracts is established.

- [x] **Step 4: Verify**

Run: `npm run typecheck`, then `node ./dist/test-runner/run-tests.js assistant-contracts` and
`node ./dist/test-runner/run-tests.js assistant-routes`
Expected: clean; all pass. `MemoryQueryService.nodeDetail` passes `row.status`, which is already
the enum, so no change there.

---

### Task 8: One source for pending capture states

**Files:**
- Modify: `packages/contracts/src/assistant-desktop.ts:158-159`
- Modify: `src/assistant/assistant-service.ts:19` (import) and `:159` (delete the local constant)
- Test: `tests/assistant-contracts.test.ts`

- [x] **Step 1: Write the failing test**

Append to `tests/assistant-contracts.test.ts` (add `PENDING_CAPTURE_STATES` and
`PENDING_CAPTURE_LIST_STATES` to the `@siftkit/contracts` import):

```ts
test('the pending view lists exactly the drain states plus the in-flight one', () => {
  assert.deepEqual([...PENDING_CAPTURE_LIST_STATES], [...PENDING_CAPTURE_STATES, 'processing']);
});
```

- [x] **Step 2: Run to verify it fails**

Run: `npm run typecheck:test`
Expected: `error TS2305: Module '"@siftkit/contracts"' has no exported member 'PENDING_CAPTURE_STATES'`.

- [x] **Step 3: Derive the list from the drain set**

Replace lines 158-159 of `packages/contracts/src/assistant-desktop.ts`:

```ts
/** Queue states still owed an extraction; the drain enqueues exactly these. */
export const PENDING_CAPTURE_STATES = ['queued', 'awaiting_image_capability'] as const;

/** The pending view adds `processing`: a worker holds it, but the owner is still waiting. */
export const PENDING_CAPTURE_LIST_STATES = [...PENDING_CAPTURE_STATES, 'processing'] as const;
```

In `src/assistant/assistant-service.ts` change line 19 to:

```ts
import { PENDING_CAPTURE_LIST_STATES, PENDING_CAPTURE_STATES } from '@siftkit/contracts';
```

and delete the local `const PENDING_CAPTURE_STATES = [...]` at line 159. The usages at
`:421`, `:845`, `:853` stay unchanged.

- [x] **Step 4: Verify**

Run: `npm run typecheck`, then `node ./dist/test-runner/run-tests.js assistant-contracts` and
`node ./dist/test-runner/run-tests.js assistant-service`
Expected: clean; all pass.

---

### Task 9: Structured candidate hold

**Files:**
- Create: `src/assistant/ingestion/candidate-hold.ts`
- Modify: `src/assistant/storage/schema.ts:173` (base schema column)
- Modify: `src/state/runtime-db.ts:33` (`CURRENT_SCHEMA_VERSION`)
- Modify: `src/state/migrations/registry.ts` (append v61)
- Modify: `src/assistant/storage/rows.ts:233` (`CandidateRowSchema`)
- Modify: `src/assistant/storage/candidate-store.ts:130-140`, `:178-186`
- Modify: `src/assistant/ingestion/candidate-promoter.ts:12-18`, `:64-80`
- Modify: `src/assistant/control/validation-queue-service.ts:1-16`, `:46-64`, `:76-83`
- Modify: `packages/contracts/src/assistant.ts:186-200`
- Modify: `dashboard/src/tabs/settings/AssistantSettings.tsx:511-515`
- Test: `tests/assistant-owner-alias-question.test.ts`, `tests/assistant-capture-intake.test.ts`,
  `tests/assistant-contracts.test.ts`, `dashboard/tests/assistant-settings.test.tsx`

The hold is currently `possible_owner_alias:<name>` in `rejection_reason`, parsed with
`startsWith`/`slice`, with the sentinel repeated as a raw string in the dashboard. It becomes a
parsed `hold_json` column and a discriminated union in the contract. `rejection_reason` goes back
to holding only validator rejection codes.

- [x] **Step 1: Write the failing tests**

In `tests/assistant-owner-alias-question.test.ts` replace the assertions in
`the validation queue reports why a candidate is held`:

```ts
    assert.equal(item?.status, 'needs_confirmation');
    assert.deepEqual(item?.hold, { kind: 'possible_owner_alias', name: 'denyz' });
```

and in `a near-miss person name parks the candidate instead of creating a node` add after the
`outcome.kind` assertion:

```ts
    assert.deepEqual(
      outcome.kind === 'needs_confirmation' ? outcome.hold : null,
      { kind: 'possible_owner_alias', name: 'denyz' },
    );
    assert.equal(context.graph.candidates.requireCandidate(candidateId).rejection_reason, null);
```

In `tests/assistant-capture-intake.test.ts`, in
`a screenshot statement containing secret material is still held back`, replace
`assert.equal(promotion.kind, 'needs_confirmation');` with:

```ts
    assert.equal(promotion.kind === 'needs_confirmation' ? promotion.hold.kind : null, 'topic');
```

In `tests/assistant-contracts.test.ts` replace the validation candidate fixture's last line:

```ts
      hold: { kind: 'possible_owner_alias', name: 'denyz' },
```

In `dashboard/tests/assistant-settings.test.tsx` replace the three fixture fields:
line 42 and line 322 `confirmationReason: null, identityName: null,` → `hold: null,`;
line 288 → `hold: { kind: 'possible_owner_alias', name: 'denyz' },`.

- [x] **Step 2: Run to verify they fail**

Run: `npm run typecheck:test`
Expected: `error TS2339: Property 'hold' does not exist on type ...` in the alias-question and
capture-intake tests, and `Object literal may only specify known properties` for the fixtures.

- [x] **Step 3: Define the hold**

Create `src/assistant/ingestion/candidate-hold.ts`:

```ts
import { z } from '../../lib/zod.js';
import { SENSITIVE_TOPICS } from '../domain/secrets.js';

/** Why a candidate is parked in `needs_confirmation`, and what answering it needs. */
export const CandidateHoldSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('topic'), topic: z.enum(SENSITIVE_TOPICS) }).strict(),
  z.object({ kind: z.literal('possible_owner_alias'), name: z.string().min(1) }).strict(),
]);
export type CandidateHold = z.infer<typeof CandidateHoldSchema>;
```

- [x] **Step 4: Add the column, base schema and migration**

In `src/assistant/storage/schema.ts` after line 173 (`rejection_reason TEXT,`):

```sql
    hold_json TEXT,
```

In `src/state/runtime-db.ts:33`:

```ts
export const CURRENT_SCHEMA_VERSION = 61;
```

Append to `MIGRATIONS` in `src/state/migrations/registry.ts`:

```ts
  {
    version: 61,
    up: (database) => {
      if (!tableExists(database, 'candidate_assertions')) {
        throw new Error('Migration v61 requires candidate_assertions.');
      }
      if (!tableHasColumn(database, 'candidate_assertions', 'hold_json')) {
        database.exec('ALTER TABLE candidate_assertions ADD COLUMN hold_json TEXT;');
      }
      // Holds used to be encoded in `rejection_reason`: a topic name, or
      // `possible_owner_alias:<name>` (21 characters before the name).
      database.exec(`
        UPDATE candidate_assertions
        SET hold_json = CASE
          WHEN rejection_reason LIKE 'possible_owner_alias:%'
            THEN json_object('kind', 'possible_owner_alias', 'name', substr(rejection_reason, 22))
          ELSE json_object('kind', 'topic', 'topic', rejection_reason)
        END,
        rejection_reason = NULL
        WHERE status = 'needs_confirmation' AND rejection_reason IS NOT NULL AND hold_json IS NULL;
      `);
    },
  },
```

The live database had zero `needs_confirmation` rows on 2026-09-03, so the backfill is for
restored backups.

- [x] **Step 5: Row schema and store**

In `src/assistant/storage/rows.ts` after `rejection_reason: z.string().nullable(),`:

```ts
  hold_json: z.string().nullable(),
```

In `src/assistant/storage/candidate-store.ts` add the import:

```ts
import { CandidateHoldSchema, type CandidateHold } from '../ingestion/candidate-hold.js';
```

Replace `needsConfirmation` (line 134-136):

```ts
  needsConfirmation(candidateId: string, hold: CandidateHold): CandidateRow {
    this.database.prepare(`
      UPDATE candidate_assertions
      SET status = 'needs_confirmation', hold_json = ?, rejection_reason = NULL, updated_at_utc = ?
      WHERE id = ?
    `).run(JSON.stringify(hold), this.clock.nowUtc(), candidateId);
    return this.requireCandidate(candidateId);
  }

  /** The question a held candidate is waiting on; `null` for any other status. */
  readHold(row: CandidateRow): CandidateHold | null {
    return row.hold_json === null ? null : parseJsonText(row.hold_json, CandidateHoldSchema);
  }
```

Replace the `UPDATE` in `setStatus` (line 183-186) so every other status clears the hold:

```ts
    this.database.prepare(`
      UPDATE candidate_assertions
      SET status = ?, rejection_reason = ?, hold_json = NULL, updated_at_utc = ?
      WHERE id = ?
    `).run(status, rejectionReason, this.clock.nowUtc(), candidateId);
```

- [x] **Step 6: Promoter writes a hold, not a string**

In `src/assistant/ingestion/candidate-promoter.ts` replace the import of `owner-identity.js`
and the sentinel constant (lines 4 and 12-13) with:

```ts
import { isNearOwnerAlias, OWNER_PRONOUN_ALIASES } from '../domain/owner-identity.js';
import type { CandidateHold } from './candidate-hold.js';
```

Replace the `needs_confirmation` variant of `PromotionOutcome`:

```ts
  | { readonly kind: 'needs_confirmation'; readonly hold: CandidateHold }
```

Replace the gate branch (lines 64-67):

```ts
    if (gateOutcome.kind === 'needs_confirmation') {
      const hold = { kind: 'topic', topic: gateOutcome.topic } as const;
      this.graph.candidates.needsConfirmation(candidate.id, hold);
      return { kind: 'needs_confirmation', hold };
    }
```

Replace the near-miss branch (lines 76-81):

```ts
    if (nearMiss !== null) {
      const hold = { kind: 'possible_owner_alias', name: nearMiss } as const;
      this.graph.candidates.needsConfirmation(candidate.id, hold);
      return { kind: 'needs_confirmation', hold };
    }
```

- [x] **Step 7: Contract and validation service**

In `packages/contracts/src/assistant.ts` before `AssistantValidationCandidateDtoSchema`:

```ts
/** Why a candidate waits in `needs_confirmation`. The dashboard renders one card per kind. */
export const AssistantCandidateHoldSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('topic'), topic: z.string() }).strict(),
  z.object({ kind: z.literal('possible_owner_alias'), name: z.string() }).strict(),
]);
export type AssistantCandidateHold = z.infer<typeof AssistantCandidateHoldSchema>;
```

In `AssistantValidationCandidateDtoSchema` replace the two fields `confirmationReason` and
`identityName` with:

```ts
  hold: AssistantCandidateHoldSchema.nullable(),
```

In `src/assistant/control/validation-queue-service.ts` delete `identityNameOf` and the
`OWNER_ALIAS_CONFIRMATION_REASON` import. In `list()` replace the `confirmationReason` and
`identityName` lines with:

```ts
        hold: this.graph.candidates.readHold(row),
```

In `resolveIdentity` replace the `identityNameOf` block:

```ts
    const hold = this.graph.candidates.readHold(candidate);
    if (hold === null || hold.kind !== 'possible_owner_alias') {
      throw new AssistantConflictError(
        `Candidate ${candidateId} is not held on an identity question.`,
      );
    }
    const identityName = hold.name;
```

- [x] **Step 8: Dashboard reads the union**

In `dashboard/src/tabs/settings/AssistantSettings.tsx` replace lines 511-512 with:

```tsx
              {candidate.hold?.kind === 'possible_owner_alias' ? (
```

and inside the block replace `candidate.identityName` with `candidate.hold.name`.

- [x] **Step 9: Verify**

Run: `grep -rn "possible_owner_alias" src dashboard/src packages/contracts/src`
Expected: hits only in `candidate-hold.ts`, `candidate-promoter.ts`, `validation-queue-service.ts`,
`packages/contracts/src/assistant.ts`, and the one `hold?.kind` comparison in the dashboard.

Run: `grep -rn "identityNameOf\|OWNER_ALIAS_CONFIRMATION_REASON\|identityName\|confirmationReason" src dashboard/src packages/contracts/src`
Expected: no hits.

Run: `npm run typecheck`, `npm run build:test`, then
`assistant-owner-alias-question`, `assistant-capture-intake`, `assistant-candidate-promoter`,
`assistant-contracts`, `assistant-routes`, and `node ./dist/test-runner/run-tests.js --dashboard`.
Expected: clean; all pass except the pre-existing `chat-live-messages` case.

---

### Task 10: Resolve-identity returns its outcome

**Files:**
- Modify: `packages/contracts/src/assistant.ts` (after `AssistantResolveIdentityRequestSchema`)
- Modify: `src/status-server/routes/assistant/policy-routes.ts:44-48`
- Modify: `dashboard/src/api.ts:120-130`
- Modify: `dashboard/src/tabs/settings/AssistantSettings.tsx:420-431`
- Test: `tests/assistant-contracts.test.ts`, `dashboard/tests/assistant-settings.test.tsx`

- [x] **Step 1: Write the failing tests**

Add to the contracts round-trip list in `tests/assistant-contracts.test.ts` (import the schema):

```ts
    [AssistantResolveIdentityResponseSchema, { ok: true, graphVersion: 3, outcome: 'rejected' }],
```

Append to `dashboard/tests/assistant-settings.test.tsx`, copying the fetch stub shape of
`an identity hold offers both answers and posts the chosen one` with these differences: the
`/resolve-identity` branch returns `json({ ok: true, graphVersion: 2, outcome: 'rejected' })`,
and `/assistant/validation` returns the same held item on every call:

```ts
test('an identity answer that does not promote keeps the card and says why', { concurrency: false }, async () => {
  const held = {
    id: 'candidate-4', status: 'needs_confirmation', proposedStatement: 'denyz USES Tauri',
    rationale: 'A screenshot showed denyz in Tauri', confidence: 0.7, sensitivity: 'personal',
    evidenceId: 'evidence-4', userNotes: '', createdAtUtc: '2026-08-10T10:00:00.000Z',
    hold: { kind: 'possible_owner_alias', name: 'denyz' },
  };
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (input: string) => {
      if (input === '/assistant/auth/bootstrap') return json({ token: 'session-secret' });
      if (input === '/assistant/desktop/state') return json(desktopStateBody(true, 0));
      if (input === '/assistant/validation') return json({ items: [held] });
      if (input === '/assistant/history') return json({ items: [] });
      if (input === '/assistant/background-decisions') return json({ items: [] });
      if (input === '/assistant/captures/pending') return json({ captures: [] });
      if (input.endsWith('/resolve-identity')) return json({ ok: true, graphVersion: 2, outcome: 'rejected' });
      throw new Error(`Unexpected request: ${input}`);
    },
  });

  render(<AssistantSettings assistant={DEFAULT_ASSISTANT_CONFIG} onChange={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Pending validation' }));
  await screen.findByText(/is close to one of your own names/u);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'No, someone else' }));
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  });

  screen.getByText('denyz USES Tauri');
  screen.getByText(/could not be written/u);
});
```

- [x] **Step 2: Run to verify they fail**

Run: `npm run typecheck:test`
Expected: `error TS2305: ... has no exported member 'AssistantResolveIdentityResponseSchema'`.

Run: `npm run build:test && node ./dist/test-runner/run-tests.js --dashboard`
Expected: the new dashboard test fails at `screen.getByText('denyz USES Tauri')` because the card
was removed optimistically.

- [x] **Step 3: Contract, route, api, and handler**

In `packages/contracts/src/assistant.ts` after `AssistantResolveIdentityRequestSchema`:

```ts
export const AssistantResolveIdentityResponseSchema = z.object({
  ok: z.literal(true),
  graphVersion: z.number().int().min(0),
  /** What the answer did to the candidate. Anything but `promoted` leaves it in the queue. */
  outcome: z.enum(['promoted', 'needs_confirmation', 'rejected']),
}).strict();
export type AssistantResolveIdentityResponse =
  z.infer<typeof AssistantResolveIdentityResponseSchema>;
```

Replace `resolveIdentityEndpoint` in `src/status-server/routes/assistant/policy-routes.ts`:

```ts
/** Answers an open "is this name you?" hold and reports what the re-promotion did. */
export const resolveIdentityEndpoint = assistantRoute(async ({ service, req, res, match }) => {
  const request = await body(req, AssistantResolveIdentityRequestSchema);
  const outcome = service.validation.resolveIdentity(id(match), request.isOwner);
  sendJson(res, 200, { ...success(service), outcome: outcome.kind });
});
```

Replace `resolveAssistantCandidateIdentity` in `dashboard/src/api.ts` (import the new schema and
type from `@siftkit/contracts`):

```ts
/** Answers an open "is this name you?" hold on a candidate and reports what it did. */
export async function resolveAssistantCandidateIdentity(
  token: string,
  candidateId: string,
  isOwner: boolean,
): Promise<AssistantResolveIdentityResponse> {
  return fetchJson(
    `/assistant/validation/${encodeURIComponent(candidateId)}/resolve-identity`,
    AssistantResolveIdentityResponseSchema,
    { method: 'POST', headers: assistantHeaders(token), body: JSON.stringify({ isOwner }) },
  );
}
```

Replace `resolveIdentity` in `dashboard/src/tabs/settings/AssistantSettings.tsx`:

```ts
  /**
   * Answers the identity hold. Only a promotion removes the card: a rejection or a second hold
   * leaves the candidate in the queue, so the list is reloaded and the reason shown.
   */
  async function resolveIdentity(
    candidate: AssistantValidationCandidateDto, isOwner: boolean,
  ): Promise<void> {
    if (token === null) return;
    try {
      const result = await resolveAssistantCandidateIdentity(token, candidate.id, isOwner);
      if (result.outcome === 'promoted') {
        setValidation((items) => items.filter((item) => item.id !== candidate.id));
        return;
      }
      setValidation(await getAssistantValidation(token));
      setError(result.outcome === 'rejected'
        ? `“${candidate.proposedStatement}” could not be written and stays in the queue.`
        : `“${candidate.proposedStatement}” raised another question and stays in the queue.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }
```

`getAssistantValidation` returns the item array (`dashboard/src/api.ts:89-95`).

- [x] **Step 4: Verify**

Run: `npm run typecheck`, `npm run build:test`, then `assistant-contracts`, `assistant-routes`,
and `node ./dist/test-runner/run-tests.js --dashboard`.
Expected: clean; all pass except the pre-existing `chat-live-messages` case.

---

### Task 11: A "no" answer is recorded explicitly, in one transaction

**Files:**
- Modify: `src/assistant/control/validation-queue-service.ts` (`resolveIdentity`)
- Modify: `src/assistant/control/graph-cleanup-service.ts` (`orphanPersonNodeIds` query)
- Test: `tests/assistant-owner-alias-question.test.ts`, `tests/assistant-graph-cleanup.test.ts`

Today "no" is remembered only by a node the resolver created as a side effect. If the
re-promotion is rejected, that node has no assertions, the cleanup deletes it, and the question
returns. The answer becomes a `user_supplied` alias plus a logged `create_node`, the orphan rule
keeps user-named nodes, and the whole answer runs in one transaction.

- [x] **Step 1: Write the failing tests**

Append to `tests/assistant-owner-alias-question.test.ts`:

```ts
/** A candidate the validator will refuse: `USES` does not accept a `project` object. */
function proposeInvalidPersonUses(
  context: AssistantTestContext, subjectName: string, sourceEventId: string,
): string {
  const { graph, ownerId } = context;
  const evidence = graph.evidence.recordTextEvidence({
    ownerId, deviceId: null, sourceType: 'screenshot', parentEvidenceId: null,
    sourceEventId, sourceRef: 'app:code', sourceTimezone: null,
    capturedAtUtc: OBSERVED_AT, sensitivity: 'personal',
    retentionUntilUtc: null, metadata: {}, text: `${subjectName} uses Some Project.`,
  });
  const observation = graph.observations.record({
    ownerId, evidenceId: evidence.id, observationType: 'screenshot_extraction',
    payload: {}, confidence: 0.7, sensitivity: 'personal',
    extractorName: 'image_extraction', extractorVersion: '1',
  });
  const candidate = graph.candidates.propose({
    ownerId, observationId: observation.id,
    subject: { nodeType: 'person', displayName: subjectName },
    predicate: 'USES',
    object: { kind: 'unresolved', nodeType: 'project', displayName: 'Some Project' },
    scope: null, basis: 'passive_observation', confidence: 0.7, sensitivity: 'personal',
    validFromUtc: null, validToUtc: null, rationale: 'object type the validator refuses',
  });
  if (candidate === null) throw new Error('Candidate proposal was deduplicated unexpectedly.');
  return candidate.id;
}

test('a no answer is remembered even when the promotion is then refused', () => {
  withAssistantContext((context) => {
    const ownerNodeId = seedOwner(context);
    const promoter = buildPromoter(context.graph);
    const firstId = proposeInvalidPersonUses(context, 'denyz', 'cap:12');
    promoter.promote({ ownerId: context.ownerId, candidateId: firstId });

    const outcome = buildQueue(context, promoter).resolveIdentity(firstId, false);

    assert.equal(outcome.kind, 'rejected');
    const [named] = context.graph.nodes.findByAlias(context.ownerId, 'denyz', 'person');
    assert.ok(named !== undefined, 'the person the owner named still exists');
    assert.ok(
      context.graph.nodes.listAliases(named.id)
        .some((row) => row.alias_type === 'user_supplied'),
      'the alias records that the owner supplied it',
    );
    const created = context.graph.audit.listMutations(context.ownerId, 'graph_nodes', named.id)
      .find((row) => row.operation === 'create_node');
    assert.equal(created?.actor_type, 'user');

    const secondId = proposePersonUses(context, 'denyz', 'cap:13');
    const second = promoter.promote({ ownerId: context.ownerId, candidateId: secondId });
    assert.equal(second.kind, 'promoted');
    const assertionId = second.kind === 'promoted' ? second.assertionId : '';
    assert.equal(
      context.graph.assertions.requireAssertion(assertionId).subject_node_id, named.id,
    );
    assert.notEqual(named.id, ownerNodeId);
  });
});
```

Append to `tests/assistant-graph-cleanup.test.ts`:

```ts
test('a person node the owner named by hand is kept even without facts', () => {
  withAssistantContext((context) => {
    const { cleanup } = buildCleanup(context);
    const named = context.graph.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: null, displayName: 'denyz',
      description: null, sensitivity: 'personal', properties: {},
    });
    context.graph.nodes.addAlias({
      ownerId: context.ownerId, nodeId: named.id, alias: 'denyz',
      aliasType: 'user_supplied', sourceEvidenceId: null,
    });

    assert.deepEqual(cleanup.preview(context.ownerId).orphanNodeIds, []);
    cleanup.run(context.ownerId, { reclassifyScreenshots: false });

    assert.equal(context.graph.nodes.requireNode(named.id).status, 'active');
  });
});
```

(Task 16 later changes `cleanup.run` to take a preview token; adjust this test then.)

- [x] **Step 2: Run to verify they fail**

Run: `npm run build:test && node ./dist/test-runner/run-tests.js assistant-owner-alias-question`
Expected: `the alias records that the owner supplied it` fails: the resolver wrote a `name` alias.

Run: `node ./dist/test-runner/run-tests.js assistant-graph-cleanup`
Expected: `AssertionError: [ 'node_...' ] deepEqual []` for the orphan preview.

- [x] **Step 3: Record the answer and wrap the whole thing**

Replace `resolveIdentity` in `src/assistant/control/validation-queue-service.ts` from the
`if (isOwner)` block to the end of the method:

```ts
    const transaction = this.graph.transactions.begin();
    try {
      if (isOwner) {
        const owner = this.graph.nodes.findByCanonicalKey(
          this.ownerId, 'person', OWNER_PERSON_CANONICAL_KEY,
        );
        if (owner === null) {
          throw new AssistantNotFoundError('The assistant has no owner person node.');
        }
        this.graph.nodes.addAlias({
          ownerId: this.ownerId, nodeId: owner.id, alias: identityName,
          aliasType: 'user_supplied', sourceEvidenceId: null,
        });
      } else {
        this.recordSeparatePerson(identityName);
      }

      this.graph.candidates.returnToPending(candidateId);
      const outcome = this.promoter.promote({ ownerId: this.ownerId, candidateId });
      // The runner recompiles after every extraction it promotes; a user's answer promotes too.
      if (outcome.kind === 'promoted') {
        this.graph.enqueueProjectionMaintenance(this.ownerId, this.projectionPriority);
      }
      transaction.commit();
      return outcome;
    } catch (error) {
      return transaction.rollbackAfter(error);
    }
  }

  /**
   * The owner said this name is someone else. The node carries a `user_supplied` alias so the
   * answer survives even if no fact ever lands on it: the orphan cleanup keeps user-named nodes.
   */
  private recordSeparatePerson(name: string): void {
    const node = this.graph.nodes.createNode({
      ownerId: this.ownerId, type: 'person', canonicalKey: null, displayName: name,
      description: null, sensitivity: 'personal', properties: {},
    });
    this.graph.nodes.addAlias({
      ownerId: this.ownerId, nodeId: node.id, alias: name,
      aliasType: 'user_supplied', sourceEvidenceId: null,
    });
    this.graph.audit.recordMutation({
      ownerId: this.ownerId, actorType: 'user', actorRef: this.ownerId,
      operation: 'create_node', targetType: 'graph_nodes', targetId: node.id,
      before: null, after: { type: 'person', displayName: name },
      reason: 'the owner said this name is not them',
    });
    this.graph.audit.incrementGraphVersion();
  }
```

The promoter's own transaction becomes a savepoint inside this one, so a validator rejection
rolls back only the promotion while the answer commits.

In `src/assistant/control/graph-cleanup-service.ts` add one predicate to `orphanPersonNodeIds`
after the `merged_into_node_id` clause:

```sql
        AND NOT EXISTS (
          SELECT 1 FROM graph_node_aliases al
          WHERE al.node_id = n.id AND al.alias_type = 'user_supplied'
        )
```

and extend the method's comment: "A node the owner named by hand (a `user_supplied` alias) is
an answer, not an orphan."

- [x] **Step 4: Verify**

Run: `npm run typecheck`, then `assistant-owner-alias-question`, `assistant-graph-cleanup`,
`assistant-owner-identity`.
Expected: clean; all pass, including `answering no promotes onto a separate node and is not asked again`.

---

### Task 12: Stranded recovery from parsed payloads

**Files:**
- Modify: `src/assistant/storage/job-store.ts` (new method after `listByStatus`)
- Modify: `src/assistant/images/capture-queue-store.ts:21-28`, `:101-117`
- Modify: `src/assistant/assistant-service.ts:828`
- Modify: `src/assistant/control/graph-cleanup-service.ts:67`, `:103`
- Test: `tests/assistant-capture-recovery.test.ts`, `tests/assistant-graph-cleanup.test.ts`

The SQL re-states the job payload shape (`json_extract(payload_json, '$.evidenceId')`) that
`readImageExtractionPayload` already validates, and `NOT IN` over a subquery returns nothing if
any live payload lacks the key. Live evidence ids are parsed with the schema in the job store and
bound as one JSON array.

- [x] **Step 1: Write the failing tests**

In `tests/assistant-capture-recovery.test.ts` change every `queue.recoverStrandedProcessing(ownerId)`
to:

```ts
    queue.recoverStrandedProcessing(ownerId, graph.jobs.listLiveImageExtractionEvidenceIds(ownerId))
```

(keep `const recovered = ...` where present), then append:

```ts
/** A malformed live payload used to make `NOT IN` compare against NULL and silently recover
 * nothing. Parsing with the schema fails loudly instead. */
test('a live job with an unreadable payload fails loudly instead of disabling recovery', () => {
  withAssistantContext(({ graph, ownerId }) => {
    graph.jobs.enqueue({
      ownerId, jobType: 'image_extraction', payload: {}, idempotencyKey: 'image_extraction:broken',
    }, 350);

    assert.throws(() => graph.jobs.listLiveImageExtractionEvidenceIds(ownerId));
  });
});
```

- [x] **Step 2: Run to verify they fail**

Run: `npm run typecheck:test`
Expected: `error TS2339: Property 'listLiveImageExtractionEvidenceIds' does not exist on type 'JobStore'`.

- [x] **Step 3: Parse in the job store, bind in the queue store**

In `src/assistant/storage/job-store.ts` import `LIVE_JOB_STATUSES` from `../domain/enums.js` and
add after `listByStatus`:

```ts
  /** Evidence ids with an extraction still queued, running, or paused. Payloads are parsed. */
  listLiveImageExtractionEvidenceIds(ownerId: string): string[] {
    return LIVE_JOB_STATUSES.flatMap((status) => this.listByStatus(ownerId, status))
      .filter((job) => job.job_type === 'image_extraction')
      .map((job) => this.readImageExtractionPayload(job).evidenceId);
  }
```

In `src/assistant/images/capture-queue-store.ts` replace the predicate constant:

```ts
/** `processing` with no live extraction job: the worker that held it is gone. Binds a JSON array. */
const STRANDED_PROCESSING_PREDICATE = `
  state = 'processing' AND evidence_id NOT IN (SELECT value FROM json_each(?))
`;
```

and the two methods:

```ts
  recoverStrandedProcessing(ownerId: string, liveEvidenceIds: readonly string[]): number {
    return this.database.prepare(`
      UPDATE assistant_capture_queue SET state = 'queued', updated_at_utc = ?
      WHERE owner_id = ? AND ${STRANDED_PROCESSING_PREDICATE}
    `).run(this.clock.nowUtc(), ownerId, JSON.stringify(liveEvidenceIds)).changes;
  }

  /** The same rows `recoverStrandedProcessing` would reset, for a caller that must inspect first. */
  listStrandedProcessing(ownerId: string, liveEvidenceIds: readonly string[]): CaptureQueueRow[] {
    return z.array(CaptureQueueRowSchema).parse(this.database.prepare(`
      SELECT * FROM assistant_capture_queue
      WHERE owner_id = ? AND ${STRANDED_PROCESSING_PREDICATE}
      ORDER BY enqueued_at_utc ASC, evidence_id ASC
    `).all(ownerId, JSON.stringify(liveEvidenceIds)));
  }
```

An empty array yields an empty `json_each`, so `NOT IN` is true for every row.

In `src/assistant/assistant-service.ts:828`:

```ts
    this.captureQueue.recoverStrandedProcessing(
      this.ownerId, this.graph.jobs.listLiveImageExtractionEvidenceIds(this.ownerId),
    );
```

In `src/assistant/control/graph-cleanup-service.ts` replace line 67 and line 103:

```ts
    const live = this.graph.jobs.listLiveImageExtractionEvidenceIds(ownerId);
    const stranded = this.queue.listStrandedProcessing(ownerId, live);
```

```ts
      const capturesRequeued = this.queue.recoverStrandedProcessing(
        ownerId, this.graph.jobs.listLiveImageExtractionEvidenceIds(ownerId),
      );
```

- [x] **Step 4: Verify**

Run: `grep -rn "json_extract" src/assistant` — Expected: no hits.
Run: `npm run typecheck`, then `assistant-capture-recovery`, `assistant-graph-cleanup`,
`assistant-service`.
Expected: clean; all pass.

---

### Task 13: Drop the dead-letter marker step

**Files:**
- Modify: `src/assistant/control/graph-cleanup-service.ts:9-10`, `:18`, `:27`, `:73`, `:104`, `:117`, `:152-157`
- Modify: `src/assistant/storage/job-store.ts:184-197` (delete `deleteTerminal`)
- Test: `tests/assistant-graph-cleanup.test.ts`

Since Task 4 of the pipeline plan, the extractor never throws for a deleted blob, so no new
dead letters with that message can appear. The live database held zero on 2026-09-03 (verified
read-only). The substring match on an error message and the hard delete it drives go away.

- [x] **Step 1: Precondition**

Run against the live database, read-only:

```
node -e "const D=require('better-sqlite3');const db=new D('.siftkit/runtime.sqlite',{readonly:true});console.log(db.prepare(\"SELECT COUNT(*) n FROM assistant_jobs WHERE status='dead_letter' AND job_type='image_extraction' AND last_error LIKE '%has been deleted.%'\").get());db.close()"
```

Expected: `{ n: 0 }`. If not zero, stop and report; do not proceed.

- [x] **Step 2: Remove the tests for the step**

In `tests/assistant-graph-cleanup.test.ts` delete: the `BLOB_DELETED_ERROR` constant, the
`deadLetter` helper, the tests `a dead-lettered deleted-blob job is cleared` and
`a dead-lettered job that failed for another reason is left alone`, and `jobsCleared: 0,` from
the expected object in `running the cleanup twice changes nothing the second time`.

- [x] **Step 3: Run to verify the remaining test fails**

Run: `npm run build:test && node ./dist/test-runner/run-tests.js assistant-graph-cleanup`
Expected: `running the cleanup twice changes nothing the second time` fails because the actual
result still carries `jobsCleared: 0` and the expected object no longer does.

- [x] **Step 4: Remove the step**

In `src/assistant/control/graph-cleanup-service.ts`: delete the `BLOB_DELETED_MARKER` constant
and its comment; delete `deletedBlobJobIds` from `GraphCleanupPlan` and its comment; delete
`jobsCleared` from `GraphCleanupResult`; delete `deletedBlobJobIds: this.deletedBlobJobIds(ownerId),`
from `preview`; delete the line `const jobsCleared = this.graph.jobs.deleteTerminal(plan.deletedBlobJobIds);`
and `jobsCleared,` from the result; delete the private `deletedBlobJobIds` method.

In `src/assistant/storage/job-store.ts` delete `deleteTerminal` (lines 184-197).

- [x] **Step 5: Verify**

Run: `grep -rn "deleteTerminal\|BLOB_DELETED_MARKER\|deletedBlobJobIds\|jobsCleared" src tests docs`
Expected: hits only in `docs/plan-assistant-pipeline-defects.md` history text.

Run: `npm run typecheck`, then `assistant-graph-cleanup` and `assistant-job-store`.
Expected: clean; all pass.

---

### Task 14: One discard path for deleted blobs

**Files:**
- Modify: `src/assistant/images/image-extractor.ts:76-92`
- Modify: `src/assistant/control/graph-cleanup-service.ts:42-64`, `:92-102`
- Modify: `src/assistant/assistant-service.ts:252-258`, `:351-356`
- Test: `tests/assistant-graph-cleanup.test.ts`

- [x] **Step 1: Write the failing test**

In `tests/assistant-graph-cleanup.test.ts` change `buildCleanup` to construct an extractor
(imports: `ImageExtractor` from `../src/assistant/images/image-extractor.js`,
`StructuredOutputRunner` from `../src/assistant/inference/structured-runner.js`,
`UnavailableImageCapabilityProvider` from `../src/assistant/images/image-capability.js`,
`FakeAssistantInference` from `./helpers/assistant-inference-fake.js`):

```ts
function buildCleanup(context: AssistantTestContext): {
  cleanup: GraphCleanupService; queue: CaptureQueueStore;
} {
  const queue = new CaptureQueueStore(context.database, context.clock);
  const extractor = new ImageExtractor({
    graph: context.graph, queue,
    runner: new StructuredOutputRunner(new FakeAssistantInference([])),
    capability: new UnavailableImageCapabilityProvider(),
  });
  return {
    cleanup: new GraphCleanupService({
      graph: context.graph, database: context.database, queue, extractor, projectionPriority: 400,
    }),
    queue,
  };
}
```

Extend `a stranded capture whose blob is gone is discarded, not queued`:

```ts
    const audited = context.graph.audit.listAuditEvents(context.ownerId, 50)
      .filter((event) => event.event_type === 'extraction_rejected');
    assert.equal(audited.length, 1);
    assert.equal(audited[0]?.details_json.includes('blob_deleted'), true);
```

- [x] **Step 2: Run to verify it fails**

Run: `npm run typecheck:test`
Expected: `Object literal may only specify known properties, and 'extractor' does not exist in type 'GraphCleanupServiceOptions'`.

- [x] **Step 3: One method on the extractor**

In `src/assistant/images/image-extractor.ts` add after `run`:

```ts
  /**
   * Retires a capture whose pixels retention already removed. Terminal, not a failure: the blob
   * cannot come back, so the capture is marked processed and the cause is audited.
   */
  discardDeletedBlob(ownerId: string, evidenceId: string): void {
    this.graph.audit.recordAuditEvent({
      ownerId,
      eventType: 'extraction_rejected',
      targetType: 'evidence',
      targetId: evidenceId,
      summary: 'Screenshot pixels were deleted before extraction ran.',
      details: { code: 'blob_deleted' },
    });
    this.queue.markProcessed(evidenceId);
  }
```

and replace the body of the `hasReadableBlob` branch in `run` (lines 81-92) with:

```ts
    if (!this.graph.evidence.hasReadableBlob(evidence)) {
      this.discardDeletedBlob(ownerId, evidenceId);
      return { kind: 'rejected' };
    }
```

In `src/assistant/control/graph-cleanup-service.ts` add `readonly extractor: ImageExtractor;` to
`GraphCleanupServiceOptions` (import the type from `../images/image-extractor.js`), store it as
`private readonly extractor: ImageExtractor;` in the constructor, and replace the discard loop
(lines 92-102) with:

```ts
      for (const evidenceId of plan.discardableCaptureIds) {
        this.extractor.discardDeletedBlob(ownerId, evidenceId);
      }
```

In `src/assistant/assistant-service.ts`: delete the `this.graphCleanup = new GraphCleanupService({...})`
block at lines 252-258; before `this.runner = new AssistantJobRunner({` hoist the extractor:

```ts
    const images = new ImageExtractor({
      graph: this.graph,
      queue: this.captureQueue,
      runner: structuredOutput,
      capability: this.imageCapability,
    });
```

pass `images,` in the runner options instead of the inline `new ImageExtractor({...})`, and after
the runner construction add:

```ts
    this.graphCleanup = new GraphCleanupService({
      graph: this.graph,
      database: options.database,
      queue: this.captureQueue,
      extractor: images,
      projectionPriority: options.config.Background.JobPriorities.ProjectionMaintenance,
    });
```

- [x] **Step 4: Verify**

Run: `grep -rn "code: 'blob_deleted'" src` — Expected: exactly one hit, in `image-extractor.ts`.
Run: `npm run typecheck`, then `assistant-graph-cleanup`, `assistant-image-extraction`,
`assistant-service`.
Expected: clean; all pass.

---

### Task 15: Cleanup writes are audited

**Files:**
- Modify: `src/assistant/control/graph-cleanup-service.ts` (`run`)
- Test: `tests/assistant-graph-cleanup.test.ts`

Every graph write goes through the mutation log with a before/after snapshot, the way the merge
and mutation services do. Evidence is not a graph row; its reclassification is an audit event,
matching how capture expiry is recorded.

- [x] **Step 1: Write the failing test**

Append to `tests/assistant-graph-cleanup.test.ts`:

```ts
test('the cleanup records every change it makes', () => {
  withAssistantContext((context) => {
    const { cleanup } = buildCleanup(context);
    const { graph, ownerId } = context;
    const orphan = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: null, displayName: 'Windows',
      description: null, sensitivity: 'personal', properties: {},
    });
    const evidenceId = screenshotEvidence(context, 'cap_audit');
    const owner = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: OWNER_PERSON_CANONICAL_KEY, displayName: 'the user',
      description: null, sensitivity: 'personal', properties: {},
    });
    const software = graph.nodes.createNode({
      ownerId, type: 'software', canonicalKey: null, displayName: 'PowerShell',
      description: null, sensitivity: 'personal', properties: {},
    });
    const assertion = graph.assertions.createAssertion({
      ownerId, subjectNodeId: owner.id, predicate: 'USES',
      object: { kind: 'node', nodeId: software.id }, scopeNodeId: null, status: 'active',
      basis: 'passive_observation', confidence: 0.7, sensitivity: 'sensitive',
      validFromUtc: null, validToUtc: null, observedAtUtc: CAPTURED_AT,
      supersedesAssertionId: null, pinned: false, attributes: {},
      searchText: { subject: 'the user', predicate: 'USES', object: 'PowerShell', scope: '' },
    });
    graph.assertions.linkEvidence(assertion.id, evidenceId, 'supports', 0.7);
    const versionBefore = graph.graphVersion;

    cleanup.run(ownerId, { reclassifyScreenshots: true });

    const nodeLog = graph.audit.listMutations(ownerId, 'graph_nodes', orphan.id)
      .find((row) => row.operation === 'update_node');
    assert.equal(nodeLog?.after_json?.includes('"deleted"'), true);
    const assertionLog = graph.audit.listMutations(ownerId, 'graph_assertions', assertion.id)
      .find((row) => row.operation === 'update_assertion');
    assert.equal(assertionLog?.before_json?.includes('"sensitive"'), true);
    assert.equal(assertionLog?.after_json?.includes('"personal"'), true);
    const evidenceEvents = graph.audit.listAuditEvents(ownerId, 50)
      .filter((event) => event.event_type === 'evidence_reclassified');
    assert.equal(evidenceEvents.length, 1);
    assert.ok(graph.graphVersion > versionBefore);
  });
});
```

(Task 16 later changes `cleanup.run` to take a preview token; adjust this test then.)

- [x] **Step 2: Run to verify it fails**

Run: `npm run build:test && node ./dist/test-runner/run-tests.js assistant-graph-cleanup`
Expected: `AssertionError [ERR_ASSERTION]: undefined !== true` at the node log check.

- [x] **Step 3: Log each write**

Replace the three write loops in `run` of `src/assistant/control/graph-cleanup-service.ts`:

```ts
      for (const nodeId of plan.orphanNodeIds) {
        const before = this.graph.nodes.requireNode(nodeId);
        this.graph.nodes.setNodeStatus(nodeId, 'deleted');
        this.graph.audit.recordMutation({
          ownerId, actorType: 'user', actorRef: ownerId,
          operation: 'update_node', targetType: 'graph_nodes', targetId: nodeId,
          before: { status: before.status }, after: { status: 'deleted' },
          reason: 'cleanup: no assertion references this person node',
        });
      }
```

```ts
      if (reclassify) {
        for (const evidenceId of plan.reclassifiableEvidenceIds) {
          const before = this.graph.evidence.requireEvidence(evidenceId);
          this.graph.evidence.setSensitivity(evidenceId, 'personal');
          this.graph.audit.recordAuditEvent({
            ownerId, eventType: 'evidence_reclassified', targetType: 'evidence',
            targetId: evidenceId,
            summary: 'Screenshot evidence reclassified to match the intake rule.',
            details: { before: before.sensitivity, after: 'personal' },
          });
        }
        for (const assertionId of plan.reclassifiableAssertionIds) {
          const before = this.graph.assertions.requireAssertion(assertionId);
          this.graph.assertions.setSensitivity(assertionId, 'personal');
          this.graph.audit.recordMutation({
            ownerId, actorType: 'user', actorRef: ownerId,
            operation: 'update_assertion', targetType: 'graph_assertions', targetId: assertionId,
            before: { sensitivity: before.sensitivity }, after: { sensitivity: 'personal' },
            reason: 'cleanup: screenshot-derived fact reclassified with its evidence',
          });
        }
      }
```

and, inside the existing `if (Object.values(result).some((count) => count > 0))` block, before
`enqueueProjectionMaintenance`:

```ts
        this.graph.audit.incrementGraphVersion();
```

- [x] **Step 4: Verify**

Run: `npm run typecheck`, then `assistant-graph-cleanup`.
Expected: clean; all pass, including the idempotency test (a second run logs nothing because it
changes nothing).

---

### Task 16: Cleanup preview/execute routes

**Files:**
- Modify: `src/assistant/control/deletion-preview.ts` (payload union + two methods)
- Modify: `packages/contracts/src/assistant.ts` (three schemas after `AssistantFactoryResetPreviewSchema`)
- Modify: `src/assistant/control/graph-cleanup-service.ts` (`preview`, `run`, options)
- Modify: `src/assistant/assistant-service.ts` (`previewGraphCleanup`, `cleanUpGraph`, construction)
- Modify: `src/status-server/routes/assistant/admin-routes.ts` (two endpoints)
- Modify: `src/status-server/routes/assistant.ts` (route table)
- Test: `tests/assistant-graph-cleanup.test.ts`, `tests/assistant-routes.test.ts`, `tests/assistant-contracts.test.ts`

Factory reset is the pattern: a signed preview token that goes stale when the graph version or
the counts change, then a confirm call carrying it.

- [x] **Step 1: Write the failing tests**

In `tests/assistant-graph-cleanup.test.ts` change `buildCleanup` to pass
`previews: new DeletionPreviewService(context.graph, context.database)` (import from
`../src/assistant/control/deletion-preview.js`), and change every `cleanup.run(context.ownerId, opts)`
to `cleanup.run(context.ownerId, cleanup.preview(context.ownerId).previewToken, opts)`. Then append:

```ts
test('a cleanup with a stale preview token is refused', () => {
  withAssistantContext((context) => {
    const { cleanup } = buildCleanup(context);
    const token = cleanup.preview(context.ownerId).previewToken;
    context.graph.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: null, displayName: 'Discord',
      description: null, sensitivity: 'personal', properties: {},
    });

    assert.throws(
      () => cleanup.run(context.ownerId, token, { reclassifyScreenshots: false }),
      /stale/u,
    );
  });
});
```

In `tests/assistant-routes.test.ts`, next to the claim-owner assertions in the bootstrap test:

```ts
    const cleanupPreview = await requestJson(`${baseUrl}/assistant/cleanup/preview`, { headers });
    assert.equal(cleanupPreview.statusCode, 200);
    assert.equal(typeof cleanupPreview.body.previewToken, 'string');
    assert.equal((await requestJson(`${baseUrl}/assistant/cleanup`, {
      method: 'POST', headers,
      body: JSON.stringify({ previewToken: 'not-a-token', reclassifyScreenshots: false }),
    })).statusCode, 409);
    assert.equal((await requestJson(`${baseUrl}/assistant/cleanup/preview`)).statusCode, 401);
```

and in the disabled-assistant section:

```ts
    assert.equal((await requestJson(`${baseUrl}/assistant/cleanup/preview`, { headers })).statusCode, 409);
```

In `tests/assistant-contracts.test.ts` add to the round-trip list:

```ts
    [AssistantGraphCleanupPreviewSchema, {
      previewToken: 'signed', graphVersion: 4, orphanNodeIds: ['node_9'],
      resumableCaptureIds: [], discardableCaptureIds: ['ev_2'],
      reclassifiableEvidenceCount: 3, reclassifiableAssertionCount: 1,
    }],
    [AssistantGraphCleanupRequestSchema, { previewToken: 'signed', reclassifyScreenshots: true }],
    [AssistantGraphCleanupResultSchema, {
      ok: true, graphVersion: 5, nodesDeleted: 1, capturesRequeued: 0, capturesDiscarded: 1,
      evidenceReclassified: 3, assertionsReclassified: 1,
    }],
```

- [x] **Step 2: Run to verify they fail**

Run: `npm run typecheck:test`
Expected: missing exports for the three contract schemas and
`Property 'previewToken' does not exist on type 'GraphCleanupPlan'`.

- [x] **Step 3: Contracts**

In `packages/contracts/src/assistant.ts` after `AssistantFactoryResetPreviewSchema`:

```ts
/** What the one-shot cleanup would touch. The token goes stale if any of it changes. */
export const AssistantGraphCleanupPreviewSchema = z.object({
  previewToken: z.string(),
  graphVersion: z.number().int().min(0),
  orphanNodeIds: z.array(z.string()),
  resumableCaptureIds: z.array(z.string()),
  discardableCaptureIds: z.array(z.string()),
  reclassifiableEvidenceCount: z.number().int().min(0),
  reclassifiableAssertionCount: z.number().int().min(0),
}).strict();
export type AssistantGraphCleanupPreview = z.infer<typeof AssistantGraphCleanupPreviewSchema>;

export const AssistantGraphCleanupRequestSchema = z.object({
  previewToken: z.string().min(1),
  /** Rewrites rows the owner already has, so it is opt-in. */
  reclassifyScreenshots: z.boolean(),
}).strict();
export type AssistantGraphCleanupRequest = z.infer<typeof AssistantGraphCleanupRequestSchema>;

export const AssistantGraphCleanupResultSchema = z.object({
  ok: z.literal(true),
  graphVersion: z.number().int().min(0),
  nodesDeleted: z.number().int().min(0),
  capturesRequeued: z.number().int().min(0),
  capturesDiscarded: z.number().int().min(0),
  evidenceReclassified: z.number().int().min(0),
  assertionsReclassified: z.number().int().min(0),
}).strict();
export type AssistantGraphCleanupResult = z.infer<typeof AssistantGraphCleanupResultSchema>;
```

- [x] **Step 4: Preview token**

In `src/assistant/control/deletion-preview.ts` add a payload schema next to the factory-reset one
and include it in `PreviewPayloadSchema`'s union:

```ts
const GraphCleanupCountsSchema = z.object({
  orphanNodes: z.number().int().min(0),
  resumableCaptures: z.number().int().min(0),
  discardableCaptures: z.number().int().min(0),
  reclassifiableEvidence: z.number().int().min(0),
  reclassifiableAssertions: z.number().int().min(0),
}).strict();
export type GraphCleanupCounts = z.infer<typeof GraphCleanupCountsSchema>;

const GraphCleanupPayloadSchema = z.object({
  ownerId: z.string(),
  operation: z.literal('graph_cleanup'),
  graphVersion: z.number().int().min(0),
  counts: GraphCleanupCountsSchema,
});
```

and two methods after `validateFactoryReset`:

```ts
  /** Counts come from `GraphCleanupService`; the token records what the owner was shown. */
  previewGraphCleanup(ownerId: string, counts: GraphCleanupCounts): string {
    return this.sign(this.buildGraphCleanupPayload(ownerId, counts));
  }

  validateGraphCleanup(ownerId: string, previewToken: string, counts: GraphCleanupCounts): void {
    const payload = this.verify(previewToken);
    if (payload.operation !== 'graph_cleanup' || payload.ownerId !== ownerId) {
      throw new AssistantConflictError('Deletion preview token does not authorize a cleanup.');
    }
    this.assertCurrent(payload, this.buildGraphCleanupPayload(ownerId, counts));
  }

  private buildGraphCleanupPayload(ownerId: string, counts: GraphCleanupCounts): PreviewPayload {
    return { ownerId, operation: 'graph_cleanup', graphVersion: this.graph.graphVersion, counts };
  }
```

- [x] **Step 5: Service returns the contract shape and validates on run**

In `src/assistant/control/graph-cleanup-service.ts`: add `readonly previews: DeletionPreviewService;`
to the options and a private field; rename the current `preview` to
`private plan(ownerId: string): GraphCleanupPlan`; drop the `export` from `GraphCleanupPlan` and
`GraphCleanupResult` (the contract types replace them outside this file); add:

```ts
  preview(ownerId: string): AssistantGraphCleanupPreview {
    const plan = this.plan(ownerId);
    return {
      previewToken: this.previews.previewGraphCleanup(ownerId, countsOf(plan)),
      graphVersion: this.graph.graphVersion,
      orphanNodeIds: [...plan.orphanNodeIds],
      resumableCaptureIds: [...plan.resumableCaptureIds],
      discardableCaptureIds: [...plan.discardableCaptureIds],
      reclassifiableEvidenceCount: plan.reclassifiableEvidenceIds.length,
      reclassifiableAssertionCount: plan.reclassifiableAssertionIds.length,
    };
  }

  run(ownerId: string, previewToken: string, options: GraphCleanupOptions): GraphCleanupResult {
    const plan = this.plan(ownerId);
    this.previews.validateGraphCleanup(ownerId, previewToken, countsOf(plan));
    const transaction = this.graph.transactions.begin();
    // ... unchanged body
  }
```

with a module-level helper:

```ts
function countsOf(plan: GraphCleanupPlan): GraphCleanupCounts {
  return {
    orphanNodes: plan.orphanNodeIds.length,
    resumableCaptures: plan.resumableCaptureIds.length,
    discardableCaptures: plan.discardableCaptureIds.length,
    reclassifiableEvidence: plan.reclassifiableEvidenceIds.length,
    reclassifiableAssertions: plan.reclassifiableAssertionIds.length,
  };
}
```

In `src/assistant/assistant-service.ts` pass `previews: deletionPreviews` when constructing the
cleanup (it is now built after `deletionPreviews` exists; move the block below it if needed) and
replace the two methods:

```ts
  /** What the one-shot repair would touch, with a token that expires when that changes. */
  previewGraphCleanup(): AssistantGraphCleanupPreview {
    return this.graphCleanup.preview(this.ownerId);
  }

  /** Removes the state the pipeline defects produced. Idempotent; refuses a stale preview. */
  async cleanUpGraph(
    previewToken: string, options: GraphCleanupOptions,
  ): Promise<AssistantGraphCleanupResult> {
    const ownerId = this.ownerId;
    const result = await this.runMaintenance(
      async () => this.graphCleanup.run(ownerId, previewToken, options),
    );
    return { ok: true, graphVersion: this.graph.graphVersion, ...result };
  }
```

- [x] **Step 6: Routes**

In `src/status-server/routes/assistant/admin-routes.ts` (import
`AssistantGraphCleanupRequestSchema` from `@siftkit/contracts`):

```ts
export const graphCleanupPreviewEndpoint = assistantRoute(({ service, res }) => {
  sendJson(res, 200, service.previewGraphCleanup());
});

export const graphCleanupEndpoint = assistantRoute(async ({ service, req, res }) => {
  const request = await body(req, AssistantGraphCleanupRequestSchema);
  // `cleanUpGraph` serializes itself against drains; do not wrap it again here.
  sendJson(res, 200, await service.cleanUpGraph(
    request.previewToken, { reclassifyScreenshots: request.reclassifyScreenshots },
  ));
});
```

In `src/status-server/routes/assistant.ts` import both and add next to the factory-reset rows:

```ts
  { method: 'GET', path: '/assistant/cleanup/preview', endpoint: graphCleanupPreviewEndpoint },
  { method: 'POST', path: '/assistant/cleanup', endpoint: graphCleanupEndpoint },
```

- [x] **Step 7: Verify**

Run: `npm run typecheck`, then `assistant-graph-cleanup`, `assistant-routes`,
`assistant-contracts`, `assistant-service`.
Expected: clean; all pass.

---

### Task 17: Claim relies on the merge's guards

**Files:**
- Modify: `src/assistant/assistant-service.ts:702-750` (`claimNodeAsOwner`)
- Test: `tests/assistant-owner-identity.test.ts`

`same_node`, `node_not_active`, and `type_mismatch` are already blocked by `checkMergeSafety`.
Only the "is this the owner" precheck carries information the merge does not have. `movedAliases`
moves inside `runMaintenance` so it is read under the same pause as the merge.

- [x] **Step 1: Confirm the existing tests pin the messages**

`claiming a node that is not a person is refused` expects `/person/iu`; the merge's message is
`Cannot merge a software into a person.` `claiming the owner node itself is refused` expects
`/already the owner/iu`, which stays a service precheck. No new test is needed; the existing ones
are the guard.

- [x] **Step 2: Trim the prechecks**

Replace the method body from `if (node.type !== 'person')` through the `movedAliases` line:

```ts
    return this.runMaintenance(async () => {
      const movedAliases = this.graph.nodes.listAliases(nodeId).map((row) => row.alias);
      const outcome = this.graph.merges.merge({
```

i.e. delete the `node.type !== 'person'` and `node.status !== 'active'` throws, and move
`const movedAliases = ...` to the first line of the maintenance callback. Everything from
`if (outcome.kind === 'blocked')` onward is unchanged.

- [x] **Step 3: Verify**

Run: `npm run typecheck`, then `assistant-owner-identity` and `assistant-routes`.
Expected: clean; all pass. A second claim of an already-merged node now surfaces the merge's
`Both nodes must be active.` as the 409 message.

---

### Task 18: Display-name alias reconciliation

**Files:**
- Modify: `src/assistant/storage/identity-store.ts` (new `setOwnerDisplayName`)
- Modify: `src/assistant/storage/node-store.ts` (new `removeAlias`, after `addAlias`)
- Modify: `src/assistant/assistant-service.ts:905-919` (`seedOwnerAliases`)
- Test: `tests/assistant-service.test.ts`

The comment says aliases are reconciled on every refresh, but seeding is additive: a renamed
`Owner.DisplayName` leaves the old name resolving to the owner forever. The owner row's
`display_name` becomes the record of the last configured name, so a rename can retire exactly the
alias it seeded and nothing learned from data.

- [x] **Step 1: Write the failing test**

Append to `tests/assistant-service.test.ts`:

```ts
test('renaming the owner retires the previous configured alias but keeps learned ones', () => {
  try {
    const service = buildService({ ownerDisplayName: 'Denys' });
    const ownerNodeId = service.ownerPersonNodeId;
    if (ownerNodeId === null) throw new Error('Enabled service did not create its owner node.');
    service.graph.nodes.addAlias({
      ownerId: service.ownerId, nodeId: ownerNodeId, alias: 'derys',
      aliasType: 'name', sourceEvidenceId: null,
    });

    service.refreshConfig({
      ...DEFAULT_ASSISTANT_CONFIG,
      Enabled: true,
      Owner: { ...DEFAULT_ASSISTANT_CONFIG.Owner, DisplayName: 'Dennis' },
    });

    const aliases = service.graph.nodes.listAliases(ownerNodeId).map((row) => row.normalized_alias);
    assert.ok(aliases.includes('dennis'));
    assert.ok(!aliases.includes('denys'), `stale configured alias survived: ${aliases.join(', ')}`);
    assert.ok(aliases.includes('derys'), 'a name learned from data is not a config alias');
    assert.ok(aliases.includes('the user'));
    assert.equal(service.graph.identity.getOwner().display_name, 'Dennis');
  } finally {
    closeRuntimeDatabase();
  }
});
```

- [x] **Step 2: Run to verify it fails**

Run: `npm run build:test && node ./dist/test-runner/run-tests.js assistant-service`
Expected: `stale configured alias survived: ...denys...`.

- [x] **Step 3: Store methods**

In `src/assistant/storage/identity-store.ts` add:

```ts
  /** Records the configured display name so a later rename knows which alias it seeded. */
  setOwnerDisplayName(displayName: string, nowUtc: string): void {
    this.database
      .prepare('UPDATE assistant_owners SET display_name = ?, updated_at_utc = ? WHERE id = ?')
      .run(displayName, nowUtc, LOCAL_OWNER_ID);
  }
```

In `src/assistant/storage/node-store.ts` after `addAlias`:

```ts
  /** Removes one alias of one type; other types with the same text (a learned name) survive. */
  removeAlias(nodeId: string, alias: string, aliasType: AliasType): number {
    const changes = this.database.prepare(`
      DELETE FROM graph_node_aliases WHERE node_id = ? AND normalized_alias = ? AND alias_type = ?
    `).run(nodeId, normalizeAliasText(alias), aliasType).changes;
    if (changes > 0) this.refreshFts(nodeId);
    return changes;
  }
```

(`AliasType` is the enum already used by `AddAliasInput`.)

- [x] **Step 4: Reconcile in the service**

Replace `seedOwnerAliases` in `src/assistant/assistant-service.ts` (import `normalizeAliasText`
from `./domain/keys.js`):

```ts
  /**
   * Reconciled on every bootstrap and config refresh. The owner row's `display_name` is the last
   * configured name; when config moves on, the alias that name seeded is retired. Aliases of
   * other types with the same text were learned from data and stay.
   */
  private seedOwnerAliases(nodeId: string): void {
    const ownerId = this.graph.ownerId;
    const configured = this.currentConfig.Owner.DisplayName.trim();
    const previous = this.graph.identity.getOwner().display_name.trim();
    if (previous !== configured) {
      const previousIsPronoun = OWNER_PRONOUN_ALIASES
        .some((pronoun) => pronoun === normalizeAliasText(previous));
      if (previous !== '' && !previousIsPronoun) {
        this.graph.nodes.removeAlias(nodeId, previous, 'user_supplied');
      }
      this.graph.identity.setOwnerDisplayName(configured, this.graph.nowUtc());
    }
    const aliases = configured === ''
      ? [...OWNER_PRONOUN_ALIASES]
      : [...OWNER_PRONOUN_ALIASES, configured];
    for (const alias of aliases) {
      this.graph.nodes.addAlias({
        ownerId, nodeId, alias, aliasType: 'user_supplied', sourceEvidenceId: null,
      });
    }
  }
```

- [x] **Step 5: Verify**

Run: `npm run typecheck`, then `assistant-service`, `assistant-owner-identity`,
`assistant-owner-alias-question`.
Expected: clean; all pass, including `an owner node created before the display name was set picks the alias up on refresh`.

---

### Task 19: Shared test fixtures

**Files:**
- Modify: `tests/helpers/assistant-fixture.ts`
- Modify: `tests/assistant-service.test.ts`, `tests/assistant-owner-identity.test.ts`,
  `tests/assistant-owner-alias-question.test.ts`, `tests/assistant-candidate-promoter.test.ts`

The session added a ninth `buildService` copy and wrote the evidence→observation→candidate seed
three ways. Two helpers replace the session's copies; the six older `buildService` copies are
pre-existing and out of scope.

- [x] **Step 1: Add the helpers**

Append to `tests/helpers/assistant-fixture.ts` (imports: `AssistantService`, `FixedClock`,
`SequentialIdGenerator`, `EstimateTokenCounter`, `DEFAULT_ASSISTANT_CONFIG`, `getRuntimeDatabase`,
`FakeAssistantInference`, `ALWAYS_IDLE`, `ALWAYS_RESIDENT`, `createManagedTempDir`, and the
`AssistantInferenceClient` type, all from the paths the two test files use today):

```ts
export interface BuildAssistantServiceOptions {
  readonly enabled?: boolean;
  readonly inference?: AssistantInferenceClient;
  readonly privateMode?: boolean;
  readonly ownerDisplayName?: string;
}

/** A service on a fresh temp database at the fixture instant. Callers close the database. */
export function buildAssistantService(options: BuildAssistantServiceOptions = {}): AssistantService {
  const runtimeRoot = createManagedTempDir('siftkit-assistant-service-');
  const config = {
    ...DEFAULT_ASSISTANT_CONFIG,
    Enabled: options.enabled ?? true,
    Owner: {
      ...DEFAULT_ASSISTANT_CONFIG.Owner,
      DisplayName: options.ownerDisplayName ?? DEFAULT_ASSISTANT_CONFIG.Owner.DisplayName,
    },
    PrivateMode: { ...DEFAULT_ASSISTANT_CONFIG.PrivateMode, Active: options.privateMode ?? false },
  };
  return AssistantService.create({
    database: getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite')),
    runtimeRoot,
    clock: new FixedClock(FIXTURE_START_INSTANT),
    ids: new SequentialIdGenerator(),
    configWriter: new MemoryAssistantConfigWriter(config),
    inference: options.inference ?? new FakeAssistantInference([]),
    tokens: new EstimateTokenCounter(4),
    idleGate: ALWAYS_IDLE,
    residencyGate: ALWAYS_RESIDENT,
    config,
  });
}

export interface ProposePersonUsesInput {
  readonly subjectName: string;
  readonly objectName: string;
  readonly sourceEventId: string;
  readonly sourceType: 'screenshot' | 'conversation_message';
  readonly basis: 'passive_observation' | 'explicit_user_statement';
  readonly confidence: number;
}

/** Evidence → observation → `USES` candidate for one person subject. Returns the candidate id. */
export function proposePersonUses(
  context: Pick<AssistantTestContext, 'graph' | 'ownerId'>, input: ProposePersonUsesInput,
): string {
  const { graph, ownerId } = context;
  const evidence = graph.evidence.recordTextEvidence({
    ownerId, deviceId: null, sourceType: input.sourceType, parentEvidenceId: null,
    sourceEventId: input.sourceEventId,
    sourceRef: input.sourceType === 'screenshot' ? 'app:code' : 'chat_1',
    sourceTimezone: null, capturedAtUtc: FIXTURE_START_INSTANT, sensitivity: 'personal',
    retentionUntilUtc: null, metadata: {}, text: `${input.subjectName} uses ${input.objectName}.`,
  });
  const observation = graph.observations.record({
    ownerId, evidenceId: evidence.id, observationType: 'screenshot_extraction',
    payload: {}, confidence: input.confidence, sensitivity: 'personal',
    extractorName: 'image_extraction', extractorVersion: '1',
  });
  const candidate = graph.candidates.propose({
    ownerId, observationId: observation.id,
    subject: { nodeType: 'person', displayName: input.subjectName },
    predicate: 'USES',
    object: { kind: 'unresolved', nodeType: 'software', displayName: input.objectName },
    scope: null, basis: input.basis, confidence: input.confidence, sensitivity: 'personal',
    validFromUtc: null, validToUtc: null,
    rationale: `${input.subjectName} uses ${input.objectName}.`,
  });
  if (candidate === null) throw new Error('Candidate proposal was deduplicated unexpectedly.');
  return candidate.id;
}
```

- [x] **Step 2: Replace the copies**

- `tests/assistant-service.test.ts`: delete `BuildServiceOptions` and `buildService`; import
  `buildAssistantService` and add `const buildService = buildAssistantService;` is **not**
  allowed (no shims) — rename every call to `buildAssistantService(...)`. Drop the now-unused
  imports.
- `tests/assistant-owner-identity.test.ts`: delete `buildService`; every call becomes
  `buildAssistantService({ ownerDisplayName: 'Denys' })`. Replace the inline evidence/observation/
  candidate block in `an identity answer uses the projection priority from the latest config`
  with `const candidateId = proposePersonUses(service, { subjectName: 'denyz', objectName: 'Tauri', sourceEventId: 'cap:priority', sourceType: 'screenshot', basis: 'passive_observation', confidence: 0.7 });`
  (`AssistantService` exposes `graph` and `ownerId`, which is all the helper needs).
- `tests/assistant-owner-alias-question.test.ts`: delete the local `proposePersonUses`; calls
  become `proposePersonUses(context, { subjectName, objectName: 'Tauri', sourceEventId, sourceType: 'screenshot', basis: 'passive_observation', confidence: 0.7 })`.
  Keep `proposeInvalidPersonUses` from Task 11 (it needs a non-software object).
- `tests/assistant-candidate-promoter.test.ts`: delete `proposeUsesPowerShell`; calls become
  `proposePersonUses(context, { subjectName, objectName: 'PowerShell', sourceEventId, sourceType: 'conversation_message', basis: 'explicit_user_statement', confidence: 0.9 })`.

- [x] **Step 3: Verify**

Run: `grep -n "^function buildService\|^function proposeUsesPowerShell\|^function proposePersonUses" tests/assistant-service.test.ts tests/assistant-owner-identity.test.ts tests/assistant-owner-alias-question.test.ts tests/assistant-candidate-promoter.test.ts`
Expected: no hits.

Run: `npm run typecheck`, then `assistant-service`, `assistant-owner-identity`,
`assistant-owner-alias-question`, `assistant-candidate-promoter`.
Expected: clean; the same test counts as before the task, all passing.

---

### Task 20: Status docs match what ran

**Files:**
- Modify: `docs/plan-assistant-pipeline-defects.md:13`
- Modify: `docs/plan-owner-identity-consolidation.md` (status table)

- [x] **Step 1: Correct the cleanup row**

Replace line 13 of `docs/plan-assistant-pipeline-defects.md`:

```
| 7 — one-shot cleanup | done; executed against live data 2026-09-03 16:04 UTC out of band (11 orphan nodes deleted, 83 dead letters cleared, 19 captures requeued, 1499 evidence + 326 assertions reclassified). Preview/execute routes and the mutation log were added by `docs/plan-session-drift-fixes.md` Tasks 15–16. |
```

- [x] **Step 2: Note the follow-up work in the owner plan**

Under the status table in `docs/plan-owner-identity-consolidation.md` add:

```
Follow-ups from the 2026-09-03 drift review (structured holds, owner-direction guard, pronoun
aliases, explicit "no" answers, alias reconciliation) are tracked in
`docs/plan-session-drift-fixes.md`.
```

- [x] **Step 3: Verify**

Run: `grep -n "not yet approved" docs/plan-assistant-pipeline-defects.md`
Expected: no hits.

---

## Verification for the whole plan

```
npm run typecheck
npm run build:test
node ./dist/test-runner/run-tests.js
node ./dist/test-runner/run-tests.js --dashboard
```

Expected: typecheck and lint clean; the node runner reports 0 failures; the dashboard runner
reports only the pre-existing `chat-live-messages` failure (`a live repo-agent turn renders the
thinking stack above the recent-activity ring`), which touches nothing in this plan.

Then, against a **copy** of the live database (SQLite backup API, second server on another port
with `--disable-managed-llama-startup`, as done on 2026-09-03):

1. `GET /assistant/cleanup/preview` returns a token and lists `orphanNodeIds: []`.
2. `POST /assistant/cleanup` with that token returns all-zero counts and a 200.
3. `POST /assistant/graph/nodes/<a remaining misspelling>/claim-owner` returns 200 and the
   mutation log shows `merge_node` with `actor_type = 'user'`.
4. `GET /assistant/validation` items carry `hold: null` or a `{ kind, ... }` object; the two
   removed fields are absent.

Before reporting a task complete, state: which tests you added, the exact reason each failed
before the change, and the final counts from the suites you ran. Then update the status table at
the top of this file.

## Out of scope

- A dashboard control for the cleanup. The routes make it reachable the way factory reset is;
  a settings-page button is a separate UI decision.
- Consolidating the six pre-existing `buildService` copies outside the session's files.
- The other two `status: z.string()` fields in the contracts (assertion and projection DTOs).
  They predate this session; tighten them in their own change.
- Consolidating the eleven live duplicate owner nodes. That is a data operation the owner runs
  through "This is me" after Task 17 lands.

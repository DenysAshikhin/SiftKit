# Owner Claim Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the "This is me" claim report what the merge actually did, and make both owner-identity paths schedule the projection recompile that puts their facts into the memory tiers.

**Architecture:** `NodeMergeService.merge` already builds a reversal payload listing every assertion it moved and every one it retired; it just does not return those counts, so `claimNodeAsOwner` counts the source's live assertions *before* the merge and overstates the result. The projection recompile is enqueued by three verbatim copies of the same eight lines (job runner, memory mutations, graph cleanup); the fix lifts that into one `AssistantGraph` method and calls it from the two new paths as well.

**Tech Stack:** TypeScript, zod contracts in `packages/contracts`, better-sqlite3 through the assistant stores, `node:test` suites run by `node ./dist/test-runner/run-tests.js <suite>`.

## Status (2026-09-03)

| Task | State |
|---|---|
| 1 — merge outcome reports moved and retired counts | done |
| 2 — claim response carries the merge's counts | done |
| 3 — one scheduler for the projection recompile | done |
| 4 — a claim schedules the recompile | done |
| 5 — an identity answer schedules the recompile | done |

## Findings this plan fixes

Both were observed on 2026-09-03 against a copy of the live database (owner node
`node_d91de57ee03d49bcb13db2f019fdc113`, duplicate `demyx` with 11 active facts):

1. **The claim response overstates what moved.** `POST /assistant/graph/nodes/:id/claim-owner`
   returned `movedAssertionCount: 11`. The merge moved 1 assertion and retired 10 as the weaker
   half of a collision with a fact the owner already held; those 10 stay on the merged node as
   `superseded`, which `unmerge` reverses. The count comes from
   `src/assistant/assistant-service.ts:716-718`, which reads `listBySubject(..., LIVE_ASSERTION_STATUSES)`
   before the merge runs. `NodeMergeService.merge` records `payload.movedAssertions` and
   `payload.retiredAssertionIds` (`src/assistant/graph/merge-service.ts:116-146`) but returns only
   `{ kind, mergeId, targetNodeId }`.

2. **Neither new path queues a projection rebuild.** After a claim and after both
   `resolveIdentity` answers, `assistant_jobs` held no `projection_maintenance` row. The compiled
   tier documents are only rebuilt when something enqueues that job; the runner does after every
   extraction (`src/assistant/jobs/job-runner.ts:292-299`), user mutations do
   (`src/assistant/control/memory-mutation-service.ts:299-306`), the cleanup does
   (`src/assistant/control/graph-cleanup-service.ts:125-132`). Facts consolidated by a claim or an
   identity answer stay out of every tier until an unrelated screenshot triggers a rebuild.

## Ground rules

TDD throughout: write the failing test named in each task, watch it fail for the stated reason,
implement the smallest change that passes, then run `npm run typecheck` and the named suites.

Do not commit. Do not create temp files. Do not touch tasks other than the one dispatched.
Work the tasks in order: 2 depends on 1, and 4 and 5 depend on 3.

Suites run as `npm run build:test && node ./dist/test-runner/run-tests.js <suite>` where
`<suite>` is the test file's basename without `.test.ts`, e.g. `assistant-merge`.

---

### Task 1: `NodeMergeService.merge` reports what it moved and retired

**Files:**
- Modify: `src/assistant/graph/merge-service.ts:24-27` (`MergeOutcome`) and `:166-172` (the `merged` return)
- Test: `tests/assistant-merge.test.ts`

The merge loop at `merge-service.ts:116-146` pushes one entry onto `payload.movedAssertions` per
node reference it re-points and one id onto `payload.retiredAssertionIds` per collision loser.
An assertion that references the source in two columns appears twice in `movedAssertions`, so the
moved count is the number of *distinct* assertion ids. A retired assertion may sit on either side:
when the target's copy is weaker it is retired and the source's copy is moved.

- [ ] **Step 1: Write the failing test**

Append to `tests/assistant-merge.test.ts`:

```ts
/**
 * `claimNodeAsOwner` shows these counts to the owner. Counting the source's live assertions
 * before the merge overstated them: a duplicate of a fact the target already holds is retired
 * as the weaker half of a collision, not moved.
 */
test('a merge reports moved and retired assertions separately', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const target = makeSoftware(h, context, 'software:vscode', 'Visual Studio Code');
    const source = makeSoftware(h, context, null, 'VSCode');
    makeUses(h, context, target, 'Visual Studio Code');
    const collidingId = makeUses(h, context, source, 'VSCode');
    const colleague = h.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: null, displayName: 'Alice',
      description: null, sensitivity: 'personal', properties: {},
    });
    const movedId = h.assertions.createAssertion({
      ownerId: context.ownerId, subjectNodeId: colleague.id, predicate: 'USES',
      object: { kind: 'node', nodeId: source }, scopeNodeId: null,
      status: 'active', basis: 'passive_observation', confidence: 0.5, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, observedAtUtc: '2026-08-05T09:00:00.000Z',
      supersedesAssertionId: null, pinned: false, attributes: {},
      searchText: { subject: 'Alice', predicate: 'uses', object: 'VSCode', scope: '' },
    }).id;

    const outcome = h.merges.merge({
      ownerId: context.ownerId, sourceNodeId: source, targetNodeId: target,
      actorType: 'user', basis: 'user confirmed', reason: 'merge',
    });

    assert.equal(outcome.kind, 'merged');
    if (outcome.kind !== 'merged') return;
    assert.equal(outcome.movedAssertionCount, 1);
    assert.equal(outcome.retiredAssertionCount, 1);
    assert.equal(h.assertions.requireAssertion(movedId).object_node_id, target);
    assert.equal(h.assertions.requireAssertion(collidingId).status, 'superseded');
  });
});
```

Why this shape: `collidingId` and the kept assertion share basis, confidence, and the fixture
clock's timestamp, so `weaker()` (`merge-service.ts:332-344`) picks the higher id, which is the
later-created `collidingId`. The colleague's assertion has no counterpart on the target, so it is
re-pointed. One moved, one retired.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run typecheck:test`
Expected: `error TS2339: Property 'movedAssertionCount' does not exist on type '{ readonly kind: "merged"; readonly mergeId: string; readonly targetNodeId: string; }'`

Run: `npm run build:test && node ./dist/test-runner/run-tests.js assistant-merge`
Expected: the new test fails with `AssertionError [ERR_ASSERTION]: undefined !== 1`.

- [ ] **Step 3: Extend the outcome type**

Replace lines 24-27 of `src/assistant/graph/merge-service.ts`:

```ts
export type MergeOutcome =
  | {
    readonly kind: 'merged';
    readonly mergeId: string;
    readonly targetNodeId: string;
    /** Distinct assertions that now reference the target instead of the source. */
    readonly movedAssertionCount: number;
    /** Assertions retired as the weaker half of a collision, on whichever side they sat. */
    readonly retiredAssertionCount: number;
  }
  | { readonly kind: 'blocked'; readonly code: MergeBlockCode; readonly message: string };
```

- [ ] **Step 4: Return the counts from the payload**

Replace the `merged` return near line 168 of `src/assistant/graph/merge-service.ts`:

```ts
      return {
        kind: 'merged',
        mergeId: mergeRow.id,
        targetNodeId: request.targetNodeId,
        movedAssertionCount: new Set(
          payload.movedAssertions.map((moved) => moved.assertionId),
        ).size,
        retiredAssertionCount: payload.retiredAssertionIds.length,
      };
```

- [ ] **Step 5: Run the suite to verify it passes**

Run: `npm run build:test && node ./dist/test-runner/run-tests.js assistant-merge`
Expected: every test in the suite passes, including the three owner-guard tests added on 2026-09-03.

Run: `npm run typecheck`
Expected: clean. If `src/assistant/assistant-service.ts` reports a missing property, stop: nothing
else constructs a `merged` outcome, so that would mean the type edit was applied to the wrong union.

---

### Task 2: The claim response carries the merge's counts

**Files:**
- Modify: `packages/contracts/src/assistant.ts:99-107` (`AssistantClaimOwnerResponseSchema`)
- Modify: `tests/assistant-contracts.test.ts:78-81` (the claim response fixture)
- Modify: `src/assistant/assistant-service.ts:22` (drop the `LIVE_ASSERTION_STATUSES` import) and `:716-739` (`claimNodeAsOwner`)
- Test: `tests/assistant-owner-identity.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/assistant-owner-identity.test.ts`, add one assertion to the existing first test right
after `assert.equal(result.movedAssertionCount, 1);`:

```ts
    assert.equal(result.retiredAssertionCount, 0);
```

Then append this test:

```ts
/**
 * Most of a duplicate's facts are facts the owner already holds: the same screenshot fact read
 * under two spellings. The merge retires those as duplicates and moves only the rest, and the
 * response has to say so instead of counting the source's facts before the merge ran.
 */
test('a claim reports duplicate facts as retired, not moved', async () => {
  try {
    const service = buildService();
    const { graph, ownerId } = service;
    const ownerNodeId = service.ownerPersonNodeId ?? '';
    const duplicate = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: null, displayName: 'demyx',
      description: null, sensitivity: 'personal', properties: {},
    });
    const tauri = graph.nodes.createNode({
      ownerId, type: 'software', canonicalKey: null, displayName: 'Tauri',
      description: null, sensitivity: 'personal', properties: {},
    });
    const vite = graph.nodes.createNode({
      ownerId, type: 'software', canonicalKey: null, displayName: 'Vite',
      description: null, sensitivity: 'personal', properties: {},
    });
    const uses = (subjectNodeId: string, objectNodeId: string, confidence: number): string =>
      graph.assertions.createAssertion({
        ownerId, subjectNodeId, predicate: 'USES',
        object: { kind: 'node', nodeId: objectNodeId }, scopeNodeId: null, status: 'active',
        basis: 'passive_observation', confidence, sensitivity: 'personal',
        validFromUtc: null, validToUtc: null, observedAtUtc: OBSERVED_AT,
        supersedesAssertionId: null, pinned: false, attributes: {},
        searchText: { subject: 'demyx', predicate: 'USES', object: 'tool', scope: '' },
      }).id;
    uses(ownerNodeId, tauri.id, 0.9);
    const duplicateTauri = uses(duplicate.id, tauri.id, 0.7);
    const duplicateVite = uses(duplicate.id, vite.id, 0.7);

    const result = await service.claimNodeAsOwner(duplicate.id, 'this spelling is me');

    assert.equal(result.movedAssertionCount, 1);
    assert.equal(result.retiredAssertionCount, 1);
    assert.equal(graph.assertions.requireAssertion(duplicateVite).subject_node_id, ownerNodeId);
    assert.equal(graph.assertions.requireAssertion(duplicateTauri).status, 'superseded');
  } finally {
    closeRuntimeDatabase();
  }
});
```

The owner's Tauri fact carries the higher confidence, so `weaker()` retires the duplicate's copy;
the Vite fact has no counterpart and moves.

In `tests/assistant-contracts.test.ts`, change the claim response fixture to:

```ts
    [AssistantClaimOwnerResponseSchema, {
      ok: true, graphVersion: 4, mergeId: 'merge_1', ownerNodeId: 'node_1',
      movedAssertionCount: 3, retiredAssertionCount: 2, movedAliases: ['demyus'],
    }],
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run typecheck:test`
Expected: `error TS2339: Property 'retiredAssertionCount' does not exist on type '{ ok: true; graphVersion: number; mergeId: string; ownerNodeId: string; movedAssertionCount: number; movedAliases: string[]; }'`

Run: `npm run build:test && node ./dist/test-runner/run-tests.js assistant-contracts`
Expected: the round-trip test fails because the strict schema rejects the unknown key
`retiredAssertionCount`.

Run: `node ./dist/test-runner/run-tests.js assistant-owner-identity`
Expected: `a claim reports duplicate facts as retired, not moved` fails with
`AssertionError [ERR_ASSERTION]: 2 !== 1` (the pre-merge count of the duplicate's two live facts).

- [ ] **Step 3: Add the field to the contract**

Replace `AssistantClaimOwnerResponseSchema` in `packages/contracts/src/assistant.ts`:

```ts
/** The owner confirming a duplicate `person` node names them. Merges it into the owner node. */
export const AssistantClaimOwnerResponseSchema = z.object({
  ok: z.literal(true),
  graphVersion: z.number().int().min(0),
  mergeId: z.string(),
  ownerNodeId: z.string(),
  /** Distinct facts from the claimed node that now sit on the owner. */
  movedAssertionCount: z.number().int().min(0),
  /** Facts retired because the owner already held the same one. The merge log restores them. */
  retiredAssertionCount: z.number().int().min(0),
  movedAliases: z.array(z.string()),
}).strict();
export type AssistantClaimOwnerResponse = z.infer<typeof AssistantClaimOwnerResponseSchema>;
```

- [ ] **Step 4: Return the merge's counts from the service**

In `src/assistant/assistant-service.ts`, delete line 22:

```ts
import { LIVE_ASSERTION_STATUSES } from './storage/assertion-store.js';
```

Then replace the body of `claimNodeAsOwner` from `const movedAliases` to the end of the method:

```ts
    const movedAliases = this.graph.nodes.listAliases(nodeId).map((row) => row.alias);

    return this.runMaintenance(async () => {
      const outcome = this.graph.merges.merge({
        ownerId: this.ownerId,
        sourceNodeId: nodeId,
        targetNodeId: ownerNodeId,
        actorType: 'user',
        basis: 'the owner confirmed this node names them',
        reason,
      });
      if (outcome.kind === 'blocked') {
        throw new AssistantConflictError(outcome.message);
      }
      return {
        ok: true,
        graphVersion: this.graph.graphVersion,
        mergeId: outcome.mergeId,
        ownerNodeId,
        movedAssertionCount: outcome.movedAssertionCount,
        retiredAssertionCount: outcome.retiredAssertionCount,
        movedAliases,
      } as const;
    });
  }
```

`movedAliases` stays as it was: `reassignAliases` moves every alias, so the pre-merge list is
exact.

- [ ] **Step 5: Run the suites to verify they pass**

Run: `npm run typecheck`
Expected: clean. The dashboard parses this response with the same strict schema
(`dashboard/src/assistant-api.ts:212-222`) and reads only `ownerNodeId`, so no dashboard change.

Run: `npm run build:test && node ./dist/test-runner/run-tests.js assistant-contracts`
Expected: pass.

Run: `node ./dist/test-runner/run-tests.js assistant-owner-identity`
Expected: pass, 7 tests.

Run: `node ./dist/test-runner/run-tests.js assistant-routes`
Expected: pass. The claim route only forwards the service result.

---

### Task 3: One scheduler for the projection recompile

**Files:**
- Modify: `src/assistant/assistant-graph.ts:107-109` (add a method after `get graphVersion()`)
- Modify: `src/assistant/jobs/job-runner.ts:292-299`
- Modify: `src/assistant/control/memory-mutation-service.ts:299-306`
- Modify: `src/assistant/control/graph-cleanup-service.ts:123-132`

This task is a pure extraction of three identical blocks, so it adds no test: the behaviour is
already pinned by `assistant-job-runner`, `assistant-memory-mutation-service`, and
`assistant-graph-cleanup` (`a cleanup that changed something queues a projection recompile`).
Tasks 4 and 5 add the behaviour tests for the new callers.

- [ ] **Step 1: Add the method to `AssistantGraph`**

In `src/assistant/assistant-graph.ts`, directly after `get graphVersion()`:

```ts
  /**
   * Schedules one recompile of the memory documents at the current graph version, cancelling any
   * recompile still queued. The documents are only rebuilt when something asks: every path that
   * changes what the owner's tiers should say must call this.
   */
  enqueueProjectionMaintenance(ownerId: string, priority: number): void {
    this.jobs.enqueueSuperseding({
      ownerId,
      jobType: 'projection_maintenance',
      payload: { reason: 'graph_changed' },
      idempotencyKey: `projection_maintenance:${this.graphVersion}`,
    }, priority);
  }
```

- [ ] **Step 2: Delegate from the job runner**

Replace lines 292-299 of `src/assistant/jobs/job-runner.ts`:

```ts
  private enqueueProjectionMaintenance(ownerId: string): void {
    this.options.graph.enqueueProjectionMaintenance(
      ownerId, this.priorityFor('projection_maintenance'),
    );
  }
```

The four call sites at lines 205, 243, 262, and 279 stay unchanged.

- [ ] **Step 3: Delegate from the memory mutation service**

Replace lines 299-306 of `src/assistant/control/memory-mutation-service.ts`:

```ts
  private enqueueProjectionMaintenance(ownerId: string): void {
    this.graph.enqueueProjectionMaintenance(ownerId, this.projectionPriority);
  }
```

The six call sites at lines 88, 138, 161, 197, 248, and 292 stay unchanged.

- [ ] **Step 4: Call it from the cleanup**

Replace lines 123-132 of `src/assistant/control/graph-cleanup-service.ts` (the comment and the
`enqueueSuperseding` block inside `run`):

```ts
      // Deleting a node or admitting a reclassified fact changes what the documents should say.
      if (Object.values(result).some((count) => count > 0)) {
        this.graph.enqueueProjectionMaintenance(ownerId, this.projectionPriority);
      }
```

- [ ] **Step 5: Verify nothing else builds the job by hand**

Run: `grep -rn "jobType: 'projection_maintenance'" src/`
Expected: exactly one hit, in `src/assistant/assistant-graph.ts`.

- [ ] **Step 6: Run the suites to verify they still pass**

Run: `npm run typecheck`
Expected: clean.

Run: `npm run build:test`, then each of:

```
node ./dist/test-runner/run-tests.js assistant-job-runner
node ./dist/test-runner/run-tests.js assistant-memory-mutation-service
node ./dist/test-runner/run-tests.js assistant-graph-cleanup
node ./dist/test-runner/run-tests.js assistant-gate-e-e2e
```

Expected: all pass with the same counts as before the task.

---

### Task 4: A claim schedules the recompile

**Files:**
- Modify: `src/assistant/assistant-service.ts` (`claimNodeAsOwner`, inside the `runMaintenance` callback)
- Test: `tests/assistant-owner-identity.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/assistant-owner-identity.test.ts`:

```ts
/** Recompiles queued for the owner. `enqueueSuperseding` keeps at most one queued at a time. */
function queuedRecompiles(service: AssistantService): number {
  return service.graph.jobs.listByStatus(service.ownerId, 'queued')
    .filter((job) => job.job_type === 'projection_maintenance').length;
}

/**
 * The compiled memory documents are only rebuilt when something asks. The runner asks after
 * every extraction; a claim has to ask too, or the facts it just moved stay out of every tier
 * until an unrelated screenshot happens to trigger a rebuild.
 */
test('a claim queues a projection recompile', async () => {
  try {
    const service = buildService();
    const { nodeId } = seedDuplicate(service, 'demys');

    await service.claimNodeAsOwner(nodeId, 'this spelling is me');

    assert.equal(queuedRecompiles(service), 1);
  } finally {
    closeRuntimeDatabase();
  }
});

test('a refused claim queues nothing', async () => {
  try {
    const service = buildService();
    const ownerNodeId = service.ownerPersonNodeId ?? '';

    await assert.rejects(() => service.claimNodeAsOwner(ownerNodeId, 'redundant'));

    assert.equal(queuedRecompiles(service), 0);
  } finally {
    closeRuntimeDatabase();
  }
});
```

- [ ] **Step 2: Run the suite to verify the first test fails**

Run: `npm run build:test && node ./dist/test-runner/run-tests.js assistant-owner-identity`
Expected: `a claim queues a projection recompile` fails with `AssertionError [ERR_ASSERTION]: 0 !== 1`;
`a refused claim queues nothing` already passes.

- [ ] **Step 3: Schedule the recompile after the merge**

In `claimNodeAsOwner` in `src/assistant/assistant-service.ts`, insert between the `blocked` check
and the `return {` so the callback reads:

```ts
      if (outcome.kind === 'blocked') {
        throw new AssistantConflictError(outcome.message);
      }
      this.graph.enqueueProjectionMaintenance(
        this.ownerId, this.currentConfig.Background.JobPriorities.ProjectionMaintenance,
      );
      return {
        ok: true,
        graphVersion: this.graph.graphVersion,
        mergeId: outcome.mergeId,
        ownerNodeId,
        movedAssertionCount: outcome.movedAssertionCount,
        retiredAssertionCount: outcome.retiredAssertionCount,
        movedAliases,
      } as const;
```

`currentConfig` is refreshed by `refreshConfig`, so the priority follows the latest settings
without extra plumbing. The call sits inside `runMaintenance`, where the drain is paused, so the
job waits for the next drain rather than racing it.

- [ ] **Step 4: Run the suites to verify they pass**

Run: `npm run build:test && node ./dist/test-runner/run-tests.js assistant-owner-identity`
Expected: pass, 9 tests.

Run: `npm run typecheck`
Expected: clean.

---

### Task 5: An identity answer schedules the recompile

**Files:**
- Modify: `src/assistant/control/validation-queue-service.ts:18-25` (constructor) and `:91-93` (end of `resolveIdentity`)
- Modify: `src/assistant/assistant-service.ts:291` (construction) and `:541-558` (`refreshConfig`)
- Test: `tests/assistant-owner-alias-question.test.ts`, `tests/assistant-owner-identity.test.ts`

`ValidationQueueService` takes three positional arguments today. Adding a priority as a fourth
positional number is easy to misorder, so this task switches it to the options-object shape
`MemoryMutationService` already uses, with the same `refreshProjectionPriority` hook.

- [ ] **Step 1: Write the failing tests**

In `tests/assistant-owner-alias-question.test.ts`, add after `buildPromoter`:

```ts
function buildQueue(
  context: AssistantTestContext, promoter: CandidatePromoter,
): ValidationQueueService {
  return new ValidationQueueService({
    graph: context.graph, ownerId: context.ownerId, promoter, projectionPriority: 300,
  });
}

function queuedRecompiles(context: AssistantTestContext): number {
  return context.graph.jobs.listByStatus(context.ownerId, 'queued')
    .filter((job) => job.job_type === 'projection_maintenance').length;
}
```

Replace each of the three `new ValidationQueueService(context.graph, context.ownerId, promoter)`
calls (lines 142, 163, 188) with `buildQueue(context, promoter)`.

Append:

```ts
/**
 * Either answer puts a fact on a node the tiers read from — the owner, or a person the owner
 * just named — and the documents are only rebuilt when something asks.
 */
test('answering yes to an identity question queues a projection recompile', () => {
  withAssistantContext((context) => {
    seedOwner(context);
    const candidateId = proposePersonUses(context, 'denyz', 'cap:9');
    const promoter = buildPromoter(context.graph);
    promoter.promote({ ownerId: context.ownerId, candidateId });

    buildQueue(context, promoter).resolveIdentity(candidateId, true);

    assert.equal(queuedRecompiles(context), 1);
  });
});

test('answering no to an identity question queues a projection recompile', () => {
  withAssistantContext((context) => {
    seedOwner(context);
    const candidateId = proposePersonUses(context, 'denyz', 'cap:10');
    const promoter = buildPromoter(context.graph);
    promoter.promote({ ownerId: context.ownerId, candidateId });

    buildQueue(context, promoter).resolveIdentity(candidateId, false);

    assert.equal(queuedRecompiles(context), 1);
  });
});
```

In `tests/assistant-owner-identity.test.ts`, add these imports next to the existing ones:

```ts
import { CandidateGate } from '../src/assistant/ingestion/candidate-gate.js';
import { CandidatePromoter } from '../src/assistant/ingestion/candidate-promoter.js';
import { SecretScanner } from '../src/assistant/domain/secrets.js';
```

and append this test, which pins the `refreshConfig` wiring end to end through the service's own
validation queue:

```ts
test('an identity answer uses the projection priority from the latest config', () => {
  try {
    const service = buildService();
    const { graph, ownerId } = service;
    const evidence = graph.evidence.recordTextEvidence({
      ownerId, deviceId: null, sourceType: 'screenshot', parentEvidenceId: null,
      sourceEventId: 'cap:priority', sourceRef: 'app:code', sourceTimezone: null,
      capturedAtUtc: OBSERVED_AT, sensitivity: 'personal', retentionUntilUtc: null,
      metadata: {}, text: 'denyz uses Tauri.',
    });
    const observation = graph.observations.record({
      ownerId, evidenceId: evidence.id, observationType: 'screenshot_extraction',
      payload: {}, confidence: 0.7, sensitivity: 'personal',
      extractorName: 'image_extraction', extractorVersion: '1',
    });
    const candidate = graph.candidates.propose({
      ownerId, observationId: observation.id,
      subject: { nodeType: 'person', displayName: 'denyz' }, predicate: 'USES',
      object: { kind: 'unresolved', nodeType: 'software', displayName: 'Tauri' },
      scope: null, basis: 'passive_observation', confidence: 0.7, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, rationale: 'The screenshot shows denyz in Tauri.',
    });
    if (candidate === null) throw new Error('Candidate proposal was deduplicated unexpectedly.');
    // Park it on the identity question the way the runner would.
    new CandidatePromoter(graph, new CandidateGate(graph.policies, new SecretScanner()))
      .promote({ ownerId, candidateId: candidate.id });
    service.refreshConfig({
      ...DEFAULT_ASSISTANT_CONFIG,
      Enabled: true,
      Owner: { ...DEFAULT_ASSISTANT_CONFIG.Owner, DisplayName: 'Denys' },
      Background: {
        ...DEFAULT_ASSISTANT_CONFIG.Background,
        JobPriorities: {
          ...DEFAULT_ASSISTANT_CONFIG.Background.JobPriorities, ProjectionMaintenance: 123,
        },
      },
    });

    const outcome = service.validation.resolveIdentity(candidate.id, true);

    assert.equal(outcome.kind, 'promoted');
    const recompiles = graph.jobs.listByStatus(ownerId, 'queued')
      .filter((job) => job.job_type === 'projection_maintenance');
    assert.equal(recompiles.length, 1);
    assert.equal(recompiles[0]?.priority, 123);
  } finally {
    closeRuntimeDatabase();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run typecheck:test`
Expected: `error TS2554: Expected 3 arguments, but got 1.` at each `new ValidationQueueService({`
in `tests/assistant-owner-alias-question.test.ts`.

Run: `npm run build:test && node ./dist/test-runner/run-tests.js assistant-owner-identity`
Expected: `an identity answer uses the projection priority from the latest config` fails with
`AssertionError [ERR_ASSERTION]: 0 !== 1`.

- [ ] **Step 3: Give the service its priority and schedule after a promotion**

In `src/assistant/control/validation-queue-service.ts`, replace the class header and constructor
(lines 18-25):

```ts
interface ValidationQueueServiceOptions {
  readonly graph: AssistantGraph;
  readonly ownerId: string;
  readonly promoter: CandidatePromoter;
  readonly projectionPriority: number;
}

/** The validation queue a user reviews before a candidate becomes an assertion. */
export class ValidationQueueService {
  private readonly graph: AssistantGraph;
  private readonly ownerId: string;
  private readonly promoter: CandidatePromoter;
  private projectionPriority: number;

  constructor(options: ValidationQueueServiceOptions) {
    this.graph = options.graph;
    this.ownerId = options.ownerId;
    this.promoter = options.promoter;
    this.projectionPriority = options.projectionPriority;
  }

  refreshProjectionPriority(priority: number): void {
    if (!Number.isInteger(priority)) throw new Error('Projection priority must be an integer.');
    this.projectionPriority = priority;
  }
```

Replace the last two statements of `resolveIdentity` (lines 91-93):

```ts
    this.graph.candidates.returnToPending(candidateId);
    const outcome = this.promoter.promote({ ownerId: this.ownerId, candidateId });
    // The runner recompiles after every extraction it promotes; a user's answer promotes too.
    if (outcome.kind === 'promoted') {
      this.graph.enqueueProjectionMaintenance(this.ownerId, this.projectionPriority);
    }
    return outcome;
  }
```

- [ ] **Step 4: Wire construction and refresh in the service**

In `src/assistant/assistant-service.ts`, replace line 291:

```ts
    this.validation = new ValidationQueueService({
      graph: this.graph,
      ownerId: this.graph.ownerId,
      promoter,
      projectionPriority: options.config.Background.JobPriorities.ProjectionMaintenance,
    });
```

In `refreshConfig`, directly after the `this.memoryMutations.refreshProjectionPriority(...)` call:

```ts
    this.validation.refreshProjectionPriority(
      config.Background.JobPriorities.ProjectionMaintenance,
    );
```

- [ ] **Step 5: Run the suites to verify they pass**

Run: `npm run typecheck`
Expected: clean.

Run: `npm run build:test`, then each of:

```
node ./dist/test-runner/run-tests.js assistant-owner-alias-question
node ./dist/test-runner/run-tests.js assistant-owner-identity
node ./dist/test-runner/run-tests.js assistant-routes
node ./dist/test-runner/run-tests.js assistant-service
```

Expected: all pass; `assistant-owner-alias-question` has 9 tests, `assistant-owner-identity` 10.

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

Before reporting a task complete, state: which tests you added, the exact reason each failed
before the change, and the final counts from the suites you ran. Then update the status table at
the top of this file.

## Out of scope

- Surfacing the retired count in the dashboard card. The controller re-selects the owner after a
  claim and shows no counts today; adding a result line is a separate UI decision.
- Consolidating the eleven duplicate owner nodes still live in the database. That is a data
  operation the owner runs through "This is me", one node at a time, after this plan lands.
- The pronoun aliases (`user`, `myself`) in the near-miss comparison set, and the cleanup
  routine's missing route. Both are tracked in the 2026-09-03 validation notes, not here.

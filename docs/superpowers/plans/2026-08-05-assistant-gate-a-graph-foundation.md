# SiftKit Assistant — Gate A (Graph Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the provenance-aware temporal knowledge graph foundation for the SiftKit assistant — domain registries, clock/ID abstractions, two migration steps, the storage layer, encrypted evidence, graph validation and mutation policy, entity resolution, and reversible merge — with nothing user-facing wired up yet.

**Architecture:** All assistant tables are appended to the existing `ensureSchema()` ladder in `src/state/runtime-db.ts`. SQL lives exclusively under `src/assistant/storage/`; decision logic lives under `src/assistant/graph/` and calls stores. The TypeScript registries in `src/assistant/domain/` are the single source of truth; the registry tables are their projection, seeded at migration time. `AssistantGraph` is the composition root that owns stores and services and is constructed with an injected `Clock`, `IdGenerator`, and `AssistantKeyProvider`.

**Tech Stack:** TypeScript (NodeNext ESM), `better-sqlite3` 12.x (SQLite 3.51.3, FTS5 available), `zod` 4.x, `node:crypto` (AES-256-GCM, SHA-256, `randomUUID`), `node:test` via `npm test`.

**Source spec:** `assistant/2026-07-30-siftkit-assistant-design.md` §4, §5, §9, §17, §18 (Gate A), §19, §21.

---

## Corrections to the design spec (locked, do not re-litigate)

| Design says | This plan does | Why |
|---|---|---|
| Migration steps v37 (tables) and v38 (FTS) | Steps **v39** (tables + seed) and **v40** (FTS); `CURRENT_SCHEMA_VERSION` goes 38 → 40 | `src/state/runtime-db.ts:37` already reads `38`; v37/v38 are taken by `migrateChatSessionsToModelPresetSnapshot` and `migrateRunLogsBackendToEngineIds`. Later gates shift by two: **B = v41** (`memory_projections`), **C = v42** (questions, jobs, retrieval), **D = v43** (activity, capture). Each gate's own plan adds its step. |
| "clock/ID abstractions" (unspecified) | `Clock` / `IdGenerator` interfaces implemented by classes, injected as objects | Repo has no clock abstraction today; `@typescript-eslint` bans passing bare functions around per repo rules. |
| Evidence key held by the OS keychain (§13.4) | Gate A ships `AssistantKeyProvider` + `RuntimeMetadataKeyProvider` (key in `runtime_metadata`); Gate D adds the native keychain provider as a second implementation | The Tauri shell does not exist until Gate D, and the assistant must work with no desktop shell (§20.4). This is a real fallback, not a shim — the honest-storage statement in §4.7 covers it. |
| Entity resolution step 5 — "model-suggested match that clears a deterministic score threshold" (§9.1) | Not implemented in Gate A. `EntityResolver` implements steps 1, 2, 3, 4, 6, 7. Step 5 arrives with `candidate_consolidator` in Gate B. | No model call exists in Gate A. Implementing an unreachable branch would be dead machinery. |
| Confidence pipeline includes a staleness function (§4.6) | Gate A implements aggregation → basis ceiling → contradiction penalty → explicit-user override → cardinality rule. Staleness lands with tier routing (§10.4) in Gate B. | The staleness decay classes are defined only by the Tier-routing table, which is Gate B. |

---

## File structure

**Created — domain (pure, no I/O):**

| File | Responsibility |
|---|---|
| `src/assistant/domain/enums.ts` | Every closed string union in the assistant, as zod enums with `z.infer` types |
| `src/assistant/domain/node-types.ts` | `NODE_TYPES`, `NodeType`, `NODE_TYPE_DEFINITIONS` |
| `src/assistant/domain/relation-types.ts` | `RELATION_TYPES`, `RelationType`, `RelationDefinition`, `RELATION_DEFINITIONS`, lookup helpers |
| `src/assistant/domain/keys.ts` | Deterministic derivations: normalization, `buildAssertionKey`, `buildCandidateFingerprint`, `hashTextContent`, `hashBytes` (§5.4.1) |
| `src/assistant/domain/confidence.ts` | `BASIS_CONFIDENCE_CEILING`, `aggregateSupport`, `resolveConfidence` (§4.6) |

**Created — infrastructure:**

| File | Responsibility |
|---|---|
| `src/assistant/clock.ts` | `Clock` interface, `SystemClock`, `FixedClock` |
| `src/assistant/ids.ts` | `IdGenerator` interface, `RandomIdGenerator`, `SequentialIdGenerator` |
| `src/assistant/crypto/key-provider.ts` | `AssistantKeyProvider` interface, `RuntimeMetadataKeyProvider` |
| `src/assistant/crypto/blob-cipher.ts` | `BlobCipher` — AES-256-GCM envelope encode/decode with tamper detection |

**Created — storage (the only place SQL lives):**

| File | Responsibility |
|---|---|
| `src/assistant/storage/schema.ts` | Assistant DDL, FTS DDL, registry/owner/device seeding |
| `src/assistant/storage/rows.ts` | zod row schemas + inferred record types for every assistant table |
| `src/assistant/storage/identity-store.ts` | `assistant_owners`, `assistant_devices` |
| `src/assistant/storage/audit-store.ts` | `graph_mutation_log`, `assistant_audit_events`, the `graph_version` counter |
| `src/assistant/storage/node-store.ts` | `graph_nodes`, `graph_node_aliases`, `graph_nodes_fts`, `graph_entity_merges` |
| `src/assistant/storage/assertion-store.ts` | `graph_assertions`, `assertion_evidence`, `graph_assertions_fts` |
| `src/assistant/storage/evidence-store.ts` | `evidence_records`, `evidence_blobs`, encrypted blob files |
| `src/assistant/storage/policy-store.ts` | `assistant_policies` |

**Created — graph services (no SQL, no `better-sqlite3` import):**

| File | Responsibility |
|---|---|
| `src/assistant/graph/validation.ts` | `AssertionValidator` — registry shape rules, basis/confidence rules (§8.3 deterministic subset) |
| `src/assistant/graph/assertion-service.ts` | `AssertionService` — create/confirm/supersede/dispute/reject/expire/delete + conflict strategies (§9.3) |
| `src/assistant/graph/entity-resolver.ts` | `EntityResolver` — resolution order §9.1 steps 1–4, 6, 7 |
| `src/assistant/graph/merge-service.ts` | `NodeMergeService` — merge safety §9.2, reversible merge/unmerge |
| `src/assistant/graph/neighborhood.ts` | `NeighborhoodReader` — bounded traversal §11.4 |

**Created — composition:**

| File | Responsibility |
|---|---|
| `src/assistant/assistant-graph.ts` | `AssistantGraph` — owns stores + services, the single construction point |

**Modified:**

| File | Change |
|---|---|
| `src/state/runtime-db.ts:37` | `CURRENT_SCHEMA_VERSION` 38 → 40 |
| `src/state/runtime-db.ts:1419-1428` | Append `if (currentVersion < 39)` and `if (currentVersion < 40)` blocks before the sub-schema calls |

**Created — tests:**

`tests/helpers/assistant-fixture.ts`, `tests/assistant-registry.test.ts`, `tests/assistant-keys.test.ts`, `tests/assistant-confidence.test.ts`, `tests/assistant-migration.test.ts`, `tests/assistant-evidence-store.test.ts`, `tests/assistant-graph-crud.test.ts`, `tests/assistant-assertion-service.test.ts`, `tests/assistant-entity-resolution.test.ts`, `tests/assistant-merge.test.ts`, `tests/assistant-neighborhood.test.ts`, `tests/assistant-gate-a-e2e.test.ts`.

---

## Repo rules that apply to every task

- TypeScript only, `strict`, NodeNext ESM — **all relative imports end in `.js`** (e.g. `import { z } from '../../lib/zod.js';`).
- Import zod as `import { z } from '../../lib/zod.js';` (the repo re-exports it there), never directly from `'zod'` in `src/`.
- **Banned and enforced by `npm run lint`:** type-assertion casts (`x as T`, `<T>x`), `any`, explicit `unknown` (`TSUnknownKeyword`), non-null `!`, namespace imports (`import * as X`), `__dirname`/`__filename` in `src/**`.
- Boundary values are parsed with a zod schema and the type comes from `z.infer`. Row reads use `RowSchema.parse(...)` / `z.array(RowSchema).parse(...)`, following `src/state/chat-sessions.ts`.
- No back-compat, no shims, no legacy branches.
- Multi-statement writes go inside `database.transaction(() => { ... })()`.
- Every task ends green: `npm test` and `npm run lint` both pass before the commit.

---

## Task 1: Domain enums

**Files:**
- Create: `src/assistant/domain/enums.ts`
- Test: `tests/assistant-registry.test.ts` (created here, extended in Task 2)

- [ ] **Step 1: Write the failing test**

Create `tests/assistant-registry.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ASSERTION_BASES,
  ASSERTION_STATUSES,
  EXPLICIT_BASES,
  PASSIVE_BASES,
  SENSITIVITIES,
  SENSITIVITY_RANK,
  isExplicitBasis,
  isSensitivityAtLeast,
} from '../src/assistant/domain/enums.js';

test('sensitivity levels are ordered least to most restrictive', () => {
  assert.deepEqual(
    [...SENSITIVITIES],
    ['low', 'personal', 'sensitive', 'highly_sensitive', 'secret_prohibited'],
  );
  assert.equal(SENSITIVITY_RANK.low, 0);
  assert.equal(SENSITIVITY_RANK.secret_prohibited, 4);
  assert.equal(isSensitivityAtLeast('highly_sensitive', 'sensitive'), true);
  assert.equal(isSensitivityAtLeast('personal', 'sensitive'), false);
});

test('assertion bases partition into explicit and passive with no overlap or gap', () => {
  assert.equal(ASSERTION_BASES.length, 6);
  const union = [...EXPLICIT_BASES, ...PASSIVE_BASES].sort();
  assert.deepEqual(union, [...ASSERTION_BASES].sort());
  assert.equal(new Set(union).size, ASSERTION_BASES.length);
  assert.equal(isExplicitBasis('explicit_user_statement'), true);
  assert.equal(isExplicitBasis('passive_observation'), false);
});

test('assertion statuses cover the full lifecycle', () => {
  assert.deepEqual(
    [...ASSERTION_STATUSES],
    ['active', 'disputed', 'superseded', 'rejected', 'expired', 'deleted'],
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- assistant-registry`
Expected: FAIL — `Cannot find module '../src/assistant/domain/enums.js'`

- [ ] **Step 3: Write the implementation**

Create `src/assistant/domain/enums.ts`:

```ts
import { z } from '../../lib/zod.js';

export const SENSITIVITIES = [
  'low', 'personal', 'sensitive', 'highly_sensitive', 'secret_prohibited',
] as const;
export const SensitivitySchema = z.enum(SENSITIVITIES);
export type Sensitivity = z.infer<typeof SensitivitySchema>;

export const SENSITIVITY_RANK = {
  low: 0,
  personal: 1,
  sensitive: 2,
  highly_sensitive: 3,
  secret_prohibited: 4,
} as const satisfies Record<Sensitivity, number>;

export function isSensitivityAtLeast(value: Sensitivity, floor: Sensitivity): boolean {
  return SENSITIVITY_RANK[value] >= SENSITIVITY_RANK[floor];
}

export const ASSERTION_STATUSES = [
  'active', 'disputed', 'superseded', 'rejected', 'expired', 'deleted',
] as const;
export const AssertionStatusSchema = z.enum(ASSERTION_STATUSES);
export type AssertionStatus = z.infer<typeof AssertionStatusSchema>;

export const ASSERTION_BASES = [
  'explicit_user_statement', 'explicit_question_answer', 'manual_import',
  'passive_observation', 'derived_aggregation', 'assistant_inference',
] as const;
export const AssertionBasisSchema = z.enum(ASSERTION_BASES);
export type AssertionBasis = z.infer<typeof AssertionBasisSchema>;

/** Bases sourced from a deliberate human statement. These outrank passive evidence, always. */
export const EXPLICIT_BASES = [
  'explicit_user_statement', 'explicit_question_answer', 'manual_import',
] as const;
/** Bases produced without a deliberate human statement. */
export const PASSIVE_BASES = [
  'passive_observation', 'derived_aggregation', 'assistant_inference',
] as const;

export function isExplicitBasis(basis: AssertionBasis): boolean {
  return EXPLICIT_BASES.some((explicit) => explicit === basis);
}

export const NODE_STATUSES = ['active', 'merged', 'archived', 'deleted'] as const;
export const NodeStatusSchema = z.enum(NODE_STATUSES);
export type NodeStatus = z.infer<typeof NodeStatusSchema>;

export const ALIAS_TYPES = [
  'name', 'handle', 'model', 'path', 'identifier', 'user_supplied',
] as const;
export const AliasTypeSchema = z.enum(ALIAS_TYPES);
export type AliasType = z.infer<typeof AliasTypeSchema>;

export const EVIDENCE_SOURCE_TYPES = [
  'conversation_message', 'question_answer', 'manual_correction', 'manual_import',
  'desktop_activity', 'screenshot', 'accessibility_snapshot', 'ocr_result', 'mobile_event',
] as const;
export const EvidenceSourceTypeSchema = z.enum(EVIDENCE_SOURCE_TYPES);
export type EvidenceSourceType = z.infer<typeof EvidenceSourceTypeSchema>;

export const EVIDENCE_STATUSES = ['active', 'expired', 'quarantined', 'deleted'] as const;
export const EvidenceStatusSchema = z.enum(EVIDENCE_STATUSES);
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;

export const EVIDENCE_STANCES = ['supports', 'contradicts', 'context'] as const;
export const EvidenceStanceSchema = z.enum(EVIDENCE_STANCES);
export type EvidenceStance = z.infer<typeof EvidenceStanceSchema>;

export const OBJECT_KINDS = ['node', 'literal'] as const;
export const ObjectKindSchema = z.enum(OBJECT_KINDS);
export type ObjectKind = z.infer<typeof ObjectKindSchema>;

export const OBJECT_VALUE_TYPES = [
  'string', 'integer', 'number', 'boolean', 'date', 'datetime',
  'duration', 'quantity', 'json',
] as const;
export const ObjectValueTypeSchema = z.enum(OBJECT_VALUE_TYPES);
export type ObjectValueType = z.infer<typeof ObjectValueTypeSchema>;

export const ACTOR_TYPES = ['user', 'system', 'assistant_proposal', 'migration'] as const;
export const ActorTypeSchema = z.enum(ACTOR_TYPES);
export type ActorType = z.infer<typeof ActorTypeSchema>;

export const MUTATION_OPERATIONS = [
  'create_node', 'update_node', 'merge_node', 'unmerge_node', 'create_assertion',
  'confirm_assertion', 'update_assertion', 'supersede_assertion', 'dispute_assertion',
  'reject_assertion', 'expire_assertion', 'delete_assertion', 'delete_evidence',
  'update_policy',
] as const;
export const MutationOperationSchema = z.enum(MUTATION_OPERATIONS);
export type MutationOperation = z.infer<typeof MutationOperationSchema>;

export const POLICY_TYPES = [
  'blocked_question_topic', 'never_infer_topic', 'capture_exclusion',
  'do_not_merge_node', 'assertion_lock',
] as const;
export const PolicyTypeSchema = z.enum(POLICY_TYPES);
export type PolicyType = z.infer<typeof PolicyTypeSchema>;

export const POLICY_SOURCES = ['default', 'user', 'migration'] as const;
export const PolicySourceSchema = z.enum(POLICY_SOURCES);
export type PolicySource = z.infer<typeof PolicySourceSchema>;

export const DEVICE_STATUSES = ['active', 'revoked'] as const;
export const DeviceStatusSchema = z.enum(DEVICE_STATUSES);
export type DeviceStatus = z.infer<typeof DeviceStatusSchema>;

export const CANDIDATE_STATUSES = [
  'pending', 'accepted', 'rejected', 'needs_confirmation', 'superseded',
] as const;
export const CandidateStatusSchema = z.enum(CANDIDATE_STATUSES);
export type CandidateStatus = z.infer<typeof CandidateStatusSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- assistant-registry`
Expected: PASS — 3 tests.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/assistant/domain/enums.ts tests/assistant-registry.test.ts
git commit -m "feat(assistant): add graph domain enums"
```

---

## Task 2: Node and relation registries

**Files:**
- Create: `src/assistant/domain/node-types.ts`, `src/assistant/domain/relation-types.ts`
- Modify: `tests/assistant-registry.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/assistant-registry.test.ts`:

```ts
import { NODE_TYPES, NODE_TYPE_DEFINITIONS } from '../src/assistant/domain/node-types.js';
import {
  RELATION_DEFINITIONS,
  RELATION_TYPES,
  getRelationDefinition,
  isNodeTypeAllowedAsObject,
  isNodeTypeAllowedAsSubject,
} from '../src/assistant/domain/relation-types.js';

test('node type registry has 28 unique types, each with a definition', () => {
  assert.equal(NODE_TYPES.length, 28);
  assert.equal(new Set(NODE_TYPES).size, 28);
  for (const nodeType of NODE_TYPES) {
    const definition = NODE_TYPE_DEFINITIONS[nodeType];
    assert.equal(typeof definition, 'string');
    assert.ok(definition.length > 10, `${nodeType} needs a real definition`);
  }
});

test('relation registry has 38 unique predicates with complete descriptors', () => {
  assert.equal(RELATION_TYPES.length, 38);
  assert.equal(new Set(RELATION_TYPES).size, 38);
  for (const predicate of RELATION_TYPES) {
    const definition = getRelationDefinition(predicate);
    assert.equal(definition.predicate, predicate);
    assert.ok(definition.allowedSubjectTypes.length > 0);
    if (definition.allowedObjectTypes !== 'literal') {
      assert.ok(definition.allowedObjectTypes.length > 0);
    }
  }
});

test('every declared node type in a relation descriptor exists in the node registry', () => {
  const known = new Set<string>(NODE_TYPES);
  for (const definition of Object.values(RELATION_DEFINITIONS)) {
    for (const subjectType of definition.allowedSubjectTypes) {
      assert.ok(known.has(subjectType), `unknown subject type ${subjectType}`);
    }
    if (definition.allowedObjectTypes !== 'literal') {
      for (const objectType of definition.allowedObjectTypes) {
        assert.ok(known.has(objectType), `unknown object type ${objectType}`);
      }
    }
  }
});

test('inverse predicates are symmetric', () => {
  for (const definition of Object.values(RELATION_DEFINITIONS)) {
    if (definition.inversePredicate === null) continue;
    const inverse = getRelationDefinition(definition.inversePredicate);
    assert.equal(
      inverse.inversePredicate,
      definition.predicate,
      `${definition.predicate} <-> ${definition.inversePredicate} is not symmetric`,
    );
  }
});

test('subject and object type membership checks respect the descriptor', () => {
  assert.equal(isNodeTypeAllowedAsSubject('OWNS', 'person'), true);
  assert.equal(isNodeTypeAllowedAsSubject('OWNS', 'software'), false);
  assert.equal(isNodeTypeAllowedAsObject('OWNS', 'vehicle'), true);
  assert.equal(isNodeTypeAllowedAsObject('OWNS', 'topic'), false);
  assert.equal(isNodeTypeAllowedAsObject('HAS_ROLE', 'person'), false);
});

test('RELATED_TO is never projected', () => {
  assert.equal(getRelationDefinition('RELATED_TO').projectionBehavior, 'never_project');
});

test('HAS_CONSTRAINT disputes rather than superseding, and is exclusive per scope', () => {
  const definition = getRelationDefinition('HAS_CONSTRAINT');
  assert.equal(definition.cardinality, 'single_per_scope');
  assert.equal(definition.conflictStrategy, 'mark_disputed');
});

test('getRelationDefinition rejects a predicate outside the registry', () => {
  assert.throws(() => getRelationDefinition('DEFINITELY_NOT_A_PREDICATE'), /unknown predicate/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- assistant-registry`
Expected: FAIL — `Cannot find module '../src/assistant/domain/node-types.js'`

- [ ] **Step 3: Write `src/assistant/domain/node-types.ts`**

```ts
import { z } from '../../lib/zod.js';

export const NODE_TYPES = [
  'person', 'organization', 'place', 'device', 'software', 'project', 'document',
  'topic', 'goal', 'routine', 'activity', 'episode', 'event', 'preference_context',
  'policy_topic', 'question_topic', 'account', 'vehicle', 'home_asset',
  'financial_account', 'health_topic', 'food_recipe', 'media_work', 'model',
  'inference_backend', 'dataset', 'benchmark', 'configuration_profile',
] as const;

export const NodeTypeSchema = z.enum(NODE_TYPES);
export type NodeType = z.infer<typeof NodeTypeSchema>;

/**
 * Human-readable definition of every node type, seeded into `graph_node_types`.
 * Adding a type requires a migration step, an entry here, allowed-relation updates,
 * tests, and a projection policy.
 */
export const NODE_TYPE_DEFINITIONS = {
  person: 'A human being, including the assistant owner (canonical key person:self) and third parties.',
  organization: 'A company, institution, team, or other collective body.',
  place: 'A physical or named location at any granularity, from a city to a room.',
  device: 'A physical computing or peripheral device such as a workstation, phone, or GPU.',
  software: 'An application, library, service, or operating system.',
  project: 'A named body of work with an identity that persists across sessions.',
  document: 'A durable written artifact such as a file, note, specification, or article.',
  topic: 'A subject of interest that is not itself a concrete entity.',
  goal: 'A stated outcome the owner intends to reach.',
  routine: 'A recurring pattern of behaviour with a cadence.',
  activity: 'A category of doing, such as focused coding or gaming.',
  episode: 'A reified multi-participant fact with its own temporal scope, such as an employment.',
  event: 'A point-in-time or short-span occurrence.',
  preference_context: 'A scope under which a preference holds, such as Windows command examples.',
  policy_topic: 'A subject area a user policy applies to, such as health or finance.',
  question_topic: 'A subject the assistant may or may not ask about.',
  account: 'A non-financial account or login identity on a service.',
  vehicle: 'A car, motorcycle, bicycle, or other means of personal transport.',
  home_asset: 'A durable possession belonging to a home, such as an appliance or furnishing.',
  financial_account: 'A bank, brokerage, credit, or other money-holding account.',
  health_topic: 'A health-related subject area. Never a diagnosis.',
  food_recipe: 'A named dish or recipe.',
  media_work: 'A book, film, series, game, album, or other authored work.',
  model: 'A machine-learning model identified by name, family, and quantization.',
  inference_backend: 'A runtime that serves models, such as llama.cpp or TabbyAPI.',
  dataset: 'A named collection of data used for evaluation or training.',
  benchmark: 'A named, repeatable measurement procedure.',
  configuration_profile: 'A named bundle of settings applied to software, a model, or a device.',
} as const satisfies Record<NodeType, string>;
```

- [ ] **Step 4: Write `src/assistant/domain/relation-types.ts`**

```ts
import { z } from '../../lib/zod.js';

import type { Sensitivity } from './enums.js';
import { NODE_TYPES, type NodeType } from './node-types.js';

export const RELATION_TYPES = [
  'OWNS', 'USES', 'PREFERS', 'DISLIKES', 'AVOIDS', 'WORKS_ON', 'CREATED',
  'CONTRIBUTED_TO', 'EMPLOYED_BY', 'HAS_ROLE', 'LOCATED_IN', 'LIVES_IN', 'VISITED',
  'INTERESTED_IN', 'READ', 'WATCHED', 'PLAYED', 'DRIVES', 'RIDES', 'HAS_GOAL',
  'HAS_PLAN', 'HAS_ROUTINE', 'HAS_CONSTRAINT', 'HAS_SETTING', 'HAS_COMPONENT',
  'RUNS_ON', 'DEPENDS_ON', 'CONFIGURED_WITH', 'COMPARED_WITH', 'TESTED_WITH',
  'RESULTED_IN', 'CAUSED_BY', 'RELATED_TO', 'PART_OF', 'ABOUT', 'MENTIONED_IN',
  'OBSERVED_DURING', 'ASKED_ABOUT',
] as const;

export const RelationTypeSchema = z.enum(RELATION_TYPES);
export type RelationType = z.infer<typeof RelationTypeSchema>;

export type RelationCardinality =
  | 'many' | 'single_current' | 'single_per_scope' | 'append_only';
export type RelationTemporal = 'none' | 'optional' | 'required';
export type ProjectionBehavior = 'core' | 'dossier' | 'episodic' | 'never_project';
export type ConflictStrategy =
  | 'coexist' | 'supersede_current' | 'mark_disputed' | 'require_confirmation';

export interface RelationDefinition {
  readonly predicate: RelationType;
  readonly allowedSubjectTypes: readonly NodeType[];
  readonly allowedObjectTypes: readonly NodeType[] | 'literal';
  readonly inversePredicate: RelationType | null;
  readonly cardinality: RelationCardinality;
  readonly temporal: RelationTemporal;
  readonly defaultSensitivity: Sensitivity;
  readonly projectionBehavior: ProjectionBehavior;
  readonly conflictStrategy: ConflictStrategy;
}

const ANY: readonly NodeType[] = NODE_TYPES;
const PERSON: readonly NodeType[] = ['person'];
const PLACES: readonly NodeType[] = ['place'];
const OWNABLE: readonly NodeType[] = [
  'device', 'software', 'vehicle', 'home_asset', 'financial_account', 'account',
  'document', 'media_work', 'dataset', 'model',
];
const TOOLS: readonly NodeType[] = [
  'software', 'device', 'model', 'inference_backend', 'configuration_profile',
];
const TASTEABLE: readonly NodeType[] = [
  'software', 'device', 'model', 'inference_backend', 'configuration_profile',
  'topic', 'media_work', 'food_recipe', 'activity', 'health_topic', 'vehicle', 'place',
];
const AUTHORED: readonly NodeType[] = [
  'project', 'document', 'media_work', 'dataset', 'software',
];
const WORK_ITEMS: readonly NodeType[] = [
  'project', 'goal', 'document', 'dataset', 'benchmark',
];
const TOPICAL: readonly NodeType[] = [
  'topic', 'project', 'software', 'model', 'media_work', 'health_topic',
  'food_recipe', 'activity', 'place', 'organization',
];
const OCCURRENCES: readonly NodeType[] = ['activity', 'episode', 'event'];

function define(definition: RelationDefinition): RelationDefinition {
  return definition;
}

export const RELATION_DEFINITIONS = {
  OWNS: define({
    predicate: 'OWNS', allowedSubjectTypes: PERSON, allowedObjectTypes: OWNABLE,
    inversePredicate: null, cardinality: 'many', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'dossier', conflictStrategy: 'coexist',
  }),
  USES: define({
    predicate: 'USES', allowedSubjectTypes: PERSON, allowedObjectTypes: TOOLS,
    inversePredicate: null, cardinality: 'many', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'dossier', conflictStrategy: 'coexist',
  }),
  PREFERS: define({
    predicate: 'PREFERS', allowedSubjectTypes: PERSON, allowedObjectTypes: TASTEABLE,
    inversePredicate: null, cardinality: 'single_per_scope', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'core', conflictStrategy: 'supersede_current',
  }),
  DISLIKES: define({
    predicate: 'DISLIKES', allowedSubjectTypes: PERSON, allowedObjectTypes: TASTEABLE,
    inversePredicate: null, cardinality: 'single_per_scope', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'dossier', conflictStrategy: 'supersede_current',
  }),
  AVOIDS: define({
    predicate: 'AVOIDS', allowedSubjectTypes: PERSON, allowedObjectTypes: TASTEABLE,
    inversePredicate: null, cardinality: 'single_per_scope', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'dossier', conflictStrategy: 'supersede_current',
  }),
  WORKS_ON: define({
    predicate: 'WORKS_ON', allowedSubjectTypes: PERSON, allowedObjectTypes: WORK_ITEMS,
    inversePredicate: null, cardinality: 'many', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'core', conflictStrategy: 'coexist',
  }),
  CREATED: define({
    predicate: 'CREATED', allowedSubjectTypes: PERSON, allowedObjectTypes: AUTHORED,
    inversePredicate: null, cardinality: 'append_only', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'dossier', conflictStrategy: 'coexist',
  }),
  CONTRIBUTED_TO: define({
    predicate: 'CONTRIBUTED_TO', allowedSubjectTypes: PERSON, allowedObjectTypes: AUTHORED,
    inversePredicate: null, cardinality: 'many', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'dossier', conflictStrategy: 'coexist',
  }),
  EMPLOYED_BY: define({
    predicate: 'EMPLOYED_BY', allowedSubjectTypes: ['person', 'episode'],
    allowedObjectTypes: ['organization'], inversePredicate: null,
    cardinality: 'single_current', temporal: 'required',
    defaultSensitivity: 'personal', projectionBehavior: 'core', conflictStrategy: 'supersede_current',
  }),
  HAS_ROLE: define({
    predicate: 'HAS_ROLE', allowedSubjectTypes: ['person', 'episode'],
    allowedObjectTypes: 'literal', inversePredicate: null,
    cardinality: 'single_current', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'core', conflictStrategy: 'supersede_current',
  }),
  LOCATED_IN: define({
    predicate: 'LOCATED_IN',
    allowedSubjectTypes: ['device', 'home_asset', 'vehicle', 'organization', 'event', 'episode'],
    allowedObjectTypes: PLACES, inversePredicate: null,
    cardinality: 'single_current', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'dossier', conflictStrategy: 'supersede_current',
  }),
  LIVES_IN: define({
    predicate: 'LIVES_IN', allowedSubjectTypes: PERSON, allowedObjectTypes: PLACES,
    inversePredicate: null, cardinality: 'single_current', temporal: 'optional',
    defaultSensitivity: 'sensitive', projectionBehavior: 'dossier', conflictStrategy: 'supersede_current',
  }),
  VISITED: define({
    predicate: 'VISITED', allowedSubjectTypes: PERSON, allowedObjectTypes: PLACES,
    inversePredicate: null, cardinality: 'append_only', temporal: 'required',
    defaultSensitivity: 'sensitive', projectionBehavior: 'episodic', conflictStrategy: 'coexist',
  }),
  INTERESTED_IN: define({
    predicate: 'INTERESTED_IN', allowedSubjectTypes: PERSON, allowedObjectTypes: TOPICAL,
    inversePredicate: null, cardinality: 'many', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'dossier', conflictStrategy: 'coexist',
  }),
  READ: define({
    predicate: 'READ', allowedSubjectTypes: PERSON,
    allowedObjectTypes: ['media_work', 'document'], inversePredicate: null,
    cardinality: 'append_only', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'episodic', conflictStrategy: 'coexist',
  }),
  WATCHED: define({
    predicate: 'WATCHED', allowedSubjectTypes: PERSON, allowedObjectTypes: ['media_work'],
    inversePredicate: null, cardinality: 'append_only', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'episodic', conflictStrategy: 'coexist',
  }),
  PLAYED: define({
    predicate: 'PLAYED', allowedSubjectTypes: PERSON,
    allowedObjectTypes: ['media_work', 'software'], inversePredicate: null,
    cardinality: 'append_only', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'episodic', conflictStrategy: 'coexist',
  }),
  DRIVES: define({
    predicate: 'DRIVES', allowedSubjectTypes: PERSON, allowedObjectTypes: ['vehicle'],
    inversePredicate: null, cardinality: 'many', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'dossier', conflictStrategy: 'coexist',
  }),
  RIDES: define({
    predicate: 'RIDES', allowedSubjectTypes: PERSON, allowedObjectTypes: ['vehicle'],
    inversePredicate: null, cardinality: 'many', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'dossier', conflictStrategy: 'coexist',
  }),
  HAS_GOAL: define({
    predicate: 'HAS_GOAL', allowedSubjectTypes: PERSON, allowedObjectTypes: ['goal'],
    inversePredicate: null, cardinality: 'many', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'core', conflictStrategy: 'coexist',
  }),
  HAS_PLAN: define({
    predicate: 'HAS_PLAN', allowedSubjectTypes: ['person', 'project', 'goal'],
    allowedObjectTypes: ['goal', 'project', 'episode'], inversePredicate: null,
    cardinality: 'many', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'dossier', conflictStrategy: 'coexist',
  }),
  HAS_ROUTINE: define({
    predicate: 'HAS_ROUTINE', allowedSubjectTypes: PERSON, allowedObjectTypes: ['routine'],
    inversePredicate: null, cardinality: 'many', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'core', conflictStrategy: 'supersede_current',
  }),
  // Two incompatible explicit constraints are the design's row-four conflict case, so this
  // predicate is exclusive per scope and disputes rather than silently superseding.
  HAS_CONSTRAINT: define({
    predicate: 'HAS_CONSTRAINT', allowedSubjectTypes: ['person', 'project', 'goal'],
    allowedObjectTypes: 'literal', inversePredicate: null,
    cardinality: 'single_per_scope', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'core', conflictStrategy: 'mark_disputed',
  }),
  HAS_SETTING: define({
    predicate: 'HAS_SETTING',
    allowedSubjectTypes: ['software', 'device', 'configuration_profile', 'model', 'inference_backend'],
    allowedObjectTypes: 'literal', inversePredicate: null,
    cardinality: 'single_per_scope', temporal: 'optional',
    defaultSensitivity: 'low', projectionBehavior: 'dossier', conflictStrategy: 'supersede_current',
  }),
  HAS_COMPONENT: define({
    predicate: 'HAS_COMPONENT',
    allowedSubjectTypes: ['device', 'software', 'vehicle', 'home_asset', 'project'],
    allowedObjectTypes: ['device', 'software', 'home_asset'], inversePredicate: 'PART_OF',
    cardinality: 'many', temporal: 'optional',
    defaultSensitivity: 'low', projectionBehavior: 'dossier', conflictStrategy: 'coexist',
  }),
  RUNS_ON: define({
    predicate: 'RUNS_ON', allowedSubjectTypes: ['software', 'model', 'project'],
    allowedObjectTypes: ['device', 'software', 'inference_backend'], inversePredicate: null,
    cardinality: 'many', temporal: 'optional',
    defaultSensitivity: 'low', projectionBehavior: 'dossier', conflictStrategy: 'coexist',
  }),
  DEPENDS_ON: define({
    predicate: 'DEPENDS_ON', allowedSubjectTypes: ['software', 'project', 'model', 'goal'],
    allowedObjectTypes: ['software', 'project', 'model', 'inference_backend', 'dataset'],
    inversePredicate: null, cardinality: 'many', temporal: 'optional',
    defaultSensitivity: 'low', projectionBehavior: 'dossier', conflictStrategy: 'coexist',
  }),
  CONFIGURED_WITH: define({
    predicate: 'CONFIGURED_WITH',
    allowedSubjectTypes: ['software', 'model', 'inference_backend', 'device'],
    allowedObjectTypes: ['configuration_profile'], inversePredicate: null,
    cardinality: 'single_current', temporal: 'optional',
    defaultSensitivity: 'low', projectionBehavior: 'dossier', conflictStrategy: 'supersede_current',
  }),
  COMPARED_WITH: define({
    predicate: 'COMPARED_WITH',
    allowedSubjectTypes: ['model', 'software', 'inference_backend', 'benchmark'],
    allowedObjectTypes: ['model', 'software', 'inference_backend'],
    inversePredicate: 'COMPARED_WITH', cardinality: 'many', temporal: 'optional',
    defaultSensitivity: 'low', projectionBehavior: 'episodic', conflictStrategy: 'coexist',
  }),
  TESTED_WITH: define({
    predicate: 'TESTED_WITH', allowedSubjectTypes: ['model', 'software', 'project'],
    allowedObjectTypes: ['benchmark', 'dataset', 'configuration_profile'],
    inversePredicate: null, cardinality: 'many', temporal: 'optional',
    defaultSensitivity: 'low', projectionBehavior: 'episodic', conflictStrategy: 'coexist',
  }),
  RESULTED_IN: define({
    predicate: 'RESULTED_IN',
    allowedSubjectTypes: ['event', 'episode', 'activity', 'benchmark'],
    allowedObjectTypes: ['event', 'episode', 'document', 'goal'],
    inversePredicate: 'CAUSED_BY', cardinality: 'append_only', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'episodic', conflictStrategy: 'coexist',
  }),
  CAUSED_BY: define({
    predicate: 'CAUSED_BY',
    allowedSubjectTypes: ['event', 'episode', 'document', 'goal'],
    allowedObjectTypes: ['event', 'episode', 'activity', 'benchmark'],
    inversePredicate: 'RESULTED_IN', cardinality: 'many', temporal: 'optional',
    defaultSensitivity: 'personal', projectionBehavior: 'episodic', conflictStrategy: 'coexist',
  }),
  RELATED_TO: define({
    predicate: 'RELATED_TO', allowedSubjectTypes: ANY, allowedObjectTypes: ANY,
    inversePredicate: 'RELATED_TO', cardinality: 'many', temporal: 'none',
    defaultSensitivity: 'low', projectionBehavior: 'never_project', conflictStrategy: 'coexist',
  }),
  PART_OF: define({
    predicate: 'PART_OF', allowedSubjectTypes: ['device', 'software', 'home_asset'],
    allowedObjectTypes: ['device', 'software', 'vehicle', 'home_asset', 'project'],
    inversePredicate: 'HAS_COMPONENT', cardinality: 'many', temporal: 'none',
    defaultSensitivity: 'low', projectionBehavior: 'dossier', conflictStrategy: 'coexist',
  }),
  ABOUT: define({
    predicate: 'ABOUT',
    allowedSubjectTypes: ['episode', 'event', 'document', 'activity', 'question_topic'],
    allowedObjectTypes: ANY, inversePredicate: null, cardinality: 'many', temporal: 'none',
    defaultSensitivity: 'personal', projectionBehavior: 'dossier', conflictStrategy: 'coexist',
  }),
  MENTIONED_IN: define({
    predicate: 'MENTIONED_IN', allowedSubjectTypes: ANY,
    allowedObjectTypes: ['document', 'episode', 'event'], inversePredicate: null,
    cardinality: 'append_only', temporal: 'none',
    defaultSensitivity: 'personal', projectionBehavior: 'never_project', conflictStrategy: 'coexist',
  }),
  OBSERVED_DURING: define({
    predicate: 'OBSERVED_DURING', allowedSubjectTypes: ANY, allowedObjectTypes: OCCURRENCES,
    inversePredicate: null, cardinality: 'append_only', temporal: 'required',
    defaultSensitivity: 'personal', projectionBehavior: 'episodic', conflictStrategy: 'coexist',
  }),
  ASKED_ABOUT: define({
    predicate: 'ASKED_ABOUT', allowedSubjectTypes: ['question_topic'], allowedObjectTypes: ANY,
    inversePredicate: null, cardinality: 'many', temporal: 'none',
    defaultSensitivity: 'personal', projectionBehavior: 'never_project', conflictStrategy: 'coexist',
  }),
} as const satisfies Record<RelationType, RelationDefinition>;

/** Throws on any predicate outside the registry. Model output must go through this. */
export function getRelationDefinition(predicate: string): RelationDefinition {
  const parsed = RelationTypeSchema.safeParse(predicate);
  if (!parsed.success) {
    throw new Error(`Unknown predicate: ${predicate}`);
  }
  return RELATION_DEFINITIONS[parsed.data];
}

export function isRelationType(predicate: string): predicate is RelationType {
  return RelationTypeSchema.safeParse(predicate).success;
}

export function isNodeTypeAllowedAsSubject(predicate: RelationType, nodeType: NodeType): boolean {
  return RELATION_DEFINITIONS[predicate].allowedSubjectTypes.includes(nodeType);
}

export function isNodeTypeAllowedAsObject(predicate: RelationType, nodeType: NodeType): boolean {
  const allowed = RELATION_DEFINITIONS[predicate].allowedObjectTypes;
  return allowed !== 'literal' && allowed.includes(nodeType);
}

export function allowsLiteralObject(predicate: RelationType): boolean {
  return RELATION_DEFINITIONS[predicate].allowedObjectTypes === 'literal';
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- assistant-registry`
Expected: PASS — 10 tests. If the inverse-symmetry test fails, fix the descriptor, not the test.

- [ ] **Step 6: Lint and commit**

```bash
npm run lint
git add src/assistant/domain/node-types.ts src/assistant/domain/relation-types.ts tests/assistant-registry.test.ts
git commit -m "feat(assistant): add node and relation type registries"
```

---

## Task 3: Clock and ID abstractions

**Files:**
- Create: `src/assistant/clock.ts`, `src/assistant/ids.ts`
- Test: `tests/assistant-keys.test.ts` (created here, extended in Task 4)

Determinism requirement (§19): every assistant service takes an injected clock and ID generator so
tests are reproducible. These are objects with methods, never bare functions passed around.

- [ ] **Step 1: Write the failing test**

Create `tests/assistant-keys.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { FixedClock, SystemClock } from '../src/assistant/clock.js';
import { RandomIdGenerator, SequentialIdGenerator } from '../src/assistant/ids.js';

test('FixedClock returns the configured instant and advances only on request', () => {
  const clock = new FixedClock('2026-08-05T10:00:00.000Z');
  assert.equal(clock.nowUtc(), '2026-08-05T10:00:00.000Z');
  assert.equal(clock.nowUtc(), '2026-08-05T10:00:00.000Z');
  clock.advanceSeconds(90);
  assert.equal(clock.nowUtc(), '2026-08-05T10:01:30.000Z');
  assert.equal(clock.nowEpochMs(), Date.parse('2026-08-05T10:01:30.000Z'));
});

test('FixedClock rejects a non-ISO instant', () => {
  assert.throws(() => new FixedClock('not-a-date'), /invalid instant/i);
});

test('SystemClock emits a UTC ISO-8601 instant', () => {
  const value = new SystemClock().nowUtc();
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('SequentialIdGenerator is deterministic and prefixed', () => {
  const ids = new SequentialIdGenerator();
  assert.equal(ids.next('node'), 'node_0001');
  assert.equal(ids.next('node'), 'node_0002');
  assert.equal(ids.next('ast'), 'ast_0003');
});

test('RandomIdGenerator emits unique prefixed ids', () => {
  const ids = new RandomIdGenerator();
  const first = ids.next('ast');
  const second = ids.next('ast');
  assert.notEqual(first, second);
  assert.ok(first.startsWith('ast_'));
  assert.ok(first.length > 10);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- assistant-keys`
Expected: FAIL — `Cannot find module '../src/assistant/clock.js'`

- [ ] **Step 3: Write `src/assistant/clock.ts`**

```ts
/** Source of the current instant. Injected so tests are reproducible. */
export interface Clock {
  /** UTC ISO-8601 with milliseconds, e.g. 2026-08-05T10:00:00.000Z. */
  nowUtc(): string;
  nowEpochMs(): number;
}

export class SystemClock implements Clock {
  nowUtc(): string {
    return new Date().toISOString();
  }

  nowEpochMs(): number {
    return Date.now();
  }
}

/** Test clock. Time only moves when a test moves it. */
export class FixedClock implements Clock {
  private epochMs: number;

  constructor(instantUtc: string) {
    const parsed = Date.parse(instantUtc);
    if (Number.isNaN(parsed)) {
      throw new Error(`Invalid instant for FixedClock: ${instantUtc}`);
    }
    this.epochMs = parsed;
  }

  nowUtc(): string {
    return new Date(this.epochMs).toISOString();
  }

  nowEpochMs(): number {
    return this.epochMs;
  }

  advanceSeconds(seconds: number): void {
    this.epochMs += Math.round(seconds * 1000);
  }

  advanceDays(days: number): void {
    this.advanceSeconds(days * 86_400);
  }
}
```

- [ ] **Step 4: Write `src/assistant/ids.ts`**

```ts
import { randomUUID } from 'node:crypto';

/**
 * Opaque identifier source. `prefix` names the row family (`node`, `ast`, `ev`, ...)
 * so an id is self-describing in a log or an export.
 */
export interface IdGenerator {
  next(prefix: string): string;
}

export class RandomIdGenerator implements IdGenerator {
  next(prefix: string): string {
    return `${prefix}_${randomUUID().replace(/-/g, '')}`;
  }
}

/** Test generator. One shared counter so ordering across families stays observable. */
export class SequentialIdGenerator implements IdGenerator {
  private counter = 0;

  next(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${String(this.counter).padStart(4, '0')}`;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- assistant-keys`
Expected: PASS — 5 tests.

- [ ] **Step 6: Lint and commit**

```bash
npm run lint
git add src/assistant/clock.ts src/assistant/ids.ts tests/assistant-keys.test.ts
git commit -m "feat(assistant): add injectable clock and id generator"
```

---

## Task 4: Derived keys and normalization

**Files:**
- Create: `src/assistant/domain/keys.ts`
- Modify: `tests/assistant-keys.test.ts` (append)

Implements §5.4.1. These three derivations are what make the uniqueness indexes mean anything, so
each gets a stability test asserting the same input yields the same key.

- [ ] **Step 1: Write the failing test**

Append to `tests/assistant-keys.test.ts`:

```ts
import {
  buildAssertionKey,
  buildCandidateFingerprint,
  hashBytes,
  hashTextContent,
  normalizeAliasText,
  normalizeLiteralValue,
} from '../src/assistant/domain/keys.js';

test('alias normalization trims, NFC-normalizes, collapses whitespace, and lowercases', () => {
  assert.equal(normalizeAliasText('  Visual   Studio Code  '), 'visual studio code');
  assert.equal(normalizeAliasText('Cafe\u0301'), normalizeAliasText('Caf\u00e9'));
});

test('literal normalization is type-directed', () => {
  assert.equal(normalizeLiteralValue('string', '  PowerShell  '), 'powershell');
  assert.equal(normalizeLiteralValue('integer', 42), '42');
  assert.equal(normalizeLiteralValue('number', 1.5000), '1.5');
  assert.equal(normalizeLiteralValue('boolean', true), 'true');
  assert.equal(normalizeLiteralValue('date', '2026-08-05'), '2026-08-05');
  assert.equal(
    normalizeLiteralValue('datetime', '2026-08-05T12:00:00+02:00'),
    '2026-08-05T10:00:00.000Z',
  );
  assert.equal(normalizeLiteralValue('quantity', { amount: 24, unit: 'GB' }), '24 gb');
  assert.equal(normalizeLiteralValue('duration', 'PT30M'), 'PT30M');
  assert.equal(normalizeLiteralValue('json', { b: 1, a: 2 }), '{"a":2,"b":1}');
});

test('literal normalization rejects a value that does not match its declared type', () => {
  assert.throws(() => normalizeLiteralValue('integer', 1.5), /integer/i);
  assert.throws(() => normalizeLiteralValue('datetime', 'yesterday'), /datetime/i);
  assert.throws(() => normalizeLiteralValue('quantity', 'lots'), /quantity/i);
});

test('assertion key is stable, scope-sensitive, and object-kind sensitive', () => {
  const base = {
    ownerId: 'own_1',
    subjectNodeId: 'node_1',
    predicate: 'PREFERS',
    scopeNodeId: null,
  } as const;
  const nodeObject = buildAssertionKey({ ...base, object: { kind: 'node', nodeId: 'node_2' } });
  const sameAgain = buildAssertionKey({ ...base, object: { kind: 'node', nodeId: 'node_2' } });
  assert.equal(nodeObject, sameAgain);
  assert.match(nodeObject, /^[0-9a-f]{64}$/);

  const scoped = buildAssertionKey({
    ...base,
    scopeNodeId: 'node_scope',
    object: { kind: 'node', nodeId: 'node_2' },
  });
  assert.notEqual(nodeObject, scoped);

  const literalObject = buildAssertionKey({
    ...base,
    object: { kind: 'literal', valueType: 'string', value: 'PowerShell' },
  });
  const literalCasing = buildAssertionKey({
    ...base,
    object: { kind: 'literal', valueType: 'string', value: '  powershell ' },
  });
  assert.equal(literalObject, literalCasing);
  assert.notEqual(literalObject, nodeObject);
});

test('candidate fingerprint collides for the same unresolved proposal', () => {
  const first = buildCandidateFingerprint({
    ownerId: 'own_1',
    subject: { nodeType: 'person', displayName: 'Denys' },
    predicate: 'USES',
    object: { kind: 'unresolved', nodeType: 'software', displayName: '  PowerShell ' },
    scope: null,
  });
  const second = buildCandidateFingerprint({
    ownerId: 'own_1',
    subject: { nodeType: 'person', displayName: 'denys' },
    predicate: 'USES',
    object: { kind: 'unresolved', nodeType: 'software', displayName: 'PowerShell' },
    scope: null,
  });
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test('text content hash normalizes line endings and Unicode form', () => {
  assert.equal(hashTextContent('a\r\nb'), hashTextContent('a\nb'));
  assert.equal(hashTextContent('Cafe\u0301'), hashTextContent('Caf\u00e9'));
  assert.notEqual(hashTextContent('a'), hashTextContent('b'));
});

test('byte hash is raw SHA-256, distinct from the text hash pipeline', () => {
  assert.match(hashBytes(Buffer.from([1, 2, 3])), /^[0-9a-f]{64}$/);
  assert.equal(hashBytes(Buffer.from('abc', 'utf8')), hashBytes(Buffer.from('abc', 'utf8')));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- assistant-keys`
Expected: FAIL — `Cannot find module '../src/assistant/domain/keys.js'`

- [ ] **Step 3: Write `src/assistant/domain/keys.ts`**

```ts
import { createHash } from 'node:crypto';

import { isJsonObject, type JsonValue } from '../../lib/json-types.js';
import type { ObjectValueType } from './enums.js';
import type { NodeType } from './node-types.js';
import type { RelationType } from './relation-types.js';

// ASCII unit separator (U+001F): cannot occur in an id, a predicate, or a normalized
// literal, so no two distinct tuples can concatenate to the same string.
const KEY_SEPARATOR = '\u001f'; // ASCII unit separator: impossible inside an id, predicate, or normalized literal

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Trim, NFC-normalize, collapse internal whitespace, lowercase. */
export function normalizeAliasText(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function shortestNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`Literal number must be finite: ${value}`);
  }
  return String(value);
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (isJsonObject(value)) {
    const keys = Object.keys(value).sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Deterministic normalization of a literal object value, keyed off its declared type.
 * A value that cannot satisfy its declared type throws — silently coercing would let two
 * different facts collapse onto one assertion key.
 */
export function normalizeLiteralValue(valueType: ObjectValueType, value: JsonValue): string {
  switch (valueType) {
    case 'string': {
      if (typeof value !== 'string') throw new Error('Literal string expects a string value.');
      return normalizeAliasText(value);
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new Error('Literal integer expects an integer value.');
      }
      return String(value);
    }
    case 'number': {
      if (typeof value !== 'number') throw new Error('Literal number expects a numeric value.');
      return shortestNumber(value);
    }
    case 'boolean': {
      if (typeof value !== 'boolean') throw new Error('Literal boolean expects a boolean value.');
      return value ? 'true' : 'false';
    }
    case 'date': {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error('Literal date expects YYYY-MM-DD.');
      }
      return value;
    }
    case 'datetime': {
      if (typeof value !== 'string') throw new Error('Literal datetime expects a string.');
      const parsed = Date.parse(value);
      if (Number.isNaN(parsed)) throw new Error(`Literal datetime is unparseable: ${value}`);
      return new Date(parsed).toISOString();
    }
    case 'duration': {
      if (typeof value !== 'string' || !/^P/.test(value)) {
        throw new Error('Literal duration expects an ISO-8601 duration.');
      }
      return value;
    }
    case 'quantity': {
      if (!isJsonObject(value)) throw new Error('Literal quantity expects { amount, unit }.');
      const amount = value.amount;
      const unit = value.unit;
      if (typeof amount !== 'number' || typeof unit !== 'string') {
        throw new Error('Literal quantity expects { amount: number, unit: string }.');
      }
      return `${shortestNumber(amount)} ${unit.trim().toLowerCase()}`;
    }
    case 'json': {
      return canonicalJson(value);
    }
  }
}

export type AssertionObjectRef =
  | { readonly kind: 'node'; readonly nodeId: string }
  | { readonly kind: 'literal'; readonly valueType: ObjectValueType; readonly value: JsonValue };

export interface AssertionKeyInput {
  readonly ownerId: string;
  readonly subjectNodeId: string;
  readonly predicate: RelationType;
  readonly object: AssertionObjectRef;
  readonly scopeNodeId: string | null;
}

function assertionObjectKey(object: AssertionObjectRef): string {
  return object.kind === 'node'
    ? `node:${object.nodeId}`
    : `literal:${object.valueType}:${normalizeLiteralValue(object.valueType, object.value)}`;
}

/**
 * SHA-256 over ownerId, subjectNodeId, predicate, objectKey, scopeNodeId.
 * Backs `graph_assertions_active_key_uq`: at most one live assertion of this exact shape.
 */
export function buildAssertionKey(input: AssertionKeyInput): string {
  return sha256Hex([
    input.ownerId,
    input.subjectNodeId,
    input.predicate,
    assertionObjectKey(input.object),
    input.scopeNodeId ?? '',
  ].join(KEY_SEPARATOR));
}

export interface UnresolvedNodeRef {
  readonly nodeType: NodeType;
  readonly displayName: string;
}

export type CandidateObjectRef =
  | { readonly kind: 'unresolved'; readonly nodeType: NodeType; readonly displayName: string }
  | { readonly kind: 'literal'; readonly valueType: ObjectValueType; readonly value: JsonValue };

export interface CandidateFingerprintInput {
  readonly ownerId: string;
  readonly subject: UnresolvedNodeRef;
  readonly predicate: RelationType;
  readonly object: CandidateObjectRef;
  readonly scope: UnresolvedNodeRef | null;
}

function unresolvedKey(ref: UnresolvedNodeRef): string {
  return `${ref.nodeType}:${normalizeAliasText(ref.displayName)}`;
}

/**
 * Same tuple shape as the assertion key but built from unresolved references, so duplicate
 * proposals collide before entity resolution runs.
 */
export function buildCandidateFingerprint(input: CandidateFingerprintInput): string {
  const objectKey = input.object.kind === 'unresolved'
    ? `node:${unresolvedKey(input.object)}`
    : `literal:${input.object.valueType}:${normalizeLiteralValue(input.object.valueType, input.object.value)}`;
  return sha256Hex([
    input.ownerId,
    unresolvedKey(input.subject),
    input.predicate,
    objectKey,
    input.scope === null ? '' : unresolvedKey(input.scope),
  ].join(KEY_SEPARATOR));
}

/** SHA-256 of text after Unicode NFC and line-ending normalization, so re-ingest deduplicates. */
export function hashTextContent(text: string): string {
  return sha256Hex(text.normalize('NFC').replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
}

/** SHA-256 of raw payload bytes. */
export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- assistant-keys`
Expected: PASS — 12 tests.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/assistant/domain/keys.ts tests/assistant-keys.test.ts
git commit -m "feat(assistant): add derived key and normalization functions"
```

---

## Task 5: Confidence ceilings and aggregation

**Files:**
- Create: `src/assistant/domain/confidence.ts`
- Test: `tests/assistant-confidence.test.ts`

Implements §4.6 minus the staleness function, which lands with tier routing in Gate B.

- [ ] **Step 1: Write the failing test**

Create `tests/assistant-confidence.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BASIS_CONFIDENCE_CEILING,
  SINGLE_SCREENSHOT_TEXT_CEILING,
  aggregateSupport,
  resolveConfidence,
} from '../src/assistant/domain/confidence.js';

test('every basis has a ceiling and explicit bases outrank passive ones', () => {
  assert.equal(BASIS_CONFIDENCE_CEILING.explicit_user_statement, 0.99);
  assert.equal(BASIS_CONFIDENCE_CEILING.explicit_question_answer, 0.98);
  assert.equal(BASIS_CONFIDENCE_CEILING.manual_import, 0.95);
  assert.equal(BASIS_CONFIDENCE_CEILING.passive_observation, 0.85);
  assert.equal(BASIS_CONFIDENCE_CEILING.derived_aggregation, 0.8);
  assert.equal(BASIS_CONFIDENCE_CEILING.assistant_inference, 0.75);
  assert.equal(SINGLE_SCREENSHOT_TEXT_CEILING, 0.55);
});

test('aggregateSupport is the noisy-or of independent evidence weights', () => {
  assert.equal(aggregateSupport([]), 0);
  assert.equal(aggregateSupport([0.5]), 0.5);
  assert.ok(Math.abs(aggregateSupport([0.5, 0.5]) - 0.75) < 1e-9);
  assert.ok(Math.abs(aggregateSupport([0.9, 0.9, 0.9]) - 0.999) < 1e-9);
  assert.ok(aggregateSupport([0.99, 0.99, 0.99]) < 1);
});

test('aggregateSupport rejects a weight outside [0, 1]', () => {
  assert.throws(() => aggregateSupport([1.5]), /weight/i);
  assert.throws(() => aggregateSupport([-0.1]), /weight/i);
});

test('resolveConfidence clamps to the basis ceiling', () => {
  const resolved = resolveConfidence({
    basis: 'passive_observation',
    supportWeights: [0.99, 0.99, 0.99],
    contradictionCount: 0,
    singleScreenshotTextObservation: false,
    userCorrected: false,
  });
  assert.equal(resolved, 0.85);
});

test('a single screenshot-text observation is clamped to 0.55 regardless of basis', () => {
  const resolved = resolveConfidence({
    basis: 'passive_observation',
    supportWeights: [0.95],
    contradictionCount: 0,
    singleScreenshotTextObservation: true,
    userCorrected: false,
  });
  assert.equal(resolved, 0.55);
});

test('contradictions reduce confidence monotonically', () => {
  const none = resolveConfidence({
    basis: 'explicit_user_statement', supportWeights: [0.9],
    contradictionCount: 0, singleScreenshotTextObservation: false, userCorrected: false,
  });
  const one = resolveConfidence({
    basis: 'explicit_user_statement', supportWeights: [0.9],
    contradictionCount: 1, singleScreenshotTextObservation: false, userCorrected: false,
  });
  const two = resolveConfidence({
    basis: 'explicit_user_statement', supportWeights: [0.9],
    contradictionCount: 2, singleScreenshotTextObservation: false, userCorrected: false,
  });
  assert.ok(none > one);
  assert.ok(one > two);
  assert.ok(two >= 0);
});

test('an explicit user correction pins confidence at 1.00 and ignores contradictions', () => {
  const resolved = resolveConfidence({
    basis: 'explicit_user_statement',
    supportWeights: [0.1],
    contradictionCount: 5,
    singleScreenshotTextObservation: false,
    userCorrected: true,
  });
  assert.equal(resolved, 1);
});

test('a user correction is only honoured for an explicit basis', () => {
  assert.throws(
    () => resolveConfidence({
      basis: 'passive_observation', supportWeights: [0.9],
      contradictionCount: 0, singleScreenshotTextObservation: false, userCorrected: true,
    }),
    /explicit basis/i,
  );
});

test('resolved confidence always lands inside [0, 1]', () => {
  for (const weights of [[], [0], [1], [1, 1, 1], [0.3, 0.7]]) {
    for (const contradictions of [0, 1, 10]) {
      const resolved = resolveConfidence({
        basis: 'derived_aggregation',
        supportWeights: weights,
        contradictionCount: contradictions,
        singleScreenshotTextObservation: false,
        userCorrected: false,
      });
      assert.ok(resolved >= 0 && resolved <= 1, `out of range: ${resolved}`);
    }
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- assistant-confidence`
Expected: FAIL — `Cannot find module '../src/assistant/domain/confidence.js'`

- [ ] **Step 3: Write `src/assistant/domain/confidence.ts`**

```ts
import { type AssertionBasis, isExplicitBasis } from './enums.js';

/** Maximum automatic confidence per basis (§4.6). Confidence never substitutes for basis. */
export const BASIS_CONFIDENCE_CEILING = {
  explicit_user_statement: 0.99,
  explicit_question_answer: 0.98,
  manual_import: 0.95,
  passive_observation: 0.85,
  derived_aggregation: 0.8,
  assistant_inference: 0.75,
} as const satisfies Record<AssertionBasis, number>;

/** An explicit user correction is the only path to 1.00. */
export const USER_CORRECTION_CONFIDENCE = 1;

/** A candidate derived from one screenshot-text observation is clamped here (§8.3). */
export const SINGLE_SCREENSHOT_TEXT_CEILING = 0.55;

/** Each additional contradicting evidence cluster divides support by this much more. */
const CONTRADICTION_PENALTY_PER_CLUSTER = 0.5;

/** support = 1 - Product(1 - weight_i) over independent evidence clusters. */
export function aggregateSupport(weights: readonly number[]): number {
  let inverse = 1;
  for (const weight of weights) {
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
      throw new Error(`Evidence weight must be within [0, 1]: ${weight}`);
    }
    inverse *= 1 - weight;
  }
  return 1 - inverse;
}

export interface ConfidenceInput {
  readonly basis: AssertionBasis;
  readonly supportWeights: readonly number[];
  readonly contradictionCount: number;
  readonly singleScreenshotTextObservation: boolean;
  readonly userCorrected: boolean;
}

/**
 * Applies, in order: aggregation, basis ceiling, single-screenshot clamp,
 * contradiction penalty, explicit-user override.
 */
export function resolveConfidence(input: ConfidenceInput): number {
  if (input.userCorrected) {
    if (!isExplicitBasis(input.basis)) {
      throw new Error(`A user correction requires an explicit basis, received: ${input.basis}`);
    }
    return USER_CORRECTION_CONFIDENCE;
  }
  if (input.contradictionCount < 0 || !Number.isInteger(input.contradictionCount)) {
    throw new Error(`Contradiction count must be a non-negative integer: ${input.contradictionCount}`);
  }

  const aggregated = aggregateSupport(input.supportWeights);
  const ceiling = input.singleScreenshotTextObservation
    ? Math.min(SINGLE_SCREENSHOT_TEXT_CEILING, BASIS_CONFIDENCE_CEILING[input.basis])
    : BASIS_CONFIDENCE_CEILING[input.basis];
  const capped = Math.min(aggregated, ceiling);
  const penalised = capped / (1 + input.contradictionCount * CONTRADICTION_PENALTY_PER_CLUSTER);
  return Math.min(1, Math.max(0, penalised));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- assistant-confidence`
Expected: PASS — 9 tests.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/assistant/domain/confidence.ts tests/assistant-confidence.test.ts
git commit -m "feat(assistant): add confidence ceilings and aggregation"
```

---

## Task 6: Assistant schema module

**Files:**
- Create: `src/assistant/storage/schema.ts`
- Test: covered by Task 7's migration test

This task only defines the SQL and the seeding logic. Task 7 wires it into the ladder. The DDL is
normative — copy it exactly from design §5.2, §5.3, and the Gate A subset of §5.4.

Gate A creates only the tables it needs. `memory_projections` (Gate B), the question/job/retrieval
tables (Gate C), and the activity/capture tables (Gate D) are **not** created here; each later gate
appends its own migration step. `candidate_assertions` and `observations` **are** created here
because the entity resolver and validator reference their shapes.

- [ ] **Step 1: Write `src/assistant/storage/schema.ts`**

```ts
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { Clock } from '../clock.js';
import { NODE_TYPE_DEFINITIONS, NODE_TYPES } from '../domain/node-types.js';
import { RELATION_DEFINITIONS, RELATION_TYPES } from '../domain/relation-types.js';

/** The single owner row id. One human user per installation (design: out of scope, multi-user). */
export const LOCAL_OWNER_ID = 'own_local';
/** Runtime metadata key holding the monotonic graph version. */
export const GRAPH_VERSION_METADATA_KEY = 'assistant.graph_version';
/** Runtime metadata key holding the id of this machine's device row. */
export const LOCAL_DEVICE_METADATA_KEY = 'assistant.local_device_id';

export const ASSISTANT_CORE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS assistant_owners (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    created_at_utc TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assistant_devices (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES assistant_owners(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    display_name TEXT NOT NULL,
    public_key TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    created_at_utc TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS graph_node_types (
    name TEXT PRIMARY KEY,
    definition TEXT NOT NULL,
    created_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS graph_relation_types (
    name TEXT PRIMARY KEY,
    definition_json TEXT NOT NULL,
    created_at_utc TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS graph_nodes (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES assistant_owners(id) ON DELETE CASCADE,
    type TEXT NOT NULL REFERENCES graph_node_types(name),
    canonical_key TEXT,
    display_name TEXT NOT NULL,
    description TEXT,
    sensitivity TEXT NOT NULL CHECK (
        sensitivity IN ('low', 'personal', 'sensitive', 'highly_sensitive', 'secret_prohibited')),
    status TEXT NOT NULL CHECK (status IN ('active', 'merged', 'archived', 'deleted')),
    properties_json TEXT NOT NULL DEFAULT '{}',
    merged_into_node_id TEXT REFERENCES graph_nodes(id),
    created_at_utc TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL,
    deleted_at_utc TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS graph_nodes_owner_type_key_uq
  ON graph_nodes(owner_id, type, canonical_key)
  WHERE canonical_key IS NOT NULL AND status <> 'deleted';
CREATE INDEX IF NOT EXISTS graph_nodes_owner_type_idx ON graph_nodes(owner_id, type, status);

CREATE TABLE IF NOT EXISTS graph_node_aliases (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES assistant_owners(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
    alias TEXT NOT NULL,
    normalized_alias TEXT NOT NULL,
    alias_type TEXT NOT NULL CHECK (
        alias_type IN ('name', 'handle', 'model', 'path', 'identifier', 'user_supplied')),
    source_evidence_id TEXT,
    created_at_utc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS graph_node_aliases_lookup_idx
  ON graph_node_aliases(owner_id, normalized_alias);

CREATE TABLE IF NOT EXISTS evidence_blobs (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES assistant_owners(id) ON DELETE CASCADE,
    content_hash TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    mime_type TEXT NOT NULL,
    storage_uri TEXT NOT NULL,
    encrypted INTEGER NOT NULL CHECK (encrypted IN (0, 1)),
    key_id TEXT,
    created_at_utc TEXT NOT NULL,
    deleted_at_utc TEXT,
    UNIQUE(owner_id, content_hash)
);

CREATE TABLE IF NOT EXISTS evidence_records (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES assistant_owners(id) ON DELETE CASCADE,
    device_id TEXT REFERENCES assistant_devices(id) ON DELETE SET NULL,
    source_event_id TEXT NOT NULL,
    parent_evidence_id TEXT REFERENCES evidence_records(id) ON DELETE SET NULL,
    blob_id TEXT REFERENCES evidence_blobs(id) ON DELETE SET NULL,
    source_type TEXT NOT NULL CHECK (source_type IN (
        'conversation_message', 'question_answer', 'manual_correction', 'manual_import',
        'desktop_activity', 'screenshot', 'accessibility_snapshot', 'ocr_result', 'mobile_event')),
    source_ref TEXT,
    captured_at_utc TEXT NOT NULL,
    source_timezone TEXT,
    ingested_at_utc TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    mime_type TEXT,
    sensitivity TEXT NOT NULL CHECK (
        sensitivity IN ('low', 'personal', 'sensitive', 'highly_sensitive', 'secret_prohibited')),
    retention_until_utc TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'quarantined', 'deleted')),
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at_utc TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL,
    UNIQUE(owner_id, source_event_id)
);
CREATE INDEX IF NOT EXISTS evidence_owner_hash_idx
  ON evidence_records(owner_id, content_hash, source_type, captured_at_utc);
CREATE INDEX IF NOT EXISTS evidence_retention_idx
  ON evidence_records(status, retention_until_utc);

CREATE TABLE IF NOT EXISTS observations (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES assistant_owners(id) ON DELETE CASCADE,
    evidence_id TEXT NOT NULL REFERENCES evidence_records(id) ON DELETE CASCADE,
    observation_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
    sensitivity TEXT NOT NULL CHECK (
        sensitivity IN ('low', 'personal', 'sensitive', 'highly_sensitive', 'secret_prohibited')),
    extractor_name TEXT NOT NULL,
    extractor_version TEXT NOT NULL,
    created_at_utc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS observations_evidence_idx ON observations(evidence_id);

CREATE TABLE IF NOT EXISTS candidate_assertions (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES assistant_owners(id) ON DELETE CASCADE,
    observation_id TEXT REFERENCES observations(id) ON DELETE SET NULL,
    candidate_fingerprint TEXT NOT NULL,
    subject_ref_json TEXT NOT NULL,
    predicate TEXT NOT NULL REFERENCES graph_relation_types(name),
    object_ref_json TEXT NOT NULL,
    scope_ref_json TEXT,
    basis TEXT NOT NULL CHECK (basis IN (
        'explicit_user_statement', 'explicit_question_answer', 'manual_import',
        'passive_observation', 'derived_aggregation', 'assistant_inference')),
    confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
    sensitivity TEXT NOT NULL CHECK (
        sensitivity IN ('low', 'personal', 'sensitive', 'highly_sensitive', 'secret_prohibited')),
    valid_from_utc TEXT,
    valid_to_utc TEXT,
    rationale TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'accepted', 'rejected', 'needs_confirmation', 'superseded')),
    rejection_reason TEXT,
    created_at_utc TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS candidate_assertions_status_idx
  ON candidate_assertions(owner_id, status, created_at_utc);
CREATE UNIQUE INDEX IF NOT EXISTS candidate_assertions_fingerprint_uq
  ON candidate_assertions(owner_id, candidate_fingerprint, observation_id);

CREATE TABLE IF NOT EXISTS graph_assertions (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES assistant_owners(id) ON DELETE CASCADE,
    assertion_key TEXT NOT NULL,
    subject_node_id TEXT NOT NULL REFERENCES graph_nodes(id),
    predicate TEXT NOT NULL REFERENCES graph_relation_types(name),
    object_kind TEXT NOT NULL CHECK (object_kind IN ('node', 'literal')),
    object_node_id TEXT REFERENCES graph_nodes(id),
    object_value_type TEXT CHECK (object_value_type IN (
        'string', 'integer', 'number', 'boolean', 'date', 'datetime',
        'duration', 'quantity', 'json')),
    object_value_json TEXT,
    object_normalized_text TEXT,
    scope_node_id TEXT REFERENCES graph_nodes(id),
    status TEXT NOT NULL CHECK (status IN (
        'active', 'disputed', 'superseded', 'rejected', 'expired', 'deleted')),
    basis TEXT NOT NULL CHECK (basis IN (
        'explicit_user_statement', 'explicit_question_answer', 'manual_import',
        'passive_observation', 'derived_aggregation', 'assistant_inference')),
    confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
    sensitivity TEXT NOT NULL CHECK (
        sensitivity IN ('low', 'personal', 'sensitive', 'highly_sensitive', 'secret_prohibited')),
    valid_from_utc TEXT,
    valid_to_utc TEXT,
    first_observed_at_utc TEXT NOT NULL,
    last_observed_at_utc TEXT NOT NULL,
    recorded_at_utc TEXT NOT NULL,
    retired_at_utc TEXT,
    supersedes_assertion_id TEXT REFERENCES graph_assertions(id),
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    attributes_json TEXT NOT NULL DEFAULT '{}',
    created_at_utc TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL,
    CHECK (
        (object_kind = 'node' AND object_node_id IS NOT NULL AND object_value_json IS NULL)
        OR
        (object_kind = 'literal' AND object_node_id IS NULL AND object_value_json IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS graph_assertions_active_key_uq
  ON graph_assertions(owner_id, assertion_key) WHERE status IN ('active', 'disputed');
CREATE INDEX IF NOT EXISTS graph_assertions_subject_idx
  ON graph_assertions(owner_id, subject_node_id, predicate, status);
CREATE INDEX IF NOT EXISTS graph_assertions_object_node_idx
  ON graph_assertions(owner_id, object_node_id, predicate, status)
  WHERE object_node_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS graph_assertions_scope_idx
  ON graph_assertions(owner_id, scope_node_id, status) WHERE scope_node_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS graph_assertions_current_idx
  ON graph_assertions(owner_id, status, valid_to_utc, last_observed_at_utc);

CREATE TABLE IF NOT EXISTS assertion_evidence (
    assertion_id TEXT NOT NULL REFERENCES graph_assertions(id) ON DELETE CASCADE,
    evidence_id TEXT NOT NULL REFERENCES evidence_records(id) ON DELETE CASCADE,
    stance TEXT NOT NULL CHECK (stance IN ('supports', 'contradicts', 'context')),
    weight REAL NOT NULL CHECK (weight >= 0.0 AND weight <= 1.0),
    created_at_utc TEXT NOT NULL,
    PRIMARY KEY (assertion_id, evidence_id, stance)
);

CREATE TABLE IF NOT EXISTS graph_entity_merges (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES assistant_owners(id) ON DELETE CASCADE,
    source_node_id TEXT NOT NULL REFERENCES graph_nodes(id),
    target_node_id TEXT NOT NULL REFERENCES graph_nodes(id),
    basis TEXT NOT NULL,
    reversible INTEGER NOT NULL DEFAULT 1 CHECK (reversible IN (0, 1)),
    created_at_utc TEXT NOT NULL,
    reversed_at_utc TEXT
);

CREATE TABLE IF NOT EXISTS graph_mutation_log (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES assistant_owners(id) ON DELETE CASCADE,
    actor_type TEXT NOT NULL CHECK (
        actor_type IN ('user', 'system', 'assistant_proposal', 'migration')),
    actor_ref TEXT,
    operation TEXT NOT NULL CHECK (operation IN (
        'create_node', 'update_node', 'merge_node', 'unmerge_node', 'create_assertion',
        'confirm_assertion', 'update_assertion', 'supersede_assertion', 'dispute_assertion',
        'reject_assertion', 'expire_assertion', 'delete_assertion', 'delete_evidence',
        'update_policy')),
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    reason TEXT NOT NULL,
    created_at_utc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS graph_mutation_target_idx
  ON graph_mutation_log(owner_id, target_type, target_id, created_at_utc);

CREATE TABLE IF NOT EXISTS assistant_policies (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES assistant_owners(id) ON DELETE CASCADE,
    policy_type TEXT NOT NULL CHECK (policy_type IN (
        'blocked_question_topic', 'never_infer_topic', 'capture_exclusion',
        'do_not_merge_node', 'assertion_lock')),
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    source TEXT NOT NULL CHECK (source IN ('default', 'user', 'migration')),
    created_at_utc TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL,
    UNIQUE(owner_id, policy_type, key)
);

CREATE TABLE IF NOT EXISTS assistant_audit_events (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES assistant_owners(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    summary TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at_utc TEXT NOT NULL
);
`;

export const ASSISTANT_FTS_SCHEMA_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS graph_nodes_fts USING fts5(
    node_id UNINDEXED, owner_id UNINDEXED,
    display_name, aliases, description, tokenize = 'unicode61');

CREATE VIRTUAL TABLE IF NOT EXISTS graph_assertions_fts USING fts5(
    assertion_id UNINDEXED, owner_id UNINDEXED,
    subject_text, predicate_text, object_text, scope_text, tokenize = 'unicode61');
`;

/**
 * Seeds the registry tables, the single owner row, and this machine's device row from the
 * TypeScript registries. The registry constants are the source of truth; these rows are their
 * projection, so seeding is a full upsert and is safe to re-run.
 */
export function seedAssistantRegistries(
  database: RuntimeDatabase,
  clock: Clock,
  localDeviceId: string,
  ownerDisplayName: string,
): void {
  const nowUtc = clock.nowUtc();

  const insertNodeType = database.prepare(`
    INSERT INTO graph_node_types (name, definition, created_at_utc)
    VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET definition = excluded.definition
  `);
  for (const nodeType of NODE_TYPES) {
    insertNodeType.run(nodeType, NODE_TYPE_DEFINITIONS[nodeType], nowUtc);
  }

  const insertRelationType = database.prepare(`
    INSERT INTO graph_relation_types (name, definition_json, created_at_utc, updated_at_utc)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      definition_json = excluded.definition_json,
      updated_at_utc = excluded.updated_at_utc
  `);
  for (const predicate of RELATION_TYPES) {
    insertRelationType.run(
      predicate,
      JSON.stringify(RELATION_DEFINITIONS[predicate]),
      nowUtc,
      nowUtc,
    );
  }

  database.prepare(`
    INSERT INTO assistant_owners (id, display_name, created_at_utc, updated_at_utc)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(LOCAL_OWNER_ID, ownerDisplayName, nowUtc, nowUtc);

  database.prepare(`
    INSERT INTO assistant_devices (
      id, owner_id, platform, display_name, public_key, status, created_at_utc, updated_at_utc
    ) VALUES (?, ?, ?, ?, NULL, 'active', ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(localDeviceId, LOCAL_OWNER_ID, process.platform, 'This device', nowUtc, nowUtc);

  database.prepare(`
    INSERT INTO runtime_metadata (key, value, updated_at_utc)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO NOTHING
  `).run(GRAPH_VERSION_METADATA_KEY, '0', nowUtc);

  database.prepare(`
    INSERT INTO runtime_metadata (key, value, updated_at_utc)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO NOTHING
  `).run(LOCAL_DEVICE_METADATA_KEY, localDeviceId, nowUtc);
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck:test`
Expected: no errors. (`schema.ts` is not imported anywhere yet; this only proves it compiles.)

- [ ] **Step 3: Commit**

```bash
npm run lint
git add src/assistant/storage/schema.ts
git commit -m "feat(assistant): add graph schema DDL and registry seeding"
```

---

## Task 7: Migration steps v39 and v40

**Files:**
- Modify: `src/state/runtime-db.ts:37` (`CURRENT_SCHEMA_VERSION` 38 → 40)
- Modify: `src/state/runtime-db.ts:1419-1428` (insert two blocks after the v38 block, before the
  sub-schema calls at the end of `ensureSchema`)
- Create: `tests/assistant-migration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/assistant-migration.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';
import { z } from 'zod';

import { RELATION_TYPES } from '../src/assistant/domain/relation-types.js';
import { NODE_TYPES } from '../src/assistant/domain/node-types.js';
import { LOCAL_OWNER_ID } from '../src/assistant/storage/schema.js';
import {
  CURRENT_SCHEMA_VERSION,
  closeRuntimeDatabase,
  getRuntimeDatabase,
} from '../src/state/runtime-db.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const NameRowSchema = z.array(z.object({ name: z.string() }));
const CountRowSchema = z.object({ count: z.number() });
const VersionRowSchema = z.object({ version: z.number() });

function tempDbPath(prefix: string): string {
  return path.join(createManagedTempDir(prefix), 'runtime.sqlite');
}

function withReadonlyDb<T>(dbPath: string, read: (database: Database.Database) => T): T {
  const database = new Database(dbPath, { readonly: true });
  try {
    return read(database);
  } finally {
    database.close();
  }
}

function tableNames(dbPath: string): string[] {
  return withReadonlyDb(dbPath, (database) => NameRowSchema
    .parse(database.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all())
    .map((row) => row.name));
}

function countRows(dbPath: string, table: string): number {
  return withReadonlyDb(dbPath, (database) => CountRowSchema
    .parse(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).count);
}

const EXPECTED_ASSISTANT_TABLES = [
  'assistant_owners', 'assistant_devices', 'graph_node_types', 'graph_relation_types',
  'graph_nodes', 'graph_node_aliases', 'evidence_blobs', 'evidence_records', 'observations',
  'candidate_assertions', 'graph_assertions', 'assertion_evidence', 'graph_entity_merges',
  'graph_mutation_log', 'assistant_policies', 'assistant_audit_events',
  'graph_nodes_fts', 'graph_assertions_fts',
];

test('a fresh database lands on the current schema version with every assistant table', () => {
  const dbPath = tempDbPath('siftkit-assistant-migration-fresh-');
  getRuntimeDatabase(dbPath);
  closeRuntimeDatabase();

  assert.equal(CURRENT_SCHEMA_VERSION, 40);
  const version = withReadonlyDb(dbPath, (database) => VersionRowSchema
    .parse(database.prepare('SELECT version FROM runtime_schema WHERE id = 1').get()).version);
  assert.equal(version, 40);

  const tables = new Set(tableNames(dbPath));
  for (const expected of EXPECTED_ASSISTANT_TABLES) {
    assert.ok(tables.has(expected), `missing table ${expected}`);
  }
});

test('registries, the owner row, and the local device row are seeded from TypeScript', () => {
  const dbPath = tempDbPath('siftkit-assistant-migration-seed-');
  getRuntimeDatabase(dbPath);
  closeRuntimeDatabase();

  assert.equal(countRows(dbPath, 'graph_node_types'), NODE_TYPES.length);
  assert.equal(countRows(dbPath, 'graph_relation_types'), RELATION_TYPES.length);
  assert.equal(countRows(dbPath, 'assistant_owners'), 1);
  assert.equal(countRows(dbPath, 'assistant_devices'), 1);

  const ownerId = withReadonlyDb(dbPath, (database) => z.object({ id: z.string() })
    .parse(database.prepare('SELECT id FROM assistant_owners LIMIT 1').get()).id);
  assert.equal(ownerId, LOCAL_OWNER_ID);

  const graphVersion = withReadonlyDb(dbPath, (database) => z.object({ value: z.string() })
    .parse(database.prepare(
      "SELECT value FROM runtime_metadata WHERE key = 'assistant.graph_version'",
    ).get()).value);
  assert.equal(graphVersion, '0');
});

test('re-opening an already-migrated database is a no-op, not a duplicate seed', () => {
  const dbPath = tempDbPath('siftkit-assistant-migration-reapply-');
  getRuntimeDatabase(dbPath);
  closeRuntimeDatabase();
  getRuntimeDatabase(dbPath);
  closeRuntimeDatabase();

  assert.equal(countRows(dbPath, 'graph_node_types'), NODE_TYPES.length);
  assert.equal(countRows(dbPath, 'graph_relation_types'), RELATION_TYPES.length);
  assert.equal(countRows(dbPath, 'assistant_owners'), 1);
  assert.equal(countRows(dbPath, 'assistant_devices'), 1);
});

test('a v38 database upgrades in place and keeps its pre-existing rows', () => {
  const dbPath = tempDbPath('siftkit-assistant-migration-upgrade-');
  const seed = new Database(dbPath);
  seed.exec(`
    CREATE TABLE runtime_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
    INSERT INTO runtime_schema (id, version) VALUES (1, 38);
    CREATE TABLE runtime_metadata (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at_utc TEXT NOT NULL);
    INSERT INTO runtime_metadata (key, value, updated_at_utc)
      VALUES ('carried.over', 'kept', '2026-08-05T00:00:00.000Z');
  `);
  seed.close();

  getRuntimeDatabase(dbPath);
  closeRuntimeDatabase();

  const tables = new Set(tableNames(dbPath));
  assert.ok(tables.has('graph_assertions'));
  assert.ok(tables.has('graph_nodes_fts'));
  const carried = withReadonlyDb(dbPath, (database) => z.object({ value: z.string() })
    .parse(database.prepare("SELECT value FROM runtime_metadata WHERE key = 'carried.over'").get()).value);
  assert.equal(carried, 'kept');
});

test('the relation registry table matches the TypeScript descriptor exactly', () => {
  const dbPath = tempDbPath('siftkit-assistant-migration-descriptor-');
  getRuntimeDatabase(dbPath);
  closeRuntimeDatabase();

  const stored = withReadonlyDb(dbPath, (database) => z.object({ definition_json: z.string() })
    .parse(database.prepare(
      "SELECT definition_json FROM graph_relation_types WHERE name = 'PREFERS'",
    ).get()).definition_json);
  const parsed = z.object({
    predicate: z.string(),
    cardinality: z.string(),
    conflictStrategy: z.string(),
    projectionBehavior: z.string(),
  }).parse(JSON.parse(stored));
  assert.equal(parsed.predicate, 'PREFERS');
  assert.equal(parsed.cardinality, 'single_per_scope');
  assert.equal(parsed.conflictStrategy, 'supersede_current');
  assert.equal(parsed.projectionBehavior, 'core');
});

test('FTS5 virtual tables accept a match query', () => {
  const dbPath = tempDbPath('siftkit-assistant-migration-fts-');
  const database = getRuntimeDatabase(dbPath);
  database.prepare(`
    INSERT INTO graph_nodes_fts (node_id, owner_id, display_name, aliases, description)
    VALUES ('node_1', ?, 'Visual Studio Code', 'vscode', 'code editor')
  `).run(LOCAL_OWNER_ID);
  const hits = z.array(z.object({ node_id: z.string() })).parse(
    database.prepare("SELECT node_id FROM graph_nodes_fts WHERE graph_nodes_fts MATCH 'vscode'").all(),
  );
  closeRuntimeDatabase();
  assert.deepEqual(hits, [{ node_id: 'node_1' }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- assistant-migration`
Expected: FAIL — `CURRENT_SCHEMA_VERSION` is 38 and `graph_assertions` does not exist.

- [ ] **Step 3: Bump the schema version**

In `src/state/runtime-db.ts`, change line 37:

```ts
export const CURRENT_SCHEMA_VERSION = 40;
```

- [ ] **Step 4: Add the two migration blocks**

In `src/state/runtime-db.ts`, immediately after the existing `if (currentVersion < 38) { ... }`
block and before the sub-schema calls at the end of `ensureSchema`, insert:

```ts
  if (currentVersion < 39) {
    applyAssistantCoreSchema(database);
    setSchemaVersion(database, 39);
    currentVersion = 39;
  }

  if (currentVersion < 40) {
    database.exec(ASSISTANT_FTS_SCHEMA_SQL);
    setSchemaVersion(database, 40);
    currentVersion = 40;
  }
```

Add the helper alongside the other migration helpers (near
`migrateRunLogsBackendToEngineIds` at line 883):

```ts
function applyAssistantCoreSchema(database: RuntimeDatabase): void {
  database.exec(ASSISTANT_CORE_SCHEMA_SQL);
  seedAssistantRegistries(database, new SystemClock(), randomUUID(), 'Local user');
}
```

Add these imports at the top of `src/state/runtime-db.ts`:

```ts
import { randomUUID } from 'node:crypto';

import { SystemClock } from '../assistant/clock.js';
import {
  ASSISTANT_CORE_SCHEMA_SQL,
  ASSISTANT_FTS_SCHEMA_SQL,
  seedAssistantRegistries,
} from '../assistant/storage/schema.js';
```

> **Import-cycle note:** `src/assistant/storage/schema.ts` imports `RuntimeDatabase` from
> `runtime-db.ts` as a **type-only** import (`import type { RuntimeDatabase }`), so the emitted
> ESM has no runtime edge back into `runtime-db.ts`. Keep it type-only. If you find yourself
> needing a value from `runtime-db.ts` inside `schema.ts`, that is a signal the code belongs in
> the migration helper instead.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- assistant-migration`
Expected: PASS — 6 tests.

- [ ] **Step 6: Run the whole suite — the version bump touches every database test**

Run: `npm test`
Expected: PASS. `tests/config-no-top-level-backend.test.ts` asserts against
`CURRENT_SCHEMA_VERSION` symbolically, so it should follow the bump; if any test hardcodes `38`,
update it to `CURRENT_SCHEMA_VERSION`.

- [ ] **Step 7: Lint and commit**

```bash
npm run lint
git add src/state/runtime-db.ts tests/assistant-migration.test.ts
git commit -m "feat(assistant): add schema migrations v39 and v40"
```

---

## Task 8: Row schemas, identity store, audit store

**Files:**
- Create: `src/assistant/storage/rows.ts`, `src/assistant/storage/identity-store.ts`,
  `src/assistant/storage/audit-store.ts`
- Create: `tests/helpers/assistant-fixture.ts`
- Test: `tests/assistant-graph-crud.test.ts` (created here, extended in Tasks 9–10)

`graph_version` (§5.5) is a monotonic integer in `runtime_metadata`, incremented exactly once per
committed graph-mutation transaction. `AuditStore` owns it because every mutation already goes
through the mutation log.

- [ ] **Step 1: Write `src/assistant/storage/rows.ts`**

Row schemas for every table Gate A reads. SQLite has no boolean, so integer columns are parsed and
exposed as `boolean` on the record type.

```ts
import { z } from '../../lib/zod.js';

import {
  ActorTypeSchema, AliasTypeSchema, AssertionBasisSchema, AssertionStatusSchema,
  DeviceStatusSchema, EvidenceSourceTypeSchema, EvidenceStanceSchema, EvidenceStatusSchema,
  MutationOperationSchema, NodeStatusSchema, ObjectKindSchema, ObjectValueTypeSchema,
  PolicySourceSchema, PolicyTypeSchema, SensitivitySchema,
} from '../domain/enums.js';
import { NodeTypeSchema } from '../domain/node-types.js';
import { RelationTypeSchema } from '../domain/relation-types.js';

const SqliteBooleanSchema = z.number().int().min(0).max(1).transform((value) => value === 1);

export const OwnerRowSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  created_at_utc: z.string(),
  updated_at_utc: z.string(),
});
export type OwnerRow = z.infer<typeof OwnerRowSchema>;

export const DeviceRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  platform: z.string(),
  display_name: z.string(),
  public_key: z.string().nullable(),
  status: DeviceStatusSchema,
  created_at_utc: z.string(),
  updated_at_utc: z.string(),
});
export type DeviceRow = z.infer<typeof DeviceRowSchema>;

export const NodeRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  type: NodeTypeSchema,
  canonical_key: z.string().nullable(),
  display_name: z.string(),
  description: z.string().nullable(),
  sensitivity: SensitivitySchema,
  status: NodeStatusSchema,
  properties_json: z.string(),
  merged_into_node_id: z.string().nullable(),
  created_at_utc: z.string(),
  updated_at_utc: z.string(),
  deleted_at_utc: z.string().nullable(),
});
export type NodeRow = z.infer<typeof NodeRowSchema>;

export const AliasRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  node_id: z.string(),
  alias: z.string(),
  normalized_alias: z.string(),
  alias_type: AliasTypeSchema,
  source_evidence_id: z.string().nullable(),
  created_at_utc: z.string(),
});
export type AliasRow = z.infer<typeof AliasRowSchema>;

export const AssertionRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  assertion_key: z.string(),
  subject_node_id: z.string(),
  predicate: RelationTypeSchema,
  object_kind: ObjectKindSchema,
  object_node_id: z.string().nullable(),
  object_value_type: ObjectValueTypeSchema.nullable(),
  object_value_json: z.string().nullable(),
  object_normalized_text: z.string().nullable(),
  scope_node_id: z.string().nullable(),
  status: AssertionStatusSchema,
  basis: AssertionBasisSchema,
  confidence: z.number(),
  sensitivity: SensitivitySchema,
  valid_from_utc: z.string().nullable(),
  valid_to_utc: z.string().nullable(),
  first_observed_at_utc: z.string(),
  last_observed_at_utc: z.string(),
  recorded_at_utc: z.string(),
  retired_at_utc: z.string().nullable(),
  supersedes_assertion_id: z.string().nullable(),
  pinned: SqliteBooleanSchema,
  attributes_json: z.string(),
  created_at_utc: z.string(),
  updated_at_utc: z.string(),
});
export type AssertionRow = z.infer<typeof AssertionRowSchema>;

export const AssertionEvidenceRowSchema = z.object({
  assertion_id: z.string(),
  evidence_id: z.string(),
  stance: EvidenceStanceSchema,
  weight: z.number(),
  created_at_utc: z.string(),
});
export type AssertionEvidenceRow = z.infer<typeof AssertionEvidenceRowSchema>;

export const EvidenceRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  device_id: z.string().nullable(),
  source_event_id: z.string(),
  parent_evidence_id: z.string().nullable(),
  blob_id: z.string().nullable(),
  source_type: EvidenceSourceTypeSchema,
  source_ref: z.string().nullable(),
  captured_at_utc: z.string(),
  source_timezone: z.string().nullable(),
  ingested_at_utc: z.string(),
  content_hash: z.string(),
  mime_type: z.string().nullable(),
  sensitivity: SensitivitySchema,
  retention_until_utc: z.string().nullable(),
  status: EvidenceStatusSchema,
  metadata_json: z.string(),
  created_at_utc: z.string(),
  updated_at_utc: z.string(),
});
export type EvidenceRow = z.infer<typeof EvidenceRowSchema>;

export const BlobRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  content_hash: z.string(),
  byte_length: z.number().int(),
  mime_type: z.string(),
  storage_uri: z.string(),
  encrypted: SqliteBooleanSchema,
  key_id: z.string().nullable(),
  created_at_utc: z.string(),
  deleted_at_utc: z.string().nullable(),
});
export type BlobRow = z.infer<typeof BlobRowSchema>;

export const MergeRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  source_node_id: z.string(),
  target_node_id: z.string(),
  basis: z.string(),
  reversible: SqliteBooleanSchema,
  created_at_utc: z.string(),
  reversed_at_utc: z.string().nullable(),
});
export type MergeRow = z.infer<typeof MergeRowSchema>;

export const MutationLogRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  actor_type: ActorTypeSchema,
  actor_ref: z.string().nullable(),
  operation: MutationOperationSchema,
  target_type: z.string(),
  target_id: z.string(),
  before_json: z.string().nullable(),
  after_json: z.string().nullable(),
  reason: z.string(),
  created_at_utc: z.string(),
});
export type MutationLogRow = z.infer<typeof MutationLogRowSchema>;

export const PolicyRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  policy_type: PolicyTypeSchema,
  key: z.string(),
  value_json: z.string(),
  enabled: SqliteBooleanSchema,
  source: PolicySourceSchema,
  created_at_utc: z.string(),
  updated_at_utc: z.string(),
});
export type PolicyRow = z.infer<typeof PolicyRowSchema>;

export const AuditEventRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  event_type: z.string(),
  target_type: z.string().nullable(),
  target_id: z.string().nullable(),
  summary: z.string(),
  details_json: z.string(),
  created_at_utc: z.string(),
});
export type AuditEventRow = z.infer<typeof AuditEventRowSchema>;

export const MetadataValueRowSchema = z.object({ value: z.string() });
export const CountRowSchema = z.object({ count: z.number() });
```

- [ ] **Step 2: Write `src/assistant/storage/identity-store.ts`**

```ts
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import { z } from '../../lib/zod.js';
import { DeviceRowSchema, OwnerRowSchema, type DeviceRow, type OwnerRow } from './rows.js';
import { LOCAL_DEVICE_METADATA_KEY, LOCAL_OWNER_ID } from './schema.js';

/** Reads the owner and device rows seeded by the migration. Never creates them. */
export class IdentityStore {
  constructor(private readonly database: RuntimeDatabase) {}

  getOwner(): OwnerRow {
    const row = this.database
      .prepare('SELECT * FROM assistant_owners WHERE id = ?')
      .get(LOCAL_OWNER_ID);
    if (row === undefined || row === null) {
      throw new Error('Assistant owner row is missing; the v39 migration did not run.');
    }
    return OwnerRowSchema.parse(row);
  }

  getLocalDeviceId(): string {
    const row = this.database
      .prepare('SELECT value FROM runtime_metadata WHERE key = ?')
      .get(LOCAL_DEVICE_METADATA_KEY);
    if (row === undefined || row === null) {
      throw new Error('Local device id is missing; the v39 migration did not run.');
    }
    return z.object({ value: z.string() }).parse(row).value;
  }

  getDevice(deviceId: string): DeviceRow | null {
    const row = this.database.prepare('SELECT * FROM assistant_devices WHERE id = ?').get(deviceId);
    return row === undefined || row === null ? null : DeviceRowSchema.parse(row);
  }

  listDevices(ownerId: string): DeviceRow[] {
    return z.array(DeviceRowSchema).parse(
      this.database
        .prepare('SELECT * FROM assistant_devices WHERE owner_id = ? ORDER BY created_at_utc')
        .all(ownerId),
    );
  }
}
```

- [ ] **Step 3: Write `src/assistant/storage/audit-store.ts`**

```ts
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import { z } from '../../lib/zod.js';
import type { JsonValue } from '../../lib/json-types.js';
import type { Clock } from '../clock.js';
import type { ActorType, MutationOperation } from '../domain/enums.js';
import type { IdGenerator } from '../ids.js';
import {
  AuditEventRowSchema, MutationLogRowSchema,
  type AuditEventRow, type MutationLogRow,
} from './rows.js';
import { GRAPH_VERSION_METADATA_KEY } from './schema.js';

export interface MutationLogEntry {
  readonly ownerId: string;
  readonly actorType: ActorType;
  readonly actorRef: string | null;
  readonly operation: MutationOperation;
  readonly targetType: string;
  readonly targetId: string;
  readonly before: JsonValue | null;
  readonly after: JsonValue | null;
  readonly reason: string;
}

export interface AuditEventEntry {
  readonly ownerId: string;
  readonly eventType: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly summary: string;
  readonly details: JsonValue;
}

/**
 * Owns the mutation log, non-content audit events, and the monotonic graph version.
 * Callers run these inside their own transaction; this store never opens one.
 */
export class AuditStore {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  recordMutation(entry: MutationLogEntry): string {
    const id = this.ids.next('mut');
    this.database.prepare(`
      INSERT INTO graph_mutation_log (
        id, owner_id, actor_type, actor_ref, operation, target_type, target_id,
        before_json, after_json, reason, created_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, entry.ownerId, entry.actorType, entry.actorRef, entry.operation,
      entry.targetType, entry.targetId,
      entry.before === null ? null : JSON.stringify(entry.before),
      entry.after === null ? null : JSON.stringify(entry.after),
      entry.reason, this.clock.nowUtc(),
    );
    return id;
  }

  recordAuditEvent(entry: AuditEventEntry): string {
    const id = this.ids.next('audit');
    this.database.prepare(`
      INSERT INTO assistant_audit_events (
        id, owner_id, event_type, target_type, target_id, summary, details_json, created_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, entry.ownerId, entry.eventType, entry.targetType, entry.targetId,
      entry.summary, JSON.stringify(entry.details), this.clock.nowUtc(),
    );
    return id;
  }

  listMutations(ownerId: string, targetType: string, targetId: string): MutationLogRow[] {
    return z.array(MutationLogRowSchema).parse(
      this.database.prepare(`
        SELECT * FROM graph_mutation_log
        WHERE owner_id = ? AND target_type = ? AND target_id = ?
        ORDER BY created_at_utc ASC, id ASC
      `).all(ownerId, targetType, targetId),
    );
  }

  listAuditEvents(ownerId: string, limit: number): AuditEventRow[] {
    return z.array(AuditEventRowSchema).parse(
      this.database.prepare(`
        SELECT * FROM assistant_audit_events
        WHERE owner_id = ? ORDER BY created_at_utc DESC, id DESC LIMIT ?
      `).all(ownerId, limit),
    );
  }

  getGraphVersion(): number {
    const row = this.database
      .prepare('SELECT value FROM runtime_metadata WHERE key = ?')
      .get(GRAPH_VERSION_METADATA_KEY);
    if (row === undefined || row === null) {
      throw new Error('Graph version metadata is missing; the v39 migration did not run.');
    }
    return Number.parseInt(z.object({ value: z.string() }).parse(row).value, 10);
  }

  /** Called exactly once per committed graph-mutation transaction. */
  incrementGraphVersion(): number {
    const next = this.getGraphVersion() + 1;
    this.database.prepare(`
      UPDATE runtime_metadata SET value = ?, updated_at_utc = ? WHERE key = ?
    `).run(String(next), this.clock.nowUtc(), GRAPH_VERSION_METADATA_KEY);
    return next;
  }
}
```

- [ ] **Step 4: Write `tests/helpers/assistant-fixture.ts`**

One construction point for every assistant test. Extended in Task 18 to return the full
`AssistantGraph`; for now it returns the raw database plus the deterministic clock and ids.

```ts
import path from 'node:path';

import { FixedClock } from '../../src/assistant/clock.js';
import { SequentialIdGenerator } from '../../src/assistant/ids.js';
import { LOCAL_OWNER_ID } from '../../src/assistant/storage/schema.js';
import {
  closeRuntimeDatabase, getRuntimeDatabase, type RuntimeDatabase,
} from '../../src/state/runtime-db.js';
import { createManagedTempDir } from './temp-dirs.js';

export interface AssistantTestContext {
  readonly database: RuntimeDatabase;
  readonly clock: FixedClock;
  readonly ids: SequentialIdGenerator;
  readonly ownerId: string;
  readonly runtimeRoot: string;
}

export const FIXTURE_START_INSTANT = '2026-08-05T09:00:00.000Z';

/**
 * Creates an isolated runtime database with the assistant schema migrated, runs `body`, then
 * closes the database. The temp directory is swept by the shared registry on process exit.
 */
export function withAssistantContext<T>(body: (context: AssistantTestContext) => T): T {
  const runtimeRoot = createManagedTempDir('siftkit-assistant-');
  const database = getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite'));
  try {
    return body({
      database,
      clock: new FixedClock(FIXTURE_START_INSTANT),
      ids: new SequentialIdGenerator(),
      ownerId: LOCAL_OWNER_ID,
      runtimeRoot,
    });
  } finally {
    closeRuntimeDatabase();
  }
}
```

- [ ] **Step 5: Write the test**

Create `tests/assistant-graph-crud.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { AuditStore } from '../src/assistant/storage/audit-store.js';
import { IdentityStore } from '../src/assistant/storage/identity-store.js';
import { LOCAL_OWNER_ID } from '../src/assistant/storage/schema.js';
import { withAssistantContext } from './helpers/assistant-fixture.js';

test('identity store reads the seeded owner and local device', () => {
  withAssistantContext((context) => {
    const identity = new IdentityStore(context.database);
    const owner = identity.getOwner();
    assert.equal(owner.id, LOCAL_OWNER_ID);

    const deviceId = identity.getLocalDeviceId();
    const device = identity.getDevice(deviceId);
    assert.notEqual(device, null);
    assert.equal(device?.status, 'active');
    assert.equal(device?.owner_id, LOCAL_OWNER_ID);
    assert.equal(identity.listDevices(LOCAL_OWNER_ID).length, 1);
  });
});

test('audit store appends mutation log entries in order with before and after state', () => {
  withAssistantContext((context) => {
    const audit = new AuditStore(context.database, context.clock, context.ids);
    audit.recordMutation({
      ownerId: context.ownerId, actorType: 'system', actorRef: null,
      operation: 'create_node', targetType: 'graph_nodes', targetId: 'node_1',
      before: null, after: { displayName: 'VS Code' }, reason: 'seeded by test',
    });
    context.clock.advanceSeconds(60);
    audit.recordMutation({
      ownerId: context.ownerId, actorType: 'user', actorRef: 'own_local',
      operation: 'update_node', targetType: 'graph_nodes', targetId: 'node_1',
      before: { displayName: 'VS Code' }, after: { displayName: 'Visual Studio Code' },
      reason: 'renamed by test',
    });

    const entries = audit.listMutations(context.ownerId, 'graph_nodes', 'node_1');
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.operation, 'create_node');
    assert.equal(entries[0]?.before_json, null);
    assert.equal(entries[1]?.operation, 'update_node');
    assert.equal(entries[1]?.actor_type, 'user');
    assert.equal(
      entries[1]?.after_json,
      JSON.stringify({ displayName: 'Visual Studio Code' }),
    );
    assert.equal(entries[0]?.created_at_utc, '2026-08-05T09:00:00.000Z');
    assert.equal(entries[1]?.created_at_utc, '2026-08-05T09:01:00.000Z');
  });
});

test('audit store records non-content audit events newest first', () => {
  withAssistantContext((context) => {
    const audit = new AuditStore(context.database, context.clock, context.ids);
    audit.recordAuditEvent({
      ownerId: context.ownerId, eventType: 'secret_discarded',
      targetType: null, targetId: null,
      summary: 'Discarded secret_prohibited content during extraction',
      details: { detector: 'test' },
    });
    const events = audit.listAuditEvents(context.ownerId, 10);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event_type, 'secret_discarded');
    assert.equal(events[0]?.summary.includes('secret_prohibited'), true);
  });
});

test('graph version starts at zero and increments monotonically', () => {
  withAssistantContext((context) => {
    const audit = new AuditStore(context.database, context.clock, context.ids);
    assert.equal(audit.getGraphVersion(), 0);
    assert.equal(audit.incrementGraphVersion(), 1);
    assert.equal(audit.incrementGraphVersion(), 2);
    assert.equal(audit.getGraphVersion(), 2);
  });
});
```

- [ ] **Step 6: Run tests**

Run: `npm test -- assistant-graph-crud`
Expected: PASS — 4 tests.

- [ ] **Step 7: Lint and commit**

```bash
npm run lint
git add src/assistant/storage/rows.ts src/assistant/storage/identity-store.ts \
        src/assistant/storage/audit-store.ts tests/helpers/assistant-fixture.ts \
        tests/assistant-graph-crud.test.ts
git commit -m "feat(assistant): add row schemas, identity store, and audit store"
```

---

## Task 9: Node store

**Files:**
- Create: `src/assistant/storage/node-store.ts`
- Modify: `tests/assistant-graph-crud.test.ts` (append)

Owns `graph_nodes`, `graph_node_aliases`, `graph_nodes_fts`, and `graph_entity_merges`. FTS rows are
written in the same transaction as the canonical row, by this code — no triggers (§5.1). Nodes whose
sensitivity is `sensitive` or `highly_sensitive` are **not** indexed (§5.3).

- [ ] **Step 1: Write the failing test**

Append to `tests/assistant-graph-crud.test.ts`:

```ts
import { NodeStore } from '../src/assistant/storage/node-store.js';

function newNodeStore(context: Parameters<Parameters<typeof withAssistantContext>[0]>[0]): NodeStore {
  return new NodeStore(context.database, context.clock, context.ids);
}

test('node store creates, reads, and lists nodes', () => {
  withAssistantContext((context) => {
    const nodes = newNodeStore(context);
    const created = nodes.createNode({
      ownerId: context.ownerId, type: 'software', canonicalKey: 'software:visual-studio-code',
      displayName: 'Visual Studio Code', description: 'Code editor',
      sensitivity: 'low', properties: { vendor: 'Microsoft' },
    });
    assert.equal(created.id, 'node_0001');
    assert.equal(created.status, 'active');
    assert.equal(created.created_at_utc, '2026-08-05T09:00:00.000Z');

    const fetched = nodes.getNode(created.id);
    assert.equal(fetched?.display_name, 'Visual Studio Code');
    assert.equal(JSON.parse(fetched?.properties_json ?? '{}').vendor, 'Microsoft');

    const listed = nodes.listNodesByType(context.ownerId, 'software');
    assert.deepEqual(listed.map((row) => row.id), [created.id]);
  });
});

test('canonical keys are unique per owner and type among non-deleted nodes', () => {
  withAssistantContext((context) => {
    const nodes = newNodeStore(context);
    nodes.createNode({
      ownerId: context.ownerId, type: 'device', canonicalKey: 'device:main',
      displayName: 'Workstation', description: null, sensitivity: 'personal', properties: {},
    });
    assert.throws(
      () => nodes.createNode({
        ownerId: context.ownerId, type: 'device', canonicalKey: 'device:main',
        displayName: 'Duplicate workstation', description: null,
        sensitivity: 'personal', properties: {},
      }),
      /UNIQUE constraint failed/,
    );
  });
});

test('findByCanonicalKey ignores deleted nodes', () => {
  withAssistantContext((context) => {
    const nodes = newNodeStore(context);
    const node = nodes.createNode({
      ownerId: context.ownerId, type: 'project', canonicalKey: 'project:siftkit',
      displayName: 'SiftKit', description: null, sensitivity: 'low', properties: {},
    });
    assert.equal(nodes.findByCanonicalKey(context.ownerId, 'project', 'project:siftkit')?.id, node.id);
    nodes.setNodeStatus(node.id, 'deleted');
    assert.equal(nodes.findByCanonicalKey(context.ownerId, 'project', 'project:siftkit'), null);
  });
});

test('aliases resolve case- and whitespace-insensitively and are type-filtered', () => {
  withAssistantContext((context) => {
    const nodes = newNodeStore(context);
    const editor = nodes.createNode({
      ownerId: context.ownerId, type: 'software', canonicalKey: 'software:visual-studio-code',
      displayName: 'Visual Studio Code', description: null, sensitivity: 'low', properties: {},
    });
    const person = nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: 'person:self',
      displayName: 'Code', description: null, sensitivity: 'personal', properties: {},
    });
    nodes.addAlias({
      ownerId: context.ownerId, nodeId: editor.id, alias: 'VS  Code',
      aliasType: 'name', sourceEvidenceId: null,
    });
    nodes.addAlias({
      ownerId: context.ownerId, nodeId: person.id, alias: 'vs code',
      aliasType: 'user_supplied', sourceEvidenceId: null,
    });

    const all = nodes.findByAlias(context.ownerId, '  vs   code ');
    assert.equal(all.length, 2);

    const softwareOnly = nodes.findByAlias(context.ownerId, 'VS Code', 'software');
    assert.deepEqual(softwareOnly.map((row) => row.id), [editor.id]);
  });
});

test('adding the same alias to the same node twice is idempotent', () => {
  withAssistantContext((context) => {
    const nodes = newNodeStore(context);
    const node = nodes.createNode({
      ownerId: context.ownerId, type: 'model', canonicalKey: 'model:qwen3.5-27b',
      displayName: 'Qwen3.5 27B', description: null, sensitivity: 'low', properties: {},
    });
    nodes.addAlias({
      ownerId: context.ownerId, nodeId: node.id, alias: 'qwen', aliasType: 'model',
      sourceEvidenceId: null,
    });
    nodes.addAlias({
      ownerId: context.ownerId, nodeId: node.id, alias: 'Qwen', aliasType: 'model',
      sourceEvidenceId: null,
    });
    assert.equal(nodes.listAliases(node.id).length, 1);
  });
});

test('full-text search matches display name, alias, and description', () => {
  withAssistantContext((context) => {
    const nodes = newNodeStore(context);
    const node = nodes.createNode({
      ownerId: context.ownerId, type: 'software', canonicalKey: 'software:powershell',
      displayName: 'PowerShell', description: 'Windows automation shell',
      sensitivity: 'low', properties: {},
    });
    nodes.addAlias({
      ownerId: context.ownerId, nodeId: node.id, alias: 'pwsh',
      aliasType: 'name', sourceEvidenceId: null,
    });

    assert.deepEqual(nodes.searchNodes(context.ownerId, 'powershell', 10), [node.id]);
    assert.deepEqual(nodes.searchNodes(context.ownerId, 'pwsh', 10), [node.id]);
    assert.deepEqual(nodes.searchNodes(context.ownerId, 'automation', 10), [node.id]);
    assert.deepEqual(nodes.searchNodes(context.ownerId, 'nothingmatches', 10), []);
  });
});

test('sensitive and highly sensitive nodes are excluded from the FTS index', () => {
  withAssistantContext((context) => {
    const nodes = newNodeStore(context);
    nodes.createNode({
      ownerId: context.ownerId, type: 'financial_account', canonicalKey: null,
      displayName: 'Brokerage account', description: null,
      sensitivity: 'highly_sensitive', properties: {},
    });
    assert.deepEqual(nodes.searchNodes(context.ownerId, 'brokerage', 10), []);
  });
});

test('renaming a node refreshes its FTS row rather than duplicating it', () => {
  withAssistantContext((context) => {
    const nodes = newNodeStore(context);
    const node = nodes.createNode({
      ownerId: context.ownerId, type: 'project', canonicalKey: 'project:siftkit',
      displayName: 'Siftkit', description: null, sensitivity: 'low', properties: {},
    });
    nodes.updateNode(node.id, { displayName: 'SiftKit Toolkit', description: 'CLI toolkit' });
    assert.deepEqual(nodes.searchNodes(context.ownerId, 'toolkit', 10), [node.id]);
    assert.deepEqual(nodes.searchNodes(context.ownerId, 'siftkit', 10), [node.id]);
    assert.equal(nodes.getNode(node.id)?.display_name, 'SiftKit Toolkit');
  });
});

test('deleting a node drops it from the FTS index', () => {
  withAssistantContext((context) => {
    const nodes = newNodeStore(context);
    const node = nodes.createNode({
      ownerId: context.ownerId, type: 'topic', canonicalKey: null,
      displayName: 'Transient topic', description: null, sensitivity: 'low', properties: {},
    });
    assert.deepEqual(nodes.searchNodes(context.ownerId, 'transient', 10), [node.id]);
    nodes.setNodeStatus(node.id, 'deleted');
    assert.deepEqual(nodes.searchNodes(context.ownerId, 'transient', 10), []);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- assistant-graph-crud`
Expected: FAIL — `Cannot find module '../src/assistant/storage/node-store.js'`

- [ ] **Step 3: Write `src/assistant/storage/node-store.ts`**

```ts
import { z } from '../../lib/zod.js';
import type { JsonObject } from '../../lib/json-types.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { Clock } from '../clock.js';
import {
  isSensitivityAtLeast, type AliasType, type NodeStatus, type Sensitivity,
} from '../domain/enums.js';
import { normalizeAliasText } from '../domain/keys.js';
import type { NodeType } from '../domain/node-types.js';
import type { IdGenerator } from '../ids.js';
import {
  AliasRowSchema, MergeRowSchema, NodeRowSchema,
  type AliasRow, type MergeRow, type NodeRow,
} from './rows.js';

export interface CreateNodeInput {
  readonly ownerId: string;
  readonly type: NodeType;
  readonly canonicalKey: string | null;
  readonly displayName: string;
  readonly description: string | null;
  readonly sensitivity: Sensitivity;
  readonly properties: JsonObject;
}

export interface UpdateNodeInput {
  readonly displayName?: string;
  readonly description?: string | null;
  readonly sensitivity?: Sensitivity;
  readonly properties?: JsonObject;
}

export interface AddAliasInput {
  readonly ownerId: string;
  readonly nodeId: string;
  readonly alias: string;
  readonly aliasType: AliasType;
  readonly sourceEvidenceId: string | null;
}

export interface RecordMergeInput {
  readonly ownerId: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly basis: string;
  readonly reversible: boolean;
}

/** A node at or above this sensitivity is never written to the plaintext FTS index (§5.3). */
const FTS_EXCLUSION_FLOOR: Sensitivity = 'sensitive';

export class NodeStore {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  createNode(input: CreateNodeInput): NodeRow {
    const id = this.ids.next('node');
    const nowUtc = this.clock.nowUtc();
    this.database.prepare(`
      INSERT INTO graph_nodes (
        id, owner_id, type, canonical_key, display_name, description, sensitivity, status,
        properties_json, merged_into_node_id, created_at_utc, updated_at_utc, deleted_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?, ?, NULL)
    `).run(
      id, input.ownerId, input.type, input.canonicalKey, input.displayName,
      input.description, input.sensitivity, JSON.stringify(input.properties), nowUtc, nowUtc,
    );
    this.refreshFts(id);
    const created = this.getNode(id);
    if (created === null) {
      throw new Error(`Node ${id} vanished immediately after insert.`);
    }
    return created;
  }

  getNode(nodeId: string): NodeRow | null {
    const row = this.database.prepare('SELECT * FROM graph_nodes WHERE id = ?').get(nodeId);
    return row === undefined || row === null ? null : NodeRowSchema.parse(row);
  }

  /** Throws instead of returning null. Use where a missing node is a programming error. */
  requireNode(nodeId: string): NodeRow {
    const node = this.getNode(nodeId);
    if (node === null) {
      throw new Error(`Unknown graph node: ${nodeId}`);
    }
    return node;
  }

  findByCanonicalKey(ownerId: string, type: NodeType, canonicalKey: string): NodeRow | null {
    const row = this.database.prepare(`
      SELECT * FROM graph_nodes
      WHERE owner_id = ? AND type = ? AND canonical_key = ? AND status <> 'deleted'
    `).get(ownerId, type, canonicalKey);
    return row === undefined || row === null ? null : NodeRowSchema.parse(row);
  }

  listNodesByType(ownerId: string, type: NodeType): NodeRow[] {
    return z.array(NodeRowSchema).parse(this.database.prepare(`
      SELECT * FROM graph_nodes
      WHERE owner_id = ? AND type = ? AND status = 'active'
      ORDER BY display_name ASC, id ASC
    `).all(ownerId, type));
  }

  updateNode(nodeId: string, input: UpdateNodeInput): NodeRow {
    const existing = this.requireNode(nodeId);
    const nowUtc = this.clock.nowUtc();
    this.database.prepare(`
      UPDATE graph_nodes
      SET display_name = ?, description = ?, sensitivity = ?, properties_json = ?, updated_at_utc = ?
      WHERE id = ?
    `).run(
      input.displayName ?? existing.display_name,
      input.description === undefined ? existing.description : input.description,
      input.sensitivity ?? existing.sensitivity,
      input.properties === undefined ? existing.properties_json : JSON.stringify(input.properties),
      nowUtc, nodeId,
    );
    this.refreshFts(nodeId);
    return this.requireNode(nodeId);
  }

  setNodeStatus(nodeId: string, status: NodeStatus, mergedIntoNodeId: string | null = null): NodeRow {
    const nowUtc = this.clock.nowUtc();
    this.database.prepare(`
      UPDATE graph_nodes
      SET status = ?, merged_into_node_id = ?, updated_at_utc = ?,
          deleted_at_utc = CASE WHEN ? = 'deleted' THEN ? ELSE deleted_at_utc END
      WHERE id = ?
    `).run(status, mergedIntoNodeId, nowUtc, status, nowUtc, nodeId);
    this.refreshFts(nodeId);
    return this.requireNode(nodeId);
  }

  addAlias(input: AddAliasInput): AliasRow {
    const normalized = normalizeAliasText(input.alias);
    const existing = this.database.prepare(`
      SELECT * FROM graph_node_aliases WHERE node_id = ? AND normalized_alias = ?
    `).get(input.nodeId, normalized);
    if (existing !== undefined && existing !== null) {
      return AliasRowSchema.parse(existing);
    }
    const id = this.ids.next('alias');
    this.database.prepare(`
      INSERT INTO graph_node_aliases (
        id, owner_id, node_id, alias, normalized_alias, alias_type,
        source_evidence_id, created_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.ownerId, input.nodeId, input.alias, normalized,
      input.aliasType, input.sourceEvidenceId, this.clock.nowUtc(),
    );
    this.refreshFts(input.nodeId);
    return AliasRowSchema.parse(
      this.database.prepare('SELECT * FROM graph_node_aliases WHERE id = ?').get(id),
    );
  }

  listAliases(nodeId: string): AliasRow[] {
    return z.array(AliasRowSchema).parse(this.database.prepare(`
      SELECT * FROM graph_node_aliases WHERE node_id = ? ORDER BY created_at_utc ASC, id ASC
    `).all(nodeId));
  }

  /** Alias lookup, optionally constrained to one node type (resolution order step 3, §9.1). */
  findByAlias(ownerId: string, alias: string, type?: NodeType): NodeRow[] {
    const normalized = normalizeAliasText(alias);
    const rows = type === undefined
      ? this.database.prepare(`
          SELECT n.* FROM graph_nodes n
          JOIN graph_node_aliases a ON a.node_id = n.id
          WHERE a.owner_id = ? AND a.normalized_alias = ? AND n.status = 'active'
          ORDER BY n.id ASC
        `).all(ownerId, normalized)
      : this.database.prepare(`
          SELECT n.* FROM graph_nodes n
          JOIN graph_node_aliases a ON a.node_id = n.id
          WHERE a.owner_id = ? AND a.normalized_alias = ? AND n.type = ? AND n.status = 'active'
          ORDER BY n.id ASC
        `).all(ownerId, normalized, type);
    return z.array(NodeRowSchema).parse(rows);
  }

  /** Re-points every alias of `sourceNodeId` at `targetNodeId`. Used by the merge service. */
  reassignAliases(sourceNodeId: string, targetNodeId: string): string[] {
    const moved = this.listAliases(sourceNodeId).map((alias) => alias.id);
    this.database
      .prepare('UPDATE graph_node_aliases SET node_id = ? WHERE node_id = ?')
      .run(targetNodeId, sourceNodeId);
    this.refreshFts(sourceNodeId);
    this.refreshFts(targetNodeId);
    return moved;
  }

  searchNodes(ownerId: string, query: string, limit: number): string[] {
    const rows = this.database.prepare(`
      SELECT node_id FROM graph_nodes_fts
      WHERE graph_nodes_fts MATCH ? AND owner_id = ?
      ORDER BY rank LIMIT ?
    `).all(query, ownerId, limit);
    return z.array(z.object({ node_id: z.string() })).parse(rows).map((row) => row.node_id);
  }

  recordMerge(input: RecordMergeInput): MergeRow {
    const id = this.ids.next('merge');
    this.database.prepare(`
      INSERT INTO graph_entity_merges (
        id, owner_id, source_node_id, target_node_id, basis, reversible,
        created_at_utc, reversed_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      id, input.ownerId, input.sourceNodeId, input.targetNodeId, input.basis,
      input.reversible ? 1 : 0, this.clock.nowUtc(),
    );
    return this.requireMerge(id);
  }

  requireMerge(mergeId: string): MergeRow {
    const row = this.database.prepare('SELECT * FROM graph_entity_merges WHERE id = ?').get(mergeId);
    if (row === undefined || row === null) {
      throw new Error(`Unknown entity merge: ${mergeId}`);
    }
    return MergeRowSchema.parse(row);
  }

  markMergeReversed(mergeId: string): void {
    this.database
      .prepare('UPDATE graph_entity_merges SET reversed_at_utc = ? WHERE id = ?')
      .run(this.clock.nowUtc(), mergeId);
  }

  listMerges(ownerId: string): MergeRow[] {
    return z.array(MergeRowSchema).parse(this.database.prepare(`
      SELECT * FROM graph_entity_merges WHERE owner_id = ? ORDER BY created_at_utc ASC, id ASC
    `).all(ownerId));
  }

  /**
   * Rewrites the node's FTS row from its current canonical state. Called after every write that
   * changes indexed text, status, or sensitivity, inside the caller's transaction.
   */
  private refreshFts(nodeId: string): void {
    this.database.prepare('DELETE FROM graph_nodes_fts WHERE node_id = ?').run(nodeId);
    const node = this.getNode(nodeId);
    if (node === null || node.status !== 'active') return;
    if (isSensitivityAtLeast(node.sensitivity, FTS_EXCLUSION_FLOOR)) return;
    const aliases = this.listAliases(nodeId).map((alias) => alias.alias).join(' ');
    this.database.prepare(`
      INSERT INTO graph_nodes_fts (node_id, owner_id, display_name, aliases, description)
      VALUES (?, ?, ?, ?, ?)
    `).run(nodeId, node.owner_id, node.display_name, aliases, node.description ?? '');
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- assistant-graph-crud`
Expected: PASS — 13 tests.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/assistant/storage/node-store.ts tests/assistant-graph-crud.test.ts
git commit -m "feat(assistant): add node store with alias resolution and FTS maintenance"
```

---

## Task 10: Assertion store

**Files:**
- Create: `src/assistant/storage/assertion-store.ts`
- Modify: `tests/assistant-graph-crud.test.ts` (append)

Owns `graph_assertions`, `assertion_evidence`, and `graph_assertions_fts`. Pure persistence: it
enforces the SQL constraints and maintains FTS, but makes no conflict or precedence decision —
that is `AssertionService` in Task 14.

- [ ] **Step 1: Write the failing test**

Append to `tests/assistant-graph-crud.test.ts`:

```ts
import { AssertionStore } from '../src/assistant/storage/assertion-store.js';
import { buildAssertionKey } from '../src/assistant/domain/keys.js';

test('assertion store writes a node-object assertion and reads it back by subject', () => {
  withAssistantContext((context) => {
    const nodes = newNodeStore(context);
    const assertions = new AssertionStore(context.database, context.clock, context.ids);
    const person = nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: 'person:self',
      displayName: 'Denys', description: null, sensitivity: 'personal', properties: {},
    });
    const shell = nodes.createNode({
      ownerId: context.ownerId, type: 'software', canonicalKey: 'software:powershell',
      displayName: 'PowerShell', description: null, sensitivity: 'low', properties: {},
    });

    const created = assertions.createAssertion({
      ownerId: context.ownerId,
      subjectNodeId: person.id,
      predicate: 'PREFERS',
      object: { kind: 'node', nodeId: shell.id },
      scopeNodeId: null,
      status: 'active',
      basis: 'explicit_user_statement',
      confidence: 0.99,
      sensitivity: 'personal',
      validFromUtc: null,
      validToUtc: null,
      observedAtUtc: '2026-08-05T09:00:00.000Z',
      supersedesAssertionId: null,
      pinned: false,
      attributes: {},
      searchText: {
        subject: 'Denys', predicate: 'prefers', object: 'PowerShell', scope: '',
      },
    });

    assert.equal(created.object_kind, 'node');
    assert.equal(created.object_node_id, shell.id);
    assert.equal(created.object_value_json, null);
    assert.equal(created.pinned, false);
    assert.equal(created.assertion_key, buildAssertionKey({
      ownerId: context.ownerId, subjectNodeId: person.id, predicate: 'PREFERS',
      object: { kind: 'node', nodeId: shell.id }, scopeNodeId: null,
    }));

    const bySubject = assertions.listBySubject(context.ownerId, person.id, ['active']);
    assert.deepEqual(bySubject.map((row) => row.id), [created.id]);
    assert.deepEqual(
      assertions.listByObjectNode(context.ownerId, shell.id, ['active']).map((row) => row.id),
      [created.id],
    );
  });
});

test('assertion store writes a literal-object assertion with a normalized object text', () => {
  withAssistantContext((context) => {
    const nodes = newNodeStore(context);
    const assertions = new AssertionStore(context.database, context.clock, context.ids);
    const device = nodes.createNode({
      ownerId: context.ownerId, type: 'device', canonicalKey: 'device:main',
      displayName: 'Workstation', description: null, sensitivity: 'personal', properties: {},
    });

    const created = assertions.createAssertion({
      ownerId: context.ownerId, subjectNodeId: device.id, predicate: 'HAS_SETTING',
      object: { kind: 'literal', valueType: 'quantity', value: { amount: 24, unit: 'GB' } },
      scopeNodeId: null, status: 'active', basis: 'manual_import', confidence: 0.95,
      sensitivity: 'low', validFromUtc: null, validToUtc: null,
      observedAtUtc: '2026-08-05T09:00:00.000Z', supersedesAssertionId: null,
      pinned: false, attributes: {},
      searchText: { subject: 'Workstation', predicate: 'has setting', object: '24 GB', scope: '' },
    });

    assert.equal(created.object_kind, 'literal');
    assert.equal(created.object_node_id, null);
    assert.equal(created.object_value_type, 'quantity');
    assert.equal(created.object_normalized_text, '24 gb');
    assert.equal(JSON.parse(created.object_value_json ?? 'null').amount, 24);
  });
});

test('two live assertions cannot share an assertion key', () => {
  withAssistantContext((context) => {
    const nodes = newNodeStore(context);
    const assertions = new AssertionStore(context.database, context.clock, context.ids);
    const person = nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: 'person:self',
      displayName: 'Denys', description: null, sensitivity: 'personal', properties: {},
    });
    const editor = nodes.createNode({
      ownerId: context.ownerId, type: 'software', canonicalKey: 'software:vscode',
      displayName: 'VS Code', description: null, sensitivity: 'low', properties: {},
    });
    const write = () => assertions.createAssertion({
      ownerId: context.ownerId, subjectNodeId: person.id, predicate: 'USES',
      object: { kind: 'node', nodeId: editor.id }, scopeNodeId: null,
      status: 'active', basis: 'passive_observation', confidence: 0.5, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, observedAtUtc: '2026-08-05T09:00:00.000Z',
      supersedesAssertionId: null, pinned: false, attributes: {},
      searchText: { subject: 'Denys', predicate: 'uses', object: 'VS Code', scope: '' },
    });
    const first = write();
    assert.throws(write, /UNIQUE constraint failed/);

    // retiring the first frees the key
    assertions.retireAssertion(first.id, 'superseded');
    const second = write();
    assert.notEqual(second.id, first.id);
  });
});

test('evidence links carry stance and weight and drive the support and contradiction split', () => {
  withAssistantContext((context) => {
    const { assertions, assertionId, evidenceIds } = seedAssertionWithEvidence(context);
    assertions.linkEvidence(assertionId, evidenceIds[0], 'supports', 0.9);
    assertions.linkEvidence(assertionId, evidenceIds[1], 'supports', 0.6);
    assertions.linkEvidence(assertionId, evidenceIds[2], 'contradicts', 0.4);

    const links = assertions.listEvidence(assertionId);
    assert.equal(links.length, 3);
    assert.deepEqual(assertions.supportWeights(assertionId), [0.9, 0.6]);
    assert.equal(assertions.contradictionCount(assertionId), 1);
  });
});

test('the same evidence may support and contextualize one assertion but not duplicate a stance', () => {
  withAssistantContext((context) => {
    const { assertions, assertionId, evidenceIds } = seedAssertionWithEvidence(context);
    assertions.linkEvidence(assertionId, evidenceIds[0], 'supports', 0.9);
    assertions.linkEvidence(assertionId, evidenceIds[0], 'context', 0.1);
    assertions.linkEvidence(assertionId, evidenceIds[0], 'supports', 0.7);
    const links = assertions.listEvidence(assertionId);
    assert.equal(links.length, 2);
    assert.deepEqual(assertions.supportWeights(assertionId), [0.7]);
  });
});

test('current-state queries exclude superseded, expired, and future-dated assertions', () => {
  withAssistantContext((context) => {
    const nodes = newNodeStore(context);
    const assertions = new AssertionStore(context.database, context.clock, context.ids);
    const person = nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: 'person:self',
      displayName: 'Denys', description: null, sensitivity: 'personal', properties: {},
    });
    const makeRole = (role: string, validFrom: string | null, validTo: string | null) =>
      assertions.createAssertion({
        ownerId: context.ownerId, subjectNodeId: person.id, predicate: 'HAS_ROLE',
        object: { kind: 'literal', valueType: 'string', value: role },
        scopeNodeId: null, status: 'active', basis: 'explicit_user_statement',
        confidence: 0.99, sensitivity: 'personal',
        validFromUtc: validFrom, validToUtc: validTo,
        observedAtUtc: '2026-08-05T09:00:00.000Z', supersedesAssertionId: null,
        pinned: false, attributes: {},
        searchText: { subject: 'Denys', predicate: 'has role', object: role, scope: '' },
      });

    const past = makeRole('Junior engineer', '2020-01-01T00:00:00.000Z', '2023-01-01T00:00:00.000Z');
    const current = makeRole('Staff engineer', '2023-01-01T00:00:00.000Z', null);
    const future = makeRole('Principal engineer', '2030-01-01T00:00:00.000Z', null);

    const currentIds = assertions
      .listCurrent(context.ownerId, person.id, '2026-08-05T09:00:00.000Z')
      .map((row) => row.id);
    assert.deepEqual(currentIds, [current.id]);

    assertions.retireAssertion(current.id, 'superseded');
    assert.deepEqual(
      assertions.listCurrent(context.ownerId, person.id, '2026-08-05T09:00:00.000Z'),
      [],
    );

    // history stays queryable
    const all = assertions.listBySubject(
      context.ownerId, person.id, ['active', 'superseded', 'expired'],
    );
    assert.equal(all.length, 3);
    assert.ok(all.some((row) => row.id === past.id));
    assert.ok(all.some((row) => row.id === future.id));
  });
});

test('assertion full-text search excludes sensitive assertions', () => {
  withAssistantContext((context) => {
    const nodes = newNodeStore(context);
    const assertions = new AssertionStore(context.database, context.clock, context.ids);
    const person = nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: 'person:self',
      displayName: 'Denys', description: null, sensitivity: 'personal', properties: {},
    });
    const visible = assertions.createAssertion({
      ownerId: context.ownerId, subjectNodeId: person.id, predicate: 'HAS_CONSTRAINT',
      object: { kind: 'literal', valueType: 'string', value: 'Prefers concise answers' },
      scopeNodeId: null, status: 'active', basis: 'explicit_user_statement', confidence: 0.99,
      sensitivity: 'personal', validFromUtc: null, validToUtc: null,
      observedAtUtc: '2026-08-05T09:00:00.000Z', supersedesAssertionId: null,
      pinned: false, attributes: {},
      searchText: {
        subject: 'Denys', predicate: 'has constraint',
        object: 'Prefers concise answers', scope: '',
      },
    });
    assertions.createAssertion({
      ownerId: context.ownerId, subjectNodeId: person.id, predicate: 'LIVES_IN',
      object: { kind: 'literal', valueType: 'string', value: 'Redacted address' },
      scopeNodeId: null, status: 'active', basis: 'explicit_user_statement', confidence: 0.99,
      sensitivity: 'highly_sensitive', validFromUtc: null, validToUtc: null,
      observedAtUtc: '2026-08-05T09:00:00.000Z', supersedesAssertionId: null,
      pinned: false, attributes: {},
      searchText: {
        subject: 'Denys', predicate: 'lives in', object: 'Redacted address', scope: '',
      },
    });

    assert.deepEqual(assertions.searchAssertions(context.ownerId, 'concise', 10), [visible.id]);
    assert.deepEqual(assertions.searchAssertions(context.ownerId, 'redacted', 10), []);
  });
});
```

Add this helper near the top of `tests/assistant-graph-crud.test.ts`, below the imports. It seeds
three evidence rows directly with SQL because `EvidenceStore` does not exist until Task 11:

```ts
import type { AssertionStore as AssertionStoreType } from '../src/assistant/storage/assertion-store.js';

interface SeededAssertion {
  readonly assertions: AssertionStoreType;
  readonly assertionId: string;
  readonly evidenceIds: readonly string[];
}

function seedAssertionWithEvidence(
  context: Parameters<Parameters<typeof withAssistantContext>[0]>[0],
): SeededAssertion {
  const nodes = newNodeStore(context);
  const assertions = new AssertionStore(context.database, context.clock, context.ids);
  const person = nodes.createNode({
    ownerId: context.ownerId, type: 'person', canonicalKey: 'person:self',
    displayName: 'Denys', description: null, sensitivity: 'personal', properties: {},
  });
  const created = assertions.createAssertion({
    ownerId: context.ownerId, subjectNodeId: person.id, predicate: 'HAS_CONSTRAINT',
    object: { kind: 'literal', valueType: 'string', value: 'Short answers' },
    scopeNodeId: null, status: 'active', basis: 'passive_observation', confidence: 0.5,
    sensitivity: 'personal', validFromUtc: null, validToUtc: null,
    observedAtUtc: '2026-08-05T09:00:00.000Z', supersedesAssertionId: null,
    pinned: false, attributes: {},
    searchText: {
      subject: 'Denys', predicate: 'has constraint', object: 'Short answers', scope: '',
    },
  });

  const evidenceIds: string[] = [];
  const insert = context.database.prepare(`
    INSERT INTO evidence_records (
      id, owner_id, device_id, source_event_id, parent_evidence_id, blob_id, source_type,
      source_ref, captured_at_utc, source_timezone, ingested_at_utc, content_hash, mime_type,
      sensitivity, retention_until_utc, status, metadata_json, created_at_utc, updated_at_utc
    ) VALUES (?, ?, NULL, ?, NULL, NULL, 'conversation_message', NULL, ?, NULL, ?, ?, 'text/plain',
              'personal', NULL, 'active', '{}', ?, ?)
  `);
  for (let index = 0; index < 3; index += 1) {
    const id = `ev_seed_${index}`;
    insert.run(
      id, context.ownerId, `evt_${index}`, '2026-08-05T09:00:00.000Z',
      '2026-08-05T09:00:00.000Z', `hash_${index}`,
      '2026-08-05T09:00:00.000Z', '2026-08-05T09:00:00.000Z',
    );
    evidenceIds.push(id);
  }
  return { assertions, assertionId: created.id, evidenceIds };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- assistant-graph-crud`
Expected: FAIL — `Cannot find module '../src/assistant/storage/assertion-store.js'`

- [ ] **Step 3: Write `src/assistant/storage/assertion-store.ts`**

```ts
import { z } from '../../lib/zod.js';
import type { JsonObject } from '../../lib/json-types.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { Clock } from '../clock.js';
import {
  isSensitivityAtLeast,
  type AssertionBasis, type AssertionStatus, type EvidenceStance, type Sensitivity,
} from '../domain/enums.js';
import {
  buildAssertionKey, normalizeLiteralValue, type AssertionObjectRef,
} from '../domain/keys.js';
import type { RelationType } from '../domain/relation-types.js';
import type { IdGenerator } from '../ids.js';
import {
  AssertionEvidenceRowSchema, AssertionRowSchema,
  type AssertionEvidenceRow, type AssertionRow,
} from './rows.js';

/** Plaintext strings indexed for lexical retrieval. Rendered by the caller, never derived here. */
export interface AssertionSearchText {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly scope: string;
}

export interface CreateAssertionInput {
  readonly ownerId: string;
  readonly subjectNodeId: string;
  readonly predicate: RelationType;
  readonly object: AssertionObjectRef;
  readonly scopeNodeId: string | null;
  readonly status: AssertionStatus;
  readonly basis: AssertionBasis;
  readonly confidence: number;
  readonly sensitivity: Sensitivity;
  readonly validFromUtc: string | null;
  readonly validToUtc: string | null;
  readonly observedAtUtc: string;
  readonly supersedesAssertionId: string | null;
  readonly pinned: boolean;
  readonly attributes: JsonObject;
  readonly searchText: AssertionSearchText;
}

/** Statuses that hold the unique assertion key. */
export const LIVE_ASSERTION_STATUSES: readonly AssertionStatus[] = ['active', 'disputed'];

/** An assertion at or above this sensitivity is never written to the plaintext FTS index. */
const FTS_EXCLUSION_FLOOR: Sensitivity = 'sensitive';

export class AssertionStore {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  createAssertion(input: CreateAssertionInput): AssertionRow {
    const id = this.ids.next('ast');
    const nowUtc = this.clock.nowUtc();
    const assertionKey = buildAssertionKey({
      ownerId: input.ownerId,
      subjectNodeId: input.subjectNodeId,
      predicate: input.predicate,
      object: input.object,
      scopeNodeId: input.scopeNodeId,
    });
    const isNodeObject = input.object.kind === 'node';
    this.database.prepare(`
      INSERT INTO graph_assertions (
        id, owner_id, assertion_key, subject_node_id, predicate, object_kind, object_node_id,
        object_value_type, object_value_json, object_normalized_text, scope_node_id, status,
        basis, confidence, sensitivity, valid_from_utc, valid_to_utc, first_observed_at_utc,
        last_observed_at_utc, recorded_at_utc, retired_at_utc, supersedes_assertion_id, pinned,
        attributes_json, created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
    `).run(
      id, input.ownerId, assertionKey, input.subjectNodeId, input.predicate,
      input.object.kind,
      isNodeObject ? input.object.nodeId : null,
      isNodeObject ? null : input.object.valueType,
      isNodeObject ? null : JSON.stringify(input.object.value),
      isNodeObject ? null : normalizeLiteralValue(input.object.valueType, input.object.value),
      input.scopeNodeId, input.status, input.basis, input.confidence, input.sensitivity,
      input.validFromUtc, input.validToUtc, input.observedAtUtc, input.observedAtUtc, nowUtc,
      input.supersedesAssertionId, input.pinned ? 1 : 0,
      JSON.stringify(input.attributes), nowUtc, nowUtc,
    );
    this.refreshFts(id, input.searchText);
    return this.requireAssertion(id);
  }

  getAssertion(assertionId: string): AssertionRow | null {
    const row = this.database.prepare('SELECT * FROM graph_assertions WHERE id = ?').get(assertionId);
    return row === undefined || row === null ? null : AssertionRowSchema.parse(row);
  }

  requireAssertion(assertionId: string): AssertionRow {
    const assertion = this.getAssertion(assertionId);
    if (assertion === null) {
      throw new Error(`Unknown graph assertion: ${assertionId}`);
    }
    return assertion;
  }

  /** The live assertion holding this key, if any. Backs conflict detection in Task 14. */
  findLiveByKey(ownerId: string, assertionKey: string): AssertionRow | null {
    const row = this.database.prepare(`
      SELECT * FROM graph_assertions
      WHERE owner_id = ? AND assertion_key = ? AND status IN ('active', 'disputed')
    `).get(ownerId, assertionKey);
    return row === undefined || row === null ? null : AssertionRowSchema.parse(row);
  }

  listBySubject(
    ownerId: string, subjectNodeId: string, statuses: readonly AssertionStatus[],
  ): AssertionRow[] {
    return this.listByColumn('subject_node_id', ownerId, subjectNodeId, statuses);
  }

  listByObjectNode(
    ownerId: string, objectNodeId: string, statuses: readonly AssertionStatus[],
  ): AssertionRow[] {
    return this.listByColumn('object_node_id', ownerId, objectNodeId, statuses);
  }

  listByScope(
    ownerId: string, scopeNodeId: string, statuses: readonly AssertionStatus[],
  ): AssertionRow[] {
    return this.listByColumn('scope_node_id', ownerId, scopeNodeId, statuses);
  }

  /**
   * Live assertions for a subject whose real-world validity window contains `atUtc`.
   * An open `valid_from` or `valid_to` is treated as unbounded on that side.
   */
  listCurrent(ownerId: string, subjectNodeId: string, atUtc: string): AssertionRow[] {
    return z.array(AssertionRowSchema).parse(this.database.prepare(`
      SELECT * FROM graph_assertions
      WHERE owner_id = ? AND subject_node_id = ? AND status IN ('active', 'disputed')
        AND (valid_from_utc IS NULL OR valid_from_utc <= ?)
        AND (valid_to_utc IS NULL OR valid_to_utc > ?)
      ORDER BY last_observed_at_utc DESC, id ASC
    `).all(ownerId, subjectNodeId, atUtc, atUtc));
  }

  /** Moves an assertion out of the live set, freeing its assertion key. */
  retireAssertion(assertionId: string, status: AssertionStatus): AssertionRow {
    const nowUtc = this.clock.nowUtc();
    this.database.prepare(`
      UPDATE graph_assertions
      SET status = ?, retired_at_utc = ?, updated_at_utc = ? WHERE id = ?
    `).run(status, nowUtc, nowUtc, assertionId);
    this.database.prepare('DELETE FROM graph_assertions_fts WHERE assertion_id = ?').run(assertionId);
    return this.requireAssertion(assertionId);
  }

  setStatus(assertionId: string, status: AssertionStatus): AssertionRow {
    this.database
      .prepare('UPDATE graph_assertions SET status = ?, updated_at_utc = ? WHERE id = ?')
      .run(status, this.clock.nowUtc(), assertionId);
    return this.requireAssertion(assertionId);
  }

  setConfidence(assertionId: string, confidence: number): AssertionRow {
    this.database
      .prepare('UPDATE graph_assertions SET confidence = ?, updated_at_utc = ? WHERE id = ?')
      .run(confidence, this.clock.nowUtc(), assertionId);
    return this.requireAssertion(assertionId);
  }

  setPinned(assertionId: string, pinned: boolean): AssertionRow {
    this.database
      .prepare('UPDATE graph_assertions SET pinned = ?, updated_at_utc = ? WHERE id = ?')
      .run(pinned ? 1 : 0, this.clock.nowUtc(), assertionId);
    return this.requireAssertion(assertionId);
  }

  /** Closes the real-world validity window without retiring the row (§9.3 temporal change). */
  closeValidity(assertionId: string, validToUtc: string): AssertionRow {
    this.database
      .prepare('UPDATE graph_assertions SET valid_to_utc = ?, updated_at_utc = ? WHERE id = ?')
      .run(validToUtc, this.clock.nowUtc(), assertionId);
    return this.requireAssertion(assertionId);
  }

  /** Extends the support window when new evidence arrives for an existing assertion. */
  recordObservation(assertionId: string, observedAtUtc: string): AssertionRow {
    const nowUtc = this.clock.nowUtc();
    this.database.prepare(`
      UPDATE graph_assertions
      SET first_observed_at_utc = MIN(first_observed_at_utc, ?),
          last_observed_at_utc = MAX(last_observed_at_utc, ?),
          updated_at_utc = ?
      WHERE id = ?
    `).run(observedAtUtc, observedAtUtc, nowUtc, assertionId);
    return this.requireAssertion(assertionId);
  }

  /** Re-points a node reference during a merge and recomputes the assertion key. */
  repointNodeReference(
    assertionId: string,
    column: 'subject_node_id' | 'object_node_id' | 'scope_node_id',
    targetNodeId: string,
  ): AssertionRow {
    const existing = this.requireAssertion(assertionId);
    this.database
      .prepare(`UPDATE graph_assertions SET ${column} = ?, updated_at_utc = ? WHERE id = ?`)
      .run(targetNodeId, this.clock.nowUtc(), assertionId);
    const moved = this.requireAssertion(assertionId);
    const objectRef: AssertionObjectRef = moved.object_kind === 'node'
      ? { kind: 'node', nodeId: moved.object_node_id ?? '' }
      : {
        kind: 'literal',
        valueType: moved.object_value_type ?? 'string',
        value: JSON.parse(moved.object_value_json ?? 'null'),
      };
    const rekeyed = buildAssertionKey({
      ownerId: moved.owner_id,
      subjectNodeId: moved.subject_node_id,
      predicate: moved.predicate,
      object: objectRef,
      scopeNodeId: moved.scope_node_id,
    });
    if (rekeyed !== existing.assertion_key) {
      this.database
        .prepare('UPDATE graph_assertions SET assertion_key = ? WHERE id = ?')
        .run(rekeyed, assertionId);
    }
    return this.requireAssertion(assertionId);
  }

  linkEvidence(
    assertionId: string, evidenceId: string, stance: EvidenceStance, weight: number,
  ): AssertionEvidenceRow {
    this.database.prepare(`
      INSERT INTO assertion_evidence (assertion_id, evidence_id, stance, weight, created_at_utc)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(assertion_id, evidence_id, stance) DO UPDATE SET weight = excluded.weight
    `).run(assertionId, evidenceId, stance, weight, this.clock.nowUtc());
    return AssertionEvidenceRowSchema.parse(this.database.prepare(`
      SELECT * FROM assertion_evidence
      WHERE assertion_id = ? AND evidence_id = ? AND stance = ?
    `).get(assertionId, evidenceId, stance));
  }

  unlinkEvidence(assertionId: string, evidenceId: string): void {
    this.database
      .prepare('DELETE FROM assertion_evidence WHERE assertion_id = ? AND evidence_id = ?')
      .run(assertionId, evidenceId);
  }

  listEvidence(assertionId: string): AssertionEvidenceRow[] {
    return z.array(AssertionEvidenceRowSchema).parse(this.database.prepare(`
      SELECT * FROM assertion_evidence WHERE assertion_id = ?
      ORDER BY created_at_utc ASC, evidence_id ASC, stance ASC
    `).all(assertionId));
  }

  /** Supporting weights from non-deleted evidence only, for confidence aggregation. */
  supportWeights(assertionId: string): number[] {
    return z.array(z.object({ weight: z.number() })).parse(this.database.prepare(`
      SELECT ae.weight FROM assertion_evidence ae
      JOIN evidence_records e ON e.id = ae.evidence_id
      WHERE ae.assertion_id = ? AND ae.stance = 'supports' AND e.status <> 'deleted'
      ORDER BY ae.created_at_utc ASC, ae.evidence_id ASC
    `).all(assertionId)).map((row) => row.weight);
  }

  contradictionCount(assertionId: string): number {
    return z.object({ count: z.number() }).parse(this.database.prepare(`
      SELECT COUNT(*) AS count FROM assertion_evidence ae
      JOIN evidence_records e ON e.id = ae.evidence_id
      WHERE ae.assertion_id = ? AND ae.stance = 'contradicts' AND e.status <> 'deleted'
    `).get(assertionId)).count;
  }

  /** Assertions that reference this evidence, used by the deletion cascade. */
  listAssertionIdsForEvidence(evidenceId: string): string[] {
    return z.array(z.object({ assertion_id: z.string() })).parse(this.database.prepare(`
      SELECT DISTINCT assertion_id FROM assertion_evidence WHERE evidence_id = ?
      ORDER BY assertion_id ASC
    `).all(evidenceId)).map((row) => row.assertion_id);
  }

  searchAssertions(ownerId: string, query: string, limit: number): string[] {
    return z.array(z.object({ assertion_id: z.string() })).parse(this.database.prepare(`
      SELECT assertion_id FROM graph_assertions_fts
      WHERE graph_assertions_fts MATCH ? AND owner_id = ?
      ORDER BY rank LIMIT ?
    `).all(query, ownerId, limit)).map((row) => row.assertion_id);
  }

  private listByColumn(
    column: 'subject_node_id' | 'object_node_id' | 'scope_node_id',
    ownerId: string,
    nodeId: string,
    statuses: readonly AssertionStatus[],
  ): AssertionRow[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(', ');
    return z.array(AssertionRowSchema).parse(this.database.prepare(`
      SELECT * FROM graph_assertions
      WHERE owner_id = ? AND ${column} = ? AND status IN (${placeholders})
      ORDER BY last_observed_at_utc DESC, id ASC
    `).all(ownerId, nodeId, ...statuses));
  }

  private refreshFts(assertionId: string, searchText: AssertionSearchText): void {
    this.database.prepare('DELETE FROM graph_assertions_fts WHERE assertion_id = ?').run(assertionId);
    const assertion = this.requireAssertion(assertionId);
    if (!LIVE_ASSERTION_STATUSES.includes(assertion.status)) return;
    if (isSensitivityAtLeast(assertion.sensitivity, FTS_EXCLUSION_FLOOR)) return;
    this.database.prepare(`
      INSERT INTO graph_assertions_fts (
        assertion_id, owner_id, subject_text, predicate_text, object_text, scope_text
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      assertionId, assertion.owner_id, searchText.subject, searchText.predicate,
      searchText.object, searchText.scope,
    );
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- assistant-graph-crud`
Expected: PASS — 20 tests.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/assistant/storage/assertion-store.ts tests/assistant-graph-crud.test.ts
git commit -m "feat(assistant): add assertion store with temporal queries and evidence links"
```

---

## Task 11: Blob cipher, key provider, evidence store

**Files:**
- Create: `src/assistant/crypto/key-provider.ts`, `src/assistant/crypto/blob-cipher.ts`,
  `src/assistant/storage/evidence-store.ts`
- Test: `tests/assistant-evidence-store.test.ts`

Implements §5.6, §13.4, and the path-traversal and tamper mitigations in §17.1.

On-disk envelope layout (all integers big-endian):

```
offset  size  contents
0       6     magic bytes "SKEV1\0"
6       4     header length H
10      H     UTF-8 JSON header: { version, algorithm, keyId, iv, authTag, plaintextSha256 }
10+H    rest  ciphertext
```

- [ ] **Step 1: Write the failing test**

Create `tests/assistant-evidence-store.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { BlobCipher } from '../src/assistant/crypto/blob-cipher.js';
import { RuntimeMetadataKeyProvider } from '../src/assistant/crypto/key-provider.js';
import { hashBytes, hashTextContent } from '../src/assistant/domain/keys.js';
import { EvidenceStore } from '../src/assistant/storage/evidence-store.js';
import { withAssistantContext, type AssistantTestContext } from './helpers/assistant-fixture.js';

function newEvidenceStore(context: AssistantTestContext): EvidenceStore {
  const keys = new RuntimeMetadataKeyProvider(context.database, context.clock);
  return new EvidenceStore(
    context.database, context.clock, context.ids,
    new BlobCipher(keys), path.join(context.runtimeRoot, 'assistant', 'evidence'),
  );
}

test('the key provider creates a 256-bit key once and reuses it', () => {
  withAssistantContext((context) => {
    const keys = new RuntimeMetadataKeyProvider(context.database, context.clock);
    const first = keys.getActiveKey();
    const second = keys.getActiveKey();
    assert.equal(first.material.byteLength, 32);
    assert.equal(first.keyId, second.keyId);
    assert.deepEqual([...first.material], [...second.material]);

    const reloaded = new RuntimeMetadataKeyProvider(context.database, context.clock).getActiveKey();
    assert.equal(reloaded.keyId, first.keyId);
    assert.deepEqual([...reloaded.material], [...first.material]);
  });
});

test('blob cipher round-trips bytes and records the plaintext hash', () => {
  withAssistantContext((context) => {
    const cipher = new BlobCipher(new RuntimeMetadataKeyProvider(context.database, context.clock));
    const plaintext = Buffer.from('screenshot bytes would go here', 'utf8');
    const envelope = cipher.encrypt(plaintext);
    assert.notEqual(envelope.indexOf(plaintext), 0);
    const decrypted = cipher.decrypt(envelope);
    assert.deepEqual([...decrypted], [...plaintext]);
  });
});

test('a tampered ciphertext, auth tag, or header is a hard read error', () => {
  withAssistantContext((context) => {
    const cipher = new BlobCipher(new RuntimeMetadataKeyProvider(context.database, context.clock));
    const envelope = cipher.encrypt(Buffer.from('sensitive', 'utf8'));

    const flippedCiphertext = Buffer.from(envelope);
    flippedCiphertext[flippedCiphertext.length - 1] ^= 0xff;
    assert.throws(() => cipher.decrypt(flippedCiphertext), /authentication|tamper/i);

    const truncated = envelope.subarray(0, envelope.length - 4);
    assert.throws(() => cipher.decrypt(truncated), /authentication|tamper|envelope/i);

    const badMagic = Buffer.from(envelope);
    badMagic[0] = 0x00;
    assert.throws(() => cipher.decrypt(badMagic), /envelope/i);
  });
});

test('text evidence is stored, deduplicated by source event id, and read back', () => {
  withAssistantContext((context) => {
    const evidence = newEvidenceStore(context);
    const first = evidence.recordTextEvidence({
      ownerId: context.ownerId, deviceId: null, sourceEventId: 'chat:msg_1',
      parentEvidenceId: null, sourceType: 'conversation_message', sourceRef: 'session_1',
      capturedAtUtc: '2026-08-05T09:00:00.000Z', sourceTimezone: 'UTC',
      sensitivity: 'personal', retentionUntilUtc: null, metadata: { role: 'user' },
      text: 'I prefer PowerShell on Windows.',
    });
    assert.equal(first.content_hash, hashTextContent('I prefer PowerShell on Windows.'));
    assert.equal(first.status, 'active');
    assert.equal(first.blob_id, null);

    const replay = evidence.recordTextEvidence({
      ownerId: context.ownerId, deviceId: null, sourceEventId: 'chat:msg_1',
      parentEvidenceId: null, sourceType: 'conversation_message', sourceRef: 'session_1',
      capturedAtUtc: '2026-08-05T09:00:00.000Z', sourceTimezone: 'UTC',
      sensitivity: 'personal', retentionUntilUtc: null, metadata: { role: 'user' },
      text: 'I prefer PowerShell on Windows.',
    });
    assert.equal(replay.id, first.id);
    assert.equal(evidence.countEvidence(context.ownerId), 1);
  });
});

test('blob evidence writes one content-addressed encrypted file and shares it across events', () => {
  withAssistantContext((context) => {
    const evidence = newEvidenceStore(context);
    const bytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const shared = {
      ownerId: context.ownerId, deviceId: null, parentEvidenceId: null,
      sourceType: 'screenshot', sourceRef: null, sourceTimezone: 'UTC',
      sensitivity: 'sensitive', retentionUntilUtc: null, metadata: {},
      mimeType: 'image/png', bytes,
    } as const;

    const first = evidence.recordBlobEvidence({
      ...shared, sourceEventId: 'cap_1', capturedAtUtc: '2026-08-05T09:00:00.000Z',
    });
    const second = evidence.recordBlobEvidence({
      ...shared, sourceEventId: 'cap_2', capturedAtUtc: '2026-08-05T09:05:00.000Z',
    });

    assert.notEqual(first.id, second.id);
    assert.equal(first.blob_id, second.blob_id);
    assert.equal(evidence.countBlobs(context.ownerId), 1);

    const blob = evidence.requireBlob(first.blob_id ?? '');
    assert.equal(blob.encrypted, true);
    assert.equal(blob.content_hash, hashBytes(bytes));

    const onDisk = path.join(
      context.runtimeRoot, 'assistant', 'evidence',
      blob.content_hash.slice(0, 2), blob.content_hash,
    );
    assert.ok(fs.existsSync(onDisk));
    assert.equal(fs.readFileSync(onDisk).includes(bytes), false, 'plaintext must not hit disk');

    assert.deepEqual([...evidence.readBlobBytes(blob.id)], [...bytes]);
  });
});

test('reading a blob whose file was swapped for different content is rejected', () => {
  withAssistantContext((context) => {
    const evidence = newEvidenceStore(context);
    const bytes = Buffer.from('original', 'utf8');
    const record = evidence.recordBlobEvidence({
      ownerId: context.ownerId, deviceId: null, sourceEventId: 'cap_1', parentEvidenceId: null,
      sourceType: 'screenshot', sourceRef: null, capturedAtUtc: '2026-08-05T09:00:00.000Z',
      sourceTimezone: 'UTC', sensitivity: 'sensitive', retentionUntilUtc: null, metadata: {},
      mimeType: 'image/png', bytes,
    });
    const blob = evidence.requireBlob(record.blob_id ?? '');
    const onDisk = path.join(
      context.runtimeRoot, 'assistant', 'evidence',
      blob.content_hash.slice(0, 2), blob.content_hash,
    );

    const cipher = new BlobCipher(new RuntimeMetadataKeyProvider(context.database, context.clock));
    fs.writeFileSync(onDisk, cipher.encrypt(Buffer.from('substituted', 'utf8')));
    assert.throws(() => evidence.readBlobBytes(blob.id), /hash mismatch/i);
  });
});

test('a storage uri that escapes the evidence root is rejected before any file access', () => {
  withAssistantContext((context) => {
    const evidence = newEvidenceStore(context);
    assert.throws(
      () => evidence.resolveBlobPath('../../../etc/passwd'),
      /content hash|evidence root/i,
    );
    assert.throws(() => evidence.resolveBlobPath('..'), /content hash|evidence root/i);
    assert.throws(() => evidence.resolveBlobPath(''), /content hash|evidence root/i);
  });
});

test('deleting evidence purges the blob file and marks the record deleted', () => {
  withAssistantContext((context) => {
    const evidence = newEvidenceStore(context);
    const record = evidence.recordBlobEvidence({
      ownerId: context.ownerId, deviceId: null, sourceEventId: 'cap_1', parentEvidenceId: null,
      sourceType: 'screenshot', sourceRef: null, capturedAtUtc: '2026-08-05T09:00:00.000Z',
      sourceTimezone: 'UTC', sensitivity: 'sensitive', retentionUntilUtc: null, metadata: {},
      mimeType: 'image/png', bytes: Buffer.from('bytes', 'utf8'),
    });
    const blob = evidence.requireBlob(record.blob_id ?? '');
    const onDisk = path.join(
      context.runtimeRoot, 'assistant', 'evidence',
      blob.content_hash.slice(0, 2), blob.content_hash,
    );
    assert.ok(fs.existsSync(onDisk));

    evidence.deleteEvidence(record.id);

    assert.equal(fs.existsSync(onDisk), false);
    assert.equal(evidence.requireEvidence(record.id).status, 'deleted');
    assert.equal(evidence.requireBlob(blob.id).deleted_at_utc !== null, true);
  });
});

test('a blob still referenced by another live evidence record survives deletion of one', () => {
  withAssistantContext((context) => {
    const evidence = newEvidenceStore(context);
    const bytes = Buffer.from('shared bytes', 'utf8');
    const shared = {
      ownerId: context.ownerId, deviceId: null, parentEvidenceId: null,
      sourceType: 'screenshot', sourceRef: null, sourceTimezone: 'UTC',
      sensitivity: 'sensitive', retentionUntilUtc: null, metadata: {},
      mimeType: 'image/png', bytes,
    } as const;
    const first = evidence.recordBlobEvidence({
      ...shared, sourceEventId: 'cap_1', capturedAtUtc: '2026-08-05T09:00:00.000Z',
    });
    const second = evidence.recordBlobEvidence({
      ...shared, sourceEventId: 'cap_2', capturedAtUtc: '2026-08-05T09:05:00.000Z',
    });

    evidence.deleteEvidence(first.id);
    assert.equal(evidence.requireEvidence(second.id).status, 'active');
    assert.deepEqual([...evidence.readBlobBytes(second.blob_id ?? '')], [...bytes]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- assistant-evidence-store`
Expected: FAIL — `Cannot find module '../src/assistant/crypto/blob-cipher.js'`

- [ ] **Step 3: Write `src/assistant/crypto/key-provider.ts`**

```ts
import { randomBytes, randomUUID } from 'node:crypto';

import { z } from '../../lib/zod.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { Clock } from '../clock.js';

export interface AssistantEncryptionKey {
  readonly keyId: string;
  readonly material: Buffer;
}

/**
 * Source of the AES-256 key used for evidence blobs. Gate D adds a native OS-keychain
 * implementation; both satisfy this interface and the assistant works with either.
 */
export interface AssistantKeyProvider {
  getActiveKey(): AssistantEncryptionKey;
  getKeyById(keyId: string): AssistantEncryptionKey;
}

const KEY_ID_METADATA_KEY = 'assistant.evidence.key_id';
const KEY_MATERIAL_METADATA_PREFIX = 'assistant.evidence.key.';
const KEY_BYTE_LENGTH = 32;

/**
 * Stores the key in `runtime_metadata`. This protects evidence blobs against casual file
 * inspection and against blob theft without the database, but NOT against an attacker who can
 * read the runtime database. The UI must say so plainly (design §4.7) and must not describe the
 * database itself as encrypted at rest.
 */
export class RuntimeMetadataKeyProvider implements AssistantKeyProvider {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly clock: Clock,
  ) {}

  getActiveKey(): AssistantEncryptionKey {
    const existingId = this.readMetadata(KEY_ID_METADATA_KEY);
    if (existingId !== null) {
      return this.getKeyById(existingId);
    }
    const keyId = randomUUID();
    const material = randomBytes(KEY_BYTE_LENGTH);
    this.writeMetadata(`${KEY_MATERIAL_METADATA_PREFIX}${keyId}`, material.toString('base64'));
    this.writeMetadata(KEY_ID_METADATA_KEY, keyId);
    return { keyId, material };
  }

  getKeyById(keyId: string): AssistantEncryptionKey {
    const encoded = this.readMetadata(`${KEY_MATERIAL_METADATA_PREFIX}${keyId}`);
    if (encoded === null) {
      throw new Error(`Evidence encryption key ${keyId} is not available.`);
    }
    const material = Buffer.from(encoded, 'base64');
    if (material.byteLength !== KEY_BYTE_LENGTH) {
      throw new Error(`Evidence encryption key ${keyId} has the wrong length.`);
    }
    return { keyId, material };
  }

  private readMetadata(key: string): string | null {
    const row = this.database
      .prepare('SELECT value FROM runtime_metadata WHERE key = ?')
      .get(key);
    return row === undefined || row === null
      ? null
      : z.object({ value: z.string() }).parse(row).value;
  }

  private writeMetadata(key: string, value: string): void {
    this.database.prepare(`
      INSERT INTO runtime_metadata (key, value, updated_at_utc) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_utc = excluded.updated_at_utc
    `).run(key, value, this.clock.nowUtc());
  }
}
```

- [ ] **Step 4: Write `src/assistant/crypto/blob-cipher.ts`**

```ts
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { z } from '../../lib/zod.js';
import type { AssistantKeyProvider } from './key-provider.js';

const MAGIC = Buffer.from('SKEV1\0', 'latin1');
const HEADER_LENGTH_BYTES = 4;
const IV_BYTE_LENGTH = 12;
const ALGORITHM = 'aes-256-gcm';

const EnvelopeHeaderSchema = z.object({
  version: z.literal(1),
  algorithm: z.literal('AES-256-GCM'),
  keyId: z.string().min(1),
  iv: z.string().min(1),
  authTag: z.string().min(1),
  plaintextSha256: z.string().length(64),
});

/**
 * AES-256-GCM envelope encryption for evidence blobs. A failed auth tag or a plaintext hash
 * mismatch is a hard read error — never a silent fallback (§13.4).
 */
export class BlobCipher {
  constructor(private readonly keys: AssistantKeyProvider) {}

  encrypt(plaintext: Buffer): Buffer {
    const key = this.keys.getActiveKey();
    const iv = randomBytes(IV_BYTE_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key.material, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const header = Buffer.from(JSON.stringify({
      version: 1,
      algorithm: 'AES-256-GCM',
      keyId: key.keyId,
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      plaintextSha256: createHash('sha256').update(plaintext).digest('hex'),
    }), 'utf8');
    const headerLength = Buffer.alloc(HEADER_LENGTH_BYTES);
    headerLength.writeUInt32BE(header.byteLength, 0);
    return Buffer.concat([MAGIC, headerLength, header, ciphertext]);
  }

  decrypt(envelope: Buffer): Buffer {
    if (envelope.byteLength < MAGIC.byteLength + HEADER_LENGTH_BYTES) {
      throw new Error('Evidence envelope is truncated.');
    }
    if (!envelope.subarray(0, MAGIC.byteLength).equals(MAGIC)) {
      throw new Error('Evidence envelope has an unrecognized magic prefix.');
    }
    const headerLength = envelope.readUInt32BE(MAGIC.byteLength);
    const headerStart = MAGIC.byteLength + HEADER_LENGTH_BYTES;
    const headerEnd = headerStart + headerLength;
    if (headerEnd > envelope.byteLength) {
      throw new Error('Evidence envelope header length exceeds the payload.');
    }

    const header = EnvelopeHeaderSchema.parse(
      JSON.parse(envelope.subarray(headerStart, headerEnd).toString('utf8')),
    );
    const key = this.keys.getKeyById(header.keyId);
    const decipher = createDecipheriv(
      ALGORITHM, key.material, Buffer.from(header.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(header.authTag, 'base64'));

    let plaintext: Buffer;
    try {
      plaintext = Buffer.concat([
        decipher.update(envelope.subarray(headerEnd)),
        decipher.final(),
      ]);
    } catch {
      throw new Error('Evidence envelope failed authentication; the blob has been tampered with.');
    }

    const actualHash = createHash('sha256').update(plaintext).digest('hex');
    if (actualHash !== header.plaintextSha256) {
      throw new Error('Evidence envelope plaintext hash mismatch; the blob has been tampered with.');
    }
    return plaintext;
  }
}
```

- [ ] **Step 5: Write `src/assistant/storage/evidence-store.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';

import { z } from '../../lib/zod.js';
import type { JsonObject } from '../../lib/json-types.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { Clock } from '../clock.js';
import type { BlobCipher } from '../crypto/blob-cipher.js';
import type { EvidenceSourceType, EvidenceStatus, Sensitivity } from '../domain/enums.js';
import { hashBytes, hashTextContent } from '../domain/keys.js';
import type { IdGenerator } from '../ids.js';
import { BlobRowSchema, EvidenceRowSchema, type BlobRow, type EvidenceRow } from './rows.js';

interface EvidenceCommonInput {
  readonly ownerId: string;
  readonly deviceId: string | null;
  readonly sourceEventId: string;
  readonly parentEvidenceId: string | null;
  readonly sourceType: EvidenceSourceType;
  readonly sourceRef: string | null;
  readonly capturedAtUtc: string;
  readonly sourceTimezone: string | null;
  readonly sensitivity: Sensitivity;
  readonly retentionUntilUtc: string | null;
  readonly metadata: JsonObject;
}

export interface RecordTextEvidenceInput extends EvidenceCommonInput {
  readonly text: string;
}

export interface RecordBlobEvidenceInput extends EvidenceCommonInput {
  readonly mimeType: string;
  readonly bytes: Buffer;
}

const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Owns evidence records and encrypted blob files. Storage URIs are derived from the content hash
 * only; any other shape is rejected before a path is built (§5.6, §17.1 path traversal).
 */
export class EvidenceStore {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly cipher: BlobCipher,
    private readonly evidenceRoot: string,
  ) {}

  recordTextEvidence(input: RecordTextEvidenceInput): EvidenceRow {
    const existing = this.findBySourceEventId(input.ownerId, input.sourceEventId);
    if (existing !== null) return existing;
    return this.insertEvidence(input, hashTextContent(input.text), null, 'text/plain');
  }

  recordBlobEvidence(input: RecordBlobEvidenceInput): EvidenceRow {
    const existing = this.findBySourceEventId(input.ownerId, input.sourceEventId);
    if (existing !== null) return existing;
    const contentHash = hashBytes(input.bytes);
    const blob = this.persistBlob(input.ownerId, contentHash, input.mimeType, input.bytes);
    return this.insertEvidence(input, contentHash, blob.id, input.mimeType);
  }

  getEvidence(evidenceId: string): EvidenceRow | null {
    const row = this.database.prepare('SELECT * FROM evidence_records WHERE id = ?').get(evidenceId);
    return row === undefined || row === null ? null : EvidenceRowSchema.parse(row);
  }

  requireEvidence(evidenceId: string): EvidenceRow {
    const evidence = this.getEvidence(evidenceId);
    if (evidence === null) {
      throw new Error(`Unknown evidence record: ${evidenceId}`);
    }
    return evidence;
  }

  findBySourceEventId(ownerId: string, sourceEventId: string): EvidenceRow | null {
    const row = this.database
      .prepare('SELECT * FROM evidence_records WHERE owner_id = ? AND source_event_id = ?')
      .get(ownerId, sourceEventId);
    return row === undefined || row === null ? null : EvidenceRowSchema.parse(row);
  }

  countEvidence(ownerId: string): number {
    return z.object({ count: z.number() }).parse(this.database
      .prepare("SELECT COUNT(*) AS count FROM evidence_records WHERE owner_id = ? AND status <> 'deleted'")
      .get(ownerId)).count;
  }

  countBlobs(ownerId: string): number {
    return z.object({ count: z.number() }).parse(this.database
      .prepare('SELECT COUNT(*) AS count FROM evidence_blobs WHERE owner_id = ? AND deleted_at_utc IS NULL')
      .get(ownerId)).count;
  }

  requireBlob(blobId: string): BlobRow {
    const row = this.database.prepare('SELECT * FROM evidence_blobs WHERE id = ?').get(blobId);
    if (row === undefined || row === null) {
      throw new Error(`Unknown evidence blob: ${blobId}`);
    }
    return BlobRowSchema.parse(row);
  }

  setStatus(evidenceId: string, status: EvidenceStatus): EvidenceRow {
    const nowUtc = this.clock.nowUtc();
    this.database
      .prepare('UPDATE evidence_records SET status = ?, updated_at_utc = ? WHERE id = ?')
      .run(status, nowUtc, evidenceId);
    return this.requireEvidence(evidenceId);
  }

  /**
   * Marks the record deleted and purges its blob file, but only when no other live record still
   * references that blob.
   */
  deleteEvidence(evidenceId: string): EvidenceRow {
    const evidence = this.requireEvidence(evidenceId);
    this.setStatus(evidenceId, 'deleted');
    if (evidence.blob_id === null) return this.requireEvidence(evidenceId);

    const remaining = z.object({ count: z.number() }).parse(this.database.prepare(`
      SELECT COUNT(*) AS count FROM evidence_records
      WHERE blob_id = ? AND status <> 'deleted'
    `).get(evidence.blob_id)).count;
    if (remaining > 0) return this.requireEvidence(evidenceId);

    const blob = this.requireBlob(evidence.blob_id);
    const filePath = this.resolveBlobPath(blob.storage_uri);
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath);
    }
    this.database
      .prepare('UPDATE evidence_blobs SET deleted_at_utc = ? WHERE id = ?')
      .run(this.clock.nowUtc(), blob.id);
    return this.requireEvidence(evidenceId);
  }

  readBlobBytes(blobId: string): Buffer {
    const blob = this.requireBlob(blobId);
    if (blob.deleted_at_utc !== null) {
      throw new Error(`Evidence blob ${blobId} has been deleted.`);
    }
    const plaintext = this.cipher.decrypt(fs.readFileSync(this.resolveBlobPath(blob.storage_uri)));
    if (hashBytes(plaintext) !== blob.content_hash) {
      throw new Error(`Evidence blob ${blobId} content hash mismatch.`);
    }
    return plaintext;
  }

  /**
   * A storage URI is a bare content hash. Anything else — a path, a traversal, an empty string —
   * is rejected before a filesystem path is constructed.
   */
  resolveBlobPath(storageUri: string): string {
    if (!CONTENT_HASH_PATTERN.test(storageUri)) {
      throw new Error(
        `Evidence storage URI must be a bare SHA-256 content hash, received: ${storageUri}`,
      );
    }
    const resolved = path.resolve(this.evidenceRoot, storageUri.slice(0, 2), storageUri);
    const root = path.resolve(this.evidenceRoot);
    if (!resolved.startsWith(root + path.sep)) {
      throw new Error('Evidence storage URI escapes the evidence root.');
    }
    return resolved;
  }

  private persistBlob(
    ownerId: string, contentHash: string, mimeType: string, bytes: Buffer,
  ): BlobRow {
    const existing = this.database
      .prepare('SELECT * FROM evidence_blobs WHERE owner_id = ? AND content_hash = ?')
      .get(ownerId, contentHash);
    if (existing !== undefined && existing !== null) {
      return BlobRowSchema.parse(existing);
    }

    const filePath = this.resolveBlobPath(contentHash);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, this.cipher.encrypt(bytes));

    const id = this.ids.next('blob');
    this.database.prepare(`
      INSERT INTO evidence_blobs (
        id, owner_id, content_hash, byte_length, mime_type, storage_uri, encrypted, key_id,
        created_at_utc, deleted_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, NULL)
    `).run(
      id, ownerId, contentHash, bytes.byteLength, mimeType, contentHash, this.clock.nowUtc(),
    );
    return this.requireBlob(id);
  }

  private insertEvidence(
    input: EvidenceCommonInput, contentHash: string, blobId: string | null, mimeType: string,
  ): EvidenceRow {
    const id = this.ids.next('ev');
    const nowUtc = this.clock.nowUtc();
    this.database.prepare(`
      INSERT INTO evidence_records (
        id, owner_id, device_id, source_event_id, parent_evidence_id, blob_id, source_type,
        source_ref, captured_at_utc, source_timezone, ingested_at_utc, content_hash, mime_type,
        sensitivity, retention_until_utc, status, metadata_json, created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `).run(
      id, input.ownerId, input.deviceId, input.sourceEventId, input.parentEvidenceId, blobId,
      input.sourceType, input.sourceRef, input.capturedAtUtc, input.sourceTimezone, nowUtc,
      contentHash, mimeType, input.sensitivity, input.retentionUntilUtc,
      JSON.stringify(input.metadata), nowUtc, nowUtc,
    );
    return this.requireEvidence(id);
  }
}
```

- [ ] **Step 6: Run tests**

Run: `npm test -- assistant-evidence-store`
Expected: PASS — 9 tests.

- [ ] **Step 7: Lint and commit**

```bash
npm run lint
git add src/assistant/crypto/key-provider.ts src/assistant/crypto/blob-cipher.ts \
        src/assistant/storage/evidence-store.ts tests/assistant-evidence-store.test.ts
git commit -m "feat(assistant): add encrypted evidence store with tamper and traversal guards"
```

---

## Task 12: Policy store

**Files:**
- Create: `src/assistant/storage/policy-store.ts`
- Test: `tests/assistant-policies.test.ts`

`assistant_policies` holds the unbounded per-subject rules (§6.2). Gate A needs three of the five
types: `never_infer_topic`, `do_not_merge_node`, and `assertion_lock`. The other two
(`blocked_question_topic`, `capture_exclusion`) are stored and read by the same generic API, so no
new code is needed for them in Gate C/D.

- [ ] **Step 1: Write the failing test**

Create `tests/assistant-policies.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { PolicyStore } from '../src/assistant/storage/policy-store.js';
import { withAssistantContext, type AssistantTestContext } from './helpers/assistant-fixture.js';

function newPolicyStore(context: AssistantTestContext): PolicyStore {
  return new PolicyStore(context.database, context.clock, context.ids);
}

test('a policy is created, read by type and key, and listed', () => {
  withAssistantContext((context) => {
    const policies = newPolicyStore(context);
    const created = policies.upsertPolicy({
      ownerId: context.ownerId, policyType: 'never_infer_topic', key: 'health',
      value: { reason: 'user asked' }, enabled: true, source: 'user',
    });
    assert.equal(created.policy_type, 'never_infer_topic');
    assert.equal(created.enabled, true);

    const found = policies.findPolicy(context.ownerId, 'never_infer_topic', 'health');
    assert.equal(found?.id, created.id);
    assert.deepEqual(
      policies.listPolicies(context.ownerId, 'never_infer_topic').map((row) => row.key),
      ['health'],
    );
  });
});

test('upserting the same type and key updates in place rather than duplicating', () => {
  withAssistantContext((context) => {
    const policies = newPolicyStore(context);
    const first = policies.upsertPolicy({
      ownerId: context.ownerId, policyType: 'never_infer_topic', key: 'finance',
      value: { reason: 'v1' }, enabled: true, source: 'user',
    });
    const second = policies.upsertPolicy({
      ownerId: context.ownerId, policyType: 'never_infer_topic', key: 'finance',
      value: { reason: 'v2' }, enabled: false, source: 'user',
    });
    assert.equal(second.id, first.id);
    assert.equal(second.enabled, false);
    assert.equal(JSON.parse(second.value_json).reason, 'v2');
    assert.equal(policies.listPolicies(context.ownerId, 'never_infer_topic').length, 1);
  });
});

test('a disabled policy is not enforced', () => {
  withAssistantContext((context) => {
    const policies = newPolicyStore(context);
    policies.upsertPolicy({
      ownerId: context.ownerId, policyType: 'never_infer_topic', key: 'health',
      value: {}, enabled: false, source: 'user',
    });
    assert.equal(policies.isTopicBlockedFromInference(context.ownerId, 'health'), false);

    policies.setEnabled(context.ownerId, 'never_infer_topic', 'health', true);
    assert.equal(policies.isTopicBlockedFromInference(context.ownerId, 'health'), true);
  });
});

test('never-infer topic matching is normalized, not raw', () => {
  withAssistantContext((context) => {
    const policies = newPolicyStore(context);
    policies.upsertPolicy({
      ownerId: context.ownerId, policyType: 'never_infer_topic', key: '  Mental   Health ',
      value: {}, enabled: true, source: 'user',
    });
    assert.equal(policies.isTopicBlockedFromInference(context.ownerId, 'mental health'), true);
    assert.equal(policies.isTopicBlockedFromInference(context.ownerId, 'MENTAL HEALTH'), true);
    assert.equal(policies.isTopicBlockedFromInference(context.ownerId, 'health'), false);
  });
});

test('do-not-merge is symmetric across the node pair', () => {
  withAssistantContext((context) => {
    const policies = newPolicyStore(context);
    policies.blockMerge(context.ownerId, 'node_b', 'node_a', 'the user said they differ');
    assert.equal(policies.isMergeBlocked(context.ownerId, 'node_a', 'node_b'), true);
    assert.equal(policies.isMergeBlocked(context.ownerId, 'node_b', 'node_a'), true);
    assert.equal(policies.isMergeBlocked(context.ownerId, 'node_a', 'node_c'), false);
  });
});

test('an assertion lock is set, queried, and cleared', () => {
  withAssistantContext((context) => {
    const policies = newPolicyStore(context);
    assert.equal(policies.isAssertionLocked(context.ownerId, 'ast_1'), false);
    policies.lockAssertion(context.ownerId, 'ast_1', 'user pinned this fact');
    assert.equal(policies.isAssertionLocked(context.ownerId, 'ast_1'), true);
    policies.deletePolicy(context.ownerId, 'assertion_lock', 'ast_1');
    assert.equal(policies.isAssertionLocked(context.ownerId, 'ast_1'), false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- assistant-policies`
Expected: FAIL — `Cannot find module '../src/assistant/storage/policy-store.js'`

- [ ] **Step 3: Write `src/assistant/storage/policy-store.ts`**

```ts
import { z } from '../../lib/zod.js';
import type { JsonObject } from '../../lib/json-types.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { Clock } from '../clock.js';
import type { PolicySource, PolicyType } from '../domain/enums.js';
import { normalizeAliasText } from '../domain/keys.js';
import type { IdGenerator } from '../ids.js';
import { PolicyRowSchema, type PolicyRow } from './rows.js';

export interface UpsertPolicyInput {
  readonly ownerId: string;
  readonly policyType: PolicyType;
  readonly key: string;
  readonly value: JsonObject;
  readonly enabled: boolean;
  readonly source: PolicySource;
}

/** Builds the symmetric key for a do-not-merge pair so order never matters. */
function mergePairKey(firstNodeId: string, secondNodeId: string): string {
  return [firstNodeId, secondNodeId].sort().join('|');
}

export class PolicyStore {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  upsertPolicy(input: UpsertPolicyInput): PolicyRow {
    const normalizedKey = normalizeAliasText(input.key);
    const nowUtc = this.clock.nowUtc();
    this.database.prepare(`
      INSERT INTO assistant_policies (
        id, owner_id, policy_type, key, value_json, enabled, source, created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_id, policy_type, key) DO UPDATE SET
        value_json = excluded.value_json,
        enabled = excluded.enabled,
        source = excluded.source,
        updated_at_utc = excluded.updated_at_utc
    `).run(
      this.ids.next('pol'), input.ownerId, input.policyType, normalizedKey,
      JSON.stringify(input.value), input.enabled ? 1 : 0, input.source, nowUtc, nowUtc,
    );
    const stored = this.findPolicy(input.ownerId, input.policyType, normalizedKey);
    if (stored === null) {
      throw new Error(`Policy ${input.policyType}:${normalizedKey} vanished after upsert.`);
    }
    return stored;
  }

  findPolicy(ownerId: string, policyType: PolicyType, key: string): PolicyRow | null {
    const row = this.database.prepare(`
      SELECT * FROM assistant_policies WHERE owner_id = ? AND policy_type = ? AND key = ?
    `).get(ownerId, policyType, normalizeAliasText(key));
    return row === undefined || row === null ? null : PolicyRowSchema.parse(row);
  }

  listPolicies(ownerId: string, policyType?: PolicyType): PolicyRow[] {
    const rows = policyType === undefined
      ? this.database.prepare(`
          SELECT * FROM assistant_policies WHERE owner_id = ? ORDER BY policy_type ASC, key ASC
        `).all(ownerId)
      : this.database.prepare(`
          SELECT * FROM assistant_policies WHERE owner_id = ? AND policy_type = ? ORDER BY key ASC
        `).all(ownerId, policyType);
    return z.array(PolicyRowSchema).parse(rows);
  }

  setEnabled(ownerId: string, policyType: PolicyType, key: string, enabled: boolean): void {
    this.database.prepare(`
      UPDATE assistant_policies SET enabled = ?, updated_at_utc = ?
      WHERE owner_id = ? AND policy_type = ? AND key = ?
    `).run(enabled ? 1 : 0, this.clock.nowUtc(), ownerId, policyType, normalizeAliasText(key));
  }

  deletePolicy(ownerId: string, policyType: PolicyType, key: string): void {
    this.database.prepare(`
      DELETE FROM assistant_policies WHERE owner_id = ? AND policy_type = ? AND key = ?
    `).run(ownerId, policyType, normalizeAliasText(key));
  }

  isTopicBlockedFromInference(ownerId: string, topic: string): boolean {
    return this.isEnabled(ownerId, 'never_infer_topic', topic);
  }

  blockMerge(ownerId: string, firstNodeId: string, secondNodeId: string, reason: string): PolicyRow {
    return this.upsertPolicy({
      ownerId, policyType: 'do_not_merge_node',
      key: mergePairKey(firstNodeId, secondNodeId),
      value: { reason, nodeIds: [firstNodeId, secondNodeId].sort() },
      enabled: true, source: 'user',
    });
  }

  isMergeBlocked(ownerId: string, firstNodeId: string, secondNodeId: string): boolean {
    return this.isEnabled(ownerId, 'do_not_merge_node', mergePairKey(firstNodeId, secondNodeId));
  }

  lockAssertion(ownerId: string, assertionId: string, reason: string): PolicyRow {
    return this.upsertPolicy({
      ownerId, policyType: 'assertion_lock', key: assertionId,
      value: { reason }, enabled: true, source: 'user',
    });
  }

  isAssertionLocked(ownerId: string, assertionId: string): boolean {
    return this.isEnabled(ownerId, 'assertion_lock', assertionId);
  }

  private isEnabled(ownerId: string, policyType: PolicyType, key: string): boolean {
    const policy = this.findPolicy(ownerId, policyType, key);
    return policy !== null && policy.enabled;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- assistant-policies`
Expected: PASS — 6 tests.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/assistant/storage/policy-store.ts tests/assistant-policies.test.ts
git commit -m "feat(assistant): add policy store"
```

---

## Task 13: Assertion validator

**Files:**
- Create: `src/assistant/graph/validation.ts`
- Test: `tests/assistant-validation.test.ts`

Implements the deterministic subset of §8.3 that applies to a fully-resolved assertion request.
The model-output-specific rules (empty rationale, duplicate candidate from one observation, quoted
third-party text) belong to the candidate pipeline in Gate B and are not implemented here — those
inputs do not exist yet.

Validation returns a typed result rather than throwing, so the caller can record a rejection reason
in the mutation log.

- [ ] **Step 1: Write the failing test**

Create `tests/assistant-validation.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { AssertionValidator } from '../src/assistant/graph/validation.js';
import { NodeStore } from '../src/assistant/storage/node-store.js';
import { PolicyStore } from '../src/assistant/storage/policy-store.js';
import { withAssistantContext, type AssistantTestContext } from './helpers/assistant-fixture.js';

interface ValidationHarness {
  readonly validator: AssertionValidator;
  readonly nodes: NodeStore;
  readonly policies: PolicyStore;
  readonly personId: string;
  readonly softwareId: string;
  readonly scopeId: string;
}

function harness(context: AssistantTestContext): ValidationHarness {
  const nodes = new NodeStore(context.database, context.clock, context.ids);
  const policies = new PolicyStore(context.database, context.clock, context.ids);
  const person = nodes.createNode({
    ownerId: context.ownerId, type: 'person', canonicalKey: 'person:self',
    displayName: 'Denys', description: null, sensitivity: 'personal', properties: {},
  });
  const software = nodes.createNode({
    ownerId: context.ownerId, type: 'software', canonicalKey: 'software:powershell',
    displayName: 'PowerShell', description: null, sensitivity: 'low', properties: {},
  });
  const scope = nodes.createNode({
    ownerId: context.ownerId, type: 'preference_context', canonicalKey: 'context:windows',
    displayName: 'Windows command examples', description: null,
    sensitivity: 'low', properties: {},
  });
  return {
    validator: new AssertionValidator(nodes, policies),
    nodes, policies,
    personId: person.id, softwareId: software.id, scopeId: scope.id,
  };
}

test('a well-formed request validates', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const result = h.validator.validate({
      ownerId: context.ownerId, subjectNodeId: h.personId, predicate: 'PREFERS',
      object: { kind: 'node', nodeId: h.softwareId }, scopeNodeId: h.scopeId,
      basis: 'explicit_user_statement', confidence: 0.99, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, topics: ['tooling'],
    });
    assert.equal(result.ok, true);
  });
});

test('an unknown predicate is rejected', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const result = h.validator.validate({
      ownerId: context.ownerId, subjectNodeId: h.personId, predicate: 'ENJOYS_DEEPLY',
      object: { kind: 'node', nodeId: h.softwareId }, scopeNodeId: null,
      basis: 'explicit_user_statement', confidence: 0.9, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, topics: [],
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, 'unknown_predicate');
  });
});

test('a subject or object node type outside the descriptor is rejected', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const wrongSubject = h.validator.validate({
      ownerId: context.ownerId, subjectNodeId: h.softwareId, predicate: 'PREFERS',
      object: { kind: 'node', nodeId: h.softwareId }, scopeNodeId: null,
      basis: 'explicit_user_statement', confidence: 0.9, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, topics: [],
    });
    assert.equal(wrongSubject.ok === false && wrongSubject.code, 'subject_type_not_allowed');

    const wrongObject = h.validator.validate({
      ownerId: context.ownerId, subjectNodeId: h.personId, predicate: 'OWNS',
      object: { kind: 'node', nodeId: h.scopeId }, scopeNodeId: null,
      basis: 'explicit_user_statement', confidence: 0.9, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, topics: [],
    });
    assert.equal(wrongObject.ok === false && wrongObject.code, 'object_type_not_allowed');
  });
});

test('object kind must match the descriptor', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const literalWhereNodeExpected = h.validator.validate({
      ownerId: context.ownerId, subjectNodeId: h.personId, predicate: 'OWNS',
      object: { kind: 'literal', valueType: 'string', value: 'a laptop' }, scopeNodeId: null,
      basis: 'explicit_user_statement', confidence: 0.9, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, topics: [],
    });
    assert.equal(literalWhereNodeExpected.ok === false && literalWhereNodeExpected.code,
      'literal_object_not_allowed');

    const nodeWhereLiteralExpected = h.validator.validate({
      ownerId: context.ownerId, subjectNodeId: h.personId, predicate: 'HAS_ROLE',
      object: { kind: 'node', nodeId: h.softwareId }, scopeNodeId: null,
      basis: 'explicit_user_statement', confidence: 0.9, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, topics: [],
    });
    assert.equal(nodeWhereLiteralExpected.ok === false && nodeWhereLiteralExpected.code,
      'node_object_not_allowed');
  });
});

test('a missing, deleted, or merged node reference is rejected', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const missing = h.validator.validate({
      ownerId: context.ownerId, subjectNodeId: 'node_missing', predicate: 'PREFERS',
      object: { kind: 'node', nodeId: h.softwareId }, scopeNodeId: null,
      basis: 'explicit_user_statement', confidence: 0.9, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, topics: [],
    });
    assert.equal(missing.ok === false && missing.code, 'subject_unresolved');

    h.nodes.setNodeStatus(h.softwareId, 'deleted');
    const deleted = h.validator.validate({
      ownerId: context.ownerId, subjectNodeId: h.personId, predicate: 'PREFERS',
      object: { kind: 'node', nodeId: h.softwareId }, scopeNodeId: null,
      basis: 'explicit_user_statement', confidence: 0.9, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, topics: [],
    });
    assert.equal(deleted.ok === false && deleted.code, 'object_unresolved');
  });
});

test('confidence above the basis ceiling is rejected', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const result = h.validator.validate({
      ownerId: context.ownerId, subjectNodeId: h.personId, predicate: 'USES',
      object: { kind: 'node', nodeId: h.softwareId }, scopeNodeId: null,
      basis: 'passive_observation', confidence: 0.95, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, topics: [],
    });
    assert.equal(result.ok === false && result.code, 'confidence_above_ceiling');
  });
});

test('secret_prohibited content is rejected outright', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const result = h.validator.validate({
      ownerId: context.ownerId, subjectNodeId: h.personId, predicate: 'USES',
      object: { kind: 'node', nodeId: h.softwareId }, scopeNodeId: null,
      basis: 'explicit_user_statement', confidence: 0.9, sensitivity: 'secret_prohibited',
      validFromUtc: null, validToUtc: null, topics: [],
    });
    assert.equal(result.ok === false && result.code, 'secret_prohibited');
  });
});

test('a never_infer_topic policy blocks a non-explicit assertion but not an explicit one', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    h.policies.upsertPolicy({
      ownerId: context.ownerId, policyType: 'never_infer_topic', key: 'health',
      value: {}, enabled: true, source: 'user',
    });
    const inferred = h.validator.validate({
      ownerId: context.ownerId, subjectNodeId: h.personId, predicate: 'INTERESTED_IN',
      object: { kind: 'node', nodeId: h.softwareId }, scopeNodeId: null,
      basis: 'assistant_inference', confidence: 0.5, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, topics: ['Health'],
    });
    assert.equal(inferred.ok === false && inferred.code, 'blocked_topic');

    const stated = h.validator.validate({
      ownerId: context.ownerId, subjectNodeId: h.personId, predicate: 'INTERESTED_IN',
      object: { kind: 'node', nodeId: h.softwareId }, scopeNodeId: null,
      basis: 'explicit_user_statement', confidence: 0.9, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, topics: ['Health'],
    });
    assert.equal(stated.ok, true);
  });
});

test('a required temporal window must be present and internally consistent', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const organization = h.nodes.createNode({
      ownerId: context.ownerId, type: 'organization', canonicalKey: 'org:acme',
      displayName: 'Acme', description: null, sensitivity: 'personal', properties: {},
    });
    const missingWindow = h.validator.validate({
      ownerId: context.ownerId, subjectNodeId: h.personId, predicate: 'EMPLOYED_BY',
      object: { kind: 'node', nodeId: organization.id }, scopeNodeId: null,
      basis: 'explicit_user_statement', confidence: 0.9, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, topics: [],
    });
    assert.equal(missingWindow.ok === false && missingWindow.code, 'temporal_window_required');

    const inverted = h.validator.validate({
      ownerId: context.ownerId, subjectNodeId: h.personId, predicate: 'EMPLOYED_BY',
      object: { kind: 'node', nodeId: organization.id }, scopeNodeId: null,
      basis: 'explicit_user_statement', confidence: 0.9, sensitivity: 'personal',
      validFromUtc: '2026-01-01T00:00:00.000Z', validToUtc: '2025-01-01T00:00:00.000Z',
      topics: [],
    });
    assert.equal(inverted.ok === false && inverted.code, 'temporal_window_inconsistent');

    const malformed = h.validator.validate({
      ownerId: context.ownerId, subjectNodeId: h.personId, predicate: 'EMPLOYED_BY',
      object: { kind: 'node', nodeId: organization.id }, scopeNodeId: null,
      basis: 'explicit_user_statement', confidence: 0.9, sensitivity: 'personal',
      validFromUtc: 'last tuesday', validToUtc: null, topics: [],
    });
    assert.equal(malformed.ok === false && malformed.code, 'temporal_window_malformed');
  });
});

test('a scope node must be a preference_context', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const result = h.validator.validate({
      ownerId: context.ownerId, subjectNodeId: h.personId, predicate: 'PREFERS',
      object: { kind: 'node', nodeId: h.softwareId }, scopeNodeId: h.softwareId,
      basis: 'explicit_user_statement', confidence: 0.9, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, topics: [],
    });
    assert.equal(result.ok === false && result.code, 'scope_type_not_allowed');
  });
});

test('a literal value that does not match its declared type is rejected', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const result = h.validator.validate({
      ownerId: context.ownerId, subjectNodeId: h.personId, predicate: 'HAS_ROLE',
      object: { kind: 'literal', valueType: 'integer', value: 'not a number' },
      scopeNodeId: null, basis: 'explicit_user_statement', confidence: 0.9,
      sensitivity: 'personal', validFromUtc: null, validToUtc: null, topics: [],
    });
    assert.equal(result.ok === false && result.code, 'literal_value_invalid');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- assistant-validation`
Expected: FAIL — `Cannot find module '../src/assistant/graph/validation.js'`

- [ ] **Step 3: Write `src/assistant/graph/validation.ts`**

```ts
import { BASIS_CONFIDENCE_CEILING } from '../domain/confidence.js';
import { isExplicitBasis, type AssertionBasis, type Sensitivity } from '../domain/enums.js';
import { normalizeLiteralValue, type AssertionObjectRef } from '../domain/keys.js';
import {
  allowsLiteralObject, isNodeTypeAllowedAsObject, isNodeTypeAllowedAsSubject, isRelationType,
  RELATION_DEFINITIONS,
} from '../domain/relation-types.js';
import type { NodeStore } from '../storage/node-store.js';
import type { PolicyStore } from '../storage/policy-store.js';

export type ValidationCode =
  | 'unknown_predicate'
  | 'subject_unresolved'
  | 'object_unresolved'
  | 'scope_unresolved'
  | 'subject_type_not_allowed'
  | 'object_type_not_allowed'
  | 'scope_type_not_allowed'
  | 'literal_object_not_allowed'
  | 'node_object_not_allowed'
  | 'literal_value_invalid'
  | 'confidence_above_ceiling'
  | 'confidence_out_of_range'
  | 'secret_prohibited'
  | 'blocked_topic'
  | 'temporal_window_required'
  | 'temporal_window_malformed'
  | 'temporal_window_inconsistent';

export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ValidationCode; readonly message: string };

export interface AssertionValidationRequest {
  readonly ownerId: string;
  readonly subjectNodeId: string;
  readonly predicate: string;
  readonly object: AssertionObjectRef;
  readonly scopeNodeId: string | null;
  readonly basis: AssertionBasis;
  readonly confidence: number;
  readonly sensitivity: Sensitivity;
  readonly validFromUtc: string | null;
  readonly validToUtc: string | null;
  /** Topic keys this assertion is about, checked against `never_infer_topic` policies. */
  readonly topics: readonly string[];
}

/** The only node type permitted as an assertion scope (§4.8). */
const SCOPE_NODE_TYPE = 'preference_context';

function reject(code: ValidationCode, message: string): ValidationResult {
  return { ok: false, code, message };
}

/**
 * Deterministic gate between a proposal and the graph. Models propose; this decides.
 * Returns a typed result so the caller can record the reason rather than swallowing an exception.
 */
export class AssertionValidator {
  constructor(
    private readonly nodes: NodeStore,
    private readonly policies: PolicyStore,
  ) {}

  validate(request: AssertionValidationRequest): ValidationResult {
    if (request.sensitivity === 'secret_prohibited') {
      return reject('secret_prohibited', 'Secret-prohibited content is never written to the graph.');
    }
    if (!isRelationType(request.predicate)) {
      return reject('unknown_predicate', `Predicate ${request.predicate} is not in the registry.`);
    }
    const definition = RELATION_DEFINITIONS[request.predicate];

    const subject = this.nodes.getNode(request.subjectNodeId);
    if (subject === null || subject.status !== 'active') {
      return reject('subject_unresolved', `Subject node ${request.subjectNodeId} is not active.`);
    }
    if (!isNodeTypeAllowedAsSubject(request.predicate, subject.type)) {
      return reject(
        'subject_type_not_allowed',
        `${request.predicate} does not accept a ${subject.type} subject.`,
      );
    }

    const objectResult = this.validateObject(request);
    if (!objectResult.ok) return objectResult;

    if (request.scopeNodeId !== null) {
      const scope = this.nodes.getNode(request.scopeNodeId);
      if (scope === null || scope.status !== 'active') {
        return reject('scope_unresolved', `Scope node ${request.scopeNodeId} is not active.`);
      }
      if (scope.type !== SCOPE_NODE_TYPE) {
        return reject(
          'scope_type_not_allowed',
          `An assertion scope must be a ${SCOPE_NODE_TYPE} node, received ${scope.type}.`,
        );
      }
    }

    if (!Number.isFinite(request.confidence) || request.confidence < 0 || request.confidence > 1) {
      return reject('confidence_out_of_range', 'Confidence must be within [0, 1].');
    }
    if (request.confidence > BASIS_CONFIDENCE_CEILING[request.basis]) {
      return reject(
        'confidence_above_ceiling',
        `Confidence ${request.confidence} exceeds the ${request.basis} ceiling.`,
      );
    }

    if (!isExplicitBasis(request.basis)) {
      for (const topic of request.topics) {
        if (this.policies.isTopicBlockedFromInference(request.ownerId, topic)) {
          return reject('blocked_topic', `A never_infer_topic policy blocks topic ${topic}.`);
        }
      }
    }

    return this.validateTemporal(request, definition.temporal);
  }

  private validateObject(request: AssertionValidationRequest): ValidationResult {
    if (!isRelationType(request.predicate)) {
      return reject('unknown_predicate', `Predicate ${request.predicate} is not in the registry.`);
    }
    const literalAllowed = allowsLiteralObject(request.predicate);

    if (request.object.kind === 'literal') {
      if (!literalAllowed) {
        return reject(
          'literal_object_not_allowed',
          `${request.predicate} requires a node object, not a literal.`,
        );
      }
      try {
        normalizeLiteralValue(request.object.valueType, request.object.value);
      } catch (error) {
        return reject(
          'literal_value_invalid',
          error instanceof Error ? error.message : 'Literal value is invalid.',
        );
      }
      return { ok: true };
    }

    if (literalAllowed) {
      return reject(
        'node_object_not_allowed',
        `${request.predicate} requires a literal object, not a node.`,
      );
    }
    const object = this.nodes.getNode(request.object.nodeId);
    if (object === null || object.status !== 'active') {
      return reject('object_unresolved', `Object node ${request.object.nodeId} is not active.`);
    }
    if (!isNodeTypeAllowedAsObject(request.predicate, object.type)) {
      return reject(
        'object_type_not_allowed',
        `${request.predicate} does not accept a ${object.type} object.`,
      );
    }
    return { ok: true };
  }

  private validateTemporal(
    request: AssertionValidationRequest,
    temporal: 'none' | 'optional' | 'required',
  ): ValidationResult {
    const from = request.validFromUtc;
    const to = request.validToUtc;

    for (const [label, value] of [['validFromUtc', from], ['validToUtc', to]] as const) {
      if (value !== null && Number.isNaN(Date.parse(value))) {
        return reject('temporal_window_malformed', `${label} is not a parseable instant: ${value}`);
      }
    }
    if (temporal === 'required' && from === null) {
      return reject(
        'temporal_window_required',
        `${request.predicate} requires a validFromUtc.`,
      );
    }
    if (from !== null && to !== null && Date.parse(to) <= Date.parse(from)) {
      return reject(
        'temporal_window_inconsistent',
        'validToUtc must be strictly after validFromUtc.',
      );
    }
    return { ok: true };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- assistant-validation`
Expected: PASS — 11 tests.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/assistant/graph/validation.ts tests/assistant-validation.test.ts
git commit -m "feat(assistant): add deterministic assertion validator"
```

---

## Task 14: Assertion service

**Files:**
- Create: `src/assistant/graph/assertion-service.ts`
- Test: `tests/assistant-assertion-service.test.ts`

The heart of Gate A. Implements §9.3's conflict table, decision 4 of §21 (explicit outranks passive,
always), the graph-version increment, and the mutation log. Every public method runs inside one
`database.transaction` and increments `graph_version` exactly once when it mutates.

Outcome type — a discriminated union so a caller can never confuse "created" with "recorded a
contradiction":

```ts
type AssertionWriteOutcome =
  | { kind: 'created';                assertionId }
  | { kind: 'reinforced';             assertionId }          // same key, evidence added
  | { kind: 'superseded';             assertionId; supersededAssertionId }
  | { kind: 'temporally_closed';      assertionId; closedAssertionId }
  | { kind: 'disputed';               assertionId; disputedWithAssertionId }
  | { kind: 'contradiction_recorded'; assertionId }          // passive lost to explicit
  | { kind: 'rejected';               code; message }
```

**Conflict detection rule (deterministic, no semantic model):** two live assertions with the same
subject, predicate, and scope but different assertion keys are in conflict when the predicate’s
cardinality is `single_current` or `single_per_scope`. Which of the §9.3 outcomes applies is then
decided by basis and by the descriptor's `conflictStrategy`.

This makes `HAS_CONSTRAINT` the §9.3 row-four case (two incompatible explicit statements), so its
Task 2 descriptor must read `cardinality: 'single_per_scope'` and
`conflictStrategy: 'mark_disputed'`. Apply that edit in Task 2, not here.

- [ ] **Step 1: Write the failing test**

Create `tests/assistant-assertion-service.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { AssertionService } from '../src/assistant/graph/assertion-service.js';
import { AssertionValidator } from '../src/assistant/graph/validation.js';
import { AssertionStore } from '../src/assistant/storage/assertion-store.js';
import { AuditStore } from '../src/assistant/storage/audit-store.js';
import { NodeStore } from '../src/assistant/storage/node-store.js';
import { PolicyStore } from '../src/assistant/storage/policy-store.js';
import { withAssistantContext, type AssistantTestContext } from './helpers/assistant-fixture.js';

interface ServiceHarness {
  readonly service: AssertionService;
  readonly assertions: AssertionStore;
  readonly audit: AuditStore;
  readonly nodes: NodeStore;
  readonly policies: PolicyStore;
  readonly personId: string;
  readonly powershellId: string;
  readonly bashId: string;
  readonly windowsScopeId: string;
  readonly linuxScopeId: string;
  readonly evidenceIds: readonly string[];
}

function harness(context: AssistantTestContext): ServiceHarness {
  const nodes = new NodeStore(context.database, context.clock, context.ids);
  const assertions = new AssertionStore(context.database, context.clock, context.ids);
  const audit = new AuditStore(context.database, context.clock, context.ids);
  const policies = new PolicyStore(context.database, context.clock, context.ids);
  const validator = new AssertionValidator(nodes, policies);
  const service = new AssertionService(
    context.database, context.clock, nodes, assertions, audit, policies, validator,
  );

  const make = (type: Parameters<NodeStore['createNode']>[0]['type'], key: string, name: string) =>
    nodes.createNode({
      ownerId: context.ownerId, type, canonicalKey: key, displayName: name,
      description: null, sensitivity: 'personal', properties: {},
    }).id;

  const personId = make('person', 'person:self', 'Denys');
  const powershellId = make('software', 'software:powershell', 'PowerShell');
  const bashId = make('software', 'software:bash', 'Bash');
  const windowsScopeId = make('preference_context', 'context:windows', 'Windows command examples');
  const linuxScopeId = make('preference_context', 'context:linux', 'Linux server work');

  const evidenceIds: string[] = [];
  const insert = context.database.prepare(`
    INSERT INTO evidence_records (
      id, owner_id, device_id, source_event_id, parent_evidence_id, blob_id, source_type,
      source_ref, captured_at_utc, source_timezone, ingested_at_utc, content_hash, mime_type,
      sensitivity, retention_until_utc, status, metadata_json, created_at_utc, updated_at_utc
    ) VALUES (?, ?, NULL, ?, NULL, NULL, 'conversation_message', NULL, ?, NULL, ?, ?, 'text/plain',
              'personal', NULL, 'active', '{}', ?, ?)
  `);
  for (let index = 0; index < 5; index += 1) {
    const id = `ev_${index}`;
    insert.run(
      id, context.ownerId, `evt_${index}`, '2026-08-05T09:00:00.000Z',
      '2026-08-05T09:00:00.000Z', `hash_${index}`,
      '2026-08-05T09:00:00.000Z', '2026-08-05T09:00:00.000Z',
    );
    evidenceIds.push(id);
  }

  return {
    service, assertions, audit, nodes, policies,
    personId, powershellId, bashId, windowsScopeId, linuxScopeId, evidenceIds,
  };
}

function preferenceRequest(
  context: AssistantTestContext,
  h: ServiceHarness,
  overrides: Partial<Parameters<AssertionService['assert']>[0]> = {},
): Parameters<AssertionService['assert']>[0] {
  return {
    ownerId: context.ownerId,
    actorType: 'system',
    actorRef: null,
    subjectNodeId: h.personId,
    predicate: 'PREFERS',
    object: { kind: 'node', nodeId: h.powershellId },
    scopeNodeId: h.windowsScopeId,
    basis: 'explicit_user_statement',
    sensitivity: 'personal',
    validFromUtc: null,
    validToUtc: null,
    observedAtUtc: '2026-08-05T09:00:00.000Z',
    topics: [],
    attributes: {},
    searchText: {
      subject: 'Denys', predicate: 'prefers', object: 'PowerShell',
      scope: 'Windows command examples',
    },
    evidence: [{ evidenceId: h.evidenceIds[0], stance: 'supports', weight: 0.9 }],
    ...overrides,
  };
}

test('asserting a new fact creates it, links evidence, logs, and bumps the graph version', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    assert.equal(h.audit.getGraphVersion(), 0);

    const outcome = h.service.assert(preferenceRequest(context, h));
    assert.equal(outcome.kind, 'created');
    if (outcome.kind !== 'created') return;

    const stored = h.assertions.requireAssertion(outcome.assertionId);
    assert.equal(stored.status, 'active');
    assert.equal(stored.basis, 'explicit_user_statement');
    assert.equal(stored.confidence, 0.9);
    assert.deepEqual(h.assertions.supportWeights(outcome.assertionId), [0.9]);

    assert.equal(h.audit.getGraphVersion(), 1);
    const log = h.audit.listMutations(context.ownerId, 'graph_assertions', outcome.assertionId);
    assert.equal(log.length, 1);
    assert.equal(log[0]?.operation, 'create_assertion');
    assert.equal(log[0]?.before_json, null);
  });
});

test('a rejected assertion writes nothing and does not bump the graph version', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const outcome = h.service.assert(preferenceRequest(context, h, {
      predicate: 'NOT_A_PREDICATE',
    }));
    assert.equal(outcome.kind, 'rejected');
    assert.equal(outcome.kind === 'rejected' && outcome.code, 'unknown_predicate');
    assert.equal(h.audit.getGraphVersion(), 0);
    assert.equal(h.assertions.listBySubject(context.ownerId, h.personId, ['active']).length, 0);
  });
});

test('re-asserting the same fact reinforces it instead of creating a duplicate', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const first = h.service.assert(preferenceRequest(context, h));
    context.clock.advanceDays(3);
    const second = h.service.assert(preferenceRequest(context, h, {
      observedAtUtc: '2026-08-08T09:00:00.000Z',
      evidence: [{ evidenceId: h.evidenceIds[1], stance: 'supports', weight: 0.8 }],
    }));

    assert.equal(second.kind, 'reinforced');
    assert.equal(first.kind === 'created' && second.kind === 'reinforced'
      && first.assertionId === second.assertionId, true);
    if (second.kind !== 'reinforced') return;

    const stored = h.assertions.requireAssertion(second.assertionId);
    assert.equal(stored.first_observed_at_utc, '2026-08-05T09:00:00.000Z');
    assert.equal(stored.last_observed_at_utc, '2026-08-08T09:00:00.000Z');
    assert.deepEqual(h.assertions.supportWeights(second.assertionId).sort(), [0.8, 0.9]);
    // 1 - (1-0.9)(1-0.8) = 0.98, clamped to the explicit_user_statement ceiling 0.99
    assert.ok(Math.abs(stored.confidence - 0.98) < 1e-9);
    assert.equal(h.assertions.listBySubject(context.ownerId, h.personId, ['active']).length, 1);
  });
});

test('a scoped preference coexists with a differently scoped one', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    h.service.assert(preferenceRequest(context, h));
    const linux = h.service.assert(preferenceRequest(context, h, {
      object: { kind: 'node', nodeId: h.bashId },
      scopeNodeId: h.linuxScopeId,
      evidence: [{ evidenceId: h.evidenceIds[1], stance: 'supports', weight: 0.9 }],
      searchText: {
        subject: 'Denys', predicate: 'prefers', object: 'Bash', scope: 'Linux server work',
      },
    }));
    assert.equal(linux.kind, 'created');
    assert.equal(h.assertions.listBySubject(context.ownerId, h.personId, ['active']).length, 2);
  });
});

test('an explicit correction supersedes the previous value within the same scope', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const original = h.service.assert(preferenceRequest(context, h));
    context.clock.advanceDays(1);
    const corrected = h.service.assert(preferenceRequest(context, h, {
      object: { kind: 'node', nodeId: h.bashId },
      evidence: [{ evidenceId: h.evidenceIds[1], stance: 'supports', weight: 0.95 }],
      searchText: {
        subject: 'Denys', predicate: 'prefers', object: 'Bash',
        scope: 'Windows command examples',
      },
    }));

    assert.equal(corrected.kind, 'superseded');
    if (corrected.kind !== 'superseded' || original.kind !== 'created') return;
    assert.equal(corrected.supersededAssertionId, original.assertionId);

    const old = h.assertions.requireAssertion(original.assertionId);
    assert.equal(old.status, 'superseded');
    assert.notEqual(old.retired_at_utc, null);

    const current = h.assertions.requireAssertion(corrected.assertionId);
    assert.equal(current.status, 'active');
    assert.equal(current.supersedes_assertion_id, original.assertionId);

    // history is preserved and still queryable
    assert.equal(
      h.assertions.listBySubject(context.ownerId, h.personId, ['active', 'superseded']).length, 2,
    );
    const log = h.audit.listMutations(context.ownerId, 'graph_assertions', original.assertionId);
    assert.ok(log.some((entry) => entry.operation === 'supersede_assertion'));
  });
});

test('passive evidence never overrides an explicit statement; it records a contradiction', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const explicit = h.service.assert(preferenceRequest(context, h));
    context.clock.advanceDays(1);
    const passive = h.service.assert(preferenceRequest(context, h, {
      object: { kind: 'node', nodeId: h.bashId },
      basis: 'passive_observation',
      evidence: [{ evidenceId: h.evidenceIds[2], stance: 'supports', weight: 0.8 }],
      searchText: {
        subject: 'Denys', predicate: 'prefers', object: 'Bash',
        scope: 'Windows command examples',
      },
    }));

    assert.equal(passive.kind, 'contradiction_recorded');
    if (passive.kind !== 'contradiction_recorded' || explicit.kind !== 'created') return;
    assert.equal(passive.assertionId, explicit.assertionId);

    const survivor = h.assertions.requireAssertion(explicit.assertionId);
    assert.equal(survivor.status, 'active');
    assert.equal(survivor.object_node_id, h.powershellId);

    // the contradicting evidence is attached to the surviving assertion, not to a new one
    assert.equal(h.assertions.contradictionCount(explicit.assertionId), 1);
    assert.equal(h.assertions.listBySubject(context.ownerId, h.personId, ['active']).length, 1);
    // and confidence falls because of it
    assert.ok(survivor.confidence < 0.9);
  });
});

test('a temporal change closes the old window rather than deleting it', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const acme = h.nodes.createNode({
      ownerId: context.ownerId, type: 'organization', canonicalKey: 'org:acme',
      displayName: 'Acme', description: null, sensitivity: 'personal', properties: {},
    });
    const globex = h.nodes.createNode({
      ownerId: context.ownerId, type: 'organization', canonicalKey: 'org:globex',
      displayName: 'Globex', description: null, sensitivity: 'personal', properties: {},
    });
    const employment = (organizationId: string, from: string, evidenceId: string) =>
      h.service.assert(preferenceRequest(context, h, {
        predicate: 'EMPLOYED_BY',
        object: { kind: 'node', nodeId: organizationId },
        scopeNodeId: null,
        validFromUtc: from,
        evidence: [{ evidenceId, stance: 'supports', weight: 0.95 }],
        searchText: {
          subject: 'Denys', predicate: 'employed by', object: organizationId, scope: '',
        },
      }));

    const first = employment(acme.id, '2020-01-01T00:00:00.000Z', h.evidenceIds[0]);
    context.clock.advanceDays(30);
    const second = employment(globex.id, '2026-01-01T00:00:00.000Z', h.evidenceIds[1]);

    assert.equal(second.kind, 'temporally_closed');
    if (second.kind !== 'temporally_closed' || first.kind !== 'created') return;
    assert.equal(second.closedAssertionId, first.assertionId);

    const closed = h.assertions.requireAssertion(first.assertionId);
    assert.equal(closed.valid_to_utc, '2026-01-01T00:00:00.000Z');
    assert.equal(closed.status, 'active', 'history stays active but out of the current window');

    const current = h.assertions
      .listCurrent(context.ownerId, h.personId, '2026-08-05T09:00:00.000Z')
      .map((row) => row.object_node_id);
    assert.deepEqual(current, [globex.id]);
  });
});

test('a locked assertion refuses automatic supersession but allows a user correction', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const original = h.service.assert(preferenceRequest(context, h));
    if (original.kind !== 'created') return;
    h.policies.lockAssertion(context.ownerId, original.assertionId, 'user pinned this');

    const automatic = h.service.assert(preferenceRequest(context, h, {
      object: { kind: 'node', nodeId: h.bashId },
      basis: 'manual_import',
      evidence: [{ evidenceId: h.evidenceIds[1], stance: 'supports', weight: 0.9 }],
      searchText: {
        subject: 'Denys', predicate: 'prefers', object: 'Bash',
        scope: 'Windows command examples',
      },
    }));
    assert.equal(automatic.kind, 'rejected');
    assert.equal(automatic.kind === 'rejected' && automatic.code, 'assertion_locked');

    const userCorrection = h.service.correct({
      ownerId: context.ownerId,
      assertionId: original.assertionId,
      object: { kind: 'node', nodeId: h.bashId },
      reason: 'user corrected the value',
      observedAtUtc: '2026-08-06T09:00:00.000Z',
      evidenceId: h.evidenceIds[2],
      searchText: {
        subject: 'Denys', predicate: 'prefers', object: 'Bash',
        scope: 'Windows command examples',
      },
    });
    assert.equal(userCorrection.kind, 'superseded');
  });
});

test('a user correction pins confidence at 1.00 and supersedes the prior value', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const original = h.service.assert(preferenceRequest(context, h, {
      basis: 'passive_observation',
      evidence: [{ evidenceId: h.evidenceIds[0], stance: 'supports', weight: 0.5 }],
    }));
    if (original.kind !== 'created') return;

    const corrected = h.service.correct({
      ownerId: context.ownerId,
      assertionId: original.assertionId,
      object: { kind: 'node', nodeId: h.bashId },
      reason: 'no, I meant Bash',
      observedAtUtc: '2026-08-06T09:00:00.000Z',
      evidenceId: h.evidenceIds[1],
      searchText: {
        subject: 'Denys', predicate: 'prefers', object: 'Bash',
        scope: 'Windows command examples',
      },
    });
    assert.equal(corrected.kind, 'superseded');
    if (corrected.kind !== 'superseded') return;
    const current = h.assertions.requireAssertion(corrected.assertionId);
    assert.equal(current.confidence, 1);
    assert.equal(current.basis, 'explicit_user_statement');
    assert.equal(h.assertions.requireAssertion(original.assertionId).status, 'superseded');
  });
});

test('confirm, pin, expire, and delete each log and bump the graph version', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const created = h.service.assert(preferenceRequest(context, h, {
      basis: 'assistant_inference',
      evidence: [{ evidenceId: h.evidenceIds[0], stance: 'supports', weight: 0.5 }],
    }));
    if (created.kind !== 'created') return;
    const id = created.assertionId;
    let version = h.audit.getGraphVersion();

    h.service.confirm({
      ownerId: context.ownerId, assertionId: id, reason: 'user confirmed',
      evidenceId: h.evidenceIds[1],
    });
    assert.equal(h.assertions.requireAssertion(id).basis, 'explicit_question_answer');
    assert.equal(h.audit.getGraphVersion(), version + 1);
    version += 1;

    h.service.setPinned({ ownerId: context.ownerId, assertionId: id, pinned: true, reason: 'pin' });
    assert.equal(h.assertions.requireAssertion(id).pinned, true);
    assert.equal(h.audit.getGraphVersion(), version + 1);
    version += 1;

    h.service.expire({ ownerId: context.ownerId, assertionId: id, reason: 'no longer true' });
    assert.equal(h.assertions.requireAssertion(id).status, 'expired');
    assert.equal(h.audit.getGraphVersion(), version + 1);
    version += 1;

    h.service.forget({ ownerId: context.ownerId, assertionId: id, reason: 'user deleted' });
    assert.equal(h.assertions.requireAssertion(id).status, 'deleted');
    assert.equal(h.audit.getGraphVersion(), version + 1);

    const log = h.audit.listMutations(context.ownerId, 'graph_assertions', id);
    const operations = log.map((entry) => entry.operation);
    assert.deepEqual(operations, [
      'create_assertion', 'confirm_assertion', 'update_assertion',
      'expire_assertion', 'delete_assertion',
    ]);
  });
});

test('recalculating confidence after evidence deletion drops the deleted support', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const created = h.service.assert(preferenceRequest(context, h, {
      basis: 'passive_observation',
      evidence: [
        { evidenceId: h.evidenceIds[0], stance: 'supports', weight: 0.8 },
        { evidenceId: h.evidenceIds[1], stance: 'supports', weight: 0.8 },
      ],
    }));
    if (created.kind !== 'created') return;
    // 1 - 0.2*0.2 = 0.96, clamped to the passive ceiling 0.85
    assert.equal(h.assertions.requireAssertion(created.assertionId).confidence, 0.85);

    context.database
      .prepare("UPDATE evidence_records SET status = 'deleted' WHERE id = ?")
      .run(h.evidenceIds[0]);
    const recalculated = h.service.recalculateConfidence({
      ownerId: context.ownerId, assertionId: created.assertionId,
      reason: 'evidence deleted',
    });
    assert.ok(Math.abs(recalculated - 0.8) < 1e-9);
  });
});

test('two incompatible explicit statements both become disputed', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const constraint = (value: string, evidenceId: string) =>
      h.service.assert(preferenceRequest(context, h, {
        predicate: 'HAS_CONSTRAINT',
        object: { kind: 'literal', valueType: 'string', value },
        scopeNodeId: null,
        evidence: [{ evidenceId, stance: 'supports', weight: 0.9 }],
        searchText: { subject: 'Denys', predicate: 'has constraint', object: value, scope: '' },
      }));

    const first = constraint('Always answer in under 50 words', h.evidenceIds[0]);
    context.clock.advanceDays(1);
    const second = constraint('Always answer in over 500 words', h.evidenceIds[1]);

    assert.equal(second.kind, 'disputed');
    if (second.kind !== 'disputed' || first.kind !== 'created') return;
    assert.equal(second.disputedWithAssertionId, first.assertionId);
    assert.equal(h.assertions.requireAssertion(first.assertionId).status, 'disputed');
    assert.equal(h.assertions.requireAssertion(second.assertionId).status, 'disputed');
    assert.equal(
      h.assertions.listBySubject(context.ownerId, h.personId, ['disputed']).length, 2,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- assistant-assertion-service`
Expected: FAIL — `Cannot find module '../src/assistant/graph/assertion-service.js'`

- [ ] **Step 3: Write `src/assistant/graph/assertion-service.ts`**

```ts
import { z } from '../../lib/zod.js';
import type { JsonObject } from '../../lib/json-types.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { Clock } from '../clock.js';
import { resolveConfidence } from '../domain/confidence.js';
import {
  isExplicitBasis,
  type ActorType, type AssertionBasis, type EvidenceStance, type Sensitivity,
} from '../domain/enums.js';
import { buildAssertionKey, type AssertionObjectRef } from '../domain/keys.js';
import { isRelationType, RELATION_DEFINITIONS } from '../domain/relation-types.js';
import type { AssertionSearchText, AssertionStore } from '../storage/assertion-store.js';
import type { AuditStore } from '../storage/audit-store.js';
import type { NodeStore } from '../storage/node-store.js';
import type { PolicyStore } from '../storage/policy-store.js';
import type { AssertionRow } from '../storage/rows.js';
import type { AssertionValidator, ValidationCode } from './validation.js';

export interface EvidenceLinkInput {
  readonly evidenceId: string;
  readonly stance: EvidenceStance;
  readonly weight: number;
}

export interface AssertRequest {
  readonly ownerId: string;
  readonly actorType: ActorType;
  readonly actorRef: string | null;
  readonly subjectNodeId: string;
  readonly predicate: string;
  readonly object: AssertionObjectRef;
  readonly scopeNodeId: string | null;
  readonly basis: AssertionBasis;
  readonly sensitivity: Sensitivity;
  readonly validFromUtc: string | null;
  readonly validToUtc: string | null;
  readonly observedAtUtc: string;
  readonly topics: readonly string[];
  readonly attributes: JsonObject;
  readonly searchText: AssertionSearchText;
  readonly evidence: readonly EvidenceLinkInput[];
}

export interface CorrectRequest {
  readonly ownerId: string;
  readonly assertionId: string;
  readonly object: AssertionObjectRef;
  readonly reason: string;
  readonly observedAtUtc: string;
  readonly evidenceId: string;
  readonly searchText: AssertionSearchText;
}

export interface ConfirmRequest {
  readonly ownerId: string;
  readonly assertionId: string;
  readonly reason: string;
  readonly evidenceId: string;
}

export interface PinRequest {
  readonly ownerId: string;
  readonly assertionId: string;
  readonly pinned: boolean;
  readonly reason: string;
}

export interface StatusChangeRequest {
  readonly ownerId: string;
  readonly assertionId: string;
  readonly reason: string;
}

export interface RecalculateRequest {
  readonly ownerId: string;
  readonly assertionId: string;
  readonly reason: string;
}

export type AssertionRejectionCode = ValidationCode | 'assertion_locked';

export type AssertionWriteOutcome =
  | { readonly kind: 'created'; readonly assertionId: string }
  | { readonly kind: 'reinforced'; readonly assertionId: string }
  | {
    readonly kind: 'superseded';
    readonly assertionId: string;
    readonly supersededAssertionId: string;
  }
  | {
    readonly kind: 'temporally_closed';
    readonly assertionId: string;
    readonly closedAssertionId: string;
  }
  | {
    readonly kind: 'disputed';
    readonly assertionId: string;
    readonly disputedWithAssertionId: string;
  }
  | { readonly kind: 'contradiction_recorded'; readonly assertionId: string }
  | {
    readonly kind: 'rejected';
    readonly code: AssertionRejectionCode;
    readonly message: string;
  };

/** Cardinalities where a second live value for the same subject/predicate/scope is a conflict. */
const EXCLUSIVE_CARDINALITIES = ['single_current', 'single_per_scope'] as const;

const AssertionSnapshotSchema = z.object({
  status: z.string(),
  basis: z.string(),
  confidence: z.number(),
  objectNodeId: z.string().nullable(),
  objectValueJson: z.string().nullable(),
  validFromUtc: z.string().nullable(),
  validToUtc: z.string().nullable(),
  pinned: z.boolean(),
});

function snapshot(assertion: AssertionRow): z.infer<typeof AssertionSnapshotSchema> {
  return {
    status: assertion.status,
    basis: assertion.basis,
    confidence: assertion.confidence,
    objectNodeId: assertion.object_node_id,
    objectValueJson: assertion.object_value_json,
    validFromUtc: assertion.valid_from_utc,
    validToUtc: assertion.valid_to_utc,
    pinned: assertion.pinned,
  };
}

/**
 * Decides what happens when a proposal meets the existing graph. Models never call the stores
 * directly; every write in Gate A goes through one of these methods, inside one transaction,
 * with exactly one graph-version increment.
 */
export class AssertionService {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly clock: Clock,
    private readonly nodes: NodeStore,
    private readonly assertions: AssertionStore,
    private readonly audit: AuditStore,
    private readonly policies: PolicyStore,
    private readonly validator: AssertionValidator,
  ) {}

  assert(request: AssertRequest): AssertionWriteOutcome {
    return this.database.transaction((): AssertionWriteOutcome => {
      const validation = this.validator.validate({
        ownerId: request.ownerId,
        subjectNodeId: request.subjectNodeId,
        predicate: request.predicate,
        object: request.object,
        scopeNodeId: request.scopeNodeId,
        basis: request.basis,
        // Validation checks the ceiling; the service computes the final value from evidence.
        confidence: 0,
        sensitivity: request.sensitivity,
        validFromUtc: request.validFromUtc,
        validToUtc: request.validToUtc,
        topics: request.topics,
      });
      if (!validation.ok) {
        return { kind: 'rejected', code: validation.code, message: validation.message };
      }
      if (!isRelationType(request.predicate)) {
        return {
          kind: 'rejected', code: 'unknown_predicate',
          message: `Predicate ${request.predicate} is not in the registry.`,
        };
      }
      const definition = RELATION_DEFINITIONS[request.predicate];
      const assertionKey = buildAssertionKey({
        ownerId: request.ownerId,
        subjectNodeId: request.subjectNodeId,
        predicate: request.predicate,
        object: request.object,
        scopeNodeId: request.scopeNodeId,
      });

      const sameKey = this.assertions.findLiveByKey(request.ownerId, assertionKey);
      if (sameKey !== null) {
        return this.reinforce(sameKey, request);
      }

      const rival = this.findExclusiveRival(request, definition.cardinality);
      if (rival === null) {
        return this.createNew(request, null);
      }
      if (this.policies.isAssertionLocked(request.ownerId, rival.id)) {
        return {
          kind: 'rejected', code: 'assertion_locked',
          message: `Assertion ${rival.id} is locked against automatic change.`,
        };
      }

      if (isExplicitBasis(rival.basis) && !isExplicitBasis(request.basis)) {
        return this.recordContradiction(rival, request);
      }
      if (definition.temporal !== 'none' && request.validFromUtc !== null) {
        return this.closeTemporally(rival, request);
      }
      if (
        definition.conflictStrategy === 'mark_disputed'
        && isExplicitBasis(rival.basis) && isExplicitBasis(request.basis)
      ) {
        return this.dispute(rival, request);
      }
      return this.supersede(rival, request);
    })();
  }

  correct(request: CorrectRequest): AssertionWriteOutcome {
    return this.database.transaction((): AssertionWriteOutcome => {
      const existing = this.assertions.requireAssertion(request.assertionId);
      const replacement = this.writeAssertion({
        ownerId: existing.owner_id,
        actorType: 'user',
        actorRef: existing.owner_id,
        subjectNodeId: existing.subject_node_id,
        predicate: existing.predicate,
        object: request.object,
        scopeNodeId: existing.scope_node_id,
        basis: 'explicit_user_statement',
        sensitivity: existing.sensitivity,
        validFromUtc: existing.valid_from_utc,
        validToUtc: existing.valid_to_utc,
        observedAtUtc: request.observedAtUtc,
        topics: [],
        attributes: JSON.parse(existing.attributes_json),
        searchText: request.searchText,
        evidence: [{ evidenceId: request.evidenceId, stance: 'supports', weight: 1 }],
      }, existing.id, true);

      this.assertions.retireAssertion(existing.id, 'superseded');
      this.audit.recordMutation({
        ownerId: existing.owner_id, actorType: 'user', actorRef: existing.owner_id,
        operation: 'supersede_assertion', targetType: 'graph_assertions', targetId: existing.id,
        before: snapshot(existing), after: { supersededBy: replacement.id },
        reason: request.reason,
      });
      this.audit.incrementGraphVersion();
      return {
        kind: 'superseded', assertionId: replacement.id, supersededAssertionId: existing.id,
      };
    })();
  }

  confirm(request: ConfirmRequest): AssertionRow {
    return this.database.transaction((): AssertionRow => {
      const before = this.assertions.requireAssertion(request.assertionId);
      this.database
        .prepare('UPDATE graph_assertions SET basis = ?, updated_at_utc = ? WHERE id = ?')
        .run('explicit_question_answer', this.clock.nowUtc(), request.assertionId);
      this.assertions.linkEvidence(request.assertionId, request.evidenceId, 'supports', 0.98);
      const after = this.applyConfidence(request.assertionId);
      this.audit.recordMutation({
        ownerId: request.ownerId, actorType: 'user', actorRef: request.ownerId,
        operation: 'confirm_assertion', targetType: 'graph_assertions',
        targetId: request.assertionId,
        before: snapshot(before), after: snapshot(after), reason: request.reason,
      });
      this.audit.incrementGraphVersion();
      return after;
    })();
  }

  setPinned(request: PinRequest): AssertionRow {
    return this.database.transaction((): AssertionRow => {
      const before = this.assertions.requireAssertion(request.assertionId);
      const after = this.assertions.setPinned(request.assertionId, request.pinned);
      this.audit.recordMutation({
        ownerId: request.ownerId, actorType: 'user', actorRef: request.ownerId,
        operation: 'update_assertion', targetType: 'graph_assertions',
        targetId: request.assertionId,
        before: snapshot(before), after: snapshot(after), reason: request.reason,
      });
      this.audit.incrementGraphVersion();
      return after;
    })();
  }

  expire(request: StatusChangeRequest): AssertionRow {
    return this.changeStatus(request, 'expired', 'expire_assertion');
  }

  forget(request: StatusChangeRequest): AssertionRow {
    return this.changeStatus(request, 'deleted', 'delete_assertion');
  }

  reject(request: StatusChangeRequest): AssertionRow {
    return this.changeStatus(request, 'rejected', 'reject_assertion');
  }

  /** Re-derives confidence from the currently live supporting and contradicting evidence. */
  recalculateConfidence(request: RecalculateRequest): number {
    return this.database.transaction((): number => {
      const before = this.assertions.requireAssertion(request.assertionId);
      const after = this.applyConfidence(request.assertionId);
      if (after.confidence !== before.confidence) {
        this.audit.recordMutation({
          ownerId: request.ownerId, actorType: 'system', actorRef: null,
          operation: 'update_assertion', targetType: 'graph_assertions',
          targetId: request.assertionId,
          before: snapshot(before), after: snapshot(after), reason: request.reason,
        });
        this.audit.incrementGraphVersion();
      }
      return after.confidence;
    })();
  }

  private changeStatus(
    request: StatusChangeRequest,
    status: 'expired' | 'deleted' | 'rejected',
    operation: 'expire_assertion' | 'delete_assertion' | 'reject_assertion',
  ): AssertionRow {
    return this.database.transaction((): AssertionRow => {
      const before = this.assertions.requireAssertion(request.assertionId);
      const after = this.assertions.retireAssertion(request.assertionId, status);
      this.audit.recordMutation({
        ownerId: request.ownerId, actorType: 'user', actorRef: request.ownerId,
        operation, targetType: 'graph_assertions', targetId: request.assertionId,
        before: snapshot(before), after: snapshot(after), reason: request.reason,
      });
      this.audit.incrementGraphVersion();
      return after;
    })();
  }

  /**
   * A live assertion with the same subject, predicate, and scope but a different key, where the
   * predicate's cardinality forbids two simultaneous values.
   */
  private findExclusiveRival(
    request: AssertRequest,
    cardinality: 'many' | 'single_current' | 'single_per_scope' | 'append_only',
  ): AssertionRow | null {
    if (!EXCLUSIVE_CARDINALITIES.some((entry) => entry === cardinality)) return null;
    const candidates = this.assertions
      .listBySubject(request.ownerId, request.subjectNodeId, ['active', 'disputed'])
      .filter((row) => row.predicate === request.predicate)
      .filter((row) => row.scope_node_id === request.scopeNodeId);
    return candidates[0] ?? null;
  }

  private reinforce(existing: AssertionRow, request: AssertRequest): AssertionWriteOutcome {
    this.assertions.recordObservation(existing.id, request.observedAtUtc);
    this.linkAll(existing.id, request.evidence);
    const after = this.applyConfidence(existing.id);
    this.audit.recordMutation({
      ownerId: request.ownerId, actorType: request.actorType, actorRef: request.actorRef,
      operation: 'update_assertion', targetType: 'graph_assertions', targetId: existing.id,
      before: snapshot(existing), after: snapshot(after),
      reason: 'reinforced by new supporting evidence',
    });
    this.audit.incrementGraphVersion();
    return { kind: 'reinforced', assertionId: existing.id };
  }

  private recordContradiction(
    survivor: AssertionRow, request: AssertRequest,
  ): AssertionWriteOutcome {
    for (const link of request.evidence) {
      this.assertions.linkEvidence(survivor.id, link.evidenceId, 'contradicts', link.weight);
    }
    const after = this.applyConfidence(survivor.id);
    this.audit.recordMutation({
      ownerId: request.ownerId, actorType: request.actorType, actorRef: request.actorRef,
      operation: 'update_assertion', targetType: 'graph_assertions', targetId: survivor.id,
      before: snapshot(survivor), after: snapshot(after),
      reason: 'passive evidence contradicted an explicit statement; explicit memory retained',
    });
    this.audit.incrementGraphVersion();
    return { kind: 'contradiction_recorded', assertionId: survivor.id };
  }

  private closeTemporally(rival: AssertionRow, request: AssertRequest): AssertionWriteOutcome {
    const validFrom = request.validFromUtc;
    if (validFrom === null) {
      return this.supersede(rival, request);
    }
    const closed = this.assertions.closeValidity(rival.id, validFrom);
    const created = this.createNew(request, null);
    if (created.kind === 'rejected') return created;
    this.audit.recordMutation({
      ownerId: request.ownerId, actorType: request.actorType, actorRef: request.actorRef,
      operation: 'update_assertion', targetType: 'graph_assertions', targetId: rival.id,
      before: snapshot(rival), after: snapshot(closed),
      reason: 'real-world validity closed by a newer current value',
    });
    return {
      kind: 'temporally_closed',
      assertionId: created.assertionId,
      closedAssertionId: rival.id,
    };
  }

  private dispute(rival: AssertionRow, request: AssertRequest): AssertionWriteOutcome {
    const disputedRival = this.assertions.setStatus(rival.id, 'disputed');
    const created = this.writeAssertion(request, null, false);
    this.assertions.setStatus(created.id, 'disputed');
    this.audit.recordMutation({
      ownerId: request.ownerId, actorType: request.actorType, actorRef: request.actorRef,
      operation: 'dispute_assertion', targetType: 'graph_assertions', targetId: rival.id,
      before: snapshot(rival), after: snapshot(disputedRival),
      reason: 'two incompatible explicit statements',
    });
    this.audit.incrementGraphVersion();
    return { kind: 'disputed', assertionId: created.id, disputedWithAssertionId: rival.id };
  }

  private supersede(rival: AssertionRow, request: AssertRequest): AssertionWriteOutcome {
    const created = this.writeAssertion(request, rival.id, false);
    this.assertions.retireAssertion(rival.id, 'superseded');
    this.audit.recordMutation({
      ownerId: request.ownerId, actorType: request.actorType, actorRef: request.actorRef,
      operation: 'supersede_assertion', targetType: 'graph_assertions', targetId: rival.id,
      before: snapshot(rival), after: { supersededBy: created.id },
      reason: 'a newer value of equal or higher basis replaced this one',
    });
    this.audit.incrementGraphVersion();
    return { kind: 'superseded', assertionId: created.id, supersededAssertionId: rival.id };
  }

  private createNew(
    request: AssertRequest,
    supersedesAssertionId: string | null,
  ): AssertionWriteOutcome {
    const created = this.writeAssertion(request, supersedesAssertionId, false);
    this.audit.incrementGraphVersion();
    return { kind: 'created', assertionId: created.id };
  }

  private writeAssertion(
    request: AssertRequest,
    supersedesAssertionId: string | null,
    userCorrected: boolean,
  ): AssertionRow {
    const created = this.assertions.createAssertion({
      ownerId: request.ownerId,
      subjectNodeId: request.subjectNodeId,
      predicate: isRelationType(request.predicate) ? request.predicate : 'RELATED_TO',
      object: request.object,
      scopeNodeId: request.scopeNodeId,
      status: 'active',
      basis: request.basis,
      confidence: 0,
      sensitivity: request.sensitivity,
      validFromUtc: request.validFromUtc,
      validToUtc: request.validToUtc,
      observedAtUtc: request.observedAtUtc,
      supersedesAssertionId,
      pinned: false,
      attributes: request.attributes,
      searchText: request.searchText,
    });
    this.linkAll(created.id, request.evidence);
    const withConfidence = this.applyConfidence(created.id, userCorrected);
    this.audit.recordMutation({
      ownerId: request.ownerId, actorType: request.actorType, actorRef: request.actorRef,
      operation: 'create_assertion', targetType: 'graph_assertions', targetId: created.id,
      before: null, after: snapshot(withConfidence),
      reason: userCorrected ? 'explicit user correction' : 'new assertion accepted',
    });
    return withConfidence;
  }

  private linkAll(assertionId: string, links: readonly EvidenceLinkInput[]): void {
    for (const link of links) {
      this.assertions.linkEvidence(assertionId, link.evidenceId, link.stance, link.weight);
    }
  }

  private applyConfidence(assertionId: string, userCorrected = false): AssertionRow {
    const assertion = this.assertions.requireAssertion(assertionId);
    const confidence = resolveConfidence({
      basis: assertion.basis,
      supportWeights: this.assertions.supportWeights(assertionId),
      contradictionCount: this.assertions.contradictionCount(assertionId),
      singleScreenshotTextObservation: false,
      userCorrected,
    });
    return this.assertions.setConfidence(assertionId, confidence);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- assistant-assertion-service`
Expected: PASS — 11 tests.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Lint and commit**

```bash
npm run lint
git add src/assistant/graph/assertion-service.ts src/assistant/domain/relation-types.ts \
        tests/assistant-assertion-service.test.ts tests/assistant-registry.test.ts
git commit -m "feat(assistant): add assertion service with conflict and precedence rules"
```

---

## Task 15: Entity resolver

**Files:**
- Create: `src/assistant/graph/entity-resolver.ts`
- Test: `tests/assistant-entity-resolution.test.ts`

Implements §9.1 steps 1, 2, 3, 4, 6, and 7. Step 5 (model-suggested match above a score threshold)
arrives with the candidate consolidator in Gate B; there is no model call in Gate A, so no branch
for it exists. **Name similarity alone never merges entities** — the resolver may create a node or
return `needs_confirmation`, but it never merges.

Resolution outcome:

```ts
type ResolutionOutcome =
  | { kind: 'resolved';           nodeId; step }   // step names which rule matched
  | { kind: 'created';            nodeId }
  | { kind: 'needs_confirmation'; candidateNodeIds }
```

- [ ] **Step 1: Write the failing test**

Create `tests/assistant-entity-resolution.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { EntityResolver } from '../src/assistant/graph/entity-resolver.js';
import { AuditStore } from '../src/assistant/storage/audit-store.js';
import { NodeStore } from '../src/assistant/storage/node-store.js';
import { withAssistantContext, type AssistantTestContext } from './helpers/assistant-fixture.js';

interface ResolverHarness {
  readonly resolver: EntityResolver;
  readonly nodes: NodeStore;
}

function harness(context: AssistantTestContext): ResolverHarness {
  const nodes = new NodeStore(context.database, context.clock, context.ids);
  const audit = new AuditStore(context.database, context.clock, context.ids);
  return { resolver: new EntityResolver(nodes, audit), nodes };
}

test('step 1: a canonical key resolves directly', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const node = h.nodes.createNode({
      ownerId: context.ownerId, type: 'software', canonicalKey: 'software:powershell',
      displayName: 'PowerShell', description: null, sensitivity: 'low', properties: {},
    });
    const outcome = h.resolver.resolve({
      ownerId: context.ownerId, nodeType: 'software', displayName: 'Whatever',
      canonicalKey: 'software:powershell', contextNodeIds: [], createIfMissing: false,
    });
    assert.equal(outcome.kind, 'resolved');
    assert.equal(outcome.kind === 'resolved' && outcome.nodeId, node.id);
    assert.equal(outcome.kind === 'resolved' && outcome.step, 'canonical_key');
  });
});

test('step 2: a user-supplied alias outranks a machine-supplied one', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const machine = h.nodes.createNode({
      ownerId: context.ownerId, type: 'software', canonicalKey: 'software:code-oss',
      displayName: 'Code OSS', description: null, sensitivity: 'low', properties: {},
    });
    const chosen = h.nodes.createNode({
      ownerId: context.ownerId, type: 'software', canonicalKey: 'software:vscode',
      displayName: 'Visual Studio Code', description: null, sensitivity: 'low', properties: {},
    });
    h.nodes.addAlias({
      ownerId: context.ownerId, nodeId: machine.id, alias: 'code',
      aliasType: 'name', sourceEvidenceId: null,
    });
    h.nodes.addAlias({
      ownerId: context.ownerId, nodeId: chosen.id, alias: 'code',
      aliasType: 'user_supplied', sourceEvidenceId: null,
    });

    const outcome = h.resolver.resolve({
      ownerId: context.ownerId, nodeType: 'software', displayName: 'code',
      canonicalKey: null, contextNodeIds: [], createIfMissing: false,
    });
    assert.equal(outcome.kind === 'resolved' && outcome.nodeId, chosen.id);
    assert.equal(outcome.kind === 'resolved' && outcome.step, 'user_alias');
  });
});

test('step 3: a unique normalized alias of the right type resolves', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const node = h.nodes.createNode({
      ownerId: context.ownerId, type: 'model', canonicalKey: 'model:qwen3.5-27b',
      displayName: 'Qwen3.5 27B', description: null, sensitivity: 'low', properties: {},
    });
    h.nodes.addAlias({
      ownerId: context.ownerId, nodeId: node.id, alias: 'Qwen 3.5',
      aliasType: 'model', sourceEvidenceId: null,
    });
    const outcome = h.resolver.resolve({
      ownerId: context.ownerId, nodeType: 'model', displayName: '  qwen   3.5 ',
      canonicalKey: null, contextNodeIds: [], createIfMissing: false,
    });
    assert.equal(outcome.kind === 'resolved' && outcome.nodeId, node.id);
    assert.equal(outcome.kind === 'resolved' && outcome.step, 'normalized_alias');
  });
});

test('an alias matching two nodes of the same type needs confirmation, never a guess', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const first = h.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: 'person:alex-1',
      displayName: 'Alex Smith', description: null, sensitivity: 'personal', properties: {},
    });
    const second = h.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: 'person:alex-2',
      displayName: 'Alex Jones', description: null, sensitivity: 'personal', properties: {},
    });
    for (const nodeId of [first.id, second.id]) {
      h.nodes.addAlias({
        ownerId: context.ownerId, nodeId, alias: 'Alex',
        aliasType: 'name', sourceEvidenceId: null,
      });
    }
    const outcome = h.resolver.resolve({
      ownerId: context.ownerId, nodeType: 'person', displayName: 'Alex',
      canonicalKey: null, contextNodeIds: [], createIfMissing: true,
    });
    assert.equal(outcome.kind, 'needs_confirmation');
    assert.deepEqual(
      outcome.kind === 'needs_confirmation' ? [...outcome.candidateNodeIds].sort() : [],
      [first.id, second.id].sort(),
    );
  });
});

test('step 4: an ambiguous alias resolves uniquely when context disambiguates it', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const work = h.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: 'person:alex-work',
      displayName: 'Alex Smith', description: null, sensitivity: 'personal', properties: {},
    });
    const other = h.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: 'person:alex-other',
      displayName: 'Alex Jones', description: null, sensitivity: 'personal', properties: {},
    });
    for (const nodeId of [work.id, other.id]) {
      h.nodes.addAlias({
        ownerId: context.ownerId, nodeId, alias: 'Alex',
        aliasType: 'name', sourceEvidenceId: null,
      });
    }
    const outcome = h.resolver.resolve({
      ownerId: context.ownerId, nodeType: 'person', displayName: 'Alex',
      canonicalKey: null, contextNodeIds: [work.id], createIfMissing: false,
    });
    assert.equal(outcome.kind === 'resolved' && outcome.nodeId, work.id);
    assert.equal(outcome.kind === 'resolved' && outcome.step, 'context_match');
  });
});

test('step 6: an unmatched name creates a node, with the name registered as an alias', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const outcome = h.resolver.resolve({
      ownerId: context.ownerId, nodeType: 'software', displayName: 'Neovim',
      canonicalKey: 'software:neovim', contextNodeIds: [], createIfMissing: true,
    });
    assert.equal(outcome.kind, 'created');
    if (outcome.kind !== 'created') return;

    const created = h.nodes.requireNode(outcome.nodeId);
    assert.equal(created.display_name, 'Neovim');
    assert.equal(created.canonical_key, 'software:neovim');
    assert.deepEqual(
      h.nodes.listAliases(outcome.nodeId).map((alias) => alias.normalized_alias),
      ['neovim'],
    );
    // resolving again finds the node it just created
    const again = h.resolver.resolve({
      ownerId: context.ownerId, nodeType: 'software', displayName: 'neovim',
      canonicalKey: null, contextNodeIds: [], createIfMissing: false,
    });
    assert.equal(again.kind === 'resolved' && again.nodeId, outcome.nodeId);
  });
});

test('step 7: with creation disabled an unmatched name needs confirmation', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const outcome = h.resolver.resolve({
      ownerId: context.ownerId, nodeType: 'software', displayName: 'Unknown Editor',
      canonicalKey: null, contextNodeIds: [], createIfMissing: false,
    });
    assert.equal(outcome.kind, 'needs_confirmation');
    assert.deepEqual(outcome.kind === 'needs_confirmation' ? outcome.candidateNodeIds : ['x'], []);
  });
});

test('a name matching a node of a different type never resolves across types', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    h.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: 'person:mercury',
      displayName: 'Mercury', description: null, sensitivity: 'personal', properties: {},
    });
    const outcome = h.resolver.resolve({
      ownerId: context.ownerId, nodeType: 'place', displayName: 'Mercury',
      canonicalKey: null, contextNodeIds: [], createIfMissing: false,
    });
    assert.equal(outcome.kind, 'needs_confirmation');
  });
});

test('a merged node is followed to its target rather than returned', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const target = h.nodes.createNode({
      ownerId: context.ownerId, type: 'software', canonicalKey: 'software:vscode',
      displayName: 'Visual Studio Code', description: null, sensitivity: 'low', properties: {},
    });
    const source = h.nodes.createNode({
      ownerId: context.ownerId, type: 'software', canonicalKey: 'software:vscode-old',
      displayName: 'VSCode', description: null, sensitivity: 'low', properties: {},
    });
    h.nodes.addAlias({
      ownerId: context.ownerId, nodeId: source.id, alias: 'vscode',
      aliasType: 'name', sourceEvidenceId: null,
    });
    h.nodes.setNodeStatus(source.id, 'merged', target.id);

    const outcome = h.resolver.resolve({
      ownerId: context.ownerId, nodeType: 'software', displayName: 'vscode',
      canonicalKey: 'software:vscode-old', contextNodeIds: [], createIfMissing: false,
    });
    assert.equal(outcome.kind === 'resolved' && outcome.nodeId, target.id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- assistant-entity-resolution`
Expected: FAIL — `Cannot find module '../src/assistant/graph/entity-resolver.js'`

- [ ] **Step 3: Write `src/assistant/graph/entity-resolver.ts`**

```ts
import { normalizeAliasText } from '../domain/keys.js';
import type { NodeType } from '../domain/node-types.js';
import type { AuditStore } from '../storage/audit-store.js';
import type { NodeStore } from '../storage/node-store.js';
import type { NodeRow } from '../storage/rows.js';

export type ResolutionStep =
  | 'canonical_key' | 'user_alias' | 'normalized_alias' | 'context_match';

export type ResolutionOutcome =
  | { readonly kind: 'resolved'; readonly nodeId: string; readonly step: ResolutionStep }
  | { readonly kind: 'created'; readonly nodeId: string }
  | { readonly kind: 'needs_confirmation'; readonly candidateNodeIds: readonly string[] };

export interface ResolveRequest {
  readonly ownerId: string;
  readonly nodeType: NodeType;
  readonly displayName: string;
  readonly canonicalKey: string | null;
  /** Nodes already established in the surrounding statement, used for step 4 disambiguation. */
  readonly contextNodeIds: readonly string[];
  readonly createIfMissing: boolean;
  readonly sensitivity?: 'low' | 'personal';
}

/** How many merge hops to follow before treating the chain as corrupt. */
const MAX_MERGE_HOPS = 16;

/**
 * Deterministic entity resolution, §9.1. Name similarity alone never merges entities: the
 * resolver either matches an exact normalized alias, creates a node, or asks for confirmation.
 */
export class EntityResolver {
  constructor(
    private readonly nodes: NodeStore,
    private readonly audit: AuditStore,
  ) {}

  resolve(request: ResolveRequest): ResolutionOutcome {
    if (request.canonicalKey !== null) {
      const byKey = this.nodes.findByCanonicalKey(
        request.ownerId, request.nodeType, request.canonicalKey,
      );
      if (byKey !== null) {
        return { kind: 'resolved', nodeId: this.followMerges(byKey).id, step: 'canonical_key' };
      }
    }

    const matches = this.nodes.findByAlias(request.ownerId, request.displayName, request.nodeType);

    const userSupplied = matches.filter((node) => this.hasUserAlias(node.id, request.displayName));
    if (userSupplied.length === 1) {
      return { kind: 'resolved', nodeId: this.followMerges(userSupplied[0]).id, step: 'user_alias' };
    }

    if (matches.length === 1) {
      return {
        kind: 'resolved', nodeId: this.followMerges(matches[0]).id, step: 'normalized_alias',
      };
    }

    if (matches.length > 1) {
      const contextual = matches.filter(
        (node) => request.contextNodeIds.includes(node.id),
      );
      if (contextual.length === 1) {
        return {
          kind: 'resolved', nodeId: this.followMerges(contextual[0]).id, step: 'context_match',
        };
      }
      return {
        kind: 'needs_confirmation',
        candidateNodeIds: matches.map((node) => node.id),
      };
    }

    if (!request.createIfMissing) {
      return { kind: 'needs_confirmation', candidateNodeIds: [] };
    }
    return { kind: 'created', nodeId: this.createNode(request) };
  }

  private createNode(request: ResolveRequest): string {
    const created = this.nodes.createNode({
      ownerId: request.ownerId,
      type: request.nodeType,
      canonicalKey: request.canonicalKey,
      displayName: request.displayName,
      description: null,
      sensitivity: request.sensitivity ?? 'personal',
      properties: {},
    });
    this.nodes.addAlias({
      ownerId: request.ownerId,
      nodeId: created.id,
      alias: request.displayName,
      aliasType: 'name',
      sourceEvidenceId: null,
    });
    this.audit.recordMutation({
      ownerId: request.ownerId, actorType: 'system', actorRef: null,
      operation: 'create_node', targetType: 'graph_nodes', targetId: created.id,
      before: null,
      after: { type: created.type, displayName: created.display_name },
      reason: 'entity resolution created a new node for an unmatched name',
    });
    this.audit.incrementGraphVersion();
    return created.id;
  }

  private hasUserAlias(nodeId: string, displayName: string): boolean {
    const normalized = normalizeAliasText(displayName);
    return this.nodes.listAliases(nodeId).some(
      (alias) => alias.normalized_alias === normalized && alias.alias_type === 'user_supplied',
    );
  }

  /** A merged node is never returned; callers always get the surviving target. */
  private followMerges(node: NodeRow): NodeRow {
    let current = node;
    for (let hop = 0; hop < MAX_MERGE_HOPS; hop += 1) {
      if (current.status !== 'merged' || current.merged_into_node_id === null) {
        return current;
      }
      current = this.nodes.requireNode(current.merged_into_node_id);
    }
    throw new Error(`Merge chain for node ${node.id} exceeds ${MAX_MERGE_HOPS} hops.`);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- assistant-entity-resolution`
Expected: PASS — 9 tests.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/assistant/graph/entity-resolver.ts tests/assistant-entity-resolution.test.ts
git commit -m "feat(assistant): add deterministic entity resolver"
```

---

## Task 16: Reversible node merge

**Files:**
- Create: `src/assistant/graph/merge-service.ts`
- Test: `tests/assistant-merge.test.ts`

Implements §9.2. Every automatic merge is reversible and recorded. The reversal payload lives in the
`merge_node` mutation-log row's `before_json`, so `graph_entity_merges` keeps the DDL from §5.2
unchanged.

Blocked when: node types differ, either node is not active, a stable canonical key conflicts, the
nodes hold incompatible explicit assertions, a merge cycle would form, either node carries a
`do_not_merge_node` policy, or the merge would collapse the owner (`person:self`) with a third party.

- [ ] **Step 1: Write the failing test**

Create `tests/assistant-merge.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { NodeMergeService } from '../src/assistant/graph/merge-service.js';
import { AssertionStore } from '../src/assistant/storage/assertion-store.js';
import { AuditStore } from '../src/assistant/storage/audit-store.js';
import { NodeStore } from '../src/assistant/storage/node-store.js';
import { PolicyStore } from '../src/assistant/storage/policy-store.js';
import { withAssistantContext, type AssistantTestContext } from './helpers/assistant-fixture.js';

interface MergeHarness {
  readonly merges: NodeMergeService;
  readonly nodes: NodeStore;
  readonly assertions: AssertionStore;
  readonly audit: AuditStore;
  readonly policies: PolicyStore;
  readonly personId: string;
}

function harness(context: AssistantTestContext): MergeHarness {
  const nodes = new NodeStore(context.database, context.clock, context.ids);
  const assertions = new AssertionStore(context.database, context.clock, context.ids);
  const audit = new AuditStore(context.database, context.clock, context.ids);
  const policies = new PolicyStore(context.database, context.clock, context.ids);
  const merges = new NodeMergeService(
    context.database, nodes, assertions, audit, policies,
  );
  const person = nodes.createNode({
    ownerId: context.ownerId, type: 'person', canonicalKey: 'person:self',
    displayName: 'Denys', description: null, sensitivity: 'personal', properties: {},
  });
  return { merges, nodes, assertions, audit, policies, personId: person.id };
}

function makeSoftware(
  h: MergeHarness, context: AssistantTestContext, key: string | null, name: string,
): string {
  return h.nodes.createNode({
    ownerId: context.ownerId, type: 'software', canonicalKey: key, displayName: name,
    description: null, sensitivity: 'low', properties: {},
  }).id;
}

function makeUses(
  h: MergeHarness, context: AssistantTestContext, objectNodeId: string, name: string,
): string {
  return h.assertions.createAssertion({
    ownerId: context.ownerId, subjectNodeId: h.personId, predicate: 'USES',
    object: { kind: 'node', nodeId: objectNodeId }, scopeNodeId: null,
    status: 'active', basis: 'passive_observation', confidence: 0.5, sensitivity: 'personal',
    validFromUtc: null, validToUtc: null, observedAtUtc: '2026-08-05T09:00:00.000Z',
    supersedesAssertionId: null, pinned: false, attributes: {},
    searchText: { subject: 'Denys', predicate: 'uses', object: name, scope: '' },
  }).id;
}

test('a merge re-points assertions and aliases and marks the source merged', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const target = makeSoftware(h, context, 'software:vscode', 'Visual Studio Code');
    const source = makeSoftware(h, context, null, 'VSCode');
    h.nodes.addAlias({
      ownerId: context.ownerId, nodeId: source, alias: 'vsc',
      aliasType: 'name', sourceEvidenceId: null,
    });
    const assertionId = makeUses(h, context, source, 'VSCode');

    const outcome = h.merges.merge({
      ownerId: context.ownerId, sourceNodeId: source, targetNodeId: target,
      basis: 'user confirmed they are the same editor', reason: 'user merge',
    });
    assert.equal(outcome.kind, 'merged');
    if (outcome.kind !== 'merged') return;

    const merged = h.nodes.requireNode(source);
    assert.equal(merged.status, 'merged');
    assert.equal(merged.merged_into_node_id, target);

    assert.equal(h.assertions.requireAssertion(assertionId).object_node_id, target);
    assert.deepEqual(
      h.nodes.listAliases(target).map((alias) => alias.normalized_alias).sort(),
      ['vsc'],
    );
    assert.equal(h.nodes.listAliases(source).length, 0);
    assert.equal(h.nodes.listMerges(context.ownerId).length, 1);
  });
});

test('a merge is reversible and restores every moved reference', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const target = makeSoftware(h, context, 'software:vscode', 'Visual Studio Code');
    const source = makeSoftware(h, context, null, 'VSCode');
    h.nodes.addAlias({
      ownerId: context.ownerId, nodeId: source, alias: 'vsc',
      aliasType: 'name', sourceEvidenceId: null,
    });
    const assertionId = makeUses(h, context, source, 'VSCode');
    const originalKey = h.assertions.requireAssertion(assertionId).assertion_key;

    const outcome = h.merges.merge({
      ownerId: context.ownerId, sourceNodeId: source, targetNodeId: target,
      basis: 'automatic alias match', reason: 'merge',
    });
    if (outcome.kind !== 'merged') return;

    h.merges.unmerge({
      ownerId: context.ownerId, mergeId: outcome.mergeId, reason: 'user reversed the merge',
    });

    const restored = h.nodes.requireNode(source);
    assert.equal(restored.status, 'active');
    assert.equal(restored.merged_into_node_id, null);
    const restoredAssertion = h.assertions.requireAssertion(assertionId);
    assert.equal(restoredAssertion.object_node_id, source);
    assert.equal(restoredAssertion.assertion_key, originalKey);
    assert.deepEqual(h.nodes.listAliases(source).map((alias) => alias.normalized_alias), ['vsc']);
    assert.equal(h.nodes.listAliases(target).length, 0);
    assert.notEqual(h.nodes.requireMerge(outcome.mergeId).reversed_at_utc, null);
  });
});

test('a merge that would collide two live assertions retires the weaker one', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const target = makeSoftware(h, context, 'software:vscode', 'Visual Studio Code');
    const source = makeSoftware(h, context, null, 'VSCode');
    const keptId = makeUses(h, context, target, 'Visual Studio Code');
    const collidingId = makeUses(h, context, source, 'VSCode');

    const outcome = h.merges.merge({
      ownerId: context.ownerId, sourceNodeId: source, targetNodeId: target,
      basis: 'user confirmed', reason: 'merge',
    });
    assert.equal(outcome.kind, 'merged');

    assert.equal(h.assertions.requireAssertion(keptId).status, 'active');
    assert.equal(h.assertions.requireAssertion(collidingId).status, 'superseded');
    assert.equal(
      h.assertions.listBySubject(context.ownerId, h.personId, ['active']).length, 1,
    );
  });
});

test('merging different node types is blocked', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const software = makeSoftware(h, context, 'software:vscode', 'Visual Studio Code');
    const outcome = h.merges.merge({
      ownerId: context.ownerId, sourceNodeId: h.personId, targetNodeId: software,
      basis: 'bad idea', reason: 'merge',
    });
    assert.equal(outcome.kind, 'blocked');
    assert.equal(outcome.kind === 'blocked' && outcome.code, 'type_mismatch');
  });
});

test('merging two nodes that both carry distinct canonical keys is blocked', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const first = makeSoftware(h, context, 'software:vscode', 'Visual Studio Code');
    const second = makeSoftware(h, context, 'software:neovim', 'Neovim');
    const outcome = h.merges.merge({
      ownerId: context.ownerId, sourceNodeId: second, targetNodeId: first,
      basis: 'name similarity', reason: 'merge',
    });
    assert.equal(outcome.kind === 'blocked' && outcome.code, 'canonical_key_conflict');
  });
});

test('merging the owner with a third party is blocked', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const other = h.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: 'person:colleague',
      displayName: 'Alex', description: null, sensitivity: 'personal', properties: {},
    });
    const outcome = h.merges.merge({
      ownerId: context.ownerId, sourceNodeId: other.id, targetNodeId: h.personId,
      basis: 'both are people', reason: 'merge',
    });
    assert.equal(outcome.kind === 'blocked' && outcome.code, 'owner_identity_collapse');
  });
});

test('a do_not_merge_node policy blocks the merge in both directions', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const first = makeSoftware(h, context, null, 'Editor A');
    const second = makeSoftware(h, context, null, 'Editor B');
    h.policies.blockMerge(context.ownerId, first, second, 'user said they differ');

    assert.equal(
      h.merges.merge({
        ownerId: context.ownerId, sourceNodeId: first, targetNodeId: second,
        basis: 'x', reason: 'merge',
      }).kind === 'blocked', true,
    );
    const reverse = h.merges.merge({
      ownerId: context.ownerId, sourceNodeId: second, targetNodeId: first,
      basis: 'x', reason: 'merge',
    });
    assert.equal(reverse.kind === 'blocked' && reverse.code, 'do_not_merge_policy');
  });
});

test('a merge that would form a cycle is blocked', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const first = makeSoftware(h, context, null, 'Editor A');
    const second = makeSoftware(h, context, null, 'Editor B');
    const forward = h.merges.merge({
      ownerId: context.ownerId, sourceNodeId: first, targetNodeId: second,
      basis: 'user confirmed', reason: 'merge',
    });
    assert.equal(forward.kind, 'merged');

    const cycle = h.merges.merge({
      ownerId: context.ownerId, sourceNodeId: second, targetNodeId: first,
      basis: 'user confirmed', reason: 'merge',
    });
    assert.equal(cycle.kind === 'blocked' && cycle.code, 'merge_cycle');
  });
});

test('a merge blocked by incompatible explicit assertions reports that reason', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const first = makeSoftware(h, context, null, 'Editor A');
    const second = makeSoftware(h, context, null, 'Editor B');
    const explicitSetting = (nodeId: string, value: string) =>
      h.assertions.createAssertion({
        ownerId: context.ownerId, subjectNodeId: nodeId, predicate: 'HAS_SETTING',
        object: { kind: 'literal', valueType: 'string', value },
        scopeNodeId: null, status: 'active', basis: 'explicit_user_statement',
        confidence: 0.99, sensitivity: 'low', validFromUtc: null, validToUtc: null,
        observedAtUtc: '2026-08-05T09:00:00.000Z', supersedesAssertionId: null,
        pinned: false, attributes: {},
        searchText: { subject: nodeId, predicate: 'has setting', object: value, scope: '' },
      });
    explicitSetting(first, 'theme dark');
    explicitSetting(second, 'theme light');

    const outcome = h.merges.merge({
      ownerId: context.ownerId, sourceNodeId: first, targetNodeId: second,
      basis: 'name similarity', reason: 'merge',
    });
    assert.equal(outcome.kind === 'blocked' && outcome.code, 'incompatible_explicit_assertions');
  });
});

test('a merge and its reversal both appear in the mutation log', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const target = makeSoftware(h, context, 'software:vscode', 'Visual Studio Code');
    const source = makeSoftware(h, context, null, 'VSCode');
    const outcome = h.merges.merge({
      ownerId: context.ownerId, sourceNodeId: source, targetNodeId: target,
      basis: 'user confirmed', reason: 'merge',
    });
    if (outcome.kind !== 'merged') return;
    h.merges.unmerge({
      ownerId: context.ownerId, mergeId: outcome.mergeId, reason: 'reversed',
    });

    const log = h.audit.listMutations(context.ownerId, 'graph_nodes', source);
    assert.deepEqual(log.map((entry) => entry.operation), ['merge_node', 'unmerge_node']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- assistant-merge`
Expected: FAIL — `Cannot find module '../src/assistant/graph/merge-service.js'`

- [ ] **Step 3: Write `src/assistant/graph/merge-service.ts`**

```ts
import { z } from '../../lib/zod.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import { isExplicitBasis } from '../domain/enums.js';
import type { AssertionStore } from '../storage/assertion-store.js';
import type { AuditStore } from '../storage/audit-store.js';
import type { NodeStore } from '../storage/node-store.js';
import type { PolicyStore } from '../storage/policy-store.js';
import type { AssertionRow } from '../storage/rows.js';

export type MergeBlockCode =
  | 'unknown_node'
  | 'node_not_active'
  | 'same_node'
  | 'type_mismatch'
  | 'canonical_key_conflict'
  | 'incompatible_explicit_assertions'
  | 'merge_cycle'
  | 'do_not_merge_policy'
  | 'owner_identity_collapse';

export type MergeOutcome =
  | { readonly kind: 'merged'; readonly mergeId: string; readonly targetNodeId: string }
  | { readonly kind: 'blocked'; readonly code: MergeBlockCode; readonly message: string };

export interface MergeRequest {
  readonly ownerId: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly basis: string;
  readonly reason: string;
}

export interface UnmergeRequest {
  readonly ownerId: string;
  readonly mergeId: string;
  readonly reason: string;
}

/** The canonical key of the assistant owner. Never merged with a third party. */
const OWNER_CANONICAL_KEY = 'person:self';

const MergePayloadSchema = z.object({
  sourceNodeId: z.string(),
  targetNodeId: z.string(),
  movedAliasIds: z.array(z.string()),
  movedAssertions: z.array(z.object({
    assertionId: z.string(),
    column: z.enum(['subject_node_id', 'object_node_id', 'scope_node_id']),
    previousNodeId: z.string(),
    previousAssertionKey: z.string(),
  })),
  retiredAssertionIds: z.array(z.string()),
});
type MergePayload = z.infer<typeof MergePayloadSchema>;

type NodeReferenceColumn = 'subject_node_id' | 'object_node_id' | 'scope_node_id';

function block(code: MergeBlockCode, message: string): MergeOutcome {
  return { kind: 'blocked', code, message };
}

/**
 * Merges one node into another, reversibly. The reversal payload is stored in the `merge_node`
 * mutation-log row so `graph_entity_merges` keeps its designed columns.
 */
export class NodeMergeService {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly nodes: NodeStore,
    private readonly assertions: AssertionStore,
    private readonly audit: AuditStore,
    private readonly policies: PolicyStore,
  ) {}

  merge(request: MergeRequest): MergeOutcome {
    return this.database.transaction((): MergeOutcome => {
      const guard = this.checkMergeSafety(request);
      if (guard !== null) return guard;

      const payload: MergePayload = {
        sourceNodeId: request.sourceNodeId,
        targetNodeId: request.targetNodeId,
        movedAliasIds: [],
        movedAssertions: [],
        retiredAssertionIds: [],
      };

      for (const column of ['subject_node_id', 'object_node_id', 'scope_node_id'] as const) {
        for (const assertion of this.listReferencing(request.ownerId, request.sourceNodeId, column)) {
          payload.movedAssertions.push({
            assertionId: assertion.id,
            column,
            previousNodeId: request.sourceNodeId,
            previousAssertionKey: assertion.assertion_key,
          });
          const moved = this.assertions.repointNodeReference(
            assertion.id, column, request.targetNodeId,
          );
          const collision = this.findLiveCollision(moved);
          if (collision !== null) {
            const loser = this.weaker(moved, collision);
            this.assertions.retireAssertion(loser.id, 'superseded');
            payload.retiredAssertionIds.push(loser.id);
          }
        }
      }

      payload.movedAliasIds.push(
        ...this.nodes.reassignAliases(request.sourceNodeId, request.targetNodeId),
      );
      this.nodes.setNodeStatus(request.sourceNodeId, 'merged', request.targetNodeId);

      const mergeRow = this.nodes.recordMerge({
        ownerId: request.ownerId,
        sourceNodeId: request.sourceNodeId,
        targetNodeId: request.targetNodeId,
        basis: request.basis,
        reversible: true,
      });
      this.audit.recordMutation({
        ownerId: request.ownerId, actorType: 'user', actorRef: request.ownerId,
        operation: 'merge_node', targetType: 'graph_nodes', targetId: request.sourceNodeId,
        before: payload, after: { mergeId: mergeRow.id, targetNodeId: request.targetNodeId },
        reason: request.reason,
      });
      this.audit.incrementGraphVersion();
      return { kind: 'merged', mergeId: mergeRow.id, targetNodeId: request.targetNodeId };
    })();
  }

  unmerge(request: UnmergeRequest): void {
    this.database.transaction((): void => {
      const mergeRow = this.nodes.requireMerge(request.mergeId);
      if (mergeRow.reversed_at_utc !== null) {
        throw new Error(`Merge ${request.mergeId} has already been reversed.`);
      }
      if (!mergeRow.reversible) {
        throw new Error(`Merge ${request.mergeId} is not reversible.`);
      }

      const entry = this.audit
        .listMutations(request.ownerId, 'graph_nodes', mergeRow.source_node_id)
        .filter((row) => row.operation === 'merge_node')
        .at(-1);
      if (entry === undefined || entry.before_json === null) {
        throw new Error(`Merge ${request.mergeId} has no reversal payload.`);
      }
      const payload = MergePayloadSchema.parse(JSON.parse(entry.before_json));

      for (const retiredId of payload.retiredAssertionIds) {
        this.assertions.setStatus(retiredId, 'active');
      }
      for (const moved of payload.movedAssertions) {
        this.assertions.repointNodeReference(moved.assertionId, moved.column, moved.previousNodeId);
      }
      this.nodes.reassignAliases(payload.targetNodeId, payload.sourceNodeId);
      this.nodes.setNodeStatus(payload.sourceNodeId, 'active', null);
      this.nodes.markMergeReversed(request.mergeId);

      this.audit.recordMutation({
        ownerId: request.ownerId, actorType: 'user', actorRef: request.ownerId,
        operation: 'unmerge_node', targetType: 'graph_nodes', targetId: payload.sourceNodeId,
        before: { mergeId: request.mergeId }, after: payload, reason: request.reason,
      });
      this.audit.incrementGraphVersion();
    })();
  }

  private checkMergeSafety(request: MergeRequest): MergeOutcome | null {
    if (request.sourceNodeId === request.targetNodeId) {
      return block('same_node', 'A node cannot merge into itself.');
    }
    const source = this.nodes.getNode(request.sourceNodeId);
    const target = this.nodes.getNode(request.targetNodeId);
    if (source === null || target === null) {
      return block('unknown_node', 'Both nodes must exist.');
    }
    if (source.status !== 'active' || target.status !== 'active') {
      return block('node_not_active', 'Both nodes must be active.');
    }
    if (source.type !== target.type) {
      return block('type_mismatch', `Cannot merge a ${source.type} into a ${target.type}.`);
    }
    if (this.policies.isMergeBlocked(request.ownerId, source.id, target.id)) {
      return block('do_not_merge_policy', 'A do_not_merge_node policy covers this pair.');
    }
    if (
      source.canonical_key === OWNER_CANONICAL_KEY || target.canonical_key === OWNER_CANONICAL_KEY
    ) {
      return block(
        'owner_identity_collapse',
        'The assistant owner is never merged with another person.',
      );
    }
    if (
      source.canonical_key !== null && target.canonical_key !== null
      && source.canonical_key !== target.canonical_key
    ) {
      return block(
        'canonical_key_conflict',
        `Stable identifiers differ: ${source.canonical_key} vs ${target.canonical_key}.`,
      );
    }
    if (this.wouldFormCycle(request.sourceNodeId, request.targetNodeId)) {
      return block('merge_cycle', 'This merge would form a cycle.');
    }
    if (this.hasIncompatibleExplicitAssertions(request)) {
      return block(
        'incompatible_explicit_assertions',
        'The two nodes hold conflicting explicit assertions.',
      );
    }
    return null;
  }

  /** Walks the target's merge chain; if it reaches the source, merging would close a loop. */
  private wouldFormCycle(sourceNodeId: string, targetNodeId: string): boolean {
    const seen = new Set<string>([sourceNodeId]);
    let current = this.nodes.getNode(targetNodeId);
    while (current !== null) {
      if (seen.has(current.id)) return true;
      seen.add(current.id);
      if (current.merged_into_node_id === null) {
        return this.nodes
          .listMerges(current.owner_id)
          .some((row) => row.reversed_at_utc === null
            && row.source_node_id === targetNodeId && row.target_node_id === sourceNodeId);
      }
      current = this.nodes.getNode(current.merged_into_node_id);
    }
    return false;
  }

  /**
   * Two nodes are incompatible when both hold an explicit, live assertion for the same predicate
   * and scope but a different object.
   */
  private hasIncompatibleExplicitAssertions(request: MergeRequest): boolean {
    const explicitOf = (nodeId: string) => this.assertions
      .listBySubject(request.ownerId, nodeId, ['active', 'disputed'])
      .filter((row) => isExplicitBasis(row.basis));
    const sourceAssertions = explicitOf(request.sourceNodeId);
    const targetAssertions = explicitOf(request.targetNodeId);

    return sourceAssertions.some((left) => targetAssertions.some((right) =>
      left.predicate === right.predicate
      && left.scope_node_id === right.scope_node_id
      && (left.object_node_id !== right.object_node_id
        || left.object_normalized_text !== right.object_normalized_text)));
  }

  private listReferencing(
    ownerId: string, nodeId: string, column: NodeReferenceColumn,
  ): AssertionRow[] {
    const statuses = ['active', 'disputed', 'superseded', 'expired'] as const;
    if (column === 'subject_node_id') return this.assertions.listBySubject(ownerId, nodeId, statuses);
    if (column === 'object_node_id') return this.assertions.listByObjectNode(ownerId, nodeId, statuses);
    return this.assertions.listByScope(ownerId, nodeId, statuses);
  }

  private findLiveCollision(assertion: AssertionRow): AssertionRow | null {
    if (assertion.status !== 'active' && assertion.status !== 'disputed') return null;
    const rivals = this.assertions
      .listBySubject(assertion.owner_id, assertion.subject_node_id, ['active', 'disputed'])
      .filter((row) => row.id !== assertion.id)
      .filter((row) => row.assertion_key === assertion.assertion_key);
    return rivals[0] ?? null;
  }

  /** Explicit outranks passive; then higher confidence; then the older row wins. */
  private weaker(left: AssertionRow, right: AssertionRow): AssertionRow {
    const leftExplicit = isExplicitBasis(left.basis);
    const rightExplicit = isExplicitBasis(right.basis);
    if (leftExplicit !== rightExplicit) return leftExplicit ? right : left;
    if (left.confidence !== right.confidence) {
      return left.confidence < right.confidence ? left : right;
    }
    return left.created_at_utc > right.created_at_utc ? left : right;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- assistant-merge`
Expected: PASS — 10 tests.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/assistant/graph/merge-service.ts tests/assistant-merge.test.ts
git commit -m "feat(assistant): add reversible node merge with safety rules"
```

---

## Task 17: Bounded neighborhood traversal

**Files:**
- Create: `src/assistant/graph/neighborhood.ts`
- Test: `tests/assistant-neighborhood.test.ts`

Implements §11.4's bounds. Gate A owns the traversal; Gate B's retriever consumes it. Limits are
passed in explicitly rather than read from config, because `SiftConfig.Assistant` is Gate C.
`RELATED_TO` is never expanded unless it appears in an explicit predicate allowlist.

Every limit that bites is reported, so a caller can never silently receive a truncated graph:

```ts
interface Neighborhood {
  rootNodeId: string;
  nodeIds: readonly string[];
  assertionIds: readonly string[];
  truncatedBy: readonly ('max_hops' | 'max_nodes' | 'max_assertions' | 'max_fanout')[];
}
```

- [ ] **Step 1: Write the failing test**

Create `tests/assistant-neighborhood.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { NeighborhoodReader } from '../src/assistant/graph/neighborhood.js';
import { AssertionStore } from '../src/assistant/storage/assertion-store.js';
import { NodeStore } from '../src/assistant/storage/node-store.js';
import { withAssistantContext, type AssistantTestContext } from './helpers/assistant-fixture.js';

interface TraversalHarness {
  readonly reader: NeighborhoodReader;
  readonly nodes: NodeStore;
  readonly assertions: AssertionStore;
}

function harness(context: AssistantTestContext): TraversalHarness {
  const nodes = new NodeStore(context.database, context.clock, context.ids);
  const assertions = new AssertionStore(context.database, context.clock, context.ids);
  return { reader: new NeighborhoodReader(nodes, assertions), nodes, assertions };
}

function makeNode(
  h: TraversalHarness, context: AssistantTestContext,
  type: Parameters<NodeStore['createNode']>[0]['type'], name: string,
): string {
  return h.nodes.createNode({
    ownerId: context.ownerId, type, canonicalKey: null, displayName: name,
    description: null, sensitivity: 'low', properties: {},
  }).id;
}

function link(
  h: TraversalHarness, context: AssistantTestContext,
  subjectNodeId: string, predicate: 'DEPENDS_ON' | 'RUNS_ON' | 'RELATED_TO',
  objectNodeId: string,
): string {
  return h.assertions.createAssertion({
    ownerId: context.ownerId, subjectNodeId, predicate,
    object: { kind: 'node', nodeId: objectNodeId }, scopeNodeId: null,
    status: 'active', basis: 'manual_import', confidence: 0.9, sensitivity: 'low',
    validFromUtc: null, validToUtc: null, observedAtUtc: '2026-08-05T09:00:00.000Z',
    supersedesAssertionId: null, pinned: false, attributes: {},
    searchText: { subject: subjectNodeId, predicate, object: objectNodeId, scope: '' },
  }).id;
}

const LIMITS = {
  maxHops: 2, maxNodes: 80, maxAssertions: 160, maxFanoutPerNodePredicate: 20,
} as const;

test('a one-hop neighborhood returns the root, its neighbours, and the connecting assertions', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const root = makeNode(h, context, 'project', 'SiftKit');
    const first = makeNode(h, context, 'software', 'better-sqlite3');
    const second = makeNode(h, context, 'software', 'zod');
    const edgeOne = link(h, context, root, 'DEPENDS_ON', first);
    const edgeTwo = link(h, context, root, 'DEPENDS_ON', second);

    const result = h.reader.read({
      ownerId: context.ownerId, rootNodeId: root, predicates: ['DEPENDS_ON'],
      ...LIMITS, maxHops: 1,
    });
    assert.deepEqual([...result.nodeIds].sort(), [root, first, second].sort());
    assert.deepEqual([...result.assertionIds].sort(), [edgeOne, edgeTwo].sort());
    assert.deepEqual(result.truncatedBy, []);
  });
});

test('traversal follows edges in both directions', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const root = makeNode(h, context, 'software', 'better-sqlite3');
    const dependent = makeNode(h, context, 'project', 'SiftKit');
    link(h, context, dependent, 'DEPENDS_ON', root);

    const result = h.reader.read({
      ownerId: context.ownerId, rootNodeId: root, predicates: ['DEPENDS_ON'],
      ...LIMITS, maxHops: 1,
    });
    assert.ok(result.nodeIds.includes(dependent));
  });
});

test('traversal stops at maxHops and reports the truncation', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const hop0 = makeNode(h, context, 'project', 'Root');
    const hop1 = makeNode(h, context, 'software', 'Hop 1');
    const hop2 = makeNode(h, context, 'software', 'Hop 2');
    const hop3 = makeNode(h, context, 'software', 'Hop 3');
    link(h, context, hop0, 'DEPENDS_ON', hop1);
    link(h, context, hop1, 'DEPENDS_ON', hop2);
    link(h, context, hop2, 'DEPENDS_ON', hop3);

    const twoHops = h.reader.read({
      ownerId: context.ownerId, rootNodeId: hop0, predicates: ['DEPENDS_ON'], ...LIMITS,
    });
    assert.deepEqual([...twoHops.nodeIds].sort(), [hop0, hop1, hop2].sort());
    assert.deepEqual(twoHops.truncatedBy, ['max_hops']);

    const threeHops = h.reader.read({
      ownerId: context.ownerId, rootNodeId: hop0, predicates: ['DEPENDS_ON'],
      ...LIMITS, maxHops: 3,
    });
    assert.equal(threeHops.nodeIds.length, 4);
    assert.deepEqual(threeHops.truncatedBy, []);
  });
});

test('only the requested predicates are followed', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const root = makeNode(h, context, 'project', 'SiftKit');
    const dependency = makeNode(h, context, 'software', 'zod');
    const host = makeNode(h, context, 'device', 'Workstation');
    link(h, context, root, 'DEPENDS_ON', dependency);
    link(h, context, root, 'RUNS_ON', host);

    const result = h.reader.read({
      ownerId: context.ownerId, rootNodeId: root, predicates: ['DEPENDS_ON'],
      ...LIMITS, maxHops: 1,
    });
    assert.ok(result.nodeIds.includes(dependency));
    assert.equal(result.nodeIds.includes(host), false);
  });
});

test('RELATED_TO is not expanded unless explicitly allowlisted', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const root = makeNode(h, context, 'topic', 'Root topic');
    const related = makeNode(h, context, 'topic', 'Loosely related');
    link(h, context, root, 'RELATED_TO', related);

    const withoutAllowlist = h.reader.read({
      ownerId: context.ownerId, rootNodeId: root, predicates: ['DEPENDS_ON', 'RUNS_ON'],
      ...LIMITS, maxHops: 2,
    });
    assert.deepEqual([...withoutAllowlist.nodeIds], [root]);

    const withAllowlist = h.reader.read({
      ownerId: context.ownerId, rootNodeId: root, predicates: ['RELATED_TO'],
      ...LIMITS, maxHops: 1,
    });
    assert.ok(withAllowlist.nodeIds.includes(related));
  });
});

test('fanout per node and predicate is capped and reported', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const root = makeNode(h, context, 'project', 'SiftKit');
    for (let index = 0; index < 30; index += 1) {
      link(h, context, root, 'DEPENDS_ON', makeNode(h, context, 'software', `dep ${index}`));
    }
    const result = h.reader.read({
      ownerId: context.ownerId, rootNodeId: root, predicates: ['DEPENDS_ON'],
      ...LIMITS, maxHops: 1, maxFanoutPerNodePredicate: 5,
    });
    assert.equal(result.nodeIds.length, 6, 'root plus five neighbours');
    assert.equal(result.assertionIds.length, 5);
    assert.ok(result.truncatedBy.includes('max_fanout'));
  });
});

test('the node cap is never exceeded and is reported', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const root = makeNode(h, context, 'project', 'SiftKit');
    for (let index = 0; index < 30; index += 1) {
      link(h, context, root, 'DEPENDS_ON', makeNode(h, context, 'software', `dep ${index}`));
    }
    const result = h.reader.read({
      ownerId: context.ownerId, rootNodeId: root, predicates: ['DEPENDS_ON'],
      ...LIMITS, maxHops: 1, maxNodes: 10,
    });
    assert.ok(result.nodeIds.length <= 10);
    assert.ok(result.truncatedBy.includes('max_nodes'));
  });
});

test('the assertion cap is never exceeded and is reported', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const root = makeNode(h, context, 'project', 'SiftKit');
    for (let index = 0; index < 30; index += 1) {
      link(h, context, root, 'DEPENDS_ON', makeNode(h, context, 'software', `dep ${index}`));
    }
    const result = h.reader.read({
      ownerId: context.ownerId, rootNodeId: root, predicates: ['DEPENDS_ON'],
      ...LIMITS, maxHops: 1, maxAssertions: 7,
    });
    assert.ok(result.assertionIds.length <= 7);
    assert.ok(result.truncatedBy.includes('max_assertions'));
  });
});

test('a cycle in the graph terminates without repeating a node', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const first = makeNode(h, context, 'software', 'A');
    const second = makeNode(h, context, 'software', 'B');
    const third = makeNode(h, context, 'software', 'C');
    link(h, context, first, 'DEPENDS_ON', second);
    link(h, context, second, 'DEPENDS_ON', third);
    link(h, context, third, 'DEPENDS_ON', first);

    const result = h.reader.read({
      ownerId: context.ownerId, rootNodeId: first, predicates: ['DEPENDS_ON'],
      ...LIMITS, maxHops: 3,
    });
    assert.equal(new Set(result.nodeIds).size, result.nodeIds.length);
    assert.deepEqual([...result.nodeIds].sort(), [first, second, third].sort());
  });
});

test('retired and deleted assertions are not traversed', () => {
  withAssistantContext((context) => {
    const h = harness(context);
    const root = makeNode(h, context, 'project', 'SiftKit');
    const live = makeNode(h, context, 'software', 'zod');
    const gone = makeNode(h, context, 'software', 'removed');
    link(h, context, root, 'DEPENDS_ON', live);
    const retired = link(h, context, root, 'DEPENDS_ON', gone);
    h.assertions.retireAssertion(retired, 'superseded');

    const result = h.reader.read({
      ownerId: context.ownerId, rootNodeId: root, predicates: ['DEPENDS_ON'],
      ...LIMITS, maxHops: 1,
    });
    assert.deepEqual([...result.nodeIds].sort(), [root, live].sort());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- assistant-neighborhood`
Expected: FAIL — `Cannot find module '../src/assistant/graph/neighborhood.js'`

- [ ] **Step 3: Write `src/assistant/graph/neighborhood.ts`**

```ts
import type { RelationType } from '../domain/relation-types.js';
import type { AssertionStore } from '../storage/assertion-store.js';
import type { NodeStore } from '../storage/node-store.js';
import type { AssertionRow } from '../storage/rows.js';

export type TruncationReason = 'max_hops' | 'max_nodes' | 'max_assertions' | 'max_fanout';

export interface Neighborhood {
  readonly rootNodeId: string;
  readonly nodeIds: readonly string[];
  readonly assertionIds: readonly string[];
  readonly truncatedBy: readonly TruncationReason[];
}

export interface NeighborhoodRequest {
  readonly ownerId: string;
  readonly rootNodeId: string;
  /** Explicit allowlist. RELATED_TO is only followed when it appears here. */
  readonly predicates: readonly RelationType[];
  readonly maxHops: number;
  readonly maxNodes: number;
  readonly maxAssertions: number;
  readonly maxFanoutPerNodePredicate: number;
}

/**
 * Breadth-first traversal with hard bounds. Every bound that bites is reported, so a caller can
 * never mistake a truncated neighborhood for a complete one (§11.4).
 */
export class NeighborhoodReader {
  constructor(
    private readonly nodes: NodeStore,
    private readonly assertions: AssertionStore,
  ) {}

  read(request: NeighborhoodRequest): Neighborhood {
    this.nodes.requireNode(request.rootNodeId);
    const allowed = new Set<RelationType>(request.predicates);
    const visitedNodes = new Set<string>([request.rootNodeId]);
    const collectedAssertions = new Set<string>();
    const truncatedBy = new Set<TruncationReason>();

    let frontier: string[] = [request.rootNodeId];

    for (let hop = 0; hop < request.maxHops; hop += 1) {
      if (frontier.length === 0) break;
      const nextFrontier: string[] = [];

      for (const nodeId of frontier) {
        const byPredicate = this.groupByPredicate(request.ownerId, nodeId, allowed);

        for (const edges of byPredicate.values()) {
          const taken = edges.slice(0, request.maxFanoutPerNodePredicate);
          if (taken.length < edges.length) truncatedBy.add('max_fanout');

          for (const edge of taken) {
            if (collectedAssertions.size >= request.maxAssertions) {
              truncatedBy.add('max_assertions');
              break;
            }
            const neighbourId = edge.subject_node_id === nodeId
              ? edge.object_node_id
              : edge.subject_node_id;
            if (neighbourId === null) continue;

            if (!visitedNodes.has(neighbourId)) {
              if (visitedNodes.size >= request.maxNodes) {
                truncatedBy.add('max_nodes');
                continue;
              }
              visitedNodes.add(neighbourId);
              nextFrontier.push(neighbourId);
            }
            collectedAssertions.add(edge.id);
          }
        }
      }
      frontier = nextFrontier;
    }

    if (frontier.length > 0) truncatedBy.add('max_hops');

    return {
      rootNodeId: request.rootNodeId,
      nodeIds: [...visitedNodes],
      assertionIds: [...collectedAssertions],
      truncatedBy: [...truncatedBy],
    };
  }

  /**
   * Live edges touching `nodeId` in either direction, grouped by predicate so the fanout cap is
   * applied per node and predicate rather than per node.
   */
  private groupByPredicate(
    ownerId: string, nodeId: string, allowed: ReadonlySet<RelationType>,
  ): Map<RelationType, AssertionRow[]> {
    const live = ['active', 'disputed'] as const;
    const edges = [
      ...this.assertions.listBySubject(ownerId, nodeId, live),
      ...this.assertions.listByObjectNode(ownerId, nodeId, live),
    ].filter((row) => row.object_kind === 'node' && allowed.has(row.predicate));

    const grouped = new Map<RelationType, AssertionRow[]>();
    for (const edge of edges) {
      const bucket = grouped.get(edge.predicate);
      if (bucket === undefined) {
        grouped.set(edge.predicate, [edge]);
      } else if (!bucket.some((existing) => existing.id === edge.id)) {
        bucket.push(edge);
      }
    }
    return grouped;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- assistant-neighborhood`
Expected: PASS — 10 tests.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/assistant/graph/neighborhood.ts tests/assistant-neighborhood.test.ts
git commit -m "feat(assistant): add bounded neighborhood traversal"
```

---

## Task 18: AssistantGraph composition and Gate A end-to-end proof

**Files:**
- Create: `src/assistant/assistant-graph.ts`
- Modify: `tests/helpers/assistant-fixture.ts` (return a wired `AssistantGraph`)
- Create: `tests/assistant-gate-a-e2e.test.ts`

`AssistantGraph` is the single construction point for the whole Gate A surface. Gate B's
`AssistantService` will own it; nothing else constructs a store directly.

- [ ] **Step 1: Write `src/assistant/assistant-graph.ts`**

```ts
import path from 'node:path';

import type { RuntimeDatabase } from '../state/runtime-db.js';
import type { Clock } from './clock.js';
import { BlobCipher } from './crypto/blob-cipher.js';
import type { AssistantKeyProvider } from './crypto/key-provider.js';
import { AssertionService } from './graph/assertion-service.js';
import { EntityResolver } from './graph/entity-resolver.js';
import { NodeMergeService } from './graph/merge-service.js';
import { NeighborhoodReader } from './graph/neighborhood.js';
import { AssertionValidator } from './graph/validation.js';
import type { IdGenerator } from './ids.js';
import { AssertionStore } from './storage/assertion-store.js';
import { AuditStore } from './storage/audit-store.js';
import { EvidenceStore } from './storage/evidence-store.js';
import { IdentityStore } from './storage/identity-store.js';
import { NodeStore } from './storage/node-store.js';
import { PolicyStore } from './storage/policy-store.js';

export interface AssistantGraphOptions {
  readonly database: RuntimeDatabase;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly keys: AssistantKeyProvider;
  /** `getRepoRuntimeRoot()` in production. Evidence blobs live under `<runtimeRoot>/assistant`. */
  readonly runtimeRoot: string;
}

/**
 * Composition root for the assistant graph. Owns every store and service and exposes them as
 * readonly fields; nothing outside this class constructs a store.
 */
export class AssistantGraph {
  readonly identity: IdentityStore;
  readonly audit: AuditStore;
  readonly nodes: NodeStore;
  readonly assertions: AssertionStore;
  readonly evidence: EvidenceStore;
  readonly policies: PolicyStore;
  readonly validator: AssertionValidator;
  readonly assertionService: AssertionService;
  readonly resolver: EntityResolver;
  readonly merges: NodeMergeService;
  readonly neighborhoods: NeighborhoodReader;

  constructor(options: AssistantGraphOptions) {
    const { database, clock, ids } = options;

    this.identity = new IdentityStore(database);
    this.audit = new AuditStore(database, clock, ids);
    this.nodes = new NodeStore(database, clock, ids);
    this.assertions = new AssertionStore(database, clock, ids);
    this.policies = new PolicyStore(database, clock, ids);
    this.evidence = new EvidenceStore(
      database, clock, ids, new BlobCipher(options.keys),
      path.join(options.runtimeRoot, 'assistant', 'evidence'),
    );

    this.validator = new AssertionValidator(this.nodes, this.policies);
    this.assertionService = new AssertionService(
      database, clock, this.nodes, this.assertions, this.audit, this.policies, this.validator,
    );
    this.resolver = new EntityResolver(this.nodes, this.audit);
    this.merges = new NodeMergeService(
      database, this.nodes, this.assertions, this.audit, this.policies,
    );
    this.neighborhoods = new NeighborhoodReader(this.nodes, this.assertions);
  }

  get ownerId(): string {
    return this.identity.getOwner().id;
  }

  get graphVersion(): number {
    return this.audit.getGraphVersion();
  }
}
```

- [ ] **Step 2: Extend the fixture**

Replace the body of `tests/helpers/assistant-fixture.ts` with the version below. The existing
`AssistantTestContext` fields stay, so no earlier test changes.

```ts
import path from 'node:path';

import { AssistantGraph } from '../../src/assistant/assistant-graph.js';
import { FixedClock } from '../../src/assistant/clock.js';
import { RuntimeMetadataKeyProvider } from '../../src/assistant/crypto/key-provider.js';
import { SequentialIdGenerator } from '../../src/assistant/ids.js';
import { LOCAL_OWNER_ID } from '../../src/assistant/storage/schema.js';
import {
  closeRuntimeDatabase, getRuntimeDatabase, type RuntimeDatabase,
} from '../../src/state/runtime-db.js';
import { createManagedTempDir } from './temp-dirs.js';

export interface AssistantTestContext {
  readonly database: RuntimeDatabase;
  readonly clock: FixedClock;
  readonly ids: SequentialIdGenerator;
  readonly ownerId: string;
  readonly runtimeRoot: string;
  readonly graph: AssistantGraph;
}

export const FIXTURE_START_INSTANT = '2026-08-05T09:00:00.000Z';

/**
 * Creates an isolated runtime database with the assistant schema migrated, wires an
 * AssistantGraph over it, runs `body`, then closes the database.
 */
export function withAssistantContext<T>(body: (context: AssistantTestContext) => T): T {
  const runtimeRoot = createManagedTempDir('siftkit-assistant-');
  const database = getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite'));
  try {
    const clock = new FixedClock(FIXTURE_START_INSTANT);
    const ids = new SequentialIdGenerator();
    const graph = new AssistantGraph({
      database, clock, ids,
      keys: new RuntimeMetadataKeyProvider(database, clock),
      runtimeRoot,
    });
    return body({ database, clock, ids, ownerId: LOCAL_OWNER_ID, runtimeRoot, graph });
  } finally {
    closeRuntimeDatabase();
  }
}
```

- [ ] **Step 3: Write the end-to-end test**

Create `tests/assistant-gate-a-e2e.test.ts`. This is the Gate A acceptance proof: every bullet in
design §18 Gate A "Demonstrates" is covered by one of these scenarios.

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { withAssistantContext, type AssistantTestContext } from './helpers/assistant-fixture.js';

function recordStatement(context: AssistantTestContext, sourceEventId: string, text: string): string {
  return context.graph.evidence.recordTextEvidence({
    ownerId: context.ownerId, deviceId: null, sourceEventId, parentEvidenceId: null,
    sourceType: 'conversation_message', sourceRef: 'session_1',
    capturedAtUtc: context.clock.nowUtc(), sourceTimezone: 'UTC',
    sensitivity: 'personal', retentionUntilUtc: null, metadata: { role: 'user' }, text,
  }).id;
}

test('gate A: a stated preference becomes an explainable, correctable, deletable memory', () => {
  withAssistantContext((context) => {
    const { graph } = context;

    // 1. resolve the entities the statement mentions
    const person = graph.resolver.resolve({
      ownerId: context.ownerId, nodeType: 'person', displayName: 'Denys',
      canonicalKey: 'person:self', contextNodeIds: [], createIfMissing: true,
    });
    const shell = graph.resolver.resolve({
      ownerId: context.ownerId, nodeType: 'software', displayName: 'PowerShell',
      canonicalKey: 'software:powershell', contextNodeIds: [], createIfMissing: true,
    });
    const scope = graph.resolver.resolve({
      ownerId: context.ownerId, nodeType: 'preference_context',
      displayName: 'Windows command examples', canonicalKey: 'context:windows-commands',
      contextNodeIds: [], createIfMissing: true,
    });
    assert.equal(person.kind, 'created');
    assert.equal(shell.kind, 'created');
    assert.equal(scope.kind, 'created');
    if (person.kind !== 'created' || shell.kind !== 'created' || scope.kind !== 'created') return;

    // 2. the statement becomes evidence, then an assertion
    const evidenceId = recordStatement(
      context, 'chat:msg_1', 'I prefer PowerShell for Windows command examples.',
    );
    const outcome = graph.assertionService.assert({
      ownerId: context.ownerId, actorType: 'system', actorRef: null,
      subjectNodeId: person.nodeId, predicate: 'PREFERS',
      object: { kind: 'node', nodeId: shell.nodeId }, scopeNodeId: scope.nodeId,
      basis: 'explicit_user_statement', sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, observedAtUtc: context.clock.nowUtc(),
      topics: ['tooling'], attributes: {},
      searchText: {
        subject: 'Denys', predicate: 'prefers', object: 'PowerShell',
        scope: 'Windows command examples',
      },
      evidence: [{ evidenceId, stance: 'supports', weight: 0.95 }],
    });
    assert.equal(outcome.kind, 'created');
    if (outcome.kind !== 'created') return;

    // 3. it is findable by lexical search over both nodes and assertions
    assert.deepEqual(graph.nodes.searchNodes(context.ownerId, 'powershell', 10), [shell.nodeId]);
    assert.deepEqual(
      graph.assertions.searchAssertions(context.ownerId, 'powershell', 10),
      [outcome.assertionId],
    );

    // 4. it is explainable: value, basis, confidence, scope, evidence, and history
    const belief = graph.assertions.requireAssertion(outcome.assertionId);
    assert.equal(belief.basis, 'explicit_user_statement');
    assert.equal(belief.confidence, 0.95);
    assert.equal(belief.scope_node_id, scope.nodeId);
    assert.deepEqual(
      graph.assertions.listEvidence(outcome.assertionId).map((link) => link.evidence_id),
      [evidenceId],
    );
    assert.equal(
      graph.audit.listMutations(context.ownerId, 'graph_assertions', outcome.assertionId).length, 1,
    );

    // 5. a correction supersedes without erasing history
    const bash = graph.resolver.resolve({
      ownerId: context.ownerId, nodeType: 'software', displayName: 'Bash',
      canonicalKey: 'software:bash', contextNodeIds: [], createIfMissing: true,
    });
    if (bash.kind !== 'created') return;
    context.clock.advanceDays(1);
    const correctionEvidenceId = recordStatement(context, 'chat:msg_2', 'No, I meant Bash.');
    const corrected = graph.assertionService.correct({
      ownerId: context.ownerId, assertionId: outcome.assertionId,
      object: { kind: 'node', nodeId: bash.nodeId },
      reason: 'user correction in conversation',
      observedAtUtc: context.clock.nowUtc(), evidenceId: correctionEvidenceId,
      searchText: {
        subject: 'Denys', predicate: 'prefers', object: 'Bash',
        scope: 'Windows command examples',
      },
    });
    assert.equal(corrected.kind, 'superseded');
    if (corrected.kind !== 'superseded') return;
    assert.equal(graph.assertions.requireAssertion(outcome.assertionId).status, 'superseded');
    assert.equal(graph.assertions.requireAssertion(corrected.assertionId).confidence, 1);

    // 6. deletion is first-class
    graph.assertionService.forget({
      ownerId: context.ownerId, assertionId: corrected.assertionId, reason: 'user deleted',
    });
    assert.equal(graph.assertions.requireAssertion(corrected.assertionId).status, 'deleted');
    assert.deepEqual(graph.assertions.searchAssertions(context.ownerId, 'bash', 10), []);
  });
});

test('gate A: passive observation never overrides an explicit statement', () => {
  withAssistantContext((context) => {
    const { graph } = context;
    const person = graph.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: 'person:self',
      displayName: 'Denys', description: null, sensitivity: 'personal', properties: {},
    });
    const vim = graph.nodes.createNode({
      ownerId: context.ownerId, type: 'software', canonicalKey: 'software:vim',
      displayName: 'Vim', description: null, sensitivity: 'low', properties: {},
    });
    const vscode = graph.nodes.createNode({
      ownerId: context.ownerId, type: 'software', canonicalKey: 'software:vscode',
      displayName: 'VS Code', description: null, sensitivity: 'low', properties: {},
    });

    const statedEvidence = recordStatement(context, 'chat:msg_1', 'I prefer Vim.');
    const stated = graph.assertionService.assert({
      ownerId: context.ownerId, actorType: 'system', actorRef: null,
      subjectNodeId: person.id, predicate: 'PREFERS',
      object: { kind: 'node', nodeId: vim.id }, scopeNodeId: null,
      basis: 'explicit_user_statement', sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, observedAtUtc: context.clock.nowUtc(),
      topics: [], attributes: {},
      searchText: { subject: 'Denys', predicate: 'prefers', object: 'Vim', scope: '' },
      evidence: [{ evidenceId: statedEvidence, stance: 'supports', weight: 0.95 }],
    });
    if (stated.kind !== 'created') return;
    const before = graph.assertions.requireAssertion(stated.assertionId).confidence;

    // three days of passive evidence pointing the other way
    for (let day = 1; day <= 3; day += 1) {
      context.clock.advanceDays(1);
      const observed = recordStatement(context, `activity:day_${day}`, 'VS Code was foreground.');
      const outcome = graph.assertionService.assert({
        ownerId: context.ownerId, actorType: 'system', actorRef: null,
        subjectNodeId: person.id, predicate: 'PREFERS',
        object: { kind: 'node', nodeId: vscode.id }, scopeNodeId: null,
        basis: 'passive_observation', sensitivity: 'personal',
        validFromUtc: null, validToUtc: null, observedAtUtc: context.clock.nowUtc(),
        topics: [], attributes: {},
        searchText: { subject: 'Denys', predicate: 'prefers', object: 'VS Code', scope: '' },
        evidence: [{ evidenceId: observed, stance: 'supports', weight: 0.85 }],
      });
      assert.equal(outcome.kind, 'contradiction_recorded');
    }

    const survivor = graph.assertions.requireAssertion(stated.assertionId);
    assert.equal(survivor.status, 'active');
    assert.equal(survivor.object_node_id, vim.id);
    assert.equal(graph.assertions.contradictionCount(stated.assertionId), 3);
    assert.ok(survivor.confidence < before, 'contradictions lower confidence but do not flip it');
    assert.equal(
      graph.assertions.listBySubject(context.ownerId, person.id, ['active']).length, 1,
    );
  });
});

test('gate A: evidence deletion recalculates dependent confidence', () => {
  withAssistantContext((context) => {
    const { graph } = context;
    const person = graph.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: 'person:self',
      displayName: 'Denys', description: null, sensitivity: 'personal', properties: {},
    });
    const editor = graph.nodes.createNode({
      ownerId: context.ownerId, type: 'software', canonicalKey: 'software:vscode',
      displayName: 'VS Code', description: null, sensitivity: 'low', properties: {},
    });
    const firstEvidence = recordStatement(context, 'chat:msg_1', 'I use VS Code.');
    context.clock.advanceDays(1);
    const secondEvidence = recordStatement(context, 'chat:msg_2', 'VS Code again.');

    const created = graph.assertionService.assert({
      ownerId: context.ownerId, actorType: 'system', actorRef: null,
      subjectNodeId: person.id, predicate: 'USES',
      object: { kind: 'node', nodeId: editor.id }, scopeNodeId: null,
      basis: 'passive_observation', sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, observedAtUtc: context.clock.nowUtc(),
      topics: [], attributes: {},
      searchText: { subject: 'Denys', predicate: 'uses', object: 'VS Code', scope: '' },
      evidence: [
        { evidenceId: firstEvidence, stance: 'supports', weight: 0.6 },
        { evidenceId: secondEvidence, stance: 'supports', weight: 0.6 },
      ],
    });
    if (created.kind !== 'created') return;
    // 1 - 0.4*0.4 = 0.84, under the 0.85 passive ceiling
    assert.ok(Math.abs(graph.assertions.requireAssertion(created.assertionId).confidence - 0.84) < 1e-9);

    graph.evidence.deleteEvidence(firstEvidence);
    const recalculated = graph.assertionService.recalculateConfidence({
      ownerId: context.ownerId, assertionId: created.assertionId,
      reason: 'source evidence deleted',
    });
    assert.ok(Math.abs(recalculated - 0.6) < 1e-9);
    assert.equal(graph.evidence.requireEvidence(firstEvidence).status, 'deleted');
    assert.equal(graph.evidence.requireEvidence(secondEvidence).status, 'active');
  });
});

test('gate A: the graph version advances once per mutation and is queryable', () => {
  withAssistantContext((context) => {
    const { graph } = context;
    assert.equal(graph.graphVersion, 0);
    const person = graph.resolver.resolve({
      ownerId: context.ownerId, nodeType: 'person', displayName: 'Denys',
      canonicalKey: 'person:self', contextNodeIds: [], createIfMissing: true,
    });
    assert.equal(graph.graphVersion, 1);
    if (person.kind !== 'created') return;

    const goal = graph.nodes.createNode({
      ownerId: context.ownerId, type: 'goal', canonicalKey: 'goal:ship-gate-a',
      displayName: 'Ship Gate A', description: null, sensitivity: 'personal', properties: {},
    });
    const evidenceId = recordStatement(context, 'chat:msg_1', 'My goal is to ship Gate A.');
    graph.assertionService.assert({
      ownerId: context.ownerId, actorType: 'system', actorRef: null,
      subjectNodeId: person.nodeId, predicate: 'HAS_GOAL',
      object: { kind: 'node', nodeId: goal.id }, scopeNodeId: null,
      basis: 'explicit_user_statement', sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, observedAtUtc: context.clock.nowUtc(),
      topics: [], attributes: {},
      searchText: { subject: 'Denys', predicate: 'has goal', object: 'Ship Gate A', scope: '' },
      evidence: [{ evidenceId, stance: 'supports', weight: 0.9 }],
    });
    assert.equal(graph.graphVersion, 2);
  });
});

test('gate A: the assistant surface is inert on a database where nothing was written', () => {
  withAssistantContext((context) => {
    const { graph } = context;
    assert.equal(graph.ownerId, context.ownerId);
    assert.equal(graph.graphVersion, 0);
    assert.deepEqual(graph.nodes.listNodesByType(context.ownerId, 'person'), []);
    assert.deepEqual(graph.nodes.searchNodes(context.ownerId, 'anything', 10), []);
    assert.deepEqual(graph.assertions.searchAssertions(context.ownerId, 'anything', 10), []);
    assert.equal(graph.evidence.countEvidence(context.ownerId), 0);
    assert.deepEqual(graph.policies.listPolicies(context.ownerId), []);
    assert.deepEqual(graph.audit.listAuditEvents(context.ownerId, 10), []);
  });
});
```

- [ ] **Step 4: Run the end-to-end tests**

Run: `npm test -- assistant-gate-a-e2e`
Expected: PASS — 5 tests.

- [ ] **Step 5: Run the full suite and the full typecheck**

```bash
npm test
npm run typecheck
```
Expected: both pass with no errors. `npm run typecheck` includes `npm run lint`, which enforces the
no-cast / no-`any` / no-`unknown` / no-namespace-import gate across the new code.

- [ ] **Step 6: Commit**

```bash
git add src/assistant/assistant-graph.ts tests/helpers/assistant-fixture.ts \
        tests/assistant-gate-a-e2e.test.ts
git commit -m "feat(assistant): compose AssistantGraph and prove Gate A end to end"
```

---

## Gate A acceptance checklist

Every bullet from design §18 Gate A "Demonstrates", mapped to the test that proves it. Verify each
by running the named test file and reading the output — do not mark a line done from inspection.

| Demonstrates | Proven by |
|---|---|
| Migrations apply and re-apply cleanly | `tests/assistant-migration.test.ts` — fresh, re-open, and v38 upgrade cases |
| Node / alias / assertion CRUD | `tests/assistant-graph-crud.test.ts` |
| Temporal and current queries | `tests/assistant-graph-crud.test.ts` — current-state query test |
| Provenance | `tests/assistant-graph-crud.test.ts` evidence links + `tests/assistant-gate-a-e2e.test.ts` explainability |
| Explicit-over-passive precedence | `tests/assistant-assertion-service.test.ts` + `tests/assistant-gate-a-e2e.test.ts` |
| Reversible merge | `tests/assistant-merge.test.ts` |
| Complete audit trail | `tests/assistant-assertion-service.test.ts` operation-sequence test, `tests/assistant-merge.test.ts` log test |
| Bounded neighborhood limits | `tests/assistant-neighborhood.test.ts` |
| Encrypted evidence, tamper detection, path traversal | `tests/assistant-evidence-store.test.ts` |
| Derived-key stability (§5.4.1) | `tests/assistant-keys.test.ts` |
| Confidence within [0, 1], ceilings honoured | `tests/assistant-confidence.test.ts` |

Not in Gate A, and deliberately absent — do not add them here:

- projections and tier compilation (Gate B, migration v41);
- chat ingestion, the candidate pipeline, retrieval, the `assistantMemory` preset flag (Gate B);
- `SiftConfig.Assistant`, `/assistant/*` routes, the CLI, the dashboard, jobs, questions
  (Gate C, migration v42);
- desktop capture, activity, Tauri (Gate D, migration v43);
- export, backup, restore, mobile envelope (Gate E).

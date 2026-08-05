# Assistant Gate A — Graph Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the provenance-aware temporal knowledge graph foundation for the SiftKit assistant — domain registries, derived keys, confidence math, two migration steps, encrypted evidence storage, graph stores, validation, mutation policy, entity resolution, reversible merge, and bounded traversal — with nothing wired into any user-facing surface yet.

**Architecture:** All assistant code lives under `src/assistant/`. `src/assistant/domain/` holds pure TypeScript registries and deterministic functions with zero I/O. `src/assistant/runtime/` holds injectable clock and ID abstractions. `src/assistant/storage/` is the *only* place that imports `better-sqlite3` or writes SQL. `src/assistant/graph/` holds deterministic services that compose stores. Assistant tables are appended to the existing migration ladder in `src/state/runtime-db.ts` — there is no second database file.

**Tech Stack:** TypeScript (strict, no casts, no `any`, no `!`), zod (via `src/lib/zod.js`), `better-sqlite3` (already bundled, SQLite 3.51.3 with FTS5), `node:crypto` for SHA-256 and AES-256-GCM, `node:test` + `node:assert/strict` via `npm test`.

---

## Source Design

`assistant/2026-07-30-siftkit-assistant-design.md` — §4 (domain model), §5 (storage), §9 (entity resolution/merge), §18 Gate A, §19 (testing), §21 (decisions that must not drift).

## Corrections to the design applied by this plan

These are forced by repository reality, not preference. They are the only deviations.

| Design says | This plan does | Why |
|---|---|---|
| Gate A adds migration steps **v37** and **v38**, raising `CURRENT_SCHEMA_VERSION` from 36 | Gate A adds **v39** and **v40**, raising `CURRENT_SCHEMA_VERSION` from **38** to **40** | `src/state/runtime-db.ts:37` already reads `export const CURRENT_SCHEMA_VERSION = 38;`. v37 and v38 are taken by `migrateChatSessionsToModelPresetSnapshot` and `migrateRunLogsBackendToEngineIds`. Later gates shift the same way: B→v41, C→v42, D→v43. |
| The evidence encryption key is held by the OS keychain via the Rust secure-key provider (§13.4) | Gate A defines the abstract `AssistantKeyProvider` and ships `LocalFileKeyProvider` (key file under `<runtimeRoot>/assistant/keys/`) plus `InMemoryKeyProvider` for tests | Design assumption 4 requires the assistant to work with no Tauri shell installed, so a non-keychain provider is required permanently, not as a shim. Gate D adds `KeychainKeyProvider` as a third implementation of the same abstract class. |

Everything else follows the design exactly. Where this plan and the design disagree on anything not in this table, the design wins and the disagreement is a bug in this plan.

## Repository rules that apply to every task

- TypeScript only, fully typed. **No** `as` casts, **no** `<T>x`, **no** `any`, **no** non-null `!`, **no** `import * as X`. `as const` and `satisfies` are allowed.
- Types at I/O boundaries come from `z.infer` of a runtime schema. One source of truth.
- No back-compat, no shims, no legacy paths. If something must change, change it completely.
- Reuse existing helpers: `src/lib/zod.js` (`z`), `src/lib/json-types.js` (`JsonValue`, `JsonObject`, `isJsonObject`), `src/lib/fs.js` (`ensureDirectory`), `src/state/runtime-db.js` (`RuntimeDatabase`, `getRuntimeDatabase`).
- Classes for anything stateful or composed. Do not pass functions as parameters — inject objects with explicit methods.
- TDD: failing test first, watch it fail, minimal implementation, watch it pass, commit.
- Prefer one end-to-end test over several unit tests when an end-to-end test covers the behaviour.
- Aim for full branch coverage of every deterministic rule.

## Commands

| Purpose | Command |
|---|---|
| Run one test file | `npm test -- assistant-relation-registry` (substring match against `tests/*.test.ts`) |
| Run all tests | `npm test` |
| Typecheck + lint | `npm run typecheck` |

`npm test` runs `npm run typecheck:test && npm run build:test && node .\dist\scripts\run-tests.js`, so a failing type is a failing test run.

## File structure

Created by this gate:

```
src/assistant/
  domain/
    primitives.ts          Sensitivity, AssertionStatus, AssertionBasis, object value types
    node-types.ts          NODE_TYPES registry + definitions
    relation-types.ts      RELATION_TYPES registry + RelationDefinition table
    keys.ts                literal normalization, assertion key, candidate fingerprint, content hashes
    confidence.ts          basis ceilings, independent-cluster aggregation, clamps
  runtime/
    clock.ts               AssistantClock / SystemAssistantClock / FixedAssistantClock
    ids.ts                 AssistantIdGenerator / RandomAssistantIdGenerator / SequentialAssistantIdGenerator
  storage/
    schema.ts              v39 + v40 DDL and registry seeding, called from the ladder
    rows.ts                row zod schemas shared by the stores
    key-provider.ts        AssistantKeyProvider / LocalFileKeyProvider / InMemoryKeyProvider
    blob-crypto.ts         AssistantBlobCipher (AES-256-GCM envelope)
    evidence-paths.ts      content-addressed path derivation + traversal rejection
    node-store.ts          GraphNodeStore (nodes + aliases + node FTS)
    evidence-store.ts      AssistantEvidenceStore (blobs + records)
    assertion-store.ts     GraphAssertionStore (assertions + assertion_evidence + assertion FTS)
    audit-store.ts         AssistantAuditStore (mutation log + audit events + graph version)
    policy-store.ts        AssistantPolicyStore (assistant_policies rows)
    graph-store.ts         GraphStore facade composing the stores above
  graph/
    validation.ts          GraphAssertionValidator
    mutation.ts            GraphMutationService
    entity-resolution.ts   EntityResolver
    merge.ts               NodeMergeService
    neighborhood.ts        NeighborhoodReader
tests/
  assistant-domain-registries.test.ts
  assistant-runtime-abstractions.test.ts
  assistant-derived-keys.test.ts
  assistant-confidence.test.ts
  assistant-migration.test.ts
  assistant-blob-crypto.test.ts
  assistant-evidence-store.test.ts
  assistant-node-store.test.ts
  assistant-assertion-store.test.ts
  assistant-audit-store.test.ts
  assistant-graph-validation.test.ts
  assistant-graph-mutation.test.ts
  assistant-entity-resolution.test.ts
  assistant-node-merge.test.ts
  assistant-neighborhood.test.ts
  assistant-gate-a.e2e.test.ts
  helpers/assistant-fixture.ts
```

Modified by this gate:

```
src/state/runtime-db.ts    CURRENT_SCHEMA_VERSION 38 → 40, two new ladder steps, fresh-DB path
```

---

## Task 1: Domain primitives and the node type registry

**Files:**
- Create: `src/assistant/domain/primitives.ts`
- Create: `src/assistant/domain/node-types.ts`
- Test: `tests/assistant-domain-registries.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/assistant-domain-registries.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SENSITIVITY_LEVELS,
  SensitivitySchema,
  ASSERTION_STATUSES,
  AssertionStatusSchema,
  ASSERTION_BASES,
  AssertionBasisSchema,
  OBJECT_VALUE_TYPES,
  ObjectValueTypeSchema,
} from '../src/assistant/domain/primitives.js';
import { NODE_TYPES, NodeTypeSchema, NODE_TYPE_DEFINITIONS } from '../src/assistant/domain/node-types.js';

test('sensitivity levels are ordered least to most restrictive and validate', () => {
  assert.deepEqual(SENSITIVITY_LEVELS, [
    'low', 'personal', 'sensitive', 'highly_sensitive', 'secret_prohibited',
  ]);
  assert.equal(SensitivitySchema.parse('highly_sensitive'), 'highly_sensitive');
  assert.equal(SensitivitySchema.safeParse('public').success, false);
});

test('assertion statuses and bases match the design registry', () => {
  assert.deepEqual(ASSERTION_STATUSES, [
    'active', 'disputed', 'superseded', 'rejected', 'expired', 'deleted',
  ]);
  assert.deepEqual(ASSERTION_BASES, [
    'explicit_user_statement', 'explicit_question_answer', 'manual_import',
    'passive_observation', 'derived_aggregation', 'assistant_inference',
  ]);
  assert.equal(AssertionStatusSchema.safeParse('archived').success, false);
  assert.equal(AssertionBasisSchema.safeParse('guess').success, false);
});

test('object value types match the assertion DDL check constraint', () => {
  assert.deepEqual(OBJECT_VALUE_TYPES, [
    'string', 'integer', 'number', 'boolean', 'date', 'datetime',
    'duration', 'quantity', 'json',
  ]);
  assert.equal(ObjectValueTypeSchema.safeParse('blob').success, false);
});

test('node type registry has 28 unique members and a definition for each', () => {
  assert.equal(NODE_TYPES.length, 28);
  assert.equal(new Set(NODE_TYPES).size, NODE_TYPES.length);
  for (const nodeType of NODE_TYPES) {
    const definition = NODE_TYPE_DEFINITIONS[nodeType];
    assert.equal(typeof definition, 'string');
    assert.ok(definition.length > 10, `definition for ${nodeType} is too short`);
  }
  assert.equal(Object.keys(NODE_TYPE_DEFINITIONS).length, NODE_TYPES.length);
});

test('node type schema rejects an unregistered type', () => {
  assert.equal(NodeTypeSchema.parse('person'), 'person');
  assert.equal(NodeTypeSchema.safeParse('spaceship').success, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- assistant-domain-registries`
Expected: FAIL — `Cannot find module '../src/assistant/domain/primitives.js'`

- [ ] **Step 3: Write `src/assistant/domain/primitives.ts`**

```ts
import { z } from '../../lib/zod.js';

export const SENSITIVITY_LEVELS = [
  'low',
  'personal',
  'sensitive',
  'highly_sensitive',
  'secret_prohibited',
] as const;
export const SensitivitySchema = z.enum(SENSITIVITY_LEVELS);
export type Sensitivity = z.infer<typeof SensitivitySchema>;

export const ASSERTION_STATUSES = [
  'active',
  'disputed',
  'superseded',
  'rejected',
  'expired',
  'deleted',
] as const;
export const AssertionStatusSchema = z.enum(ASSERTION_STATUSES);
export type AssertionStatus = z.infer<typeof AssertionStatusSchema>;

export const ASSERTION_BASES = [
  'explicit_user_statement',
  'explicit_question_answer',
  'manual_import',
  'passive_observation',
  'derived_aggregation',
  'assistant_inference',
] as const;
export const AssertionBasisSchema = z.enum(ASSERTION_BASES);
export type AssertionBasis = z.infer<typeof AssertionBasisSchema>;

export const NODE_STATUSES = ['active', 'merged', 'archived', 'deleted'] as const;
export const NodeStatusSchema = z.enum(NODE_STATUSES);
export type NodeStatus = z.infer<typeof NodeStatusSchema>;

export const OBJECT_VALUE_TYPES = [
  'string',
  'integer',
  'number',
  'boolean',
  'date',
  'datetime',
  'duration',
  'quantity',
  'json',
] as const;
export const ObjectValueTypeSchema = z.enum(OBJECT_VALUE_TYPES);
export type ObjectValueType = z.infer<typeof ObjectValueTypeSchema>;

export const EVIDENCE_SOURCE_TYPES = [
  'conversation_message',
  'question_answer',
  'manual_correction',
  'manual_import',
  'desktop_activity',
  'screenshot',
  'accessibility_snapshot',
  'ocr_result',
  'mobile_event',
] as const;
export const EvidenceSourceTypeSchema = z.enum(EVIDENCE_SOURCE_TYPES);
export type EvidenceSourceType = z.infer<typeof EvidenceSourceTypeSchema>;

export const EVIDENCE_STATUSES = ['active', 'expired', 'quarantined', 'deleted'] as const;
export const EvidenceStatusSchema = z.enum(EVIDENCE_STATUSES);
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;

export const EVIDENCE_STANCES = ['supports', 'contradicts', 'context'] as const;
export const EvidenceStanceSchema = z.enum(EVIDENCE_STANCES);
export type EvidenceStance = z.infer<typeof EvidenceStanceSchema>;

export const MUTATION_ACTOR_TYPES = [
  'user',
  'system',
  'assistant_proposal',
  'migration',
] as const;
export const MutationActorTypeSchema = z.enum(MUTATION_ACTOR_TYPES);
export type MutationActorType = z.infer<typeof MutationActorTypeSchema>;

export const MUTATION_OPERATIONS = [
  'create_node',
  'update_node',
  'merge_node',
  'unmerge_node',
  'create_assertion',
  'confirm_assertion',
  'update_assertion',
  'supersede_assertion',
  'dispute_assertion',
  'reject_assertion',
  'expire_assertion',
  'delete_assertion',
  'delete_evidence',
  'update_policy',
] as const;
export const MutationOperationSchema = z.enum(MUTATION_OPERATIONS);
export type MutationOperation = z.infer<typeof MutationOperationSchema>;

export const POLICY_TYPES = [
  'blocked_question_topic',
  'never_infer_topic',
  'capture_exclusion',
  'do_not_merge_node',
  'assertion_lock',
] as const;
export const PolicyTypeSchema = z.enum(POLICY_TYPES);
export type PolicyType = z.infer<typeof PolicyTypeSchema>;

export const POLICY_SOURCES = ['default', 'user', 'migration'] as const;
export const PolicySourceSchema = z.enum(POLICY_SOURCES);
export type PolicySource = z.infer<typeof PolicySourceSchema>;

export const ALIAS_TYPES = [
  'name',
  'handle',
  'model',
  'path',
  'identifier',
  'user_supplied',
] as const;
export const AliasTypeSchema = z.enum(ALIAS_TYPES);
export type AliasType = z.infer<typeof AliasTypeSchema>;

// Sensitivity levels at or above this index never reach FTS or a plaintext projection.
export const FTS_EXCLUDED_SENSITIVITIES = ['sensitive', 'highly_sensitive', 'secret_prohibited'] as const;

export function isFtsExcludedSensitivity(sensitivity: Sensitivity): boolean {
  return sensitivity === 'sensitive'
    || sensitivity === 'highly_sensitive'
    || sensitivity === 'secret_prohibited';
}
```

- [ ] **Step 4: Write `src/assistant/domain/node-types.ts`**

```ts
import { z } from '../../lib/zod.js';

export const NODE_TYPES = [
  'person',
  'organization',
  'place',
  'device',
  'software',
  'project',
  'document',
  'topic',
  'goal',
  'routine',
  'activity',
  'episode',
  'event',
  'preference_context',
  'policy_topic',
  'question_topic',
  'account',
  'vehicle',
  'home_asset',
  'financial_account',
  'health_topic',
  'food_recipe',
  'media_work',
  'model',
  'inference_backend',
  'dataset',
  'benchmark',
  'configuration_profile',
] as const;
export const NodeTypeSchema = z.enum(NODE_TYPES);
export type NodeType = z.infer<typeof NodeTypeSchema>;

// Seeded verbatim into graph_node_types.definition at migration time. The registry is the
// source of truth; the table is its projection.
export const NODE_TYPE_DEFINITIONS: Readonly<Record<NodeType, string>> = {
  person: 'A human being, including the owner (canonical key person:self) and third parties.',
  organization: 'A company, institution, team, or other formal group of people.',
  place: 'A geographic location at any granularity, from a city to a named room.',
  device: 'A physical computing or peripheral device such as a workstation, phone, or GPU.',
  software: 'An application, library, service, or operating system.',
  project: 'A named body of work with its own goals, repository, or deliverables.',
  document: 'A written artefact such as a file, note, specification, article, or message thread.',
  topic: 'A subject of interest that is not itself a project, person, or artefact.',
  goal: 'A desired outcome the owner or a project is working toward.',
  routine: 'A recurring behaviour pattern with a cadence, such as a weekly review.',
  activity: 'A kind of doing, such as writing code, gaming, or exercising.',
  episode: 'A reified multi-participant fact with its own temporal extent, such as an employment.',
  event: 'A dated occurrence with a definite point or short span in time.',
  preference_context: 'A scope in which a preference holds, such as Windows command examples.',
  policy_topic: 'A subject governed by a user policy, such as health or finances.',
  question_topic: 'A subject the assistant may ask about, used to rate-limit and block questions.',
  account: 'A non-financial account or identity on a service or platform.',
  vehicle: 'A car, motorcycle, bicycle, or other owned or driven vehicle.',
  home_asset: 'A durable household item such as an appliance, tool, or piece of furniture.',
  financial_account: 'A bank, brokerage, credit, or payment account. Always at least sensitive.',
  health_topic: 'A health-related subject. Never a diagnosis, always at least sensitive.',
  food_recipe: 'A dish, recipe, or dietary item.',
  media_work: 'A book, film, series, album, game, or other published work.',
  model: 'A machine learning model identified by name, family, and quantisation.',
  inference_backend: 'An inference server or runtime such as llama.cpp or TabbyAPI.',
  dataset: 'A named collection of data used for evaluation, training, or analysis.',
  benchmark: 'A named measurement procedure and its identity, not its results.',
  configuration_profile: 'A named bundle of settings applied to software, a model, or a device.',
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- assistant-domain-registries`
Expected: PASS — 5 tests

- [ ] **Step 6: Commit**

```bash
git add src/assistant/domain/primitives.ts src/assistant/domain/node-types.ts tests/assistant-domain-registries.test.ts
git commit -m "feat(assistant): add graph domain primitives and node type registry"
```

---

## Task 2: Relation type registry

The relation registry is the deterministic descriptor table from design §4.3. It is data, and it must be complete — every predicate needs allowed subject/object types, cardinality, temporality, default sensitivity, projection behaviour, and conflict strategy. Arbitrary predicate strings are rejected against this table in Task 12.

**Files:**
- Create: `src/assistant/domain/relation-types.ts`
- Modify: `tests/assistant-domain-registries.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/assistant-domain-registries.test.ts`:

```ts
import {
  RELATION_TYPES,
  RelationTypeSchema,
  RELATION_DEFINITIONS,
  RELATION_CARDINALITIES,
  RELATION_TEMPORALITIES,
  RELATION_PROJECTION_BEHAVIORS,
  RELATION_CONFLICT_STRATEGIES,
  getRelationDefinition,
} from '../src/assistant/domain/relation-types.js';

test('relation registry has 38 unique members with one definition each', () => {
  assert.equal(RELATION_TYPES.length, 38);
  assert.equal(new Set(RELATION_TYPES).size, RELATION_TYPES.length);
  assert.equal(Object.keys(RELATION_DEFINITIONS).length, RELATION_TYPES.length);
});

test('every relation definition is internally consistent', () => {
  for (const predicate of RELATION_TYPES) {
    const definition = RELATION_DEFINITIONS[predicate];
    assert.equal(definition.predicate, predicate);
    assert.ok(definition.allowedSubjectTypes.length > 0, `${predicate} has no subject types`);
    for (const subjectType of definition.allowedSubjectTypes) {
      assert.ok(NODE_TYPES.includes(subjectType), `${predicate} subject ${subjectType} not a node type`);
    }
    if (definition.allowedObjectTypes !== 'literal') {
      assert.ok(definition.allowedObjectTypes.length > 0, `${predicate} has no object types`);
      for (const objectType of definition.allowedObjectTypes) {
        assert.ok(NODE_TYPES.includes(objectType), `${predicate} object ${objectType} not a node type`);
      }
    }
    assert.ok(RELATION_CARDINALITIES.includes(definition.cardinality));
    assert.ok(RELATION_TEMPORALITIES.includes(definition.temporal));
    assert.ok(RELATION_PROJECTION_BEHAVIORS.includes(definition.projectionBehavior));
    assert.ok(RELATION_CONFLICT_STRATEGIES.includes(definition.conflictStrategy));
  }
});

test('inverse predicates are registered and symmetric', () => {
  for (const predicate of RELATION_TYPES) {
    const inverse = RELATION_DEFINITIONS[predicate].inversePredicate;
    if (inverse === null) {
      continue;
    }
    assert.ok(RELATION_TYPES.includes(inverse), `${predicate} inverse ${inverse} unregistered`);
    assert.equal(
      RELATION_DEFINITIONS[inverse].inversePredicate,
      predicate,
      `${predicate}/${inverse} inverse pair is not symmetric`,
    );
  }
});

test('literal-object predicates never carry a node object list', () => {
  const literalPredicates = RELATION_TYPES.filter(
    (predicate) => RELATION_DEFINITIONS[predicate].allowedObjectTypes === 'literal',
  );
  assert.deepEqual(literalPredicates, ['HAS_ROLE', 'HAS_CONSTRAINT', 'HAS_SETTING']);
});

test('sensitive-by-default predicates carry at least sensitive default sensitivity', () => {
  for (const predicate of ['EMPLOYED_BY', 'LIVES_IN', 'VISITED', 'HAS_ROLE'] as const) {
    const definition = RELATION_DEFINITIONS[predicate];
    assert.ok(
      definition.defaultSensitivity === 'sensitive' || definition.defaultSensitivity === 'highly_sensitive',
      `${predicate} must default to at least sensitive`,
    );
  }
});

test('RELATED_TO and MENTIONED_IN are never projected', () => {
  assert.equal(RELATION_DEFINITIONS.RELATED_TO.projectionBehavior, 'never_project');
  assert.equal(RELATION_DEFINITIONS.MENTIONED_IN.projectionBehavior, 'never_project');
});

test('getRelationDefinition throws for an unregistered predicate', () => {
  assert.equal(getRelationDefinition('OWNS').predicate, 'OWNS');
  assert.throws(
    () => getRelationDefinition('ADORES'),
    /Unregistered relation predicate: ADORES/u,
  );
  assert.equal(RelationTypeSchema.safeParse('ADORES').success, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- assistant-domain-registries`
Expected: FAIL — `Cannot find module '../src/assistant/domain/relation-types.js'`

- [ ] **Step 3: Write `src/assistant/domain/relation-types.ts`**

```ts
import { z } from '../../lib/zod.js';
import { NODE_TYPES, NodeTypeSchema, type NodeType } from './node-types.js';
import { SensitivitySchema, type Sensitivity } from './primitives.js';

export const RELATION_TYPES = [
  'OWNS',
  'USES',
  'PREFERS',
  'DISLIKES',
  'AVOIDS',
  'WORKS_ON',
  'CREATED',
  'CONTRIBUTED_TO',
  'EMPLOYED_BY',
  'HAS_ROLE',
  'LOCATED_IN',
  'LIVES_IN',
  'VISITED',
  'INTERESTED_IN',
  'READ',
  'WATCHED',
  'PLAYED',
  'DRIVES',
  'RIDES',
  'HAS_GOAL',
  'HAS_PLAN',
  'HAS_ROUTINE',
  'HAS_CONSTRAINT',
  'HAS_SETTING',
  'HAS_COMPONENT',
  'RUNS_ON',
  'DEPENDS_ON',
  'CONFIGURED_WITH',
  'COMPARED_WITH',
  'TESTED_WITH',
  'RESULTED_IN',
  'CAUSED_BY',
  'RELATED_TO',
  'PART_OF',
  'ABOUT',
  'MENTIONED_IN',
  'OBSERVED_DURING',
  'ASKED_ABOUT',
] as const;
export const RelationTypeSchema = z.enum(RELATION_TYPES);
export type RelationType = z.infer<typeof RelationTypeSchema>;

export const RELATION_CARDINALITIES = [
  'many',
  'single_current',
  'single_per_scope',
  'append_only',
] as const;
export const RelationCardinalitySchema = z.enum(RELATION_CARDINALITIES);
export type RelationCardinality = z.infer<typeof RelationCardinalitySchema>;

export const RELATION_TEMPORALITIES = ['none', 'optional', 'required'] as const;
export const RelationTemporalitySchema = z.enum(RELATION_TEMPORALITIES);
export type RelationTemporality = z.infer<typeof RelationTemporalitySchema>;

export const RELATION_PROJECTION_BEHAVIORS = [
  'core',
  'dossier',
  'episodic',
  'never_project',
] as const;
export const RelationProjectionBehaviorSchema = z.enum(RELATION_PROJECTION_BEHAVIORS);
export type RelationProjectionBehavior = z.infer<typeof RelationProjectionBehaviorSchema>;

export const RELATION_CONFLICT_STRATEGIES = [
  'coexist',
  'supersede_current',
  'mark_disputed',
  'require_confirmation',
] as const;
export const RelationConflictStrategySchema = z.enum(RELATION_CONFLICT_STRATEGIES);
export type RelationConflictStrategy = z.infer<typeof RelationConflictStrategySchema>;

export const RelationDefinitionSchema = z.object({
  predicate: RelationTypeSchema,
  allowedSubjectTypes: z.array(NodeTypeSchema).readonly(),
  allowedObjectTypes: z.union([z.array(NodeTypeSchema).readonly(), z.literal('literal')]),
  inversePredicate: RelationTypeSchema.nullable(),
  cardinality: RelationCardinalitySchema,
  temporal: RelationTemporalitySchema,
  defaultSensitivity: SensitivitySchema,
  projectionBehavior: RelationProjectionBehaviorSchema,
  conflictStrategy: RelationConflictStrategySchema,
});
export type RelationDefinition = z.infer<typeof RelationDefinitionSchema>;

const ANY_NODE_TYPE: readonly NodeType[] = NODE_TYPES;

const AGENT_TYPES: readonly NodeType[] = ['person', 'organization'];
const PRODUCT_TYPES: readonly NodeType[] = ['project', 'document', 'media_work', 'dataset', 'software'];
const TOOLING_TYPES: readonly NodeType[] = [
  'software', 'device', 'model', 'inference_backend', 'configuration_profile',
];
const TASTE_TYPES: readonly NodeType[] = [
  'software', 'model', 'inference_backend', 'media_work', 'food_recipe', 'topic',
  'configuration_profile', 'activity',
];

export const RELATION_DEFINITIONS: Readonly<Record<RelationType, RelationDefinition>> = {
  OWNS: {
    predicate: 'OWNS',
    allowedSubjectTypes: AGENT_TYPES,
    allowedObjectTypes: [
      'device', 'vehicle', 'home_asset', 'account', 'financial_account', 'software', 'media_work',
    ],
    inversePredicate: null,
    cardinality: 'many',
    temporal: 'optional',
    defaultSensitivity: 'personal',
    projectionBehavior: 'dossier',
    conflictStrategy: 'coexist',
  },
  USES: {
    predicate: 'USES',
    allowedSubjectTypes: ['person', 'organization', 'project', 'software', 'device'],
    allowedObjectTypes: TOOLING_TYPES,
    inversePredicate: null,
    cardinality: 'many',
    temporal: 'optional',
    defaultSensitivity: 'personal',
    projectionBehavior: 'dossier',
    conflictStrategy: 'coexist',
  },
  PREFERS: {
    predicate: 'PREFERS',
    allowedSubjectTypes: ['person'],
    allowedObjectTypes: TASTE_TYPES,
    inversePredicate: null,
    cardinality: 'single_per_scope',
    temporal: 'optional',
    defaultSensitivity: 'personal',
    projectionBehavior: 'core',
    conflictStrategy: 'supersede_current',
  },
  DISLIKES: {
    predicate: 'DISLIKES',
    allowedSubjectTypes: ['person'],
    allowedObjectTypes: TASTE_TYPES,
    inversePredicate: null,
    cardinality: 'single_per_scope',
    temporal: 'optional',
    defaultSensitivity: 'personal',
    projectionBehavior: 'dossier',
    conflictStrategy: 'supersede_current',
  },
  AVOIDS: {
    predicate: 'AVOIDS',
    allowedSubjectTypes: ['person'],
    allowedObjectTypes: ['software', 'food_recipe', 'topic', 'media_work', 'place', 'activity'],
    inversePredicate: null,
    cardinality: 'many',
    temporal: 'optional',
    defaultSensitivity: 'personal',
    projectionBehavior: 'dossier',
    conflictStrategy: 'coexist',
  },
  WORKS_ON: {
    predicate: 'WORKS_ON',
    allowedSubjectTypes: AGENT_TYPES,
    allowedObjectTypes: ['project', 'goal'],
    inversePredicate: null,
    cardinality: 'many',
    temporal: 'optional',
    defaultSensitivity: 'personal',
    projectionBehavior: 'core',
    conflictStrategy: 'coexist',
  },
  CREATED: {
    predicate: 'CREATED',
    allowedSubjectTypes: AGENT_TYPES,
    allowedObjectTypes: PRODUCT_TYPES,
    inversePredicate: null,
    cardinality: 'many',
    temporal: 'optional',
    defaultSensitivity: 'personal',
    projectionBehavior: 'dossier',
    conflictStrategy: 'coexist',
  },
  CONTRIBUTED_TO: {
    predicate: 'CONTRIBUTED_TO',
    allowedSubjectTypes: AGENT_TYPES,
    allowedObjectTypes: PRODUCT_TYPES,
    inversePredicate: null,
    cardinality: 'many',
    temporal: 'optional',
    defaultSensitivity: 'personal',
    projectionBehavior: 'dossier',
    conflictStrategy: 'coexist',
  },
  EMPLOYED_BY: {
    predicate: 'EMPLOYED_BY',
    allowedSubjectTypes: ['person'],
    allowedObjectTypes: ['organization'],
    inversePredicate: null,
    cardinality: 'single_current',
    temporal: 'required',
    defaultSensitivity: 'sensitive',
    projectionBehavior: 'dossier',
    conflictStrategy: 'supersede_current',
  },
  HAS_ROLE: {
    predicate: 'HAS_ROLE',
    allowedSubjectTypes: ['person', 'episode'],
    allowedObjectTypes: 'literal',
    inversePredicate: null,
    cardinality: 'many',
    temporal: 'optional',
    defaultSensitivity: 'sensitive',
    projectionBehavior: 'dossier',
    conflictStrategy: 'supersede_current',
  },
  LOCATED_IN: {
    predicate: 'LOCATED_IN',
    allowedSubjectTypes: ['place', 'organization', 'device', 'home_asset', 'vehicle'],
    allowedObjectTypes: ['place'],
    inversePredicate: null,
    cardinality: 'single_current',
    temporal: 'optional',
    defaultSensitivity: 'personal',
    projectionBehavior: 'dossier',
    conflictStrategy: 'supersede_current',
  },
  LIVES_IN: {
    predicate: 'LIVES_IN',
    allowedSubjectTypes: ['person'],
    allowedObjectTypes: ['place'],
    inversePredicate: null,
    cardinality: 'single_current',
    temporal: 'required',
    defaultSensitivity: 'sensitive',
    projectionBehavior: 'dossier',
    conflictStrategy: 'supersede_current',
  },
  VISITED: {
    predicate: 'VISITED',
    allowedSubjectTypes: ['person'],
    allowedObjectTypes: ['place'],
    inversePredicate: null,
    cardinality: 'append_only',
    temporal: 'required',
    defaultSensitivity: 'sensitive',
    projectionBehavior: 'episodic',
    conflictStrategy: 'coexist',
  },
  INTERESTED_IN: {
    predicate: 'INTERESTED_IN',
    allowedSubjectTypes: ['person'],
    allowedObjectTypes: ['topic', 'project', 'media_work', 'health_topic', 'benchmark', 'activity'],
    inversePredicate: null,
    cardinality: 'many',
    temporal: 'optional',
    defaultSensitivity: 'personal',
    projectionBehavior: 'core',
    conflictStrategy: 'coexist',
  },
  READ: {
    predicate: 'READ',
    allowedSubjectTypes: ['person'],
    allowedObjectTypes: ['media_work', 'document'],
    inversePredicate: null,
    cardinality: 'append_only',
    temporal: 'optional',
    defaultSensitivity: 'personal',
    projectionBehavior: 'episodic',
    conflictStrategy: 'coexist',
  },
  WATCHED: {
    predicate: 'WATCHED',
    allowedSubjectTypes: ['person'],
    allowedObjectTypes: ['media_work'],
    inversePredicate: null,
    cardinality: 'append_only',
    temporal: 'optional',
    defaultSensitivity: 'personal',
    projectionBehavior: 'episodic',
    conflictStrategy: 'coexist',
  },
  PLAYED: {
    predicate: 'PLAYED',
    allowedSubjectTypes: ['person'],
    allowedObjectTypes: ['media_work'],
    inversePredicate: null,
    cardinality: 'append_only',
    temporal: 'optional',
    defaultSensitivity: 'personal',
    projectionBehavior: 'episodic',
    conflictStrategy: 'coexist',
  },
  DRIVES: {
    predicate: 'DRIVES',
    allowedSubjectTypes: ['person'],
    allowedObjectTypes: ['vehicle'],
    inversePredicate: null,
    cardinality: 'many',
    temporal: 'optional',
    defaultSensitivity: 'personal',
    projectionBehavior: 'dossier',
    conflictStrategy: 'coexist',
  },
  RIDES: {
    predicate: 'RIDES',
    allowedSubjectTypes: ['person'],
    allowedObjectTypes: ['vehicle'],
    inversePredicate: null,
    cardinality: 'many',
    temporal: 'optional',
    defaultSensitivity: 'personal',
    projectionBehavior: 'dossier',
    conflictStrategy: 'coexist',
  },
  HAS_GOAL: {
    predicate: 'HAS_GOAL',
    allowedSubjectTypes: ['person', 'organization', 'project'],
    allowedObjectTypes: ['goal'],
    inversePredicate: null,
    cardinality: 'many',
    temporal: 'optional',
    defaultSensitivity: 'personal',
    projectionBehavior: 'core',
    conflictStrategy: 'coexist',
  },
  HAS_PLAN: {
    predicate: 'HAS_PLAN',
    allowedSubjectTypes: ['person', 'project', 'goal'],
    allowedObjectTypes: ['document', 'episode'],
    inversePredicate: null,
    cardinality: 'many',
    temporal: 'optional',
    defaultSensitivity: 'personal',
    projectionBehavior: 'dossier',
    conflictStrategy: 'coexist',
  },
  HAS_ROUTINE: {
    predicate: 'HAS_ROUTINE',
    allowedSubjectTypes: ['person'],
    allowedObjectTypes: ['routine'],
    inversePredicate: null,
    cardinality: 'many',
    temporal: 'optional',
    defaultSensitivity: 'personal',
    projectionBehavior: 'core',
    conflictStrategy: 'supersede_current',
  },
  HAS_CONSTRAINT: {
    predicate: 'HAS_CONSTRAINT',
    allowedSubjectTypes: ['person', 'project', 'device', 'configuration_profile'],
    allowedObjectTypes: 'literal',
    inversePredicate: null,
    cardinality: 'many',
    temporal: 'optional',
    defaultSensitivity: 'personal',
    projectionBehavior: 'core',
    conflictStrategy: 'supersede_current',
  },
  HAS_SETTING: {
    predicate: 'HAS_SETTING',
    allowedSubjectTypes: [
      'software', 'device', 'model', 'inference_backend', 'configuration_profile', 'project',
    ],
    allowedObjectTypes: 'literal',
    inversePredicate: null,
    cardinality: 'single_per_scope',
    temporal: 'optional',
    defaultSensitivity: 'low',
    projectionBehavior: 'dossier',
    conflictStrategy: 'supersede_current',
  },
  HAS_COMPONENT: {
    predicate: 'HAS_COMPONENT',
    allowedSubjectTypes: ['device', 'vehicle', 'home_asset', 'software', 'project'],
    allowedObjectTypes: ['device', 'software', 'home_asset'],
    inversePredicate: null,
    cardinality: 'many',
    temporal: 'none',
    defaultSensitivity: 'low',
    projectionBehavior: 'dossier',
    conflictStrategy: 'coexist',
  },
  RUNS_ON: {
    predicate: 'RUNS_ON',
    allowedSubjectTypes: ['software', 'model', 'project', 'inference_backend'],
    allowedObjectTypes: ['device', 'software', 'inference_backend'],
    inversePredicate: null,
    cardinality: 'many',
    temporal: 'optional',
    defaultSensitivity: 'low',
    projectionBehavior: 'dossier',
    conflictStrategy: 'coexist',
  },
  DEPENDS_ON: {
    predicate: 'DEPENDS_ON',
    allowedSubjectTypes: ['project', 'software', 'goal', 'model'],
    allowedObjectTypes: ['project', 'software', 'dataset', 'model', 'inference_backend'],
    inversePredicate: null,
    cardinality: 'many',
    temporal: 'none',
    defaultSensitivity: 'low',
    projectionBehavior: 'dossier',
    conflictStrategy: 'coexist',
  },
  CONFIGURED_WITH: {
    predicate: 'CONFIGURED_WITH',
    allowedSubjectTypes: ['software', 'model', 'device', 'inference_backend', 'project'],
    allowedObjectTypes: ['configuration_profile'],
    inversePredicate: null,
    cardinality: 'single_current',
    temporal: 'optional',
    defaultSensitivity: 'low',
    projectionBehavior: 'dossier',
    conflictStrategy: 'supersede_current',
  },
  COMPARED_WITH: {
    predicate: 'COMPARED_WITH',
    allowedSubjectTypes: ['model', 'software', 'inference_backend', 'benchmark', 'device'],
    allowedObjectTypes: ['model', 'software', 'inference_backend', 'benchmark', 'device'],
    inversePredicate: 'COMPARED_WITH',
    cardinality: 'many',
    temporal: 'none',
    defaultSensitivity: 'low',
    projectionBehavior: 'episodic',
    conflictStrategy: 'coexist',
  },
  TESTED_WITH: {
    predicate: 'TESTED_WITH',
    allowedSubjectTypes: ['model', 'software', 'project'],
    allowedObjectTypes: ['benchmark', 'dataset', 'configuration_profile'],
    inversePredicate: null,
    cardinality: 'many',
    temporal: 'none',
    defaultSensitivity: 'low',
    projectionBehavior: 'episodic',
    conflictStrategy: 'coexist',
  },
  RESULTED_IN: {
    predicate: 'RESULTED_IN',
    allowedSubjectTypes: ['episode', 'event', 'activity', 'benchmark'],
    allowedObjectTypes: ['event', 'document', 'goal', 'project'],
    inversePredicate: 'CAUSED_BY',
    cardinality: 'many',
    temporal: 'none',
    defaultSensitivity: 'personal',
    projectionBehavior: 'episodic',
    conflictStrategy: 'coexist',
  },
  CAUSED_BY: {
    predicate: 'CAUSED_BY',
    allowedSubjectTypes: ['event', 'document', 'goal', 'project'],
    allowedObjectTypes: ['episode', 'event', 'activity', 'benchmark'],
    inversePredicate: 'RESULTED_IN',
    cardinality: 'many',
    temporal: 'none',
    defaultSensitivity: 'personal',
    projectionBehavior: 'episodic',
    conflictStrategy: 'coexist',
  },
  RELATED_TO: {
    predicate: 'RELATED_TO',
    allowedSubjectTypes: ANY_NODE_TYPE,
    allowedObjectTypes: ANY_NODE_TYPE,
    inversePredicate: 'RELATED_TO',
    cardinality: 'many',
    temporal: 'none',
    defaultSensitivity: 'low',
    projectionBehavior: 'never_project',
    conflictStrategy: 'coexist',
  },
  PART_OF: {
    predicate: 'PART_OF',
    allowedSubjectTypes: [
      'project', 'document', 'topic', 'place', 'organization', 'goal', 'home_asset',
    ],
    allowedObjectTypes: [
      'project', 'document', 'topic', 'place', 'organization', 'goal', 'home_asset',
    ],
    inversePredicate: null,
    cardinality: 'many',
    temporal: 'none',
    defaultSensitivity: 'low',
    projectionBehavior: 'dossier',
    conflictStrategy: 'coexist',
  },
  ABOUT: {
    predicate: 'ABOUT',
    allowedSubjectTypes: [
      'document', 'episode', 'event', 'activity', 'media_work', 'question_topic', 'policy_topic',
    ],
    allowedObjectTypes: [
      'topic', 'project', 'person', 'organization', 'place', 'health_topic', 'financial_account',
    ],
    inversePredicate: null,
    cardinality: 'many',
    temporal: 'none',
    defaultSensitivity: 'personal',
    projectionBehavior: 'dossier',
    conflictStrategy: 'coexist',
  },
  MENTIONED_IN: {
    predicate: 'MENTIONED_IN',
    allowedSubjectTypes: ANY_NODE_TYPE,
    allowedObjectTypes: ['document', 'episode', 'event'],
    inversePredicate: null,
    cardinality: 'append_only',
    temporal: 'none',
    defaultSensitivity: 'personal',
    projectionBehavior: 'never_project',
    conflictStrategy: 'coexist',
  },
  OBSERVED_DURING: {
    predicate: 'OBSERVED_DURING',
    allowedSubjectTypes: ['activity', 'software', 'device'],
    allowedObjectTypes: ['episode', 'event'],
    inversePredicate: null,
    cardinality: 'append_only',
    temporal: 'required',
    defaultSensitivity: 'personal',
    projectionBehavior: 'episodic',
    conflictStrategy: 'coexist',
  },
  ASKED_ABOUT: {
    predicate: 'ASKED_ABOUT',
    allowedSubjectTypes: ['question_topic'],
    allowedObjectTypes: [
      'topic', 'person', 'project', 'health_topic', 'financial_account', 'policy_topic',
    ],
    inversePredicate: null,
    cardinality: 'many',
    temporal: 'none',
    defaultSensitivity: 'personal',
    projectionBehavior: 'never_project',
    conflictStrategy: 'coexist',
  },
};

export function getRelationDefinition(predicate: string): RelationDefinition {
  const parsed = RelationTypeSchema.safeParse(predicate);
  if (!parsed.success) {
    throw new Error(`Unregistered relation predicate: ${predicate}`);
  }
  return RELATION_DEFINITIONS[parsed.data];
}

export function isNodeTypeAllowedAsSubject(definition: RelationDefinition, nodeType: NodeType): boolean {
  return definition.allowedSubjectTypes.includes(nodeType);
}

export function isNodeTypeAllowedAsObject(definition: RelationDefinition, nodeType: NodeType): boolean {
  if (definition.allowedObjectTypes === 'literal') {
    return false;
  }
  return definition.allowedObjectTypes.includes(nodeType);
}

export function relationDefaultSensitivity(definition: RelationDefinition): Sensitivity {
  return definition.defaultSensitivity;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- assistant-domain-registries`
Expected: PASS — 12 tests

- [ ] **Step 5: Commit**

```bash
git add src/assistant/domain/relation-types.ts tests/assistant-domain-registries.test.ts
git commit -m "feat(assistant): add relation type registry with deterministic descriptors"
```

---

## Task 3: Clock and ID generator abstractions

The repository has no shared clock or ID abstraction — every store inlines `new Date().toISOString()` and `randomUUID()`. Deterministic assistant tests require injected time and IDs (design §19), so Gate A introduces both as classes. Assistant code never calls `Date` or `randomUUID` directly.

**Files:**
- Create: `src/assistant/runtime/clock.ts`
- Create: `src/assistant/runtime/ids.ts`
- Test: `tests/assistant-runtime-abstractions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/assistant-runtime-abstractions.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AssistantClock,
  SystemAssistantClock,
  FixedAssistantClock,
} from '../src/assistant/runtime/clock.js';
import {
  AssistantIdGenerator,
  RandomAssistantIdGenerator,
  SequentialAssistantIdGenerator,
  ASSISTANT_ID_PREFIXES,
} from '../src/assistant/runtime/ids.js';

test('system clock returns an ISO-8601 UTC instant', () => {
  const clock = new SystemAssistantClock();
  assert.ok(clock instanceof AssistantClock);
  assert.match(clock.nowUtc(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
});

test('fixed clock is stable until advanced', () => {
  const clock = new FixedAssistantClock('2026-08-04T09:00:00.000Z');
  assert.equal(clock.nowUtc(), '2026-08-04T09:00:00.000Z');
  assert.equal(clock.nowUtc(), '2026-08-04T09:00:00.000Z');
  clock.advanceSeconds(90);
  assert.equal(clock.nowUtc(), '2026-08-04T09:01:30.000Z');
  clock.setUtc('2027-01-01T00:00:00.000Z');
  assert.equal(clock.nowUtc(), '2027-01-01T00:00:00.000Z');
});

test('fixed clock rejects a non-ISO instant', () => {
  assert.throws(
    () => new FixedAssistantClock('yesterday'),
    /Invalid fixed clock instant: yesterday/u,
  );
});

test('sequential id generator is deterministic and prefix scoped', () => {
  const ids = new SequentialAssistantIdGenerator();
  assert.ok(ids instanceof AssistantIdGenerator);
  assert.equal(ids.next(ASSISTANT_ID_PREFIXES.node), 'nod_000001');
  assert.equal(ids.next(ASSISTANT_ID_PREFIXES.node), 'nod_000002');
  assert.equal(ids.next(ASSISTANT_ID_PREFIXES.assertion), 'ast_000003');
});

test('random id generator produces unique prefixed opaque ids', () => {
  const ids = new RandomAssistantIdGenerator();
  const first = ids.next(ASSISTANT_ID_PREFIXES.evidence);
  const second = ids.next(ASSISTANT_ID_PREFIXES.evidence);
  assert.notEqual(first, second);
  assert.match(first, /^evd_[0-9a-f]{32}$/u);
});

test('id prefixes cover every Gate A entity and are unique', () => {
  const prefixes = Object.values(ASSISTANT_ID_PREFIXES);
  assert.equal(new Set(prefixes).size, prefixes.length);
  assert.deepEqual(Object.keys(ASSISTANT_ID_PREFIXES).sort(), [
    'alias', 'assertion', 'audit', 'blob', 'candidate', 'device', 'evidence',
    'merge', 'mutation', 'node', 'observation', 'owner', 'policy',
  ]);
});

test('id generator rejects an empty prefix', () => {
  const ids = new SequentialAssistantIdGenerator();
  assert.throws(() => ids.next(''), /Assistant id prefix must not be empty/u);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- assistant-runtime-abstractions`
Expected: FAIL — `Cannot find module '../src/assistant/runtime/clock.js'`

- [ ] **Step 3: Write `src/assistant/runtime/clock.ts`**

```ts
export abstract class AssistantClock {
  abstract nowUtc(): string;
}

export class SystemAssistantClock extends AssistantClock {
  nowUtc(): string {
    return new Date().toISOString();
  }
}

export class FixedAssistantClock extends AssistantClock {
  private currentEpochMs: number;

  constructor(startUtc: string) {
    super();
    this.currentEpochMs = FixedAssistantClock.parseInstant(startUtc);
  }

  private static parseInstant(value: string): number {
    const epochMs = Date.parse(value);
    if (!Number.isFinite(epochMs)) {
      throw new Error(`Invalid fixed clock instant: ${value}`);
    }
    return epochMs;
  }

  nowUtc(): string {
    return new Date(this.currentEpochMs).toISOString();
  }

  advanceSeconds(seconds: number): void {
    if (!Number.isFinite(seconds)) {
      throw new Error(`Invalid clock advance in seconds: ${String(seconds)}`);
    }
    this.currentEpochMs += Math.round(seconds * 1000);
  }

  setUtc(value: string): void {
    this.currentEpochMs = FixedAssistantClock.parseInstant(value);
  }
}
```

- [ ] **Step 4: Write `src/assistant/runtime/ids.ts`**

```ts
import { randomUUID } from 'node:crypto';

export const ASSISTANT_ID_PREFIXES = {
  owner: 'own',
  device: 'dev',
  node: 'nod',
  alias: 'ali',
  evidence: 'evd',
  blob: 'blb',
  observation: 'obs',
  candidate: 'cnd',
  assertion: 'ast',
  merge: 'mrg',
  mutation: 'mut',
  policy: 'pol',
  audit: 'aud',
} as const;

export abstract class AssistantIdGenerator {
  abstract next(prefix: string): string;

  protected assertPrefix(prefix: string): string {
    const normalized = prefix.trim();
    if (!normalized) {
      throw new Error('Assistant id prefix must not be empty');
    }
    return normalized;
  }
}

export class RandomAssistantIdGenerator extends AssistantIdGenerator {
  next(prefix: string): string {
    return `${this.assertPrefix(prefix)}_${randomUUID().replace(/-/gu, '')}`;
  }
}

export class SequentialAssistantIdGenerator extends AssistantIdGenerator {
  private counter = 0;

  next(prefix: string): string {
    const normalized = this.assertPrefix(prefix);
    this.counter += 1;
    return `${normalized}_${String(this.counter).padStart(6, '0')}`;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- assistant-runtime-abstractions`
Expected: PASS — 7 tests

- [ ] **Step 6: Commit**

```bash
git add src/assistant/runtime/clock.ts src/assistant/runtime/ids.ts tests/assistant-runtime-abstractions.test.ts
git commit -m "feat(assistant): add injectable clock and id generator abstractions"
```

---

## Task 4: Derived keys and literal normalization

Design §5.4.1. Three columns are deterministic derivations with a stability requirement: the same input yields the same key across processes.

**Files:**
- Create: `src/assistant/domain/keys.ts`
- Test: `tests/assistant-derived-keys.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/assistant-derived-keys.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalJsonText,
  normalizeLiteralValue,
  buildLiteralObjectKey,
  buildNodeObjectKey,
  computeAssertionKey,
  computeCandidateFingerprint,
  computeTextContentHash,
  computeBytesContentHash,
  encodeKeyFields,
} from '../src/assistant/domain/keys.js';

test('canonical json text sorts object keys recursively and is stable', () => {
  assert.equal(
    canonicalJsonText({ b: 1, a: { d: [3, 2], c: true } }),
    '{"a":{"c":true,"d":[3,2]},"b":1}',
  );
  assert.equal(canonicalJsonText(null), 'null');
  assert.equal(canonicalJsonText([1, 'x']), '[1,"x"]');
});

test('string literals normalize by trim, NFC and lowercase', () => {
  assert.equal(normalizeLiteralValue({ valueType: 'string', value: '  PowerShell  ' }), 'powershell');
  assert.equal(
    normalizeLiteralValue({ valueType: 'string', value: 'café' }),
    normalizeLiteralValue({ valueType: 'string', value: 'café' }),
  );
});

test('number literals normalize to shortest round-trip decimal', () => {
  assert.equal(normalizeLiteralValue({ valueType: 'number', value: 1.5 }), '1.5');
  assert.equal(normalizeLiteralValue({ valueType: 'number', value: 1.50 }), '1.5');
  assert.equal(normalizeLiteralValue({ valueType: 'integer', value: 42 }), '42');
  assert.throws(
    () => normalizeLiteralValue({ valueType: 'integer', value: 4.2 }),
    /Integer literal must be an integer: 4.2/u,
  );
});

test('date and datetime literals normalize to UTC ISO-8601', () => {
  assert.equal(
    normalizeLiteralValue({ valueType: 'datetime', value: '2026-08-04T12:00:00+02:00' }),
    '2026-08-04T10:00:00.000Z',
  );
  assert.equal(normalizeLiteralValue({ valueType: 'date', value: '2026-08-04T23:30:00Z' }), '2026-08-04');
  assert.throws(
    () => normalizeLiteralValue({ valueType: 'datetime', value: 'soon' }),
    /Invalid datetime literal: soon/u,
  );
});

test('quantity literals normalize to amount and lowercased unit', () => {
  assert.equal(
    normalizeLiteralValue({ valueType: 'quantity', value: { amount: 24, unit: 'GB' } }),
    '24 gb',
  );
});

test('boolean and json literals normalize deterministically', () => {
  assert.equal(normalizeLiteralValue({ valueType: 'boolean', value: true }), 'true');
  assert.equal(
    normalizeLiteralValue({ valueType: 'json', value: { z: 1, a: 2 } }),
    '{"a":2,"z":1}',
  );
});

test('object keys distinguish node references from literals', () => {
  assert.equal(buildNodeObjectKey('nod_000001'), 'node:nod_000001');
  assert.equal(
    buildLiteralObjectKey({ valueType: 'string', value: 'PowerShell' }),
    'literal:string:powershell',
  );
});

test('assertion key is a stable sha-256 over the canonical tuple', () => {
  const key = computeAssertionKey({
    ownerId: 'own_local',
    subjectNodeId: 'nod_000001',
    predicate: 'PREFERS',
    objectKey: buildNodeObjectKey('nod_000002'),
    scopeNodeId: null,
  });
  assert.match(key, /^[0-9a-f]{64}$/u);
  assert.equal(
    key,
    computeAssertionKey({
      ownerId: 'own_local',
      subjectNodeId: 'nod_000001',
      predicate: 'PREFERS',
      objectKey: buildNodeObjectKey('nod_000002'),
      scopeNodeId: null,
    }),
  );
});

test('a null scope is distinct from a scoped assertion', () => {
  const unscoped = computeAssertionKey({
    ownerId: 'own_local',
    subjectNodeId: 'nod_1',
    predicate: 'PREFERS',
    objectKey: 'literal:string:powershell',
    scopeNodeId: null,
  });
  const scoped = computeAssertionKey({
    ownerId: 'own_local',
    subjectNodeId: 'nod_1',
    predicate: 'PREFERS',
    objectKey: 'literal:string:powershell',
    scopeNodeId: 'nod_scope',
  });
  assert.notEqual(unscoped, scoped);
});

test('candidate fingerprint collides for duplicate unresolved proposals', () => {
  const first = computeCandidateFingerprint({
    ownerId: 'own_local',
    subjectRef: { type: 'person', displayName: '  Denys  ' },
    predicate: 'USES',
    objectRef: { type: 'software', displayName: 'PowerShell' },
    scopeRef: null,
  });
  const second = computeCandidateFingerprint({
    ownerId: 'own_local',
    subjectRef: { type: 'person', displayName: 'denys' },
    predicate: 'USES',
    objectRef: { type: 'software', displayName: 'powershell' },
    scopeRef: null,
  });
  assert.equal(first, second);
});

test('content hashing normalizes text line endings and unicode form', () => {
  assert.equal(
    computeTextContentHash('line one\r\nline two'),
    computeTextContentHash('line one\nline two'),
  );
  assert.equal(computeTextContentHash('café'), computeTextContentHash('café'));
  assert.match(computeBytesContentHash(Buffer.from([1, 2, 3])), /^[0-9a-f]{64}$/u);
});

test('derived keys match their golden digests, so they are stable across processes', () => {
  // These constants pin the canonical tuple encoding itself. If a change to encodeKeyFields,
  // literal normalization, or field order alters them, every stored assertion_key in every
  // existing database would silently stop matching -- so a failure here is a migration problem,
  // never a test to update casually.
  assert.equal(
    encodeKeyFields(['own_local', 'nod_1', 'OWNS', 'node:nod_2', '']),
    '9:own_local5:nod_14:OWNS10:node:nod_20:',
  );
  assert.equal(
    computeAssertionKey({
      ownerId: 'own_local',
      subjectNodeId: 'nod_1',
      predicate: 'OWNS',
      objectKey: 'node:nod_2',
      scopeNodeId: null,
    }),
    'c24fe74e3002c679fb62675412483ae9e4eed824c389b84b21d42d2cab45ded6',
  );
  assert.equal(
    computeCandidateFingerprint({
      ownerId: 'own_local',
      subjectRef: { type: 'person', displayName: 'Denys' },
      predicate: 'USES',
      objectRef: { type: 'software', displayName: 'PowerShell' },
      scopeRef: null,
    }),
    '91da0457aaf5bc6d97a54928e708b50a27fa8e10a701c95c441881a1b43c3862',
  );
});

test('field encoding cannot be spoofed by embedding the separator in a value', () => {
  // Two different field splits must never encode identically.
  assert.notEqual(encodeKeyFields(['a:b', 'c']), encodeKeyFields(['a', 'b:c']));
  assert.notEqual(encodeKeyFields(['', 'ab']), encodeKeyFields(['ab', '']));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- assistant-derived-keys`
Expected: FAIL — `Cannot find module '../src/assistant/domain/keys.js'`

- [ ] **Step 3: Write `src/assistant/domain/keys.ts`**

```ts
import { createHash } from 'node:crypto';
import { z } from '../../lib/zod.js';
import { JsonValueSchema, type JsonValue } from '../../lib/json-types.js';
import { NodeTypeSchema } from './node-types.js';
import { RelationTypeSchema } from './relation-types.js';

export const QuantityLiteralSchema = z.object({
  amount: z.number(),
  unit: z.string(),
});

export const LiteralObjectValueSchema = z.discriminatedUnion('valueType', [
  z.object({ valueType: z.literal('string'), value: z.string() }),
  z.object({ valueType: z.literal('integer'), value: z.number() }),
  z.object({ valueType: z.literal('number'), value: z.number() }),
  z.object({ valueType: z.literal('boolean'), value: z.boolean() }),
  z.object({ valueType: z.literal('date'), value: z.string() }),
  z.object({ valueType: z.literal('datetime'), value: z.string() }),
  z.object({ valueType: z.literal('duration'), value: z.string() }),
  z.object({ valueType: z.literal('quantity'), value: QuantityLiteralSchema }),
  z.object({ valueType: z.literal('json'), value: JsonValueSchema }),
]);
export type LiteralObjectValue = z.infer<typeof LiteralObjectValueSchema>;

export const UnresolvedNodeRefSchema = z.object({
  type: NodeTypeSchema,
  displayName: z.string(),
});
export type UnresolvedNodeRef = z.infer<typeof UnresolvedNodeRefSchema>;

export function canonicalJsonText(value: JsonValue): string {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJsonText(entry)).join(',')}]`;
  }
  const sortedKeys = Object.keys(value).sort();
  const entries = sortedKeys.map((key) => {
    const entry = value[key];
    return `${JSON.stringify(key)}:${canonicalJsonText(entry === undefined ? null : entry)}`;
  });
  return `{${entries.join(',')}}`;
}

export function normalizeText(value: string): string {
  return value.normalize('NFC').replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
}

function normalizeStringLiteral(value: string): string {
  return value.trim().normalize('NFC').toLowerCase();
}

function normalizeInstant(value: string, valueType: 'date' | 'datetime'): string {
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs)) {
    throw new Error(`Invalid ${valueType} literal: ${value}`);
  }
  const iso = new Date(epochMs).toISOString();
  return valueType === 'date' ? iso.slice(0, 10) : iso;
}

export function normalizeLiteralValue(literal: LiteralObjectValue): string {
  switch (literal.valueType) {
    case 'string':
    case 'duration':
      return normalizeStringLiteral(literal.value);
    case 'integer':
      if (!Number.isInteger(literal.value)) {
        throw new Error(`Integer literal must be an integer: ${String(literal.value)}`);
      }
      return String(literal.value);
    case 'number':
      if (!Number.isFinite(literal.value)) {
        throw new Error(`Number literal must be finite: ${String(literal.value)}`);
      }
      return String(literal.value);
    case 'boolean':
      return literal.value ? 'true' : 'false';
    case 'date':
    case 'datetime':
      return normalizeInstant(literal.value, literal.valueType);
    case 'quantity':
      if (!Number.isFinite(literal.value.amount)) {
        throw new Error(`Quantity amount must be finite: ${String(literal.value.amount)}`);
      }
      return `${String(literal.value.amount)} ${literal.value.unit.trim().toLowerCase()}`;
    case 'json':
      return canonicalJsonText(literal.value);
  }
}

export function buildNodeObjectKey(nodeId: string): string {
  return `node:${nodeId}`;
}

export function buildLiteralObjectKey(literal: LiteralObjectValue): string {
  return `literal:${literal.valueType}:${normalizeLiteralValue(literal)}`;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// Canonical tuple encoding. A normalized literal may contain any character, so no separator is
// collision-proof; each field is therefore length-prefixed, which is unambiguous by construction.
// The fields "a" and "bc" encode as `1:a2:bc`, which no other field split can produce.
export function encodeKeyFields(fields: readonly string[]): string {
  return fields.map((field) => `${String(field.length)}:${field}`).join('');
}

export interface AssertionKeyInput {
  ownerId: string;
  subjectNodeId: string;
  predicate: string;
  objectKey: string;
  scopeNodeId: string | null;
}

export function computeAssertionKey(input: AssertionKeyInput): string {
  const predicate = RelationTypeSchema.parse(input.predicate);
  return sha256Hex(encodeKeyFields([
    input.ownerId,
    input.subjectNodeId,
    predicate,
    input.objectKey,
    input.scopeNodeId ?? '',
  ]));
}

export interface CandidateFingerprintInput {
  ownerId: string;
  subjectRef: UnresolvedNodeRef;
  predicate: string;
  objectRef: UnresolvedNodeRef | LiteralObjectValue;
  scopeRef: UnresolvedNodeRef | null;
}

function unresolvedRefKey(ref: UnresolvedNodeRef): string {
  return `${ref.type}:${normalizeStringLiteral(ref.displayName)}`;
}

function candidateObjectKey(ref: UnresolvedNodeRef | LiteralObjectValue): string {
  if ('valueType' in ref) {
    return buildLiteralObjectKey(ref);
  }
  return unresolvedRefKey(ref);
}

export function computeCandidateFingerprint(input: CandidateFingerprintInput): string {
  const predicate = RelationTypeSchema.parse(input.predicate);
  return sha256Hex(encodeKeyFields([
    input.ownerId,
    unresolvedRefKey(input.subjectRef),
    predicate,
    candidateObjectKey(input.objectRef),
    input.scopeRef === null ? '' : unresolvedRefKey(input.scopeRef),
  ]));
}

export function computeTextContentHash(text: string): string {
  return sha256Hex(normalizeText(text));
}

export function computeBytesContentHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function normalizeAlias(alias: string): string {
  return alias.trim().normalize('NFC').toLowerCase().replace(/\s+/gu, ' ');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- assistant-derived-keys`
Expected: PASS — 13 tests

- [ ] **Step 5: Commit**

```bash
git add src/assistant/domain/keys.ts tests/assistant-derived-keys.test.ts
git commit -m "feat(assistant): add derived key and literal normalization functions"
```

---

## Task 5: Confidence ceilings and aggregation

Design §4.6. Confidence is derived, never free-form: aggregate independent evidence clusters, then apply the basis ceiling. Explicit statements always outrank passive evidence regardless of volume.

**Files:**
- Create: `src/assistant/domain/confidence.ts`
- Test: `tests/assistant-confidence.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/assistant-confidence.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BASIS_CONFIDENCE_CEILINGS,
  EXPLICIT_CORRECTION_CEILING,
  SINGLE_SCREENSHOT_INFERENCE_CEILING,
  aggregateIndependentSupport,
  applyBasisCeiling,
  clampConfidence,
  isExplicitBasis,
  outranks,
} from '../src/assistant/domain/confidence.js';

test('basis ceilings match the design table', () => {
  assert.equal(BASIS_CONFIDENCE_CEILINGS.explicit_user_statement, 0.99);
  assert.equal(BASIS_CONFIDENCE_CEILINGS.explicit_question_answer, 0.98);
  assert.equal(BASIS_CONFIDENCE_CEILINGS.manual_import, 0.95);
  assert.equal(BASIS_CONFIDENCE_CEILINGS.passive_observation, 0.85);
  assert.equal(BASIS_CONFIDENCE_CEILINGS.derived_aggregation, 0.80);
  assert.equal(BASIS_CONFIDENCE_CEILINGS.assistant_inference, 0.75);
  assert.equal(EXPLICIT_CORRECTION_CEILING, 1.0);
  assert.equal(SINGLE_SCREENSHOT_INFERENCE_CEILING, 0.55);
});

test('independent support uses the noisy-or formula', () => {
  assert.equal(aggregateIndependentSupport([]), 0);
  assert.equal(aggregateIndependentSupport([0.5]), 0.5);
  // 1 - (0.5 * 0.5) = 0.75
  assert.equal(aggregateIndependentSupport([0.5, 0.5]), 0.75);
  // 1 - (0.6 * 0.7 * 0.8) = 0.664
  assert.ok(Math.abs(aggregateIndependentSupport([0.4, 0.3, 0.2]) - 0.664) < 1e-9);
});

test('independent support saturates but never reaches or exceeds one', () => {
  const value = aggregateIndependentSupport([0.99, 0.99, 0.99, 0.99]);
  assert.ok(value > 0.99);
  assert.ok(value < 1);
});

test('independent support rejects a weight outside the unit interval', () => {
  assert.throws(() => aggregateIndependentSupport([1.2]), /Evidence weight out of range: 1.2/u);
  assert.throws(() => aggregateIndependentSupport([-0.1]), /Evidence weight out of range: -0.1/u);
});

test('basis ceiling caps an over-confident value and leaves a compliant one', () => {
  assert.equal(applyBasisCeiling(0.97, 'passive_observation'), 0.85);
  assert.equal(applyBasisCeiling(0.42, 'passive_observation'), 0.42);
  assert.equal(applyBasisCeiling(1.0, 'explicit_user_statement'), 0.99);
});

test('clamp keeps confidence inside the unit interval', () => {
  assert.equal(clampConfidence(-3), 0);
  assert.equal(clampConfidence(7), 1);
  assert.equal(clampConfidence(0.5), 0.5);
  assert.throws(() => clampConfidence(Number.NaN), /Confidence must be a finite number/u);
});

test('explicit bases are recognised', () => {
  assert.equal(isExplicitBasis('explicit_user_statement'), true);
  assert.equal(isExplicitBasis('explicit_question_answer'), true);
  assert.equal(isExplicitBasis('manual_import'), true);
  assert.equal(isExplicitBasis('passive_observation'), false);
  assert.equal(isExplicitBasis('derived_aggregation'), false);
  assert.equal(isExplicitBasis('assistant_inference'), false);
});

test('no amount of passive confidence outranks an explicit statement', () => {
  assert.equal(
    outranks(
      { basis: 'passive_observation', confidence: 0.85 },
      { basis: 'explicit_user_statement', confidence: 0.30 },
    ),
    false,
  );
  assert.equal(
    outranks(
      { basis: 'explicit_user_statement', confidence: 0.30 },
      { basis: 'passive_observation', confidence: 0.85 },
    ),
    true,
  );
});

test('within the same basis class confidence decides and ties do not outrank', () => {
  assert.equal(
    outranks(
      { basis: 'passive_observation', confidence: 0.7 },
      { basis: 'derived_aggregation', confidence: 0.6 },
    ),
    true,
  );
  assert.equal(
    outranks(
      { basis: 'passive_observation', confidence: 0.6 },
      { basis: 'derived_aggregation', confidence: 0.6 },
    ),
    false,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- assistant-confidence`
Expected: FAIL — `Cannot find module '../src/assistant/domain/confidence.js'`

- [ ] **Step 3: Write `src/assistant/domain/confidence.ts`**

```ts
import type { AssertionBasis } from './primitives.js';

export const BASIS_CONFIDENCE_CEILINGS: Readonly<Record<AssertionBasis, number>> = {
  explicit_user_statement: 0.99,
  explicit_question_answer: 0.98,
  manual_import: 0.95,
  passive_observation: 0.85,
  derived_aggregation: 0.80,
  assistant_inference: 0.75,
};

// An explicit user correction is the only path to full confidence, and it is applied by the
// mutation service, not by an extractor.
export const EXPLICIT_CORRECTION_CEILING = 1.0;
export const SINGLE_SCREENSHOT_INFERENCE_CEILING = 0.55;
export const SINGLE_AMBIGUOUS_ACTIVITY_CEILING = 0.40;

const EXPLICIT_BASES: readonly AssertionBasis[] = [
  'explicit_user_statement',
  'explicit_question_answer',
  'manual_import',
];

export function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Confidence must be a finite number: ${String(value)}`);
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

// support = 1 − Π(1 − wᵢ) over independent evidence clusters.
export function aggregateIndependentSupport(weights: readonly number[]): number {
  let complement = 1;
  for (const weight of weights) {
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
      throw new Error(`Evidence weight out of range: ${String(weight)}`);
    }
    complement *= 1 - weight;
  }
  return clampConfidence(1 - complement);
}

export function applyBasisCeiling(confidence: number, basis: AssertionBasis): number {
  return Math.min(clampConfidence(confidence), BASIS_CONFIDENCE_CEILINGS[basis]);
}

export function isExplicitBasis(basis: AssertionBasis): boolean {
  return EXPLICIT_BASES.includes(basis);
}

export interface BeliefStrength {
  basis: AssertionBasis;
  confidence: number;
}

// Explicit basis always beats non-explicit basis. Within a class, higher confidence wins.
// A tie never outranks, so an incumbent assertion is never displaced by an equal challenger.
export function outranks(challenger: BeliefStrength, incumbent: BeliefStrength): boolean {
  const challengerExplicit = isExplicitBasis(challenger.basis);
  const incumbentExplicit = isExplicitBasis(incumbent.basis);
  if (challengerExplicit !== incumbentExplicit) {
    return challengerExplicit;
  }
  return clampConfidence(challenger.confidence) > clampConfidence(incumbent.confidence);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- assistant-confidence`
Expected: PASS — 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/assistant/domain/confidence.ts tests/assistant-confidence.test.ts
git commit -m "feat(assistant): add confidence ceilings and independent evidence aggregation"
```

---

## Task 6: Migration step v39 — core assistant tables

Design §5.1/§5.2, corrected to v39. The DDL lives in `src/assistant/storage/schema.ts`; the ladder in `src/state/runtime-db.ts` calls it. Every statement is idempotent so re-running the ladder is a no-op.

**Files:**
- Create: `src/assistant/storage/schema.ts`
- Modify: `src/state/runtime-db.ts` (line 37 `CURRENT_SCHEMA_VERSION`, fresh-DB branch at 985-993, ladder tail after line 1423)
- Test: `tests/assistant-migration.test.ts`
- Test helper: `tests/helpers/assistant-fixture.ts`

- [ ] **Step 1: Write the test helper**

Create `tests/helpers/assistant-fixture.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { closeRuntimeDatabase, getRuntimeDatabase, type RuntimeDatabase } from '../../src/state/runtime-db.js';
import { createManagedTempDir } from './temp-dirs.js';

export interface AssistantFixtureContext {
  repoRoot: string;
  runtimeRoot: string;
  database: RuntimeDatabase;
}

// Runs `body` inside a throwaway SiftKit repo so the runtime database is created from scratch
// and torn down afterwards. Mirrors withTempRepo in tests/chat-sessions-db.test.ts.
export function withAssistantRepo(body: (context: AssistantFixtureContext) => void): void {
  const tempRoot = createManagedTempDir('siftkit-assistant-');
  const previousCwd = process.cwd();
  try {
    fs.writeFileSync(
      path.join(tempRoot, 'package.json'),
      JSON.stringify({ name: 'siftkit', version: '0.1.0' }, null, 2),
      'utf8',
    );
    process.chdir(tempRoot);
    const database = getRuntimeDatabase();
    body({
      repoRoot: tempRoot,
      runtimeRoot: path.join(tempRoot, '.siftkit'),
      database,
    });
  } finally {
    closeRuntimeDatabase();
    process.chdir(previousCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/assistant-migration.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from '../src/lib/zod.js';
import { CURRENT_SCHEMA_VERSION, type RuntimeDatabase } from '../src/state/runtime-db.js';
import {
  ASSISTANT_CORE_TABLES,
  LOCAL_OWNER_ID,
  LOCAL_DEVICE_ID,
  applyAssistantCoreSchema,
  seedAssistantRegistries,
} from '../src/assistant/storage/schema.js';
import { NODE_TYPES } from '../src/assistant/domain/node-types.js';
import { RELATION_TYPES } from '../src/assistant/domain/relation-types.js';
import { withAssistantRepo } from './helpers/assistant-fixture.js';

const CountRowSchema = z.object({ total: z.number() });
const NameRowSchema = z.object({ name: z.string() });
const STAMP = '2026-08-04T00:00:00.000Z';

function countRows(database: RuntimeDatabase, table: string): number {
  return CountRowSchema.parse(database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()).total;
}

function tableNames(database: RuntimeDatabase): readonly string[] {
  const rows = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all();
  return rows.map((row) => NameRowSchema.parse(row).name);
}

function insertOwnerNode(database: RuntimeDatabase, nodeId: string): void {
  database.prepare(`
    INSERT INTO graph_nodes (
      id, owner_id, type, canonical_key, display_name, description, sensitivity, status,
      properties_json, merged_into_node_id, created_at_utc, updated_at_utc, deleted_at_utc
    ) VALUES (?, ?, 'person', 'person:self', 'Owner', NULL, 'personal', 'active', '{}', NULL, ?, ?, NULL)
  `).run(nodeId, LOCAL_OWNER_ID, STAMP, STAMP);
}

test('current schema version is 40 after the two assistant steps', () => {
  assert.equal(CURRENT_SCHEMA_VERSION, 40);
});

test('a fresh runtime database contains every assistant core table', () => {
  withAssistantRepo(({ database }) => {
    const names = tableNames(database);
    for (const table of ASSISTANT_CORE_TABLES) {
      assert.ok(names.includes(table), `missing assistant table ${table}`);
    }
  });
});

test('registries are seeded from the typescript constants', () => {
  withAssistantRepo(({ database }) => {
    assert.equal(countRows(database, 'graph_node_types'), NODE_TYPES.length);
    assert.equal(countRows(database, 'graph_relation_types'), RELATION_TYPES.length);
    assert.equal(countRows(database, 'assistant_owners'), 1);
    assert.equal(countRows(database, 'assistant_devices'), 1);
    const owner = z.object({ id: z.string() }).parse(
      database.prepare('SELECT id FROM assistant_owners LIMIT 1').get(),
    );
    assert.equal(owner.id, LOCAL_OWNER_ID);
    const device = z.object({ id: z.string(), owner_id: z.string(), status: z.string() }).parse(
      database.prepare('SELECT id, owner_id, status FROM assistant_devices LIMIT 1').get(),
    );
    assert.equal(device.id, LOCAL_DEVICE_ID);
    assert.equal(device.owner_id, LOCAL_OWNER_ID);
    assert.equal(device.status, 'active');
  });
});

test('re-applying the assistant schema and seed is idempotent', () => {
  withAssistantRepo(({ database }) => {
    applyAssistantCoreSchema(database);
    seedAssistantRegistries(database, STAMP);
    applyAssistantCoreSchema(database);
    seedAssistantRegistries(database, STAMP);
    assert.equal(countRows(database, 'graph_node_types'), NODE_TYPES.length);
    assert.equal(countRows(database, 'graph_relation_types'), RELATION_TYPES.length);
    assert.equal(countRows(database, 'assistant_owners'), 1);
    assert.equal(countRows(database, 'assistant_devices'), 1);
  });
});

test('relation type rows round-trip their json definition', () => {
  withAssistantRepo(({ database }) => {
    const row = z.object({ name: z.string(), definition_json: z.string() }).parse(
      database.prepare('SELECT name, definition_json FROM graph_relation_types WHERE name = ?').get('PREFERS'),
    );
    const parsed = z.object({
      predicate: z.string(),
      cardinality: z.string(),
      projectionBehavior: z.string(),
    }).parse(JSON.parse(row.definition_json));
    assert.equal(parsed.predicate, 'PREFERS');
    assert.equal(parsed.cardinality, 'single_per_scope');
    assert.equal(parsed.projectionBehavior, 'core');
  });
});

test('foreign keys are enforced against the owner table', () => {
  withAssistantRepo(({ database }) => {
    assert.throws(
      () => database.prepare(`
        INSERT INTO graph_nodes (
          id, owner_id, type, canonical_key, display_name, description, sensitivity, status,
          properties_json, merged_into_node_id, created_at_utc, updated_at_utc, deleted_at_utc
        ) VALUES (?, ?, 'person', NULL, 'Ghost', NULL, 'personal', 'active', '{}', NULL, ?, ?, NULL)
      `).run('nod_orphan', 'own_missing', STAMP, STAMP),
      /FOREIGN KEY constraint failed/u,
    );
  });
});

test('an assertion must be exactly one of a node object or a literal object', () => {
  withAssistantRepo(({ database }) => {
    insertOwnerNode(database, 'nod_subject');
    assert.throws(
      () => database.prepare(`
        INSERT INTO graph_assertions (
          id, owner_id, assertion_key, subject_node_id, predicate, object_kind, object_node_id,
          object_value_type, object_value_json, object_normalized_text, scope_node_id, status, basis,
          confidence, sensitivity, valid_from_utc, valid_to_utc, first_observed_at_utc,
          last_observed_at_utc, recorded_at_utc, retired_at_utc, supersedes_assertion_id, pinned,
          attributes_json, created_at_utc, updated_at_utc
        ) VALUES ('ast_bad', ?, 'key_bad', 'nod_subject', 'USES', 'node', NULL, NULL, NULL, NULL,
          NULL, 'active', 'explicit_user_statement', 0.9, 'personal', NULL, NULL, ?, ?, ?, NULL,
          NULL, 0, '{}', ?, ?)
      `).run(LOCAL_OWNER_ID, STAMP, STAMP, STAMP, STAMP, STAMP),
      /CHECK constraint failed/u,
    );
  });
});

test('only one live assertion may share an assertion key', () => {
  withAssistantRepo(({ database }) => {
    insertOwnerNode(database, 'nod_s');
    const insert = database.prepare(`
      INSERT INTO graph_assertions (
        id, owner_id, assertion_key, subject_node_id, predicate, object_kind, object_node_id,
        object_value_type, object_value_json, object_normalized_text, scope_node_id, status, basis,
        confidence, sensitivity, valid_from_utc, valid_to_utc, first_observed_at_utc,
        last_observed_at_utc, recorded_at_utc, retired_at_utc, supersedes_assertion_id, pinned,
        attributes_json, created_at_utc, updated_at_utc
      ) VALUES (?, ?, 'shared_key', 'nod_s', 'HAS_CONSTRAINT', 'literal', NULL, 'string',
        '"no meetings before noon"', 'no meetings before noon', NULL, ?, 'explicit_user_statement',
        0.9, 'personal', NULL, NULL, ?, ?, ?, NULL, NULL, 0, '{}', ?, ?)
    `);
    insert.run('ast_1', LOCAL_OWNER_ID, 'active', STAMP, STAMP, STAMP, STAMP, STAMP);
    assert.throws(
      () => insert.run('ast_2', LOCAL_OWNER_ID, 'active', STAMP, STAMP, STAMP, STAMP, STAMP),
      /UNIQUE constraint failed/u,
    );
    // A superseded row with the same key is permitted, because the index is partial.
    insert.run('ast_3', LOCAL_OWNER_ID, 'superseded', STAMP, STAMP, STAMP, STAMP, STAMP);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- assistant-migration`
Expected: FAIL — `Cannot find module '../src/assistant/storage/schema.js'`

- [ ] **Step 4: Write `src/assistant/storage/schema.ts`**

```ts
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import { NODE_TYPES, NODE_TYPE_DEFINITIONS } from '../domain/node-types.js';
import { RELATION_TYPES, RELATION_DEFINITIONS } from '../domain/relation-types.js';

export const LOCAL_OWNER_ID = 'own_local';
export const LOCAL_OWNER_DISPLAY_NAME = 'Local User';
export const LOCAL_DEVICE_ID = 'dev_local';
export const LOCAL_DEVICE_DISPLAY_NAME = 'Local Device';
export const LOCAL_DEVICE_PLATFORM = 'local';

export const ASSISTANT_CORE_TABLES = [
  'assistant_owners',
  'assistant_devices',
  'graph_node_types',
  'graph_relation_types',
  'graph_nodes',
  'graph_node_aliases',
  'evidence_blobs',
  'evidence_records',
  'observations',
  'candidate_assertions',
  'graph_assertions',
  'assertion_evidence',
  'graph_entity_merges',
  'graph_mutation_log',
  'assistant_policies',
  'assistant_audit_events',
] as const;

export const ASSISTANT_SEARCH_TABLES = [
  'graph_nodes_fts',
  'graph_assertions_fts',
  'memory_projections_fts',
] as const;

export function applyAssistantCoreSchema(database: RuntimeDatabase): void {
  database.exec(`
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
    CREATE INDEX IF NOT EXISTS graph_nodes_owner_type_idx
      ON graph_nodes(owner_id, type, status);

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
    CREATE UNIQUE INDEX IF NOT EXISTS graph_node_aliases_node_alias_uq
      ON graph_node_aliases(owner_id, node_id, normalized_alias);

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
    CREATE INDEX IF NOT EXISTS graph_entity_merges_source_idx
      ON graph_entity_merges(owner_id, source_node_id, reversed_at_utc);

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
    CREATE INDEX IF NOT EXISTS assistant_audit_events_time_idx
      ON assistant_audit_events(owner_id, created_at_utc);
  `);
}

export function applyAssistantSearchSchema(database: RuntimeDatabase): void {
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS graph_nodes_fts USING fts5(
      node_id UNINDEXED, owner_id UNINDEXED,
      display_name, aliases, description, tokenize = 'unicode61');

    CREATE VIRTUAL TABLE IF NOT EXISTS graph_assertions_fts USING fts5(
      assertion_id UNINDEXED, owner_id UNINDEXED,
      subject_text, predicate_text, object_text, scope_text, tokenize = 'unicode61');

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_projections_fts USING fts5(
      projection_id UNINDEXED, owner_id UNINDEXED, tier UNINDEXED,
      topic_key, content, tokenize = 'unicode61');
  `);
}

// The TypeScript registries are the single source of truth; these rows are their projection.
// Re-running replaces definitions in place so a registry edit ships with its migration.
export function seedAssistantRegistries(database: RuntimeDatabase, nowUtc: string): void {
  const insertOwner = database.prepare(`
    INSERT INTO assistant_owners (id, display_name, created_at_utc, updated_at_utc)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);
  const insertDevice = database.prepare(`
    INSERT INTO assistant_devices (
      id, owner_id, platform, display_name, public_key, status, created_at_utc, updated_at_utc
    ) VALUES (?, ?, ?, ?, NULL, 'active', ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);
  const insertNodeType = database.prepare(`
    INSERT INTO graph_node_types (name, definition, created_at_utc)
    VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET definition = excluded.definition
  `);
  const insertRelationType = database.prepare(`
    INSERT INTO graph_relation_types (name, definition_json, created_at_utc, updated_at_utc)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      definition_json = excluded.definition_json,
      updated_at_utc = excluded.updated_at_utc
  `);

  const seed = database.transaction(() => {
    insertOwner.run(LOCAL_OWNER_ID, LOCAL_OWNER_DISPLAY_NAME, nowUtc, nowUtc);
    insertDevice.run(
      LOCAL_DEVICE_ID,
      LOCAL_OWNER_ID,
      LOCAL_DEVICE_PLATFORM,
      LOCAL_DEVICE_DISPLAY_NAME,
      nowUtc,
      nowUtc,
    );
    for (const nodeType of NODE_TYPES) {
      insertNodeType.run(nodeType, NODE_TYPE_DEFINITIONS[nodeType], nowUtc);
    }
    for (const predicate of RELATION_TYPES) {
      insertRelationType.run(predicate, JSON.stringify(RELATION_DEFINITIONS[predicate]), nowUtc, nowUtc);
    }
  });
  seed();
}
```

- [ ] **Step 5: Wire the ladder step into `src/state/runtime-db.ts`**

Add the import beside the existing imports at the top of the file:

```ts
import {
  applyAssistantCoreSchema,
  applyAssistantSearchSchema,
  seedAssistantRegistries,
} from '../assistant/storage/schema.js';
```

Change line 37 to:

```ts
export const CURRENT_SCHEMA_VERSION = 40;
```

Add this helper immediately above `ensureSchema`:

```ts
function ensureAssistantSchema(database: RuntimeDatabase): void {
  applyAssistantCoreSchema(database);
  seedAssistantRegistries(database, new Date().toISOString());
}
```

In the fresh-database branch (currently lines 985-993), add the calls before `setSchemaVersion`:

```ts
  if (currentVersion <= 0) {
    applyBaseSchema(database);
    ensureChatMessageTimelineSchema(database);
    ensureInferenceRunAndBenchmarkMatrixSchema(database);
    ensureDashboardBenchmarkSchema(database);
    ensureRuntimeErrorEventsSchema(database);
    ensureAssistantSchema(database);
    applyAssistantSearchSchema(database);
    setSchemaVersion(database, CURRENT_SCHEMA_VERSION);
    return;
  }
```

Append the v39 step immediately after the existing v38 step (after line 1423):

```ts
  if (currentVersion < 39) {
    ensureAssistantSchema(database);
    setSchemaVersion(database, 39);
    currentVersion = 39;
  }
```

- [ ] **Step 6: Run test to confirm the v39 behaviour**

Run: `npm test -- assistant-migration`
Expected: seven of the eight tests PASS. `current schema version is 40 after the two assistant steps` still FAILS with `Expected values to be strictly equal: 39 !== 40` because Task 7 has not run. Do not "fix" it here.

- [ ] **Step 7: Commit**

```bash
git add src/assistant/storage/schema.ts src/state/runtime-db.ts tests/assistant-migration.test.ts tests/helpers/assistant-fixture.ts
git commit -m "feat(assistant): add migration step v39 with assistant core tables and registry seeding"
```

---

## Task 7: Migration step v40 — FTS5 virtual tables

**Files:**
- Modify: `src/state/runtime-db.ts` (`CURRENT_SCHEMA_VERSION`, ladder tail)
- Modify: `tests/assistant-migration.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/assistant-migration.test.ts`. Extend the existing schema import at the top of the file to add `ASSISTANT_SEARCH_TABLES` and `applyAssistantSearchSchema`, then add:

```ts
test('fts5 is compiled in and every assistant search table exists', () => {
  withAssistantRepo(({ database }) => {
    const names = tableNames(database);
    for (const table of ASSISTANT_SEARCH_TABLES) {
      assert.ok(names.includes(table), `missing assistant fts table ${table}`);
    }
  });
});

test('assistant fts tables tokenize and match on inserted content', () => {
  withAssistantRepo(({ database }) => {
    database.prepare(`
      INSERT INTO graph_nodes_fts (node_id, owner_id, display_name, aliases, description)
      VALUES ('nod_1', ?, 'Visual Studio Code', 'vscode code', 'Primary editor')
    `).run(LOCAL_OWNER_ID);
    const hits = database.prepare(
      "SELECT node_id FROM graph_nodes_fts WHERE graph_nodes_fts MATCH 'vscode'",
    ).all();
    assert.equal(hits.length, 1);
    assert.equal(z.object({ node_id: z.string() }).parse(hits[0]).node_id, 'nod_1');
  });
});

test('re-applying the assistant search schema is idempotent', () => {
  withAssistantRepo(({ database }) => {
    applyAssistantSearchSchema(database);
    applyAssistantSearchSchema(database);
    const names = tableNames(database);
    for (const table of ASSISTANT_SEARCH_TABLES) {
      assert.ok(names.includes(table), `missing assistant fts table ${table}`);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- assistant-migration`
Expected: FAIL — the schema-version assertion still fails, and on an upgraded database the FTS tables are absent.

- [ ] **Step 3: Add the v40 ladder step in `src/state/runtime-db.ts`**

Append immediately after the v39 step:

```ts
  if (currentVersion < 40) {
    applyAssistantSearchSchema(database);
    setSchemaVersion(database, 40);
    currentVersion = 40;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- assistant-migration`
Expected: PASS — 11 tests

- [ ] **Step 5: Run the full suite to prove the ladder change breaks nothing**

Run: `npm test`
Expected: PASS — the pre-existing suite is unaffected.

- [ ] **Step 6: Commit**

```bash
git add src/state/runtime-db.ts tests/assistant-migration.test.ts
git commit -m "feat(assistant): add migration step v40 with assistant FTS5 virtual tables"
```

---

## Task 8: Evidence key provider, blob cipher, and content-addressed paths

Design §5.6, §13.4, §17.1 (path traversal). Raw evidence blobs are always encrypted; tamper is a hard read error, never a silent fallback. Paths derive from the content hash only, and any path escaping the evidence root is rejected before read or write.

**Files:**
- Create: `src/assistant/storage/key-provider.ts`
- Create: `src/assistant/storage/blob-crypto.ts`
- Create: `src/assistant/storage/evidence-paths.ts`
- Test: `tests/assistant-blob-crypto.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/assistant-blob-crypto.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  AssistantKeyProvider,
  InMemoryKeyProvider,
  LocalFileKeyProvider,
} from '../src/assistant/storage/key-provider.js';
import { AssistantBlobCipher } from '../src/assistant/storage/blob-crypto.js';
import {
  assistantEvidenceRoot,
  resolveEvidenceBlobPath,
  evidenceStorageUri,
} from '../src/assistant/storage/evidence-paths.js';
import { computeBytesContentHash } from '../src/assistant/domain/keys.js';
import { withAssistantRepo } from './helpers/assistant-fixture.js';

const PLAINTEXT = Buffer.from('a screenshot of a terminal window', 'utf8');

test('in-memory key provider returns a stable 32-byte key for its active id', () => {
  const keys = new InMemoryKeyProvider();
  assert.ok(keys instanceof AssistantKeyProvider);
  const keyId = keys.getActiveKeyId();
  assert.equal(keys.getKey(keyId).length, 32);
  assert.deepEqual(keys.getKey(keyId), keys.getKey(keyId));
});

test('in-memory key provider rejects an unknown key id', () => {
  const keys = new InMemoryKeyProvider();
  assert.throws(() => keys.getKey('key_missing'), /Unknown assistant evidence key: key_missing/u);
});

test('local file key provider creates the key once and reuses it', () => {
  withAssistantRepo(({ runtimeRoot }) => {
    const first = new LocalFileKeyProvider(runtimeRoot);
    const keyId = first.getActiveKeyId();
    const keyBytes = first.getKey(keyId);
    assert.equal(keyBytes.length, 32);

    const second = new LocalFileKeyProvider(runtimeRoot);
    assert.equal(second.getActiveKeyId(), keyId);
    assert.deepEqual(second.getKey(keyId), keyBytes);

    const keyPath = path.join(runtimeRoot, 'assistant', 'keys', `${keyId}.key`);
    assert.ok(fs.existsSync(keyPath));
  });
});

test('encrypt and decrypt round-trip the exact plaintext', () => {
  const cipher = new AssistantBlobCipher(new InMemoryKeyProvider());
  const envelope = cipher.encrypt(PLAINTEXT);
  assert.equal(envelope.version, 1);
  assert.equal(envelope.algorithm, 'AES-256-GCM');
  assert.equal(envelope.plaintextSha256, computeBytesContentHash(PLAINTEXT));
  assert.notDeepEqual(envelope.ciphertext, PLAINTEXT);
  assert.deepEqual(cipher.decrypt(envelope), PLAINTEXT);
});

test('two encryptions of the same plaintext use different ivs', () => {
  const cipher = new AssistantBlobCipher(new InMemoryKeyProvider());
  assert.notEqual(cipher.encrypt(PLAINTEXT).iv, cipher.encrypt(PLAINTEXT).iv);
});

test('serialize and deserialize round-trip an envelope through bytes', () => {
  const cipher = new AssistantBlobCipher(new InMemoryKeyProvider());
  const envelope = cipher.encrypt(PLAINTEXT);
  const restored = cipher.deserialize(cipher.serialize(envelope));
  assert.deepEqual(restored, envelope);
  assert.deepEqual(cipher.decrypt(restored), PLAINTEXT);
});

test('a tampered auth tag is a hard read error', () => {
  const cipher = new AssistantBlobCipher(new InMemoryKeyProvider());
  const envelope = cipher.encrypt(PLAINTEXT);
  const tampered = { ...envelope, authTag: Buffer.alloc(16, 7).toString('base64') };
  assert.throws(() => cipher.decrypt(tampered), /Assistant evidence blob failed authentication/u);
});

test('tampered ciphertext is a hard read error', () => {
  const cipher = new AssistantBlobCipher(new InMemoryKeyProvider());
  const envelope = cipher.encrypt(PLAINTEXT);
  const bytes = Buffer.from(envelope.ciphertext);
  bytes[0] = bytes[0] ^ 0xff;
  assert.throws(
    () => cipher.decrypt({ ...envelope, ciphertext: bytes }),
    /Assistant evidence blob failed authentication/u,
  );
});

test('a plaintext hash mismatch is a hard read error', () => {
  const cipher = new AssistantBlobCipher(new InMemoryKeyProvider());
  const envelope = cipher.encrypt(PLAINTEXT);
  assert.throws(
    () => cipher.decrypt({ ...envelope, plaintextSha256: 'f'.repeat(64) }),
    /Assistant evidence blob hash mismatch/u,
  );
});

test('a corrupt serialized header is rejected', () => {
  const cipher = new AssistantBlobCipher(new InMemoryKeyProvider());
  assert.throws(
    () => cipher.deserialize(Buffer.from('not-an-envelope', 'utf8')),
    /Malformed assistant evidence blob envelope/u,
  );
});

test('blob paths are content addressed under the evidence root', () => {
  withAssistantRepo(({ runtimeRoot }) => {
    const contentHash = computeBytesContentHash(PLAINTEXT);
    const root = assistantEvidenceRoot(runtimeRoot);
    const blobPath = resolveEvidenceBlobPath(runtimeRoot, contentHash);
    assert.equal(blobPath, path.join(root, contentHash.slice(0, 2), contentHash));
    assert.equal(evidenceStorageUri(contentHash), `assistant-evidence://${contentHash}`);
  });
});

test('a non-hash storage reference is rejected before any file access', () => {
  withAssistantRepo(({ runtimeRoot }) => {
    for (const bad of ['../escape', 'AABB', 'zz'.repeat(32), '', 'a'.repeat(63)]) {
      assert.throws(
        () => resolveEvidenceBlobPath(runtimeRoot, bad),
        /Invalid assistant evidence content hash/u,
        `expected rejection for ${bad}`,
      );
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- assistant-blob-crypto`
Expected: FAIL — `Cannot find module '../src/assistant/storage/key-provider.js'`

- [ ] **Step 3: Write `src/assistant/storage/key-provider.ts`**

```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ensureDirectory } from '../../lib/fs.js';

export const ASSISTANT_KEY_BYTE_LENGTH = 32;

export abstract class AssistantKeyProvider {
  abstract getActiveKeyId(): string;
  abstract getKey(keyId: string): Buffer;
}

// Used by tests and by any in-process flow that must not touch disk.
export class InMemoryKeyProvider extends AssistantKeyProvider {
  private readonly activeKeyId: string;
  private readonly keysById = new Map<string, Buffer>();

  constructor(activeKeyId = 'key_in_memory') {
    super();
    this.activeKeyId = activeKeyId;
    this.keysById.set(activeKeyId, randomBytes(ASSISTANT_KEY_BYTE_LENGTH));
  }

  getActiveKeyId(): string {
    return this.activeKeyId;
  }

  getKey(keyId: string): Buffer {
    const key = this.keysById.get(keyId);
    if (!key) {
      throw new Error(`Unknown assistant evidence key: ${keyId}`);
    }
    return key;
  }
}

// The headless provider. SiftKit must work with no Tauri shell installed, so the key lives in a
// file under the runtime root. Gate D adds a keychain-backed provider as a sibling implementation.
export class LocalFileKeyProvider extends AssistantKeyProvider {
  private static readonly ACTIVE_KEY_ID = 'key_local_v1';
  private readonly keysDirectory: string;
  private cachedKey: Buffer | null = null;

  constructor(runtimeRoot: string) {
    super();
    this.keysDirectory = join(runtimeRoot, 'assistant', 'keys');
  }

  getActiveKeyId(): string {
    return LocalFileKeyProvider.ACTIVE_KEY_ID;
  }

  getKey(keyId: string): Buffer {
    if (keyId !== LocalFileKeyProvider.ACTIVE_KEY_ID) {
      throw new Error(`Unknown assistant evidence key: ${keyId}`);
    }
    if (this.cachedKey) {
      return this.cachedKey;
    }
    ensureDirectory(this.keysDirectory);
    const keyPath = join(this.keysDirectory, `${keyId}.key`);
    if (!existsSync(keyPath)) {
      writeFileSync(keyPath, randomBytes(ASSISTANT_KEY_BYTE_LENGTH), { mode: 0o600 });
    }
    const keyBytes = readFileSync(keyPath);
    if (keyBytes.length !== ASSISTANT_KEY_BYTE_LENGTH) {
      throw new Error(`Assistant evidence key ${keyId} has an invalid length: ${String(keyBytes.length)}`);
    }
    this.cachedKey = keyBytes;
    return keyBytes;
  }
}
```

- [ ] **Step 4: Write `src/assistant/storage/blob-crypto.ts`**

```ts
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from '../../lib/zod.js';
import { computeBytesContentHash } from '../domain/keys.js';
import type { AssistantKeyProvider } from './key-provider.js';

const IV_BYTE_LENGTH = 12;
const AUTH_TAG_BYTE_LENGTH = 16;
const ENVELOPE_SEPARATOR = 0x0a;

export const EncryptedBlobHeaderSchema = z.object({
  version: z.literal(1),
  algorithm: z.literal('AES-256-GCM'),
  keyId: z.string().min(1),
  iv: z.string().min(1),
  authTag: z.string().min(1),
  plaintextSha256: z.string().regex(/^[0-9a-f]{64}$/u),
});
export type EncryptedBlobHeader = z.infer<typeof EncryptedBlobHeaderSchema>;

export interface EncryptedBlobEnvelope extends EncryptedBlobHeader {
  ciphertext: Buffer;
}

export class AssistantBlobCipher {
  constructor(private readonly keys: AssistantKeyProvider) {}

  encrypt(plaintext: Buffer): EncryptedBlobEnvelope {
    const keyId = this.keys.getActiveKeyId();
    const iv = randomBytes(IV_BYTE_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', this.keys.getKey(keyId), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      version: 1,
      algorithm: 'AES-256-GCM',
      keyId,
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      plaintextSha256: computeBytesContentHash(plaintext),
      ciphertext,
    };
  }

  decrypt(envelope: EncryptedBlobEnvelope): Buffer {
    const authTag = Buffer.from(envelope.authTag, 'base64');
    if (authTag.length !== AUTH_TAG_BYTE_LENGTH) {
      throw new Error('Assistant evidence blob failed authentication: malformed auth tag');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.keys.getKey(envelope.keyId),
      Buffer.from(envelope.iv, 'base64'),
    );
    decipher.setAuthTag(authTag);
    let plaintext: Buffer;
    try {
      plaintext = Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
    } catch {
      throw new Error('Assistant evidence blob failed authentication');
    }
    const actualHash = Buffer.from(computeBytesContentHash(plaintext), 'utf8');
    const expectedHash = Buffer.from(envelope.plaintextSha256, 'utf8');
    if (actualHash.length !== expectedHash.length || !timingSafeEqual(actualHash, expectedHash)) {
      throw new Error('Assistant evidence blob hash mismatch');
    }
    return plaintext;
  }

  // On-disk layout: one JSON header line, a newline, then raw ciphertext bytes.
  serialize(envelope: EncryptedBlobEnvelope): Buffer {
    const header: EncryptedBlobHeader = {
      version: envelope.version,
      algorithm: envelope.algorithm,
      keyId: envelope.keyId,
      iv: envelope.iv,
      authTag: envelope.authTag,
      plaintextSha256: envelope.plaintextSha256,
    };
    return Buffer.concat([
      Buffer.from(JSON.stringify(header), 'utf8'),
      Buffer.from([ENVELOPE_SEPARATOR]),
      envelope.ciphertext,
    ]);
  }

  deserialize(bytes: Buffer): EncryptedBlobEnvelope {
    const separatorIndex = bytes.indexOf(ENVELOPE_SEPARATOR);
    if (separatorIndex <= 0) {
      throw new Error('Malformed assistant evidence blob envelope: missing header separator');
    }
    const headerResult = EncryptedBlobHeaderSchema.safeParse(
      JSON.parse(bytes.subarray(0, separatorIndex).toString('utf8')),
    );
    if (!headerResult.success) {
      throw new Error(`Malformed assistant evidence blob envelope: ${headerResult.error.message}`);
    }
    return { ...headerResult.data, ciphertext: bytes.subarray(separatorIndex + 1) };
  }
}
```

Note: `deserialize` must not let a `JSON.parse` throw escape with the wrong message. Wrap the parse:

```ts
  private static parseHeaderText(headerText: string): EncryptedBlobHeader {
    let parsed: unknown;
    try {
      parsed = JSON.parse(headerText);
    } catch {
      throw new Error('Malformed assistant evidence blob envelope: header is not JSON');
    }
    const result = EncryptedBlobHeaderSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`Malformed assistant evidence blob envelope: ${result.error.message}`);
    }
    return result.data;
  }
```

and call `AssistantBlobCipher.parseHeaderText(...)` from `deserialize` instead of inlining the parse.

- [ ] **Step 5: Write `src/assistant/storage/evidence-paths.ts`**

```ts
import { join, resolve, sep } from 'node:path';

const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/u;
export const EVIDENCE_URI_SCHEME = 'assistant-evidence';

export function assistantEvidenceRoot(runtimeRoot: string): string {
  return join(runtimeRoot, 'assistant', 'evidence');
}

export function evidenceStorageUri(contentHash: string): string {
  assertContentHash(contentHash);
  return `${EVIDENCE_URI_SCHEME}://${contentHash}`;
}

export function contentHashFromStorageUri(storageUri: string): string {
  const prefix = `${EVIDENCE_URI_SCHEME}://`;
  if (!storageUri.startsWith(prefix)) {
    throw new Error(`Invalid assistant evidence storage uri: ${storageUri}`);
  }
  const contentHash = storageUri.slice(prefix.length);
  assertContentHash(contentHash);
  return contentHash;
}

function assertContentHash(contentHash: string): void {
  if (!CONTENT_HASH_PATTERN.test(contentHash)) {
    throw new Error(`Invalid assistant evidence content hash: ${contentHash}`);
  }
}

// Paths derive from the content hash alone. The containment check is belt-and-braces: the hash
// pattern already forbids separators and dot segments, and this rejects anything that still escapes.
export function resolveEvidenceBlobPath(runtimeRoot: string, contentHash: string): string {
  assertContentHash(contentHash);
  const root = resolve(assistantEvidenceRoot(runtimeRoot));
  const blobPath = resolve(join(root, contentHash.slice(0, 2), contentHash));
  if (blobPath !== root && !blobPath.startsWith(`${root}${sep}`)) {
    throw new Error(`Assistant evidence path escapes the evidence root: ${blobPath}`);
  }
  return blobPath;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- assistant-blob-crypto`
Expected: PASS — 12 tests

- [ ] **Step 7: Commit**

```bash
git add src/assistant/storage/key-provider.ts src/assistant/storage/blob-crypto.ts src/assistant/storage/evidence-paths.ts tests/assistant-blob-crypto.test.ts
git commit -m "feat(assistant): add encrypted evidence blob cipher, key provider and content-addressed paths"
```

---

## Task 9: Evidence store

Design §7.1 (idempotency via `sourceEventId`, blob dedupe), §4.7 (`secret_prohibited` is discarded, never written), §16.1 (evidence deletion purges the blob).

**Files:**
- Create: `src/assistant/storage/rows.ts`
- Create: `src/assistant/storage/evidence-store.ts`
- Test: `tests/assistant-evidence-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/assistant-evidence-store.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AssistantEvidenceStore } from '../src/assistant/storage/evidence-store.js';
import { InMemoryKeyProvider } from '../src/assistant/storage/key-provider.js';
import { AssistantBlobCipher } from '../src/assistant/storage/blob-crypto.js';
import { resolveEvidenceBlobPath } from '../src/assistant/storage/evidence-paths.js';
import { LOCAL_OWNER_ID, LOCAL_DEVICE_ID } from '../src/assistant/storage/schema.js';
import { FixedAssistantClock } from '../src/assistant/runtime/clock.js';
import { SequentialAssistantIdGenerator } from '../src/assistant/runtime/ids.js';
import { computeTextContentHash, computeBytesContentHash } from '../src/assistant/domain/keys.js';
import { withAssistantRepo, type AssistantFixtureContext } from './helpers/assistant-fixture.js';

function buildStore(context: AssistantFixtureContext): AssistantEvidenceStore {
  return new AssistantEvidenceStore(
    context.database,
    new FixedAssistantClock('2026-08-04T10:00:00.000Z'),
    new SequentialAssistantIdGenerator(),
    new AssistantBlobCipher(new InMemoryKeyProvider()),
    context.runtimeRoot,
  );
}

const TEXT_INPUT = {
  ownerId: LOCAL_OWNER_ID,
  deviceId: null,
  sourceEventId: 'chat:session-1:message-1',
  parentEvidenceId: null,
  sourceType: 'conversation_message',
  sourceRef: 'session-1/message-1',
  capturedAtUtc: '2026-08-04T09:59:00.000Z',
  sourceTimezone: 'Europe/Berlin',
  sensitivity: 'personal',
  retentionUntilUtc: null,
  metadata: { role: 'user' },
  payload: { kind: 'text', text: 'I use PowerShell on Windows.' },
} as const;

test('text evidence is recorded with a normalized content hash', () => {
  withAssistantRepo((context) => {
    const store = buildStore(context);
    const record = store.recordEvidence(TEXT_INPUT);
    assert.equal(record.id, 'evd_000001');
    assert.equal(record.ownerId, LOCAL_OWNER_ID);
    assert.equal(record.sourceType, 'conversation_message');
    assert.equal(record.status, 'active');
    assert.equal(record.blobId, null);
    assert.equal(record.ingestedAtUtc, '2026-08-04T10:00:00.000Z');
    assert.equal(record.contentHash, computeTextContentHash('I use PowerShell on Windows.'));
    assert.deepEqual(record.metadata, { role: 'user' });
  });
});

test('re-ingesting the same source event id is a no-op that returns the original record', () => {
  withAssistantRepo((context) => {
    const store = buildStore(context);
    const first = store.recordEvidence(TEXT_INPUT);
    const second = store.recordEvidence({ ...TEXT_INPUT, payload: { kind: 'text', text: 'different' } });
    assert.equal(second.id, first.id);
    assert.equal(second.contentHash, first.contentHash);
    assert.equal(store.countEvidence(LOCAL_OWNER_ID), 1);
  });
});

test('secret_prohibited evidence is discarded and never written', () => {
  withAssistantRepo((context) => {
    const store = buildStore(context);
    assert.throws(
      () => store.recordEvidence({ ...TEXT_INPUT, sensitivity: 'secret_prohibited' }),
      /Refusing to persist secret_prohibited evidence/u,
    );
    assert.equal(store.countEvidence(LOCAL_OWNER_ID), 0);
  });
});

test('blob evidence is encrypted on disk and decrypts back to the original bytes', () => {
  withAssistantRepo((context) => {
    const store = buildStore(context);
    const bytes = Buffer.from('PNG-ish screenshot bytes', 'utf8');
    const record = store.recordEvidence({
      ...TEXT_INPUT,
      sourceEventId: 'capture:1',
      sourceType: 'screenshot',
      payload: { kind: 'blob', bytes, mimeType: 'image/png' },
    });
    assert.equal(record.contentHash, computeBytesContentHash(bytes));
    assert.notEqual(record.blobId, null);

    const blobPath = resolveEvidenceBlobPath(context.runtimeRoot, record.contentHash);
    assert.ok(fs.existsSync(blobPath));
    assert.ok(!fs.readFileSync(blobPath).includes(bytes), 'plaintext must not appear on disk');
    assert.deepEqual(store.readBlobBytes(record.id), bytes);
  });
});

test('two evidence records may share one deduplicated blob', () => {
  withAssistantRepo((context) => {
    const store = buildStore(context);
    const bytes = Buffer.from('identical screen', 'utf8');
    const first = store.recordEvidence({
      ...TEXT_INPUT,
      sourceEventId: 'capture:1',
      sourceType: 'screenshot',
      payload: { kind: 'blob', bytes, mimeType: 'image/png' },
    });
    const second = store.recordEvidence({
      ...TEXT_INPUT,
      sourceEventId: 'capture:2',
      sourceType: 'screenshot',
      capturedAtUtc: '2026-08-04T10:05:00.000Z',
      payload: { kind: 'blob', bytes, mimeType: 'image/png' },
    });
    assert.notEqual(first.id, second.id);
    assert.equal(first.blobId, second.blobId);
    assert.equal(store.countBlobs(LOCAL_OWNER_ID), 1);
  });
});

test('json evidence hashes its canonical form so key order does not matter', () => {
  withAssistantRepo((context) => {
    const store = buildStore(context);
    const first = store.recordEvidence({
      ...TEXT_INPUT,
      sourceEventId: 'activity:1',
      sourceType: 'desktop_activity',
      payload: { kind: 'json', value: { app: 'code', idleSeconds: 0 } },
    });
    const second = store.recordEvidence({
      ...TEXT_INPUT,
      sourceEventId: 'activity:2',
      sourceType: 'desktop_activity',
      payload: { kind: 'json', value: { idleSeconds: 0, app: 'code' } },
    });
    assert.equal(first.contentHash, second.contentHash);
  });
});

test('reading a missing evidence record returns null and reading its blob throws', () => {
  withAssistantRepo((context) => {
    const store = buildStore(context);
    assert.equal(store.readEvidence('evd_missing'), null);
    assert.throws(() => store.readBlobBytes('evd_missing'), /Unknown evidence record: evd_missing/u);
  });
});

test('text evidence has no blob to read', () => {
  withAssistantRepo((context) => {
    const store = buildStore(context);
    const record = store.recordEvidence(TEXT_INPUT);
    assert.throws(
      () => store.readBlobBytes(record.id),
      /Evidence record evd_000001 has no blob/u,
    );
  });
});

test('deleting evidence purges the blob file and marks the record deleted', () => {
  withAssistantRepo((context) => {
    const store = buildStore(context);
    const bytes = Buffer.from('to be purged', 'utf8');
    const record = store.recordEvidence({
      ...TEXT_INPUT,
      sourceEventId: 'capture:1',
      sourceType: 'screenshot',
      payload: { kind: 'blob', bytes, mimeType: 'image/png' },
    });
    const blobPath = resolveEvidenceBlobPath(context.runtimeRoot, record.contentHash);
    assert.ok(fs.existsSync(blobPath));

    store.deleteEvidence(record.id);

    assert.ok(!fs.existsSync(blobPath));
    const deleted = store.readEvidence(record.id);
    assert.notEqual(deleted, null);
    assert.equal(deleted?.status, 'deleted');
    assert.equal(deleted?.blobId, null);
  });
});

test('a shared blob survives deletion of one of its evidence records', () => {
  withAssistantRepo((context) => {
    const store = buildStore(context);
    const bytes = Buffer.from('shared', 'utf8');
    const first = store.recordEvidence({
      ...TEXT_INPUT,
      sourceEventId: 'capture:1',
      sourceType: 'screenshot',
      payload: { kind: 'blob', bytes, mimeType: 'image/png' },
    });
    const second = store.recordEvidence({
      ...TEXT_INPUT,
      sourceEventId: 'capture:2',
      sourceType: 'screenshot',
      payload: { kind: 'blob', bytes, mimeType: 'image/png' },
    });
    store.deleteEvidence(first.id);
    assert.deepEqual(store.readBlobBytes(second.id), bytes);
    assert.ok(fs.existsSync(resolveEvidenceBlobPath(context.runtimeRoot, second.contentHash)));
  });
});

test('evidence status transitions are recorded', () => {
  withAssistantRepo((context) => {
    const store = buildStore(context);
    const record = store.recordEvidence(TEXT_INPUT);
    store.setEvidenceStatus(record.id, 'expired');
    assert.equal(store.readEvidence(record.id)?.status, 'expired');
    assert.throws(
      () => store.setEvidenceStatus('evd_missing', 'expired'),
      /Unknown evidence record: evd_missing/u,
    );
  });
});

test('a device id is persisted when supplied', () => {
  withAssistantRepo((context) => {
    const store = buildStore(context);
    const record = store.recordEvidence({ ...TEXT_INPUT, deviceId: LOCAL_DEVICE_ID });
    assert.equal(store.readEvidence(record.id)?.deviceId, LOCAL_DEVICE_ID);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- assistant-evidence-store`
Expected: FAIL — `Cannot find module '../src/assistant/storage/evidence-store.js'`

- [ ] **Step 3: Write `src/assistant/storage/rows.ts`**

```ts
import { z } from '../../lib/zod.js';
import { JsonObjectSchema, type JsonObject } from '../../lib/json-types.js';

// Shared row-level helpers. Every store parses raw better-sqlite3 rows through a zod schema
// before mapping to a domain record, so no cast is ever needed at the SQL boundary.

export function parseJsonObjectColumn(text: string): JsonObject {
  const parsed: unknown = JSON.parse(text);
  return JsonObjectSchema.parse(parsed);
}

export function toSqliteFlag(value: boolean): number {
  return value ? 1 : 0;
}

export function fromSqliteFlag(value: number): boolean {
  return value === 1;
}

export const EvidenceRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  device_id: z.string().nullable(),
  source_event_id: z.string(),
  parent_evidence_id: z.string().nullable(),
  blob_id: z.string().nullable(),
  source_type: z.string(),
  source_ref: z.string().nullable(),
  captured_at_utc: z.string(),
  source_timezone: z.string().nullable(),
  ingested_at_utc: z.string(),
  content_hash: z.string(),
  mime_type: z.string().nullable(),
  sensitivity: z.string(),
  retention_until_utc: z.string().nullable(),
  status: z.string(),
  metadata_json: z.string(),
  created_at_utc: z.string(),
  updated_at_utc: z.string(),
});

export const BlobRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  content_hash: z.string(),
  byte_length: z.number(),
  mime_type: z.string(),
  storage_uri: z.string(),
  encrypted: z.number(),
  key_id: z.string().nullable(),
  created_at_utc: z.string(),
  deleted_at_utc: z.string().nullable(),
});

export const CountRowSchema = z.object({ total: z.number() });
```

- [ ] **Step 4: Write `src/assistant/storage/evidence-store.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from '../../lib/zod.js';
import { type JsonObject, type JsonValue } from '../../lib/json-types.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { AssistantClock } from '../runtime/clock.js';
import { ASSISTANT_ID_PREFIXES, type AssistantIdGenerator } from '../runtime/ids.js';
import {
  EvidenceSourceTypeSchema,
  EvidenceStatusSchema,
  SensitivitySchema,
  type EvidenceSourceType,
  type EvidenceStatus,
  type Sensitivity,
} from '../domain/primitives.js';
import {
  canonicalJsonText,
  computeBytesContentHash,
  computeTextContentHash,
} from '../domain/keys.js';
import type { AssistantBlobCipher } from './blob-crypto.js';
import { evidenceStorageUri, resolveEvidenceBlobPath } from './evidence-paths.js';
import { BlobRowSchema, CountRowSchema, EvidenceRowSchema, parseJsonObjectColumn } from './rows.js';

export type EvidencePayload =
  | { kind: 'text'; text: string }
  | { kind: 'json'; value: JsonValue }
  | { kind: 'blob'; bytes: Buffer; mimeType: string };

export interface RecordEvidenceInput {
  ownerId: string;
  deviceId: string | null;
  sourceEventId: string;
  parentEvidenceId: string | null;
  sourceType: EvidenceSourceType;
  sourceRef: string | null;
  capturedAtUtc: string;
  sourceTimezone: string | null;
  sensitivity: Sensitivity;
  retentionUntilUtc: string | null;
  metadata: JsonObject;
  payload: EvidencePayload;
}

export interface EvidenceRecord {
  id: string;
  ownerId: string;
  deviceId: string | null;
  sourceEventId: string;
  parentEvidenceId: string | null;
  blobId: string | null;
  sourceType: EvidenceSourceType;
  sourceRef: string | null;
  capturedAtUtc: string;
  sourceTimezone: string | null;
  ingestedAtUtc: string;
  contentHash: string;
  mimeType: string | null;
  sensitivity: Sensitivity;
  retentionUntilUtc: string | null;
  status: EvidenceStatus;
  metadata: JsonObject;
  createdAtUtc: string;
  updatedAtUtc: string;
}

const TEXT_MIME_TYPE = 'text/plain';
const JSON_MIME_TYPE = 'application/json';

export class AssistantEvidenceStore {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly clock: AssistantClock,
    private readonly ids: AssistantIdGenerator,
    private readonly cipher: AssistantBlobCipher,
    private readonly runtimeRoot: string,
  ) {}

  recordEvidence(input: RecordEvidenceInput): EvidenceRecord {
    if (input.sensitivity === 'secret_prohibited') {
      throw new Error(
        `Refusing to persist secret_prohibited evidence for source event ${input.sourceEventId}`,
      );
    }
    const existing = this.readEvidenceBySourceEventId(input.ownerId, input.sourceEventId);
    if (existing) {
      return existing;
    }

    const nowUtc = this.clock.nowUtc();
    const contentHash = AssistantEvidenceStore.hashPayload(input.payload);
    const mimeType = AssistantEvidenceStore.mimeTypeFor(input.payload);
    const evidenceId = this.ids.next(ASSISTANT_ID_PREFIXES.evidence);

    const persist = this.database.transaction(() => {
      const blobId = input.payload.kind === 'blob'
        ? this.persistBlob(input.ownerId, contentHash, input.payload.bytes, input.payload.mimeType, nowUtc)
        : null;
      this.database.prepare(`
        INSERT INTO evidence_records (
          id, owner_id, device_id, source_event_id, parent_evidence_id, blob_id, source_type,
          source_ref, captured_at_utc, source_timezone, ingested_at_utc, content_hash, mime_type,
          sensitivity, retention_until_utc, status, metadata_json, created_at_utc, updated_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `).run(
        evidenceId,
        input.ownerId,
        input.deviceId,
        input.sourceEventId,
        input.parentEvidenceId,
        blobId,
        input.sourceType,
        input.sourceRef,
        input.capturedAtUtc,
        input.sourceTimezone,
        nowUtc,
        contentHash,
        mimeType,
        input.sensitivity,
        input.retentionUntilUtc,
        JSON.stringify(input.metadata),
        nowUtc,
        nowUtc,
      );
    });
    persist();

    return this.requireEvidence(evidenceId);
  }

  readEvidence(evidenceId: string): EvidenceRecord | null {
    const rawRow = this.database.prepare(
      'SELECT * FROM evidence_records WHERE id = ? LIMIT 1',
    ).get(evidenceId);
    if (rawRow == null) {
      return null;
    }
    return AssistantEvidenceStore.mapRow(EvidenceRowSchema.parse(rawRow));
  }

  readEvidenceBySourceEventId(ownerId: string, sourceEventId: string): EvidenceRecord | null {
    const rawRow = this.database.prepare(
      'SELECT * FROM evidence_records WHERE owner_id = ? AND source_event_id = ? LIMIT 1',
    ).get(ownerId, sourceEventId);
    if (rawRow == null) {
      return null;
    }
    return AssistantEvidenceStore.mapRow(EvidenceRowSchema.parse(rawRow));
  }

  readBlobBytes(evidenceId: string): Buffer {
    const record = this.requireEvidence(evidenceId);
    if (record.blobId === null) {
      throw new Error(`Evidence record ${evidenceId} has no blob`);
    }
    const rawRow = this.database.prepare(
      'SELECT * FROM evidence_blobs WHERE id = ? LIMIT 1',
    ).get(record.blobId);
    if (rawRow == null) {
      throw new Error(`Unknown evidence blob: ${record.blobId}`);
    }
    const blobRow = BlobRowSchema.parse(rawRow);
    const blobPath = resolveEvidenceBlobPath(this.runtimeRoot, blobRow.content_hash);
    if (!existsSync(blobPath)) {
      throw new Error(`Missing assistant evidence blob file for ${blobRow.content_hash}`);
    }
    return this.cipher.decrypt(this.cipher.deserialize(readFileSync(blobPath)));
  }

  setEvidenceStatus(evidenceId: string, status: EvidenceStatus): void {
    this.requireEvidence(evidenceId);
    this.database.prepare(
      'UPDATE evidence_records SET status = ?, updated_at_utc = ? WHERE id = ?',
    ).run(status, this.clock.nowUtc(), evidenceId);
  }

  // Purges the blob only when no other live evidence record still references it.
  deleteEvidence(evidenceId: string): void {
    const record = this.requireEvidence(evidenceId);
    const nowUtc = this.clock.nowUtc();
    const blobId = record.blobId;

    const purge = this.database.transaction(() => {
      this.database.prepare(`
        UPDATE evidence_records
        SET status = 'deleted', blob_id = NULL, metadata_json = '{}', updated_at_utc = ?
        WHERE id = ?
      `).run(nowUtc, evidenceId);
      if (blobId === null) {
        return;
      }
      const referenceCount = CountRowSchema.parse(this.database.prepare(
        'SELECT COUNT(*) AS total FROM evidence_records WHERE blob_id = ?',
      ).get(blobId)).total;
      if (referenceCount > 0) {
        return;
      }
      const rawRow = this.database.prepare(
        'SELECT * FROM evidence_blobs WHERE id = ? LIMIT 1',
      ).get(blobId);
      if (rawRow == null) {
        return;
      }
      const blobRow = BlobRowSchema.parse(rawRow);
      this.database.prepare('DELETE FROM evidence_blobs WHERE id = ?').run(blobId);
      rmSync(resolveEvidenceBlobPath(this.runtimeRoot, blobRow.content_hash), { force: true });
    });
    purge();
  }

  countEvidence(ownerId: string): number {
    return CountRowSchema.parse(this.database.prepare(
      'SELECT COUNT(*) AS total FROM evidence_records WHERE owner_id = ?',
    ).get(ownerId)).total;
  }

  countBlobs(ownerId: string): number {
    return CountRowSchema.parse(this.database.prepare(
      'SELECT COUNT(*) AS total FROM evidence_blobs WHERE owner_id = ?',
    ).get(ownerId)).total;
  }

  private requireEvidence(evidenceId: string): EvidenceRecord {
    const record = this.readEvidence(evidenceId);
    if (!record) {
      throw new Error(`Unknown evidence record: ${evidenceId}`);
    }
    return record;
  }

  private persistBlob(
    ownerId: string,
    contentHash: string,
    bytes: Buffer,
    mimeType: string,
    nowUtc: string,
  ): string {
    const rawRow = this.database.prepare(
      'SELECT * FROM evidence_blobs WHERE owner_id = ? AND content_hash = ? LIMIT 1',
    ).get(ownerId, contentHash);
    if (rawRow != null) {
      return BlobRowSchema.parse(rawRow).id;
    }
    const blobPath = resolveEvidenceBlobPath(this.runtimeRoot, contentHash);
    mkdirSync(dirname(blobPath), { recursive: true });
    const envelope = this.cipher.encrypt(bytes);
    writeFileSync(blobPath, this.cipher.serialize(envelope), { mode: 0o600 });

    const blobId = this.ids.next(ASSISTANT_ID_PREFIXES.blob);
    this.database.prepare(`
      INSERT INTO evidence_blobs (
        id, owner_id, content_hash, byte_length, mime_type, storage_uri, encrypted, key_id,
        created_at_utc, deleted_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)
    `).run(
      blobId,
      ownerId,
      contentHash,
      bytes.length,
      mimeType,
      evidenceStorageUri(contentHash),
      envelope.keyId,
      nowUtc,
    );
    return blobId;
  }

  private static hashPayload(payload: EvidencePayload): string {
    switch (payload.kind) {
      case 'text':
        return computeTextContentHash(payload.text);
      case 'json':
        return computeTextContentHash(canonicalJsonText(payload.value));
      case 'blob':
        return computeBytesContentHash(payload.bytes);
    }
  }

  private static mimeTypeFor(payload: EvidencePayload): string {
    switch (payload.kind) {
      case 'text':
        return TEXT_MIME_TYPE;
      case 'json':
        return JSON_MIME_TYPE;
      case 'blob':
        return payload.mimeType;
    }
  }

  private static mapRow(row: z.infer<typeof EvidenceRowSchema>): EvidenceRecord {
    return {
      id: row.id,
      ownerId: row.owner_id,
      deviceId: row.device_id,
      sourceEventId: row.source_event_id,
      parentEvidenceId: row.parent_evidence_id,
      blobId: row.blob_id,
      sourceType: EvidenceSourceTypeSchema.parse(row.source_type),
      sourceRef: row.source_ref,
      capturedAtUtc: row.captured_at_utc,
      sourceTimezone: row.source_timezone,
      ingestedAtUtc: row.ingested_at_utc,
      contentHash: row.content_hash,
      mimeType: row.mime_type,
      sensitivity: SensitivitySchema.parse(row.sensitivity),
      retentionUntilUtc: row.retention_until_utc,
      status: EvidenceStatusSchema.parse(row.status),
      metadata: parseJsonObjectColumn(row.metadata_json),
      createdAtUtc: row.created_at_utc,
      updatedAtUtc: row.updated_at_utc,
    };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- assistant-evidence-store`
Expected: PASS — 12 tests

- [ ] **Step 6: Commit**

```bash
git add src/assistant/storage/rows.ts src/assistant/storage/evidence-store.ts tests/assistant-evidence-store.test.ts
git commit -m "feat(assistant): add evidence store with idempotent ingestion and encrypted blobs"
```

---

## Task 10: Node and alias store

Design §5.2, §5.3 (FTS maintained by repository code in the canonical write transaction, no triggers), §9.1 (canonical keys and aliases).

**Files:**
- Create: `src/assistant/storage/node-store.ts`
- Modify: `src/assistant/storage/rows.ts` (append node and alias row schemas)
- Test: `tests/assistant-node-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/assistant-node-store.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphNodeStore } from '../src/assistant/storage/node-store.js';
import { LOCAL_OWNER_ID } from '../src/assistant/storage/schema.js';
import { FixedAssistantClock } from '../src/assistant/runtime/clock.js';
import { SequentialAssistantIdGenerator } from '../src/assistant/runtime/ids.js';
import { withAssistantRepo, type AssistantFixtureContext } from './helpers/assistant-fixture.js';

function buildStore(context: AssistantFixtureContext): GraphNodeStore {
  return new GraphNodeStore(
    context.database,
    new FixedAssistantClock('2026-08-04T10:00:00.000Z'),
    new SequentialAssistantIdGenerator(),
  );
}

const SELF_NODE = {
  ownerId: LOCAL_OWNER_ID,
  type: 'person',
  canonicalKey: 'person:self',
  displayName: 'Denys',
  description: 'The assistant owner.',
  sensitivity: 'personal',
  properties: {},
} as const;

test('a node is created with generated id and timestamps', () => {
  withAssistantRepo((context) => {
    const store = buildStore(context);
    const node = store.createNode(SELF_NODE);
    assert.equal(node.id, 'nod_000001');
    assert.equal(node.type, 'person');
    assert.equal(node.canonicalKey, 'person:self');
    assert.equal(node.status, 'active');
    assert.equal(node.createdAtUtc, '2026-08-04T10:00:00.000Z');
    assert.deepEqual(node.properties, {});
    assert.deepEqual(store.readNode(node.id), node);
  });
});

test('reading a missing node returns null', () => {
  withAssistantRepo((context) => {
    assert.equal(buildStore(context).readNode('nod_missing'), null);
  });
});

test('canonical keys are unique per owner and type', () => {
  withAssistantRepo((context) => {
    const store = buildStore(context);
    store.createNode(SELF_NODE);
    assert.throws(
      () => store.createNode({ ...SELF_NODE, displayName: 'Denys Again' }),
      /UNIQUE constraint failed/u,
    );
    // A different node type may reuse the same key text.
    const topic = store.createNode({ ...SELF_NODE, type: 'topic', displayName: 'Self' });
    assert.equal(topic.type, 'topic');
  });
});

test('a node is found by its canonical key', () => {
  withAssistantRepo((context) => {
    const store = buildStore(context);
    const node = store.createNode(SELF_NODE);
    assert.equal(store.findByCanonicalKey(LOCAL_OWNER_ID, 'person', 'person:self')?.id, node.id);
    assert.equal(store.findByCanonicalKey(LOCAL_OWNER_ID, 'person', 'person:other'), null);
  });
});

test('updating a node changes display fields and bumps updated_at', () => {
  withAssistantRepo((context) => {
    const clock = new FixedAssistantClock('2026-08-04T10:00:00.000Z');
    const store = new GraphNodeStore(context.database, clock, new SequentialAssistantIdGenerator());
    const node = store.createNode(SELF_NODE);
    clock.advanceSeconds(60);
    const updated = store.updateNode(node.id, {
      displayName: 'Denys A.',
      description: null,
      sensitivity: 'sensitive',
      properties: { pronouns: 'they/them' },
    });
    assert.equal(updated.displayName, 'Denys A.');
    assert.equal(updated.description, null);
    assert.equal(updated.sensitivity, 'sensitive');
    assert.deepEqual(updated.properties, { pronouns: 'they/them' });
    assert.equal(updated.updatedAtUtc, '2026-08-04T10:01:00.000Z');
    assert.equal(updated.createdAtUtc, '2026-08-04T10:00:00.000Z');
  });
});

test('updating a missing node throws', () => {
  withAssistantRepo((context) => {
    assert.throws(
      () => buildStore(context).updateNode('nod_missing', {
        displayName: 'x', description: null, sensitivity: 'low', properties: {},
      }),
      /Unknown graph node: nod_missing/u,
    );
  });
});

test('aliases are normalized, deduplicated per node, and resolvable', () => {
  withAssistantRepo((context) => {
    const store = buildStore(context);
    const node = store.createNode({
      ...SELF_NODE, type: 'software', canonicalKey: 'software:visual-studio-code',
      displayName: 'Visual Studio Code', sensitivity: 'low',
    });
    const alias = store.addAlias({
      ownerId: LOCAL_OWNER_ID,
      nodeId: node.id,
      alias: '  VS   Code ',
      aliasType: 'name',
      sourceEvidenceId: null,
    });
    assert.equal(alias.normalizedAlias, 'vs code');

    // Re-adding the same normalized alias is a no-op returning the original row.
    const again = store.addAlias({
      ownerId: LOCAL_OWNER_ID, nodeId: node.id, alias: 'vs code', aliasType: 'user_supplied',
      sourceEvidenceId: null,
    });
    assert.equal(again.id, alias.id);
    assert.equal(again.aliasType, 'name');

    assert.deepEqual(
      store.findNodesByAlias(LOCAL_OWNER_ID, 'VS Code').map((match) => match.id),
      [node.id],
    );
    assert.deepEqual(store.listAliases(node.id).map((entry) => entry.normalizedAlias), ['vs code']);
    assert.deepEqual(store.findNodesByAlias(LOCAL_OWNER_ID, 'emacs'), []);
  });
});

test('alias lookup ignores non-active nodes', () => {
  withAssistantRepo((context) => {
    const store = buildStore(context);
    const node = store.createNode(SELF_NODE);
    store.addAlias({
      ownerId: LOCAL_OWNER_ID, nodeId: node.id, alias: 'Boss', aliasType: 'name',
      sourceEvidenceId: null,
    });
    store.setNodeStatus(node.id, 'archived');
    assert.deepEqual(store.findNodesByAlias(LOCAL_OWNER_ID, 'Boss'), []);
  });
});

test('node fts indexes display name, aliases and description', () => {
  withAssistantRepo((context) => {
    const store = buildStore(context);
    const node = store.createNode({
      ...SELF_NODE, type: 'software', canonicalKey: 'software:visual-studio-code',
      displayName: 'Visual Studio Code', description: 'Primary editor', sensitivity: 'low',
    });
    store.addAlias({
      ownerId: LOCAL_OWNER_ID, nodeId: node.id, alias: 'vscode', aliasType: 'name',
      sourceEvidenceId: null,
    });
    assert.deepEqual(store.searchNodes(LOCAL_OWNER_ID, 'vscode', 10).map((hit) => hit.id), [node.id]);
    assert.deepEqual(store.searchNodes(LOCAL_OWNER_ID, 'editor', 10).map((hit) => hit.id), [node.id]);
    assert.deepEqual(store.searchNodes(LOCAL_OWNER_ID, 'notepad', 10), []);
  });
});

test('node fts reflects a display name update and a deletion', () => {
  withAssistantRepo((context) => {
    const store = buildStore(context);
    const node = store.createNode({
      ...SELF_NODE, type: 'software', canonicalKey: 'software:editor',
      displayName: 'Notepad', description: null, sensitivity: 'low',
    });
    assert.equal(store.searchNodes(LOCAL_OWNER_ID, 'Notepad', 10).length, 1);

    store.updateNode(node.id, {
      displayName: 'Neovim', description: null, sensitivity: 'low', properties: {},
    });
    assert.equal(store.searchNodes(LOCAL_OWNER_ID, 'Notepad', 10).length, 0);
    assert.equal(store.searchNodes(LOCAL_OWNER_ID, 'Neovim', 10).length, 1);

    store.setNodeStatus(node.id, 'deleted');
    assert.equal(store.searchNodes(LOCAL_OWNER_ID, 'Neovim', 10).length, 0);
  });
});

test('search results are capped by the supplied limit', () => {
  withAssistantRepo((context) => {
    const store = buildStore(context);
    for (let index = 0; index < 5; index += 1) {
      store.createNode({
        ...SELF_NODE, type: 'topic', canonicalKey: `topic:memory-${String(index)}`,
        displayName: `memory topic ${String(index)}`, description: null, sensitivity: 'low',
      });
    }
    assert.equal(store.searchNodes(LOCAL_OWNER_ID, 'memory', 3).length, 3);
  });
});

test('listing nodes by type returns only active nodes of that type', () => {
  withAssistantRepo((context) => {
    const store = buildStore(context);
    store.createNode(SELF_NODE);
    const archived = store.createNode({
      ...SELF_NODE, canonicalKey: 'person:colleague', displayName: 'Colleague',
    });
    store.setNodeStatus(archived.id, 'archived');
    store.createNode({
      ...SELF_NODE, type: 'topic', canonicalKey: 'topic:llm', displayName: 'LLMs',
    });
    assert.deepEqual(
      store.listNodesByType(LOCAL_OWNER_ID, 'person').map((node) => node.displayName),
      ['Denys'],
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- assistant-node-store`
Expected: FAIL — `Cannot find module '../src/assistant/storage/node-store.js'`

- [ ] **Step 3: Append row schemas to `src/assistant/storage/rows.ts`**

```ts
export const NodeRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  type: z.string(),
  canonical_key: z.string().nullable(),
  display_name: z.string(),
  description: z.string().nullable(),
  sensitivity: z.string(),
  status: z.string(),
  properties_json: z.string(),
  merged_into_node_id: z.string().nullable(),
  created_at_utc: z.string(),
  updated_at_utc: z.string(),
  deleted_at_utc: z.string().nullable(),
});

export const AliasRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  node_id: z.string(),
  alias: z.string(),
  normalized_alias: z.string(),
  alias_type: z.string(),
  source_evidence_id: z.string().nullable(),
  created_at_utc: z.string(),
});

export const NodeIdRowSchema = z.object({ node_id: z.string() });
```

- [ ] **Step 4: Write `src/assistant/storage/node-store.ts`**

```ts
import { z } from '../../lib/zod.js';
import { type JsonObject } from '../../lib/json-types.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { AssistantClock } from '../runtime/clock.js';
import { ASSISTANT_ID_PREFIXES, type AssistantIdGenerator } from '../runtime/ids.js';
import { NodeTypeSchema, type NodeType } from '../domain/node-types.js';
import {
  AliasTypeSchema,
  NodeStatusSchema,
  SensitivitySchema,
  type AliasType,
  type NodeStatus,
  type Sensitivity,
} from '../domain/primitives.js';
import { normalizeAlias } from '../domain/keys.js';
import { AliasRowSchema, NodeIdRowSchema, NodeRowSchema, parseJsonObjectColumn } from './rows.js';

export interface CreateGraphNodeInput {
  ownerId: string;
  type: NodeType;
  canonicalKey: string | null;
  displayName: string;
  description: string | null;
  sensitivity: Sensitivity;
  properties: JsonObject;
}

export interface UpdateGraphNodeInput {
  displayName: string;
  description: string | null;
  sensitivity: Sensitivity;
  properties: JsonObject;
}

export interface GraphNodeRecord {
  id: string;
  ownerId: string;
  type: NodeType;
  canonicalKey: string | null;
  displayName: string;
  description: string | null;
  sensitivity: Sensitivity;
  status: NodeStatus;
  properties: JsonObject;
  mergedIntoNodeId: string | null;
  createdAtUtc: string;
  updatedAtUtc: string;
  deletedAtUtc: string | null;
}

export interface AddAliasInput {
  ownerId: string;
  nodeId: string;
  alias: string;
  aliasType: AliasType;
  sourceEvidenceId: string | null;
}

export interface GraphNodeAliasRecord {
  id: string;
  ownerId: string;
  nodeId: string;
  alias: string;
  normalizedAlias: string;
  aliasType: AliasType;
  sourceEvidenceId: string | null;
  createdAtUtc: string;
}

// FTS5 query strings are escaped as a single quoted phrase so user text can never inject operators.
function toFtsPhrase(queryText: string): string {
  return `"${queryText.replace(/"/gu, '""')}"`;
}

export class GraphNodeStore {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly clock: AssistantClock,
    private readonly ids: AssistantIdGenerator,
  ) {}

  createNode(input: CreateGraphNodeInput): GraphNodeRecord {
    const nowUtc = this.clock.nowUtc();
    const nodeId = this.ids.next(ASSISTANT_ID_PREFIXES.node);
    const create = this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO graph_nodes (
          id, owner_id, type, canonical_key, display_name, description, sensitivity, status,
          properties_json, merged_into_node_id, created_at_utc, updated_at_utc, deleted_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?, ?, NULL)
      `).run(
        nodeId,
        input.ownerId,
        input.type,
        input.canonicalKey,
        input.displayName,
        input.description,
        input.sensitivity,
        JSON.stringify(input.properties),
        nowUtc,
        nowUtc,
      );
      this.refreshNodeFts(nodeId);
    });
    create();
    return this.requireNode(nodeId);
  }

  readNode(nodeId: string): GraphNodeRecord | null {
    const rawRow = this.database.prepare('SELECT * FROM graph_nodes WHERE id = ? LIMIT 1').get(nodeId);
    if (rawRow == null) {
      return null;
    }
    return GraphNodeStore.mapNodeRow(NodeRowSchema.parse(rawRow));
  }

  findByCanonicalKey(ownerId: string, type: NodeType, canonicalKey: string): GraphNodeRecord | null {
    const rawRow = this.database.prepare(`
      SELECT * FROM graph_nodes
      WHERE owner_id = ? AND type = ? AND canonical_key = ? AND status <> 'deleted'
      LIMIT 1
    `).get(ownerId, type, canonicalKey);
    if (rawRow == null) {
      return null;
    }
    return GraphNodeStore.mapNodeRow(NodeRowSchema.parse(rawRow));
  }

  listNodesByType(ownerId: string, type: NodeType): readonly GraphNodeRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM graph_nodes
      WHERE owner_id = ? AND type = ? AND status = 'active'
      ORDER BY created_at_utc, id
    `).all(ownerId, type);
    return rows.map((row) => GraphNodeStore.mapNodeRow(NodeRowSchema.parse(row)));
  }

  updateNode(nodeId: string, input: UpdateGraphNodeInput): GraphNodeRecord {
    this.requireNode(nodeId);
    const nowUtc = this.clock.nowUtc();
    const update = this.database.transaction(() => {
      this.database.prepare(`
        UPDATE graph_nodes
        SET display_name = ?, description = ?, sensitivity = ?, properties_json = ?, updated_at_utc = ?
        WHERE id = ?
      `).run(
        input.displayName,
        input.description,
        input.sensitivity,
        JSON.stringify(input.properties),
        nowUtc,
        nodeId,
      );
      this.refreshNodeFts(nodeId);
    });
    update();
    return this.requireNode(nodeId);
  }

  setNodeStatus(nodeId: string, status: NodeStatus, mergedIntoNodeId: string | null = null): GraphNodeRecord {
    this.requireNode(nodeId);
    const nowUtc = this.clock.nowUtc();
    const apply = this.database.transaction(() => {
      this.database.prepare(`
        UPDATE graph_nodes
        SET status = ?, merged_into_node_id = ?, updated_at_utc = ?,
            deleted_at_utc = CASE WHEN ? = 'deleted' THEN ? ELSE deleted_at_utc END
        WHERE id = ?
      `).run(status, mergedIntoNodeId, nowUtc, status, nowUtc, nodeId);
      this.refreshNodeFts(nodeId);
    });
    apply();
    return this.requireNode(nodeId);
  }

  addAlias(input: AddAliasInput): GraphNodeAliasRecord {
    this.requireNode(input.nodeId);
    const normalizedAlias = normalizeAlias(input.alias);
    if (!normalizedAlias) {
      throw new Error(`Refusing to store an empty alias for node ${input.nodeId}`);
    }
    const existing = this.database.prepare(`
      SELECT * FROM graph_node_aliases
      WHERE owner_id = ? AND node_id = ? AND normalized_alias = ?
      LIMIT 1
    `).get(input.ownerId, input.nodeId, normalizedAlias);
    if (existing != null) {
      return GraphNodeStore.mapAliasRow(AliasRowSchema.parse(existing));
    }

    const aliasId = this.ids.next(ASSISTANT_ID_PREFIXES.alias);
    const nowUtc = this.clock.nowUtc();
    const insert = this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO graph_node_aliases (
          id, owner_id, node_id, alias, normalized_alias, alias_type, source_evidence_id, created_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        aliasId,
        input.ownerId,
        input.nodeId,
        input.alias.trim(),
        normalizedAlias,
        input.aliasType,
        input.sourceEvidenceId,
        nowUtc,
      );
      this.refreshNodeFts(input.nodeId);
    });
    insert();

    const rawRow = this.database.prepare('SELECT * FROM graph_node_aliases WHERE id = ?').get(aliasId);
    return GraphNodeStore.mapAliasRow(AliasRowSchema.parse(rawRow));
  }

  listAliases(nodeId: string): readonly GraphNodeAliasRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM graph_node_aliases WHERE node_id = ? ORDER BY created_at_utc, id
    `).all(nodeId);
    return rows.map((row) => GraphNodeStore.mapAliasRow(AliasRowSchema.parse(row)));
  }

  findNodesByAlias(ownerId: string, alias: string): readonly GraphNodeRecord[] {
    const rows = this.database.prepare(`
      SELECT nodes.* FROM graph_node_aliases AS aliases
      JOIN graph_nodes AS nodes ON nodes.id = aliases.node_id
      WHERE aliases.owner_id = ? AND aliases.normalized_alias = ? AND nodes.status = 'active'
      ORDER BY nodes.created_at_utc, nodes.id
    `).all(ownerId, normalizeAlias(alias));
    return rows.map((row) => GraphNodeStore.mapNodeRow(NodeRowSchema.parse(row)));
  }

  searchNodes(ownerId: string, queryText: string, limit: number): readonly GraphNodeRecord[] {
    const normalizedQuery = queryText.trim();
    if (!normalizedQuery) {
      return [];
    }
    const rows = this.database.prepare(`
      SELECT node_id FROM graph_nodes_fts
      WHERE graph_nodes_fts MATCH ? AND owner_id = ?
      ORDER BY rank
      LIMIT ?
    `).all(toFtsPhrase(normalizedQuery), ownerId, limit);
    const nodes: GraphNodeRecord[] = [];
    for (const row of rows) {
      const node = this.readNode(NodeIdRowSchema.parse(row).node_id);
      if (node) {
        nodes.push(node);
      }
    }
    return nodes;
  }

  private requireNode(nodeId: string): GraphNodeRecord {
    const node = this.readNode(nodeId);
    if (!node) {
      throw new Error(`Unknown graph node: ${nodeId}`);
    }
    return node;
  }

  // Rewrites the node's FTS row inside the caller's transaction. Non-active nodes are removed
  // from the index entirely so archived, merged, and deleted nodes are unsearchable.
  private refreshNodeFts(nodeId: string): void {
    this.database.prepare('DELETE FROM graph_nodes_fts WHERE node_id = ?').run(nodeId);
    const rawRow = this.database.prepare('SELECT * FROM graph_nodes WHERE id = ? LIMIT 1').get(nodeId);
    if (rawRow == null) {
      return;
    }
    const row = NodeRowSchema.parse(rawRow);
    if (row.status !== 'active') {
      return;
    }
    const aliasText = this.listAliases(nodeId).map((entry) => entry.alias).join(' ');
    this.database.prepare(`
      INSERT INTO graph_nodes_fts (node_id, owner_id, display_name, aliases, description)
      VALUES (?, ?, ?, ?, ?)
    `).run(row.id, row.owner_id, row.display_name, aliasText, row.description ?? '');
  }

  private static mapNodeRow(row: z.infer<typeof NodeRowSchema>): GraphNodeRecord {
    return {
      id: row.id,
      ownerId: row.owner_id,
      type: NodeTypeSchema.parse(row.type),
      canonicalKey: row.canonical_key,
      displayName: row.display_name,
      description: row.description,
      sensitivity: SensitivitySchema.parse(row.sensitivity),
      status: NodeStatusSchema.parse(row.status),
      properties: parseJsonObjectColumn(row.properties_json),
      mergedIntoNodeId: row.merged_into_node_id,
      createdAtUtc: row.created_at_utc,
      updatedAtUtc: row.updated_at_utc,
      deletedAtUtc: row.deleted_at_utc,
    };
  }

  private static mapAliasRow(row: z.infer<typeof AliasRowSchema>): GraphNodeAliasRecord {
    return {
      id: row.id,
      ownerId: row.owner_id,
      nodeId: row.node_id,
      alias: row.alias,
      normalizedAlias: row.normalized_alias,
      aliasType: AliasTypeSchema.parse(row.alias_type),
      sourceEvidenceId: row.source_evidence_id,
      createdAtUtc: row.created_at_utc,
    };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- assistant-node-store`
Expected: PASS — 12 tests

- [ ] **Step 6: Commit**

```bash
git add src/assistant/storage/node-store.ts src/assistant/storage/rows.ts tests/assistant-node-store.test.ts
git commit -m "feat(assistant): add graph node and alias store with transactional FTS maintenance"
```

---

## Task 11: Assertion store

Design §4.5 (temporal model), §4.6 (status), §5.2, §5.3 (sensitive assertions are not indexed), §5.4.1 (`assertion_key`).

**Files:**
- Create: `src/assistant/storage/assertion-store.ts`
- Modify: `src/assistant/storage/rows.ts` (append assertion row schemas)
- Test: `tests/assistant-assertion-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/assistant-assertion-store.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphAssertionStore } from '../src/assistant/storage/assertion-store.js';
import { GraphNodeStore } from '../src/assistant/storage/node-store.js';
import { LOCAL_OWNER_ID } from '../src/assistant/storage/schema.js';
import { FixedAssistantClock } from '../src/assistant/runtime/clock.js';
import { SequentialAssistantIdGenerator } from '../src/assistant/runtime/ids.js';
import { computeAssertionKey, buildNodeObjectKey } from '../src/assistant/domain/keys.js';
import { withAssistantRepo, type AssistantFixtureContext } from './helpers/assistant-fixture.js';

interface Harness {
  nodes: GraphNodeStore;
  assertions: GraphAssertionStore;
  clock: FixedAssistantClock;
  selfNodeId: string;
  powershellNodeId: string;
  bashNodeId: string;
  windowsScopeNodeId: string;
}

function buildHarness(context: AssistantFixtureContext): Harness {
  const clock = new FixedAssistantClock('2026-08-04T10:00:00.000Z');
  const ids = new SequentialAssistantIdGenerator();
  const nodes = new GraphNodeStore(context.database, clock, ids);
  const assertions = new GraphAssertionStore(context.database, clock, ids);
  const make = (type: 'person' | 'software' | 'preference_context', key: string, name: string): string =>
    nodes.createNode({
      ownerId: LOCAL_OWNER_ID, type, canonicalKey: key, displayName: name,
      description: null, sensitivity: 'low', properties: {},
    }).id;
  return {
    nodes,
    assertions,
    clock,
    selfNodeId: make('person', 'person:self', 'Denys'),
    powershellNodeId: make('software', 'software:powershell', 'PowerShell'),
    bashNodeId: make('software', 'software:bash', 'Bash'),
    windowsScopeNodeId: make('preference_context', 'preference_context:windows', 'Windows work'),
  };
}

function nodeObjectInput(harness: Harness, objectNodeId: string) {
  return {
    ownerId: LOCAL_OWNER_ID,
    subjectNodeId: harness.selfNodeId,
    predicate: 'PREFERS',
    object: { kind: 'node', nodeId: objectNodeId },
    scopeNodeId: null,
    basis: 'explicit_user_statement',
    confidence: 0.95,
    sensitivity: 'personal',
    validFromUtc: null,
    validToUtc: null,
    observedAtUtc: '2026-08-04T09:00:00.000Z',
    attributes: {},
  } as const;
}

test('a node-object assertion is created with a derived assertion key', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const record = harness.assertions.createAssertion(nodeObjectInput(harness, harness.powershellNodeId));
    assert.equal(record.status, 'active');
    assert.equal(record.objectKind, 'node');
    assert.equal(record.objectNodeId, harness.powershellNodeId);
    assert.equal(record.objectValue, null);
    assert.equal(record.firstObservedAtUtc, '2026-08-04T09:00:00.000Z');
    assert.equal(record.lastObservedAtUtc, '2026-08-04T09:00:00.000Z');
    assert.equal(record.recordedAtUtc, '2026-08-04T10:00:00.000Z');
    assert.equal(record.pinned, false);
    assert.equal(
      record.assertionKey,
      computeAssertionKey({
        ownerId: LOCAL_OWNER_ID,
        subjectNodeId: harness.selfNodeId,
        predicate: 'PREFERS',
        objectKey: buildNodeObjectKey(harness.powershellNodeId),
        scopeNodeId: null,
      }),
    );
    assert.deepEqual(harness.assertions.readAssertion(record.id), record);
  });
});

test('a literal-object assertion round-trips its typed value', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const record = harness.assertions.createAssertion({
      ...nodeObjectInput(harness, harness.powershellNodeId),
      predicate: 'HAS_CONSTRAINT',
      object: { kind: 'literal', value: { valueType: 'string', value: '  No Meetings Before Noon ' } },
    });
    assert.equal(record.objectKind, 'literal');
    assert.equal(record.objectNodeId, null);
    assert.deepEqual(record.objectValue, { valueType: 'string', value: '  No Meetings Before Noon ' });
    assert.equal(record.objectNormalizedText, 'no meetings before noon');
  });
});

test('reading a missing assertion returns null', () => {
  withAssistantRepo((context) => {
    assert.equal(buildHarness(context).assertions.readAssertion('ast_missing'), null);
  });
});

test('a duplicate live assertion key is rejected', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    harness.assertions.createAssertion(nodeObjectInput(harness, harness.powershellNodeId));
    assert.throws(
      () => harness.assertions.createAssertion(nodeObjectInput(harness, harness.powershellNodeId)),
      /UNIQUE constraint failed/u,
    );
  });
});

test('scoped and unscoped assertions of the same shape coexist', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const unscoped = harness.assertions.createAssertion(nodeObjectInput(harness, harness.powershellNodeId));
    const scoped = harness.assertions.createAssertion({
      ...nodeObjectInput(harness, harness.powershellNodeId),
      scopeNodeId: harness.windowsScopeNodeId,
    });
    assert.notEqual(unscoped.assertionKey, scoped.assertionKey);
    assert.equal(harness.assertions.listBySubject(LOCAL_OWNER_ID, harness.selfNodeId, 'PREFERS').length, 2);
  });
});

test('finding by key only returns a live assertion', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const record = harness.assertions.createAssertion(nodeObjectInput(harness, harness.powershellNodeId));
    assert.equal(harness.assertions.findLiveByKey(LOCAL_OWNER_ID, record.assertionKey)?.id, record.id);
    harness.assertions.retireAssertion(record.id, 'superseded', null);
    assert.equal(harness.assertions.findLiveByKey(LOCAL_OWNER_ID, record.assertionKey), null);
  });
});

test('retiring an assertion sets status, retired_at and the supersession link', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const original = harness.assertions.createAssertion(nodeObjectInput(harness, harness.powershellNodeId));
    harness.clock.advanceSeconds(3600);
    const replacement = harness.assertions.createAssertion({
      ...nodeObjectInput(harness, harness.bashNodeId),
      supersedesAssertionId: original.id,
    });
    harness.assertions.retireAssertion(original.id, 'superseded', null);

    const retired = harness.assertions.readAssertion(original.id);
    assert.equal(retired?.status, 'superseded');
    assert.equal(retired?.retiredAtUtc, '2026-08-04T11:00:00.000Z');
    assert.equal(replacement.supersedesAssertionId, original.id);
    // History stays queryable.
    assert.equal(harness.assertions.listBySubject(LOCAL_OWNER_ID, harness.selfNodeId, 'PREFERS').length, 1);
    assert.equal(
      harness.assertions.listBySubjectIncludingHistory(LOCAL_OWNER_ID, harness.selfNodeId, 'PREFERS').length,
      2,
    );
  });
});

test('retiring with a valid_to closes real-world validity without erasing history', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const record = harness.assertions.createAssertion({
      ...nodeObjectInput(harness, harness.powershellNodeId),
      validFromUtc: '2024-01-01T00:00:00.000Z',
    });
    harness.assertions.retireAssertion(record.id, 'expired', '2026-08-01T00:00:00.000Z');
    const retired = harness.assertions.readAssertion(record.id);
    assert.equal(retired?.status, 'expired');
    assert.equal(retired?.validFromUtc, '2024-01-01T00:00:00.000Z');
    assert.equal(retired?.validToUtc, '2026-08-01T00:00:00.000Z');
  });
});

test('retiring a missing assertion throws', () => {
  withAssistantRepo((context) => {
    assert.throws(
      () => buildHarness(context).assertions.retireAssertion('ast_missing', 'expired', null),
      /Unknown graph assertion: ast_missing/u,
    );
  });
});

test('observation window, confidence and pin are updatable', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const record = harness.assertions.createAssertion(nodeObjectInput(harness, harness.powershellNodeId));
    harness.clock.advanceSeconds(120);
    const reinforced = harness.assertions.reinforceAssertion(record.id, {
      confidence: 0.99,
      observedAtUtc: '2026-08-04T12:00:00.000Z',
    });
    assert.equal(reinforced.confidence, 0.99);
    assert.equal(reinforced.firstObservedAtUtc, '2026-08-04T09:00:00.000Z');
    assert.equal(reinforced.lastObservedAtUtc, '2026-08-04T12:00:00.000Z');

    // An earlier observation extends the window backwards without moving last_observed.
    const widened = harness.assertions.reinforceAssertion(record.id, {
      confidence: 0.99,
      observedAtUtc: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(widened.firstObservedAtUtc, '2026-01-01T00:00:00.000Z');
    assert.equal(widened.lastObservedAtUtc, '2026-08-04T12:00:00.000Z');

    assert.equal(harness.assertions.setPinned(record.id, true).pinned, true);
    assert.equal(harness.assertions.setPinned(record.id, false).pinned, false);
  });
});

test('evidence links carry stance and weight and are readable per assertion', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const record = harness.assertions.createAssertion(nodeObjectInput(harness, harness.powershellNodeId));
    context.database.prepare(`
      INSERT INTO evidence_records (
        id, owner_id, device_id, source_event_id, parent_evidence_id, blob_id, source_type,
        source_ref, captured_at_utc, source_timezone, ingested_at_utc, content_hash, mime_type,
        sensitivity, retention_until_utc, status, metadata_json, created_at_utc, updated_at_utc
      ) VALUES ('evd_a', ?, NULL, 'chat:1', NULL, NULL, 'conversation_message', NULL,
        '2026-08-04T09:00:00.000Z', NULL, '2026-08-04T10:00:00.000Z', 'a'.repeat(1), NULL,
        'personal', NULL, 'active', '{}', '2026-08-04T10:00:00.000Z', '2026-08-04T10:00:00.000Z')
    `).run(LOCAL_OWNER_ID);

    harness.assertions.linkEvidence(record.id, 'evd_a', 'supports', 0.9);
    // Re-linking the same stance updates the weight instead of duplicating.
    harness.assertions.linkEvidence(record.id, 'evd_a', 'supports', 0.7);
    harness.assertions.linkEvidence(record.id, 'evd_a', 'contradicts', 0.2);

    const links = harness.assertions.listEvidenceLinks(record.id);
    assert.equal(links.length, 2);
    assert.deepEqual(
      links.map((link) => `${link.stance}:${String(link.weight)}`).sort(),
      ['contradicts:0.2', 'supports:0.7'],
    );
  });
});

test('assertion fts indexes low and personal assertions but not sensitive ones', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const visible = harness.assertions.createAssertion(nodeObjectInput(harness, harness.powershellNodeId));
    const hidden = harness.assertions.createAssertion({
      ...nodeObjectInput(harness, harness.bashNodeId),
      sensitivity: 'sensitive',
    });
    assert.deepEqual(
      harness.assertions.searchAssertions(LOCAL_OWNER_ID, 'PowerShell', 10).map((hit) => hit.id),
      [visible.id],
    );
    assert.deepEqual(harness.assertions.searchAssertions(LOCAL_OWNER_ID, 'Bash', 10), []);
    assert.equal(harness.assertions.readAssertion(hidden.id)?.sensitivity, 'sensitive');
  });
});

test('assertion fts drops a retired assertion', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const record = harness.assertions.createAssertion(nodeObjectInput(harness, harness.powershellNodeId));
    assert.equal(harness.assertions.searchAssertions(LOCAL_OWNER_ID, 'PowerShell', 10).length, 1);
    harness.assertions.retireAssertion(record.id, 'superseded', null);
    assert.equal(harness.assertions.searchAssertions(LOCAL_OWNER_ID, 'PowerShell', 10).length, 0);
  });
});

test('current assertions exclude expired validity windows', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const current = harness.assertions.createAssertion(nodeObjectInput(harness, harness.powershellNodeId));
    const past = harness.assertions.createAssertion({
      ...nodeObjectInput(harness, harness.bashNodeId),
      validFromUtc: '2020-01-01T00:00:00.000Z',
      validToUtc: '2021-01-01T00:00:00.000Z',
    });
    const currentIds = harness.assertions
      .listCurrentBySubject(LOCAL_OWNER_ID, harness.selfNodeId, '2026-08-04T10:00:00.000Z')
      .map((entry) => entry.id);
    assert.deepEqual(currentIds, [current.id]);
    assert.notEqual(harness.assertions.readAssertion(past.id), null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- assistant-assertion-store`
Expected: FAIL — `Cannot find module '../src/assistant/storage/assertion-store.js'`

- [ ] **Step 3: Append row schemas to `src/assistant/storage/rows.ts`**

```ts
export const AssertionRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  assertion_key: z.string(),
  subject_node_id: z.string(),
  predicate: z.string(),
  object_kind: z.string(),
  object_node_id: z.string().nullable(),
  object_value_type: z.string().nullable(),
  object_value_json: z.string().nullable(),
  object_normalized_text: z.string().nullable(),
  scope_node_id: z.string().nullable(),
  status: z.string(),
  basis: z.string(),
  confidence: z.number(),
  sensitivity: z.string(),
  valid_from_utc: z.string().nullable(),
  valid_to_utc: z.string().nullable(),
  first_observed_at_utc: z.string(),
  last_observed_at_utc: z.string(),
  recorded_at_utc: z.string(),
  retired_at_utc: z.string().nullable(),
  supersedes_assertion_id: z.string().nullable(),
  pinned: z.number(),
  attributes_json: z.string(),
  created_at_utc: z.string(),
  updated_at_utc: z.string(),
});

export const AssertionEvidenceRowSchema = z.object({
  assertion_id: z.string(),
  evidence_id: z.string(),
  stance: z.string(),
  weight: z.number(),
  created_at_utc: z.string(),
});

export const AssertionIdRowSchema = z.object({ assertion_id: z.string() });
```

- [ ] **Step 4: Write `src/assistant/storage/assertion-store.ts`**

```ts
import { z } from '../../lib/zod.js';
import { type JsonObject } from '../../lib/json-types.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { AssistantClock } from '../runtime/clock.js';
import { ASSISTANT_ID_PREFIXES, type AssistantIdGenerator } from '../runtime/ids.js';
import { RelationTypeSchema, type RelationType } from '../domain/relation-types.js';
import {
  AssertionBasisSchema,
  AssertionStatusSchema,
  EvidenceStanceSchema,
  SensitivitySchema,
  isFtsExcludedSensitivity,
  type AssertionBasis,
  type AssertionStatus,
  type EvidenceStance,
  type Sensitivity,
} from '../domain/primitives.js';
import {
  LiteralObjectValueSchema,
  buildLiteralObjectKey,
  buildNodeObjectKey,
  computeAssertionKey,
  normalizeLiteralValue,
  type LiteralObjectValue,
} from '../domain/keys.js';
import {
  AssertionEvidenceRowSchema,
  AssertionIdRowSchema,
  AssertionRowSchema,
  fromSqliteFlag,
  parseJsonObjectColumn,
  toSqliteFlag,
} from './rows.js';

export type AssertionObject =
  | { kind: 'node'; nodeId: string }
  | { kind: 'literal'; value: LiteralObjectValue };

export interface CreateAssertionInput {
  ownerId: string;
  subjectNodeId: string;
  predicate: RelationType;
  object: AssertionObject;
  scopeNodeId: string | null;
  basis: AssertionBasis;
  confidence: number;
  sensitivity: Sensitivity;
  validFromUtc: string | null;
  validToUtc: string | null;
  observedAtUtc: string;
  attributes: JsonObject;
  supersedesAssertionId?: string | null;
}

export interface ReinforceAssertionInput {
  confidence: number;
  observedAtUtc: string;
}

export interface GraphAssertionRecord {
  id: string;
  ownerId: string;
  assertionKey: string;
  subjectNodeId: string;
  predicate: RelationType;
  objectKind: 'node' | 'literal';
  objectNodeId: string | null;
  objectValue: LiteralObjectValue | null;
  objectNormalizedText: string | null;
  scopeNodeId: string | null;
  status: AssertionStatus;
  basis: AssertionBasis;
  confidence: number;
  sensitivity: Sensitivity;
  validFromUtc: string | null;
  validToUtc: string | null;
  firstObservedAtUtc: string;
  lastObservedAtUtc: string;
  recordedAtUtc: string;
  retiredAtUtc: string | null;
  supersedesAssertionId: string | null;
  pinned: boolean;
  attributes: JsonObject;
  createdAtUtc: string;
  updatedAtUtc: string;
}

export interface AssertionEvidenceLink {
  assertionId: string;
  evidenceId: string;
  stance: EvidenceStance;
  weight: number;
  createdAtUtc: string;
}

const LIVE_STATUSES = ['active', 'disputed'] as const;

function toFtsPhrase(queryText: string): string {
  return `"${queryText.replace(/"/gu, '""')}"`;
}

export class GraphAssertionStore {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly clock: AssistantClock,
    private readonly ids: AssistantIdGenerator,
  ) {}

  createAssertion(input: CreateAssertionInput): GraphAssertionRecord {
    const objectKey = input.object.kind === 'node'
      ? buildNodeObjectKey(input.object.nodeId)
      : buildLiteralObjectKey(input.object.value);
    const assertionKey = computeAssertionKey({
      ownerId: input.ownerId,
      subjectNodeId: input.subjectNodeId,
      predicate: input.predicate,
      objectKey,
      scopeNodeId: input.scopeNodeId,
    });
    const nowUtc = this.clock.nowUtc();
    const assertionId = this.ids.next(ASSISTANT_ID_PREFIXES.assertion);

    const create = this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO graph_assertions (
          id, owner_id, assertion_key, subject_node_id, predicate, object_kind, object_node_id,
          object_value_type, object_value_json, object_normalized_text, scope_node_id, status, basis,
          confidence, sensitivity, valid_from_utc, valid_to_utc, first_observed_at_utc,
          last_observed_at_utc, recorded_at_utc, retired_at_utc, supersedes_assertion_id, pinned,
          attributes_json, created_at_utc, updated_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?, ?, ?)
      `).run(
        assertionId,
        input.ownerId,
        assertionKey,
        input.subjectNodeId,
        input.predicate,
        input.object.kind,
        input.object.kind === 'node' ? input.object.nodeId : null,
        input.object.kind === 'literal' ? input.object.value.valueType : null,
        input.object.kind === 'literal' ? JSON.stringify(input.object.value) : null,
        input.object.kind === 'literal' ? normalizeLiteralValue(input.object.value) : null,
        input.scopeNodeId,
        input.basis,
        input.confidence,
        input.sensitivity,
        input.validFromUtc,
        input.validToUtc,
        input.observedAtUtc,
        input.observedAtUtc,
        nowUtc,
        input.supersedesAssertionId ?? null,
        JSON.stringify(input.attributes),
        nowUtc,
        nowUtc,
      );
      this.refreshAssertionFts(assertionId);
    });
    create();
    return this.requireAssertion(assertionId);
  }

  readAssertion(assertionId: string): GraphAssertionRecord | null {
    const rawRow = this.database.prepare(
      'SELECT * FROM graph_assertions WHERE id = ? LIMIT 1',
    ).get(assertionId);
    if (rawRow == null) {
      return null;
    }
    return GraphAssertionStore.mapRow(AssertionRowSchema.parse(rawRow));
  }

  findLiveByKey(ownerId: string, assertionKey: string): GraphAssertionRecord | null {
    const rawRow = this.database.prepare(`
      SELECT * FROM graph_assertions
      WHERE owner_id = ? AND assertion_key = ? AND status IN ('active', 'disputed')
      LIMIT 1
    `).get(ownerId, assertionKey);
    if (rawRow == null) {
      return null;
    }
    return GraphAssertionStore.mapRow(AssertionRowSchema.parse(rawRow));
  }

  listBySubject(
    ownerId: string,
    subjectNodeId: string,
    predicate: RelationType | null = null,
  ): readonly GraphAssertionRecord[] {
    const rows = predicate === null
      ? this.database.prepare(`
          SELECT * FROM graph_assertions
          WHERE owner_id = ? AND subject_node_id = ? AND status IN ('active', 'disputed')
          ORDER BY created_at_utc, id
        `).all(ownerId, subjectNodeId)
      : this.database.prepare(`
          SELECT * FROM graph_assertions
          WHERE owner_id = ? AND subject_node_id = ? AND predicate = ?
            AND status IN ('active', 'disputed')
          ORDER BY created_at_utc, id
        `).all(ownerId, subjectNodeId, predicate);
    return rows.map((row) => GraphAssertionStore.mapRow(AssertionRowSchema.parse(row)));
  }

  listBySubjectIncludingHistory(
    ownerId: string,
    subjectNodeId: string,
    predicate: RelationType,
  ): readonly GraphAssertionRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM graph_assertions
      WHERE owner_id = ? AND subject_node_id = ? AND predicate = ? AND status <> 'deleted'
      ORDER BY created_at_utc, id
    `).all(ownerId, subjectNodeId, predicate);
    return rows.map((row) => GraphAssertionStore.mapRow(AssertionRowSchema.parse(row)));
  }

  listByObjectNode(ownerId: string, objectNodeId: string): readonly GraphAssertionRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM graph_assertions
      WHERE owner_id = ? AND object_node_id = ? AND status IN ('active', 'disputed')
      ORDER BY created_at_utc, id
    `).all(ownerId, objectNodeId);
    return rows.map((row) => GraphAssertionStore.mapRow(AssertionRowSchema.parse(row)));
  }

  // Current means live and not closed in real-world time as of `asOfUtc`.
  listCurrentBySubject(
    ownerId: string,
    subjectNodeId: string,
    asOfUtc: string,
  ): readonly GraphAssertionRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM graph_assertions
      WHERE owner_id = ? AND subject_node_id = ? AND status IN ('active', 'disputed')
        AND (valid_from_utc IS NULL OR valid_from_utc <= ?)
        AND (valid_to_utc IS NULL OR valid_to_utc > ?)
      ORDER BY created_at_utc, id
    `).all(ownerId, subjectNodeId, asOfUtc, asOfUtc);
    return rows.map((row) => GraphAssertionStore.mapRow(AssertionRowSchema.parse(row)));
  }

  retireAssertion(
    assertionId: string,
    status: Exclude<AssertionStatus, 'active' | 'disputed'>,
    validToUtc: string | null,
  ): GraphAssertionRecord {
    this.requireAssertion(assertionId);
    const nowUtc = this.clock.nowUtc();
    const retire = this.database.transaction(() => {
      this.database.prepare(`
        UPDATE graph_assertions
        SET status = ?, retired_at_utc = ?, updated_at_utc = ?,
            valid_to_utc = COALESCE(?, valid_to_utc)
        WHERE id = ?
      `).run(status, nowUtc, nowUtc, validToUtc, assertionId);
      this.refreshAssertionFts(assertionId);
    });
    retire();
    return this.requireAssertion(assertionId);
  }

  setStatus(assertionId: string, status: 'active' | 'disputed'): GraphAssertionRecord {
    this.requireAssertion(assertionId);
    const nowUtc = this.clock.nowUtc();
    const apply = this.database.transaction(() => {
      this.database.prepare(`
        UPDATE graph_assertions
        SET status = ?, retired_at_utc = NULL, updated_at_utc = ?
        WHERE id = ?
      `).run(status, nowUtc, assertionId);
      this.refreshAssertionFts(assertionId);
    });
    apply();
    return this.requireAssertion(assertionId);
  }

  // Widens the support window in whichever direction the new observation extends it.
  reinforceAssertion(assertionId: string, input: ReinforceAssertionInput): GraphAssertionRecord {
    this.requireAssertion(assertionId);
    const nowUtc = this.clock.nowUtc();
    this.database.prepare(`
      UPDATE graph_assertions
      SET confidence = ?,
          first_observed_at_utc = MIN(first_observed_at_utc, ?),
          last_observed_at_utc = MAX(last_observed_at_utc, ?),
          updated_at_utc = ?
      WHERE id = ?
    `).run(input.confidence, input.observedAtUtc, input.observedAtUtc, nowUtc, assertionId);
    return this.requireAssertion(assertionId);
  }

  setPinned(assertionId: string, pinned: boolean): GraphAssertionRecord {
    this.requireAssertion(assertionId);
    this.database.prepare(
      'UPDATE graph_assertions SET pinned = ?, updated_at_utc = ? WHERE id = ?',
    ).run(toSqliteFlag(pinned), this.clock.nowUtc(), assertionId);
    return this.requireAssertion(assertionId);
  }

  linkEvidence(
    assertionId: string,
    evidenceId: string,
    stance: EvidenceStance,
    weight: number,
  ): void {
    this.database.prepare(`
      INSERT INTO assertion_evidence (assertion_id, evidence_id, stance, weight, created_at_utc)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(assertion_id, evidence_id, stance) DO UPDATE SET weight = excluded.weight
    `).run(assertionId, evidenceId, stance, weight, this.clock.nowUtc());
  }

  listEvidenceLinks(assertionId: string): readonly AssertionEvidenceLink[] {
    const rows = this.database.prepare(`
      SELECT * FROM assertion_evidence WHERE assertion_id = ? ORDER BY evidence_id, stance
    `).all(assertionId);
    return rows.map((row) => {
      const parsed = AssertionEvidenceRowSchema.parse(row);
      return {
        assertionId: parsed.assertion_id,
        evidenceId: parsed.evidence_id,
        stance: EvidenceStanceSchema.parse(parsed.stance),
        weight: parsed.weight,
        createdAtUtc: parsed.created_at_utc,
      };
    });
  }

  searchAssertions(ownerId: string, queryText: string, limit: number): readonly GraphAssertionRecord[] {
    const normalizedQuery = queryText.trim();
    if (!normalizedQuery) {
      return [];
    }
    const rows = this.database.prepare(`
      SELECT assertion_id FROM graph_assertions_fts
      WHERE graph_assertions_fts MATCH ? AND owner_id = ?
      ORDER BY rank
      LIMIT ?
    `).all(toFtsPhrase(normalizedQuery), ownerId, limit);
    const records: GraphAssertionRecord[] = [];
    for (const row of rows) {
      const record = this.readAssertion(AssertionIdRowSchema.parse(row).assertion_id);
      if (record) {
        records.push(record);
      }
    }
    return records;
  }

  private requireAssertion(assertionId: string): GraphAssertionRecord {
    const record = this.readAssertion(assertionId);
    if (!record) {
      throw new Error(`Unknown graph assertion: ${assertionId}`);
    }
    return record;
  }

  // Only live, non-sensitive assertions reach the index (design §5.3). The searchable text is
  // resolved node display names plus the normalized literal, so lexical search finds real words.
  private refreshAssertionFts(assertionId: string): void {
    this.database.prepare('DELETE FROM graph_assertions_fts WHERE assertion_id = ?').run(assertionId);
    const record = this.readAssertion(assertionId);
    if (!record) {
      return;
    }
    const liveStatus = LIVE_STATUSES.some((status) => status === record.status);
    if (!liveStatus || isFtsExcludedSensitivity(record.sensitivity)) {
      return;
    }
    this.database.prepare(`
      INSERT INTO graph_assertions_fts (
        assertion_id, owner_id, subject_text, predicate_text, object_text, scope_text
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.ownerId,
      this.nodeDisplayName(record.subjectNodeId),
      record.predicate,
      record.objectNodeId === null
        ? record.objectNormalizedText ?? ''
        : this.nodeDisplayName(record.objectNodeId),
      record.scopeNodeId === null ? '' : this.nodeDisplayName(record.scopeNodeId),
    );
  }

  private nodeDisplayName(nodeId: string): string {
    const rawRow = this.database.prepare(
      'SELECT display_name FROM graph_nodes WHERE id = ? LIMIT 1',
    ).get(nodeId);
    if (rawRow == null) {
      return '';
    }
    return z.object({ display_name: z.string() }).parse(rawRow).display_name;
  }

  private static mapRow(row: z.infer<typeof AssertionRowSchema>): GraphAssertionRecord {
    const objectKind = row.object_kind === 'node' ? 'node' : 'literal';
    return {
      id: row.id,
      ownerId: row.owner_id,
      assertionKey: row.assertion_key,
      subjectNodeId: row.subject_node_id,
      predicate: RelationTypeSchema.parse(row.predicate),
      objectKind,
      objectNodeId: row.object_node_id,
      objectValue: row.object_value_json === null
        ? null
        : LiteralObjectValueSchema.parse(JSON.parse(row.object_value_json)),
      objectNormalizedText: row.object_normalized_text,
      scopeNodeId: row.scope_node_id,
      status: AssertionStatusSchema.parse(row.status),
      basis: AssertionBasisSchema.parse(row.basis),
      confidence: row.confidence,
      sensitivity: SensitivitySchema.parse(row.sensitivity),
      validFromUtc: row.valid_from_utc,
      validToUtc: row.valid_to_utc,
      firstObservedAtUtc: row.first_observed_at_utc,
      lastObservedAtUtc: row.last_observed_at_utc,
      recordedAtUtc: row.recorded_at_utc,
      retiredAtUtc: row.retired_at_utc,
      supersedesAssertionId: row.supersedes_assertion_id,
      pinned: fromSqliteFlag(row.pinned),
      attributes: parseJsonObjectColumn(row.attributes_json),
      createdAtUtc: row.created_at_utc,
      updatedAtUtc: row.updated_at_utc,
    };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- assistant-assertion-store`
Expected: PASS — 14 tests

- [ ] **Step 6: Commit**

```bash
git add src/assistant/storage/assertion-store.ts src/assistant/storage/rows.ts tests/assistant-assertion-store.test.ts
git commit -m "feat(assistant): add graph assertion store with temporal queries and sensitivity-gated FTS"
```

---

## Task 12: Audit store, mutation log, and graph version

Design §5.5 (monotonic `graph_version` in `runtime_metadata`, incremented once per committed graph mutation transaction), §4.7 (`secret_prohibited` records only a non-content audit event), §21.11 (every memory is explainable).

**Files:**
- Create: `src/assistant/storage/audit-store.ts`
- Test: `tests/assistant-audit-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/assistant-audit-store.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { AssistantAuditStore, GRAPH_VERSION_METADATA_KEY } from '../src/assistant/storage/audit-store.js';
import { LOCAL_OWNER_ID } from '../src/assistant/storage/schema.js';
import { FixedAssistantClock } from '../src/assistant/runtime/clock.js';
import { SequentialAssistantIdGenerator } from '../src/assistant/runtime/ids.js';
import { z } from '../src/lib/zod.js';
import { withAssistantRepo, type AssistantFixtureContext } from './helpers/assistant-fixture.js';

function buildStore(context: AssistantFixtureContext): AssistantAuditStore {
  return new AssistantAuditStore(
    context.database,
    new FixedAssistantClock('2026-08-04T10:00:00.000Z'),
    new SequentialAssistantIdGenerator(),
  );
}

test('graph version starts at zero and increments monotonically', () => {
  withAssistantRepo((context) => {
    const store = buildStore(context);
    assert.equal(store.readGraphVersion(), 0);
    assert.equal(store.incrementGraphVersion(), 1);
    assert.equal(store.incrementGraphVersion(), 2);
    assert.equal(store.readGraphVersion(), 2);
  });
});

test('graph version survives a new store instance over the same database', () => {
  withAssistantRepo((context) => {
    buildStore(context).incrementGraphVersion();
    assert.equal(buildStore(context).readGraphVersion(), 1);
    const stored = z.object({ value: z.string() }).parse(
      context.database.prepare('SELECT value FROM runtime_metadata WHERE key = ?')
        .get(GRAPH_VERSION_METADATA_KEY),
    );
    assert.equal(stored.value, '1');
  });
});

test('a corrupt graph version value is rejected loudly', () => {
  withAssistantRepo((context) => {
    context.database.prepare(`
      INSERT INTO runtime_metadata (key, value, updated_at_utc) VALUES (?, 'not-a-number', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(GRAPH_VERSION_METADATA_KEY, '2026-08-04T10:00:00.000Z');
    assert.throws(
      () => buildStore(context).readGraphVersion(),
      /Corrupt assistant graph version: not-a-number/u,
    );
  });
});

test('a mutation is logged with before and after snapshots', () => {
  withAssistantRepo((context) => {
    const store = buildStore(context);
    const entry = store.recordMutation({
      ownerId: LOCAL_OWNER_ID,
      actorType: 'user',
      actorRef: 'memory-inspector',
      operation: 'supersede_assertion',
      targetType: 'graph_assertion',
      targetId: 'ast_000001',
      before: { status: 'active' },
      after: { status: 'superseded' },
      reason: 'User corrected the preference.',
    });
    assert.equal(entry.id, 'mut_000001');
    assert.equal(entry.operation, 'supersede_assertion');
    assert.deepEqual(entry.before, { status: 'active' });
    assert.deepEqual(entry.after, { status: 'superseded' });
    assert.equal(entry.createdAtUtc, '2026-08-04T10:00:00.000Z');
  });
});

test('mutation history for a target is returned in chronological order', () => {
  withAssistantRepo((context) => {
    const clock = new FixedAssistantClock('2026-08-04T10:00:00.000Z');
    const store = new AssistantAuditStore(context.database, clock, new SequentialAssistantIdGenerator());
    store.recordMutation({
      ownerId: LOCAL_OWNER_ID, actorType: 'system', actorRef: null, operation: 'create_assertion',
      targetType: 'graph_assertion', targetId: 'ast_1', before: null, after: { status: 'active' },
      reason: 'Ingested from a chat turn.',
    });
    clock.advanceSeconds(60);
    store.recordMutation({
      ownerId: LOCAL_OWNER_ID, actorType: 'user', actorRef: null, operation: 'confirm_assertion',
      targetType: 'graph_assertion', targetId: 'ast_1', before: { confidence: 0.7 },
      after: { confidence: 0.98 }, reason: 'User confirmed.',
    });
    store.recordMutation({
      ownerId: LOCAL_OWNER_ID, actorType: 'user', actorRef: null, operation: 'create_node',
      targetType: 'graph_node', targetId: 'nod_1', before: null, after: {}, reason: 'Unrelated.',
    });

    const history = store.listMutations(LOCAL_OWNER_ID, 'graph_assertion', 'ast_1');
    assert.deepEqual(history.map((entry) => entry.operation), ['create_assertion', 'confirm_assertion']);
    assert.equal(history[1]?.createdAtUtc, '2026-08-04T10:01:00.000Z');
  });
});

test('a null before or after snapshot round-trips as null', () => {
  withAssistantRepo((context) => {
    const store = buildStore(context);
    const entry = store.recordMutation({
      ownerId: LOCAL_OWNER_ID, actorType: 'migration', actorRef: null, operation: 'create_node',
      targetType: 'graph_node', targetId: 'nod_1', before: null, after: null, reason: 'Seed.',
    });
    const [stored] = store.listMutations(LOCAL_OWNER_ID, 'graph_node', 'nod_1');
    assert.equal(stored?.id, entry.id);
    assert.equal(stored?.before, null);
    assert.equal(stored?.after, null);
  });
});

test('audit events record non-content facts only', () => {
  withAssistantRepo((context) => {
    const store = buildStore(context);
    const event = store.recordAuditEvent({
      ownerId: LOCAL_OWNER_ID,
      eventType: 'secret_prohibited_discarded',
      targetType: 'evidence_record',
      targetId: 'evd_000001',
      summary: 'Discarded content classified secret_prohibited during extraction.',
      details: { extractorName: 'conversation_memory_extractor' },
    });
    assert.equal(event.id, 'aud_000001');
    const events = store.listAuditEvents(LOCAL_OWNER_ID, 10);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.eventType, 'secret_prohibited_discarded');
    assert.deepEqual(events[0]?.details, { extractorName: 'conversation_memory_extractor' });
  });
});

test('audit events are returned newest first and capped by limit', () => {
  withAssistantRepo((context) => {
    const clock = new FixedAssistantClock('2026-08-04T10:00:00.000Z');
    const store = new AssistantAuditStore(context.database, clock, new SequentialAssistantIdGenerator());
    for (let index = 0; index < 4; index += 1) {
      store.recordAuditEvent({
        ownerId: LOCAL_OWNER_ID, eventType: `event_${String(index)}`, targetType: null,
        targetId: null, summary: `Event ${String(index)}`, details: {},
      });
      clock.advanceSeconds(60);
    }
    const events = store.listAuditEvents(LOCAL_OWNER_ID, 2);
    assert.deepEqual(events.map((event) => event.eventType), ['event_3', 'event_2']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- assistant-audit-store`
Expected: FAIL — `Cannot find module '../src/assistant/storage/audit-store.js'`

- [ ] **Step 3: Write `src/assistant/storage/audit-store.ts`**

```ts
import { z } from '../../lib/zod.js';
import { type JsonObject } from '../../lib/json-types.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { AssistantClock } from '../runtime/clock.js';
import { ASSISTANT_ID_PREFIXES, type AssistantIdGenerator } from '../runtime/ids.js';
import {
  MutationActorTypeSchema,
  MutationOperationSchema,
  type MutationActorType,
  type MutationOperation,
} from '../domain/primitives.js';
import { parseJsonObjectColumn } from './rows.js';

export const GRAPH_VERSION_METADATA_KEY = 'assistant_graph_version';

const GraphVersionRowSchema = z.object({ value: z.string() });

const MutationRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  actor_type: z.string(),
  actor_ref: z.string().nullable(),
  operation: z.string(),
  target_type: z.string(),
  target_id: z.string(),
  before_json: z.string().nullable(),
  after_json: z.string().nullable(),
  reason: z.string(),
  created_at_utc: z.string(),
});

const AuditEventRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  event_type: z.string(),
  target_type: z.string().nullable(),
  target_id: z.string().nullable(),
  summary: z.string(),
  details_json: z.string(),
  created_at_utc: z.string(),
});

export interface RecordMutationInput {
  ownerId: string;
  actorType: MutationActorType;
  actorRef: string | null;
  operation: MutationOperation;
  targetType: string;
  targetId: string;
  before: JsonObject | null;
  after: JsonObject | null;
  reason: string;
}

export interface GraphMutationEntry {
  id: string;
  ownerId: string;
  actorType: MutationActorType;
  actorRef: string | null;
  operation: MutationOperation;
  targetType: string;
  targetId: string;
  before: JsonObject | null;
  after: JsonObject | null;
  reason: string;
  createdAtUtc: string;
}

export interface RecordAuditEventInput {
  ownerId: string;
  eventType: string;
  targetType: string | null;
  targetId: string | null;
  summary: string;
  details: JsonObject;
}

export interface AssistantAuditEvent {
  id: string;
  ownerId: string;
  eventType: string;
  targetType: string | null;
  targetId: string | null;
  summary: string;
  details: JsonObject;
  createdAtUtc: string;
}

export class AssistantAuditStore {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly clock: AssistantClock,
    private readonly ids: AssistantIdGenerator,
  ) {}

  readGraphVersion(): number {
    const rawRow = this.database.prepare(
      'SELECT value FROM runtime_metadata WHERE key = ? LIMIT 1',
    ).get(GRAPH_VERSION_METADATA_KEY);
    if (rawRow == null) {
      return 0;
    }
    const text = GraphVersionRowSchema.parse(rawRow).value;
    const version = Number(text);
    if (!Number.isInteger(version) || version < 0) {
      throw new Error(`Corrupt assistant graph version: ${text}`);
    }
    return version;
  }

  // Called exactly once inside each committed graph mutation transaction.
  incrementGraphVersion(): number {
    const nextVersion = this.readGraphVersion() + 1;
    this.database.prepare(`
      INSERT INTO runtime_metadata (key, value, updated_at_utc)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_utc = excluded.updated_at_utc
    `).run(GRAPH_VERSION_METADATA_KEY, String(nextVersion), this.clock.nowUtc());
    return nextVersion;
  }

  recordMutation(input: RecordMutationInput): GraphMutationEntry {
    const mutationId = this.ids.next(ASSISTANT_ID_PREFIXES.mutation);
    const nowUtc = this.clock.nowUtc();
    this.database.prepare(`
      INSERT INTO graph_mutation_log (
        id, owner_id, actor_type, actor_ref, operation, target_type, target_id,
        before_json, after_json, reason, created_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      mutationId,
      input.ownerId,
      input.actorType,
      input.actorRef,
      input.operation,
      input.targetType,
      input.targetId,
      input.before === null ? null : JSON.stringify(input.before),
      input.after === null ? null : JSON.stringify(input.after),
      input.reason,
      nowUtc,
    );
    return {
      id: mutationId,
      ownerId: input.ownerId,
      actorType: input.actorType,
      actorRef: input.actorRef,
      operation: input.operation,
      targetType: input.targetType,
      targetId: input.targetId,
      before: input.before,
      after: input.after,
      reason: input.reason,
      createdAtUtc: nowUtc,
    };
  }

  listMutations(
    ownerId: string,
    targetType: string,
    targetId: string,
  ): readonly GraphMutationEntry[] {
    const rows = this.database.prepare(`
      SELECT * FROM graph_mutation_log
      WHERE owner_id = ? AND target_type = ? AND target_id = ?
      ORDER BY created_at_utc, id
    `).all(ownerId, targetType, targetId);
    return rows.map((row) => {
      const parsed = MutationRowSchema.parse(row);
      return {
        id: parsed.id,
        ownerId: parsed.owner_id,
        actorType: MutationActorTypeSchema.parse(parsed.actor_type),
        actorRef: parsed.actor_ref,
        operation: MutationOperationSchema.parse(parsed.operation),
        targetType: parsed.target_type,
        targetId: parsed.target_id,
        before: parsed.before_json === null ? null : parseJsonObjectColumn(parsed.before_json),
        after: parsed.after_json === null ? null : parseJsonObjectColumn(parsed.after_json),
        reason: parsed.reason,
        createdAtUtc: parsed.created_at_utc,
      };
    });
  }

  recordAuditEvent(input: RecordAuditEventInput): AssistantAuditEvent {
    const eventId = this.ids.next(ASSISTANT_ID_PREFIXES.audit);
    const nowUtc = this.clock.nowUtc();
    this.database.prepare(`
      INSERT INTO assistant_audit_events (
        id, owner_id, event_type, target_type, target_id, summary, details_json, created_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      input.ownerId,
      input.eventType,
      input.targetType,
      input.targetId,
      input.summary,
      JSON.stringify(input.details),
      nowUtc,
    );
    return { id: eventId, ...input, createdAtUtc: nowUtc };
  }

  listAuditEvents(ownerId: string, limit: number): readonly AssistantAuditEvent[] {
    const rows = this.database.prepare(`
      SELECT * FROM assistant_audit_events
      WHERE owner_id = ?
      ORDER BY created_at_utc DESC, id DESC
      LIMIT ?
    `).all(ownerId, limit);
    return rows.map((row) => {
      const parsed = AuditEventRowSchema.parse(row);
      return {
        id: parsed.id,
        ownerId: parsed.owner_id,
        eventType: parsed.event_type,
        targetType: parsed.target_type,
        targetId: parsed.target_id,
        summary: parsed.summary,
        details: parseJsonObjectColumn(parsed.details_json),
        createdAtUtc: parsed.created_at_utc,
      };
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- assistant-audit-store`
Expected: PASS — 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/assistant/storage/audit-store.ts tests/assistant-audit-store.test.ts
git commit -m "feat(assistant): add audit store with mutation log and monotonic graph version"
```

---

## Task 13: Graph assertion validator

Design §4.3 (arbitrary predicates are rejected at validation), §4.5 (temporal requirements), §4.6 (basis ceilings), §4.7 (`secret_prohibited` never becomes a graph value), §4.8 (scope is a `preference_context` node), §8.3.

The validator is pure: it takes already-resolved node records and returns either a normalized proposal or a list of errors. It never touches the database.

**Files:**
- Create: `src/assistant/graph/validation.ts`
- Test: `tests/assistant-graph-validation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/assistant-graph-validation.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GraphAssertionValidator,
  ASSERTION_VALIDATION_CODES,
} from '../src/assistant/graph/validation.js';
import type { GraphNodeRecord } from '../src/assistant/storage/node-store.js';
import type { NodeType } from '../src/assistant/domain/node-types.js';
import type { Sensitivity } from '../src/assistant/domain/primitives.js';

const OWNER_ID = 'own_local';

function node(
  id: string,
  type: NodeType,
  overrides: Partial<Pick<GraphNodeRecord, 'ownerId' | 'status' | 'sensitivity'>> = {},
): GraphNodeRecord {
  return {
    id,
    ownerId: overrides.ownerId ?? OWNER_ID,
    type,
    canonicalKey: `${type}:${id}`,
    displayName: id,
    description: null,
    sensitivity: overrides.sensitivity ?? 'personal',
    status: overrides.status ?? 'active',
    properties: {},
    mergedIntoNodeId: null,
    createdAtUtc: '2026-08-04T10:00:00.000Z',
    updatedAtUtc: '2026-08-04T10:00:00.000Z',
    deletedAtUtc: null,
  };
}

const SELF = node('self', 'person');
const POWERSHELL = node('powershell', 'software');
const WINDOWS_SCOPE = node('windows', 'preference_context');

function baseProposal(overrides: Record<string, unknown> = {}) {
  return {
    ownerId: OWNER_ID,
    subjectNode: SELF,
    predicate: 'PREFERS',
    object: { kind: 'node', node: POWERSHELL },
    scopeNode: null,
    basis: 'explicit_user_statement',
    confidence: 0.95,
    sensitivity: null,
    validFromUtc: null,
    validToUtc: null,
    ...overrides,
  } as const;
}

function errorCodes(result: ReturnType<GraphAssertionValidator['validate']>): readonly string[] {
  return result.ok ? [] : result.errors.map((entry) => entry.code);
}

test('a well-formed proposal validates and inherits the relation default sensitivity', () => {
  const result = new GraphAssertionValidator().validate(baseProposal());
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.normalized.sensitivity, 'personal');
  assert.equal(result.normalized.confidence, 0.95);
  assert.equal(result.normalized.predicate, 'PREFERS');
});

test('an explicit sensitivity overrides the relation default only upwards', () => {
  const validator = new GraphAssertionValidator();
  const raised = validator.validate(baseProposal({ sensitivity: 'sensitive' }));
  assert.equal(raised.ok, true);
  if (raised.ok) {
    assert.equal(raised.normalized.sensitivity, 'sensitive');
  }
  // EMPLOYED_BY defaults to sensitive; a caller may not quietly downgrade it to low.
  const lowered = validator.validate(baseProposal({
    predicate: 'EMPLOYED_BY',
    object: { kind: 'node', node: node('acme', 'organization') },
    sensitivity: 'low',
    validFromUtc: '2024-01-01T00:00:00.000Z',
  }));
  assert.equal(lowered.ok, true);
  if (lowered.ok) {
    assert.equal(lowered.normalized.sensitivity, 'sensitive');
  }
});

test('an unregistered predicate is rejected', () => {
  const result = new GraphAssertionValidator().validate(baseProposal({ predicate: 'ADORES' }));
  assert.deepEqual(errorCodes(result), ['unregistered_predicate']);
});

test('a subject node type outside the allowed set is rejected', () => {
  const result = new GraphAssertionValidator().validate(baseProposal({
    subjectNode: node('vscode', 'software'),
  }));
  assert.deepEqual(errorCodes(result), ['subject_type_not_allowed']);
});

test('an object node type outside the allowed set is rejected', () => {
  const result = new GraphAssertionValidator().validate(baseProposal({
    object: { kind: 'node', node: node('berlin', 'place') },
  }));
  assert.deepEqual(errorCodes(result), ['object_type_not_allowed']);
});

test('a literal object supplied to a node predicate is rejected and vice versa', () => {
  const validator = new GraphAssertionValidator();
  assert.deepEqual(
    errorCodes(validator.validate(baseProposal({
      object: { kind: 'literal', value: { valueType: 'string', value: 'PowerShell' } },
    }))),
    ['object_kind_mismatch'],
  );
  assert.deepEqual(
    errorCodes(validator.validate(baseProposal({
      predicate: 'HAS_CONSTRAINT',
      object: { kind: 'node', node: POWERSHELL },
    }))),
    ['object_kind_mismatch'],
  );
});

test('a scope node must be a preference_context node', () => {
  const validator = new GraphAssertionValidator();
  assert.equal(validator.validate(baseProposal({ scopeNode: WINDOWS_SCOPE })).ok, true);
  assert.deepEqual(
    errorCodes(validator.validate(baseProposal({ scopeNode: POWERSHELL }))),
    ['scope_type_not_allowed'],
  );
});

test('a predicate requiring temporality must carry valid_from', () => {
  const validator = new GraphAssertionValidator();
  const acme = node('acme', 'organization');
  assert.deepEqual(
    errorCodes(validator.validate(baseProposal({
      predicate: 'EMPLOYED_BY', object: { kind: 'node', node: acme },
    }))),
    ['temporal_required'],
  );
  assert.equal(
    validator.validate(baseProposal({
      predicate: 'EMPLOYED_BY',
      object: { kind: 'node', node: acme },
      validFromUtc: '2024-01-01T00:00:00.000Z',
    })).ok,
    true,
  );
});

test('a predicate with no temporality must not carry validity dates', () => {
  const result = new GraphAssertionValidator().validate(baseProposal({
    predicate: 'DEPENDS_ON',
    subjectNode: node('siftkit', 'project'),
    object: { kind: 'node', node: POWERSHELL },
    validFromUtc: '2024-01-01T00:00:00.000Z',
  }));
  assert.deepEqual(errorCodes(result), ['temporal_not_allowed']);
});

test('validity dates must be parseable and ordered', () => {
  const validator = new GraphAssertionValidator();
  assert.deepEqual(
    errorCodes(validator.validate(baseProposal({ validFromUtc: 'last tuesday' }))),
    ['malformed_validity_date'],
  );
  assert.deepEqual(
    errorCodes(validator.validate(baseProposal({
      validFromUtc: '2026-01-01T00:00:00.000Z',
      validToUtc: '2025-01-01T00:00:00.000Z',
    }))),
    ['inverted_validity_range'],
  );
});

test('confidence is clamped to the basis ceiling rather than rejected', () => {
  const result = new GraphAssertionValidator().validate(baseProposal({
    basis: 'passive_observation',
    confidence: 0.99,
  }));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.normalized.confidence, 0.85);
    assert.equal(result.normalized.basis, 'passive_observation');
  }
});

test('a non-finite or out-of-range confidence is rejected', () => {
  const validator = new GraphAssertionValidator();
  assert.deepEqual(errorCodes(validator.validate(baseProposal({ confidence: Number.NaN }))), ['invalid_confidence']);
  assert.deepEqual(errorCodes(validator.validate(baseProposal({ confidence: -1 }))), ['invalid_confidence']);
  assert.deepEqual(errorCodes(validator.validate(baseProposal({ confidence: 2 }))), ['invalid_confidence']);
});

test('secret_prohibited never becomes a graph value', () => {
  const result = new GraphAssertionValidator().validate(baseProposal({ sensitivity: 'secret_prohibited' }));
  assert.deepEqual(errorCodes(result), ['secret_prohibited_content']);
});

test('non-active or foreign nodes are rejected', () => {
  const validator = new GraphAssertionValidator();
  assert.deepEqual(
    errorCodes(validator.validate(baseProposal({ subjectNode: node('self', 'person', { status: 'merged' }) }))),
    ['node_not_active'],
  );
  assert.deepEqual(
    errorCodes(validator.validate(baseProposal({
      object: { kind: 'node', node: node('powershell', 'software', { status: 'deleted' }) },
    }))),
    ['node_not_active'],
  );
  assert.deepEqual(
    errorCodes(validator.validate(baseProposal({
      subjectNode: node('self', 'person', { ownerId: 'own_other' }),
    }))),
    ['owner_mismatch'],
  );
});

test('a self-referential assertion is rejected', () => {
  const result = new GraphAssertionValidator().validate(baseProposal({
    predicate: 'RELATED_TO',
    object: { kind: 'node', node: SELF },
  }));
  assert.deepEqual(errorCodes(result), ['self_reference']);
});

test('multiple independent problems are all reported', () => {
  const result = new GraphAssertionValidator().validate(baseProposal({
    subjectNode: node('vscode', 'software'),
    object: { kind: 'node', node: node('berlin', 'place') },
    confidence: 5,
  }));
  assert.deepEqual(
    [...errorCodes(result)].sort(),
    ['invalid_confidence', 'object_type_not_allowed', 'subject_type_not_allowed'],
  );
});

test('every declared validation code is a unique string', () => {
  assert.equal(new Set(ASSERTION_VALIDATION_CODES).size, ASSERTION_VALIDATION_CODES.length);
});
```

Typing note for the two helpers above: declare them against the real types so the test file
typechecks without a cast.

```ts
import type { AssertionProposal, AssertionValidationResult } from '../src/assistant/graph/validation.js';

function baseProposal(overrides: Partial<AssertionProposal> = {}): AssertionProposal {
  return {
    ownerId: OWNER_ID,
    subjectNode: SELF,
    predicate: 'PREFERS',
    object: { kind: 'node', node: POWERSHELL },
    scopeNode: null,
    basis: 'explicit_user_statement',
    confidence: 0.95,
    sensitivity: null,
    validFromUtc: null,
    validToUtc: null,
    ...overrides,
  };
}

function errorCodes(result: AssertionValidationResult): readonly string[] {
  return result.ok ? [] : result.errors.map((entry) => entry.code);
}
```

`AssertionProposal.predicate` is `string`, so `baseProposal({ predicate: 'ADORES' })` is valid input
that the validator must reject at runtime — which is exactly the point of that test.

The unused `Sensitivity` import in the sketch above is not needed; drop it.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- assistant-graph-validation`
Expected: FAIL — `Cannot find module '../src/assistant/graph/validation.js'`

- [ ] **Step 3: Write `src/assistant/graph/validation.ts`**

```ts
import { z } from '../../lib/zod.js';
import {
  RelationTypeSchema,
  getRelationDefinition,
  isNodeTypeAllowedAsObject,
  isNodeTypeAllowedAsSubject,
  type RelationDefinition,
  type RelationType,
} from '../domain/relation-types.js';
import {
  SENSITIVITY_LEVELS,
  type AssertionBasis,
  type Sensitivity,
} from '../domain/primitives.js';
import { applyBasisCeiling } from '../domain/confidence.js';
import type { LiteralObjectValue } from '../domain/keys.js';
import type { GraphNodeRecord } from '../storage/node-store.js';

export const ASSERTION_VALIDATION_CODES = [
  'unregistered_predicate',
  'owner_mismatch',
  'node_not_active',
  'subject_type_not_allowed',
  'object_type_not_allowed',
  'object_kind_mismatch',
  'scope_type_not_allowed',
  'self_reference',
  'temporal_required',
  'temporal_not_allowed',
  'malformed_validity_date',
  'inverted_validity_range',
  'invalid_confidence',
  'secret_prohibited_content',
] as const;
export const AssertionValidationCodeSchema = z.enum(ASSERTION_VALIDATION_CODES);
export type AssertionValidationCode = z.infer<typeof AssertionValidationCodeSchema>;

export interface AssertionValidationError {
  code: AssertionValidationCode;
  message: string;
}

export type ProposedAssertionObject =
  | { kind: 'node'; node: GraphNodeRecord }
  | { kind: 'literal'; value: LiteralObjectValue };

export interface AssertionProposal {
  ownerId: string;
  subjectNode: GraphNodeRecord;
  predicate: string;
  object: ProposedAssertionObject;
  scopeNode: GraphNodeRecord | null;
  basis: AssertionBasis;
  confidence: number;
  // null means "inherit the relation default"; a supplied value may only raise sensitivity.
  sensitivity: Sensitivity | null;
  validFromUtc: string | null;
  validToUtc: string | null;
}

export interface NormalizedAssertionProposal {
  ownerId: string;
  subjectNode: GraphNodeRecord;
  predicate: RelationType;
  definition: RelationDefinition;
  object: ProposedAssertionObject;
  scopeNode: GraphNodeRecord | null;
  basis: AssertionBasis;
  confidence: number;
  sensitivity: Sensitivity;
  validFromUtc: string | null;
  validToUtc: string | null;
}

export type AssertionValidationResult =
  | { ok: true; normalized: NormalizedAssertionProposal }
  | { ok: false; errors: readonly AssertionValidationError[] };

function sensitivityRank(sensitivity: Sensitivity): number {
  return SENSITIVITY_LEVELS.indexOf(sensitivity);
}

function isParseableInstant(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

export class GraphAssertionValidator {
  validate(proposal: AssertionProposal): AssertionValidationResult {
    const errors: AssertionValidationError[] = [];
    const predicateResult = RelationTypeSchema.safeParse(proposal.predicate);
    if (!predicateResult.success) {
      return {
        ok: false,
        errors: [{
          code: 'unregistered_predicate',
          message: `Unregistered relation predicate: ${proposal.predicate}`,
        }],
      };
    }
    const predicate = predicateResult.data;
    const definition = getRelationDefinition(predicate);

    this.checkNodes(proposal, errors);
    this.checkTypes(proposal, definition, errors);
    this.checkTemporality(proposal, definition, errors);
    this.checkConfidence(proposal, errors);

    if (proposal.sensitivity === 'secret_prohibited') {
      errors.push({
        code: 'secret_prohibited_content',
        message: 'Refusing to write a secret_prohibited value into the graph.',
      });
    }

    if (errors.length > 0) {
      return { ok: false, errors };
    }
    return {
      ok: true,
      normalized: {
        ownerId: proposal.ownerId,
        subjectNode: proposal.subjectNode,
        predicate,
        definition,
        object: proposal.object,
        scopeNode: proposal.scopeNode,
        basis: proposal.basis,
        confidence: applyBasisCeiling(proposal.confidence, proposal.basis),
        sensitivity: GraphAssertionValidator.resolveSensitivity(proposal, definition),
        validFromUtc: proposal.validFromUtc,
        validToUtc: proposal.validToUtc,
      },
    };
  }

  private checkNodes(proposal: AssertionProposal, errors: AssertionValidationError[]): void {
    const involved: GraphNodeRecord[] = [proposal.subjectNode];
    if (proposal.object.kind === 'node') {
      involved.push(proposal.object.node);
    }
    if (proposal.scopeNode) {
      involved.push(proposal.scopeNode);
    }
    for (const involvedNode of involved) {
      if (involvedNode.ownerId !== proposal.ownerId) {
        errors.push({
          code: 'owner_mismatch',
          message: `Node ${involvedNode.id} belongs to owner ${involvedNode.ownerId}, not ${proposal.ownerId}.`,
        });
      }
      if (involvedNode.status !== 'active') {
        errors.push({
          code: 'node_not_active',
          message: `Node ${involvedNode.id} has status ${involvedNode.status} and cannot take part in an assertion.`,
        });
      }
    }
    if (proposal.object.kind === 'node' && proposal.object.node.id === proposal.subjectNode.id) {
      errors.push({
        code: 'self_reference',
        message: `Node ${proposal.subjectNode.id} cannot be both subject and object.`,
      });
    }
  }

  private checkTypes(
    proposal: AssertionProposal,
    definition: RelationDefinition,
    errors: AssertionValidationError[],
  ): void {
    if (!isNodeTypeAllowedAsSubject(definition, proposal.subjectNode.type)) {
      errors.push({
        code: 'subject_type_not_allowed',
        message: `${definition.predicate} does not accept a ${proposal.subjectNode.type} subject.`,
      });
    }
    const expectsLiteral = definition.allowedObjectTypes === 'literal';
    if (expectsLiteral !== (proposal.object.kind === 'literal')) {
      errors.push({
        code: 'object_kind_mismatch',
        message: `${definition.predicate} expects ${expectsLiteral ? 'a literal' : 'a node'} object.`,
      });
    } else if (proposal.object.kind === 'node'
      && !isNodeTypeAllowedAsObject(definition, proposal.object.node.type)) {
      errors.push({
        code: 'object_type_not_allowed',
        message: `${definition.predicate} does not accept a ${proposal.object.node.type} object.`,
      });
    }
    if (proposal.scopeNode && proposal.scopeNode.type !== 'preference_context') {
      errors.push({
        code: 'scope_type_not_allowed',
        message: `Scope node ${proposal.scopeNode.id} must be a preference_context node.`,
      });
    }
  }

  private checkTemporality(
    proposal: AssertionProposal,
    definition: RelationDefinition,
    errors: AssertionValidationError[],
  ): void {
    const hasValidity = proposal.validFromUtc !== null || proposal.validToUtc !== null;
    if (definition.temporal === 'required' && proposal.validFromUtc === null) {
      errors.push({
        code: 'temporal_required',
        message: `${definition.predicate} requires valid_from.`,
      });
    }
    if (definition.temporal === 'none' && hasValidity) {
      errors.push({
        code: 'temporal_not_allowed',
        message: `${definition.predicate} does not carry real-world validity dates.`,
      });
    }
    for (const value of [proposal.validFromUtc, proposal.validToUtc]) {
      if (value !== null && !isParseableInstant(value)) {
        errors.push({
          code: 'malformed_validity_date',
          message: `Unparseable validity instant: ${value}`,
        });
      }
    }
    if (
      proposal.validFromUtc !== null
      && proposal.validToUtc !== null
      && isParseableInstant(proposal.validFromUtc)
      && isParseableInstant(proposal.validToUtc)
      && Date.parse(proposal.validFromUtc) > Date.parse(proposal.validToUtc)
    ) {
      errors.push({
        code: 'inverted_validity_range',
        message: `valid_from ${proposal.validFromUtc} is after valid_to ${proposal.validToUtc}.`,
      });
    }
  }

  private checkConfidence(proposal: AssertionProposal, errors: AssertionValidationError[]): void {
    if (!Number.isFinite(proposal.confidence) || proposal.confidence < 0 || proposal.confidence > 1) {
      errors.push({
        code: 'invalid_confidence',
        message: `Confidence must lie in [0, 1]: ${String(proposal.confidence)}`,
      });
    }
  }

  // A caller may raise sensitivity above the relation default but never lower it.
  private static resolveSensitivity(
    proposal: AssertionProposal,
    definition: RelationDefinition,
  ): Sensitivity {
    if (proposal.sensitivity === null) {
      return definition.defaultSensitivity;
    }
    return sensitivityRank(proposal.sensitivity) > sensitivityRank(definition.defaultSensitivity)
      ? proposal.sensitivity
      : definition.defaultSensitivity;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- assistant-graph-validation`
Expected: PASS — 17 tests

- [ ] **Step 5: Commit**

```bash
git add src/assistant/graph/validation.ts tests/assistant-graph-validation.test.ts
git commit -m "feat(assistant): add deterministic graph assertion validator"
```

---

## Task 14: Policy store and graph mutation service

Design §9.3 (conflict strategies), §9.4 (user locks), §4.6 (explicit outranks passive), §5.5 (one graph-version bump per committed mutation transaction), §6.2 (`assistant_policies` rows), §21.3-4.

This is where "models propose, deterministic services decide and write" is enforced.

**Files:**
- Create: `src/assistant/storage/policy-store.ts`
- Create: `src/assistant/graph/mutation.ts`
- Test: `tests/assistant-graph-mutation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/assistant-graph-mutation.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphMutationService } from '../src/assistant/graph/mutation.js';
import { GraphAssertionValidator } from '../src/assistant/graph/validation.js';
import { GraphNodeStore } from '../src/assistant/storage/node-store.js';
import { GraphAssertionStore } from '../src/assistant/storage/assertion-store.js';
import { AssistantAuditStore } from '../src/assistant/storage/audit-store.js';
import { AssistantPolicyStore } from '../src/assistant/storage/policy-store.js';
import { LOCAL_OWNER_ID } from '../src/assistant/storage/schema.js';
import { FixedAssistantClock } from '../src/assistant/runtime/clock.js';
import { SequentialAssistantIdGenerator } from '../src/assistant/runtime/ids.js';
import type { NodeType } from '../src/assistant/domain/node-types.js';
import { withAssistantRepo, type AssistantFixtureContext } from './helpers/assistant-fixture.js';

interface Harness {
  clock: FixedAssistantClock;
  nodes: GraphNodeStore;
  assertions: GraphAssertionStore;
  audit: AssistantAuditStore;
  policies: AssistantPolicyStore;
  mutation: GraphMutationService;
  nodeId: (type: NodeType, key: string, name: string) => string;
}

function buildHarness(context: AssistantFixtureContext): Harness {
  const clock = new FixedAssistantClock('2026-08-04T10:00:00.000Z');
  const ids = new SequentialAssistantIdGenerator();
  const nodes = new GraphNodeStore(context.database, clock, ids);
  const assertions = new GraphAssertionStore(context.database, clock, ids);
  const audit = new AssistantAuditStore(context.database, clock, ids);
  const policies = new AssistantPolicyStore(context.database, clock, ids);
  return {
    clock,
    nodes,
    assertions,
    audit,
    policies,
    mutation: new GraphMutationService(
      context.database, nodes, assertions, audit, policies, new GraphAssertionValidator(),
    ),
    nodeId: (type, key, name) => nodes.createNode({
      ownerId: LOCAL_OWNER_ID, type, canonicalKey: key, displayName: name,
      description: null, sensitivity: 'low', properties: {},
    }).id,
  };
}

function preferenceInput(subjectNodeId: string, objectNodeId: string, overrides: Record<string, unknown> = {}) {
  return {
    ownerId: LOCAL_OWNER_ID,
    subjectNodeId,
    predicate: 'PREFERS',
    object: { kind: 'node', nodeId: objectNodeId },
    scopeNodeId: null,
    basis: 'explicit_user_statement',
    confidence: 0.95,
    sensitivity: null,
    validFromUtc: null,
    validToUtc: null,
    observedAtUtc: '2026-08-04T09:00:00.000Z',
    attributes: {},
    actor: { type: 'user', ref: 'chat' },
    reason: 'Stated in conversation.',
    evidence: null,
    ...overrides,
  } as const;
}

test('applying a valid proposal creates an assertion and bumps the graph version', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const self = harness.nodeId('person', 'person:self', 'Denys');
    const powershell = harness.nodeId('software', 'software:powershell', 'PowerShell');
    assert.equal(harness.audit.readGraphVersion(), 0);

    const outcome = harness.mutation.applyAssertion(preferenceInput(self, powershell));
    assert.equal(outcome.kind, 'created');
    if (outcome.kind !== 'created') {
      return;
    }
    assert.equal(outcome.graphVersion, 1);
    assert.equal(outcome.assertion.status, 'active');
    assert.equal(harness.audit.readGraphVersion(), 1);

    const history = harness.audit.listMutations(LOCAL_OWNER_ID, 'graph_assertion', outcome.assertion.id);
    assert.deepEqual(history.map((entry) => entry.operation), ['create_assertion']);
    assert.equal(history[0]?.reason, 'Stated in conversation.');
  });
});

test('an invalid proposal is rejected without touching the graph or the version', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const self = harness.nodeId('person', 'person:self', 'Denys');
    const berlin = harness.nodeId('place', 'place:berlin', 'Berlin');

    const outcome = harness.mutation.applyAssertion(preferenceInput(self, berlin));
    assert.equal(outcome.kind, 'rejected');
    if (outcome.kind === 'rejected') {
      assert.deepEqual(outcome.errors.map((entry) => entry.code), ['object_type_not_allowed']);
    }
    assert.equal(harness.audit.readGraphVersion(), 0);
    assert.equal(harness.assertions.listBySubject(LOCAL_OWNER_ID, self).length, 0);
  });
});

test('re-applying the identical assertion reinforces it instead of duplicating', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const self = harness.nodeId('person', 'person:self', 'Denys');
    const powershell = harness.nodeId('software', 'software:powershell', 'PowerShell');
    const first = harness.mutation.applyAssertion(preferenceInput(self, powershell));
    harness.clock.advanceSeconds(3600);
    const second = harness.mutation.applyAssertion(preferenceInput(self, powershell, {
      observedAtUtc: '2026-08-04T11:30:00.000Z',
      confidence: 0.99,
    }));

    assert.equal(second.kind, 'reinforced');
    if (first.kind !== 'created' || second.kind !== 'reinforced') {
      return;
    }
    assert.equal(second.assertion.id, first.assertion.id);
    assert.equal(second.assertion.lastObservedAtUtc, '2026-08-04T11:30:00.000Z');
    assert.equal(second.assertion.firstObservedAtUtc, '2026-08-04T09:00:00.000Z');
    assert.equal(harness.assertions.listBySubject(LOCAL_OWNER_ID, self).length, 1);
  });
});

test('a stronger explicit statement supersedes the current single-value preference', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const self = harness.nodeId('person', 'person:self', 'Denys');
    const powershell = harness.nodeId('software', 'software:powershell', 'PowerShell');
    const bash = harness.nodeId('software', 'software:bash', 'Bash');
    const original = harness.mutation.applyAssertion(preferenceInput(self, powershell, { confidence: 0.9 }));
    harness.clock.advanceSeconds(600);
    const correction = harness.mutation.applyAssertion(preferenceInput(self, bash, {
      confidence: 0.99,
      reason: 'No, I meant Bash.',
    }));

    assert.equal(correction.kind, 'superseded');
    if (original.kind !== 'created' || correction.kind !== 'superseded') {
      return;
    }
    assert.equal(correction.supersededAssertionId, original.assertion.id);
    assert.equal(correction.assertion.supersedesAssertionId, original.assertion.id);
    assert.equal(harness.assertions.readAssertion(original.assertion.id)?.status, 'superseded');
    assert.equal(harness.assertions.listBySubject(LOCAL_OWNER_ID, self, 'PREFERS').length, 1);
    assert.equal(harness.audit.readGraphVersion(), 2);
    assert.deepEqual(
      harness.audit.listMutations(LOCAL_OWNER_ID, 'graph_assertion', original.assertion.id)
        .map((entry) => entry.operation),
      ['create_assertion', 'supersede_assertion'],
    );
  });
});

test('passive evidence never displaces an explicit memory', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const self = harness.nodeId('person', 'person:self', 'Denys');
    const powershell = harness.nodeId('software', 'software:powershell', 'PowerShell');
    const bash = harness.nodeId('software', 'software:bash', 'Bash');
    const explicit = harness.mutation.applyAssertion(preferenceInput(self, powershell, { confidence: 0.3 }));
    const passive = harness.mutation.applyAssertion(preferenceInput(self, bash, {
      basis: 'passive_observation',
      confidence: 0.85,
      actor: { type: 'assistant_proposal', ref: 'desktop_observation_extractor' },
      reason: 'Bash was foreground for a long time.',
    }));

    assert.equal(passive.kind, 'blocked_by_explicit_memory');
    if (explicit.kind !== 'created' || passive.kind !== 'blocked_by_explicit_memory') {
      return;
    }
    assert.equal(passive.incumbentAssertionId, explicit.assertion.id);
    assert.equal(harness.assertions.readAssertion(explicit.assertion.id)?.status, 'active');
    assert.equal(harness.assertions.listBySubject(LOCAL_OWNER_ID, self, 'PREFERS').length, 1);
    assert.equal(harness.audit.readGraphVersion(), 1);
  });
});

test('two equally strong explicit statements are both marked disputed', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const self = harness.nodeId('person', 'person:self', 'Denys');
    const powershell = harness.nodeId('software', 'software:powershell', 'PowerShell');
    const bash = harness.nodeId('software', 'software:bash', 'Bash');
    const first = harness.mutation.applyAssertion(preferenceInput(self, powershell, { confidence: 0.95 }));
    const second = harness.mutation.applyAssertion(preferenceInput(self, bash, { confidence: 0.95 }));

    assert.equal(second.kind, 'disputed');
    if (first.kind !== 'created' || second.kind !== 'disputed') {
      return;
    }
    assert.deepEqual(
      second.assertions.map((entry) => entry.status),
      ['disputed', 'disputed'],
    );
    assert.equal(harness.assertions.readAssertion(first.assertion.id)?.status, 'disputed');
  });
});

test('a coexisting predicate accumulates values instead of superseding', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const self = harness.nodeId('person', 'person:self', 'Denys');
    const powershell = harness.nodeId('software', 'software:powershell', 'PowerShell');
    const bash = harness.nodeId('software', 'software:bash', 'Bash');
    harness.mutation.applyAssertion(preferenceInput(self, powershell, { predicate: 'USES' }));
    const second = harness.mutation.applyAssertion(preferenceInput(self, bash, { predicate: 'USES' }));
    assert.equal(second.kind, 'created');
    assert.equal(harness.assertions.listBySubject(LOCAL_OWNER_ID, self, 'USES').length, 2);
  });
});

test('a scoped preference does not compete with an unscoped one', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const self = harness.nodeId('person', 'person:self', 'Denys');
    const powershell = harness.nodeId('software', 'software:powershell', 'PowerShell');
    const bash = harness.nodeId('software', 'software:bash', 'Bash');
    const windows = harness.nodeId('preference_context', 'preference_context:windows', 'Windows work');
    const linux = harness.nodeId('preference_context', 'preference_context:linux', 'Linux servers');

    harness.mutation.applyAssertion(preferenceInput(self, powershell, { scopeNodeId: windows }));
    const other = harness.mutation.applyAssertion(preferenceInput(self, bash, { scopeNodeId: linux }));
    assert.equal(other.kind, 'created');
    assert.equal(harness.assertions.listBySubject(LOCAL_OWNER_ID, self, 'PREFERS').length, 2);
  });
});

test('a pinned assertion blocks automatic supersession but not a user correction', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const self = harness.nodeId('person', 'person:self', 'Denys');
    const powershell = harness.nodeId('software', 'software:powershell', 'PowerShell');
    const bash = harness.nodeId('software', 'software:bash', 'Bash');
    const pinned = harness.mutation.applyAssertion(preferenceInput(self, powershell, { confidence: 0.9 }));
    if (pinned.kind !== 'created') {
      return;
    }
    harness.assertions.setPinned(pinned.assertion.id, true);

    const automatic = harness.mutation.applyAssertion(preferenceInput(self, bash, {
      basis: 'manual_import',
      confidence: 0.95,
      actor: { type: 'assistant_proposal', ref: 'candidate_consolidator' },
    }));
    assert.equal(automatic.kind, 'blocked_by_lock');

    const userCorrection = harness.mutation.applyAssertion(preferenceInput(self, bash, {
      confidence: 0.99,
      actor: { type: 'user', ref: 'memory-inspector' },
    }));
    assert.equal(userCorrection.kind, 'superseded');
  });
});

test('an assertion_lock policy blocks automatic supersession', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const self = harness.nodeId('person', 'person:self', 'Denys');
    const powershell = harness.nodeId('software', 'software:powershell', 'PowerShell');
    const bash = harness.nodeId('software', 'software:bash', 'Bash');
    const locked = harness.mutation.applyAssertion(preferenceInput(self, powershell, { confidence: 0.9 }));
    if (locked.kind !== 'created') {
      return;
    }
    harness.policies.upsertPolicy({
      ownerId: LOCAL_OWNER_ID, policyType: 'assertion_lock', key: locked.assertion.id,
      value: { locked: true }, enabled: true, source: 'user',
    });

    const automatic = harness.mutation.applyAssertion(preferenceInput(self, bash, {
      basis: 'manual_import', confidence: 0.95,
      actor: { type: 'assistant_proposal', ref: 'candidate_consolidator' },
    }));
    assert.equal(automatic.kind, 'blocked_by_lock');

    harness.policies.setPolicyEnabled(LOCAL_OWNER_ID, 'assertion_lock', locked.assertion.id, false);
    const retried = harness.mutation.applyAssertion(preferenceInput(self, bash, {
      basis: 'manual_import', confidence: 0.95,
      actor: { type: 'assistant_proposal', ref: 'candidate_consolidator' },
    }));
    assert.equal(retried.kind, 'superseded');
  });
});

test('a require_confirmation predicate writes nothing and asks for confirmation', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const self = harness.nodeId('person', 'person:self', 'Denys');
    const berlin = harness.nodeId('place', 'place:berlin', 'Berlin');
    // LIVES_IN is single_current/supersede_current; force the confirmation path with a policy-free
    // predicate whose strategy is require_confirmation by construction in the registry test below.
    const outcome = harness.mutation.applyAssertion(preferenceInput(self, berlin, {
      predicate: 'LIVES_IN',
      validFromUtc: '2024-01-01T00:00:00.000Z',
      basis: 'assistant_inference',
      confidence: 0.5,
      actor: { type: 'assistant_proposal', ref: 'conversation_memory_extractor' },
    }));
    // Sensitive inference from a non-explicit basis is held for confirmation.
    assert.equal(outcome.kind, 'requires_confirmation');
    assert.equal(harness.assertions.listBySubject(LOCAL_OWNER_ID, self, 'LIVES_IN').length, 0);
    assert.equal(harness.audit.readGraphVersion(), 0);
  });
});

test('evidence supplied with a proposal is linked to the resulting assertion', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const self = harness.nodeId('person', 'person:self', 'Denys');
    const powershell = harness.nodeId('software', 'software:powershell', 'PowerShell');
    context.database.prepare(`
      INSERT INTO evidence_records (
        id, owner_id, device_id, source_event_id, parent_evidence_id, blob_id, source_type,
        source_ref, captured_at_utc, source_timezone, ingested_at_utc, content_hash, mime_type,
        sensitivity, retention_until_utc, status, metadata_json, created_at_utc, updated_at_utc
      ) VALUES ('evd_a', ?, NULL, 'chat:1', NULL, NULL, 'conversation_message', NULL,
        '2026-08-04T09:00:00.000Z', NULL, '2026-08-04T10:00:00.000Z', 'hash', NULL,
        'personal', NULL, 'active', '{}', '2026-08-04T10:00:00.000Z', '2026-08-04T10:00:00.000Z')
    `).run(LOCAL_OWNER_ID);

    const outcome = harness.mutation.applyAssertion(preferenceInput(self, powershell, {
      evidence: { evidenceId: 'evd_a', stance: 'supports', weight: 0.9 },
    }));
    assert.equal(outcome.kind, 'created');
    if (outcome.kind !== 'created') {
      return;
    }
    const links = harness.assertions.listEvidenceLinks(outcome.assertion.id);
    assert.deepEqual(links.map((link) => link.evidenceId), ['evd_a']);
    assert.equal(links[0]?.stance, 'supports');
  });
});

test('an explicit user correction records the correction and can reach full confidence', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const self = harness.nodeId('person', 'person:self', 'Denys');
    const powershell = harness.nodeId('software', 'software:powershell', 'PowerShell');
    const created = harness.mutation.applyAssertion(preferenceInput(self, powershell, {
      basis: 'passive_observation', confidence: 0.5,
      actor: { type: 'assistant_proposal', ref: 'desktop_observation_extractor' },
    }));
    if (created.kind !== 'created') {
      return;
    }
    assert.equal(created.assertion.confidence, 0.5);

    const confirmed = harness.mutation.confirmAssertion({
      assertionId: created.assertion.id,
      actorRef: 'memory-inspector',
      reason: 'User confirmed in the Memory Inspector.',
    });
    assert.equal(confirmed.assertion.basis, 'explicit_user_statement');
    assert.equal(confirmed.assertion.confidence, 1);
    assert.equal(confirmed.assertion.status, 'active');
    assert.deepEqual(
      harness.audit.listMutations(LOCAL_OWNER_ID, 'graph_assertion', created.assertion.id)
        .map((entry) => entry.operation),
      ['create_assertion', 'confirm_assertion'],
    );
  });
});

test('deleting an assertion retires it, unlinks evidence and logs the deletion', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const self = harness.nodeId('person', 'person:self', 'Denys');
    const powershell = harness.nodeId('software', 'software:powershell', 'PowerShell');
    const created = harness.mutation.applyAssertion(preferenceInput(self, powershell));
    if (created.kind !== 'created') {
      return;
    }
    const versionBefore = harness.audit.readGraphVersion();
    harness.mutation.deleteAssertion({
      assertionId: created.assertion.id,
      actorRef: 'cli',
      reason: 'User asked to forget this.',
    });
    assert.equal(harness.assertions.readAssertion(created.assertion.id)?.status, 'deleted');
    assert.equal(harness.assertions.listEvidenceLinks(created.assertion.id).length, 0);
    assert.equal(harness.audit.readGraphVersion(), versionBefore + 1);
    assert.equal(harness.assertions.searchAssertions(LOCAL_OWNER_ID, 'PowerShell', 10).length, 0);
  });
});

test('confirming or deleting a missing assertion throws', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    assert.throws(
      () => harness.mutation.confirmAssertion({ assertionId: 'ast_x', actorRef: null, reason: 'r' }),
      /Unknown graph assertion: ast_x/u,
    );
    assert.throws(
      () => harness.mutation.deleteAssertion({ assertionId: 'ast_x', actorRef: null, reason: 'r' }),
      /Unknown graph assertion: ast_x/u,
    );
  });
});
```

Note on the `require_confirmation` test: the registry as written in Task 2 gives `LIVES_IN` the strategy `supersede_current`. Change the `LIVES_IN` entry's `conflictStrategy` to `'require_confirmation'` in `src/assistant/domain/relation-types.ts` as part of this task — a first-ever home address inferred from passive evidence must be confirmed, which is exactly design §8.3's "health, finance, relationship, and precise-location candidates require confirmation unless the user stated them explicitly". Update the Task 2 test `sensitive-by-default predicates` if it fails; it asserts sensitivity, not strategy, so it will not.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- assistant-graph-mutation`
Expected: FAIL — `Cannot find module '../src/assistant/graph/mutation.js'`

- [ ] **Step 3: Change `LIVES_IN` conflict strategy in `src/assistant/domain/relation-types.ts`**

```ts
  LIVES_IN: {
    predicate: 'LIVES_IN',
    allowedSubjectTypes: ['person'],
    allowedObjectTypes: ['place'],
    inversePredicate: null,
    cardinality: 'single_current',
    temporal: 'required',
    defaultSensitivity: 'sensitive',
    projectionBehavior: 'dossier',
    conflictStrategy: 'require_confirmation',
  },
```

- [ ] **Step 4: Write `src/assistant/storage/policy-store.ts`**

```ts
import { z } from '../../lib/zod.js';
import { type JsonObject } from '../../lib/json-types.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { AssistantClock } from '../runtime/clock.js';
import { ASSISTANT_ID_PREFIXES, type AssistantIdGenerator } from '../runtime/ids.js';
import {
  PolicySourceSchema,
  PolicyTypeSchema,
  type PolicySource,
  type PolicyType,
} from '../domain/primitives.js';
import { fromSqliteFlag, parseJsonObjectColumn, toSqliteFlag } from './rows.js';

const PolicyRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  policy_type: z.string(),
  key: z.string(),
  value_json: z.string(),
  enabled: z.number(),
  source: z.string(),
  created_at_utc: z.string(),
  updated_at_utc: z.string(),
});

export interface UpsertPolicyInput {
  ownerId: string;
  policyType: PolicyType;
  key: string;
  value: JsonObject;
  enabled: boolean;
  source: PolicySource;
}

export interface AssistantPolicyRecord {
  id: string;
  ownerId: string;
  policyType: PolicyType;
  key: string;
  value: JsonObject;
  enabled: boolean;
  source: PolicySource;
  createdAtUtc: string;
  updatedAtUtc: string;
}

export class AssistantPolicyStore {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly clock: AssistantClock,
    private readonly ids: AssistantIdGenerator,
  ) {}

  upsertPolicy(input: UpsertPolicyInput): AssistantPolicyRecord {
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
      this.ids.next(ASSISTANT_ID_PREFIXES.policy),
      input.ownerId,
      input.policyType,
      input.key,
      JSON.stringify(input.value),
      toSqliteFlag(input.enabled),
      input.source,
      nowUtc,
      nowUtc,
    );
    const record = this.readPolicy(input.ownerId, input.policyType, input.key);
    if (!record) {
      throw new Error(`Failed to persist policy ${input.policyType}:${input.key}`);
    }
    return record;
  }

  readPolicy(ownerId: string, policyType: PolicyType, key: string): AssistantPolicyRecord | null {
    const rawRow = this.database.prepare(`
      SELECT * FROM assistant_policies
      WHERE owner_id = ? AND policy_type = ? AND key = ?
      LIMIT 1
    `).get(ownerId, policyType, key);
    if (rawRow == null) {
      return null;
    }
    return AssistantPolicyStore.mapRow(PolicyRowSchema.parse(rawRow));
  }

  isPolicyActive(ownerId: string, policyType: PolicyType, key: string): boolean {
    const record = this.readPolicy(ownerId, policyType, key);
    return record !== null && record.enabled;
  }

  setPolicyEnabled(
    ownerId: string,
    policyType: PolicyType,
    key: string,
    enabled: boolean,
  ): AssistantPolicyRecord {
    const existing = this.readPolicy(ownerId, policyType, key);
    if (!existing) {
      throw new Error(`Unknown assistant policy: ${policyType}:${key}`);
    }
    this.database.prepare(`
      UPDATE assistant_policies SET enabled = ?, updated_at_utc = ?
      WHERE owner_id = ? AND policy_type = ? AND key = ?
    `).run(toSqliteFlag(enabled), this.clock.nowUtc(), ownerId, policyType, key);
    const updated = this.readPolicy(ownerId, policyType, key);
    if (!updated) {
      throw new Error(`Unknown assistant policy: ${policyType}:${key}`);
    }
    return updated;
  }

  listPolicies(ownerId: string, policyType: PolicyType): readonly AssistantPolicyRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM assistant_policies
      WHERE owner_id = ? AND policy_type = ?
      ORDER BY key
    `).all(ownerId, policyType);
    return rows.map((row) => AssistantPolicyStore.mapRow(PolicyRowSchema.parse(row)));
  }

  deletePolicy(ownerId: string, policyType: PolicyType, key: string): void {
    this.database.prepare(
      'DELETE FROM assistant_policies WHERE owner_id = ? AND policy_type = ? AND key = ?',
    ).run(ownerId, policyType, key);
  }

  private static mapRow(row: z.infer<typeof PolicyRowSchema>): AssistantPolicyRecord {
    return {
      id: row.id,
      ownerId: row.owner_id,
      policyType: PolicyTypeSchema.parse(row.policy_type),
      key: row.key,
      value: parseJsonObjectColumn(row.value_json),
      enabled: fromSqliteFlag(row.enabled),
      source: PolicySourceSchema.parse(row.source),
      createdAtUtc: row.created_at_utc,
      updatedAtUtc: row.updated_at_utc,
    };
  }
}
```

- [ ] **Step 5: Write `src/assistant/graph/mutation.ts`**

```ts
import { type JsonObject } from '../../lib/json-types.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { RelationType } from '../domain/relation-types.js';
import {
  type AssertionBasis,
  type EvidenceStance,
  type MutationActorType,
  type Sensitivity,
} from '../domain/primitives.js';
import { EXPLICIT_CORRECTION_CEILING, isExplicitBasis, outranks } from '../domain/confidence.js';
import { buildLiteralObjectKey, buildNodeObjectKey, computeAssertionKey, type LiteralObjectValue } from '../domain/keys.js';
import type { GraphNodeStore, GraphNodeRecord } from '../storage/node-store.js';
import type { GraphAssertionRecord, GraphAssertionStore } from '../storage/assertion-store.js';
import type { AssistantAuditStore } from '../storage/audit-store.js';
import type { AssistantPolicyStore } from '../storage/policy-store.js';
import type { AssertionValidationError, GraphAssertionValidator } from './validation.js';

export type MutationAssertionObject =
  | { kind: 'node'; nodeId: string }
  | { kind: 'literal'; value: LiteralObjectValue };

export interface AssertionEvidenceInput {
  evidenceId: string;
  stance: EvidenceStance;
  weight: number;
}

export interface ApplyAssertionInput {
  ownerId: string;
  subjectNodeId: string;
  predicate: string;
  object: MutationAssertionObject;
  scopeNodeId: string | null;
  basis: AssertionBasis;
  confidence: number;
  sensitivity: Sensitivity | null;
  validFromUtc: string | null;
  validToUtc: string | null;
  observedAtUtc: string;
  attributes: JsonObject;
  actor: { type: MutationActorType; ref: string | null };
  reason: string;
  evidence: AssertionEvidenceInput | null;
}

export type GraphMutationOutcome =
  | { kind: 'created'; assertion: GraphAssertionRecord; graphVersion: number }
  | { kind: 'reinforced'; assertion: GraphAssertionRecord; graphVersion: number }
  | {
      kind: 'superseded';
      assertion: GraphAssertionRecord;
      supersededAssertionId: string;
      graphVersion: number;
    }
  | { kind: 'disputed'; assertions: readonly GraphAssertionRecord[]; graphVersion: number }
  | { kind: 'rejected'; errors: readonly AssertionValidationError[] }
  | { kind: 'blocked_by_explicit_memory'; incumbentAssertionId: string }
  | { kind: 'blocked_by_lock'; incumbentAssertionId: string }
  | { kind: 'requires_confirmation' };

export interface ConfirmAssertionInput {
  assertionId: string;
  actorRef: string | null;
  reason: string;
}

export interface ConfirmAssertionOutcome {
  assertion: GraphAssertionRecord;
  graphVersion: number;
}

export interface DeleteAssertionInput {
  assertionId: string;
  actorRef: string | null;
  reason: string;
}

// Deterministic writer for the graph. Models propose; this class decides and writes. Every public
// method runs in one transaction and bumps the graph version exactly once when it changes state.
export class GraphMutationService {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly nodes: GraphNodeStore,
    private readonly assertions: GraphAssertionStore,
    private readonly audit: AssistantAuditStore,
    private readonly policies: AssistantPolicyStore,
    private readonly validator: GraphAssertionValidator,
  ) {}

  applyAssertion(input: ApplyAssertionInput): GraphMutationOutcome {
    const subjectNode = this.requireNode(input.subjectNodeId);
    const objectNode = input.object.kind === 'node' ? this.requireNode(input.object.nodeId) : null;
    const scopeNode = input.scopeNodeId === null ? null : this.requireNode(input.scopeNodeId);

    const validation = this.validator.validate({
      ownerId: input.ownerId,
      subjectNode,
      predicate: input.predicate,
      object: objectNode === null && input.object.kind === 'literal'
        ? { kind: 'literal', value: input.object.value }
        : { kind: 'node', node: this.requireNodeRecord(objectNode) },
      scopeNode,
      basis: input.basis,
      confidence: input.confidence,
      sensitivity: input.sensitivity,
      validFromUtc: input.validFromUtc,
      validToUtc: input.validToUtc,
    });
    if (!validation.ok) {
      return { kind: 'rejected', errors: validation.errors };
    }
    const normalized = validation.normalized;
    const objectKey = input.object.kind === 'node'
      ? buildNodeObjectKey(input.object.nodeId)
      : buildLiteralObjectKey(input.object.value);
    const assertionKey = computeAssertionKey({
      ownerId: input.ownerId,
      subjectNodeId: input.subjectNodeId,
      predicate: normalized.predicate,
      objectKey,
      scopeNodeId: input.scopeNodeId,
    });

    const identical = this.assertions.findLiveByKey(input.ownerId, assertionKey);
    if (identical) {
      return this.runTransaction(() => {
        const reinforced = this.assertions.reinforceAssertion(identical.id, {
          confidence: Math.max(identical.confidence, normalized.confidence),
          observedAtUtc: input.observedAtUtc,
        });
        this.linkEvidence(reinforced.id, input.evidence);
        this.audit.recordMutation({
          ownerId: input.ownerId,
          actorType: input.actor.type,
          actorRef: input.actor.ref,
          operation: 'update_assertion',
          targetType: 'graph_assertion',
          targetId: reinforced.id,
          before: { confidence: identical.confidence, lastObservedAtUtc: identical.lastObservedAtUtc },
          after: { confidence: reinforced.confidence, lastObservedAtUtc: reinforced.lastObservedAtUtc },
          reason: input.reason,
        });
        return { kind: 'reinforced', assertion: reinforced, graphVersion: this.audit.incrementGraphVersion() };
      });
    }

    const incumbent = this.findCompetingAssertion(input, normalized.predicate);
    if (incumbent === null || normalized.definition.conflictStrategy === 'coexist') {
      if (normalized.definition.conflictStrategy === 'require_confirmation' && !isExplicitBasis(input.basis)) {
        return { kind: 'requires_confirmation' };
      }
      return this.createAssertion(input, normalized, null);
    }

    if (normalized.definition.conflictStrategy === 'require_confirmation' && !isExplicitBasis(input.basis)) {
      return { kind: 'requires_confirmation' };
    }

    const automatic = input.actor.type !== 'user';
    if (automatic && this.isLocked(input.ownerId, incumbent)) {
      return { kind: 'blocked_by_lock', incumbentAssertionId: incumbent.id };
    }

    const challengerWins = outranks(
      { basis: input.basis, confidence: normalized.confidence },
      { basis: incumbent.basis, confidence: incumbent.confidence },
    );
    if (challengerWins) {
      return this.createAssertion(input, normalized, incumbent);
    }
    if (isExplicitBasis(incumbent.basis) && !isExplicitBasis(input.basis)) {
      return { kind: 'blocked_by_explicit_memory', incumbentAssertionId: incumbent.id };
    }
    return this.markDisputed(input, normalized, incumbent);
  }

  confirmAssertion(input: ConfirmAssertionInput): ConfirmAssertionOutcome {
    const before = this.requireAssertion(input.assertionId);
    return this.runTransaction(() => {
      this.database.prepare(`
        UPDATE graph_assertions
        SET basis = 'explicit_user_statement', confidence = ?, status = 'active', retired_at_utc = NULL
        WHERE id = ?
      `).run(EXPLICIT_CORRECTION_CEILING, input.assertionId);
      const after = this.assertions.setStatus(input.assertionId, 'active');
      this.audit.recordMutation({
        ownerId: before.ownerId,
        actorType: 'user',
        actorRef: input.actorRef,
        operation: 'confirm_assertion',
        targetType: 'graph_assertion',
        targetId: input.assertionId,
        before: { basis: before.basis, confidence: before.confidence },
        after: { basis: after.basis, confidence: after.confidence },
        reason: input.reason,
      });
      return { assertion: after, graphVersion: this.audit.incrementGraphVersion() };
    });
  }

  deleteAssertion(input: DeleteAssertionInput): ConfirmAssertionOutcome {
    const before = this.requireAssertion(input.assertionId);
    return this.runTransaction(() => {
      this.database.prepare('DELETE FROM assertion_evidence WHERE assertion_id = ?').run(input.assertionId);
      const after = this.assertions.retireAssertion(input.assertionId, 'deleted', null);
      this.audit.recordMutation({
        ownerId: before.ownerId,
        actorType: 'user',
        actorRef: input.actorRef,
        operation: 'delete_assertion',
        targetType: 'graph_assertion',
        targetId: input.assertionId,
        before: { status: before.status },
        after: { status: after.status },
        reason: input.reason,
      });
      return { assertion: after, graphVersion: this.audit.incrementGraphVersion() };
    });
  }

  private createAssertion(
    input: ApplyAssertionInput,
    normalized: { predicate: RelationType; confidence: number; sensitivity: Sensitivity },
    incumbent: GraphAssertionRecord | null,
  ): GraphMutationOutcome {
    return this.runTransaction(() => {
      const created = this.assertions.createAssertion({
        ownerId: input.ownerId,
        subjectNodeId: input.subjectNodeId,
        predicate: normalized.predicate,
        object: input.object.kind === 'node'
          ? { kind: 'node', nodeId: input.object.nodeId }
          : { kind: 'literal', value: input.object.value },
        scopeNodeId: input.scopeNodeId,
        basis: input.basis,
        confidence: normalized.confidence,
        sensitivity: normalized.sensitivity,
        validFromUtc: input.validFromUtc,
        validToUtc: input.validToUtc,
        observedAtUtc: input.observedAtUtc,
        attributes: input.attributes,
        supersedesAssertionId: incumbent?.id ?? null,
      });
      this.linkEvidence(created.id, input.evidence);
      this.audit.recordMutation({
        ownerId: input.ownerId,
        actorType: input.actor.type,
        actorRef: input.actor.ref,
        operation: 'create_assertion',
        targetType: 'graph_assertion',
        targetId: created.id,
        before: null,
        after: { status: created.status, confidence: created.confidence },
        reason: input.reason,
      });
      if (incumbent === null) {
        return { kind: 'created', assertion: created, graphVersion: this.audit.incrementGraphVersion() };
      }
      const retired = this.assertions.retireAssertion(incumbent.id, 'superseded', input.validFromUtc);
      this.audit.recordMutation({
        ownerId: input.ownerId,
        actorType: input.actor.type,
        actorRef: input.actor.ref,
        operation: 'supersede_assertion',
        targetType: 'graph_assertion',
        targetId: incumbent.id,
        before: { status: incumbent.status },
        after: { status: retired.status, supersededBy: created.id },
        reason: input.reason,
      });
      return {
        kind: 'superseded',
        assertion: created,
        supersededAssertionId: incumbent.id,
        graphVersion: this.audit.incrementGraphVersion(),
      };
    });
  }

  private markDisputed(
    input: ApplyAssertionInput,
    normalized: { predicate: RelationType; confidence: number; sensitivity: Sensitivity },
    incumbent: GraphAssertionRecord,
  ): GraphMutationOutcome {
    return this.runTransaction(() => {
      const created = this.assertions.createAssertion({
        ownerId: input.ownerId,
        subjectNodeId: input.subjectNodeId,
        predicate: normalized.predicate,
        object: input.object.kind === 'node'
          ? { kind: 'node', nodeId: input.object.nodeId }
          : { kind: 'literal', value: input.object.value },
        scopeNodeId: input.scopeNodeId,
        basis: input.basis,
        confidence: normalized.confidence,
        sensitivity: normalized.sensitivity,
        validFromUtc: input.validFromUtc,
        validToUtc: input.validToUtc,
        observedAtUtc: input.observedAtUtc,
        attributes: input.attributes,
        supersedesAssertionId: null,
      });
      this.linkEvidence(created.id, input.evidence);
      const disputedIncumbent = this.assertions.setStatus(incumbent.id, 'disputed');
      const disputedChallenger = this.assertions.setStatus(created.id, 'disputed');
      for (const target of [disputedIncumbent, disputedChallenger]) {
        this.audit.recordMutation({
          ownerId: input.ownerId,
          actorType: input.actor.type,
          actorRef: input.actor.ref,
          operation: 'dispute_assertion',
          targetType: 'graph_assertion',
          targetId: target.id,
          before: { status: 'active' },
          after: { status: 'disputed' },
          reason: input.reason,
        });
      }
      return {
        kind: 'disputed',
        assertions: [disputedIncumbent, disputedChallenger],
        graphVersion: this.audit.incrementGraphVersion(),
      };
    });
  }

  // Competition is scoped by cardinality: single_current competes across the whole subject and
  // predicate, single_per_scope only within the same scope, and append_only never competes.
  private findCompetingAssertion(
    input: ApplyAssertionInput,
    predicate: RelationType,
  ): GraphAssertionRecord | null {
    const live = this.assertions.listBySubject(input.ownerId, input.subjectNodeId, predicate);
    for (const candidate of live) {
      if (candidate.scopeNodeId !== input.scopeNodeId) {
        continue;
      }
      return candidate;
    }
    return null;
  }

  private isLocked(ownerId: string, assertion: GraphAssertionRecord): boolean {
    return assertion.pinned
      || this.policies.isPolicyActive(ownerId, 'assertion_lock', assertion.id);
  }

  private linkEvidence(assertionId: string, evidence: AssertionEvidenceInput | null): void {
    if (evidence === null) {
      return;
    }
    this.assertions.linkEvidence(assertionId, evidence.evidenceId, evidence.stance, evidence.weight);
  }

  private requireNode(nodeId: string): GraphNodeRecord {
    const node = this.nodes.readNode(nodeId);
    if (!node) {
      throw new Error(`Unknown graph node: ${nodeId}`);
    }
    return node;
  }

  private requireNodeRecord(node: GraphNodeRecord | null): GraphNodeRecord {
    if (!node) {
      throw new Error('Expected a resolved object node for a node-object assertion');
    }
    return node;
  }

  private requireAssertion(assertionId: string): GraphAssertionRecord {
    const assertion = this.assertions.readAssertion(assertionId);
    if (!assertion) {
      throw new Error(`Unknown graph assertion: ${assertionId}`);
    }
    return assertion;
  }

  private runTransaction<T>(body: () => T): T {
    return this.database.transaction(body)();
  }
}
```

Two implementation notes for the engineer:

1. `findCompetingAssertion` above returns the first live assertion sharing subject, predicate and
   scope. For `append_only` and `many` cardinalities the caller must never reach the conflict path
   — guard it explicitly at the top of the conflict branch:

```ts
    const competesByCardinality = normalized.definition.cardinality === 'single_current'
      || normalized.definition.cardinality === 'single_per_scope';
    const incumbent = competesByCardinality
      ? this.findCompetingAssertion(input, normalized.predicate)
      : null;
```

   Use this instead of the plain call, so `USES` and `VISITED` accumulate rather than compete.

2. The object argument passed to the validator must not silently coerce. Replace the inline
   conditional with an explicit branch:

```ts
    const validatorObject = input.object.kind === 'literal'
      ? { kind: 'literal', value: input.object.value } as const
      : { kind: 'node', node: this.requireNodeRecord(objectNode) } as const;
```

   and pass `validatorObject` to `this.validator.validate({ ..., object: validatorObject, ... })`.

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- assistant-graph-mutation`
Expected: PASS — 15 tests

- [ ] **Step 7: Re-run the registry tests to confirm the LIVES_IN change is consistent**

Run: `npm test -- assistant-domain-registries`
Expected: PASS — 12 tests

- [ ] **Step 8: Commit**

```bash
git add src/assistant/storage/policy-store.ts src/assistant/graph/mutation.ts src/assistant/domain/relation-types.ts tests/assistant-graph-mutation.test.ts
git commit -m "feat(assistant): add policy store and deterministic graph mutation service"
```

---

## Task 15: Entity resolution

Design §9.1. The resolution order is deterministic and stops at the first hit. Name similarity alone never merges entities — every match in Gate A is an exact normalized match, a canonical key, or a scored suggestion that clears a fixed threshold.

**Files:**
- Create: `src/assistant/graph/entity-resolution.ts`
- Test: `tests/assistant-entity-resolution.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/assistant-entity-resolution.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EntityResolver,
  MODEL_SUGGESTION_SCORE_THRESHOLD,
  RESOLUTION_STEPS,
} from '../src/assistant/graph/entity-resolution.js';
import { GraphNodeStore } from '../src/assistant/storage/node-store.js';
import { LOCAL_OWNER_ID } from '../src/assistant/storage/schema.js';
import { FixedAssistantClock } from '../src/assistant/runtime/clock.js';
import { SequentialAssistantIdGenerator } from '../src/assistant/runtime/ids.js';
import { withAssistantRepo, type AssistantFixtureContext } from './helpers/assistant-fixture.js';

interface Harness {
  nodes: GraphNodeStore;
  resolver: EntityResolver;
}

function buildHarness(context: AssistantFixtureContext): Harness {
  const nodes = new GraphNodeStore(
    context.database,
    new FixedAssistantClock('2026-08-04T10:00:00.000Z'),
    new SequentialAssistantIdGenerator(),
  );
  return { nodes, resolver: new EntityResolver(nodes) };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    ownerId: LOCAL_OWNER_ID,
    type: 'software',
    displayName: 'Visual Studio Code',
    canonicalKey: null,
    suggestedNodeId: null,
    suggestionScore: 0,
    allowCreate: true,
    sensitivity: 'low',
    ...overrides,
  } as const;
}

test('a canonical key match resolves first and wins over every later step', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const node = harness.nodes.createNode({
      ownerId: LOCAL_OWNER_ID, type: 'software', canonicalKey: 'software:visual-studio-code',
      displayName: 'Visual Studio Code', description: null, sensitivity: 'low', properties: {},
    });
    const decoy = harness.nodes.createNode({
      ownerId: LOCAL_OWNER_ID, type: 'software', canonicalKey: 'software:decoy',
      displayName: 'Visual Studio Code', description: null, sensitivity: 'low', properties: {},
    });
    harness.nodes.addAlias({
      ownerId: LOCAL_OWNER_ID, nodeId: decoy.id, alias: 'Visual Studio Code',
      aliasType: 'user_supplied', sourceEvidenceId: null,
    });

    const result = harness.resolver.resolve(request({ canonicalKey: 'software:visual-studio-code' }));
    assert.equal(result.kind, 'matched');
    if (result.kind === 'matched') {
      assert.equal(result.node.id, node.id);
      assert.equal(result.step, 'canonical_key');
    }
  });
});

test('a user-supplied alias outranks a machine-derived alias', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const machine = harness.nodes.createNode({
      ownerId: LOCAL_OWNER_ID, type: 'software', canonicalKey: 'software:a',
      displayName: 'Editor A', description: null, sensitivity: 'low', properties: {},
    });
    const user = harness.nodes.createNode({
      ownerId: LOCAL_OWNER_ID, type: 'software', canonicalKey: 'software:b',
      displayName: 'Editor B', description: null, sensitivity: 'low', properties: {},
    });
    harness.nodes.addAlias({
      ownerId: LOCAL_OWNER_ID, nodeId: machine.id, alias: 'my editor',
      aliasType: 'name', sourceEvidenceId: null,
    });
    harness.nodes.addAlias({
      ownerId: LOCAL_OWNER_ID, nodeId: user.id, alias: 'my editor',
      aliasType: 'user_supplied', sourceEvidenceId: null,
    });

    const result = harness.resolver.resolve(request({ displayName: 'My Editor' }));
    assert.equal(result.kind, 'matched');
    if (result.kind === 'matched') {
      assert.equal(result.node.id, user.id);
      assert.equal(result.step, 'user_alias');
    }
  });
});

test('an exact normalized alias with a compatible type matches', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const node = harness.nodes.createNode({
      ownerId: LOCAL_OWNER_ID, type: 'software', canonicalKey: 'software:vscode',
      displayName: 'Visual Studio Code', description: null, sensitivity: 'low', properties: {},
    });
    harness.nodes.addAlias({
      ownerId: LOCAL_OWNER_ID, nodeId: node.id, alias: 'VS Code',
      aliasType: 'name', sourceEvidenceId: null,
    });
    const result = harness.resolver.resolve(request({ displayName: '  vs   code ' }));
    assert.equal(result.kind, 'matched');
    if (result.kind === 'matched') {
      assert.equal(result.node.id, node.id);
      assert.equal(result.step, 'normalized_alias');
    }
  });
});

test('an alias on an incompatible node type does not match', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const topic = harness.nodes.createNode({
      ownerId: LOCAL_OWNER_ID, type: 'topic', canonicalKey: 'topic:vscode',
      displayName: 'VS Code', description: null, sensitivity: 'low', properties: {},
    });
    harness.nodes.addAlias({
      ownerId: LOCAL_OWNER_ID, nodeId: topic.id, alias: 'VS Code',
      aliasType: 'name', sourceEvidenceId: null,
    });
    const result = harness.resolver.resolve(request({ displayName: 'VS Code', allowCreate: false }));
    assert.equal(result.kind, 'needs_confirmation');
  });
});

test('a unique display-name match of the right type resolves contextually', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const node = harness.nodes.createNode({
      ownerId: LOCAL_OWNER_ID, type: 'software', canonicalKey: null,
      displayName: 'Neovim', description: null, sensitivity: 'low', properties: {},
    });
    const result = harness.resolver.resolve(request({ displayName: 'neovim' }));
    assert.equal(result.kind, 'matched');
    if (result.kind === 'matched') {
      assert.equal(result.node.id, node.id);
      assert.equal(result.step, 'contextual_match');
    }
  });
});

test('two equally named nodes of the same type are ambiguous, never merged', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const first = harness.nodes.createNode({
      ownerId: LOCAL_OWNER_ID, type: 'person', canonicalKey: null,
      displayName: 'Alex', description: null, sensitivity: 'personal', properties: {},
    });
    const second = harness.nodes.createNode({
      ownerId: LOCAL_OWNER_ID, type: 'person', canonicalKey: null,
      displayName: 'alex', description: null, sensitivity: 'personal', properties: {},
    });
    const result = harness.resolver.resolve(request({ type: 'person', displayName: 'Alex' }));
    assert.equal(result.kind, 'ambiguous');
    if (result.kind === 'ambiguous') {
      assert.deepEqual([...result.candidates.map((node) => node.id)].sort(), [first.id, second.id].sort());
    }
  });
});

test('a model suggestion resolves only at or above the score threshold', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const node = harness.nodes.createNode({
      ownerId: LOCAL_OWNER_ID, type: 'software', canonicalKey: null,
      displayName: 'JetBrains Rider', description: null, sensitivity: 'low', properties: {},
    });
    const accepted = harness.resolver.resolve(request({
      displayName: 'Rider IDE',
      suggestedNodeId: node.id,
      suggestionScore: MODEL_SUGGESTION_SCORE_THRESHOLD,
      allowCreate: false,
    }));
    assert.equal(accepted.kind, 'matched');
    if (accepted.kind === 'matched') {
      assert.equal(accepted.step, 'suggested_match');
    }

    const rejected = harness.resolver.resolve(request({
      displayName: 'Rider IDE',
      suggestedNodeId: node.id,
      suggestionScore: MODEL_SUGGESTION_SCORE_THRESHOLD - 0.01,
      allowCreate: false,
    }));
    assert.equal(rejected.kind, 'needs_confirmation');
  });
});

test('a suggestion pointing at a wrong-type or missing node is ignored', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const topic = harness.nodes.createNode({
      ownerId: LOCAL_OWNER_ID, type: 'topic', canonicalKey: null,
      displayName: 'Editors', description: null, sensitivity: 'low', properties: {},
    });
    assert.equal(
      harness.resolver.resolve(request({
        suggestedNodeId: topic.id, suggestionScore: 0.99, allowCreate: false,
      })).kind,
      'needs_confirmation',
    );
    assert.equal(
      harness.resolver.resolve(request({
        suggestedNodeId: 'nod_missing', suggestionScore: 0.99, allowCreate: false,
      })).kind,
      'needs_confirmation',
    );
  });
});

test('when nothing matches a new node is created with the requested attributes', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const result = harness.resolver.resolve(request({
      displayName: 'Zed', canonicalKey: 'software:zed', sensitivity: 'personal',
    }));
    assert.equal(result.kind, 'created');
    if (result.kind !== 'created') {
      return;
    }
    assert.equal(result.node.displayName, 'Zed');
    assert.equal(result.node.canonicalKey, 'software:zed');
    assert.equal(result.node.sensitivity, 'personal');
    // The display name becomes a searchable alias so the next resolution hits step 3.
    assert.deepEqual(
      harness.nodes.listAliases(result.node.id).map((alias) => alias.normalizedAlias),
      ['zed'],
    );
  });
});

test('creation is refused when allowCreate is false', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const result = harness.resolver.resolve(request({ displayName: 'Zed', allowCreate: false }));
    assert.equal(result.kind, 'needs_confirmation');
    if (result.kind === 'needs_confirmation') {
      assert.match(result.reason, /No node matched and creation was not permitted/u);
    }
  });
});

test('an empty display name is refused', () => {
  withAssistantRepo((context) => {
    const result = buildHarness(context).resolver.resolve(request({ displayName: '   ' }));
    assert.equal(result.kind, 'needs_confirmation');
    if (result.kind === 'needs_confirmation') {
      assert.match(result.reason, /empty display name/u);
    }
  });
});

test('resolution steps are declared in design order', () => {
  assert.deepEqual(RESOLUTION_STEPS, [
    'canonical_key', 'user_alias', 'normalized_alias', 'contextual_match', 'suggested_match',
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- assistant-entity-resolution`
Expected: FAIL — `Cannot find module '../src/assistant/graph/entity-resolution.js'`

- [ ] **Step 3: Write `src/assistant/graph/entity-resolution.ts`**

```ts
import { z } from '../../lib/zod.js';
import type { NodeType } from '../domain/node-types.js';
import type { Sensitivity } from '../domain/primitives.js';
import { normalizeAlias } from '../domain/keys.js';
import type { GraphNodeRecord, GraphNodeStore } from '../storage/node-store.js';

export const RESOLUTION_STEPS = [
  'canonical_key',
  'user_alias',
  'normalized_alias',
  'contextual_match',
  'suggested_match',
] as const;
export const ResolutionStepSchema = z.enum(RESOLUTION_STEPS);
export type ResolutionStep = z.infer<typeof ResolutionStepSchema>;

// A model suggestion below this deterministic threshold never resolves on its own.
export const MODEL_SUGGESTION_SCORE_THRESHOLD = 0.85;

export interface EntityResolutionRequest {
  ownerId: string;
  type: NodeType;
  displayName: string;
  canonicalKey: string | null;
  suggestedNodeId: string | null;
  suggestionScore: number;
  allowCreate: boolean;
  sensitivity: Sensitivity;
}

export type EntityResolution =
  | { kind: 'matched'; node: GraphNodeRecord; step: ResolutionStep }
  | { kind: 'created'; node: GraphNodeRecord }
  | { kind: 'ambiguous'; candidates: readonly GraphNodeRecord[] }
  | { kind: 'needs_confirmation'; reason: string };

export class EntityResolver {
  constructor(private readonly nodes: GraphNodeStore) {}

  resolve(request: EntityResolutionRequest): EntityResolution {
    const normalizedName = normalizeAlias(request.displayName);
    if (!normalizedName) {
      return { kind: 'needs_confirmation', reason: 'Cannot resolve an entity from an empty display name.' };
    }

    const byCanonicalKey = this.matchCanonicalKey(request);
    if (byCanonicalKey) {
      return { kind: 'matched', node: byCanonicalKey, step: 'canonical_key' };
    }

    const aliasMatches = this.nodes
      .findNodesByAlias(request.ownerId, normalizedName)
      .filter((node) => node.type === request.type);
    const userAliasMatches = aliasMatches.filter(
      (node) => this.hasUserSuppliedAlias(node.id, normalizedName),
    );
    if (userAliasMatches.length === 1) {
      return { kind: 'matched', node: userAliasMatches[0], step: 'user_alias' };
    }
    if (userAliasMatches.length > 1) {
      return { kind: 'ambiguous', candidates: userAliasMatches };
    }
    if (aliasMatches.length === 1) {
      return { kind: 'matched', node: aliasMatches[0], step: 'normalized_alias' };
    }
    if (aliasMatches.length > 1) {
      return { kind: 'ambiguous', candidates: aliasMatches };
    }

    const nameMatches = this.nodes
      .listNodesByType(request.ownerId, request.type)
      .filter((node) => normalizeAlias(node.displayName) === normalizedName);
    if (nameMatches.length === 1) {
      return { kind: 'matched', node: nameMatches[0], step: 'contextual_match' };
    }
    if (nameMatches.length > 1) {
      return { kind: 'ambiguous', candidates: nameMatches };
    }

    const suggested = this.matchSuggestion(request);
    if (suggested) {
      return { kind: 'matched', node: suggested, step: 'suggested_match' };
    }

    if (!request.allowCreate) {
      return {
        kind: 'needs_confirmation',
        reason: `No node matched and creation was not permitted for ${request.type} "${request.displayName}".`,
      };
    }
    return { kind: 'created', node: this.createNode(request) };
  }

  private matchCanonicalKey(request: EntityResolutionRequest): GraphNodeRecord | null {
    if (request.canonicalKey === null) {
      return null;
    }
    return this.nodes.findByCanonicalKey(request.ownerId, request.type, request.canonicalKey);
  }

  private hasUserSuppliedAlias(nodeId: string, normalizedAlias: string): boolean {
    return this.nodes.listAliases(nodeId).some(
      (alias) => alias.normalizedAlias === normalizedAlias && alias.aliasType === 'user_supplied',
    );
  }

  private matchSuggestion(request: EntityResolutionRequest): GraphNodeRecord | null {
    if (request.suggestedNodeId === null || request.suggestionScore < MODEL_SUGGESTION_SCORE_THRESHOLD) {
      return null;
    }
    const node = this.nodes.readNode(request.suggestedNodeId);
    if (!node || node.status !== 'active' || node.type !== request.type || node.ownerId !== request.ownerId) {
      return null;
    }
    return node;
  }

  private createNode(request: EntityResolutionRequest): GraphNodeRecord {
    const node = this.nodes.createNode({
      ownerId: request.ownerId,
      type: request.type,
      canonicalKey: request.canonicalKey,
      displayName: request.displayName.trim(),
      description: null,
      sensitivity: request.sensitivity,
      properties: {},
    });
    this.nodes.addAlias({
      ownerId: request.ownerId,
      nodeId: node.id,
      alias: request.displayName,
      aliasType: 'name',
      sourceEvidenceId: null,
    });
    return node;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- assistant-entity-resolution`
Expected: PASS — 12 tests

- [ ] **Step 5: Commit**

```bash
git add src/assistant/graph/entity-resolution.ts tests/assistant-entity-resolution.test.ts
git commit -m "feat(assistant): add deterministic entity resolver with ordered match steps"
```

---

## Task 16: Reversible node merge

Design §9.2 (merge safety and reversibility), §17.1 (entity merge corruption, cycle detection), §19.2 (property test: no merge cycles).

**Files:**
- Modify: `src/assistant/storage/assertion-store.ts` (add `repointAssertion`)
- Create: `src/assistant/graph/merge.ts`
- Test: `tests/assistant-node-merge.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/assistant-node-merge.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeMergeService, MERGE_BLOCK_REASONS } from '../src/assistant/graph/merge.js';
import { GraphMutationService } from '../src/assistant/graph/mutation.js';
import { GraphAssertionValidator } from '../src/assistant/graph/validation.js';
import { GraphNodeStore } from '../src/assistant/storage/node-store.js';
import { GraphAssertionStore } from '../src/assistant/storage/assertion-store.js';
import { AssistantAuditStore } from '../src/assistant/storage/audit-store.js';
import { AssistantPolicyStore } from '../src/assistant/storage/policy-store.js';
import { LOCAL_OWNER_ID } from '../src/assistant/storage/schema.js';
import { FixedAssistantClock } from '../src/assistant/runtime/clock.js';
import { SequentialAssistantIdGenerator } from '../src/assistant/runtime/ids.js';
import type { NodeType } from '../src/assistant/domain/node-types.js';
import { withAssistantRepo, type AssistantFixtureContext } from './helpers/assistant-fixture.js';

interface Harness {
  nodes: GraphNodeStore;
  assertions: GraphAssertionStore;
  audit: AssistantAuditStore;
  policies: AssistantPolicyStore;
  mutation: GraphMutationService;
  merge: NodeMergeService;
  makeNode: (type: NodeType, key: string | null, name: string) => string;
}

function buildHarness(context: AssistantFixtureContext): Harness {
  const clock = new FixedAssistantClock('2026-08-04T10:00:00.000Z');
  const ids = new SequentialAssistantIdGenerator();
  const nodes = new GraphNodeStore(context.database, clock, ids);
  const assertions = new GraphAssertionStore(context.database, clock, ids);
  const audit = new AssistantAuditStore(context.database, clock, ids);
  const policies = new AssistantPolicyStore(context.database, clock, ids);
  const mutation = new GraphMutationService(
    context.database, nodes, assertions, audit, policies, new GraphAssertionValidator(),
  );
  return {
    nodes,
    assertions,
    audit,
    policies,
    mutation,
    merge: new NodeMergeService(context.database, nodes, assertions, audit, policies, ids, clock),
    makeNode: (type, key, name) => nodes.createNode({
      ownerId: LOCAL_OWNER_ID, type, canonicalKey: key, displayName: name,
      description: null, sensitivity: 'low', properties: {},
    }).id,
  };
}

function usesInput(subjectNodeId: string, objectNodeId: string) {
  return {
    ownerId: LOCAL_OWNER_ID,
    subjectNodeId,
    predicate: 'USES',
    object: { kind: 'node', nodeId: objectNodeId },
    scopeNodeId: null,
    basis: 'explicit_user_statement',
    confidence: 0.9,
    sensitivity: null,
    validFromUtc: null,
    validToUtc: null,
    observedAtUtc: '2026-08-04T09:00:00.000Z',
    attributes: {},
    actor: { type: 'user', ref: 'chat' },
    reason: 'Stated in conversation.',
    evidence: null,
  } as const;
}

test('a merge moves aliases and re-points assertions onto the target', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const self = harness.makeNode('person', 'person:self', 'Denys');
    const source = harness.makeNode('software', null, 'VSCode');
    const target = harness.makeNode('software', 'software:visual-studio-code', 'Visual Studio Code');
    harness.nodes.addAlias({
      ownerId: LOCAL_OWNER_ID, nodeId: source, alias: 'vscode', aliasType: 'name', sourceEvidenceId: null,
    });
    const created = harness.mutation.applyAssertion(usesInput(self, source));
    if (created.kind !== 'created') {
      return;
    }
    const versionBefore = harness.audit.readGraphVersion();

    const outcome = harness.merge.mergeNodes({
      ownerId: LOCAL_OWNER_ID, sourceNodeId: source, targetNodeId: target,
      basis: 'user_confirmed_duplicate', actorType: 'user', actorRef: 'memory-inspector',
      reason: 'Same editor.',
    });
    assert.equal(outcome.kind, 'merged');
    if (outcome.kind !== 'merged') {
      return;
    }
    assert.equal(harness.audit.readGraphVersion(), versionBefore + 1);
    assert.equal(harness.nodes.readNode(source)?.status, 'merged');
    assert.equal(harness.nodes.readNode(source)?.mergedIntoNodeId, target);
    assert.deepEqual(
      harness.nodes.listAliases(target).map((alias) => alias.normalizedAlias).sort(),
      ['vscode'],
    );
    assert.equal(harness.assertions.readAssertion(created.assertion.id)?.objectNodeId, target);
    assert.deepEqual(outcome.movedAssertionIds, [created.assertion.id]);
    assert.deepEqual(outcome.retiredAssertionIds, []);
  });
});

test('a merge that would collide with an identical target assertion retires the moved one', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const self = harness.makeNode('person', 'person:self', 'Denys');
    const source = harness.makeNode('software', null, 'VSCode');
    const target = harness.makeNode('software', 'software:visual-studio-code', 'Visual Studio Code');
    const fromSource = harness.mutation.applyAssertion(usesInput(self, source));
    const fromTarget = harness.mutation.applyAssertion(usesInput(self, target));
    if (fromSource.kind !== 'created' || fromTarget.kind !== 'created') {
      return;
    }

    const outcome = harness.merge.mergeNodes({
      ownerId: LOCAL_OWNER_ID, sourceNodeId: source, targetNodeId: target,
      basis: 'user_confirmed_duplicate', actorType: 'user', actorRef: null, reason: 'Same editor.',
    });
    assert.equal(outcome.kind, 'merged');
    if (outcome.kind !== 'merged') {
      return;
    }
    assert.deepEqual(outcome.retiredAssertionIds, [fromSource.assertion.id]);
    assert.equal(harness.assertions.readAssertion(fromSource.assertion.id)?.status, 'superseded');
    assert.equal(harness.assertions.readAssertion(fromTarget.assertion.id)?.status, 'active');
    assert.equal(harness.assertions.listBySubject(LOCAL_OWNER_ID, self, 'USES').length, 1);
  });
});

test('unmerge restores the source node, its aliases and its assertions', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const self = harness.makeNode('person', 'person:self', 'Denys');
    const source = harness.makeNode('software', null, 'VSCode');
    const target = harness.makeNode('software', 'software:visual-studio-code', 'Visual Studio Code');
    harness.nodes.addAlias({
      ownerId: LOCAL_OWNER_ID, nodeId: source, alias: 'vscode', aliasType: 'name', sourceEvidenceId: null,
    });
    const fromSource = harness.mutation.applyAssertion(usesInput(self, source));
    const fromTarget = harness.mutation.applyAssertion(usesInput(self, target));
    if (fromSource.kind !== 'created' || fromTarget.kind !== 'created') {
      return;
    }
    const merged = harness.merge.mergeNodes({
      ownerId: LOCAL_OWNER_ID, sourceNodeId: source, targetNodeId: target,
      basis: 'automatic_alias_match', actorType: 'assistant_proposal', actorRef: null, reason: 'Alias match.',
    });
    if (merged.kind !== 'merged') {
      return;
    }

    const versionBefore = harness.audit.readGraphVersion();
    harness.merge.unmergeNodes({
      ownerId: LOCAL_OWNER_ID, mergeId: merged.mergeId, actorRef: 'memory-inspector',
      reason: 'That was wrong.',
    });

    assert.equal(harness.audit.readGraphVersion(), versionBefore + 1);
    assert.equal(harness.nodes.readNode(source)?.status, 'active');
    assert.equal(harness.nodes.readNode(source)?.mergedIntoNodeId, null);
    assert.deepEqual(
      harness.nodes.listAliases(source).map((alias) => alias.normalizedAlias),
      ['vscode'],
    );
    assert.equal(harness.assertions.readAssertion(fromSource.assertion.id)?.objectNodeId, source);
    assert.equal(harness.assertions.readAssertion(fromSource.assertion.id)?.status, 'active');
    assert.equal(harness.assertions.readAssertion(fromTarget.assertion.id)?.objectNodeId, target);
  });
});

test('unmerging an unknown or already-reversed merge throws', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const source = harness.makeNode('software', null, 'A');
    const target = harness.makeNode('software', null, 'B');
    const merged = harness.merge.mergeNodes({
      ownerId: LOCAL_OWNER_ID, sourceNodeId: source, targetNodeId: target,
      basis: 'user_confirmed_duplicate', actorType: 'user', actorRef: null, reason: 'Same.',
    });
    if (merged.kind !== 'merged') {
      return;
    }
    harness.merge.unmergeNodes({
      ownerId: LOCAL_OWNER_ID, mergeId: merged.mergeId, actorRef: null, reason: 'Undo.',
    });
    assert.throws(
      () => harness.merge.unmergeNodes({
        ownerId: LOCAL_OWNER_ID, mergeId: merged.mergeId, actorRef: null, reason: 'Undo again.',
      }),
      /Merge .+ has already been reversed/u,
    );
    assert.throws(
      () => harness.merge.unmergeNodes({
        ownerId: LOCAL_OWNER_ID, mergeId: 'mrg_missing', actorRef: null, reason: 'Undo.',
      }),
      /Unknown node merge: mrg_missing/u,
    );
  });
});

test('nodes of different types never merge', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const source = harness.makeNode('software', null, 'VS Code');
    const target = harness.makeNode('topic', null, 'VS Code');
    const outcome = harness.merge.mergeNodes({
      ownerId: LOCAL_OWNER_ID, sourceNodeId: source, targetNodeId: target,
      basis: 'automatic_alias_match', actorType: 'assistant_proposal', actorRef: null, reason: 'Name match.',
    });
    assert.equal(outcome.kind, 'blocked');
    if (outcome.kind === 'blocked') {
      assert.deepEqual(outcome.reasons, ['node_type_mismatch']);
    }
  });
});

test('conflicting canonical keys block a merge', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const source = harness.makeNode('software', 'software:vscode', 'VS Code');
    const target = harness.makeNode('software', 'software:vscodium', 'VSCodium');
    const outcome = harness.merge.mergeNodes({
      ownerId: LOCAL_OWNER_ID, sourceNodeId: source, targetNodeId: target,
      basis: 'automatic_alias_match', actorType: 'assistant_proposal', actorRef: null, reason: 'Name match.',
    });
    assert.equal(outcome.kind, 'blocked');
    if (outcome.kind === 'blocked') {
      assert.deepEqual(outcome.reasons, ['canonical_key_conflict']);
    }
  });
});

test('a do_not_merge_node policy on either side blocks the merge', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const source = harness.makeNode('software', null, 'A');
    const target = harness.makeNode('software', null, 'B');
    harness.policies.upsertPolicy({
      ownerId: LOCAL_OWNER_ID, policyType: 'do_not_merge_node', key: target,
      value: { locked: true }, enabled: true, source: 'user',
    });
    const outcome = harness.merge.mergeNodes({
      ownerId: LOCAL_OWNER_ID, sourceNodeId: source, targetNodeId: target,
      basis: 'automatic_alias_match', actorType: 'assistant_proposal', actorRef: null, reason: 'Name match.',
    });
    assert.equal(outcome.kind, 'blocked');
    if (outcome.kind === 'blocked') {
      assert.deepEqual(outcome.reasons, ['do_not_merge_policy']);
    }
  });
});

test('merging the owner with a third party is blocked', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const self = harness.makeNode('person', 'person:self', 'Denys');
    const colleague = harness.makeNode('person', null, 'Denys from work');
    const outcome = harness.merge.mergeNodes({
      ownerId: LOCAL_OWNER_ID, sourceNodeId: colleague, targetNodeId: self,
      basis: 'automatic_alias_match', actorType: 'assistant_proposal', actorRef: null, reason: 'Name match.',
    });
    assert.equal(outcome.kind, 'blocked');
    if (outcome.kind === 'blocked') {
      assert.deepEqual(outcome.reasons, ['owner_identity_collapse']);
    }
  });
});

test('a merge cycle is detected and blocked', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const first = harness.makeNode('software', null, 'A');
    const second = harness.makeNode('software', null, 'B');
    harness.merge.mergeNodes({
      ownerId: LOCAL_OWNER_ID, sourceNodeId: first, targetNodeId: second,
      basis: 'user_confirmed_duplicate', actorType: 'user', actorRef: null, reason: 'Same.',
    });
    const outcome = harness.merge.mergeNodes({
      ownerId: LOCAL_OWNER_ID, sourceNodeId: second, targetNodeId: first,
      basis: 'user_confirmed_duplicate', actorType: 'user', actorRef: null, reason: 'Reverse.',
    });
    assert.equal(outcome.kind, 'blocked');
    if (outcome.kind === 'blocked') {
      assert.deepEqual(outcome.reasons, ['merge_cycle']);
    }
  });
});

test('incompatible explicit single-valued assertions block a merge', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const powershell = harness.makeNode('software', 'software:powershell', 'PowerShell');
    const bash = harness.makeNode('software', 'software:bash', 'Bash');
    const first = harness.makeNode('person', null, 'Alex');
    const second = harness.makeNode('person', null, 'Alexander');
    harness.mutation.applyAssertion({ ...usesInput(first, powershell), predicate: 'PREFERS' });
    harness.mutation.applyAssertion({ ...usesInput(second, bash), predicate: 'PREFERS' });

    const outcome = harness.merge.mergeNodes({
      ownerId: LOCAL_OWNER_ID, sourceNodeId: second, targetNodeId: first,
      basis: 'automatic_alias_match', actorType: 'assistant_proposal', actorRef: null, reason: 'Name match.',
    });
    assert.equal(outcome.kind, 'blocked');
    if (outcome.kind === 'blocked') {
      assert.deepEqual(outcome.reasons, ['incompatible_explicit_assertions']);
    }
  });
});

test('merging a node with itself or a missing node is blocked', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const node = harness.makeNode('software', null, 'A');
    const sameNode = harness.merge.mergeNodes({
      ownerId: LOCAL_OWNER_ID, sourceNodeId: node, targetNodeId: node,
      basis: 'automatic_alias_match', actorType: 'assistant_proposal', actorRef: null, reason: 'Self.',
    });
    assert.equal(sameNode.kind, 'blocked');
    if (sameNode.kind === 'blocked') {
      assert.deepEqual(sameNode.reasons, ['same_node']);
    }
    assert.throws(
      () => harness.merge.mergeNodes({
        ownerId: LOCAL_OWNER_ID, sourceNodeId: 'nod_missing', targetNodeId: node,
        basis: 'automatic_alias_match', actorType: 'assistant_proposal', actorRef: null, reason: 'x',
      }),
      /Unknown graph node: nod_missing/u,
    );
  });
});

test('every declared block reason is unique', () => {
  assert.equal(new Set(MERGE_BLOCK_REASONS).size, MERGE_BLOCK_REASONS.length);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- assistant-node-merge`
Expected: FAIL — `Cannot find module '../src/assistant/graph/merge.js'`

- [ ] **Step 3: Add `repointAssertion` to `src/assistant/storage/assertion-store.ts`**

Insert this method after `setStatus`:

```ts
  // Rewrites the node references of an existing assertion and recomputes its derived key.
  // Used only by the merge service; the caller must already hold a transaction.
  repointAssertion(assertionId: string, target: {
    subjectNodeId: string;
    objectNodeId: string | null;
    scopeNodeId: string | null;
  }): GraphAssertionRecord {
    const existing = this.requireAssertion(assertionId);
    const objectKey = existing.objectKind === 'node'
      ? buildNodeObjectKey(GraphAssertionStore.requireObjectNodeId(target.objectNodeId, assertionId))
      : buildLiteralObjectKey(GraphAssertionStore.requireLiteralValue(existing));
    const assertionKey = computeAssertionKey({
      ownerId: existing.ownerId,
      subjectNodeId: target.subjectNodeId,
      predicate: existing.predicate,
      objectKey,
      scopeNodeId: target.scopeNodeId,
    });
    this.database.prepare(`
      UPDATE graph_assertions
      SET subject_node_id = ?, object_node_id = ?, scope_node_id = ?, assertion_key = ?, updated_at_utc = ?
      WHERE id = ?
    `).run(
      target.subjectNodeId,
      target.objectNodeId,
      target.scopeNodeId,
      assertionKey,
      this.clock.nowUtc(),
      assertionId,
    );
    this.refreshAssertionFts(assertionId);
    return this.requireAssertion(assertionId);
  }

  private static requireObjectNodeId(objectNodeId: string | null, assertionId: string): string {
    if (objectNodeId === null) {
      throw new Error(`Assertion ${assertionId} has a node object and requires an object node id`);
    }
    return objectNodeId;
  }

  private static requireLiteralValue(record: GraphAssertionRecord): LiteralObjectValue {
    if (record.objectValue === null) {
      throw new Error(`Assertion ${record.id} has a literal object but no stored value`);
    }
    return record.objectValue;
  }
```

- [ ] **Step 4: Write `src/assistant/graph/merge.ts`**

```ts
import { z } from '../../lib/zod.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { AssistantClock } from '../runtime/clock.js';
import { ASSISTANT_ID_PREFIXES, type AssistantIdGenerator } from '../runtime/ids.js';
import { isExplicitBasis } from '../domain/confidence.js';
import { getRelationDefinition } from '../domain/relation-types.js';
import type { MutationActorType } from '../domain/primitives.js';
import type { GraphNodeRecord, GraphNodeStore } from '../storage/node-store.js';
import type { GraphAssertionRecord, GraphAssertionStore } from '../storage/assertion-store.js';
import type { AssistantAuditStore } from '../storage/audit-store.js';
import type { AssistantPolicyStore } from '../storage/policy-store.js';

export const MERGE_BLOCK_REASONS = [
  'same_node',
  'node_type_mismatch',
  'canonical_key_conflict',
  'do_not_merge_policy',
  'owner_identity_collapse',
  'merge_cycle',
  'incompatible_explicit_assertions',
  'node_not_active',
] as const;
export const MergeBlockReasonSchema = z.enum(MERGE_BLOCK_REASONS);
export type MergeBlockReason = z.infer<typeof MergeBlockReasonSchema>;

export const SELF_PERSON_CANONICAL_KEY = 'person:self';
export const MERGE_AUDIT_EVENT_TYPE = 'node_merge_applied';

const MergeRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  source_node_id: z.string(),
  target_node_id: z.string(),
  basis: z.string(),
  reversible: z.number(),
  created_at_utc: z.string(),
  reversed_at_utc: z.string().nullable(),
});

const MergeDetailsSchema = z.object({
  movedAssertionIds: z.array(z.string()),
  retiredAssertionIds: z.array(z.string()),
  movedAliasIds: z.array(z.string()),
});

export interface MergeNodesInput {
  ownerId: string;
  sourceNodeId: string;
  targetNodeId: string;
  basis: string;
  actorType: MutationActorType;
  actorRef: string | null;
  reason: string;
}

export type MergeOutcome =
  | {
      kind: 'merged';
      mergeId: string;
      movedAssertionIds: readonly string[];
      retiredAssertionIds: readonly string[];
      graphVersion: number;
    }
  | { kind: 'blocked'; reasons: readonly MergeBlockReason[] };

export interface UnmergeNodesInput {
  ownerId: string;
  mergeId: string;
  actorRef: string | null;
  reason: string;
}

export class NodeMergeService {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly nodes: GraphNodeStore,
    private readonly assertions: GraphAssertionStore,
    private readonly audit: AssistantAuditStore,
    private readonly policies: AssistantPolicyStore,
    private readonly ids: AssistantIdGenerator,
    private readonly clock: AssistantClock,
  ) {}

  mergeNodes(input: MergeNodesInput): MergeOutcome {
    const source = this.requireNode(input.sourceNodeId);
    const target = this.requireNode(input.targetNodeId);
    const reasons = this.collectBlockReasons(input, source, target);
    if (reasons.length > 0) {
      return { kind: 'blocked', reasons };
    }

    const mergeId = this.ids.next(ASSISTANT_ID_PREFIXES.merge);
    const nowUtc = this.clock.nowUtc();

    const apply = this.database.transaction((): MergeOutcome => {
      const movedAliasIds = this.moveAliases(source, target);
      const { movedAssertionIds, retiredAssertionIds } = this.repointAssertions(input, source, target);
      this.nodes.setNodeStatus(source.id, 'merged', target.id);

      this.database.prepare(`
        INSERT INTO graph_entity_merges (
          id, owner_id, source_node_id, target_node_id, basis, reversible, created_at_utc, reversed_at_utc
        ) VALUES (?, ?, ?, ?, ?, 1, ?, NULL)
      `).run(mergeId, input.ownerId, source.id, target.id, input.basis, nowUtc);

      this.audit.recordAuditEvent({
        ownerId: input.ownerId,
        eventType: MERGE_AUDIT_EVENT_TYPE,
        targetType: 'graph_entity_merge',
        targetId: mergeId,
        summary: `Merged node ${source.id} into ${target.id}.`,
        details: { movedAssertionIds, retiredAssertionIds, movedAliasIds },
      });
      this.audit.recordMutation({
        ownerId: input.ownerId,
        actorType: input.actorType,
        actorRef: input.actorRef,
        operation: 'merge_node',
        targetType: 'graph_node',
        targetId: source.id,
        before: { status: source.status, mergedIntoNodeId: source.mergedIntoNodeId },
        after: { status: 'merged', mergedIntoNodeId: target.id, mergeId },
        reason: input.reason,
      });
      return {
        kind: 'merged',
        mergeId,
        movedAssertionIds,
        retiredAssertionIds,
        graphVersion: this.audit.incrementGraphVersion(),
      };
    });
    return apply();
  }

  unmergeNodes(input: UnmergeNodesInput): number {
    const rawRow = this.database.prepare(
      'SELECT * FROM graph_entity_merges WHERE id = ? AND owner_id = ? LIMIT 1',
    ).get(input.mergeId, input.ownerId);
    if (rawRow == null) {
      throw new Error(`Unknown node merge: ${input.mergeId}`);
    }
    const mergeRow = MergeRowSchema.parse(rawRow);
    if (mergeRow.reversed_at_utc !== null) {
      throw new Error(`Merge ${input.mergeId} has already been reversed at ${mergeRow.reversed_at_utc}`);
    }
    const details = this.readMergeDetails(input.ownerId, input.mergeId);
    const nowUtc = this.clock.nowUtc();

    const reverse = this.database.transaction((): number => {
      for (const aliasId of details.movedAliasIds) {
        this.database.prepare('UPDATE graph_node_aliases SET node_id = ? WHERE id = ?')
          .run(mergeRow.source_node_id, aliasId);
      }
      this.nodes.setNodeStatus(mergeRow.source_node_id, 'active', null);
      for (const assertionId of details.retiredAssertionIds) {
        this.assertions.setStatus(assertionId, 'active');
      }
      for (const assertionId of [...details.movedAssertionIds, ...details.retiredAssertionIds]) {
        this.restoreAssertionReferences(assertionId, mergeRow.target_node_id, mergeRow.source_node_id);
      }
      this.database.prepare('UPDATE graph_entity_merges SET reversed_at_utc = ? WHERE id = ?')
        .run(nowUtc, input.mergeId);
      this.audit.recordMutation({
        ownerId: input.ownerId,
        actorType: 'user',
        actorRef: input.actorRef,
        operation: 'unmerge_node',
        targetType: 'graph_node',
        targetId: mergeRow.source_node_id,
        before: { status: 'merged', mergedIntoNodeId: mergeRow.target_node_id },
        after: { status: 'active', mergedIntoNodeId: null, mergeId: input.mergeId },
        reason: input.reason,
      });
      return this.audit.incrementGraphVersion();
    });
    return reverse();
  }

  private collectBlockReasons(
    input: MergeNodesInput,
    source: GraphNodeRecord,
    target: GraphNodeRecord,
  ): readonly MergeBlockReason[] {
    if (source.id === target.id) {
      return ['same_node'];
    }
    if (source.status !== 'active' || target.status !== 'active') {
      return ['node_not_active'];
    }
    if (source.type !== target.type) {
      return ['node_type_mismatch'];
    }
    if (
      source.canonicalKey !== null
      && target.canonicalKey !== null
      && source.canonicalKey !== target.canonicalKey
    ) {
      return ['canonical_key_conflict'];
    }
    if (
      this.policies.isPolicyActive(input.ownerId, 'do_not_merge_node', source.id)
      || this.policies.isPolicyActive(input.ownerId, 'do_not_merge_node', target.id)
    ) {
      return ['do_not_merge_policy'];
    }
    const selfCount = [source, target]
      .filter((node) => node.canonicalKey === SELF_PERSON_CANONICAL_KEY).length;
    if (selfCount === 1 && source.type === 'person') {
      return ['owner_identity_collapse'];
    }
    if (this.wouldFormCycle(source.id, target.id)) {
      return ['merge_cycle'];
    }
    if (this.hasIncompatibleExplicitAssertions(input.ownerId, source.id, target.id)) {
      return ['incompatible_explicit_assertions'];
    }
    return [];
  }

  // Walking merged_into_node_id from the target must never arrive back at the source.
  private wouldFormCycle(sourceNodeId: string, targetNodeId: string): boolean {
    const visited = new Set<string>();
    let cursor: string | null = targetNodeId;
    while (cursor !== null) {
      if (cursor === sourceNodeId) {
        return true;
      }
      if (visited.has(cursor)) {
        return true;
      }
      visited.add(cursor);
      cursor = this.nodes.readNode(cursor)?.mergedIntoNodeId ?? null;
    }
    return false;
  }

  // Two nodes cannot merge when each holds a live explicit assertion on the same single-valued
  // predicate and scope but points at a different object.
  private hasIncompatibleExplicitAssertions(
    ownerId: string,
    sourceNodeId: string,
    targetNodeId: string,
  ): boolean {
    const singleValued = (assertion: GraphAssertionRecord): boolean => {
      const cardinality = getRelationDefinition(assertion.predicate).cardinality;
      return cardinality === 'single_current' || cardinality === 'single_per_scope';
    };
    const sourceAssertions = this.assertions.listBySubject(ownerId, sourceNodeId)
      .filter((assertion) => isExplicitBasis(assertion.basis) && singleValued(assertion));
    const targetAssertions = this.assertions.listBySubject(ownerId, targetNodeId)
      .filter((assertion) => isExplicitBasis(assertion.basis) && singleValued(assertion));
    for (const sourceAssertion of sourceAssertions) {
      for (const targetAssertion of targetAssertions) {
        if (sourceAssertion.predicate !== targetAssertion.predicate) {
          continue;
        }
        if (sourceAssertion.scopeNodeId !== targetAssertion.scopeNodeId) {
          continue;
        }
        const sameObject = sourceAssertion.objectNodeId === targetAssertion.objectNodeId
          && sourceAssertion.objectNormalizedText === targetAssertion.objectNormalizedText;
        if (!sameObject) {
          return true;
        }
      }
    }
    return false;
  }

  private moveAliases(source: GraphNodeRecord, target: GraphNodeRecord): readonly string[] {
    const targetAliases = new Set(
      this.nodes.listAliases(target.id).map((alias) => alias.normalizedAlias),
    );
    const movedAliasIds: string[] = [];
    for (const alias of this.nodes.listAliases(source.id)) {
      if (targetAliases.has(alias.normalizedAlias)) {
        continue;
      }
      this.database.prepare('UPDATE graph_node_aliases SET node_id = ? WHERE id = ?')
        .run(target.id, alias.id);
      movedAliasIds.push(alias.id);
      targetAliases.add(alias.normalizedAlias);
    }
    return movedAliasIds;
  }

  private repointAssertions(
    input: MergeNodesInput,
    source: GraphNodeRecord,
    target: GraphNodeRecord,
  ): { movedAssertionIds: readonly string[]; retiredAssertionIds: readonly string[] } {
    const affected = [
      ...this.assertions.listBySubject(input.ownerId, source.id),
      ...this.assertions.listByObjectNode(input.ownerId, source.id),
      ...this.listByScopeNode(input.ownerId, source.id),
    ];
    const seen = new Set<string>();
    const movedAssertionIds: string[] = [];
    const retiredAssertionIds: string[] = [];

    for (const assertion of affected) {
      if (seen.has(assertion.id)) {
        continue;
      }
      seen.add(assertion.id);
      const repointed = {
        subjectNodeId: assertion.subjectNodeId === source.id ? target.id : assertion.subjectNodeId,
        objectNodeId: assertion.objectNodeId === source.id ? target.id : assertion.objectNodeId,
        scopeNodeId: assertion.scopeNodeId === source.id ? target.id : assertion.scopeNodeId,
      };
      if (this.collidesWithLiveAssertion(assertion, repointed)) {
        this.assertions.retireAssertion(assertion.id, 'superseded', null);
        retiredAssertionIds.push(assertion.id);
        continue;
      }
      this.assertions.repointAssertion(assertion.id, repointed);
      movedAssertionIds.push(assertion.id);
    }
    return { movedAssertionIds, retiredAssertionIds };
  }

  private collidesWithLiveAssertion(
    assertion: GraphAssertionRecord,
    repointed: { subjectNodeId: string; objectNodeId: string | null; scopeNodeId: string | null },
  ): boolean {
    return this.assertions
      .listBySubject(assertion.ownerId, repointed.subjectNodeId, assertion.predicate)
      .some((candidate) => candidate.id !== assertion.id
        && candidate.objectNodeId === repointed.objectNodeId
        && candidate.objectNormalizedText === assertion.objectNormalizedText
        && candidate.scopeNodeId === repointed.scopeNodeId);
  }

  private restoreAssertionReferences(
    assertionId: string,
    targetNodeId: string,
    sourceNodeId: string,
  ): void {
    const assertion = this.assertions.readAssertion(assertionId);
    if (!assertion) {
      return;
    }
    this.assertions.repointAssertion(assertionId, {
      subjectNodeId: assertion.subjectNodeId === targetNodeId ? sourceNodeId : assertion.subjectNodeId,
      objectNodeId: assertion.objectNodeId === targetNodeId ? sourceNodeId : assertion.objectNodeId,
      scopeNodeId: assertion.scopeNodeId === targetNodeId ? sourceNodeId : assertion.scopeNodeId,
    });
  }

  private listByScopeNode(ownerId: string, scopeNodeId: string): readonly GraphAssertionRecord[] {
    const rows = this.database.prepare(`
      SELECT id FROM graph_assertions
      WHERE owner_id = ? AND scope_node_id = ? AND status IN ('active', 'disputed')
    `).all(ownerId, scopeNodeId);
    const records: GraphAssertionRecord[] = [];
    for (const row of rows) {
      const record = this.assertions.readAssertion(z.object({ id: z.string() }).parse(row).id);
      if (record) {
        records.push(record);
      }
    }
    return records;
  }

  private readMergeDetails(ownerId: string, mergeId: string): z.infer<typeof MergeDetailsSchema> {
    const event = this.audit.listAuditEvents(ownerId, 1000).find(
      (candidate) => candidate.eventType === MERGE_AUDIT_EVENT_TYPE && candidate.targetId === mergeId,
    );
    if (!event) {
      throw new Error(`Missing merge audit event for merge ${mergeId}`);
    }
    return MergeDetailsSchema.parse(event.details);
  }

  private requireNode(nodeId: string): GraphNodeRecord {
    const node = this.nodes.readNode(nodeId);
    if (!node) {
      throw new Error(`Unknown graph node: ${nodeId}`);
    }
    return node;
  }
}
```

Note: `unmergeRestore` calls `restoreAssertionReferences` for the retired assertions *after*
`setStatus(assertionId, 'active')`. Reactivating before repointing can trip the live-key unique
index when the target still holds the equivalent assertion. Reverse the order — repoint first,
then reactivate — by moving the `setStatus` loop below the repoint loop in `unmergeNodes`.

- [ ] **Step 5: Apply the ordering fix noted above, then run the test**

Run: `npm test -- assistant-node-merge`
Expected: PASS — 12 tests

- [ ] **Step 6: Run the mutation and assertion suites to confirm `repointAssertion` broke nothing**

Run: `npm test -- assistant-assertion-store` then `npm test -- assistant-graph-mutation`
Expected: PASS — 14 and 15 tests

- [ ] **Step 7: Commit**

```bash
git add src/assistant/graph/merge.ts src/assistant/storage/assertion-store.ts tests/assistant-node-merge.test.ts
git commit -m "feat(assistant): add reversible node merge with cycle detection and safety blocks"
```

---

## Task 17: Bounded neighborhood traversal

Design §11.4 (traversal bounds), §18 Gate A ("bounded neighborhood limits"), §19.2 (property test: traversal never exceeds configured limits), §21 (`RELATED_TO` is never expanded without an explicit predicate allowlist).

The retriever itself is Gate B. Gate A ships only the bounded reader the Memory Inspector and the retriever will both use.

**Files:**
- Create: `src/assistant/graph/neighborhood.ts`
- Test: `tests/assistant-neighborhood.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/assistant-neighborhood.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NeighborhoodReader,
  DEFAULT_NEIGHBORHOOD_BOUNDS,
} from '../src/assistant/graph/neighborhood.js';
import { GraphMutationService } from '../src/assistant/graph/mutation.js';
import { GraphAssertionValidator } from '../src/assistant/graph/validation.js';
import { GraphNodeStore } from '../src/assistant/storage/node-store.js';
import { GraphAssertionStore } from '../src/assistant/storage/assertion-store.js';
import { AssistantAuditStore } from '../src/assistant/storage/audit-store.js';
import { AssistantPolicyStore } from '../src/assistant/storage/policy-store.js';
import { LOCAL_OWNER_ID } from '../src/assistant/storage/schema.js';
import { FixedAssistantClock } from '../src/assistant/runtime/clock.js';
import { SequentialAssistantIdGenerator } from '../src/assistant/runtime/ids.js';
import type { NodeType } from '../src/assistant/domain/node-types.js';
import type { RelationType } from '../src/assistant/domain/relation-types.js';
import { withAssistantRepo, type AssistantFixtureContext } from './helpers/assistant-fixture.js';

interface Harness {
  nodes: GraphNodeStore;
  reader: NeighborhoodReader;
  mutation: GraphMutationService;
  makeNode: (type: NodeType, name: string) => string;
  link: (subjectNodeId: string, predicate: RelationType, objectNodeId: string) => void;
}

function buildHarness(context: AssistantFixtureContext): Harness {
  const clock = new FixedAssistantClock('2026-08-04T10:00:00.000Z');
  const ids = new SequentialAssistantIdGenerator();
  const nodes = new GraphNodeStore(context.database, clock, ids);
  const assertions = new GraphAssertionStore(context.database, clock, ids);
  const audit = new AssistantAuditStore(context.database, clock, ids);
  const policies = new AssistantPolicyStore(context.database, clock, ids);
  const mutation = new GraphMutationService(
    context.database, nodes, assertions, audit, policies, new GraphAssertionValidator(),
  );
  return {
    nodes,
    mutation,
    reader: new NeighborhoodReader(nodes, assertions),
    makeNode: (type, name) => nodes.createNode({
      ownerId: LOCAL_OWNER_ID, type, canonicalKey: null, displayName: name,
      description: null, sensitivity: 'low', properties: {},
    }).id,
    link: (subjectNodeId, predicate, objectNodeId) => {
      const outcome = mutation.applyAssertion({
        ownerId: LOCAL_OWNER_ID,
        subjectNodeId,
        predicate,
        object: { kind: 'node', nodeId: objectNodeId },
        scopeNodeId: null,
        basis: 'explicit_user_statement',
        confidence: 0.9,
        sensitivity: null,
        validFromUtc: null,
        validToUtc: null,
        observedAtUtc: '2026-08-04T09:00:00.000Z',
        attributes: {},
        actor: { type: 'user', ref: 'test' },
        reason: 'Fixture link.',
        evidence: null,
      });
      if (outcome.kind !== 'created') {
        throw new Error(`Fixture link failed: ${outcome.kind}`);
      }
    },
  };
}

test('a one-hop neighborhood returns the seed, its edges and its neighbours', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const self = harness.makeNode('person', 'Denys');
    const siftkit = harness.makeNode('project', 'SiftKit');
    const powershell = harness.makeNode('software', 'PowerShell');
    harness.link(self, 'WORKS_ON', siftkit);
    harness.link(self, 'USES', powershell);

    const result = harness.reader.readNeighborhood({
      ownerId: LOCAL_OWNER_ID,
      seedNodeIds: [self],
      predicates: ['WORKS_ON', 'USES'],
      bounds: { ...DEFAULT_NEIGHBORHOOD_BOUNDS, maxHops: 1 },
    });
    assert.deepEqual([...result.nodes.map((node) => node.id)].sort(), [self, siftkit, powershell].sort());
    assert.equal(result.assertions.length, 2);
    assert.equal(result.truncated, false);
  });
});

test('traversal follows edges in both directions', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const self = harness.makeNode('person', 'Denys');
    const siftkit = harness.makeNode('project', 'SiftKit');
    harness.link(self, 'WORKS_ON', siftkit);

    const result = harness.reader.readNeighborhood({
      ownerId: LOCAL_OWNER_ID,
      seedNodeIds: [siftkit],
      predicates: ['WORKS_ON'],
      bounds: { ...DEFAULT_NEIGHBORHOOD_BOUNDS, maxHops: 1 },
    });
    assert.deepEqual([...result.nodes.map((node) => node.id)].sort(), [self, siftkit].sort());
  });
});

test('hops beyond maxHops are not expanded', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const self = harness.makeNode('person', 'Denys');
    const siftkit = harness.makeNode('project', 'SiftKit');
    const powershell = harness.makeNode('software', 'PowerShell');
    harness.link(self, 'WORKS_ON', siftkit);
    harness.link(siftkit, 'DEPENDS_ON', powershell);

    const oneHop = harness.reader.readNeighborhood({
      ownerId: LOCAL_OWNER_ID,
      seedNodeIds: [self],
      predicates: ['WORKS_ON', 'DEPENDS_ON'],
      bounds: { ...DEFAULT_NEIGHBORHOOD_BOUNDS, maxHops: 1 },
    });
    assert.equal(oneHop.nodes.some((node) => node.id === powershell), false);

    const twoHops = harness.reader.readNeighborhood({
      ownerId: LOCAL_OWNER_ID,
      seedNodeIds: [self],
      predicates: ['WORKS_ON', 'DEPENDS_ON'],
      bounds: { ...DEFAULT_NEIGHBORHOOD_BOUNDS, maxHops: 2 },
    });
    assert.equal(twoHops.nodes.some((node) => node.id === powershell), true);
  });
});

test('only allowlisted predicates are followed', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const self = harness.makeNode('person', 'Denys');
    const siftkit = harness.makeNode('project', 'SiftKit');
    const powershell = harness.makeNode('software', 'PowerShell');
    harness.link(self, 'WORKS_ON', siftkit);
    harness.link(self, 'USES', powershell);

    const result = harness.reader.readNeighborhood({
      ownerId: LOCAL_OWNER_ID,
      seedNodeIds: [self],
      predicates: ['WORKS_ON'],
      bounds: { ...DEFAULT_NEIGHBORHOOD_BOUNDS, maxHops: 2 },
    });
    assert.deepEqual([...result.nodes.map((node) => node.id)].sort(), [self, siftkit].sort());
    assert.deepEqual(result.assertions.map((assertion) => assertion.predicate), ['WORKS_ON']);
  });
});

test('RELATED_TO is never expanded even when allowlisted', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const self = harness.makeNode('person', 'Denys');
    const topic = harness.makeNode('topic', 'Local LLMs');
    harness.link(self, 'RELATED_TO', topic);

    const result = harness.reader.readNeighborhood({
      ownerId: LOCAL_OWNER_ID,
      seedNodeIds: [self],
      predicates: ['RELATED_TO'],
      bounds: { ...DEFAULT_NEIGHBORHOOD_BOUNDS, maxHops: 2 },
    });
    assert.deepEqual(result.nodes.map((node) => node.id), [self]);
    assert.deepEqual(result.assertions, []);
  });
});

test('fanout per node and predicate is capped and marks the result truncated', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const self = harness.makeNode('person', 'Denys');
    for (let index = 0; index < 6; index += 1) {
      harness.link(self, 'USES', harness.makeNode('software', `Tool ${String(index)}`));
    }
    const result = harness.reader.readNeighborhood({
      ownerId: LOCAL_OWNER_ID,
      seedNodeIds: [self],
      predicates: ['USES'],
      bounds: { ...DEFAULT_NEIGHBORHOOD_BOUNDS, maxHops: 1, maxFanoutPerNodePredicate: 2 },
    });
    assert.equal(result.assertions.length, 2);
    assert.equal(result.truncated, true);
  });
});

test('the node and assertion caps are never exceeded', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const self = harness.makeNode('person', 'Denys');
    for (let index = 0; index < 10; index += 1) {
      harness.link(self, 'USES', harness.makeNode('software', `Tool ${String(index)}`));
    }
    const nodeCapped = harness.reader.readNeighborhood({
      ownerId: LOCAL_OWNER_ID,
      seedNodeIds: [self],
      predicates: ['USES'],
      bounds: { ...DEFAULT_NEIGHBORHOOD_BOUNDS, maxHops: 1, maxNodes: 4 },
    });
    assert.ok(nodeCapped.nodes.length <= 4);
    assert.equal(nodeCapped.truncated, true);

    const assertionCapped = harness.reader.readNeighborhood({
      ownerId: LOCAL_OWNER_ID,
      seedNodeIds: [self],
      predicates: ['USES'],
      bounds: { ...DEFAULT_NEIGHBORHOOD_BOUNDS, maxHops: 1, maxAssertions: 3 },
    });
    assert.ok(assertionCapped.assertions.length <= 3);
    assert.equal(assertionCapped.truncated, true);
  });
});

test('seed nodes beyond maxSeedNodes are dropped', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const seeds = [0, 1, 2].map((index) => harness.makeNode('topic', `Topic ${String(index)}`));
    const result = harness.reader.readNeighborhood({
      ownerId: LOCAL_OWNER_ID,
      seedNodeIds: seeds,
      predicates: ['RELATED_TO'],
      bounds: { ...DEFAULT_NEIGHBORHOOD_BOUNDS, maxSeedNodes: 2 },
    });
    assert.equal(result.nodes.length, 2);
    assert.equal(result.truncated, true);
  });
});

test('a cycle in the graph terminates without repeating nodes', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const first = harness.makeNode('project', 'A');
    const second = harness.makeNode('project', 'B');
    harness.link(first, 'PART_OF', second);
    harness.link(second, 'PART_OF', first);

    const result = harness.reader.readNeighborhood({
      ownerId: LOCAL_OWNER_ID,
      seedNodeIds: [first],
      predicates: ['PART_OF'],
      bounds: { ...DEFAULT_NEIGHBORHOOD_BOUNDS, maxHops: 3 },
    });
    assert.equal(result.nodes.length, 2);
    assert.equal(new Set(result.assertions.map((assertion) => assertion.id)).size, result.assertions.length);
  });
});

test('a missing or non-active seed contributes nothing', () => {
  withAssistantRepo((context) => {
    const harness = buildHarness(context);
    const archived = harness.makeNode('topic', 'Archived');
    harness.nodes.setNodeStatus(archived, 'archived');
    const result = harness.reader.readNeighborhood({
      ownerId: LOCAL_OWNER_ID,
      seedNodeIds: ['nod_missing', archived],
      predicates: ['RELATED_TO'],
      bounds: DEFAULT_NEIGHBORHOOD_BOUNDS,
    });
    assert.deepEqual(result.nodes, []);
    assert.deepEqual(result.assertions, []);
  });
});

test('default bounds match the design retrieval defaults', () => {
  assert.deepEqual(DEFAULT_NEIGHBORHOOD_BOUNDS, {
    maxHops: 2,
    maxSeedNodes: 12,
    maxNodes: 80,
    maxAssertions: 160,
    maxFanoutPerNodePredicate: 20,
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- assistant-neighborhood`
Expected: FAIL — `Cannot find module '../src/assistant/graph/neighborhood.js'`

- [ ] **Step 3: Write `src/assistant/graph/neighborhood.ts`**

```ts
import type { RelationType } from '../domain/relation-types.js';
import type { GraphNodeRecord, GraphNodeStore } from '../storage/node-store.js';
import type { GraphAssertionRecord, GraphAssertionStore } from '../storage/assertion-store.js';

export interface NeighborhoodBounds {
  maxHops: number;
  maxSeedNodes: number;
  maxNodes: number;
  maxAssertions: number;
  maxFanoutPerNodePredicate: number;
}

// Mirrors the Assistant.Retrieval defaults in design §6.1. Gate C reads them from SiftConfig.
export const DEFAULT_NEIGHBORHOOD_BOUNDS: NeighborhoodBounds = {
  maxHops: 2,
  maxSeedNodes: 12,
  maxNodes: 80,
  maxAssertions: 160,
  maxFanoutPerNodePredicate: 20,
};

// RELATED_TO carries no semantics and would produce unbounded fanout, so it is never traversed.
export const NEVER_EXPANDED_PREDICATES: readonly RelationType[] = ['RELATED_TO'];

export interface NeighborhoodRequest {
  ownerId: string;
  seedNodeIds: readonly string[];
  predicates: readonly RelationType[];
  bounds: NeighborhoodBounds;
}

export interface NeighborhoodResult {
  nodes: readonly GraphNodeRecord[];
  assertions: readonly GraphAssertionRecord[];
  truncated: boolean;
}

export class NeighborhoodReader {
  constructor(
    private readonly nodes: GraphNodeStore,
    private readonly assertions: GraphAssertionStore,
  ) {}

  readNeighborhood(request: NeighborhoodRequest): NeighborhoodResult {
    const allowedPredicates = request.predicates.filter(
      (predicate) => !NEVER_EXPANDED_PREDICATES.includes(predicate),
    );
    const collectedNodes = new Map<string, GraphNodeRecord>();
    const collectedAssertions = new Map<string, GraphAssertionRecord>();
    let truncated = request.seedNodeIds.length > request.bounds.maxSeedNodes
      || allowedPredicates.length !== request.predicates.length;

    let frontier: string[] = [];
    for (const seedNodeId of request.seedNodeIds.slice(0, request.bounds.maxSeedNodes)) {
      const node = this.nodes.readNode(seedNodeId);
      if (!node || node.status !== 'active' || node.ownerId !== request.ownerId) {
        continue;
      }
      if (collectedNodes.size >= request.bounds.maxNodes) {
        truncated = true;
        break;
      }
      collectedNodes.set(node.id, node);
      frontier.push(node.id);
    }

    for (let hop = 0; hop < request.bounds.maxHops && frontier.length > 0; hop += 1) {
      const nextFrontier: string[] = [];
      for (const nodeId of frontier) {
        for (const predicate of allowedPredicates) {
          const edges = this.readEdges(request.ownerId, nodeId, predicate);
          const capped = edges.slice(0, request.bounds.maxFanoutPerNodePredicate);
          if (capped.length < edges.length) {
            truncated = true;
          }
          for (const assertion of capped) {
            if (collectedAssertions.size >= request.bounds.maxAssertions) {
              truncated = true;
              break;
            }
            collectedAssertions.set(assertion.id, assertion);
            const otherNodeId = assertion.subjectNodeId === nodeId
              ? assertion.objectNodeId
              : assertion.subjectNodeId;
            if (otherNodeId === null || collectedNodes.has(otherNodeId)) {
              continue;
            }
            if (collectedNodes.size >= request.bounds.maxNodes) {
              truncated = true;
              continue;
            }
            const otherNode = this.nodes.readNode(otherNodeId);
            if (!otherNode || otherNode.status !== 'active') {
              continue;
            }
            collectedNodes.set(otherNode.id, otherNode);
            nextFrontier.push(otherNode.id);
          }
        }
      }
      frontier = nextFrontier;
    }

    return {
      nodes: [...collectedNodes.values()],
      assertions: [...collectedAssertions.values()],
      truncated,
    };
  }

  // Edges are undirected for traversal: a node participates as subject or as object.
  private readEdges(
    ownerId: string,
    nodeId: string,
    predicate: RelationType,
  ): readonly GraphAssertionRecord[] {
    const outgoing = this.assertions.listBySubject(ownerId, nodeId, predicate);
    const incoming = this.assertions
      .listByObjectNode(ownerId, nodeId)
      .filter((assertion) => assertion.predicate === predicate);
    const merged = new Map<string, GraphAssertionRecord>();
    for (const assertion of [...outgoing, ...incoming]) {
      merged.set(assertion.id, assertion);
    }
    return [...merged.values()];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- assistant-neighborhood`
Expected: PASS — 11 tests

- [ ] **Step 5: Commit**

```bash
git add src/assistant/graph/neighborhood.ts tests/assistant-neighborhood.test.ts
git commit -m "feat(assistant): add bounded graph neighborhood reader"
```

---

## Task 18: GraphStore facade and the Gate A end-to-end test

Design §3 (`AssistantService` composes `GraphStore`), §18 Gate A demonstrations. The facade is the single construction point so no caller assembles seven collaborators by hand, and the end-to-end test proves the whole gate together.

**Files:**
- Create: `src/assistant/storage/graph-store.ts`
- Test: `tests/assistant-gate-a.e2e.test.ts`

- [ ] **Step 1: Write the failing end-to-end test**

Create `tests/assistant-gate-a.e2e.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GraphStore } from '../src/assistant/storage/graph-store.js';
import { InMemoryKeyProvider } from '../src/assistant/storage/key-provider.js';
import { LOCAL_OWNER_ID } from '../src/assistant/storage/schema.js';
import { resolveEvidenceBlobPath } from '../src/assistant/storage/evidence-paths.js';
import { FixedAssistantClock } from '../src/assistant/runtime/clock.js';
import { SequentialAssistantIdGenerator } from '../src/assistant/runtime/ids.js';
import { withAssistantRepo, type AssistantFixtureContext } from './helpers/assistant-fixture.js';

function buildStore(context: AssistantFixtureContext): GraphStore {
  return new GraphStore({
    database: context.database,
    runtimeRoot: context.runtimeRoot,
    clock: new FixedAssistantClock('2026-08-04T10:00:00.000Z'),
    ids: new SequentialAssistantIdGenerator(),
    keyProvider: new InMemoryKeyProvider(),
  });
}

test('a stated preference becomes an explained, evidence-backed graph assertion', () => {
  withAssistantRepo((context) => {
    const store = buildStore(context);

    const evidence = store.evidence.recordEvidence({
      ownerId: LOCAL_OWNER_ID,
      deviceId: null,
      sourceEventId: 'chat:session-1:message-1',
      parentEvidenceId: null,
      sourceType: 'conversation_message',
      sourceRef: 'session-1/message-1',
      capturedAtUtc: '2026-08-04T09:59:00.000Z',
      sourceTimezone: 'Europe/Berlin',
      sensitivity: 'personal',
      retentionUntilUtc: null,
      metadata: { role: 'user' },
      payload: { kind: 'text', text: 'I prefer PowerShell for Windows work.' },
    });

    const self = store.resolver.resolve({
      ownerId: LOCAL_OWNER_ID, type: 'person', displayName: 'Denys',
      canonicalKey: 'person:self', suggestedNodeId: null, suggestionScore: 0,
      allowCreate: true, sensitivity: 'personal',
    });
    const powershell = store.resolver.resolve({
      ownerId: LOCAL_OWNER_ID, type: 'software', displayName: 'PowerShell',
      canonicalKey: 'software:powershell', suggestedNodeId: null, suggestionScore: 0,
      allowCreate: true, sensitivity: 'low',
    });
    assert.equal(self.kind, 'created');
    assert.equal(powershell.kind, 'created');
    if (self.kind !== 'created' || powershell.kind !== 'created') {
      return;
    }

    const outcome = store.mutation.applyAssertion({
      ownerId: LOCAL_OWNER_ID,
      subjectNodeId: self.node.id,
      predicate: 'PREFERS',
      object: { kind: 'node', nodeId: powershell.node.id },
      scopeNodeId: null,
      basis: 'explicit_user_statement',
      confidence: 0.95,
      sensitivity: null,
      validFromUtc: null,
      validToUtc: null,
      observedAtUtc: evidence.capturedAtUtc,
      attributes: {},
      actor: { type: 'user', ref: 'chat' },
      reason: 'Stated directly in conversation.',
      evidence: { evidenceId: evidence.id, stance: 'supports', weight: 0.9 },
    });
    assert.equal(outcome.kind, 'created');
    if (outcome.kind !== 'created') {
      return;
    }

    // Explainable: evidence trail plus mutation history.
    const links = store.assertions.listEvidenceLinks(outcome.assertion.id);
    assert.deepEqual(links.map((link) => link.evidenceId), [evidence.id]);
    assert.deepEqual(
      store.audit.listMutations(LOCAL_OWNER_ID, 'graph_assertion', outcome.assertion.id)
        .map((entry) => entry.operation),
      ['create_assertion'],
    );
    // Searchable through both indexes.
    assert.equal(store.nodes.searchNodes(LOCAL_OWNER_ID, 'PowerShell', 10).length, 1);
    assert.equal(store.assertions.searchAssertions(LOCAL_OWNER_ID, 'PowerShell', 10).length, 1);
  });
});

test('a correction supersedes the old belief and preserves its history', () => {
  withAssistantRepo((context) => {
    const store = buildStore(context);
    const self = store.nodes.createNode({
      ownerId: LOCAL_OWNER_ID, type: 'person', canonicalKey: 'person:self',
      displayName: 'Denys', description: null, sensitivity: 'personal', properties: {},
    });
    const powershell = store.nodes.createNode({
      ownerId: LOCAL_OWNER_ID, type: 'software', canonicalKey: 'software:powershell',
      displayName: 'PowerShell', description: null, sensitivity: 'low', properties: {},
    });
    const bash = store.nodes.createNode({
      ownerId: LOCAL_OWNER_ID, type: 'software', canonicalKey: 'software:bash',
      displayName: 'Bash', description: null, sensitivity: 'low', properties: {},
    });
    const base = {
      ownerId: LOCAL_OWNER_ID,
      subjectNodeId: self.id,
      predicate: 'PREFERS',
      scopeNodeId: null,
      basis: 'explicit_user_statement',
      sensitivity: null,
      validFromUtc: null,
      validToUtc: null,
      observedAtUtc: '2026-08-04T09:00:00.000Z',
      attributes: {},
      actor: { type: 'user', ref: 'chat' },
      evidence: null,
    } as const;

    const first = store.mutation.applyAssertion({
      ...base, object: { kind: 'node', nodeId: powershell.id }, confidence: 0.9,
      reason: 'Original statement.',
    });
    const corrected = store.mutation.applyAssertion({
      ...base, object: { kind: 'node', nodeId: bash.id }, confidence: 0.99,
      reason: 'No, I meant Bash.',
    });
    assert.equal(corrected.kind, 'superseded');
    if (first.kind !== 'created' || corrected.kind !== 'superseded') {
      return;
    }
    assert.equal(store.assertions.readAssertion(first.assertion.id)?.status, 'superseded');
    assert.equal(
      store.assertions.listBySubjectIncludingHistory(LOCAL_OWNER_ID, self.id, 'PREFERS').length,
      2,
    );
    assert.equal(store.assertions.listBySubject(LOCAL_OWNER_ID, self.id, 'PREFERS').length, 1);
    assert.equal(store.audit.readGraphVersion(), 2);
  });
});

test('deleting evidence purges its blob while the graph stays consistent', () => {
  withAssistantRepo((context) => {
    const store = buildStore(context);
    const bytes = Buffer.from('screenshot bytes', 'utf8');
    const evidence = store.evidence.recordEvidence({
      ownerId: LOCAL_OWNER_ID, deviceId: null, sourceEventId: 'capture:1', parentEvidenceId: null,
      sourceType: 'screenshot', sourceRef: null, capturedAtUtc: '2026-08-04T09:00:00.000Z',
      sourceTimezone: null, sensitivity: 'personal', retentionUntilUtc: null, metadata: {},
      payload: { kind: 'blob', bytes, mimeType: 'image/png' },
    });
    const blobPath = resolveEvidenceBlobPath(context.runtimeRoot, evidence.contentHash);
    assert.ok(fs.existsSync(blobPath));

    store.evidence.deleteEvidence(evidence.id);
    assert.ok(!fs.existsSync(blobPath));
    assert.equal(store.evidence.readEvidence(evidence.id)?.status, 'deleted');
  });
});

test('a full merge and unmerge cycle leaves the graph exactly as it started', () => {
  withAssistantRepo((context) => {
    const store = buildStore(context);
    const self = store.nodes.createNode({
      ownerId: LOCAL_OWNER_ID, type: 'person', canonicalKey: 'person:self',
      displayName: 'Denys', description: null, sensitivity: 'personal', properties: {},
    });
    const source = store.nodes.createNode({
      ownerId: LOCAL_OWNER_ID, type: 'software', canonicalKey: null,
      displayName: 'VSCode', description: null, sensitivity: 'low', properties: {},
    });
    const target = store.nodes.createNode({
      ownerId: LOCAL_OWNER_ID, type: 'software', canonicalKey: 'software:visual-studio-code',
      displayName: 'Visual Studio Code', description: null, sensitivity: 'low', properties: {},
    });
    const created = store.mutation.applyAssertion({
      ownerId: LOCAL_OWNER_ID, subjectNodeId: self.id, predicate: 'USES',
      object: { kind: 'node', nodeId: source.id }, scopeNodeId: null,
      basis: 'explicit_user_statement', confidence: 0.9, sensitivity: null,
      validFromUtc: null, validToUtc: null, observedAtUtc: '2026-08-04T09:00:00.000Z',
      attributes: {}, actor: { type: 'user', ref: 'chat' }, reason: 'Stated.', evidence: null,
    });
    if (created.kind !== 'created') {
      return;
    }

    const merged = store.merge.mergeNodes({
      ownerId: LOCAL_OWNER_ID, sourceNodeId: source.id, targetNodeId: target.id,
      basis: 'user_confirmed_duplicate', actorType: 'user', actorRef: 'inspector',
      reason: 'Same editor.',
    });
    assert.equal(merged.kind, 'merged');
    if (merged.kind !== 'merged') {
      return;
    }
    assert.equal(store.assertions.readAssertion(created.assertion.id)?.objectNodeId, target.id);

    store.merge.unmergeNodes({
      ownerId: LOCAL_OWNER_ID, mergeId: merged.mergeId, actorRef: 'inspector', reason: 'Undo.',
    });
    assert.equal(store.nodes.readNode(source.id)?.status, 'active');
    assert.equal(store.assertions.readAssertion(created.assertion.id)?.objectNodeId, source.id);
  });
});

test('the bounded reader answers a neighborhood query through the facade', () => {
  withAssistantRepo((context) => {
    const store = buildStore(context);
    const self = store.nodes.createNode({
      ownerId: LOCAL_OWNER_ID, type: 'person', canonicalKey: 'person:self',
      displayName: 'Denys', description: null, sensitivity: 'personal', properties: {},
    });
    const siftkit = store.nodes.createNode({
      ownerId: LOCAL_OWNER_ID, type: 'project', canonicalKey: 'project:siftkit',
      displayName: 'SiftKit', description: null, sensitivity: 'low', properties: {},
    });
    store.mutation.applyAssertion({
      ownerId: LOCAL_OWNER_ID, subjectNodeId: self.id, predicate: 'WORKS_ON',
      object: { kind: 'node', nodeId: siftkit.id }, scopeNodeId: null,
      basis: 'explicit_user_statement', confidence: 0.95, sensitivity: null,
      validFromUtc: null, validToUtc: null, observedAtUtc: '2026-08-04T09:00:00.000Z',
      attributes: {}, actor: { type: 'user', ref: 'chat' }, reason: 'Stated.', evidence: null,
    });

    const result = store.neighborhood.readNeighborhood({
      ownerId: LOCAL_OWNER_ID,
      seedNodeIds: [self.id],
      predicates: ['WORKS_ON'],
      bounds: { maxHops: 1, maxSeedNodes: 12, maxNodes: 80, maxAssertions: 160, maxFanoutPerNodePredicate: 20 },
    });
    assert.deepEqual([...result.nodes.map((node) => node.id)].sort(), [self.id, siftkit.id].sort());
    assert.equal(result.truncated, false);
  });
});

test('every store on the facade shares one database connection and one clock', () => {
  withAssistantRepo((context) => {
    const store = buildStore(context);
    const node = store.nodes.createNode({
      ownerId: LOCAL_OWNER_ID, type: 'topic', canonicalKey: 'topic:llm',
      displayName: 'Local LLMs', description: null, sensitivity: 'low', properties: {},
    });
    const event = store.audit.recordAuditEvent({
      ownerId: LOCAL_OWNER_ID, eventType: 'inspection', targetType: 'graph_node',
      targetId: node.id, summary: 'Viewed.', details: {},
    });
    assert.equal(node.createdAtUtc, event.createdAtUtc);
    assert.equal(store.nodes.readNode(node.id)?.id, node.id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- assistant-gate-a`
Expected: FAIL — `Cannot find module '../src/assistant/storage/graph-store.js'`

- [ ] **Step 3: Write `src/assistant/storage/graph-store.ts`**

```ts
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { AssistantClock } from '../runtime/clock.js';
import type { AssistantIdGenerator } from '../runtime/ids.js';
import { GraphAssertionValidator } from '../graph/validation.js';
import { GraphMutationService } from '../graph/mutation.js';
import { EntityResolver } from '../graph/entity-resolution.js';
import { NodeMergeService } from '../graph/merge.js';
import { NeighborhoodReader } from '../graph/neighborhood.js';
import { AssistantBlobCipher } from './blob-crypto.js';
import type { AssistantKeyProvider } from './key-provider.js';
import { GraphNodeStore } from './node-store.js';
import { GraphAssertionStore } from './assertion-store.js';
import { AssistantEvidenceStore } from './evidence-store.js';
import { AssistantAuditStore } from './audit-store.js';
import { AssistantPolicyStore } from './policy-store.js';

export interface GraphStoreOptions {
  database: RuntimeDatabase;
  runtimeRoot: string;
  clock: AssistantClock;
  ids: AssistantIdGenerator;
  keyProvider: AssistantKeyProvider;
}

// Single construction point for the Gate A graph foundation. Everything shares one database
// connection, one clock and one id generator, so tests stay deterministic and writes stay atomic.
export class GraphStore {
  readonly nodes: GraphNodeStore;
  readonly assertions: GraphAssertionStore;
  readonly evidence: AssistantEvidenceStore;
  readonly audit: AssistantAuditStore;
  readonly policies: AssistantPolicyStore;
  readonly validator: GraphAssertionValidator;
  readonly mutation: GraphMutationService;
  readonly resolver: EntityResolver;
  readonly merge: NodeMergeService;
  readonly neighborhood: NeighborhoodReader;

  constructor(options: GraphStoreOptions) {
    this.nodes = new GraphNodeStore(options.database, options.clock, options.ids);
    this.assertions = new GraphAssertionStore(options.database, options.clock, options.ids);
    this.evidence = new AssistantEvidenceStore(
      options.database,
      options.clock,
      options.ids,
      new AssistantBlobCipher(options.keyProvider),
      options.runtimeRoot,
    );
    this.audit = new AssistantAuditStore(options.database, options.clock, options.ids);
    this.policies = new AssistantPolicyStore(options.database, options.clock, options.ids);
    this.validator = new GraphAssertionValidator();
    this.mutation = new GraphMutationService(
      options.database,
      this.nodes,
      this.assertions,
      this.audit,
      this.policies,
      this.validator,
    );
    this.resolver = new EntityResolver(this.nodes);
    this.merge = new NodeMergeService(
      options.database,
      this.nodes,
      this.assertions,
      this.audit,
      this.policies,
      options.ids,
      options.clock,
    );
    this.neighborhood = new NeighborhoodReader(this.nodes, this.assertions);
  }
}
```

- [ ] **Step 4: Run the end-to-end test**

Run: `npm test -- assistant-gate-a`
Expected: PASS — 6 tests

- [ ] **Step 5: Run the full suite and the typecheck**

Run: `npm test`
Expected: PASS — every pre-existing test plus the 16 new assistant files.

Run: `npm run typecheck`
Expected: PASS — no type errors, no lint errors. If ESLint flags anything, fix the code; do not add a suppression comment.

- [ ] **Step 6: Verify the boundary rules by inspection**

Confirm and state the result of each:

- `grep -rn "better-sqlite3" src/assistant/` returns nothing (only `RuntimeDatabase` type imports from `src/state/runtime-db.js`).
- `grep -rn "prepare(" src/assistant/domain/ src/assistant/runtime/` returns nothing.
- `grep -rn " as \| as any\|<[A-Z][A-Za-z]*>(\|!\." src/assistant/` finds no type-assertion cast, `any`, or non-null assertion.
- `grep -rn "import \* as" src/assistant/` returns nothing.
- `grep -rn "prepare(\|this.database" src/assistant/graph/` must return nothing. As written in Tasks 14 and 16, four SQL statements still live in the graph services, which **violates boundary rule 4**. Move each into the store that owns the table, with these exact signatures, and have the graph service call the store method instead:

```ts
// src/assistant/storage/assertion-store.ts
  listByScopeNode(ownerId: string, scopeNodeId: string): readonly GraphAssertionRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM graph_assertions
      WHERE owner_id = ? AND scope_node_id = ? AND status IN ('active', 'disputed')
      ORDER BY created_at_utc, id
    `).all(ownerId, scopeNodeId);
    return rows.map((row) => GraphAssertionStore.mapRow(AssertionRowSchema.parse(row)));
  }

  // Promotes an assertion to an explicit, fully confident user statement.
  applyUserConfirmation(assertionId: string): GraphAssertionRecord {
    this.requireAssertion(assertionId);
    this.database.prepare(`
      UPDATE graph_assertions
      SET basis = 'explicit_user_statement', confidence = ?, updated_at_utc = ?
      WHERE id = ?
    `).run(EXPLICIT_CORRECTION_CEILING, this.clock.nowUtc(), assertionId);
    return this.setStatus(assertionId, 'active');
  }

  clearEvidenceLinks(assertionId: string): void {
    this.database.prepare('DELETE FROM assertion_evidence WHERE assertion_id = ?').run(assertionId);
  }
```

```ts
// src/assistant/storage/node-store.ts
  // Used only by the merge service to move an alias row between nodes.
  reassignAliasNode(aliasId: string, nodeId: string): void {
    this.database.prepare('UPDATE graph_node_aliases SET node_id = ? WHERE id = ?').run(nodeId, aliasId);
  }
```

  Import `EXPLICIT_CORRECTION_CEILING` from `../domain/confidence.js` in `assertion-store.ts`. Then in `mutation.ts` replace the raw `UPDATE`/`DELETE` in `confirmAssertion` and `deleteAssertion` with `this.assertions.applyUserConfirmation(...)` and `this.assertions.clearEvidenceLinks(...)`, and in `merge.ts` replace `listByScopeNode`'s body with `this.assertions.listByScopeNode(...)` and both alias `UPDATE`s with `this.nodes.reassignAliasNode(...)`. `GraphMutationService` and `NodeMergeService` still take `database` for `runTransaction` / `this.database.transaction`, which is the only permitted use.

  Re-run `npm test` afterwards; all suites must still pass.

- [ ] **Step 7: Commit**

```bash
git add src/assistant/storage/graph-store.ts src/assistant/graph/ src/assistant/storage/ tests/assistant-gate-a.e2e.test.ts
git commit -m "feat(assistant): add GraphStore facade and Gate A end-to-end coverage"
```

---

## Gate A exit criteria

Gate A is green when all of the following hold and have been observed, not assumed:

- [ ] `npm test` passes with no failures and no skipped assistant tests.
- [ ] `npm run typecheck` passes, including ESLint, with no new suppressions.
- [ ] `CURRENT_SCHEMA_VERSION` is 40; a fresh database and an upgraded database both reach it.
- [ ] Re-running `ensureSchema` against an already-migrated database changes nothing.
- [ ] No file outside `src/assistant/storage/` contains SQL, and no file under `src/assistant/` imports `better-sqlite3` as a value.
- [ ] No type-assertion cast, `any`, non-null `!`, or namespace import exists under `src/assistant/`.
- [ ] Nothing in Gate A is wired into a user-facing surface: no route, no CLI command, no dashboard change, no config field. `git diff main --stat` touches only `src/assistant/`, `src/state/runtime-db.ts`, `tests/`, and this plan.

Only after all of the above is Gate B planned.

## Deliberately out of scope for Gate A

Listed here so a reviewer does not read their absence as an omission:

| Deferred | Gate |
|---|---|
| `SiftConfig.Assistant`, the `assistantMemory` preset flag, Settings ▸ Assistant | C / B |
| Ingestion pipeline, observations, candidate assertions, model extraction | B |
| `memory_projections` (migration v41) and the tier compilers | B |
| Retrieval, prompt assembly, `retrieval_usage` | B |
| Questions, jobs, `/assistant/*` routes, the §15.0 transport guard, CLI | C |
| Tauri shell, desktop activity, screenshots, keychain key provider | D |
| Tier maintenance, export, backup, restore, mobile envelope | E |

`candidate_assertions` and `observations` tables are created in v39 because they belong to the same
migration step, but no Gate A code writes to them.

There is deliberately **no** `AssistantOwnerStore`. `assistant_owners` and `assistant_devices` each
hold exactly one seeded row (`own_local`, `dev_local`) and nothing in Gate A mutates them. Gate C
introduces owner editing when `SiftConfig.Assistant.Owner` lands; Gate D introduces device
registration. Writing a store now would be an unused abstraction.

There is also no `fts.ts`. FTS rows are written by the store that owns the canonical row, inside
the same transaction, which is what design §5.3 requires. A separate FTS module would create a
second place that can forget to run.


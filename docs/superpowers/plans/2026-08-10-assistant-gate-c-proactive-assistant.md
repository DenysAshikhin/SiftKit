# SiftKit Assistant â€” Gate C (Proactive Assistant) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the proactive-question system, complete assistant configuration, authenticated loopback API, CLI, and dashboard Memory Inspector on top of the completed Gate B conversational-memory system.

**Architecture:** `AssistantService` remains the only assistant composition root. Gate C adds migration v42, question and retrieval-usage stores, deterministic question eligibility/scheduling, text-only question planning, user-control services, and authenticated HTTP adapters. The existing durable job runner is extended rather than replaced; chat retrieval remains deterministic and model-free.

**Tech Stack:** TypeScript 5.9, zod-derived contracts, better-sqlite3, Node `node:test`, React, Testing Library, existing status-server `RouteTable` and HTTP client.

## Global Constraints

- Follow TDD for every task: focused failing test, minimum implementation, focused green test, then refactor.
- Do not use worktrees. Do not commit unless the user explicitly requests a commit.
- Do not use SiftKit in a session where the user has disabled it.
- Preserve Gate A and Gate B behavior and keep all existing assistant acceptance tests green.
- All new code and tests are TypeScript. Parse every database row, request body, response body, config value, and model result with zod; derive types with `z.infer`.
- Forbidden: `any`, type assertions, non-null assertions, namespace imports, schema-duplicating types, dynamically passed functions, compatibility shims, optional migration fallbacks, and parallel legacy paths.
- The assistant graph and evidence remain canonical. Projections remain generated database rows.
- `Assistant.Enabled === false` means no memory ingestion, retrieval, job draining, question planning, or memory mutations. Migrations, status reads, and configuration changes still work so the assistant can be re-enabled.
- Chat memory requires both `Assistant.Enabled === true` and `preset.assistantMemory === true`.
- Chat retrieval stays deterministic and makes no model call. `query_intent_parser` is not placed on the chat request path.
- Question policy runs before model planning. The model proposes text only; deterministic services decide eligibility, scheduling, status, and writes.
- When desktop interruption-state signals are unavailable, questions may remain visible as pending dashboard items but may not transition to `shown` or trigger an interruption.
- Every `/assistant/*` route except the loopback-only bootstrap route requires the assistant bearer token.
- Assistant routes reject non-loopback peers with `404`, including when the status server binds `0.0.0.0`.
- The bootstrap response is loopback-only, same-origin-or-no-Origin, `Cache-Control: no-store`, and never appears in the ordinary `/config` response.
- Gate C registers only routes backed by Gate C behavior. Capture, desktop ingestion, mobile ingestion, export, backup, restore, and factory-reset routes remain absent until their gates.
- No assistant inference request contains images, image URLs, base64 image data, or image embeddings.
- Gate C uses schema migration v42. `assistant_jobs` and its lease/preemption implementation already exist in v41 and must not be recreated.
- Gate D screenshot/desktop choices and Gate E compaction/export/backup work are out of scope.
- â€œPending proofâ€ is the existing candidate-validation queue, not a second persistence model.

## Locked Gate-C Corrections

These resolve drift between the approved 2026-07-30 design and the completed Gate B tree.

1. **Migration numbering:** Gate A occupies v39â€“v40 and Gate B occupies v41. Gate C is v42.
2. **Jobs:** Gate B already shipped `assistant_jobs`, `JobStore`, `AssistantJobRunner`, idle-only draining, leases, recovery, retry, and preemption. Gate C adds question job types, configuration-driven priorities, and resource limits only.
3. **Token bootstrap:** the bearer token is never returned by the existing unauthenticated config route. `GET /assistant/auth/bootstrap` is the sole bearer-exempt assistant route and still enforces loopback and Origin checks.
4. **Desktop-state absence:** Gate C defines a versioned `QuestionEnvironmentStateProvider`. The production Gate C provider reports unavailable; pending questions remain dashboard-visible, but delivery fails closed. Gate D supplies native state.
5. **Retrieval roles:** normal chat keeps Gate B's deterministic `QueryIntentExtractor`. Gate C's `query_intent_parser` is available only to an explicit Memory Inspector/CLI search request and never changes the normal chat seam.
6. **Projection summarization:** `projection_summarizer` is a background compression pass. Any uncited sentence or malformed result rejects the whole model result and preserves the deterministic projection byte-for-byte.
7. **Route boundaries:** Gate C does not register placeholder Gate D/E endpoints. Unknown future endpoints return the normal `404`.
8. **Owner identity:** `Assistant.Owner.Id` is the read-only durable ID `own_local` in Gate C. Changing it is rejected; `DisplayName` is editable and updates `assistant_owners`. Multi-owner migration is out of scope.
9. **Assertion demotion:** the approved API includes assertion demotion but the approved schema has no durable representation for it. Migration v42 adds `graph_assertions.user_demoted`; this is an explicit user ranking/projection penalty and is separate from Gate E projection-cap demotion.
10. **Pending validation UI:** `candidate_assertions` in `pending` or `needs_confirmation` state are the canonical â€œproofâ€ queue. Gate C adds durable user notes to those rows. Removing an item rejects it with an explicit user-removal reason, preserving provenance and auditability while removing it from the active queue.

## File Structure

| Area | Files | Responsibility |
|---|---|---|
| Contracts | `packages/contracts/src/assistant.ts`, `packages/contracts/src/config.ts`, `packages/contracts/src/index.ts` | Canonical config and assistant HTTP schemas |
| Migration/domain | `src/assistant/storage/schema.ts`, `src/assistant/storage/rows.ts`, `src/assistant/domain/enums.ts`, `src/state/runtime-db.ts` | v42 tables, row schemas, enums |
| Storage | `src/assistant/storage/question-store.ts`, `retrieval-usage-store.ts` | SQL only for Gate C tables |
| Questions | `src/assistant/questions/candidates.ts`, `policy-engine.ts`, `planner.ts`, `scheduler.ts`, `feedback-service.ts`, `answer-ingestor.ts`, `environment-state.ts` | Candidate discovery, deterministic policy, planning, scheduling, feedback |
| Retrieval/projections | `src/assistant/retrieval/explicit-intent-parser.ts`, `src/assistant/projections/projection-summarizer.ts` | Explicit model-assisted search and validated background compression |
| User control | `src/assistant/control/memory-query-service.ts`, `memory-mutation-service.ts`, `deletion-preview.ts` | Search, explanation, correction, confirmation, pin/demote/forget preview |
| Runtime | `src/assistant/jobs/job-types.ts`, `job-runner.ts`, `resource-policy.ts`, `src/assistant/assistant-graph.ts`, `assistant-service.ts` | Extend the Gate B composition root and runner |
| HTTP | `src/status-server/assistant-auth.ts`, `assistant-rate-limiter.ts`, `routes/assistant.ts`, `routes.ts`, `server-types.ts`, `index.ts` | Guarded Gate C API and lifecycle |
| CLI | `src/cli/assistant-args.ts`, `run-assistant.ts`, `status-server-api-client.ts`, `command-catalog.ts`, `dispatch.ts`, `help.ts` | `siftkit assistant ...` commands |
| Dashboard | `dashboard/src/assistant-api.ts`, `hooks/useAssistantController.ts`, `tabs/AssistantTab.tsx`, `tabs/settings/AssistantSettings.tsx`, `types.ts`, `App.tsx`, `components/Rail.tsx`, styles | Settings and Memory Inspector |

---

### Task 1: Migration v42 â€” questions, feedback, retrieval usage, and assistant config

**Files:**
- Modify: `src/assistant/storage/schema.ts`
- Modify: `src/state/runtime-db.ts`
- Modify: `tests/assistant-migration.test.ts`
- Modify: `tests/helpers/app-config-migration-fixture.ts`

**Interfaces:**
- Produces: `ASSISTANT_PROACTIVE_SCHEMA_SQL`
- Produces: runtime schema version `42`
- Produces tables `assistant_questions`, `assistant_question_feedback`, `retrieval_usage`
- Produces `app_config.assistant_json TEXT NOT NULL DEFAULT '{}'`
- Produces `graph_assertions.user_demoted INTEGER NOT NULL DEFAULT 0`
- Produces `candidate_assertions.user_notes TEXT NOT NULL DEFAULT ''`

- [x] **Step 1: Write failing fresh/upgrade/idempotency tests**

Add tests that open a fresh database and a v41 fixture, then assert exact columns, foreign keys, checks, and indexes. Include:

```ts
assert.equal(CURRENT_SCHEMA_VERSION, 42);
assert.deepEqual(tableNames(database).filter((name) => name.startsWith('assistant_question')), [
  'assistant_question_feedback',
  'assistant_questions',
]);
assert.ok(columnNames(database, 'app_config').includes('assistant_json'));
assert.equal(getSchemaVersion(database), 42);
```

Test that rerunning schema initialization changes neither the version nor seeded data. Test invalid question status/type/feedback values and foreign-owner references fail loudly.

- [x] **Step 2: Run the migration tests and verify RED**

Run: `npm test -- assistant-migration`

Expected: FAIL because schema version 42 and the new tables/column do not exist.

- [x] **Step 3: Add the v42 schema**

Define `ASSISTANT_PROACTIVE_SCHEMA_SQL` with the approved columns from design Â§5.4, adjusted only as follows:

```sql
CREATE TABLE IF NOT EXISTS assistant_questions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES assistant_owners(id) ON DELETE CASCADE,
  topic_key TEXT NOT NULL,
  question_text TEXT NOT NULL,
  question_type TEXT NOT NULL CHECK (question_type IN (
    'confirm_inference', 'resolve_conflict', 'clarify_scope',
    'follow_active_goal', 'fill_relevant_gap'
  )),
  candidate_ids_json TEXT NOT NULL DEFAULT '[]',
  expected_value REAL NOT NULL,
  interruption_cost REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'planned', 'eligible', 'shown', 'answered', 'dismissed', 'snoozed', 'expired', 'blocked'
  )),
  eligible_after_utc TEXT,
  expires_at_utc TEXT,
  shown_at_utc TEXT,
  answered_at_utc TEXT,
  answer_evidence_id TEXT REFERENCES evidence_records(id),
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_questions_schedule_idx
  ON assistant_questions(owner_id, status, eligible_after_utc, expires_at_utc);
CREATE UNIQUE INDEX IF NOT EXISTS assistant_questions_live_topic_uq
  ON assistant_questions(owner_id, topic_key)
  WHERE status IN ('planned', 'eligible', 'shown', 'snoozed');

CREATE TABLE IF NOT EXISTS assistant_question_feedback (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES assistant_owners(id) ON DELETE CASCADE,
  question_id TEXT REFERENCES assistant_questions(id) ON DELETE SET NULL,
  feedback_type TEXT NOT NULL CHECK (feedback_type IN (
    'answer', 'skip', 'snooze', 'do_not_repeat', 'block_topic',
    'change_schedule', 'change_rate_limit'
  )),
  value_json TEXT NOT NULL,
  created_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS retrieval_usage (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES assistant_owners(id) ON DELETE CASCADE,
  conversation_id TEXT,
  query_hash TEXT NOT NULL,
  assertion_ids_json TEXT NOT NULL,
  projection_ids_json TEXT NOT NULL,
  rendered_token_count INTEGER NOT NULL CHECK (rendered_token_count >= 0),
  usefulness_feedback REAL CHECK (
    usefulness_feedback IS NULL OR (usefulness_feedback >= -1.0 AND usefulness_feedback <= 1.0)
  ),
  created_at_utc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS retrieval_usage_owner_time_idx
  ON retrieval_usage(owner_id, created_at_utc DESC);
```

Migration v42 must execute the schema, add `assistant_json` only once, set version 42, and update the fresh-database path. Do not recreate `assistant_jobs`.

It must also add:

```sql
ALTER TABLE graph_assertions
  ADD COLUMN user_demoted INTEGER NOT NULL DEFAULT 0 CHECK (user_demoted IN (0, 1));
```

Add `candidate_assertions.user_notes TEXT NOT NULL DEFAULT ''` through the same idempotent column helper.

Use the migration ladder's existing column-existence helper so an interrupted/re-applied v42 step is idempotent.

- [x] **Step 4: Run focused tests and typecheck**

Run: `npm test -- assistant-migration`

Run: `npm run typecheck`

Expected: PASS.

---

### Task 2: Gate C enums and parsed row schemas

**Files:**
- Modify: `src/assistant/domain/enums.ts`
- Modify: `src/assistant/storage/rows.ts`
- Create: `tests/assistant-proactive-rows.test.ts`

**Interfaces:**
- Produces: `QuestionType`, `QuestionStatus`, `QuestionFeedbackType`
- Produces: `QuestionRow`, `QuestionFeedbackRow`, `RetrievalUsageRow`
- Changes: `AssertionRow` includes parsed boolean-compatible `user_demoted`

- [x] **Step 1: Write failing schema tests**

Test every allowed enum member, reject one unknown member per enum, parse representative SQLite rows, and reject invalid enum/count/range fields. JSON columns remain strings in row schemas and are parsed by their owning stores.

- [x] **Step 2: Run and verify RED**

Run: `npm test -- assistant-proactive-rows`

Expected: FAIL because the exports do not exist.

- [x] **Step 3: Add enum and row schemas**

Use literal arrays and `z.enum`; derive all types. Row schemas mirror SQL names exactly:

```ts
export const QUESTION_TYPES = [
  'confirm_inference', 'resolve_conflict', 'clarify_scope',
  'follow_active_goal', 'fill_relevant_gap',
] as const;
export const QuestionTypeSchema = z.enum(QUESTION_TYPES);
export type QuestionType = z.infer<typeof QuestionTypeSchema>;

export const QUESTION_STATUSES = [
  'planned', 'eligible', 'shown', 'answered', 'dismissed', 'snoozed', 'expired', 'blocked',
] as const;
```

Keep `candidate_ids_json`, assertion IDs, and projection IDs as strings in row schemas. Parse them at store/service boundaries using dedicated zod schemas; do not expose unparsed JSON to question logic.

- [x] **Step 4: Run focused tests**

Run: `npm test -- assistant-proactive-rows`

Expected: PASS.

---

### Task 3: QuestionStore and RetrievalUsageStore

**Files:**
- Create: `src/assistant/storage/question-store.ts`
- Create: `src/assistant/storage/retrieval-usage-store.ts`
- Modify: `src/assistant/assistant-graph.ts`
- Create: `tests/assistant-question-store.test.ts`
- Create: `tests/assistant-retrieval-usage-store.test.ts`

**Interfaces:**
- Produces: `QuestionStore.create`, `get`, `listPending`, `findLiveByTopic`, `markEligible`, `markShown`, `answer`, `dismiss`, `snooze`, `expireDue`, `block`
- Produces: `QuestionStore.recordFeedback`, `listFeedback`
- Produces: `RetrievalUsageStore.record`, `get`, `listRecent`, `setUsefulness`

- [x] **Step 1: Write failing store tests against real SQLite**

Cover creation, deterministic ordering, live-topic uniqueness, every legal transition, invalid transition rejection, snooze timing, expiry, feedback retention after question deletion, owner isolation, retrieval round-trip, usefulness bounds, and missing-row errors.

- [x] **Step 2: Run and verify RED**

Run: `npm test -- assistant-question-store assistant-retrieval-usage-store`

- [x] **Step 3: Implement SQL-only stores**

Use explicit input objects and stable transition errors. `QuestionStore` owns a transition table expressed as a `switch`, not a dynamically passed handler map:

```ts
type QuestionTransition =
  | { kind: 'eligible'; eligibleAfterUtc: string }
  | { kind: 'shown' }
  | { kind: 'answered'; evidenceId: string }
  | { kind: 'dismissed' }
  | { kind: 'snoozed'; eligibleAfterUtc: string }
  | { kind: 'expired' }
  | { kind: 'blocked' };
```

Every write re-reads and parses the row. No store starts a transaction; callers own multi-store atomicity.

- [x] **Step 4: Compose stores into AssistantGraph and verify**

Add readonly `questions` and `retrievalUsage` fields. Run both focused tests plus `npm test -- assistant-graph-crud`.

---

### Task 4: Complete `SiftConfig.Assistant`

**Files:**
- Modify: `packages/contracts/src/config.ts`
- Modify: `src/config/types.ts`
- Modify: `src/config/defaults.ts`
- Modify: `src/config/normalization.ts`
- Modify: `src/status-server/config-store.ts`
- Modify: `tests/runtime-loadconfig.test.ts`
- Create: `tests/assistant-config.test.ts`

**Interfaces:**
- Produces: `AssistantConfigSchema`, `AssistantConfig`, `DEFAULT_ASSISTANT_CONFIG`
- Produces: `normalizeAssistantConfig(value: JsonValue): AssistantConfig`

- [x] **Step 1: Write failing contract/default/round-trip tests**

Assert the strict shape from design Â§6.1, exact documented defaults, normalization from `{}`, database round-trip through `assistant_json`, malformed-value repair to field defaults, and rejection of unknown fields by the public contract schema. Assert `Owner.Id` defaults to `own_local`, is immutable through config updates, and `Owner.DisplayName` synchronizes to `assistant_owners.display_name`.

Add `Background.JobPriorities` with these fixed scalar keys, resolving the Gate B deferral without exposing arbitrary job names:

```ts
const AssistantJobPrioritiesSchema = z.object({
  ConversationIngestion: z.number().int(),
  QuestionAnswerIngestion: z.number().int(),
  QuestionPlanning: z.number().int(),
  CandidateConsolidation: z.number().int(),
  ProjectionMaintenance: z.number().int(),
}).strict();
```

Defaults are 800, 850, 600, 400, and 300 respectively.

- [x] **Step 2: Run and verify RED**

Run: `npm test -- assistant-config runtime-loadconfig`

- [x] **Step 3: Implement the schema and documented defaults**

Copy every scalar and default from design Â§6.1. Export the schema from `@siftkit/contracts`; re-export the inferred type through `src/config/types.ts`. Add `Assistant` to `SiftConfigSchema` as required, not optional.

Normalization must explicitly normalize each nested object. Do not spread unvalidated input into the result. Persist only `JSON.stringify(normalizeAssistantConfig(config.Assistant))` to `assistant_json`.

- [x] **Step 4: Run focused tests and scan all config fixtures**

Run: `npm test -- assistant-config runtime-loadconfig config-`

Run: `npm run typecheck`

Expected: all fixture literals declare `Assistant`; no optional/default compatibility field is added to `SiftConfigSchema`.

---

### Task 5: Configuration-driven job priorities and resource policy

**Files:**
- Modify: `src/assistant/jobs/job-types.ts`
- Modify: `src/assistant/storage/job-store.ts`
- Create: `src/assistant/jobs/resource-policy.ts`
- Modify: `src/assistant/jobs/job-runner.ts`
- Modify: `tests/assistant-job-store.test.ts`
- Modify: `tests/assistant-job-runner.test.ts`
- Create: `tests/assistant-resource-policy.test.ts`

**Interfaces:**
- Changes: `JobStore.enqueue(input, priority: number)`; remove direct dependency on `JOB_PRIORITY`
- Produces: `AssistantResourcePolicy.canStartBackgroundWork(): ResourceDecision`
- Produces: `AssistantResourcePolicy.recordGpuUse(startedAtMs, finishedAtMs): void`

- [x] **Step 1: Write failing priority/resource tests**

Prove configured priority determines claim order, invalid job types still fail parsing, max jobs per drain is honored, daily GPU time blocks only model-backed jobs, and the counter resets on the next local date. Define power state explicitly:

```ts
export const PowerStateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('available'), onBattery: z.boolean(), batteryPercent: z.number().min(0).max(100) }),
  z.object({ kind: z.literal('unavailable') }),
]);
```

Gate C preserves Gate B behavior when power state is unavailable; Gate D supplies native data. When available, `AllowOnBattery` and `MinimumBatteryPercent` are hard gates.

- [x] **Step 2: Run and verify RED**

Run: `npm test -- assistant-job-store assistant-job-runner assistant-resource-policy`

- [x] **Step 3: Move priority ownership to the composition root**

Keep the job-type payload schemas in `job-types.ts`. Resolve each priority from validated `AssistantConfig.Background.JobPriorities` before calling `JobStore.enqueue`. The store writes the explicit priority it receives.

Add resource-policy checks before each claim and before a model-backed job begins. Persist daily usage in `runtime_metadata` under a versioned key so restart does not reset the cap. Do not count preempted wall time after the abort has settled.

- [x] **Step 4: Run focused tests**

Expected: all focused tests pass and Gate B preemption/lease behavior is unchanged.

---

### Task 6: Retrieval usage and explicit model-assisted intent parsing

**Files:**
- Modify: `src/assistant/retrieval/memory-retriever.ts`
- Create: `src/assistant/retrieval/explicit-intent-parser.ts`
- Modify: `src/assistant/inference/roles.ts`
- Modify: `tests/assistant-retrieval.test.ts`
- Create: `tests/assistant-explicit-intent-parser.test.ts`

**Interfaces:**
- Changes: retrieval input accepts `conversationId: string | null` and `recordUsage: boolean`
- Produces: `ExplicitIntentParser.parse(query, abortSignal): Promise<QueryIntent>`
- Adds inference role `query_intent_parser`

- [x] **Step 1: Write failing usage tests**

Assert successful non-empty retrieval writes one `retrieval_usage` row containing the SHA-256 query hash, exact used assertion/projection IDs, and rendered token count. Empty retrieval writes no row. Sensitive raw query text is never stored.

Assert `ExplicitIntentParser` accepts only the existing `QueryIntent` schema, uses text-only inference, and makes a single validated retry through `StructuredOutputRunner`.

- [x] **Step 2: Run and verify RED**

Run: `npm test -- assistant-retrieval assistant-explicit-intent-parser`

- [x] **Step 3: Implement without changing chat latency**

Inject `RetrievalUsageStore` into `MemoryRetriever`. Record only after the final rendered block is known. Add the explicit parser as a separate service used by Memory Inspector/CLI search only. Do not call it from `ChatMemorySeam` or `retrieveMemoryContext`.

- [x] **Step 4: Run focused tests and the chat seam regressions**

Run: `npm test -- assistant-retrieval assistant-explicit-intent-parser assistant-chat-seam assistant-streaming-chat-memory`

Expected: opted-out and empty-memory prompts remain byte-identical.

---

### Task 7: Validated projection summarizer

**Files:**
- Create: `src/assistant/projections/projection-summarizer.ts`
- Modify: `src/assistant/inference/roles.ts`
- Modify: `src/assistant/projections/projection-compiler.ts`
- Create: `tests/assistant-projection-summarizer.test.ts`

**Interfaces:**
- Produces: `ProjectionSummarizer.summarize(input, abortSignal): Promise<SummarizeProjectionResult>`
- Adds inference role `projection_summarizer`

- [x] **Step 1: Write failing tests**

Cover valid cited compression, malformed output, unknown assertion citation, uncited sentence, token overflow, sensitive assertion exclusion, abort, and inference failure. Every rejected result must return the exact deterministic original body.

- [x] **Step 2: Run and verify RED**

Run: `npm test -- assistant-projection-summarizer`

- [x] **Step 3: Implement the background-only pass**

Use an output schema whose sentences each contain `text` and a non-empty `assertionIds` list. Validate every ID against the supplied assertion set. Join only validated sentences, enforce the existing tier limit, and return a discriminated result:

```ts
const SummarizeProjectionResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('summarized'), body: z.string(), assertionIds: z.array(z.string()) }),
  z.object({ kind: z.literal('unchanged'), reason: z.string() }),
]);
```

The deterministic compiler writes first. Enqueue summarization only when that body exceeds the configured target token count. Summarization may replace its content only after complete validation; an unchanged graph version returns the existing projection and never invokes summarization again, preserving Gate B's byte-identical recompile behavior.

- [x] **Step 4: Run projection tests**

Run: `npm test -- assistant-projection-summarizer assistant-projection-compiler assistant-token-limit-enforcer`

---

### Task 8: Assistant bearer token, loopback guard, and bootstrap

**Files:**
- Create: `src/status-server/assistant-auth.ts`
- Create: `tests/assistant-auth.test.ts`
- Modify: `src/status-server/server-types.ts`

**Interfaces:**
- Produces: `AssistantTokenStore.getOrCreate(): string`
- Produces: `AssistantRouteGuard.authorize(req, mode): AssistantAuthorization`
- Modes: `'bootstrap' | 'bearer'`

- [x] **Step 1: Write failing unit and live-server tests**

Cover first-start 32-byte token generation, stable reuse, distinct database tokens, constant-time comparison, IPv4/IPv6/IPv4-mapped loopback, non-loopback `404`, missing/wrong token `401`, accepted `Bearer <token>`, bootstrap Origin rejection, and `Cache-Control: no-store`.

- [x] **Step 2: Run and verify RED**

Run: `npm test -- assistant-auth`

- [x] **Step 3: Implement authentication**

Store the base64url token in `runtime_metadata` under `assistant.api.token.v1`. Generate with `randomBytes(32)`. Compare decoded bytes only after equal-length validation with `timingSafeEqual`.

`bootstrap` requires loopback and either no `Origin` header or an Origin whose host and port match the request Host. It does not require bearer authentication. `bearer` requires all loopback checks plus the token.

Do not log tokens, authorization headers, or bootstrap bodies.

- [x] **Step 4: Run focused security tests**

Expected: non-loopback is indistinguishable from an absent route and token failures do not expose token metadata.

---

### Task 9: Shared assistant API contracts

**Files:**
- Create: `packages/contracts/src/assistant.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `tests/assistant-contracts.test.ts`

**Interfaces:**
- Produces schemas/types for assistant status, config patch, graph summaries/details, assertions, explanations, projections, questions, policies, previews, mutations, and errors

- [x] **Step 1: Write failing contract tests**

Round-trip one valid example and reject one malformed example for every request and response schema. Ensure sensitive evidence DTOs expose metadata and deliberate-reveal state, never decrypted content by default.

- [x] **Step 2: Run and verify RED**

Run: `npm test -- assistant-contracts`

- [x] **Step 3: Implement canonical strict schemas**

Use zod composition and inferred types. Reuse `AssistantConfigSchema`; do not reproduce row schemas in the contracts package. Public DTO field names use camelCase and are mapped from parsed storage rows inside services.

Mutation requests carry `reason`. Destructive requests use:

```ts
export const AssistantDestructiveRequestSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('preview') }),
  z.object({ mode: z.literal('confirm'), previewToken: z.string().min(1) }),
]);
```

`PATCH /assistant/config` is deliberately a complete replacement of the `Assistant` block, represented as `{ assistant: AssistantConfigSchema }`; it never performs an ambiguous recursive partial merge.

- [x] **Step 4: Build contracts and run tests**

Run: `npm --prefix .\packages\contracts run build`

Run: `npm test -- assistant-contracts`

---

### Task 10: Memory query and explanation service

**Files:**
- Create: `src/assistant/control/memory-query-service.ts`
- Modify: `src/assistant/storage/node-store.ts`
- Modify: `src/assistant/storage/assertion-store.ts`
- Modify: `src/assistant/storage/evidence-store.ts`
- Create: `tests/assistant-memory-query-service.test.ts`

**Interfaces:**
- Produces: `search`, `getNode`, `getNeighborhood`, `listAssertions`, `getAssertion`, `explainAssertion`, `listEvidence`, `getEvidenceMetadata`, `listProjections`

- [x] **Step 1: Write failing end-to-end query tests**

Seed a real graph and prove bounded pagination, owner isolation, FTS search, assertion explanation containing basis/confidence/validity/evidence/mutations, bounded neighborhood limits, sensitive redaction, and missing-row `not_found` results.

- [x] **Step 2: Run and verify RED**

Run: `npm test -- assistant-memory-query-service`

- [x] **Step 3: Implement one read service**

Add only the narrow list methods missing from stores. `MemoryQueryService` maps parsed rows to public DTOs and owns pagination caps. It never performs SQL directly and never decrypts a blob for list/detail metadata.

- [x] **Step 4: Run focused tests**

Run: `npm test -- assistant-memory-query-service assistant-neighborhood assistant-retrieval`

---

### Task 11: Memory mutations and destructive previews

**Files:**
- Create: `src/assistant/control/deletion-preview.ts`
- Create: `src/assistant/control/memory-mutation-service.ts`
- Modify: `src/assistant/projections/projection-compiler.ts`
- Create: `tests/assistant-memory-mutation-service.test.ts`

**Interfaces:**
- Produces: confirm, correct, pin, demote, previewForgetAssertion, confirmForgetAssertion, rebuildProjections

- [x] **Step 1: Write failing mutation tests**

Cover confirmation, correction supersession, pin/unpin, demotion, preview with affected projections/dependent assertions, preview-token tamper, stale preview after graph-version change, confirmed forget, projection refresh, audit/mutation history, and background-race rejection.

- [x] **Step 2: Run and verify RED**

Run: `npm test -- assistant-memory-mutation-service`

- [x] **Step 3: Implement explicit transactional workflows**

Preview tokens are HMAC-SHA-256 over owner ID, operation, target ID, graph version, and affected IDs using a separate versioned secret in `runtime_metadata`. Confirmation recomputes the preview inside an explicit assistant transaction and rejects any mismatch.

Use existing `AssertionService` methods. A confirmed forget marks the assertion deleted, records mutation/audit entries, increments graph version once, and enqueues projection maintenance. Do not implement topic deletion, raw evidence deletion, or factory reset; those remain Gate E.

Demotion sets `user_demoted = 1`, records an `update_assertion` mutation, removes the assertion from Tier 1, applies the maximum negative user-priority term in tier utility and retrieval ranking, and recompiles affected projections. It does not lower factual confidence or delete provenance. Pinning clears `user_demoted`; demotion clears `pinned`, so an assertion cannot carry contradictory explicit priority states.

- [x] **Step 4: Run focused mutation and Gate A regression tests**

Run: `npm test -- assistant-memory-mutation-service assistant-assertion-service assistant-gate-a-e2e`

---

### Task 12: Deterministic question candidates and policy engine

**Files:**
- Create: `src/assistant/questions/candidates.ts`
- Create: `src/assistant/questions/environment-state.ts`
- Create: `src/assistant/questions/policy-engine.ts`
- Create: `tests/assistant-question-policy.test.ts`

**Interfaces:**
- Produces: `QuestionCandidateSource.list(ownerId): QuestionCandidate[]`
- Produces: `QuestionEnvironmentStateProvider.read(): QuestionEnvironmentState`
- Produces: `QuestionPolicyEngine.evaluate(candidate, config): QuestionPolicyDecision`

- [x] **Step 1: Write failing branch-complete policy tests**

Cover disabled assistant/questions, missing concrete benefit, unsupported gap type, blocked topic, local-time window including midnight wrap, daily/weekly caps, minimum interval, dismissed cooldown, duplicate live question, expiry, fullscreen/locked/DND/presenting/excluded app, recent input, private mode, sensitivity cost, score below threshold, and unavailable environment.

Unavailable environment returns `pending_only`, not `eligible`.

- [x] **Step 2: Run and verify RED**

Run: `npm test -- assistant-question-policy`

- [x] **Step 3: Implement deterministic candidate derivation and policy**

Initial candidate sources are concrete graph states only:

- `candidate_assertions.status = 'needs_confirmation'` â†’ `confirm_inference` or `clarify_scope`;
- `graph_assertions.status = 'disputed'` â†’ `resolve_conflict`;
- an active `goal` node with no live `HAS_PLAN` assertion â†’ `follow_active_goal`.

Normalize every score component to `[0, 1]`. Calculate exactly:

```ts
const score = uncertaintyReduction * futureUsefulness * currentRelevance * answerability
  - interruptionCost - sensitivityCost - repeatPenalty;
```

Eligible requires `score > 0`; equality is ineligible. Policy emits stable reason codes and never calls inference.

- [x] **Step 4: Run focused tests**

Expected: every eligibility branch has a named test and idleness alone never makes a question eligible.

---

### Task 13: Question planner and scheduler

**Files:**
- Create: `src/assistant/questions/planner.ts`
- Create: `src/assistant/questions/scheduler.ts`
- Modify: `src/assistant/inference/roles.ts`
- Create: `tests/assistant-question-planner.test.ts`
- Create: `tests/assistant-question-scheduler.test.ts`

**Interfaces:**
- Produces: `QuestionPlanner.plan(candidate, abortSignal): Promise<QuestionProposal>`
- Produces: `QuestionScheduler.planPending(ownerId): Promise<PlanQuestionsSummary>`
- Produces: `QuestionScheduler.current(ownerId): QuestionRow | null`
- Adds inference role `question_planner`

- [x] **Step 1: Write failing planner/scheduler tests**

Prove the planner receives only policy-approved structured facts, produces text only, cannot alter topic/type/score/schedule, retries malformed output once, and honors abort. Prove the scheduler deduplicates, expires due rows, respects deterministic ordering, stores pending-only rows without showing them, and marks one eligible row when environment state is available.

- [x] **Step 2: Run and verify RED**

Run: `npm test -- assistant-question-planner assistant-question-scheduler`

- [x] **Step 3: Implement planner and scheduler**

The model output schema is deliberately narrow:

```ts
const QuestionProposalSchema = z.object({ questionText: z.string().trim().min(1).max(500) }).strict();
```

The scheduler runs policy before planner, sorts by score descending then stable topic key, plans at most the configured remaining daily capacity, and writes through `QuestionStore` inside an explicit transaction. No UI delivery call exists in Gate C.

- [x] **Step 4: Run focused tests and no-image spy**

Run: `npm test -- assistant-question-planner assistant-question-scheduler assistant-inference-client`

---

### Task 14: Question feedback and answer ingestion

**Files:**
- Create: `src/assistant/questions/feedback-service.ts`
- Create: `src/assistant/questions/answer-ingestor.ts`
- Modify: `src/assistant/ingestion/envelope.ts`
- Modify: `src/assistant/ingestion/pipeline.ts`
- Create: `tests/assistant-question-feedback.test.ts`

**Interfaces:**
- Produces: answer, skip, snooze, doNotRepeat, blockTopic, changeSchedule, changeRateLimit

- [x] **Step 1: Write failing transactional workflow tests**

Answer must atomically record `question_answer` evidence, feedback, question status, and a `question_answer_ingestion` job. Cover empty/secret answer rejection, replay idempotency, snooze boundary, do-not-repeat, block-topic policy creation before further inference, schedule/rate config changes, and rollback on every injected write failure.

- [x] **Step 2: Run and verify RED**

Run: `npm test -- assistant-question-feedback`

- [x] **Step 3: Implement feedback workflows**

Use explicit transaction scopes. `answer` evidence uses basis `explicit_question_answer` and outranks passive evidence through `QuestionAnswerIngestor`, which invokes the existing structured extraction/candidate validation boundary but fixes the promoted basis to `explicit_question_answer`. Policy/config feedback writes occur before any job enqueue. Stable idempotency key:

```ts
`question_answer_ingestion:${questionId}:${evidence.content_hash}`
```

Do not reuse the conversation envelope with an optional compatibility field; add a required `question_answer` envelope variant.

- [x] **Step 4: Run focused ingestion and precedence tests**

Run: `npm test -- assistant-question-feedback assistant-ingestion-pipeline assistant-assertion-service`

---

### Task 15: Extend the durable runner for Gate C work

**Files:**
- Modify: `src/assistant/jobs/job-types.ts`
- Modify: `src/assistant/storage/job-store.ts`
- Modify: `src/assistant/jobs/job-runner.ts`
- Modify: `tests/assistant-job-store.test.ts`
- Modify: `tests/assistant-job-runner.test.ts`

**Interfaces:**
- Adds job types `question_planning`, `question_answer_ingestion`, `projection_summarization`
- Adds parsed payload schemas and explicit runner branches

- [x] **Step 1: Write failing job tests**

Cover payload validation, configured claim order, question planning, answer extraction/promotion, projection summarization, preemption for every model-backed branch, retry/dead-letter behavior, idempotent enqueue, and absence of attempt consumption on preemption.

- [x] **Step 2: Run and verify RED**

Run: `npm test -- assistant-job-store assistant-job-runner`

- [x] **Step 3: Add explicit job branches**

Extend `ASSISTANT_JOB_TYPES` and the runner `switch`. Do not introduce a handler map. Inject `QuestionScheduler`, question-answer extractor/promoter dependencies, `ProjectionSummarizer`, priorities, and resource policy through `AssistantJobRunnerOptions`.

- [x] **Step 4: Run focused jobs and Gate B E2E**

Run: `npm test -- assistant-job-store assistant-job-runner assistant-gate-b-e2e`

Expected: Gate B jobs preserve their current semantics.

---

### Task 16: Extend AssistantService and enforce `Assistant.Enabled`

**Files:**
- Modify: `src/assistant/assistant-service.ts`
- Modify: `src/status-server/chat-memory-seam.ts`
- Modify: `src/status-server/index.ts`
- Modify: `src/status-server/server-types.ts`
- Modify: `tests/assistant-service.test.ts`
- Modify: `tests/assistant-chat-seam.test.ts`

**Interfaces:**
- Extends `AssistantRuntime` with status/config refresh, query, mutation, question, and policy operations needed by adapters
- Adds `AssistantServiceOptions.config: AssistantConfig`

- [x] **Step 1: Write failing enabled/disabled and composition tests**

Prove disabled assistant creates no owner-person node beyond migration seeds, performs no retrieval/ingestion/draining/questions/mutations, and returns a disabled status. Prove enabled assistant composes all Gate C services. Prove config refresh changes gates and limits without rebuilding the graph stores.

- [x] **Step 2: Run and verify RED**

Run: `npm test -- assistant-service assistant-chat-seam`

- [x] **Step 3: Extend the composition root**

Keep service construction fail-soft in the status server. Store the current validated config in `AssistantService`; expose explicit methods rather than stores to HTTP/CLI/UI. `ChatMemorySeam` checks both gates before retrieval and ingestion.

Use `config.Background.MaxJobsPerIdleSession` instead of `MAX_JOBS_PER_DRAIN`; use config memory/retrieval token and graph bounds instead of Gate B constants.

- [x] **Step 4: Run focused service and chat tests**

Run: `npm test -- assistant-service assistant-chat-seam assistant-streaming-chat-memory assistant-gate-b-e2e`

---

### Task 17: Guarded Gate C HTTP routes

**Files:**
- Create: `src/status-server/assistant-rate-limiter.ts`
- Create: `src/status-server/routes/assistant.ts`
- Modify: `src/status-server/routes.ts`
- Modify: `src/status-server/server-types.ts`
- Modify: `src/status-server/index.ts`
- Create: `tests/assistant-routes.test.ts`
- Create: `tests/assistant-transport-guard.test.ts`

**Interfaces:**
- Produces: `handleAssistantRoute(ctx, req, res, pathname): Promise<boolean>`
- Produces: pending-validation list, note-update, and queue-removal routes

- [x] **Step 1: Write failing live-HTTP tests**

Test bootstrap, bearer enforcement, loopback/non-loopback, disabled/unavailable service, malformed JSON, body caps, rate caps, not-found IDs, conflicts, previews, and every Gate C route:

```text
GET    /assistant/auth/bootstrap
GET    /assistant/status
GET    /assistant/config
PATCH  /assistant/config
GET    /assistant/search
GET    /assistant/graph/nodes
GET    /assistant/graph/nodes/{nodeId}
GET    /assistant/graph/nodes/{nodeId}/neighborhood
GET    /assistant/graph/assertions
GET    /assistant/graph/assertions/{assertionId}
GET    /assistant/graph/assertions/{assertionId}/explanation
POST   /assistant/graph/assertions/{assertionId}/confirm
POST   /assistant/graph/assertions/{assertionId}/correct
POST   /assistant/graph/assertions/{assertionId}/pin
POST   /assistant/graph/assertions/{assertionId}/demote
DELETE /assistant/graph/assertions/{assertionId}
GET    /assistant/evidence
GET    /assistant/evidence/{evidenceId}
GET    /assistant/projections
POST   /assistant/projections/rebuild
GET    /assistant/questions/current
POST   /assistant/questions/{questionId}/answer
POST   /assistant/questions/{questionId}/skip
POST   /assistant/questions/{questionId}/snooze
POST   /assistant/questions/{questionId}/do-not-repeat
POST   /assistant/questions/{questionId}/block-topic
GET    /assistant/policies
PATCH  /assistant/policies/{policyId}
DELETE /assistant/policies/{policyId}
GET    /assistant/validation
PATCH  /assistant/validation/{candidateId}/notes
DELETE /assistant/validation/{candidateId}
```

Assert `/assistant/capture/*`, `/assistant/ingest/*`, `/assistant/export`, and `/assistant/backup` return ordinary `404`.

Use fixed-window in-memory limits per bearer token: 120 reads/minute, 30 mutations/minute, and 10 question answers/minute. Enforce the question-answer body cap of 64 KiB and all other mutation body caps of 256 KiB before parsing JSON. Restart may reset counters; no durable rate state is required.

- [x] **Step 2: Run and verify RED**

Run: `npm test -- assistant-routes assistant-transport-guard`

- [x] **Step 3: Implement one guarded RouteTable**

Run the assistant guard before matching bearer-protected routes so unknown `/assistant/*` paths do not leak route presence remotely. Parse all bodies and responses with shared contracts. Use 404 for missing resources, 409 for stale preview/state conflicts, 413 for body cap, 429 for rate cap, and 503 when the assistant failed to construct.

Config PATCH accepts the complete `AssistantConfig`, writes through the existing config store, and refreshes `AssistantService` only after durable persistence succeeds.

- [x] **Step 4: Run focused route/security tests**

Run: `npm test -- assistant-routes assistant-transport-guard routes-`

---

### Task 18: Assistant CLI

**Files:**
- Create: `src/cli/assistant-args.ts`
- Create: `src/cli/run-assistant.ts`
- Modify: `src/cli/status-server-api-client.ts`
- Modify: `src/cli/command-catalog.ts`
- Modify: `src/cli/dispatch.ts`
- Modify: `src/cli/help.ts`
- Create: `tests/assistant-cli.test.ts`

**Interfaces:**
- Adds top-level command `assistant`
- Adds authenticated JSON methods to `StatusServerApiClient`

- [x] **Step 1: Write failing parser/client/output tests**

Cover exact commands:

```text
siftkit assistant status
siftkit assistant pause
siftkit assistant resume
siftkit assistant memory search <query> [--model-intent]
siftkit assistant memory explain <assertion-id>
siftkit assistant memory confirm <assertion-id>
siftkit assistant memory correct <assertion-id> --value <json>
siftkit assistant memory forget <assertion-id> --preview
siftkit assistant memory forget <assertion-id> --confirm <preview-token>
siftkit assistant policy list
siftkit assistant policy block-topic <topic>
siftkit assistant projections rebuild
```

Reject missing modes, simultaneous preview/confirm, unknown options, empty IDs/topics, and capture/export/backup commands that belong to later gates.

- [x] **Step 2: Run and verify RED**

Run: `npm test -- assistant-cli`

- [x] **Step 3: Implement CLI and token bootstrap**

The API client fetches the bootstrap token for each CLI invocation, holds it only in memory, and sends `Authorization: Bearer`. Output is stable JSON for status/search/explain/list/preview and one concise line for successful mutations. Never print the bearer token.

`pause` and `resume` update `Assistant.Enabled`; they do not create a second runtime state.

- [x] **Step 4: Run CLI tests and help snapshot tests**

Run: `npm test -- assistant-cli cli-help`

---

### Task 19: Dashboard Assistant settings

**Files:**
- Create: `dashboard/src/tabs/settings/AssistantSettings.tsx`
- Modify: `dashboard/src/tabs/SettingsTab.tsx`
- Modify: `dashboard/src/settings-sections.ts`
- Modify: `dashboard/src/hooks/useSettingsController.ts`
- Modify: `dashboard/src/types.ts`
- Create: `dashboard/tests/assistant-settings.test.tsx`

**Interfaces:**
- Adds `assistant` settings section bound directly to `DashboardConfig.Assistant`
- Adds a polished `Pending validation` page backed by candidate assertions

- [x] **Step 1: Write failing component/controller tests**

Render every Â§6.1 scalar, edit representative booleans/numbers/time strings, validate min/max constraints, save/reload, show dirty-state confirmation, and verify sensitive security copy states that evidence encryption uses a file key until Gate D supplies the OS keychain provider.

- [x] **Step 2: Run and verify RED**

Run: `npm test -- assistant-settings`

The component test also renders every `pending` or `needs_confirmation` candidate with its proposed statement, rationale, confidence, source/evidence context, status, and durable user notes. Cover saving notes and confirmed removal from the active queue.

- [x] **Step 3: Implement the settings section**

Add a `Pending validation` subpage under Assistant settings. Saving notes updates `candidate_assertions.user_notes`. Removal calls the rejection endpoint with `removed_by_user`; it does not delete source evidence or erase audit history.

Use existing `SettingsFields` and controller action patterns. Group controls by General, Memory, Retrieval, Questions, Observation, Retention, Background, and Private Mode. Observation controls are configurable but clearly marked â€œused by Gate D desktop observationâ€; do not add fake capture status.

- [x] **Step 4: Run dashboard settings tests**

Run: `npm test -- assistant-settings settings-tab dashboard-settings-controller`

Run: `npm run typecheck:dashboard-test`

---

### Task 20: Dashboard Memory Inspector and questions

**Files:**
- Create: `dashboard/src/assistant-api.ts`
- Create: `dashboard/src/hooks/useAssistantController.ts`
- Create: `dashboard/src/tabs/AssistantTab.tsx`
- Create: `dashboard/src/components/AssistantMemoryDetail.tsx`
- Create: `dashboard/src/components/AssistantQuestionCard.tsx`
- Modify: `dashboard/src/App.tsx`
- Modify: `dashboard/src/components/Rail.tsx`
- Modify: `dashboard/src/types.ts`
- Modify: `dashboard/src/styles/layout.css`
- Create: `dashboard/src/styles/assistant.css`
- Create: `dashboard/tests/assistant-tab.test.tsx`
- Create: `tests/assistant-dashboard-e2e.test.ts`

**Interfaces:**
- Adds dashboard tab key `assistant`
- Produces typed API calls that bootstrap once per page lifecycle and keep the token only in controller memory

- [x] **Step 1: Write failing UI and live-server tests**

Cover tab navigation, status, search/filter, node/assertion/projection detail, evidence/mutation explanation, bounded neighborhood, sensitive reveal affordance without automatic content loading, confirm/correct/pin/demote, forget preview/confirm, policies, pending question answer/skip/snooze/block, stale preview handling, loading/empty/error states, and token redaction from rendered DOM/errors.

- [x] **Step 2: Run and verify RED**

Run: `npm test -- assistant-tab assistant-dashboard-e2e`

- [x] **Step 3: Implement the smallest complete inspector**

Use a three-pane layout only when viewport width permits: search/results, selected detail, contextual actions/questions. On narrow screens stack those regions. Do not add a canvas graph; render the bounded neighborhood as an accessible node/edge list in Gate C.

Every destructive action opens the server-generated preview before enabling confirm. Sensitive evidence metadata renders by default; content retrieval remains absent until the later deliberate-preview workflow.

- [x] **Step 4: Run dashboard tests**

Run: `npm test -- assistant-tab assistant-dashboard-e2e app-shell rail`

Run: `npm run typecheck:dashboard-test`

---

### Task 21: Gate C end-to-end acceptance and closeout

**Files:**
- Create: `tests/assistant-gate-c-e2e.test.ts`
- Modify: `docs/superpowers/handoffs/` only during final closeout, after implementation is green

**Interfaces:**
- Demonstrates every Gate C exit criterion through public service/HTTP/CLI/UI seams

- [x] **Step 1: Write the failing Gate C E2E scenarios**

Use real SQLite, injected clock/IDs, fake text-only inference, and a live status server. Cover:

1. Enable assistant â†’ disputed memory produces one pending question â†’ answer enqueues work â†’ explicit answer supersedes/reinforces memory â†’ projection refreshes.
2. Daily/weekly/time/cooldown/topic/private-mode limits hold; unavailable desktop state never marks a question shown.
3. Interactive request preempts question planning within one second and the job resumes with unchanged attempt count.
4. Memory is searchable, explainable, correctable, pinnable, demotable, and forgettable through authenticated HTTP and CLI.
5. Forget requires preview; a changed graph invalidates the token; confirmed forget removes the assertion from retrieval and projections.
6. Non-loopback assistant request gets `404` while bound to `0.0.0.0`; missing/wrong bearer gets `401`; bootstrap is loopback/origin constrained.
7. Disabled assistant performs no ingestion, retrieval, jobs, or question work while ordinary SiftKit chat remains usable.
8. Every assistant inference spy request is text-only.
9. Future Gate D/E assistant endpoints are absent.

- [x] **Step 2: Run Gate C E2E and verify RED before final wiring**

Run: `npm test -- assistant-gate-c-e2e`

- [x] **Step 3: Make only acceptance-wiring fixes**

Fix missing composition or adapter wiring exposed by E2E. Do not add new product scope or weaken assertions.

- [x] **Step 4: Run focused Gate C validation**

Run: `npm test -- assistant`

Run: `npm test -- assistant-gate-c-e2e assistant-dashboard-e2e assistant-transport-guard assistant-cli`

- [x] **Step 5: Run broad repository validation with large output summarized**

Run the repository-required commands, routing large output through the session-approved summarization mechanism. If SiftKit remains disabled, capture output to the single scratch directory and inspect only narrowed failures:

```powershell
npm test
npm run typecheck
npm run lint
npm run build
git diff --check
```

Expected: zero failures, no new skips, no orphaned managed workers, and no listeners left on test/status ports.

- [x] **Step 6: Independent review and handoff**

Review the complete diff for scope drift, duplicate schemas, callback transactions, casts, non-null assertions, unvalidated IO, plaintext sensitive content, token logging, unguarded routes, and placeholder later-gate endpoints. Remove the single scratch directory. Write a Gate C completion handoff with exact commands/counts, deviations, remaining Gate D decisions, and current workspace state. Do not commit unless requested.

---

## Gate C Acceptance Checklist

Verify each item by running its named tests, not by inspection alone.

| Criterion | Evidence |
|---|---|
| Migration v42 applies fresh, upgrades v41, and re-applies safely | `assistant-migration.test.ts` |
| Assistant config is strict, normalized, persisted, and complete | `assistant-config.test.ts`, `runtime-loadconfig.test.ts` |
| Disabled assistant performs no work | `assistant-service.test.ts`, `assistant-gate-c-e2e.test.ts` |
| Chat memory requires both global and preset gates | `assistant-chat-seam.test.ts` |
| Background work respects configured priority/resource limits | `assistant-resource-policy.test.ts`, `assistant-job-runner.test.ts` |
| Interactive work preempts background inference within one second | `assistant-job-runner.test.ts`, `assistant-gate-c-e2e.test.ts` |
| Question policy is deterministic and model-independent | `assistant-question-policy.test.ts` |
| Unavailable desktop state never causes an interruption | `assistant-question-policy.test.ts`, `assistant-question-scheduler.test.ts` |
| Question feedback applies policy/config before model work | `assistant-question-feedback.test.ts` |
| Explicit answers outrank passive evidence | `assistant-question-feedback.test.ts`, `assistant-gate-c-e2e.test.ts` |
| Retrieval usage stores hashes/IDs/counts, not query text | `assistant-retrieval.test.ts` |
| Normal chat retrieval remains model-free | `assistant-chat-seam.test.ts`, `assistant-streaming-chat-memory.test.ts` |
| Projection summarization cannot introduce uncited facts | `assistant-projection-summarizer.test.ts` |
| Every memory is searchable and explainable | `assistant-memory-query-service.test.ts` |
| Correction, confirmation, pin, demote, and forget are audited | `assistant-memory-mutation-service.test.ts` |
| Destructive actions require a fresh preview token | `assistant-memory-mutation-service.test.ts`, `assistant-routes.test.ts` |
| All Gate C routes are loopback-only and bearer-authenticated | `assistant-transport-guard.test.ts` |
| Bootstrap does not leak through ordinary config or logs | `assistant-auth.test.ts`, `assistant-dashboard-e2e.test.ts` |
| CLI and dashboard expose the same supported control surface | `assistant-cli.test.ts`, `assistant-dashboard-e2e.test.ts` |
| Later-gate routes are not registered | `assistant-routes.test.ts`, `assistant-gate-c-e2e.test.ts` |
| No assistant inference request contains images | `assistant-inference-client.test.ts`, `assistant-gate-c-e2e.test.ts` |
| Full repository validation is green and leaves no orphan processes | final Task 21 evidence |

## Explicitly Out of Scope

- Tauri 2 shell, tray, popup delivery, native activity/idle/power/keychain providers.
- Desktop activity, sessionization, accessibility/OCR ingestion, screenshots, blob ingestion envelopes.
- Screenshot pixels or LLM vision.
- Tier demotion/merge/archive compaction beyond explicit user demotion.
- Topic deletion, raw evidence deletion, deletion-barrier generalization, factory reset.
- Export, backup, restore, mobile envelope, pairing, or mobile client.
- 24-hour soak, performance benchmarks, installer/update/uninstall documentation.
- macOS or Linux native adapters.

## Execution Order

Tasks are sequential because later contracts and adapters depend on earlier schema/service boundaries:

`1 â†’ 2 â†’ 3 â†’ 4 â†’ 5 â†’ 6 â†’ 7 â†’ 8 â†’ 9 â†’ 10 â†’ 11 â†’ 12 â†’ 13 â†’ 14 â†’ 15 â†’ 16 â†’ 17 â†’ 18 â†’ 19 â†’ 20 â†’ 21`

At each task boundary: inspect only that task's diff, run its focused tests independently, run typecheck when public types changed, remove scope drift, and continue only with a green tree.

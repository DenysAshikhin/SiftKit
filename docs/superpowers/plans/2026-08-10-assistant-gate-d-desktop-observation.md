# Assistant Gate D — Desktop Observation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Session constraints (override generic skill wording):** execute inline — no SiftKit, no
> subagents, no worktrees, and **no git commits**. TDD every task. Where this plan template would
> normally say "commit", run the focused tests instead and continue.

**Goal:** Ship the Gate D desktop-observation layer: Tauri 2 shell with Rust Windows adapters,
tray + native question popup, activity/sessionization, silent encrypted screenshot capture with
fail-closed privacy preflight, an image-extraction queue gated on live runtime vision capability,
retention, and DPAPI key custody.

**Architecture:** Thin Tauri shell + authenticated daemon ingestion (approved spec
`docs/superpowers/specs/2026-08-10-assistant-gate-d-desktop-observation-design.md`). Rust computes
bytes/hashes/preflight facts and ships versioned DTOs to loopback `/assistant/*`; the Node daemon
owns all policy, crypto at rest, the queue, and retention. React gains settings + preview only.

**Tech Stack:** TypeScript (strict, zod-validated IO), `node:test`, Tauri 2 + Rust (windows crate),
existing status-server/assistant modules, portable rustup/cargo under
`C:\Users\denys\Documents\GitHub\.tooling\siftkit-gate-d\`.

**Verification commands** (after any task): `npm test -- assistant`, `npm run typecheck`,
`npm run lint`; Rust tasks additionally `npm run desktop:test`. Full gate at Task 28.

**Established seams this plan builds on** (verified 2026-08-10):

- `src/assistant/crypto/key-provider.ts` — `AssistantKeyProvider { getActiveKey(); getKeyById() }`.
- `src/assistant/crypto/blob-cipher.ts` — `BlobCipher.encrypt/decrypt`, hard tamper errors.
- `src/assistant/storage/evidence-store.ts` — `recordBlobEvidence(RecordBlobEvidenceInput)`.
- `src/assistant/storage/schema.ts` — schema SQL constants; `src/state/runtime-db.ts` migration
  ladder currently ends at `setSchemaVersion(database, 42)`. Gate D adds **v43**.
- `src/assistant/jobs/job-types.ts` — `ASSISTANT_JOB_TYPES` + payload schemas;
  `job-runner.ts` `execute()` switch.
- `src/assistant/jobs/resource-policy.ts` — `PowerStateProvider`/`UnavailablePowerStateProvider`.
- `src/assistant/questions/environment-state.ts` — `QuestionEnvironmentStateProvider`.
- `src/assistant/assistant-service.ts` — composition root; currently instantiates the two
  Unavailable providers directly.
- `src/status-server/routes/assistant.ts` — pathname-dispatch endpoint + route table +
  `assistant-auth.ts` bearer bootstrap.
- `src/status-server/managed-inference-runtime.ts` — process/model state transitions (gains a
  generation counter); `applied-model-preset-state.ts` — active `ModelRuntimePreset`
  (`VisionEnabled`).
- `packages/contracts/src/image.ts` — `ImageDataUrlSchema`, `SIFT_MAX_IMAGE_BYTES`;
  `src/llm-protocol/image-attachments.ts`, `preset-image-admission.ts`.
- `src/assistant/domain/enums.ts` — `EVIDENCE_SOURCE_TYPES` already includes
  `'desktop_activity' | 'screenshot' | 'accessibility_snapshot'`.

---

## Phase 1 — Contracts and configuration

### Task 1: Replace provisional observation config fields

**Files:**
- Modify: `packages/contracts/src/config.ts` (Observation block, lines ~170–184; add `KeyCustody`)
- Modify: `src/config/defaults.ts`, `src/config/normalization.ts` (renamed fields/defaults)
- Modify: `dashboard/src/tabs/settings/AssistantSettings.tsx` (mechanical rename only; full
  replacement is Task 14)
- Test: `test/contracts/assistant-config.test.ts` (extend existing config tests where they live —
  locate with `rg "FixedCadenceMinutes" test src`)

- [ ] **Step 1: Write failing tests** for the replaced schema:

```ts
test('observation config uses gate D fields', () => {
  const parsed = AssistantConfigSchema.parse(buildAssistantConfigFixture());
  assert.equal(parsed.Observation.FixedCadenceSeconds, 30);
  assert.equal(parsed.Observation.DuplicateSimilarityPercent, 92);
  assert.equal(parsed.Observation.CaptureScope, 'foreground_window');
  assert.equal(parsed.KeyCustody, 'file');
});

test('observation config rejects removed provisional fields', () => {
  assert.throws(() => AssistantConfigSchema.parse({
    ...buildAssistantConfigFixture(),
    Observation: { ...valid.Observation, FixedCadenceMinutes: 1 },
  }));
});
```

- [ ] **Step 2: Run** `npm test -- assistant-config` → FAIL (fields missing).
- [ ] **Step 3: Implement.** In `packages/contracts/src/config.ts` Observation block: delete
  `FixedCadenceMinutes` and `MinimumPerceptualDistance`; add:

```ts
FixedCadenceSeconds: z.number().int().positive(),
DuplicateSimilarityPercent: z.number().int().min(0).max(100),
CaptureScope: z.enum(['foreground_window', 'all_monitors']),
```

  Add to the top-level Assistant object (sibling of `Observation`):
  `KeyCustody: z.enum(['file', 'desktop'])`. Update `src/config/defaults.ts`
  (30 / 92 / `'foreground_window'` / `'file'`; `MinimumForegroundDwellSeconds` default 5) and any
  normalization/fixture references. Fix every compile error the rename surfaces (`rg
  "FixedCadenceMinutes|MinimumPerceptualDistance"` must return zero source hits) — **no compat
  aliases**.
- [ ] **Step 4: Run** `npm test -- assistant` and `npm run typecheck` → PASS.

### Task 2: Desktop DTO contracts + golden fixtures

**Files:**
- Create: `packages/contracts/src/assistant-desktop.ts`; export from the contracts index.
- Create: `desktop/contract-fixtures/*.json` (one valid fixture per DTO + one
  `unknown-version.json`)
- Test: `test/contracts/assistant-desktop.test.ts`

- [ ] **Step 1: Write failing tests**: every fixture file parses with its schema; the
  unknown-version fixture fails for every schema; `CaptureSubmissionDto` rejects an oversized
  data URL.

```ts
test('golden fixtures parse', () => {
  const activity = ActivityEventDtoSchema.parse(readFixture('activity-event.json'));
  assert.equal(activity.schemaVersion, 1);
});
test('unknown schemaVersion fails closed', () => {
  assert.throws(() => ActivityEventDtoSchema.parse(readFixture('unknown-version.json')));
});
```

- [ ] **Step 2: Run** → FAIL (module missing).
- [ ] **Step 3: Implement** `assistant-desktop.ts` (all `.strict()`, `schemaVersion: z.literal(1)`):

```ts
import { z } from 'zod';
import { ImageDataUrlSchema } from './image.js';

export const ForegroundContextDtoSchema = z.object({
  processName: z.string().nullable(),
  executablePath: z.string().nullable(),
  applicationId: z.string().nullable(),
  normalizedTitle: z.string().nullable(),
  fullscreen: z.boolean(),
}).strict();

export const ActivityEventDtoSchema = z.object({
  schemaVersion: z.literal(1),
  capturedAtUtc: z.string(),
  foreground: ForegroundContextDtoSchema,
  idleSeconds: z.number().int().min(0),
  sessionLocked: z.boolean(),
}).strict();

export const EnvironmentStateDtoSchema = z.object({
  schemaVersion: z.literal(1),
  capturedAtUtc: z.string(),
  fullscreen: z.boolean(), locked: z.boolean(), doNotDisturb: z.boolean(),
  presenting: z.boolean(), excludedApplication: z.boolean(),
  secondsSinceInput: z.number().int().min(0),
  power: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('available'), onBattery: z.boolean(),
      batteryPercent: z.number().min(0).max(100) }).strict(),
    z.object({ kind: z.literal('unavailable') }).strict(),
  ]),
}).strict();

export const CaptureReasonSchema = z.enum(['fixed_cadence', 'window_change', 'manual']);

export const CaptureSubmissionDtoSchema = z.object({
  schemaVersion: z.literal(1),
  capturedAtUtc: z.string(),
  reason: CaptureReasonSchema,
  display: z.object({
    id: z.string(), name: z.string(), primary: z.boolean(),
    pixelWidth: z.number().int().positive(), pixelHeight: z.number().int().positive(),
    logicalWidth: z.number().int().positive(), logicalHeight: z.number().int().positive(),
    scaleFactor: z.number().positive(),
  }).strict(),
  foregroundContextKey: z.string().min(1),
  foreground: ForegroundContextDtoSchema,
  pixelSha256: z.string().length(64),
  perceptualHash: z.string().length(16), // 64-bit dHash, hex
  imageDataUrl: ImageDataUrlSchema,
}).strict();

export const SuppressionRuleIdSchema = z.enum([
  'private_mode', 'session_locked', 'secure_desktop', 'unknown_foreground',
  'process_denylist', 'title_deny_pattern', 'private_browsing', 'fullscreen_suppression',
  'secret_classification', 'capture_failure',
]);
export const SuppressionAuditDtoSchema = z.object({
  schemaVersion: z.literal(1),
  occurredAtUtc: z.string(),
  ruleId: SuppressionRuleIdSchema,
}).strict();

export const KeyCustodyStatusDtoSchema = z.object({
  schemaVersion: z.literal(1),
  custody: z.enum(['file', 'desktop']),
  imported: z.boolean(),
  activeKeyId: z.string().nullable(),
}).strict();
export const KeyMaterialDtoSchema = z.object({
  schemaVersion: z.literal(1),
  activeKeyId: z.string().min(1),
  keys: z.record(z.string().min(1), z.string().min(1)), // keyId -> base64 (32 bytes decoded)
}).strict();

export const DesktopStateDtoSchema = z.object({
  schemaVersion: z.literal(1),
  assistantEnabled: z.boolean(),
  captureEnabled: z.boolean(),
  paused: z.boolean(),
  custody: KeyCustodyStatusDtoSchema.omit({ schemaVersion: true }),
  imageCapability: z.object({
    capable: z.boolean(), instanceId: z.string().nullable(), queueDepth: z.number().int().min(0),
  }).strict(),
  pendingQuestion: z.object({
    id: z.string(), questionText: z.string(),
  }).strict().nullable(),
}).strict();
```

  Derive all types with `z.infer`. Write one fixture JSON per DTO matching the schemas exactly
  plus `unknown-version.json` (`"schemaVersion": 2`).
- [ ] **Step 4: Run** `npm test -- assistant-desktop`, `npm run typecheck` → PASS.

---

## Phase 2 — Daemon key custody

### Task 3: `ImportedKeyProvider` and custody service

**Files:**
- Create: `src/assistant/crypto/imported-key-provider.ts`
- Create: `src/assistant/crypto/key-custody.ts`
- Test: `test/assistant/crypto/key-custody.test.ts`

- [ ] **Step 1: Write failing tests:**

```ts
test('imported provider serves keys memory-only', () => {
  const provider = new ImportedKeyProvider();
  assert.throws(() => provider.getActiveKey(), /No evidence key has been imported/);
  provider.import({ activeKeyId: 'k1', keys: { k1: key32Base64 } });
  assert.equal(provider.getActiveKey().keyId, 'k1');
  assert.equal(provider.getKeyById('k1').material.byteLength, 32);
});
test('custody service finalizes migration atomically', () => {
  // file custody, key file on disk, one evidence blob encrypted with it
  const result = custody.finalizeMigration({ activeKeyId, keys });
  assert.equal(result.custody, 'desktop');
  assert.equal(fs.existsSync(keyFilePath), false);
});
test('finalize with mismatched keys leaves file custody untouched', () => {
  assert.throws(() => custody.finalizeMigration({ activeKeyId: 'wrong', keys: { wrong: other } }));
  assert.equal(fs.existsSync(keyFilePath), true);
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `ImportedKeyProvider implements AssistantKeyProvider`: holds the
  parsed key map in a private field; `import(material)` validates each key decodes to 32 bytes;
  `clear()` zeroes state. `KeyCustodyService` (constructor: config accessor + config writer,
  key file path, `ImportedKeyProvider`, `BlobCipher` factory, `EvidenceStore` sample reader):
  - `status(): { custody, imported, activeKeyId }`.
  - `exportForShell()`: only legal in `'file'` custody; returns the parsed key file content.
  - `importFromShell(material)`: loads into `ImportedKeyProvider`; when custody is `'file'`
    this is step 4 of migration — verify key ids equal the file's, decrypt one existing evidence
    blob (or cipher self-test round trip when none exists), then `finalizeMigration` deletes the
    key file and writes `KeyCustody: 'desktop'` through the durable config route/writer. Any
    verification failure throws before any mutation.
  - The active `AssistantKeyProvider` used by `BlobCipher` becomes a small delegating provider:
    custody `'file'` → `FileKeyProvider`; `'desktop'` → `ImportedKeyProvider` (throws loudly
    when nothing imported yet).
- [ ] **Step 4: Run** `npm test -- key-custody` → PASS.

### Task 4: Custody routes

**Files:**
- Modify: `src/status-server/routes/assistant.ts` (+ route table entries)
- Modify: `src/assistant/assistant-service.ts` (compose `KeyCustodyService`, expose accessor)
- Test: `test/status-server/assistant-key-custody-routes.test.ts` (follow the existing
  assistant route test harness pattern)

- [ ] **Step 1: Failing tests:** `GET /assistant/keys/custody` returns the status DTO;
  `POST /assistant/keys/export` returns key material only in `'file'` custody and 409 in
  `'desktop'`; `POST /assistant/keys/import` accepts `KeyMaterialDto`, finalizes migration when
  custody was `'file'`, is idempotent re-import in `'desktop'`; all three require the bearer;
  unknown `schemaVersion` → 400 + one audit event; key material never appears in the audit row.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the three pathname branches in the existing dispatch style, parsing
  bodies with the Task 2 schemas, delegating to `KeyCustodyService`. Wire the delegating key
  provider into the `BlobCipher` constructed in `assistant-service.ts` (replace direct
  `FileKeyProvider` construction). Audit events record rule/key **ids only**.
- [ ] **Step 4: Run** `npm test -- assistant` → PASS.

---

## Phase 3 — Migration v43 and daemon observation ingestion

### Task 5: Migration v43 — desktop observation tables

**Files:**
- Modify: `src/assistant/storage/schema.ts` (new `ASSISTANT_DESKTOP_SCHEMA_SQL`)
- Modify: `src/state/runtime-db.ts` (step `< 43`)
- Test: extend the existing migration/schema test file (locate:
  `rg "applyAssistantProactiveSchema" test`)

- [ ] **Step 1: Failing tests:** migrating a fresh DB reaches version 43; re-running is a no-op;
  the new tables exist (`assistant_activity_events`, `assistant_activity_sessions`,
  `assistant_capture_queue`).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement:**

```sql
CREATE TABLE IF NOT EXISTS assistant_activity_events (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES assistant_owners(id) ON DELETE CASCADE,
    captured_at_utc TEXT NOT NULL,
    application_id TEXT,
    process_name TEXT,
    normalized_title TEXT,
    fullscreen INTEGER NOT NULL CHECK (fullscreen IN (0, 1)),
    idle_seconds INTEGER NOT NULL CHECK (idle_seconds >= 0),
    session_locked INTEGER NOT NULL CHECK (session_locked IN (0, 1)),
    session_id TEXT
);
CREATE INDEX IF NOT EXISTS assistant_activity_events_time_idx
  ON assistant_activity_events(owner_id, captured_at_utc DESC);

CREATE TABLE IF NOT EXISTS assistant_activity_sessions (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES assistant_owners(id) ON DELETE CASCADE,
    application_id TEXT,
    process_name TEXT,
    started_at_utc TEXT NOT NULL,
    ended_at_utc TEXT,
    event_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS assistant_capture_queue (
    evidence_id TEXT PRIMARY KEY REFERENCES evidence_records(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL REFERENCES assistant_owners(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN (
        'queued', 'awaiting_image_capability', 'processing', 'processed',
        'expired', 'evicted', 'discarded')),
    foreground_context_key TEXT NOT NULL,
    pixel_sha256 TEXT NOT NULL,
    perceptual_hash TEXT NOT NULL,
    byte_length INTEGER NOT NULL CHECK (byte_length > 0),
    enqueued_at_utc TEXT NOT NULL,
    processed_at_utc TEXT,
    updated_at_utc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_capture_queue_state_idx
  ON assistant_capture_queue(owner_id, state, enqueued_at_utc);
CREATE INDEX IF NOT EXISTS assistant_capture_queue_dedupe_idx
  ON assistant_capture_queue(owner_id, foreground_context_key, enqueued_at_utc DESC);
```

  Add `applyAssistantDesktopSchema(database)` and the `if (currentVersion < 43)` step after 42.
- [ ] **Step 4: Run** migration tests → PASS.

### Task 6: Desktop environment cache → provider seams

**Files:**
- Create: `src/assistant/observation/environment-cache.ts`
- Modify: `src/assistant/assistant-service.ts` (own the cache; replace both Unavailable providers)
- Modify: `src/status-server/routes/assistant.ts` (`POST /assistant/ingest/environment`)
- Test: `test/assistant/observation/environment-cache.test.ts`

- [ ] **Step 1: Failing tests** (injected clock):

```ts
test('fresh environment state feeds both providers', () => {
  cache.ingest(environmentDto);            // capturedAt = now
  const env = cache.read();                // QuestionEnvironmentState
  assert.equal(env.kind, 'available');
  assert.equal(cache.readPower().kind, 'available');
});
test('stale environment state is unavailable', () => {
  cache.ingest(environmentDto);
  clock.advanceSeconds(61);                // heartbeat deadline 60s
  assert.equal(cache.read().kind, 'unavailable');
  assert.equal(cache.readPower().kind, 'unavailable');
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `DesktopEnvironmentCache implements QuestionEnvironmentStateProvider,
  PowerStateProvider` (constructor: `Clock`, `stalenessSeconds = 60`). `ingest()` stores the last
  DTO + received timestamp; `read()` maps DTO → `QuestionEnvironmentState` (localTime from clock),
  `readPower()` maps the power branch. In `assistant-service.ts` construct one cache and pass it
  where `UnavailableQuestionEnvironmentStateProvider` / `UnavailablePowerStateProvider` are
  instantiated today; expose `ingestEnvironment(dto)` on the service. Route parses with
  `EnvironmentStateDtoSchema`, requires bearer, 400+audit on unknown version.
- [ ] **Step 4: Run** `npm test -- assistant` → PASS (including existing question-policy tests,
  which must still pass with the cache defaulting to unavailable).

### Task 7: Activity ingestion and sessionization

**Files:**
- Create: `src/assistant/observation/activity-log.ts`
- Modify: `src/status-server/routes/assistant.ts` (`POST /assistant/ingest/activity`)
- Modify: `src/assistant/assistant-service.ts`
- Test: `test/assistant/observation/activity-log.test.ts`

- [ ] **Step 1: Failing tests:** ingesting an `ActivityEventDto` inserts a row; two events with
  the same `applicationId` within the gap bound (default 300 s) share a `session_id`; a gap or a
  different application closes the session (sets `ended_at_utc`) and opens a new one; ingestion
  with the assistant disabled or private mode active is rejected with an explicit error; an
  observation (via the existing `ObservationStore`) is recorded per closed session, never a
  preference/assertion.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `ActivityLog` (database, clock, ids; `ingest(ownerId, dto)` +
  `closeIdleSessions(nowUtc)`). Sessionization is deterministic SQL/TS — no model involvement.
  Wire route + service accessor as in Task 6.
- [ ] **Step 4: Run** → PASS.

### Task 8: Capture ingestion — dedupe, evidence, queue, suppression audit

**Files:**
- Create: `src/assistant/observation/capture-intake.ts`
- Modify: `src/status-server/routes/assistant.ts` (`POST /assistant/ingest/capture`,
  `POST /assistant/ingest/suppression`)
- Modify: `src/assistant/assistant-service.ts`
- Test: `test/assistant/observation/capture-intake.test.ts`

- [ ] **Step 1: Failing tests:**

```ts
test('novel capture becomes encrypted evidence and queue row', () => {
  const outcome = intake.submit(ownerId, captureDto());
  assert.equal(outcome.kind, 'accepted');
  const row = queueRow(outcome.evidenceId);
  // fake capability provider reports not capable in this test
  assert.equal(row.state, 'awaiting_image_capability');
});
test('exact sha match always discards', () => {
  intake.submit(ownerId, captureDto({ pixelSha256: A }));
  const dup = intake.submit(ownerId, captureDto({ pixelSha256: A }));
  assert.equal(dup.kind, 'duplicate_discarded');
});
test('perceptual similarity >= threshold in same context audits skipped duplicate', () => {
  intake.submit(ownerId, captureDto({ perceptualHash: h1, foregroundContextKey: 'app:code' }));
  const near = intake.submit(ownerId, captureDto({
    perceptualHash: within92PercentOf(h1), foregroundContextKey: 'app:code' }));
  assert.equal(near.kind, 'skipped_duplicate');   // audit row exists, no evidence row
});
test('same hash in a different context is not a perceptual duplicate', ...);
test('screenshots disabled or capture with unavailable key provider rejects loudly', ...);
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `CaptureIntake` (evidence store, capture-queue store, audit store,
  capability provider stub until Task 9, config accessor, clock, ids):
  - Similarity: 64-bit dHash Hamming distance; `similarityPercent = 100 * (64 - distance) / 64`;
    compare against previous queue rows with the same `foreground_context_key` inside the
    retention window; `>= DuplicateSimilarityPercent` → `skipped_duplicate` audit event, stop.
    Exact `pixel_sha256` match → silent discard (audited `duplicate_discarded`).
  - Otherwise decode the data URL to bytes (bounded by `ImageDataUrlSchema` already), call
    `evidenceStore.recordBlobEvidence({ sourceType: 'screenshot', sensitivity: 'sensitive',
    mimeType: 'image/png', bytes, metadata: {display, reason, foreground…}, … })`, insert the
    queue row (state from the capability gate: `queued` when capable else
    `awaiting_image_capability`).
  - Suppression route parses `SuppressionAuditDtoSchema` and writes one non-content audit event.
- [ ] **Step 4: Run** → PASS.

---

## Phase 4 — Image capability, inference contract, jobs, retention

### Task 9: `RuntimeImageCapabilityProvider`

**Files:**
- Modify: `src/status-server/managed-inference-runtime.ts` (generation counter)
- Create: `src/status-server/runtime-image-capability.ts`
- Modify: `src/status-server/main.ts` (or wherever the runtime + `AppliedModelPresetState` are
  composed — locate with `rg "new AppliedModelPresetState"`) to construct and hand the provider
  to `AssistantService`.
- Test: `test/status-server/runtime-image-capability.test.ts`

- [ ] **Step 1: Failing tests:**

```ts
test('capable only when running, loaded, vision preset', () => {
  const cap = provider.read();
  assert.deepEqual(cap, { instanceId: 'llama:3', visionCapable: true, healthy: true });
});
test('any state transition changes instanceId', () => {
  const before = provider.read().instanceId;
  runtime.simulateModelUnload();
  assert.notEqual(provider.read().instanceId, before);
  assert.equal(provider.read().visionCapable, false);
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** In `ManagedInferenceRuntime`: private `generation = 0`, incremented in
  both `transitionProcessTo` and `transitionModelTo` when the state actually changes; expose
  `getGeneration(): number`. Provider:

```ts
export interface RuntimeImageCapability {
  readonly instanceId: string | null;
  readonly visionCapable: boolean;
  readonly healthy: boolean;
}
export interface RuntimeImageCapabilityProvider { read(): RuntimeImageCapability; }

export class ManagedRuntimeImageCapabilityProvider implements RuntimeImageCapabilityProvider {
  constructor(
    private readonly runtime: ManagedInferenceRuntime,
    private readonly appliedPreset: AppliedModelPresetState,
  ) {}
  read(): RuntimeImageCapability {
    const running = this.runtime.getProcessState() === 'running'
      && this.runtime.getModelState() === 'loaded';
    const preset = this.appliedPreset.getPreset();
    const instanceId = running ? `${this.runtime.id}:${this.runtime.getGeneration()}` : null;
    return {
      instanceId,
      visionCapable: running && preset.VisionEnabled === true,
      healthy: running,
    };
  }
}
```

  Add `UnavailableRuntimeImageCapabilityProvider` (`{ instanceId: null, visionCapable: false,
  healthy: false }`) as the default in `AssistantService` so headless composition keeps working.
  Replace the Task 8 stub with this interface.
- [ ] **Step 4: Run** → PASS.

### Task 10: Replace the assistant inference contract (text-or-image union)

**Files:**
- Modify: `src/assistant/inference/client.ts` (full replacement)
- Modify: every constructor of `AssistantInferenceRequest` (locate:
  `rg "AssistantInferenceRequest" src test` — extractor, consolidator, planner, summarizer,
  structured-output runner) to build the `kind: 'text'` variant.
- Test: replace the no-image invariant tests (locate: `rg "no-image|userText" test/assistant`)
  with `test/assistant/inference/client.test.ts`

- [ ] **Step 1: Failing tests:**

```ts
test('text request shape is structurally image-free', () => {
  const request: AssistantTextInferenceRequest = { kind: 'text', role, systemPrompt, userText,
    responseSchemaName, responseJsonSchema, abortSignal: null };
  // @ts-expect-error text requests cannot carry images
  const bad: AssistantTextInferenceRequest = { ...request, images: [] };
});
test('image request sends multimodal user content and stays tool-free', async () => {
  const recorder = new RecordingBackend();
  await client.complete({ kind: 'image', role: 'image_extraction', systemPrompt, userText,
    images: [pngDataUrl], responseSchemaName, responseJsonSchema, abortSignal: null });
  assert.deepEqual(recorder.last.tools, []);
  assert.equal(recorder.last.messages[1].content[1].type, 'image_url');
});
test('image request against a non-vision preset is rejected before the wire', ...);
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `AssistantInferenceRequest = AssistantTextInferenceRequest |
  AssistantImageInferenceRequest` discriminated on `kind`. The image variant carries
  `images: readonly ImageDataUrl[]` (parsed by `ImageDataUrlSchema`); admission reuses
  `preset-image-admission.ts` against the active preset before building the message; user content
  becomes the same multimodal parts shape `image-attachments.ts` produces for chat. Text branch
  is byte-identical behavior to today. Update all call sites to `kind: 'text'`. Delete the §12.6
  comments; the replacement guarantee (tool-free, schema-validated) is asserted for both variants.
- [ ] **Step 4: Run** `npm test -- assistant` → PASS.

### Task 11: `image_extraction` job — queue lifecycle, exactly-once, capability revalidation

**Files:**
- Modify: `src/assistant/jobs/job-types.ts` (add `'image_extraction'` + payload schema
  `{ evidenceId: z.string() }.strict()`; include in `isModelBackedJobType`)
- Create: `src/assistant/images/image-extractor.ts`
- Create: `src/assistant/images/capture-queue-store.ts` (row CRUD over
  `assistant_capture_queue`; also used by Task 8 — if Task 8 inlined queue SQL, move it here now)
- Modify: `src/assistant/jobs/job-runner.ts` (execute-switch branch + payload parse branch)
- Modify: `src/assistant/assistant-service.ts` (compose; on capability provider reporting
  capable during `drain`, enqueue jobs for `awaiting_image_capability` rows oldest-first)
- Modify: `src/assistant/ingestion/candidate-gate.ts` or `consolidator.ts` (single-image
  confidence cap — locate the confidence clamp; cap candidates whose only evidence is one
  screenshot below the stable-preference promotion threshold)
- Test: `test/assistant/images/image-extraction.test.ts`

- [ ] **Step 1: Failing tests** (fake capability provider + fake inference):

```ts
test('capable runtime drains awaiting items oldest-first exactly once', async () => {
  // two awaiting rows; run drain twice
  assert.deepEqual(statesAfter, ['processed', 'processed']);
  assert.equal(fakeInference.imageCalls.length, 2);      // not 4
});
test('instanceId change between claim and dispatch returns item to awaiting', async () => {
  capability.set({ instanceId: 'llama:1', visionCapable: true, healthy: true });
  fakeInference.beforeCall = () => capability.set({ instanceId: null, visionCapable: false, healthy: false });
  await drain();
  assert.equal(queueRow(id).state, 'awaiting_image_capability');
});
test('extraction output is schema-validated passive candidates', ...);
test('single-image candidate confidence is capped below stable promotion', ...);
test('gate never starts or switches a model', () => {
  assert.equal(fakeRuntime.ensureCalls, 0);
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `ImageExtractor.run(ownerId, evidenceId, signal)`:
  1. read queue row; `processed` → no-op return (exactly-once);
  2. capability read #1 (admission) — not capable → set `awaiting_image_capability`, return;
  3. decrypt blob via `BlobCipher` (bytes scoped to this call), build the image request
     (Task 10), capability read #2 must return the **same `instanceId`** immediately before the
     call — otherwise back to awaiting;
  4. schema-validate output into extraction candidates via the existing candidate pipeline
     (source `'screenshot'`), mark `processed` + `processed_at_utc`.
  Runner branch mirrors `runConversationIngestion`'s shape. Confidence cap: deterministic clamp
  in the promoter/gate keyed on "all supporting evidence is a single screenshot".
- [ ] **Step 4: Run** `npm test -- assistant` → PASS.

### Task 12: Capture retention and eviction

**Files:**
- Create: `src/assistant/images/capture-retention.ts`
- Modify: `src/assistant/jobs/job-types.ts` (+ `'capture_retention'`, payload
  `{ reason: z.enum(['schedule', 'capacity']) }.strict()`, **not** model-backed)
- Modify: `src/assistant/jobs/job-runner.ts`, `src/assistant/assistant-service.ts` (enqueue on
  drain start; `CaptureIntake` enqueues a `capacity` run when the running byte total exceeds the
  limit)
- Test: `test/assistant/images/capture-retention.test.ts`

- [ ] **Step 1: Failing tests:** a row older than `RawRetentionHours` → blob file deleted,
  evidence `expired`, queue `expired`, audit event, dependent assertion confidence recalculated;
  total bytes over `RawStorageLimitGb` → oldest rows evicted first (including
  `awaiting_image_capability`) until under the cap, audit per eviction; `processed` rows expire
  the same way; suppression audits are untouched.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** using the existing evidence deletion/confidence-recalculation
  machinery (locate: `rg "expired" src/assistant/storage/evidence-store.ts` and the Gate C
  deletion service in `src/assistant/control/`). Deterministic, no model.
- [ ] **Step 4: Run** → PASS.

---

## Phase 5 — Desktop state endpoint, questions, dashboard

### Task 13: `GET /assistant/desktop/state` + question shown/dismiss endpoints

**Files:**
- Modify: `src/status-server/routes/assistant.ts` (+ route table)
- Modify: `src/assistant/assistant-service.ts` (state assembly; mark-shown/dismissed via the
  existing question store/feedback service)
- Test: `test/status-server/assistant-desktop-state.test.ts`

- [ ] **Step 1: Failing tests:** the endpoint returns a valid `DesktopStateDto` (capture
  enabled/paused flags from config + private mode, custody from Task 3, capability + queue depth
  from Tasks 9/11, `pendingQuestion` = the current eligible question);
  `POST /assistant/questions/mark-shown {questionId}` transitions `eligible → shown` and is
  rejected for any other status; `POST /assistant/questions/dismiss {questionId}` records
  `dismissed`; a question never becomes `shown` by being returned from the state poll.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the three branches; `mark-shown` is the **only** writer of
  `shown_at_utc` (popup paint confirmation per spec §6).
- [ ] **Step 4: Run** → PASS.

### Task 14: Dashboard observation settings replacement

**Files:**
- Modify: `dashboard/src/tabs/settings/AssistantSettings.tsx` (observation section full
  replacement)
- Test: extend the existing settings component tests (locate:
  `rg "AssistantSettings" dashboard/src --files-with-matches` and its test file)

- [ ] **Step 1: Failing component tests:** renders screenshot enable (off default) with consent
  text containing "enables automatic image analysis"; cadence seconds, capture scope select,
  similarity percent, dwell seconds, deny lists, retention hours/GB, sign-in startup toggle;
  shows custody status and the image-capability warning with queue depth when the desktop state
  reports incapable.
- [ ] **Step 2: Run** dashboard tests → FAIL.
- [ ] **Step 3: Implement** against the Task 1 config fields and Task 13 state endpoint (poll via
  the existing controller hook pattern in `useAssistantController.ts`). Remove every provisional
  Gate C observation control.
- [ ] **Step 4: Run** dashboard tests + `npm run typecheck` → PASS.

### Task 15: Per-item evidence pixel reveal

**Files:**
- Modify: `src/status-server/routes/assistant.ts` (`GET /assistant/evidence/blob?id=` —
  authenticated decrypt-and-serve, `Cache-Control: no-store`)
- Modify: `dashboard/src/tabs/AssistantTab.tsx` (metadata list already exists; add confirm →
  fetch → object URL preview; revoke on close/auth loss)
- Test: `test/status-server/assistant-evidence-blob.test.ts` + component test

- [ ] **Step 1: Failing tests:** route requires bearer; returns decrypted bytes with `no-store`;
  404 for non-blob or expired evidence; tampered blob → 500 with the tamper error, never bytes.
  Component: preview renders only after explicit confirmation; closing revokes the object URL.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** (decrypt via `BlobCipher`; nothing written to disk or cache).
- [ ] **Step 4: Run** → PASS.

---

## Phase 6 — Toolchain and the Tauri shell

### Task 16: Portable Rust toolchain + env-scoped scripts

**Files:**
- Create: `scripts/desktop/rust-env.mjs` (spawns a command with `RUSTUP_HOME`, `CARGO_HOME`, and
  PATH prepended with the portable cargo/bin — process-scoped only)
- Create: `scripts/desktop/install-toolchain.mjs` (downloads `rustup-init.exe` into the tooling
  root, runs `rustup-init -y --no-modify-path --default-toolchain stable-x86_64-pc-windows-msvc`)
- Create: `docs/superpowers/handoffs/gate-d-toolchain-manifest.md` (what was installed, exact
  paths, removal steps, explicit note that VS 2022 + WebView2 are pre-existing system components)
- Modify: `package.json` scripts:
  `"desktop:test": "node scripts/desktop/rust-env.mjs cargo test --manifest-path desktop/src-tauri/Cargo.toml"`,
  `"desktop:dev"`, `"desktop:build"` (tauri CLI via `cargo tauri`), plus
  `"desktop:install-toolchain"`.

- [ ] **Step 1:** Run `npm run desktop:install-toolchain` → rustup + stable MSVC toolchain under
  `C:\Users\denys\Documents\GitHub\.tooling\siftkit-gate-d\` (verify `cargo --version` through
  `rust-env.mjs`). Install the Tauri CLI: `node scripts/desktop/rust-env.mjs cargo install
  tauri-cli --locked`.
- [ ] **Step 2:** Verify global environment untouched: `cargo` absent from a plain shell;
  `$env:PATH` unchanged.
- [ ] **Step 3:** Write the manifest doc with the honest removal boundary.

### Task 17: Tauri scaffold + tray skeleton

**Files:**
- Create: `desktop/src-tauri/` (`Cargo.toml`, `tauri.conf.json`, `src/main.rs`, `src/lib.rs`),
  `desktop/ui/` (static popup/tray assets placeholder), `desktop/.gitignore` (`target/`)

- [ ] **Step 1:** `cargo tauri init`-equivalent minimal scaffold: Tauri 2, `tray-icon` feature,
  no default window (the dashboard webview window and popup are created on demand). Identifier
  `com.siftkit.assistant`, product name `SiftKit Assistant`.
- [ ] **Step 2:** `main.rs`: build the app with a tray icon (Open dashboard / Pause observation /
  Quit stub handlers), keep the process alive with no window.
- [ ] **Step 3:** `npm run desktop:test` (empty test pass) and `npm run desktop:build` → the
  binary launches, shows the tray icon, quits cleanly. Manual check on this machine.

### Task 18: Rust DTOs + golden-fixture tests

**Files:**
- Create: `desktop/src-tauri/src/contracts.rs`
- Test: `desktop/src-tauri/src/contracts.rs` `#[cfg(test)]` module reading
  `../../contract-fixtures/*.json`

- [ ] **Step 1: Failing tests:** each fixture deserializes into its serde struct
  (`deny_unknown_fields`); `unknown-version.json` fails for every type; serializing the struct
  back reproduces the fixture (round-trip).

```rust
#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ActivityEventDto {
    pub schema_version: SchemaV1,
    pub captured_at_utc: String,
    pub foreground: ForegroundContextDto,
    pub idle_seconds: u32,
    pub session_locked: bool,
}
// SchemaV1 = unit struct that (de)serializes only the number 1 — unknown versions fail closed.
```

- [ ] **Step 2:** `npm run desktop:test` → FAIL, then implement all DTOs from Task 2 1:1.
- [ ] **Step 3:** `npm run desktop:test` → PASS.

### Task 19: Windows activity/environment adapters + heartbeat loop

**Files:**
- Create: `desktop/src-tauri/src/platform/mod.rs` (traits), `platform/windows/activity.rs`,
  `platform/windows/power.rs`
- Create: `desktop/src-tauri/src/observation/heartbeat.rs` (pure scheduling logic)
- Test: `#[cfg(test)]` with fake trait impls

- [ ] **Step 1: Failing tests** (fakes, injected clock): heartbeat emits `EnvironmentStateDto`
  every 20 s and `ActivityEventDto` on foreground change + on the same tick while unlocked;
  nothing is emitted while paused or in private mode; titles are normalized (privacy filter:
  strip URLs/emails/file paths; raw title only attached when policy allows).
- [ ] **Step 2:** Implement traits:

```rust
pub trait NativeActivityProvider: Send {
    fn foreground(&self) -> ForegroundSample;    // process/exe/app-id/title/fullscreen
    fn idle_seconds(&self) -> u32;
    fn session_locked(&self) -> bool;
}
pub trait NativePowerStateProvider: Send {
    fn read(&self) -> PowerSample;               // on_battery, percent, or unavailable
}
```

  Windows impls (all Win32 confined here): `GetForegroundWindow` +
  `GetWindowThreadProcessId`/`QueryFullProcessImageNameW`/`GetWindowTextW`,
  `GetLastInputInfo` for idle, `WTSRegisterSessionNotification`/`OpenInputDesktop` failure for
  locked/secure desktop, `GetSystemPowerStatus` for power,
  `SHQueryUserNotificationState` for DND/presenting/fullscreen.
- [ ] **Step 3:** `npm run desktop:test` → PASS (logic tests); manual smoke deferred to Task 26.

### Task 20: Preflight + dwell/cadence state machines

**Files:**
- Create: `desktop/src-tauri/src/observation/preflight.rs`, `observation/scheduler.rs`
- Test: `#[cfg(test)]` fakes

- [ ] **Step 1: Failing tests:** preflight evaluates exactly the spec §4 order (private mode →
  locked → secure desktop → unknown foreground → process denylist → title pattern → private
  browsing → fullscreen suppression → secret classification) and returns the **first** matching
  `SuppressionRuleId`; a provider error is a suppression, not a capture; the scheduler fires
  `fixed_cadence` every `FixedCadenceSeconds`, arms a dwell timer on foreground change that
  resets on further changes and fires `window_change` after `MinimumForegroundDwellSeconds`;
  pause/private-mode cancels all timers immediately.
- [ ] **Step 2:** Implement. Secret classification: accessibility snapshot text (UIAutomation
  behind `NativeAccessibilityProvider`) scanned by a small keyword/regex set (password, 2FA,
  card-number patterns…) — used **only** for suppression. Private-browsing detection: title
  suffix match per known browsers (`InPrivate`, `Incognito`, `Private Browsing`).
- [ ] **Step 3:** `npm run desktop:test` → PASS.

### Task 21: Capture mechanics + hashes

**Files:**
- Create: `desktop/src-tauri/src/platform/windows/capture.rs`,
  `desktop/src-tauri/src/observation/hash.rs`
- Test: `#[cfg(test)]` (hashes over fixture pixel buffers; capture behind trait fake)

- [ ] **Step 1: Failing tests:** `dhash64` of a known 9×8 grayscale fixture equals the
  precomputed hex; `pixel_sha256` of a fixture buffer matches; identical buffers → distance 0;
  a DRM-style all-black frame is reported as `capture_failure`, not submitted.
- [ ] **Step 2:** Implement `NativeCaptureProvider`:
  - `foreground_window` scope: `PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT)` → DIB → PNG encode
    (`png` crate); minimized/cloaked (`DwmGetWindowAttribute DWMWA_CLOAKED`) → failure result.
  - `all_monitors` scope: DXGI output duplication per monitor.
  - No Windows.Graphics.Capture; nothing that flashes, borders, or changes focus.
  - `hash.rs`: SHA-256 (`sha2` crate) + 64-bit dHash (downscale to 9×8 grayscale, compare
    neighbors), hex-encoded to 16 chars.
- [ ] **Step 3:** `npm run desktop:test` → PASS.

### Task 22: DPAPI custody + shell migration client

**Files:**
- Create: `desktop/src-tauri/src/platform/windows/secure_key.rs`, `desktop/src-tauri/src/custody.rs`
- Test: `#[cfg(test)]` (DPAPI round-trip is a Windows-only test; migration flow with a fake
  daemon client)

- [ ] **Step 1: Failing tests:** protect→unprotect round-trips key JSON; the migration state
  machine calls, in order: custody-status → export → DPAPI write → re-read/unprotect → import →
  (daemon deletes file + flips config); any step failing aborts without a partial state and
  surfaces an attention state; steady-state connect with `'desktop'` custody unprotects and
  imports.
- [ ] **Step 2:** Implement with `CryptProtectData`/`CryptUnprotectData`
  (`CRYPTPROTECT_UI_FORBIDDEN`), blob at `<runtimeRoot>/.siftkit/assistant-keys.dpapi`. Key
  bytes are zeroized (`zeroize` crate) after import POST.
- [ ] **Step 3:** `npm run desktop:test` → PASS.

### Task 23: Daemon client — auth, ingestion, polling, supervision, quit

**Files:**
- Create: `desktop/src-tauri/src/daemon/client.rs` (bearer bootstrap + typed POST/GET),
  `daemon/supervisor.rs`
- Test: `#[cfg(test)]` against a stub HTTP server (`tiny_http` dev-dependency) — auth header on
  every call, version-mismatch (400) response halts capture and sets the attention state,
  disconnect halts capture with no local buffering, reconnect resumes.

- [ ] **Step 1: Failing tests** as above, plus supervisor logic: probe port → adopt when
  compatible (`GET /assistant/status`), else spawn `node dist/src/status-server/main.js`-
  equivalent launch command as a child with a Job Object; quit terminates only the spawned tree
  (`TerminateJobObject`); adopted external servers are never terminated.
- [ ] **Step 2:** Implement (`reqwest` blocking or `ureq`; keep it minimal). Bearer bootstrapped
  once per shell lifecycle via the existing `/assistant/auth/bootstrap` loopback route,
  memory-only.
- [ ] **Step 3:** `npm run desktop:test` → PASS.

### Task 24: Question popup + shown confirmation; tray states

**Files:**
- Create: `desktop/ui/popup.html` + `desktop/ui/popup.ts` (compact static assets, Tauri command
  IPC only), `desktop/src-tauri/src/popup.rs`
- Modify: `desktop/src-tauri/src/main.rs` (tray states: on / capture-enabled / paused /
  attention / question badge; wire poll → popup)
- Test: Rust `#[cfg(test)]` for the popup state machine (fake window + fake client)

- [ ] **Step 1: Failing tests:** poll returns a pending question → popup window created; only the
  webview's `popup_rendered` event triggers `mark-shown` (queued/creation-failure/disconnect
  never do); close-without-answer sends `dismiss`; answer submit failure keeps the popup open
  with the text intact and retries; tray badge clears when no pending question.
- [ ] **Step 2:** Implement popup as a small frameless always-on-top Tauri window
  (bottom-right); actions answer / skip / snooze / overflow (do-not-repeat, stop-topic) posting
  through the existing feedback routes.
- [ ] **Step 3:** `npm run desktop:test` → PASS.

### Task 25: Sign-in startup registration

**Files:**
- Create: `desktop/src-tauri/src/platform/windows/startup.rs`
- Modify: shell poll handling (reconcile registration to the setting each poll)
- Test: `#[cfg(test)]` with a fake registry trait

- [ ] **Step 1: Failing tests:** setting on → `HKCU\...\Run\SiftKitAssistant` written with the
  exe path; setting off → value deleted; reconcile is idempotent; never registers when the
  setting is absent/off.
- [ ] **Step 2:** Implement over `RegSetValueExW`/`RegDeleteValueW` behind a trait.
- [ ] **Step 3:** `npm run desktop:test` → PASS. Add the uninstall-removes-registration step to
  Task 26's NSIS config.

### Task 26: Packaging + manual smoke script

**Files:**
- Modify: `desktop/src-tauri/tauri.conf.json` (NSIS bundle, uninstall hook deleting the Run key)
- Create: `scripts/desktop/manual-smoke.md` (checklist: tray visible; pause works; capture is
  silent — no border/flash/focus change; multi-monitor bounds correct; popup paint → `shown`;
  quit kills only the shell-spawned daemon)

- [ ] **Step 1:** `npm run desktop:build` → NSIS installer produced under
  `desktop/src-tauri/target/release/bundle/`.
- [ ] **Step 2:** Run the manual smoke checklist on this machine; record results in the checklist
  file. CI never runs this.

---

## Phase 7 — End-to-end and final validation

### Task 27: Node E2E — fake shell scenarios

**Files:**
- Create: `test/e2e/assistant-gate-d.test.ts` (fake shell = plain HTTP client using Task 2 DTOs
  against a real status server on a temp runtime, fake inference, fake capability provider)

- [ ] **Step 1: Failing tests** covering the spec §8 E2E list:
  1. capture DTO → encrypted evidence → queue → capability flips capable → drain → schema-valid
     candidate in consolidation → visible via `/assistant/search`;
  2. suppression DTO → audit event only, zero evidence rows;
  3. injection-bearing extraction output (fixture) → no policy mutation, no candidate promotion;
  4. retention expiry → blob gone, evidence `expired`, dependent confidence recalculated;
  5. environment staleness → question policy reports environment unavailable (no `shown`);
  6. key custody migration end-to-end (file → export → import → file deleted → custody
     `desktop`), then daemon restart + re-import serves decryption again;
  7. `Assistant.Enabled = false` → every ingestion route rejects, zero rows.
- [ ] **Step 2:** Run → FAIL, fix integration seams until PASS.

### Task 28: Full validation gate

- [ ] `npm run build:test` — pass.
- [ ] `npm test -- assistant` — pass, 0 fail.
- [ ] `npm test` — full suite, 0 fail (2 pre-existing skips allowed).
- [ ] `npm run typecheck` — pass.
- [ ] `npm run lint` — pass.
- [ ] `npm run build` — pass (existing ~1 MB chunk warning allowed).
- [ ] `npm run desktop:test` — pass.
- [ ] `npm run desktop:build` — pass.
- [ ] Windows process/listener audit — no stray test/daemon/shell processes.
- [ ] Scratch artifacts deleted; report results honestly, including anything unverified
  (browser-based visual checks if no browser is available).

---

## Self-review notes

- Spec §0–§8 → Tasks: config/§0 (1), DTOs/§2 (2, 18), custody/§3 (3, 4, 22), capture+activity/§4
  (5–8, 19–21), image queue/§5 (9–12), UI/§6 (13–15, 24, 25), retention+errors/§7 (8, 12, 23,
  24), tests/toolchain/packaging/§8 (16, 17, 26–28).
- Migration numbering: runtime DB is at v42; Gate D is v43 (the master design's "v41" label is
  historical).
- No commits anywhere by explicit user instruction; the executing skill's commit steps are
  replaced by focused test runs.

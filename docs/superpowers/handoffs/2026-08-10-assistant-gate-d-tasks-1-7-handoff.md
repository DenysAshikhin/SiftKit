# Assistant Gate D — Handoff after Tasks 1–7

**Date:** 2026-08-10
**Plan:** `docs/superpowers/plans/2026-08-10-assistant-gate-d-desktop-observation.md`
**Spec:** `docs/superpowers/specs/2026-08-10-assistant-gate-d-desktop-observation-design.md`
**State:** Tasks 1–7 complete and green. Task 8 not started. Nothing committed (per plan
constraint: no git commits).

---

## Session constraints in force

From the plan header, overriding generic skill/CLAUDE.md wording for this work:

- Execute inline — **no SiftKit, no subagents, no worktrees**.
- **No git commits.** Where the plan template would say "commit", run the focused tests instead.
- TDD every task: failing test → implement → pass.

---

## Verification status (last run, all green)

```
npm run build:test    # passes
npm test -- assistant # 385 tests, 0 fail
npm run typecheck     # passes (includes eslint)
```

The full suite (`npm test`), `npm run build`, and the Rust/Tauri gates have **not** been run yet —
they belong to Task 28.

---

## Completed tasks

### Task 1 — Observation config replaced

`packages/contracts/src/config.ts`, `src/config/defaults.ts`, `src/config/normalization.ts`,
`dashboard/src/tabs/settings/AssistantSettings.tsx`, `tests/assistant-config.test.ts`.

- Removed `Observation.FixedCadenceMinutes` and `Observation.MinimumPerceptualDistance`.
- Added `Observation.FixedCadenceSeconds` (default 30), `Observation.DuplicateSimilarityPercent`
  (default 92), `Observation.CaptureScope` (`'foreground_window' | 'all_monitors'`, default
  `'foreground_window'`).
- `MinimumForegroundDwellSeconds` default changed 30 → 5.
- Added top-level `Assistant.KeyCustody` (`'file' | 'desktop'`, default `'file'`).
- Added `memberOrDefault()` to `normalization.ts` for enum repair (no type assertions).
- Zero source references to the removed fields remain (the only hits are the negative assertions
  inside `tests/assistant-config.test.ts`).
- Dashboard change was the mechanical rename only; **Task 14 still owns the full replacement**
  (no `CaptureScope` control is rendered yet).

### Task 2 — Desktop DTO contracts + golden fixtures

`packages/contracts/src/assistant-desktop.ts` (exported from the contracts index),
`desktop/contract-fixtures/*.json`, `tests/assistant-desktop-contracts.test.ts`.

Every DTO is `.strict()` with `schemaVersion: z.literal(1)`:
`ForegroundContextDto`, `ActivityEventDto`, `EnvironmentStateDto`, `CaptureSubmissionDto`
(+ `CaptureDisplayDto`, `CaptureReason`), `SuppressionAuditDto` (+ `SuppressionRuleId`),
`KeyCustodyState` / `KeyCustodyStatusDto`, `KeyMaterialDto`, `DesktopStateDto`.

**Deviation from the plan text:** the plan wrote `DesktopStateDto.custody` as
`KeyCustodyStatusDtoSchema.omit({ schemaVersion: true })`. Instead there is a named
`KeyCustodyStateSchema`, and `KeyCustodyStatusDtoSchema` spreads it plus `schemaVersion`. Task 3's
service returns `KeyCustodyState`; routes add `schemaVersion: 1`. Task 13 should use
`KeyCustodyStateSchema` for the `custody` field.

Fixtures: one per DTO plus `unknown-version.json` (`{"schemaVersion": 2}`). The key-material
fixture decodes to exactly 32 bytes. **Task 18 reads these same files from Rust** — keep them
byte-compatible.

### Task 3 — `ImportedKeyProvider` + `KeyCustodyService`

`src/assistant/crypto/imported-key-provider.ts`, `src/assistant/crypto/key-custody.ts`,
`tests/assistant-key-custody.test.ts`. Supporting additions:

- `FileKeyProvider` gained `peekActiveKeyId()` (non-creating), `exportKeyFile()` (creates the key
  on first call), `deleteKeyFile()`; `KeyFile` is now exported.
- `EvidenceStore` gained `findLatestBlob(ownerId)` and `readBlobEnvelope(blob)` (raw ciphertext —
  custody verification cannot go through the store's own cipher).

Shape:

- `ImportedKeyProvider` — memory-only, throws `/no evidence key has been imported/i` before import,
  validates 32-byte decode, `clear()` zeroes buffers.
- `AssistantCustodyConfigPort { readCustody(); writeCustody() }`.
- `CustodyDelegatingKeyProvider` — the provider handed to `AssistantGraph`/`BlobCipher`; routes by
  configured custody.
- `KeyCustodyService` — `status()`, `exportForShell()` (409-worthy throw under desktop custody),
  `importFromShell()` (dispatches), `finalizeMigration()` (file→desktop, verifies key ids match the
  file **and** that the keys decrypt a real stored blob — or a cipher round trip when no evidence
  exists — before deleting the file and flipping config).

**No `BlobCipher` factory function** was introduced (the plan mentioned one); `key-custody.ts`
constructs `BlobCipher` directly, per the "don't pass functions dynamically" rule.

### Task 4 — Custody routes + service rewiring

`src/status-server/routes/assistant.ts`, `src/assistant/assistant-service.ts`,
`src/status-server/assistant-config-writer.ts`, `tests/assistant-key-custody-routes.test.ts`.

Routes (placed **before** the `service.enabled` gate, so custody works while the assistant is off):

- `GET  /assistant/keys/custody` → `KeyCustodyStatusDto`
- `POST /assistant/keys/export`  → `KeyMaterialDto` (409 in desktop custody)
- `POST /assistant/keys/import`  → `KeyCustodyStatusDto`

**Breaking composition changes — every `AssistantService.create` call site was updated:**

- `AssistantServiceOptions.keys` was **removed**. The service now builds
  `FileKeyProvider(assistantKeyFile(runtimeRoot))` + `ImportedKeyProvider` +
  `CustodyDelegatingKeyProvider` itself.
- `AssistantServiceOptions.configWriter: AssistantConfigWriter` is **new and required**.
  Production: `StatusServerAssistantConfigWriter(configPath)`. Tests:
  `MemoryAssistantConfigWriter` (exported from `tests/helpers/assistant-fixture.ts`).

New service members: `readonly keyCustody`, `applyKeyCustody(custody)`,
`recordDesktopContractRejection(kind)`.

New route helper `desktopBody(service, req, schema, kind, maxBytes)` — on a contract mismatch it
writes **one** audit event (`event_type = 'desktop_contract_rejected'`, `details = { kind }` only,
never the payload) and throws → 400. **Every future desktop ingestion route must use this helper.**

The route error mapper's 409 regex now includes `custody`.

### Task 5 — Migration v43

`src/assistant/storage/schema.ts` (`ASSISTANT_DESKTOP_SCHEMA_SQL`), `src/state/runtime-db.ts`
(`applyAssistantDesktopSchema`, `currentVersion < 43` step, `CURRENT_SCHEMA_VERSION = 43`),
`tests/assistant-migration.test.ts`.

Tables: `assistant_activity_events`, `assistant_activity_sessions`, `assistant_capture_queue`
(+ the three indexes) exactly as specified in the plan.

### Task 6 — Desktop environment cache

`src/assistant/observation/environment-cache.ts`, `tests/assistant-environment-cache.test.ts`,
route `POST /assistant/ingest/environment`.

- `DesktopEnvironmentCache implements QuestionEnvironmentStateProvider`; staleness default 60 s
  measured from **receipt** time, not `capturedAtUtc`.
- **Deviation:** it cannot also `implements PowerStateProvider` — both interfaces declare `read()`
  with different return types. The cache exposes `readonly power: PowerStateProvider` backed by a
  small `DesktopPowerStateProvider` class wrapping `readPower()`.
- `AssistantService` now owns one cache and passes it to `QuestionPolicyEngine` and to
  `AssistantResourcePolicy` (`power: this.environment.power`).
  `UnavailableQuestionEnvironmentStateProvider` / `UnavailablePowerStateProvider` are no longer
  constructed by the service (the classes still exist).
- Service method: `ingestEnvironment(dto)`.

### Task 7 — Activity ingestion and sessionization

`src/assistant/observation/activity-log.ts`, `src/assistant/observation/config-reader.ts`,
`tests/assistant-activity-log.test.ts`, route `POST /assistant/ingest/activity`.

- `AssistantConfigReader { read(): AssistantConfig }` + `requireObservationAllowed(config)` — the
  shared gate (disabled → throw, private mode → throw). `AssistantService` implements it via a
  private `ServiceConfigReader`. **Task 8's `CaptureIntake` must reuse both.**
- `ActivityLog`: `ingest(ownerId, dto)`, `closeIdleSessions(ownerId, nowUtc)`,
  `listSessions(ownerId)`. Session gap default 300 s. A closed session writes one text evidence
  record (`source_type = 'desktop_activity'`, sensitivity `personal`, `sourceEventId =
  activity_session:<id>`) and exactly one observation — never a candidate/assertion.
- Service method: `ingestActivity(dto)`.

Enum/row additions made along the way:

- `OBSERVATION_TYPES` += `'desktop_activity_session'`, `'screenshot_extraction'`
  (the latter is pre-added for Task 11).
- New `CAPTURE_QUEUE_STATES` / `CaptureQueueStateSchema` in `domain/enums.ts`.
- New row schemas in `storage/rows.ts`: `ActivityEventRowSchema`, `ActivitySessionRowSchema`,
  `CaptureQueueRowSchema` (the last is unused until Task 8/11).
- `IdPrefix` += `'aevt'`, `'asess'`.

---

## Conventions established (follow these for Tasks 8+)

1. **Test layout.** The plan names nested paths like `test/assistant/observation/foo.test.ts`; this
   repo uses a **flat `tests/*.test.ts`**. Files created so far:
   `tests/assistant-desktop-contracts.test.ts`, `tests/assistant-key-custody.test.ts`,
   `tests/assistant-key-custody-routes.test.ts`, `tests/assistant-environment-cache.test.ts`,
   `tests/assistant-activity-log.test.ts`.
2. **Test cycle.** `npm run build:test` must run before `npm test -- <filter>`; the build is a
   typecheck, so a missing module shows up there as RED.
3. **Route tests** use the harness in `tests/assistant-routes.test.ts`
   (`enterDashboardTestRepo` / `configureDashboardTestEnv` / `startStatusServer` /
   `requestJson` / restore in `finally`). `getRuntimeDatabase()` returns the same cached handle the
   server uses, so audit rows can be asserted directly.
4. **Unit tests** use `withAssistantContext` from `tests/helpers/assistant-fixture.ts`.
5. **Lint constraints that bit already:** `unknown` is banned (use `parseJsonValueText` +
   `JsonValue`); no type assertions; no non-null `!`. Prefer small classes over passed functions.

---

## Next up: Task 8 — capture ingestion

Create `src/assistant/observation/capture-intake.ts`; routes `POST /assistant/ingest/capture` and
`POST /assistant/ingest/suppression`; test `tests/assistant-capture-intake.test.ts`.

Notes for whoever picks it up:

- Reuse `AssistantConfigReader` + `requireObservationAllowed`, and additionally require
  `Observation.ScreenshotsEnabled`.
- `CaptureQueueRowSchema` already exists in `storage/rows.ts`. The plan's Task 11 says to move
  queue SQL into `src/assistant/images/capture-queue-store.ts` if Task 8 inlines it — **write it
  in `capture-queue-store.ts` from the start** and have `CaptureIntake` depend on that store.
- Similarity: 64-bit dHash Hamming distance,
  `similarityPercent = 100 * (64 - distance) / 64`, compared only against prior queue rows with the
  same `foreground_context_key`; `>=` threshold → `skipped_duplicate` audit + stop. Exact
  `pixel_sha256` match → `duplicate_discarded` audit + stop.
- The capability provider is a stub until Task 9 (`RuntimeImageCapabilityProvider`); queue state is
  `queued` when capable, else `awaiting_image_capability`.
- Capture bodies are large (data URL up to `SIFT_MAX_IMAGE_BYTES` = 20 MB). The existing
  `OBSERVATION_BODY_LIMIT` (16 KB) is **too small** — add a separate capture limit
  (~28 MB to cover base64 expansion) in `routes/assistant.ts`.
- Suppression route: parse `SuppressionAuditDtoSchema`, write one non-content audit event, no rows.

Remaining after that: Tasks 9–15 (daemon/UI), 16–26 (Rust toolchain + Tauri shell — Task 16
installs a portable rustup under `C:\Users\denys\Documents\GitHub\.tooling\siftkit-gate-d\`),
27 (E2E), 28 (full validation gate).

---

## Changed / added files so far

Modified: `dashboard/src/tabs/settings/AssistantSettings.tsx`, `packages/contracts/src/config.ts`,
`packages/contracts/src/index.ts`, `src/assistant/assistant-service.ts`,
`src/assistant/crypto/key-provider.ts`, `src/assistant/domain/enums.ts`, `src/assistant/ids.ts`,
`src/assistant/storage/evidence-store.ts`, `src/assistant/storage/rows.ts`,
`src/assistant/storage/schema.ts`, `src/config/defaults.ts`, `src/config/normalization.ts`,
`src/state/runtime-db.ts`, `src/status-server/index.ts`, `src/status-server/routes/assistant.ts`,
`tests/assistant-config.test.ts`, `tests/assistant-gate-b-e2e.test.ts`,
`tests/assistant-gate-c-e2e.test.ts`, `tests/assistant-migration.test.ts`,
`tests/assistant-service.test.ts`, `tests/helpers/assistant-fixture.ts`.

Added: `desktop/contract-fixtures/` (8 fixtures), `packages/contracts/src/assistant-desktop.ts`,
`src/assistant/crypto/imported-key-provider.ts`, `src/assistant/crypto/key-custody.ts`,
`src/assistant/observation/{activity-log,config-reader,environment-cache}.ts`,
`src/status-server/assistant-config-writer.ts`, and the five new test files listed above.

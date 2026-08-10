# Assistant Gate D — Handoff after Tasks 8–11

**Date:** 2026-08-10
**Plan:** `docs/superpowers/plans/2026-08-10-assistant-gate-d-desktop-observation.md`
**Spec:** `docs/superpowers/specs/2026-08-10-assistant-gate-d-desktop-observation-design.md`
**Predecessor handoff:** `docs/superpowers/handoffs/2026-08-10-assistant-gate-d-tasks-1-7-handoff.md`
**State:** Tasks 1–7 are committed (`ee704de2`). Tasks 8–11 are complete, green, and
**uncommitted** in the working tree. Task 12 not started.

---

## Session constraints still in force

From the plan header: execute inline — **no SiftKit, no subagents, no worktrees, no git commits**.
TDD every task; where the plan says "commit", run the focused tests instead.

---

## Verification status (last run, all green)

```
npm run build:test    # passes
npm test              # 2932 tests, 0 fail, 2 skipped
npm run typecheck     # passes (includes eslint)
```

`npm run build`, `npm run desktop:test`, and the Rust/Tauri gates have **not** run — Task 28.

---

## Completed tasks

### Task 8 — Capture ingestion (dedupe, evidence, queue, suppression audit)

`src/assistant/observation/capture-intake.ts`, `src/assistant/images/capture-queue-store.ts`,
`src/assistant/images/image-capability.ts`, routes `POST /assistant/ingest/capture` and
`POST /assistant/ingest/suppression`, `tests/assistant-capture-intake.test.ts`.

- `CaptureIntake.submit(ownerId, dto, config)` → `CaptureOutcome`
  (`accepted` + `evidenceId` + queue `state` | `duplicate_discarded` | `skipped_duplicate`).
  Gate order: `requireObservationAllowed(config)` → `Observation.ScreenshotsEnabled` →
  exact `pixel_sha256` (any context, inside the window) → perceptual similarity (same
  `foreground_context_key` only) → record evidence + enqueue.
- Similarity is 64-bit dHash Hamming: `100 * (64 - distance) / 64`, `>= DuplicateSimilarityPercent`.
  Both dedupe lookups are bounded by `Observation.RawRetentionHours` from the clock's now, so once
  retention removes the pixels the hashes stop deciding anything.
- **Design decision worth keeping:** evidence `sourceEventId` is
  `capture:<capturedAtUtc>:<pixelSha256>`. Keying on the hash alone made identical pixels
  re-captured after the window collide on the queue primary key. The source event is a capture
  *attempt*, not the pixels.
- Evidence: `sourceType: 'screenshot'`, `sensitivity: 'sensitive'`, mime parsed from the data URL
  via `ImageMimeSchema`, `retentionUntilUtc: null` (**Task 12 owns retention — do not duplicate the
  rule here**), metadata = reason/capturedAt/contextKey/hashes/display/foreground.
- Audit event types: `duplicate_discarded`, `skipped_duplicate` (both `targetType`
  `'desktop_capture'`, `targetId: null`, non-content details), `capture_suppressed`
  (`targetId` = rule id, details = `{ ruleId, occurredAtUtc }`).
- `recordSuppression` is deliberately **not** behind `requireObservationAllowed`: private mode is
  itself a suppression rule, so the shell must be able to report it. The route still sits behind
  the `service.enabled` gate (409 when the assistant is off), like the other ingest routes.
- `CAPTURE_BODY_LIMIT` in `routes/assistant.ts` is derived from `SIFT_MAX_IMAGE_BYTES`
  (base64 expansion + `OBSERVATION_BODY_LIMIT` for the descriptor); suppression uses
  `OBSERVATION_BODY_LIMIT`.
  `DesktopPayloadKind` gained `'capture_submission' | 'suppression_audit'`.
- Capture route responds `{ ok: true, outcome: <kind> }`.

### Task 9 — Runtime image capability

`src/status-server/runtime-image-capability.ts`, `tests/runtime-image-capability.test.ts`.

- **Deviation from the plan text (3 items):**
  1. The interface lives in `src/assistant/images/image-capability.ts`
     (`AssistantImageCapability` / `AssistantImageCapabilityProvider` /
     `UnavailableImageCapabilityProvider`), not in status-server — `src/assistant/*` must not
     import from `src/status-server/*`. `ManagedRuntimeImageCapabilityProvider` implements it.
  2. The plan's `getModelState() === 'loaded'` is not a real state; the enums are
     `process: ready`, `model: ready`.
  3. There are two runtimes (llama + exl3), so the provider takes a
     `Pick<PresetRuntimeCoordinator, 'getActiveRuntime'>` seam (the codebase's structural idiom);
     the test uses a one-line stub class.
- `ManagedInferenceRuntime` gained `getGeneration()`; `transitionProcessTo`/`transitionModelTo`
  now no-op on an unchanged state and otherwise bump the generation. `instanceId` is
  `` `${runtime.id}:${generation}` `` while running, else `null`.
- `visionCapable` reuses the **new** non-throwing `presetAcceptsImages(preset)` in
  `src/llm-protocol/image-attachments.ts` (backend must be exl3, `VisionEnabled`,
  `VisionImageRetention !== 0`). `assertPresetAcceptsImages` now derives its message from the same
  private `presetImageRejection` helper — one source of truth, no duplicated admission logic.
- `AssistantServiceOptions.imageCapability` is **optional**; headless composition falls back to
  `UnavailableImageCapabilityProvider`. `src/status-server/index.ts` passes the managed provider.

### Task 10 — Inference contract replaced (text-or-image union)

`src/assistant/inference/client.ts` (full replacement), `roles.ts`, `structured-runner.ts`,
`tests/assistant-inference-client.test.ts`.

- `AssistantInferenceRequest = AssistantTextInferenceRequest | AssistantImageInferenceRequest`,
  discriminated on `kind`. The text variant has no `images` field at all, so
  `{ ...textRequest, images: [] }` is a compile error (asserted with `@ts-expect-error`).
- The image branch calls `admitImagesForPreset(presets.getPreset(), images)` and
  `buildUserContent(...)` — the same admission and multimodal shape the chat surface uses. An
  image request with an empty `images` array throws rather than degrading to text.
- The constructor takes an `ActiveModelPresetSource` (production: `AppliedModelPresetState`), so
  image admission judges the preset the runtime is *running* — the same one the capability gate
  used to enqueue the extraction. Admitting against the boot-time `SiftConfig` snapshot instead
  failed every extraction enqueued after a switch onto a vision preset.
- Both variants stay tool-free and schema-pinned. Text behaviour is unchanged.
- `ASSISTANT_INFERENCE_ROLES` += `'image_extraction'` (+ `ROLE_PROMPT_VERSION` entry).
- `StructuredOutputRunner` gained `runWithImages(...)`; `run()` and it share one private
  `execute(request, images)` + `buildRequest(...)`, so the repair retry carries the images too.

### Task 11 — `image_extraction` job

`src/assistant/images/image-extractor.ts`, job wiring, `tests/assistant-image-extraction.test.ts`.

- `ImageExtractor.run(ownerId, evidenceId, signal)` → `processed` | `awaiting_capability` |
  `already_processed` | `rejected`. Order: queue row (`processed` → no-op) → capability read #1
  (admission) → `state = 'processing'` → decrypt blob to a data URL → capability read #2 must
  return the **same `instanceId`** → `runWithImages` → observations
  (`screenshot_extraction`) + candidates (`passive_observation`) → `markProcessed`.
  Unusable output writes an `extraction_rejected` audit and still marks the row processed.
- Queue store gained `setState`, `markProcessed`, `listByState` (oldest-first).
- Job plumbing: `ASSISTANT_JOB_TYPES` += `'image_extraction'` (model-backed),
  `ImageExtractionPayloadSchema { evidenceId }`, `JobStore.readImageExtractionPayload`,
  runner branch `runImageExtraction` (a non-`processed` outcome completes the job — an item the
  runtime can no longer analyse is not a failure and must not burn its retry budget).
- **Deviation:** added `Background.JobPriorities.ImageExtraction` (default **350**) to the config
  contract, defaults, normalization, and `tests/assistant-config.test.ts`. Every other job type has
  a configured priority; hardcoding one here would have been the odd one out.
- `AssistantService.drainJobs()` calls `enqueueWaitingCaptures()` first: when capability reports
  capable it enqueues `image_extraction` for **both** `queued` and `awaiting_image_capability` rows
  (a capture taken while the runtime was already capable is inserted as `queued`, so filtering on
  `awaiting_image_capability` alone silently stranded it — caught by the service-level drain test).
  Idempotency key `image_extraction:<evidenceId>` makes the re-check free.
- **Confidence cap implemented at the assertion, not the candidate:** `AssertionStore.
  listSupportingEvidence(assertionId)` returns `{ weight, source_type }` per live supporting row;
  `assertion-service.applyConfidence` derives both `supportWeights` and
  `singleScreenshotTextObservation` from that one query instead of the hardcoded `false`. A belief supported only
  by one screenshot lands at `SINGLE_SCREENSHOT_TEXT_CEILING` (0.55). This also means Task 12's
  "dependent assertion confidence recalculated" comes out right for free.

---

## Known gaps / notes for whoever continues

- **TDD honesty:** Task 8 and Task 10 had an observed RED run. Tasks 9 and 11 were written
  test-first but the RED run was not observed separately — the missing-module compile failure was
  the only red signal. Verified retroactively by mutation: dropping the preset check from
  `visionCapable`, the generation bump from `transitionModelTo`, and the pre-dispatch instance
  re-check each turned exactly the load-bearing test red, then were reverted.
- `CaptureQueueStore` has no `countByState` yet; **Task 13** needs it for `DesktopStateDto`'s
  `imageCapability.queueDepth`.
- **Pre-existing, out of scope, worth a decision:** `status-server/index.ts` builds
  `LlamaCppAssistantInference(initialConfig, …)` and `BackendTokenCounter(initialConfig)` from a
  boot-time `SiftConfig` snapshot that nothing refreshes (`AssistantService.refreshConfig` carries
  only the `Assistant` subtree). Every chat route re-reads config per request instead. Image
  admission now bypasses the snapshot via the applied-preset source, but the model id, base URL,
  and sampler defaults the assistant sends still come from boot-time config and go stale on a
  preset switch.
- Nothing evicts or expires queue rows yet — that is Task 12 in full (`RawRetentionHours`,
  `RawStorageLimitGb`, capacity eviction, blob deletion, audit per eviction). Task 12 also wires
  `CaptureIntake` to enqueue a `capacity` retention run; the intake does **not** do that today.
- The dashboard still renders no capture controls (Task 14) and there is no
  `GET /assistant/desktop/state` (Task 13).

## Next up: Task 12 — capture retention and eviction

Create `src/assistant/images/capture-retention.ts`; add the `capture_retention` job type
(payload `{ reason: 'schedule' | 'capacity' }`, **not** model-backed); enqueue on drain start;
test `tests/assistant-capture-retention.test.ts` (flat test layout, per the Task 1–7 conventions).
Reuse the existing evidence-deletion machinery in `EvidenceStore.deleteEvidence` and the Gate C
deletion service under `src/assistant/control/`.

Remaining after that: 13–15 (desktop state endpoint, dashboard, pixel reveal), 16–26 (Rust
toolchain + Tauri shell — Task 16 installs a portable rustup under
`C:\Users\denys\Documents\GitHub\.tooling\siftkit-gate-d\`), 27 (E2E), 28 (full validation gate).

---

## Changed / added files in this session (all uncommitted)

Modified: `packages/contracts/src/config.ts`, `src/assistant/assistant-service.ts`,
`src/assistant/graph/assertion-service.ts`, `src/assistant/inference/client.ts`,
`src/assistant/inference/roles.ts`, `src/assistant/inference/structured-runner.ts`,
`src/assistant/jobs/job-runner.ts`, `src/assistant/jobs/job-types.ts`,
`src/assistant/storage/assertion-store.ts`, `src/assistant/storage/job-store.ts`,
`src/config/defaults.ts`, `src/config/normalization.ts`,
`src/llm-protocol/image-attachments.ts`, `src/status-server/index.ts`,
`src/status-server/managed-inference-runtime.ts`,
`src/status-server/preset-runtime-coordinator.ts`, `src/status-server/routes/assistant.ts`,
`tests/assistant-config.test.ts`, `tests/assistant-inference-client.test.ts`,
`tests/assistant-job-runner.test.ts`.

Added: `src/assistant/images/{capture-queue-store,image-capability,image-extractor}.ts`,
`src/assistant/observation/capture-intake.ts`, `src/status-server/runtime-image-capability.ts`,
`tests/assistant-capture-intake.test.ts`, `tests/assistant-image-extraction.test.ts`,
`tests/runtime-image-capability.test.ts`.

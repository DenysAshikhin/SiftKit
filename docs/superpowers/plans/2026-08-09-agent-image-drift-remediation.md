# Agent Image Drift Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all ten agent-image drift findings through complete, typed, single-source replacements without changing intended feature behavior.

**Architecture:** Shared contracts own dependency-free image math and IO schemas. Server boundaries call one preset-admission operation and one OOM classifier. Transcript messages carry internal structured image identity, while dashboard runtime state owns complete pending attachments and React components contain only lifecycle state they actually need.

**Tech Stack:** TypeScript, Zod, Node test runner, React Testing Library, `@napi-rs/image`.

## Global Constraints

- Follow TDD for every behavior change: failing test, minimum implementation, passing test, refactor.
- No `any`, type assertions, non-null assertions, namespace imports, schema duplication, or unvalidated IO.
- Complete replacements only; delete obsolete parsers, queue state, duplicated helpers, and tests for removed APIs.
- Preserve unrelated changes and do not commit.
- Execute tasks sequentially and keep the applicable focused test slice green before continuing.

---

### Task 1: Consolidate shared image and startup-failure contracts

**Files:**
- Modify: `packages/contracts/src/image.ts`
- Create: `packages/contracts/src/managed-llama-failure.ts`
- Modify: `packages/contracts/src/system.ts`
- Modify: `packages/contracts/src/config.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `tests/contracts-chat.test.ts`
- Modify: `tests/contracts-config.test.ts`
- Modify: `tests/image-admission.test.ts`
- Modify: `dashboard/tests/message-images.test.tsx`

**Interfaces:**
- Produces: `computeImageTargetDimensions(width, height, maxPixels)`.
- Produces: `ManagedLlamaStartupFailureSchema` from a cycle-safe module.
- Changes: `ImageMetadataSchema.mime` to `ImageMimeSchema`.

- [ ] **Step 1: Write failing shared-contract tests**

```ts
test('image metadata rejects unsupported persisted MIME values', () => {
  assert.equal(ImageMetadataSchema.safeParse({ ...metadata, mime: 'image/bmp' }).success, false);
});

test('shared target dimensions preserve aspect ratio under the pixel ceiling', () => {
  assert.deepEqual(computeImageTargetDimensions(4000, 2000, 1_000_000), { width: 1414, height: 707 });
});

test('restart and system startup failures share nullable metric validation', () => {
  const failure = { kind: 'gpu_memory_oom', requiredMiB: null, availableMiB: null };
  assert.deepEqual(ManagedLlamaStartupFailureSchema.parse(failure), failure);
  assert.deepEqual(RestartBackendResponseSchema.parse({ ok: false, restarted: false, startupFailure: failure }).startupFailure, failure);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm test -- tests/contracts-chat.test.ts tests/contracts-config.test.ts tests/image-admission.test.ts dashboard/tests/message-images.test.tsx`

Expected: unsupported MIME is accepted, the shared dimension export is missing, or the duplicated schema remains independently defined.

- [ ] **Step 3: Implement the shared contracts**

```ts
export function computeImageTargetDimensions(
  width: number,
  height: number,
  maxPixels: number,
): { width: number; height: number } | null {
  if (width * height <= maxPixels) return null;
  const scale = Math.sqrt(maxPixels / (width * height));
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

export const ImageMetadataSchema = z.object({
  // existing fields
  mime: ImageMimeSchema,
});
```

Move `ManagedLlamaStartupFailureSchema` and its inferred type into `managed-llama-failure.ts`; import that schema from both response modules and export it through `index.ts`.

- [ ] **Step 4: Replace both local dimension implementations**

Import `computeImageTargetDimensions` from `@siftkit/contracts` in server admission and browser downscaling. Delete `computeTargetDimensions` and `computeBrowserTargetDimensions`, then update their tests to exercise the shared export through each consumer.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npm test -- tests/contracts-chat.test.ts tests/contracts-config.test.ts tests/image-admission.test.ts dashboard/tests/message-images.test.tsx`

---

### Task 2: Replace rendered-label parsing with structured image identity

**Files:**
- Modify: `src/repo-search/planner-protocol.ts`
- Modify: `src/repo-search/engine/transcript-manager.ts`
- Modify: `src/repo-search/engine/tool-action-processor.ts`
- Modify: `src/image-retention-policy.ts`
- Delete: `src/image-label-parser.ts`
- Modify: `tests/image-retention.test.ts`
- Modify: `tests/engine-transcript-manager.test.ts`

**Interfaces:**
- Changes: `ChatMessage` gains `imagePathKey?: string` as internal metadata.
- Changes: `TranscriptManager.pushUser` and `insertUserAfter` accept an optional `imagePathKey`.
- Changes: `ImageRetentionPolicy.prune` returns structured path keys.

- [ ] **Step 1: Write failing structured-identity tests**

```ts
test('retention releases a guard without parsing rendered text', () => {
  const message = imageMessage(PNG, 'arbitrary display copy');
  message.imagePathKey = buildReadPathKey('docs/architecture diagram.png');
  assert.deepEqual(new ImageRetentionPolicy(0).prune([message]), [message.imagePathKey]);
});

test('compaction keeps a structured image guard when label wording changes', () => {
  transcript.pushUser('not a canonical label', [PNG], pathKey);
  transcript.replaceWith([{ ...transcript.getMessages().at(-1) }]);
  assert.equal(liveImagePathKeys.has(pathKey), true);
});
```

- [ ] **Step 2: Run the retention/transcript tests and verify RED**

Run: `npm test -- tests/image-retention.test.ts tests/engine-transcript-manager.test.ts`

Expected: current code tries to parse the arbitrary label and loses the guard.

- [ ] **Step 3: Add and propagate structured metadata**

```ts
export type ChatMessage = {
  role: LlamaCppChatRole;
  content?: string | LlamaCppContentPart[];
  imagePathKey?: string;
  // existing internal/protocol fields
};
```

Set `imagePathKey` when inserting a successful tool image. Derive retained and dropped guards exclusively from that field. Keep `toProtocolChatMessages` unchanged so internal metadata never crosses the provider boundary.

- [ ] **Step 4: Delete the parser and parsing tests**

Remove `src/image-label-parser.ts`, its imports, label-regex tests, and any label-to-key fallback. Missing structured identity must not be silently reconstructed.

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run: `npm test -- tests/image-retention.test.ts tests/engine-transcript-manager.test.ts tests/image-read-tool.test.ts tests/repo-search.test.ts`

---

### Task 3: Centralize preset admission and retention rejection

**Files:**
- Modify: `src/llm-protocol/image-attachments.ts`
- Modify: `src/llm-protocol/image-admission.ts`
- Modify: `src/repo-search/engine/image-read.ts`
- Modify: `src/summary/request-runner.ts`
- Modify: `src/repo-search/execute.ts`
- Modify: `src/status-server/chat-repo-operation-runner.ts`
- Modify: `src/status-server/routes/chat.ts`
- Modify: `tests/image-admission.test.ts`
- Modify: `tests/image-read-tool.test.ts`
- Modify: relevant summary/repo-search/chat route tests

**Interfaces:**
- Produces: `IMAGE_RETENTION_DISABLED_REASON`.
- Produces: `admitImagesForPreset(preset, dataUrls): AdmittedImage[]`.

- [ ] **Step 1: Write failing source-of-truth tests**

```ts
test('preset admission applies guard, budget, and cap through one operation', () => {
  assert.throws(() => admitImagesForPreset(retentionZeroPreset, [PNG]), new RegExp(IMAGE_RETENTION_DISABLED_REASON));
  assert.equal(admitImagesForPreset(cappedPreset, [oversizedPng])[0]?.metadata.resized, true);
});

test('image read uses the shared retention-disabled reason', () => {
  assert.equal(executeImageRead(input).reason, IMAGE_RETENTION_DISABLED_REASON);
});
```

- [ ] **Step 2: Run the admission/read tests and verify RED**

Run: `npm test -- tests/image-admission.test.ts tests/image-read-tool.test.ts`

- [ ] **Step 3: Implement the shared operation and constant**

```ts
export const IMAGE_RETENTION_DISABLED_REASON =
  'Image input is disabled for this preset (VisionImageRetention = 0)';

export function admitImagesForPreset(
  preset: ModelRuntimePreset,
  dataUrls: readonly string[],
): AdmittedImage[] {
  assertPresetAcceptsImages(preset, dataUrls);
  if (dataUrls.length === 0) return [];
  return admitImageDataUrls(dataUrls, resolveImageTokenBudget(preset), preset.VisionMaxImagePixels);
}
```

- [ ] **Step 4: Migrate all four admission boundaries**

Each boundary selects its effective preset, calls `admitImagesForPreset`, and maps the returned records only where the downstream API needs data URLs. Delete copied imports and orchestration blocks.

- [ ] **Step 5: Run boundary tests and verify GREEN**

Run: `npm test -- tests/image-admission.test.ts tests/image-read-tool.test.ts tests/summary-status-server.test.ts tests/repo-search-status-server.test.ts tests/status-server-chat-routes.test.ts tests/chat-repo-operation-runner.test.ts`

---

### Task 4: Centralize GPU OOM diagnosis

**Files:**
- Modify: `src/status-server/managed-llama.ts`
- Modify: `src/status-server/routes/chat.ts`
- Modify: `src/status-server/chat-repo-operation-runner.ts`
- Modify: `tests/chat-oom-guidance.test.ts`
- Modify: `tests/chat-repo-operation-runner.test.ts`
- Modify: `tests/managed-llama-startup-failure.test.ts`

**Interfaces:**
- Produces: `diagnoseManagedLlamaOom(error, options): ManagedLlamaOomDiagnosis | null`.

- [ ] **Step 1: Write failing classifier tests**

```ts
test('typed startup failure wins over image presence', () => {
  const diagnosis = diagnoseManagedLlamaOom(startupError, { hasImages: true, visionMaxImagePixels: 500_000 });
  assert.equal(diagnosis?.phase, 'startup');
  assert.doesNotMatch(diagnosis?.guidance ?? '', /Max image size/iu);
});

test('untyped OOM text is image encode only for image-bearing requests', () => {
  assert.equal(diagnoseManagedLlamaOom(new Error(oomText), { hasImages: false }), null);
  assert.equal(diagnoseManagedLlamaOom(new Error(oomText), { hasImages: true })?.phase, 'image_encode');
});
```

- [ ] **Step 2: Run OOM tests and verify RED**

Run: `npm test -- tests/chat-oom-guidance.test.ts tests/chat-repo-operation-runner.test.ts tests/managed-llama-startup-failure.test.ts`

- [ ] **Step 3: Implement the typed diagnosis**

```ts
export type ManagedLlamaOomDiagnosis = {
  phase: GpuOomPhase;
  failure: ManagedLlamaStartupFailure;
  guidance: string;
};
```

The function checks typed startup metadata first, parses generic text only for image-bearing requests, and builds guidance once.

- [ ] **Step 4: Replace both classifiers**

Direct chat returns `diagnosis?.guidance ?? originalText`. Repo operations throw `ManagedLlamaStartupError` only for a startup diagnosis and otherwise throw a normal `Error` containing image guidance.

- [ ] **Step 5: Run OOM tests and verify GREEN**

Run: `npm test -- tests/chat-oom-guidance.test.ts tests/chat-repo-operation-runner.test.ts tests/managed-llama-startup-failure.test.ts tests/status-server-chat-routes.test.ts`

---

### Task 5: Make pending attachments atomic runtime state

**Files:**
- Modify: `dashboard/src/lib/downscale-image.ts`
- Modify: `dashboard/src/lib/chat-session-runtime-store.ts`
- Modify: `dashboard/src/hooks/useChatSessions.ts`
- Modify: `dashboard/src/hooks/useChatController.ts`
- Modify: `dashboard/src/tabs/ChatTab.tsx`
- Modify: `dashboard/src/components/PendingImageStrip.tsx`
- Delete: `dashboard/src/lib/pending-image-attachments.ts`
- Modify: `dashboard/tests/hooks/useChatSessions.test.tsx`
- Modify: `dashboard/tests/chat-session-runtime-store.test.ts`
- Modify: `dashboard/tests/chat-tab.test.tsx`
- Modify: `dashboard/tests/message-images.test.tsx`

**Interfaces:**
- Changes: `ChatSessionRuntime.pendingImages: PendingImage[]`.
- Adds transitions: `{ kind: 'append-images'; sessionId; images: PendingImage[] }` and `{ kind: 'images'; sessionId; images: PendingImage[] }`.
- Changes: API send payloads map `pendingImages.map(({ dataUrl }) => dataUrl)`.

- [ ] **Step 1: Write failing runtime-state tests**

```ts
test('pending attachment notes stay owned by their image through removal', () => {
  const store = initial.apply({ kind: 'images', sessionId: 's1', images: [first, second] });
  const next = store.apply({ kind: 'images', sessionId: 's1', images: [second] });
  assert.deepEqual(next.get('s1').pendingImages, [second]);
});

test('append-images atomically preserves dispatch order', () => {
  const next = initial
    .apply({ kind: 'append-images', sessionId: 's1', images: [first] })
    .apply({ kind: 'append-images', sessionId: 's1', images: [second] });
  assert.deepEqual(next.get('s1').pendingImages, [first, second]);
});
```

Add a ChatTab test where `readImageFiles` rejects and assert that the owning session failure callback receives the error.

- [ ] **Step 2: Run dashboard attachment tests and verify RED**

Run: `npm test -- dashboard/tests/chat-session-runtime-store.test.ts dashboard/tests/hooks/useChatSessions.test.tsx dashboard/tests/chat-tab.test.tsx dashboard/tests/message-images.test.tsx`

- [ ] **Step 3: Implement typed runtime ownership**

Store `{ dataUrl, note }` records atomically. Update strip rendering/removal and send projections. Remove resize-note maps and remapping logic.

- [ ] **Step 4: Replace the queue with ordering-only refs**

`ChatTab` keeps `{ generation, tail }` in one ref. A session change increments generation. Each selected batch chains onto `tail`; a matching generation dispatches `append-images`, while failure calls the provided session-error callback. The ref never stores images or notes.

- [ ] **Step 5: Delete the obsolete queue and verify GREEN**

Run: `npm test -- dashboard/tests/chat-session-runtime-store.test.ts dashboard/tests/hooks/useChatSessions.test.tsx dashboard/tests/chat-tab.test.tsx dashboard/tests/message-images.test.tsx dashboard/tests/pending-image-strip.test.tsx`

---

### Task 6: Preserve the zero sentinel and simplify caption lifecycle

**Files:**
- Modify: `dashboard/src/tabs/settings/VisionPresetControls.tsx`
- Modify: `dashboard/src/components/MessageImages.tsx`
- Modify: `dashboard/src/tabs/ChatTab.tsx`
- Modify: `dashboard/tests/vision-preset-controls.test.tsx`
- Modify: `dashboard/tests/message-images.test.tsx`
- Modify: `dashboard/tests/message-images-lifecycle.test.tsx`

**Interfaces:**
- UI stores `0` unchanged and derives effective pixel/readout values separately.
- Caption state is one discriminated map per image index.

- [ ] **Step 1: Write failing zero-sentinel tests**

```ts
test('max image size accepts and persists zero as model ceiling', () => {
  fireEvent.change(screen.getByLabelText('Max image size (MP)'), { target: { value: '0' } });
  assert.deepEqual(calls, [['VisionMaxImagePixels', 0]]);
});

test('enabling vision preserves an existing zero sentinel', () => {
  fireEvent.click(screen.getByRole('checkbox', { name: /vision enabled/iu }));
  assert.equal(calls.some(([field]) => field === 'VisionMaxImagePixels'), false);
});
```

- [ ] **Step 2: Write failing caption lifecycle tests**

Key the rendered `MessageImages` by `${sessionId}:${message.id}`. Rerender with a different identity and verify the old request cannot update the new component; double-clicking the same caption button must issue one request.

- [ ] **Step 3: Run focused UI tests and verify RED**

Run: `npm test -- dashboard/tests/vision-preset-controls.test.tsx dashboard/tests/message-images.test.tsx dashboard/tests/message-images-lifecycle.test.tsx dashboard/tests/chat-tab.test.tsx`

- [ ] **Step 4: Implement zero-sentinel behavior**

Use the raw configured value for the input, allow `min={0}`, and pass `0` through unchanged. Continue using `effectivePixels` for estimates and ceiling copy.

- [ ] **Step 5: Replace caption lifecycle machinery**

Use one `Record<number, CaptionState>` with `idle`, `pending`, `ready`, and `error` variants plus one mounted ref for async completion safety. Parent compound keys handle identity changes. Delete generation, active-identity, caption-value, and pending-index refs.

- [ ] **Step 6: Run UI tests and verify GREEN**

Run: `npm test -- dashboard/tests/vision-preset-controls.test.tsx dashboard/tests/message-images.test.tsx dashboard/tests/message-images-lifecycle.test.tsx dashboard/tests/chat-tab.test.tsx`

---

### Task 7: Removal audit and final validation

**Files:**
- Delete any obsolete tests/imports tied only to removed APIs.
- Modify: `.superpowers/sdd/2026-08-07-agent-image-reads/progress.md`

**Interfaces:**
- No new production interface; this task proves complete replacement and records evidence.

- [ ] **Step 1: Confirm obsolete artifacts are absent**

Run targeted searches for `parseGeneratedImageLabel`, `PendingImageAttachmentQueue`, `computeBrowserTargetDimensions`, `computeTargetDimensions`, the inline startup-failure object, copied admission triplets, and copied retention-disabled text. Expected: only the single authoritative declarations/usages remain.

- [ ] **Step 2: Run the broad server/core feature matrix**

Run the same image, retention, repo-search, summary, chat-route, caption, OOM, and managed-startup suites recorded in the existing progress ledger. Expected: all pass.

- [ ] **Step 3: Run the broad dashboard feature matrix**

Run all dashboard attachment, runtime-store, ChatTab, MessageImages, caption, settings, and API suites. Expected: all pass.

- [ ] **Step 4: Run static validation**

Run: `npm run typecheck`

Run: `npm run lint`

Run: `git diff --check`

Expected: all exit zero with no diagnostics.

- [ ] **Step 5: Attempt the full applicable suite**

Run: `npm test`

Expected: pass, or reproduce and report the already-documented baseline nontermination without claiming full-suite success.

- [ ] **Step 6: Update the progress ledger**

Record each remediation task’s focused test evidence, broad matrix counts, static-check results, deletions, and any remaining external/baseline limitation. Do not commit.

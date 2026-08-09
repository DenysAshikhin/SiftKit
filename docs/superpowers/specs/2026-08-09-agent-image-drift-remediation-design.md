# Agent Image Drift Remediation Design

## Goal

Replace the ten session-drift findings with single-source, typed implementations while preserving the completed agent-image behavior.

## Constraints

- Complete replacements only: remove the label parser, duplicated queue state, duplicated schemas, copied messages, and copied orchestration.
- TypeScript remains inferred end-to-end with runtime schemas at IO boundaries; no assertions, `any`, or non-null assertions.
- Every behavioral change starts with a failing regression test.
- Preserve the existing image formats, admission limits, retention semantics, selected-preset behavior, and user-visible copy unless this design explicitly changes them.
- Do not commit.

## Architecture

### Structured transcript image identity

`ChatMessage` gains an optional internal `imagePathKey`. `TranscriptManager.pushUser` and `insertUserAfter` accept that key when a repository image read creates the message. Planner compaction already copies message properties, so the key follows retained messages; `toProtocolChatMessages` continues serializing only protocol fields.

`ImageRetentionPolicy` returns dropped `imagePathKey` values directly. `TranscriptManager.releaseDroppedImageGuards` derives surviving guards only from structured keys on messages that still contain images. Human-readable labels remain presentation only. Delete `image-label-parser.ts` and all parsing call sites.

### Shared admission and resize policy

Move the pure aspect-preserving target-dimension function to `@siftkit/contracts`. Browser and server admission import the same function.

Add `admitImagesForPreset(preset, imageDataUrls)` beside server admission. It performs the preset guard, resolves the token budget, admits every image, and returns `AdmittedImage[]`. Summary, repo-search, direct-chat, and chat repo-operation boundaries call it instead of repeating the sequence.

The retention-disabled error becomes one exported constant used by both the throwing preset guard and repository image-read result. No consumer duplicates its text.

### Typed contracts

Move `ManagedLlamaStartupFailureSchema` to a cycle-safe contract module imported by both `system.ts` and `config.ts`; `RestartBackendResponseSchema` references that schema directly.

`ImageMetadataSchema.mime` uses `ImageMimeSchema`, rejecting unsupported persisted or HTTP MIME values.

### One OOM classifier

`managed-llama.ts` exposes one typed OOM diagnosis function accepting the error, whether the request contained images, and the active pixel cap. It returns either `null` or `{ phase, failure, guidance }`. Direct chat renders its guidance; repo operations use the same diagnosis and preserve `ManagedLlamaStartupError` only for `phase: 'startup'`.

### Dashboard attachment ownership

`ChatSessionRuntime.pendingImages` becomes `PendingImage[]`, where each entry owns its `dataUrl` and optional resize note. Runtime transitions append or replace typed attachments atomically. Send methods project them to data URLs only at the API boundary.

Delete `PendingImageAttachmentQueue` and its note-remapping state. `ChatTab` retains only a generation and promise tail to preserve selection order for overlapping reads; resolved batches dispatch typed append transitions to the captured session. Session changes invalidate older generations. File-read errors are routed to the existing session failure path instead of being swallowed.

`PendingImageStrip` receives typed entries directly, so removal cannot desynchronize notes from images.

### Dashboard controls and captions

The max-image-size input displays the stored `VisionMaxImagePixels` value, accepts `0`, and separately derives effective pixels for token and VRAM estimates. Enabling vision does not rewrite an existing zero sentinel.

`MessageBubble` keys image content by both session and message identity. `MessageImages` uses one per-index caption-state map and one mounted flag; identity changes remount the component. Remove generation, active-identity, mirrored caption, and pending-index refs.

## Error handling

- Failed attachment reads set the owning session error and do not mutate pending attachments.
- Stale attachment resolutions after a session-generation change are ignored.
- Unsupported persisted image MIME fails schema parsing loudly.
- OOM errors retain original text when classification returns `null`.
- Startup OOMs never mention image settings; image-encode OOMs retain the active preset cap guidance.

## Test strategy

1. Transcript tests prove labels can change arbitrarily while structured guard retention/release remains correct.
2. Admission tests prove all four boundaries share the same guard and cap behavior; dimension tests exercise the shared contracts function from browser and server consumers.
3. Contract tests reject unsupported metadata MIME and prove restart/system schemas accept the same nullable startup metrics.
4. OOM tests exercise the shared classifier through direct chat and repo-operation paths.
5. Dashboard runtime tests cover atomic attachment append/removal, overlapping order, session invalidation, and surfaced read failure.
6. Vision-control tests enter `0`, preserve it across enablement, and show model-ceiling-derived estimates.
7. Caption lifecycle tests cover duplicate clicks, success, failure, identity remount, and unmount without stale updates.
8. Run focused suites after each TDD cycle, then the broader image/chat/dashboard matrices, `npm run typecheck`, `npm run lint`, and `git diff --check`.

## Acceptance criteria

- All ten drift findings are removed, including obsolete artifacts and tests tied only to the old structures.
- There is one target-dimension algorithm, one server preset-admission operation, one startup-failure schema, one retention-disabled message, and one OOM classifier.
- Image guard ownership never depends on rendered text.
- Pending attachment data and notes have one authoritative owner and failures are visible.
- The dashboard can persist the `0` model-ceiling sentinel.
- Relevant tests and static validation pass; broader-suite limitations are reported exactly.

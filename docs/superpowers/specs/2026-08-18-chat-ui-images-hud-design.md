# Chat UI: optimistic bubbles, clipboard images, lightbox, image token accounting, perf HUD

Date: 2026-08-18
Status: approved

## Problem

Six gaps in the dashboard chat UI (`dashboard/src/tabs/ChatTab.tsx` and friends):

1. A submitted message and its attachments stay in the composer until the stream finishes. There is no bubble and no pending state.
2. Images can only be attached with the file picker. Clipboard paste does nothing.
3. Images in bubbles are static; there is no way to enlarge one without leaving the app.
4. A bubble's token chip counts text only. Image cost is invisible, and there is no way to drop a single image from a session's context.
5. Same limbo problem as (1) for plain text messages.
6. Prompt-processing speed, decode speed, TTFT, cache hit rate and acceptance rate are computed and passed into `ChatTab` but never rendered.

## Current state (verified)

- `ChatTab.tsx:439-471` — composer textarea, `Attach` file input, Send button. Draft and pending images live on `ChatSessionRuntime` (`dashboard/src/lib/chat-session-runtime-store.ts:18-30`) and are cleared only by the `done` transition (`:101-110`).
- `ChatTab.tsx:226` — `visibleMessages = [...persistedMessages, ...liveMessages]`. Live messages already exist for thinking/tool/answer; there is no live *user* message.
- `dashboard/src/components/MessageImages.tsx` — renders `images` + `imageMeta`, shows `tokenEstimate` inside a `<details>` summary, lazy-loads captions.
- `dashboard/src/components/PendingImageStrip.tsx` — thumbnails with a remove button.
- **Gap:** user-attached images never persist `ImageMetadata`. `src/status-server/routes/chat.ts:230-231` calls `admitImagesForPreset` then `.map((image) => image.dataUrl)`, dropping metadata; `AppendChatOptions` (`src/status-server/chat.ts:413-437`) has no `imageMeta` field; `src/state/chat-sessions.ts:661` therefore writes `image_meta = null`. Only `tool_image` messages carry metadata.
- **Gap:** `ContextUsageBuilder` (`src/status-server/chat.ts:147-195`) sums `formatChatMessageForPrompt` text only. `ContextUsageSchema` (`packages/contracts/src/chat.ts:46-52`) has no image-token field.
- **Gap:** no per-image delete. Only `DELETE /dashboard/chat/sessions/:id/messages/:messageId` (`src/status-server/routes/chat.ts:1379`).
- Per-turn rates ride the terminal `done` SSE payload (`toWireChatMessage`, `src/status-server/routes/chat.ts:178-180`). There are no live mid-stream timings.
- `getSessionTelemetryStats` (`dashboard/src/lib/format.ts:103-235`) already derives cache hit rate, acceptance rate, prompt t/s and generation t/s; the result is passed as `sessionPromptCacheStats` (`ChatTab.tsx:95`) and never used.

## Decisions

| Decision | Choice |
| --- | --- |
| Per-image delete semantics | Strip the image, leave the message text untouched, record a `removedImageCount` and render/replay the notice from it |
| HUD data source | Last completed turn + session aggregate; no live mid-stream timings |
| Image tokens in context usage | Yes — fold `tokenEstimate` into `ContextUsage` |
| HUD layout | Single inline strip under the composer, every chip hoverable |

## Design

### A. Optimistic bubbles (items 1, 5)

Add a `submit` transition to `ChatSessionRuntimeTransition`:

```
| { kind: 'submit'; sessionId: string; content: string; images: PendingImage[] }
```

`applyTransition('submit')`:

- builds a live user message with a fixed id `live-user` via `createLiveMessage`, carrying `content` and `images` (data URLs). It carries no `imageMeta`: `tokenEstimate` depends on the server-resolved `pixelsPerToken`, and `MessageImages` already degrades to a plain thumbnail when metadata is absent. The real per-image cost appears the moment the persisted message replaces the live one.
- appends it to `liveMessages` (empty at submit time, so the user bubble is always the first live entry and renders before any assistant live message);
- clears `draft` and `pendingImages`;
- stores `submittedInput: { content, images }` on the runtime.

`ChatSessionRuntime` gains `submittedInput: SubmittedChatInput | null`.

- `done` — clears `submittedInput` along with `liveMessages`; the persisted user message from the response takes over.
- `failure` — restores `draft` and `pendingImages` from `submittedInput`, clears it, drops the live bubble. This preserves the existing err-banner Retry, which depends on the draft still being present (`ChatTab.tsx:383`).

`sendMessage` / `sendPlan` / `sendRepoSearch` in `dashboard/src/hooks/useChatSessions.ts` apply `submit` before calling `runChatStream`, reading the payload from `readRuntimeInputs` first.

Pending affordance: the live user bubble renders with a `pending` modifier class while `activity.kind === 'active'` and no stream event has arrived yet; `MessageHeader` shows `sending…` in place of the timestamp and a spinner instead of the delete button (live messages already suppress delete). Once any thinking/tool/answer transition lands, the modifier drops.

Attachment read latency: `PendingImageStrip` accepts a `pendingCount` prop and renders that many skeleton tiles while `enqueuePendingImageRead` is in flight, so a slow downscale is visible rather than a dead pause.

### B. Clipboard paste (item 2)

`onPaste` handler on the composer textarea:

- read `event.clipboardData.items`, keep entries whose `type` starts with `image/`, map through `getAsFile()`;
- if none, return without touching the event so text paste is unaffected;
- otherwise `preventDefault()` and hand the files to the existing `enqueuePendingImageRead(files, effectiveImagePixelCeiling)` path, reusing the generation guard, downscale and error reporting;
- no-op when `effectiveImagePixelCeiling === null` or the session is busy, matching the file input's `disabled` condition.

Extraction of the image files from a `ClipboardEvent` lives in a pure helper (`dashboard/src/lib/clipboard-images.ts`) so it is unit-testable without a DOM paste.

### C. Lightbox (item 3)

New `dashboard/src/components/ImageLightbox.tsx`:

- props `{ src, alt, onClose }`; renders a fixed full-viewport overlay with `role="dialog"` and `aria-modal="true"`;
- closes on backdrop click, Esc keydown, and an explicit ✕ button;
- image sized with `max-width/max-height: 90vw/90vh` and `object-fit: contain`;
- focus moves to the close button on mount and returns to the trigger on unmount.

Both `MessageImages` and `PendingImageStrip` wrap their `<img>` in a `<button type="button" class="image-zoom">` that opens the lightbox. State is local to each component. Styles go in `dashboard/src/styles/chat.css`.

### D. Image token cost and per-image delete (item 4)

**D1 — persist metadata for user images.**
`admitSelectedChatImages` (`src/status-server/routes/chat.ts:223-233`) returns admitted metadata alongside the data URLs instead of discarding it. `AppendChatOptions` gains `imageMeta?: ImageMetadata[]`; the user-message push (`src/status-server/chat.ts:476-490`) sets `imageMeta: options.imageMeta ?? []`. All three stream endpoints (message, plan, repo-search) pass it through. `saveChatSession` already serialises `image_meta` when present.

**D2 — count image tokens in context usage.**
`getMessageContextTokenEstimate` (`src/status-server/chat.ts:44-49`) adds `sum(message.imageMeta.map((m) => m.tokenEstimate))`. `ContextUsageTokenTotals` and `ContextUsageSchema` gain `imageUsedTokens: number`. `buildTokenTotals` accumulates it separately so the settings popover can display it; `chatUsedTokens` and `totalUsedTokens` include it. The popover (`ChatTab.tsx:483-534`) gains an `Images: N` line.

**D3 — per-image delete endpoint.**
`DELETE /dashboard/chat/sessions/:id/messages/:messageId/images/:index` → new `DeleteChatMessageImageEndpoint` in `src/status-server/routes/chat.ts`, registered in `CHAT_ROUTES`. It calls a new `deleteChatMessageImage(runtimeRoot, sessionId, messageId, imageIndex)` in `src/state/chat-sessions.ts`, modelled directly on `updateChatMessageImageCaption` (`:458-512`):

- same validation (non-empty ids, non-negative integer index) and the same `ChatMessageImageNotFoundError` for a missing row, missing image or out-of-range index;
- splices `imageIndex` out of both `images` and `image_meta`;
- increments a `removed_image_count` column instead of editing `content`, so the user's text is never rewritten; the bubble notice and the replay notice (`appendRemovedImageNotice` in `src/status-server/chat.ts`) are composed from the count, so the model does not see a dangling reference;
- writes both columns plus `removed_image_count` in one `UPDATE`, requiring exactly one changed row;
- bumps `updated_at_utc` on the session.

The endpoint replies with `buildChatSessionResponse`, so the client gets a fresh `ContextUsage` and the context meter moves.

**D4 — client.**
`deleteChatMessageImage(sessionId, messageId, index)` in `dashboard/src/api.ts`; `deleteMessageImage` in `useChatSessions` (mirrors `deleteMessage`, calls `applySessionResponse`); threaded to `MessageImages` through `ChatTab` props. `MessageImages` renders a busy-guarded ✕ per image.

**D5 — bubble token chip.**
`getMessageImageTokenCount(message)` in `dashboard/src/lib/format.ts` sums `imageMeta.tokenEstimate`. `MessageHeader` renders `1,240 tok (+2,048 img)` when the image contribution is non-zero, and the plain label otherwise. `getTurnTokenDisplay` includes image tokens in its aggregate.

### E. Performance HUD (item 6)

New `dashboard/src/components/ChatStatsBar.tsx`, rendered inside `.composer` directly below the input row.

Chips, each `⟨icon⟩ ⟨value⟩` with a hover tooltip:

| Chip | Value | Tooltip |
| --- | --- | --- |
| ⚡ | prefill tokens/s | "Prompt processing speed on the last completed turn. Session average: N/s." |
| ▸ | decode tokens/s | "Token generation speed on the last completed turn. Session average: N/s." |
| ⏱ | TTFT ms | "Time to first token — the prompt-eval duration reported by the backend." |
| ⛁ | cache hit % | "Share of prompt tokens served from the prompt cache across this session." |
| ✦ | accept % | "Speculative-decoding acceptance rate across this session." |
| Σ | context tokens | "Tokens currently occupying the context window, including images." |

Data:

- Last-turn values come from a new pure selector `getLastTurnTelemetry(session)` in `dashboard/src/lib/format.ts`, which walks backwards to the last assistant message with usable timings and reuses the existing rate helpers.
- Session aggregates come from the existing `sessionPromptCacheStats` prop.
- Context tokens come from `contextUsage.totalUsedTokens`.

States:

- no data — every chip renders `—`; the strip stays mounted so layout does not jump;
- streaming — strip gets a `streaming` class (dimmed) and keeps showing the previous turn's numbers;
- populated — normal.

Tooltips are implemented as a CSS-only `data-tip` popover plus a `title` attribute, so they work under hover and are readable by assistive tech without a new dependency.

## Testing

TDD, failing test first, per task.

Dashboard:

- `chat-session-runtime-store.test.ts` — `submit` clears draft/images and creates `live-user`; `failure` restores them; `done` clears `submittedInput`.
- `hooks/useChatSessions.test.tsx` — send applies `submit` before streaming; failure path leaves the composer repopulated.
- new `clipboard-images.test.ts` — image extraction from a synthetic clipboard payload; text-only payload yields none.
- new `image-lightbox.test.tsx` — opens on click, closes on Esc/backdrop/✕.
- `message-images.test.tsx` — per-image ✕ calls the delete callback with the right index; token chip shows the image contribution.
- `chat-tab.test.tsx` — pending bubble renders on submit; paste attaches; stats bar renders `—` with no data and values when populated.
- new `chat-stats-bar.test.tsx` — the three states above.
- `lib/format.test.ts` — `getMessageImageTokenCount`, `getLastTurnTelemetry`.

Server:

- `tests/status-server-chat-routes.test.ts` — per-image delete happy path, out-of-range index, missing message, marker text appended, session response carries updated `ContextUsage`; user-message `imageMeta` is persisted by the stream endpoints.
- context-usage tests — image tokens included in `chatUsedTokens`/`totalUsedTokens` and reported as `imageUsedTokens`.

Gate before completion: `npm run typecheck`, `npm run lint`, the dashboard suite and the affected server tests.

## Non-goals

- Live mid-stream timing events over SSE.
- Drag-and-drop attachment.
- Re-adding a deleted image.
- Changing how images are downscaled or admitted.

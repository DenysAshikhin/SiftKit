# Agent image reads, image admission, and chat image rendering

Date: 2026-08-07
Status: draft for review

## Problem

Four defects and one feature, all on the image path.

1. **An images-only chat turn cannot execute.** `parseChatMessageRequest` deliberately accepts a
   request with empty text and at least one image
   (`src/status-server/chat-route-request-normalizers.ts:63`), and the dashboard submits it
   (`dashboard/src/hooks/useChatSessions.ts:343`), but `executeRepoSearchRequest` rejects any empty
   prompt without consulting `initialUserImages` (`src/repo-search/execute.ts:288-292`). The
   relaxation was applied at the request boundary and never at the engine guard. The thrown message
   also names `--prompt` and `repo-search` on `chat` and `plan` turns, where neither applies.

2. **The dashboard repo-search and plan endpoints silently drop attached images.** No layer on that
   route carries them: not the payload (`dashboard/src/api.ts:418-431`), not the sender
   (`useChatSessions.ts:366-377`), not `ChatRepoRequest`
   (`chat-route-request-normalizers.ts:24-27`), not `ResolvedChatRepoRequest`
   (`src/status-server/routes/chat-session-operation-endpoint.ts:26-29`), and not
   `buildChatRepoOperationRequest` (`src/status-server/routes/chat.ts:228-257`). The composer still
   reports the attachment, so the loss is invisible.

3. **The agent cannot look at an image in the repository.** Images enter the transcript at exactly
   one point — the initial user message, via `buildUserContent`
   (`src/repo-search/engine/transcript-manager.ts:31`). Tool results are text only
   (`src/tool-call-messages.ts:51-55`), so a vision-capable model working in a repository full of
   screenshots and diagrams has no way to see any of them.

4. **Image size is unvalidated on the path that needs it most.** `SIFT_MAX_IMAGE_BYTES` (20 MB) is
   enforced only in `ImageAttachmentReader.read`
   (`src/llm-protocol/image-attachments.ts:55`), which serves CLI `--image` and repo-agent. The
   data-URL path used by the dashboard and every HTTP route — `ImageDataUrlSchema`
   (`image-attachments.ts:26-34`) — validates the prefix and MIME allow-list and nothing else. A
   browser paste of a 60 MB screenshot reaches the model unchecked. Compounding it,
   `SIFT_IMAGE_TOKEN_ESTIMATE` is a flat 2048 regardless of resolution, so the context preflight
   under-budgets large images and overflow surfaces late or not at all. Nothing anywhere reads
   image dimensions.

Feature: **images should render as images in chat**, with a collapsed annotation exposing what the
model perceives, and the composer should preview pending attachments with per-image removal.

## Scope

In scope: the five sections below, across CLI, HTTP routes, engine, and dashboard.

Out of scope: video or PDF input; multi-frame GIF handling beyond frame one; server-side resizing of
GIF (see §4.4); automatic re-captioning when a preset changes.

## 1. Images-only turns reach the engine

`src/repo-search/execute.ts:288-292` becomes prompt-or-image:

```ts
const prompt = String(request.prompt || '').trim();
if (!prompt && (request.initialUserImages ?? []).length === 0) {
  throw new Error('A prompt or an image is required.');
}
```

The message drops the `--prompt` and `repo-search` wording, which was wrong on `chat` and `plan`
turns.

The CLI guard at `src/cli/run-repo-search.ts:31` **stays strict and keeps its current message**.
`siftkit repo-search` with no `--prompt` is a user error worth naming by flag, and the CLI's message
is more actionable there than the engine's generic one. This asymmetry is deliberate; a reader who
assumes it is an oversight should read this paragraph first.

Existing assertions on the old string (`tests/repo-search.test.ts:222`, `:232`) are updated rather
than deleted — the empty-and-no-image case they cover is still a real failure, only its message
changes. `tests/cli-internal.test.ts:263` exercises the CLI guard, which is unchanged, so that test
stays as-is; if it starts failing, the CLI guard was relaxed by mistake.

## 2. Images reach the repo-search and plan endpoints

`images` is threaded through every link that currently drops it:

| Layer | File | Change |
|---|---|---|
| Payload type | `dashboard/src/api.ts:418-431` | add `images?: string[]` to both stream payloads |
| Sender | `dashboard/src/hooks/useChatSessions.ts:366-377` | pass `inputs.pendingImages` |
| Wire request | `chat-route-request-normalizers.ts:24-27,73-83` | add `images`, parsed by `parseImageDataUrls` |
| Resolved request | `chat-session-operation-endpoint.ts:26-29` | add `images` |
| Operation request | `chat.ts:228-257` | add `images`, forward as `initialUserImages` |

Two omissions ride along, because they are the same defect: `assertPresetAcceptsImages` currently
runs only on the message endpoints and is added to the repo-search and plan endpoints; and the user
message persists its images the way chat already does, so an attachment survives a session reload.

`content` stays required on these two endpoints. A repository search with no question is not a
meaningful request; images-only is a chat affordance.

## 3. `read` returns images

### 3.1 Surface

`read` gains image support with no new arguments, dispatching on file extension. `isImagePath` is
exported from `image-attachments.ts` and reuses the existing `IMAGE_MIME_MAP`, so the supported
format list keeps one definition.

### 3.2 Gating and discoverability

`RepoToolContext` gains `visionEnabled`. With vision off, an image path fails with
`reading images requires an exl3 preset with VisionEnabled; this preset is text-only` — one wasted
turn, but it names the fix.

To avoid spending that turn, `resolveRepoSearchPlannerToolDefinitions` takes a `visionEnabled` flag
and swaps `read`'s description. The text-only variant is today's string verbatim.
`TOOL_DEFINITIONS` keeps the text-only default.

The vision variant appends a sentence naming the formats, so a model never has to guess whether an
image is readable:

> Images are supported: reading a `.png`, `.jpg`/`.jpeg`, `.webp` or `.gif` file returns the picture
> itself for you to look at, not its bytes. `offset` and `limit` do not apply to images.

The format list is generated from `IMAGE_MIME_MAP` rather than hardcoded in the description, so
adding a format cannot leave the prompt stale.

### 3.3 Image branch

Shares `read`'s path resolution, ignore-policy and existence checks, then diverges completely:

- size and dimensions validated by the shared admission path (§4)
- `offset` and `limit` rejected outright rather than ignored — accepting them would imply a
  windowing that does not exist
- no `lineReadStats`, no `findContiguousUnreadRange`
- re-reads guarded by an explicit in-context image set (§5.3), because the line-range tracker's
  "lines 1-1 were already returned" phrasing is meaningless for a PNG

### 3.4 Transport

`RepoToolExecution` gains `imageDataUrl?: string`. The tool result stays text
(`Image docs/arch.png (1440×900) attached below.`); the engine then appends a `role: 'user'` message
carrying the image, flushed immediately after `appendBatchExchange` alongside the existing
`pendingModeChangeUserMessages` (`tool-action-processor.ts:207-208`).
`TranscriptManager.pushUser` takes an optional images argument and routes through `buildUserContent`.

Images go in a user message rather than the `role: 'tool'` message because OpenAI-compatible
endpoints are not required to scan tool-role messages for `image_url` parts. TabbyAPI's behaviour
here is unverified and could not be tested — the local server returned 503 on every completion
throughout this design work. The user-message form is provider-agnostic and needs no such guarantee.

## 4. Admission: size, dimensions, and downscaling

### 4.1 One shared byte guard

The byte limit moves into `ImageDataUrlSchema`, computed from base64 payload length without
decoding. Every HTTP route inherits it through `parseImageDataUrls`, closing the dashboard hole.
`ImageAttachmentReader.read` keeps its pre-encode check — cheaper, and it catches the file before
base64 inflates it by a third — but both read the same constant.

The zod schema stays cheap: prefix, MIME, byte length. Dimension and token admission is a separate
explicit step, because decoding inside a schema refinement is both slow and wrongly placed.

### 4.2 Dimensions

`readImageDimensions(buffer, mime)` returns width and height:

- PNG, JPEG, WebP — `Transformer.metadata()` from `@napi-rs/image` (verified)
- GIF — header read, bytes 6–9 little-endian uint16 (verified), because the library cannot decode
  GIF at all

### 4.3 Token ceiling derived from the model

`resolveImageTokenBudget(preset)` reads `preprocessor_config.json` from the preset's `ModelPath`
(`packages/contracts/src/config.ts:71`) and derives pixels-per-token from `max_pixels`, patch size
and merge size. Result is cached per preset and logged with its source. When the file is absent or
unparseable it falls back to a default ratio **and says so loudly** rather than silently.

The resolved ceiling surfaces in the preset panel, so the limit is visible before it is hit.

**Verification required during implementation:** the model directory layout on the target machine was
not confirmed — TabbyAPI exposes only directory names through `/v1/models`. The first implementation
task is to confirm `preprocessor_config.json` sits beside the weights. If it does not, the fallback
ratio is the shipped behaviour and this section reduces to a constant.

### 4.4 Downscaling

Images above the ceiling are downscaled to fit rather than rejected. Target dimensions come from one
shared function, `computeTargetDimensions(width, height, maxPixels)`, used by both execution paths;
only the resampling call differs. Format is preserved; animated GIF takes frame one.

**Dashboard attachments resize in the browser** with `createImageBitmap` +
`OffscreenCanvas.convertToBlob()`. No dependency, and it fixes the problem at its source: a 60 MB
paste never becomes an 80 MB base64 POST. This is also the only path that can downscale a GIF, since
browsers decode GIF natively.

**Agent `read` and CLI `--image` resize server-side** with `@napi-rs/image`, Lanczos3. Lanczos3 is
the right default because the dominant input is UI screenshots, where glyph legibility after
downscale is the whole point, and it preserves text edges markedly better than bilinear.

An oversized **GIF** on the server path cannot be resized and is rejected with the resize message.
`@napi-rs/image` does not support GIF decoding. If server-side GIF resize later proves to matter,
that is the trigger to switch this path to `sharp`, which handles it via libvips.

Rejection message names real numbers:
`image is 8000×8000 (64.0 MP); this preset accepts up to 12.5 MP (≈2048 image tokens) — resize and retry`.

### 4.5 Budgeting

No change to `preflightPlannerPromptBudget`. Because admission guarantees every image is at or under
`SIFT_IMAGE_TOKEN_ESTIMATE`, the existing flat per-image charge
(`src/repo-search/prompt-budget.ts:139-142`) becomes accurate by construction instead of a guess.

## 5. Retention and replay

### 5.1 The replay defect

Chat sessions hold no live transcript; each turn rebuilds history from persisted rows via
`buildChatHistoryMessages`, and persisted tool commands re-expand into assistant/tool pairs — `read`
is in `REPLAY_NATIVE_TOOL_NAMES` (`src/llm-protocol/tool-call-parser.ts:43`). An image read produces
three messages, not two:

```
assistant  tool_call: read path="docs/arch.png"
tool       "Image docs/arch.png (1440×900) attached below."
user       [image_url: data:…]        ← synthetic, not part of the pair
```

Replay reconstructs the pair. The third message is lost, leaving text that points at nothing, and
the model's likeliest recovery — re-reading the file — is refused by the dedup guard, stranding it
referring to something it cannot see. Ordering is the second trap: once persisted, that message must
land immediately after its own tool result, not batched at the end of the rebuild, or it attaches to
the wrong tool call.

Resolution: **persist the synthetic message as a first-class message, replayed in position.** The
chat schema already carries `images` on user messages.

### 5.2 Retention window

Persisting alone would make every image permanent, re-sending 2048 tokens per image on every later
turn. A new preset field `VisionImageRetention` bounds it, following the `ThinkingRetentionPolicy`
precedent already in the codebase:

| Value | Behaviour |
|---|---|
| `8` (default) | the 8 most recent **images** stay live; older ones degrade to `[image docs/arch.png — 1440×900, dropped from context]` |
| `-1` | unbounded; images are never aged out, and context pressure is left to the existing overflow and compaction path, which already counts images |
| `0` | no image is ever admitted, on any path — composer upload, HTTP route, CLI `--image`, or agent `read` |

The window counts **individual images, not messages**, because one message can carry several. Ageing
out is oldest-first, and degrading an image rewrites just that `image_url` part into a text part
within its message, leaving any still-live siblings untouched. Message content is already a parts
array (`buildUserContent`), so this needs no new shape.

`VisionImageRetention` is added to `ModelPresetFieldSchema` and the preset settings section, so it
gets configuration UI on the same footing as `VisionEnabled`.

**Two switches, two messages.** `VisionEnabled: false` and `VisionImageRetention: 0` both reject
images and must be distinguishable, or a user will change the wrong one:

- vision off → `Vision is not enabled for this preset; enable VisionEnabled to use images` (existing)
- retention zero → `Image input is disabled for this preset (VisionImageRetention = 0)`

### 5.3 Re-read guard keys off "in context", not "ever read"

The §3.3 guard tracks images **currently live in the transcript**, not images ever read. When an
image ages out under §5.2, or is dropped by compaction, re-reading it is permitted again. Keying the
guard off "ever read" would combine with retention to produce exactly the trap described in §5.1.

## 6. Dashboard rendering

### 6.1 Composer previews

Replaces the current `N image(s) attached` text. A horizontal strip inside the composer container
above the input: ~56px rounded thumbnails, `object-fit: cover`, horizontal scroll past about six,
and a circular (×) at each thumbnail's top-right — shown on hover **and on keyboard focus**, never
hover-only, so it stays reachable.

Removal reuses the existing store transition rather than adding one:
`setSessionImages(id, images.filter((_, i) => i !== index))`.

A thumbnail whose source was downscaled in the browser carries a quiet badge, with original and
final dimensions in its tooltip. A silent resize would otherwise be invisible at exactly the moment
it matters.

### 6.2 Embedded images and the collapsed annotation

Images render inline in the message bubble. Beneath each, a collapsed disclosure:

```
▶ 1440×900 · png · 412 KB · 1,024 tok
```

Metadata is computed once at admission and persisted with the message, so display costs nothing.

Expanding requests a caption from a new endpoint, which runs a single-turn vision pass, persists the
result and returns it. Cached — a second expand is free. It takes the model-request lock like every
other inference route and passes through `assertPresetAcceptsImages`.

**The caption is labelled as an independent read of the image, not a transcript of the original
turn.** It is a second, separate perception. It answers "is this image legible to this model at this
resolution", which is the practical question, but it cannot prove what the model attended to during
the real turn, and the UI must not let it read as ground truth.

Agent `read` images use the identical component; the persisted synthetic message from §5.1 is what
the run log renders.

## 7. Dependency

`@napi-rs/image@1.14.0` added as a runtime dependency. Verified on 2026-08-07:

- prebuilds for win32-x64-msvc plus twelve other targets, including a wasm32-wasi fallback
- `Transformer.metadata()` returns `{width, height, format, colorType}`, removing the need for a
  hand-rolled header parser on three of four formats
- `ResizeFilterType.Lanczos3` resizes correctly; PNG, JPEG and WebP all decode, resize and encode
- 12 MP → 1.5 MP in 155–214 ms per format
- GIF is not supported for decode (§4.4)

`better-sqlite3` is already a native module with prebuilds and a postinstall script, so this adds no
new class of dependency. `sharp` is the documented fallback if server-side GIF resize becomes
necessary.

## 8. Testing

TDD throughout; each item is a failing test first.

**Engine and admission**
- images-only request executes; empty-and-imageless still throws, with the new message
- CLI keeps its flag-specific message
- byte limit enforced on the data-URL path (the current gap) and the file path alike
- dimensions read correctly for PNG, JPEG, WebP and GIF
- over-ceiling image downscales to within budget server-side; oversized GIF rejects with the resize
  message
- token ceiling derived from a fixture `preprocessor_config.json`; fallback path logs its source

**`read`**
- tool description names every `IMAGE_MIME_MAP` extension when vision is on, and is byte-identical
  to today's string when vision is off; adding a format to the map changes the description without
  a further edit
- returns an image for each supported extension; appends exactly one user message, positioned
  immediately after its tool result
- rejected with the vision message when the preset lacks vision
- `offset`/`limit` rejected on an image path
- second read of a live image refused; permitted again once aged out

**Retention and replay**
- a persisted image read replays in position with its image intact
- default 8 ages out the ninth; `-1` never ages out; `0` rejects at upload with the retention
  message, distinct from the vision-disabled message

**Routes**
- repo-search and plan endpoints forward images and enforce `assertPresetAcceptsImages`
- images persist and survive session reload

**Dashboard**
- composer renders one thumbnail per pending image; (×) removes the right index; control reachable
  by keyboard
- oversized attachment downscales in-browser before upload and shows the resize badge
- annotation renders metadata collapsed; caption fetched on first expand and cached

Before completion: relevant tests, the broader suite, `npm run typecheck`, `npm run lint`.

## 9. Risks and open items

1. **`preprocessor_config.json` location unverified** (§4.3). First implementation task; documented
   fallback if absent.
2. **TabbyAPI tool-role image handling unverified.** Sidestepped by the user-message transport
   (§3.4), so this is a design constraint rather than an open risk — but it is the reason for that
   choice and should not be "simplified" away later without testing.
3. **The local provider is down.** TabbyAPI returned 503 on every completion during this design
   work, including plain text with no images, on both `/v1/chat/completions` and `/v1/completions`,
   with the model resident. End-to-end verification of any vision behaviour is blocked until that is
   resolved; it is an environment fault, not a SiftKit defect.
4. **Caption cost.** One extra vision pass per expanded image. Bounded by being on-demand and
   cached, but it is real GPU time on a box with ~1.8 GB free VRAM.
5. **`VisionImageRetention: -1`** defers entirely to compaction. Compaction dropping an image
   message must release the §5.3 re-read guard, or the model is stranded exactly as in §5.1.

# EXL3 vision preset toggle + image input — design (2026-07-30)

## Problem

The managed EXL3 backend runs Qwen3.5-27B, a vision-language model, with TabbyAPI's
`vision: false`. The vision tower is never loaded and SiftKit has no way to send images.
Two gaps:

1. No preset-level control over whether the tower loads. Measured cost of loading it:
   **890.1 MiB resident** (BF16, unquantized — exl3 does not quantize the vision tower, so
   the 4.7bpw setting does not apply to it) plus **~0.1 MiB per image token** transient during
   encode (31 MiB at 640×480, 207 MiB at 1080p, 828 MiB at 4K). Image embeddings come back on
   CPU, so the runtime cost is weights + encode spike only.
2. No path for an image to reach the model from any SiftKit surface.

## Scope

In: a boolean preset field controlling the tower, and image input on four surfaces
(`summary`, `repo-search`, `repo-agent` CLI flags; dashboard chat attachment).

Out: `max_pixels` control (TabbyAPI has no knob — exllamav3 reads it from the model's
`preprocessor_config.json`), an agent-callable image tool, video input, blob storage/GC.

## A. Preset field `VisionEnabled`

Preset fields live in one flat shape shared by both backends and are gated per-backend by
`getPresetFieldAvailability`.

- `packages/contracts/src/config.ts`: `ManagedLlamaSettingsShape` gains
  `VisionEnabled: z.boolean()`; `ModelPresetFieldSchema` gains `'VisionEnabled'`.
- `src/config/constants.ts`: `SIFT_DEFAULT_VISION_ENABLED = false`.
- `src/config/defaults.ts` and `src/config/normalization.ts`: normalized as a boolean, mirroring
  `FlashAttention`.
- `src/inference-presets/preset-compatibility.ts`: the `Backend === 'llama'` early return becomes
  explicit — `VisionEnabled` reports `{ enabled: false, reason: 'Not supported by llama.cpp' }`
  for llama. For exl3 it joins the `ExternalServerEnabled`-gated group alongside `ParallelSlots`
  and the speculative fields: a preset pointing at an externally-run TabbyAPI does not own its
  launch flags.
- `src/inference-presets/exl3-preset-adapter.ts`: `Exl3LaunchEnvironmentSchema` gains
  `TABBY_MODEL_VISION: z.enum(['true', 'false'])`, always emitted. TabbyAPI reads it through its
  `TABBY_{section}_{field}` env override (`common/tabby_config.py:159`) and pydantic coerces the
  string to `bool`.

Reload on toggle is automatic: `managed-tabby.ts:84` derives `processSignature` from
`JSON.stringify(launchEnvironment)`, so changing the value restarts the engine.

Dashboard: `settings-draft-editor.ts` field union, a `settings-sections.ts` entry with help text
naming the ~890 MiB cost, and a checkbox in `tabs/settings/ModelPresetsSection.tsx` rendered
through `renderCompatibilityControl`.

## B. Preflight — no silent vision-off

New `src/inference-presets/exl3-model-capabilities.ts`: class `Exl3ModelCapabilities` with
`hasVisionTower(modelDirectory: string): boolean`, reading the model's `config.json` and
zod-parsing for a `vision_config` object. `Exl3PresetAdapter.validatePreset` throws when
`VisionEnabled` is true and the tower is absent:

```
preset=<id> backend=exl3 VisionEnabled=true but <path> has no vision_config
```

Without this, TabbyAPI logs a warning and continues with vision silently off while the preset
claims otherwise. The adapter constructs the capability reader directly — no injected functions.

## C. Image attachment core

One shared module, `src/llm-protocol/image-attachments.ts`, used by every surface:

- `ImageDataUrlSchema` — `z.string().regex(...)` matching `data:image/(png|jpeg|webp|gif);base64,…`.
  TabbyAPI's `common/image_util.py` accepts exactly this form (or an http URL, which SiftKit does
  not produce).
- `class ImageAttachmentReader` — `read(path: string): string`. Extension→mime map, a
  `SIFT_MAX_IMAGE_BYTES = 20 * 1024 * 1024` cap, and loud throws on unknown extension, oversize,
  or unreadable file.
- `buildUserContent(text: string, images: readonly string[]): string | LlamaCppContentPart[]` —
  returns the plain string when `images` is empty, otherwise
  `[{ type: 'text', text }, …images.map(url => ({ type: 'image_url', image_url: { url } }))]`.
- `assertPresetAcceptsImages(preset: ModelRuntimePreset, imageCount: number): void` — throws when
  images are present and `Backend !== 'exl3' || !VisionEnabled`. No auto-enable, no engine reload
  triggered by a request.

`LlamaCppContentPart` already carries `image_url`, so the wire type needs no change.
`ChatMessage.content` in `src/repo-search/planner-protocol.ts:65` widens from `string` to
`string | LlamaCppContentPart[]`. Only three sites read it as a string
(`prompt-budget.ts:148`, `planner-protocol.ts:412`, `planner-protocol.ts:763`) and two already
guard with `typeof === 'string'`.

Token accounting: image tokens cannot be derived from a data URI without decoding the image, so
`SIFT_IMAGE_TOKEN_ESTIMATE = 2048` per image feeds the pre-flight prompt budget. The engine's
reported prompt token count remains the source of truth after the request.

## D. Wiring per surface

`task-loop.ts:220-226` builds the initial user turn for repo-search, repo-agent *and* chat
(`loopKind === 'chat'`), so one new `initialUserImages: readonly string[]` option on
`TaskLoop`/`TranscriptManager` covers three of the four surfaces.

| surface | entry | request field | turn construction |
|---|---|---|---|
| summary | `--image <path>`, repeatable | `SummaryRequest.images` | `src/summary/planner/mode.ts:1427` via `buildUserContent` |
| repo-search | `--image <path>`, repeatable | `/repo-search` body `images` | `task-loop.ts:220` |
| repo-agent | `--image <path>`, repeatable | `/repo-agent` body + run record | `task-loop.ts:220` |
| chat | `ChatTab.tsx` file input + paste, `FileReader` → data URI | `ChatMessageRequest.images` | current turn via `task-loop.ts:220`; history via `chat.ts:228` |

CLI: `ParsedArgs.images?: string[]` collected by repeated `--image` in `parseArguments`, resolved
through `ImageAttachmentReader` in `run-summary.ts` and `run-repo-search.ts`, and posted as data
URIs. `validateRepoSearchTokens` gains `--image` to its value-flag set. repo-agent parses its own
tokens, so `RepoAgentStartInvocationSchema` in `repo-agent-args.ts` gains
`images: z.array(z.string()).default([])`, `parseRepoAgentInvocation` collects repeated `--image`
via `readOptionValue`, and `repo-agent-request.ts` forwards them alongside `prompt`.

Summary's `stdin, --text or --file required` guard (both `run-summary.ts:26` and
`route-request-normalizers.ts:127`) relaxes to allow an images-only request.

Persistence: images are stored inline as data URIs. A new `images TEXT` column (JSON array) on
`chat_messages`, added through the existing migration list at `runtime-db.ts:363-372`, plus the
field on `MessageRowSchema` and `PersistedChatMessage`. `PersistedChatMessage.content` stays a
`string` — images never move into the content column. `buildChatHistoryMessages` re-emits content
parts for user messages that carry images, so an image stays in context across turns; TabbyAPI's
32-entry embedding cache keys off the data URI, so re-sends do not re-encode.

## E. Errors

Every failure is loud and names the offending input:

- CLI: unknown extension, oversize, or unreadable file → non-zero exit naming the path.
- Server: malformed data URI or preset mismatch → HTTP 400 with the reason.
- Adapter: `VisionEnabled` on a model with no vision tower → throw at preset validation.
- No image is ever silently dropped, downscaled, or converted.

## F. Testing (TDD, E2E-first)

- `tests/model-preset-adapters.test.ts:46` and `:80` `deepEqual` the whole launch environment —
  both fixtures need `TABBY_MODEL_VISION` or the suite fails. New cases: the true/false env value,
  and both preflight branches against fixture model directories with and without `vision_config`.
- New `tests/image-attachments.test.ts`: reader mime/size/missing-file behaviour, `buildUserContent`
  shapes for zero and many images, and `assertPresetAcceptsImages` in both directions.
- E2E per surface against the existing fake-inference harness: assert the outbound request body
  contains the `image_url` part for each of summary, repo-search, repo-agent and chat, and assert
  rejection when `VisionEnabled` is false or the backend is llama.
- Chat round-trip: persist a message with images, reload the session, confirm
  `buildChatHistoryMessages` re-emits the parts.
- Config round-trip for the new field plus the availability matrix (llama / exl3-managed /
  exl3-external).

## G. Docs

`docs/exl3-performance-tuning-2026-07-21.md` gains a note next to the `EXL3_QC_ATTN` rationale:
the launch key, the measured 890.1 MiB resident cost, the ~0.1 MiB/image-token encode spike, and
the fact that the model's `preprocessor_config.json` allows up to 16.7 Mpx (16,384 image tokens,
~1.6 GiB transient) per image because nothing clamps it.

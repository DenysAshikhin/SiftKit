# ReasoningEffort preset field — design

Date: 2026-08-17
Status: approved, pending implementation plan

## Problem

Qwen3.8-27B exposes reasoning depth through the `reasoning_effort` chat-template
variable. SiftKit never sends it: `reasoning_effort` appears nowhere in `src`, so every
request silently runs at the template's own default. The preset config can toggle
thinking on and off and control transcript replay, but cannot tune depth.

## Evidence

The active preset is `exl3-3-6-27b-2` (label `EXL3 3.8_27B`, `Backend: exl3`,
`Model: 3.8_27b_4.6bpw`, `ModelPath: D:\personal\models\elx3\3.8_27b_4.6bpw`). The
preset id is a stale leftover from cloning the 3.6 preset and is deliberately not
renamed; ids are identity keys.

`D:\personal\models\elx3\3.8_27b_4.6bpw\chat_template.jinja`, version
`qwen3.8-froggeric-v22`:

- `:43` — `{%- set _effort_raw = reasoning_effort if reasoning_effort is defined else 'xhigh' %}`.
  The template default is `xhigh`.
- `:44-52` — normalization. `high` and `xhigh` both collapse to `xhigh`; `low` stays
  `low`; `medium` stays `medium`; anything else falls back to `xhigh`. Three effective
  levels.
- `:54-60` — the level selects a system-prompt sentence, and only when thinking is on.
  `xhigh` asks the model to validate assumptions and weigh alternatives; `low` asks for
  brief thinking; `medium` produces an empty string, so no preamble is injected.
- `:126-128`, `:146-148` — that sentence is prepended to the tools system block, or
  becomes/prefixes the system message.

The model README confirms `reasoning_effort` is a supported knob alongside
`enable_thinking` and `preserve_thinking`, the two SiftKit already sends.

## Decision

Add `ReasoningEffort: 'low' | 'medium' | 'xhigh'`, default `'xhigh'`, as a preset field
available on both backends, delivered as `chat_template_kwargs.reasoning_effort`.

`high` is not offered: it is a dead alias for `xhigh` in this template, and an option
that silently means something else is a lie in the UI. There is no "unset" state — the
field always has a value, matching every other preset field. There is no per-request
override; the preset stays the single owner of thinking policy, as
`inference-passthrough.ts:73` already documents.

## Architecture

The field follows the path every other preset field already takes. No new layer.

### Contract

`packages/contracts/src/config.ts`

- `ReasoningEffortSchema = z.enum(['low', 'medium', 'xhigh'])` beside `ReasoningSchema:15`,
  exported with its inferred type.
- `ReasoningEffort: ReasoningEffortSchema` in `ManagedLlamaSettingsShape:67`, adjacent to
  the other reasoning fields.
- `'ReasoningEffort'` in `ModelPresetFieldSchema:84`.

`ModelRuntimePreset`, `ManagedLlamaSettings` and the dashboard's
`DashboardModelRuntimePreset` (a direct alias, `dashboard/src/types.ts:17`) all derive
from these, so the type flows outward with no duplication.

### Storage and defaults

`src/config/defaults.ts:131` area gains `ReasoningEffort: 'xhigh'`.
`resolveManagedLlamaSettings` (`src/config/normalization.ts:498`) resolves it through a
`getReasoningEffort` helper modelled on `getManagedKvCacheQuantization:526`, falling back
to the default for a missing or unrecognized value.

No sqlite migration. The five stored presets omit the key; `resolveManagedLlamaSettings`
fills it from defaults on load. The unknown-field guard at `normalization.ts:446` rejects
*removed* fields, not added ones, so existing rows load unchanged.

### Request path

- `PresetRequestDefaultsSchema` and `buildPresetRequestDefaults`
  (`src/inference-presets/preset-compatibility.ts:17-46`) carry `reasoningEffort`.
- `PRESET_FIELD_SUPPORT.ReasoningEffort: 'both'` (`preset-compatibility.ts:114` area).
- `LlamaCppChatTemplateKwargs` (`src/llm-protocol/types.ts:64`) gains `reasoning_effort?`.
- `InferenceThinkingPolicy` (`src/llm-protocol/inference-backend.ts:10`) gains `effort`.
- `InferenceRequestBuilder` (`src/llm-protocol/inference-request-builder.ts:21-25`) emits
  `reasoning_effort` **only when `enable_thinking` is true**. The template ignores effort
  with thinking off (`jinja:54`), so emitting it there would be noise that also perturbs
  prompt-prefix reuse.
- `LlamaCppClient.buildChatRequest` (`src/llm-protocol/llama-cpp-client.ts:305-333`)
  passes `effort: defaults.reasoningEffort` into `thinking`.
- `applyThinkingSettings` (`src/status-server/routes/inference-passthrough.ts:74-83`)
  adds it to the kwargs object it replaces wholesale.

### Token accounting

Two call sites build a *reserve shape*, not a wire request. Because effort changes the
rendered system prompt, both must include it or their estimates and prefix-reuse
assumptions drift:

- `buildPlannerRequestPromptReserveText` (`src/repo-search/planner-protocol.ts:435-452`)
  already calls `buildPresetRequestDefaults`, so it reads `samplerDefaults.reasoningEffort`
  directly. No signature change; `PlannerThinkingFlags` stays as it is, since effort is
  preset-derived rather than per-request.
- `getProviderOverheadTokens` (`src/status-server/chat.ts:197-216`) gets a
  `resolveReasoningEffort(config)` helper beside `shouldPreserveThinking:249`.

### Host pass-through

`HostPresetSettings` (`src/config/host-sync.ts:23-25`) is the set of request-shaping
fields a host owns in pass-through mode. `ReasoningEffort` joins it and is copied at
`:65`, so a pass-through client renders the same prompt as its host.

### Dashboard

`dashboard/src/tabs/settings/ModelPresetsSection.tsx`, inside `group('reasoning', ...)`
at `:312-358`: a `<select>` directly below the Reasoning on/off select, rendered only
when `reasoningEnabled` (`:115`) — the same condition the Reasoning-content checkbox uses
at `:323`. Options `low`, `medium`, `xhigh`.

Supporting changes:

- `settings-action-groups.ts:90` area — `setReasoningEffort(value)` on the actions type.
- `useSettingsController.ts:300-364` — the action, dispatching `set-model-reasoning-effort`.
- `settings-draft-editor.ts:130` area — the action variant, its `apply` case, and
  `setModelReasoningEffort`. `setModelReasoning('off')` resets `ReasoningEffort` to
  `'xhigh'` alongside the existing resets at `:366-376`.
- `settings-sections.ts:148` area — a help-text descriptor for the `Reasoning effort`
  label, stating that `medium` injects no guidance and that models whose template ignores
  `reasoning_effort` are unaffected.
- `model-preset-groups.ts:37-39` — `summarizeReasoning` includes the effort.

## Failure modes

A stored value outside the enum normalizes to `xhigh` rather than throwing, matching
`KvCacheQuantization` and `SpeculativeType`. A backend or template that does not read
`reasoning_effort` ignores the extra kwarg, because Jinja templates guard their
variables with `is defined`; that is why the field is `'both'` rather than exl3-only.

The exhaustive `satisfies Record<ModelPresetField, ...>` maps —
`PRESET_FIELD_SUPPORT` (`preset-compatibility.ts:141`) and the matrix in
`tests/model-preset-adapters.test.ts:302` — fail to compile until the new field is
listed, so a partial migration cannot pass typecheck.

## Testing

- `tests/contracts-config.test.ts` — the enum accepts its three values, rejects `high`,
  and `ReasoningEffort` is in `ModelPresetFieldSchema`.
- `tests/config-normalization.test.ts` — a preset JSON without the key defaults to
  `xhigh`; a bogus value normalizes to `xhigh`; a valid value round-trips.
- `tests/model-preset-adapters.test.ts` — availability is `both`, and
  `buildPresetRequestDefaults` maps the field.
- `tests/inference-request-builder.test.ts` — `reasoning_effort` is emitted with
  thinking on, at each of the three levels, and omitted with thinking off.
- `tests/inference-passthrough-status-server.test.ts` — a caller's
  `chat_template_kwargs` is replaced by one carrying the preset's effort.
- `tests/host-sync.test.ts` — the field is overlaid from the host preset.
- `tests/settings-draft-editor.test.ts` — the setter writes the value; switching
  Reasoning to `off` resets it to `xhigh`.
- `tests/dashboard-model-presets-section.test.ts` — the select renders when reasoning is
  on and is absent when it is off.

## Out of scope

Renaming the stale `exl3-3-6-27b-2` preset id. Per-request effort overrides. Exposing
`high`. Any change to `ReasoningBudget`, which stays llama-only.

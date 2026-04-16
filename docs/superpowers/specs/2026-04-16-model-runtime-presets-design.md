# Model Runtime Presets Design

**Date:** 2026-04-16

**Goal:** Merge model selection and llama.cpp runtime tuning into one Settings page built around named presets, so operators can quickly switch between saved model/runtime combinations and apply them through the existing save then restart flow.

## Scope

- Replace the split model selection plus managed llama settings experience with one preset-driven editor.
- Store a custom editable name for each model/runtime preset.
- Let each preset carry:
  - model selection
  - llama.cpp launcher settings
  - llama.cpp runtime and sampling settings
- Keep preset changes in draft state until `Save Settings`.
- Keep backend application explicit: `Save Settings` first, then `Restart Backend`.

## Non-Goals

- No changes to prompt presets, preset family, tool policy, or chat/web execution presets.
- No automatic live switching when the selected model/runtime preset changes.
- No second override layer outside presets.
- No support for mixing a selected preset with separate raw manual model/runtime edits.

## Recommended Approach

Use a single `Model Presets` editor in Settings as the only editing surface for model and llama.cpp runtime configuration.

The page should expose:

- a preset dropdown
- `Add Preset`
- `Delete`
- editable preset name
- editable model field
- editable llama.cpp runtime fields

The selected preset is the draft source of truth for all model/runtime fields shown on the page. Saving copies the selected preset into the persisted active runtime config. Restart continues to use the saved active runtime config, not unsaved draft edits.

## Interaction Model

### Preset Selection

- The top control row shows the current preset selector and preset actions.
- The selector lists every model/runtime preset by custom label.
- Selecting a preset swaps the editor fields to that preset.
- Adding a preset clones the currently selected preset, assigns a unique id, and immediately selects it.
- Deleting a preset removes it and selects a valid fallback preset.
- Renaming a preset changes only its display label, not its stable id.

### Preset Editor

The selected preset editor contains the same model/runtime controls that are currently spread across separate areas.

The editor should include:

- `Preset name`
- `Model`
- `Executable path`
- `Base URL`
- `Bind host`
- `Port`
- `Model path (.gguf)`
- `NumCtx`
- `GpuLayers`
- `Threads`
- `Flash attention`
- `ParallelSlots`
- `BatchSize`
- `UBatchSize`
- `CacheRam`
- `KV cache quant`
- `MaxTokens`
- `Temperature`
- `TopP`
- `TopK`
- `MinP`
- `PresencePenalty`
- `RepetitionPenalty`
- `Reasoning`
- `ReasoningBudget`
- `ReasoningBudgetMessage`
- `StartupTimeoutMs`
- `HealthcheckTimeoutMs`
- `HealthcheckIntervalMs`
- `Managed llama verbose logging`

The separate manual model field should be removed from the general settings flow. Model selection belongs to the active model/runtime preset only.

## Save And Restart Behavior

- Switching presets only changes the draft selection and visible draft fields.
- Editing preset fields only mutates the draft config.
- `Save Settings` persists:
  - the preset library
  - the selected preset id
  - the active runtime fields mirrored from the selected preset
- `Restart Backend` uses the saved active runtime fields.
- If settings are dirty and the user clicks `Restart Backend`, keep the existing confirmation flow: save first or cancel.

This preserves the current explicit operator workflow:

1. choose or edit preset
2. save settings
3. restart backend

## Data Model

The current managed llama preset structure is already close to the needed shape and should remain the base storage model, but the UI should stop presenting it as a separate advanced launcher area.

The preset record should continue to carry:

- stable id
- editable label
- model-related fields
- llama.cpp launcher fields
- llama.cpp runtime fields

The config should continue to keep:

- preset library
- selected preset id
- mirrored active server/runtime values

On save, the selected preset should be copied into the persisted active runtime/server fields so existing backend code can continue to read one active configuration without resolving presets at runtime.

## Implementation Notes

- Reuse the existing managed preset add/select/delete helpers where possible.
- Extend preset syncing so preset selection also controls the saved runtime model field.
- Keep the diff minimal by reshaping the current `Managed llama.cpp` section into `Model Presets` rather than introducing a second preset system.
- Keep all types explicit in the dashboard config and helper functions.

## Testing

Add or update tests to cover:

- one preset editor is shown at a time
- selecting a preset swaps model/runtime values
- adding a preset clones the current preset and selects it
- deleting a preset selects a valid fallback
- renaming a preset updates the visible selector label
- saving mirrors the selected preset into active runtime config, including model
- unsaved preset changes do not affect restart until saved
- existing dirty-settings confirmation flow still guards restart and navigation

## Risks

- The current config mirrors active runtime fields outside the preset list, so save-time synchronization must stay explicit and centralized.
- If preset selection and active runtime mirroring happen in different places, the saved config can drift; one helper should own that mapping.
- Removing the old separate model field changes the mental model, so the section title and help text need to make the preset-driven flow obvious.

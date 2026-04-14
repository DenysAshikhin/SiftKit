# Presets Single-Editor Design

**Date:** 2026-04-14

**Goal:** Replace the current expanded preset-card list with a single selected-preset editor and make `Allowed tools` an explicit multi-select dropdown with toggleable tool options.

## Scope

- Change only the `Presets` settings section UI.
- Show one preset editor at a time.
- Add a preset selector at the top of the section.
- Keep add/delete actions in the presets section.
- Replace the read-only `Allowed tools` field with a toggleable dropdown menu.
- Preserve existing preset data shape and save flow.

## Non-Goals

- No preset schema changes.
- No backend API changes.
- No redesign of other settings sections.
- No separate preset list below the editor.
- No native multi-select `<select>` control.

## Recommended Approach

Keep the existing presets section and editing logic, but swap the repeated card list for:

- a top control row with:
  - preset selector
  - `Add Preset`
  - `Delete`
- one editor panel for the selected preset

Store the currently selected preset id in local component state. Resolve the active preset from `dashboardConfig.Presets`. If the selected id becomes invalid after add/delete/reload, automatically select a valid fallback preset.

## Interaction Model

### Preset Selection

- The selector lists all presets by label.
- The initial selection defaults to the first available preset.
- Changing the selector swaps the form fields to that preset only.
- Adding a preset creates it and immediately selects it.
- Deleting a preset removes it and selects the nearest remaining preset.
- Built-in presets remain non-deletable and keep the disabled `Delete` button.

### Editor Layout

The selected preset editor keeps the current fields:

- `Name`
- `Execution family`
- `CLI surface`
- `Web surface`
- `Description`
- `Prompt override`
- `Allowed tools`
- `Use for default summary`

The header metadata (`id`, family, builtin/custom`) stays visible for the selected preset only.

### Allowed Tools Dropdown

- Closed state shows the selected tool ids as a compact comma-separated summary.
- Opening the control reveals all supported tool options:
  - `find_text`
  - `read_lines`
  - `json_filter`
  - `run_repo_cmd`
- Each option is rendered with a checkbox.
- Toggling an option updates `preset.allowedTools` directly.
- The control remains available for the selected preset regardless of execution family.

## Family Change Behavior

Changing `Execution family` should keep the existing family-driven defaults for:

- `repoRootRequired`
- `maxTurns`
- `thinkingInterval`
- `thinkingEnabled`

`allowedTools` should still be seeded from the selected family defaults when the family changes, but after that the dropdown remains the editable source of truth for further tool toggles.

## State Rules

- Selection state is UI-only and should not persist to config.
- The editor should tolerate empty or missing preset arrays without crashing.
- `Use for default summary` remains mutually exclusive across presets.
- Surface toggles continue to update `surfaces` with explicit inclusion/removal of `cli` and `web`.

## Styling

- Reuse the existing preset card/editor styling where possible.
- Add minimal new styles for:
  - top selector/action row
  - dropdown trigger
  - dropdown menu
  - dropdown option list
- Keep the layout compact and avoid reintroducing long vertical preset stacks.

## Testing

Add or update frontend tests to cover:

- only one preset editor renders at a time
- changing the selector swaps visible preset data
- adding a preset selects the new preset
- deleting a selected custom preset selects a valid fallback
- deleting a built-in preset stays blocked
- opening the tools dropdown shows all supported tool options
- toggling tool options updates the selected preset state
- `Use for default summary` still clears the flag on other presets

## Risks

- Dropdown open/close handling can become brittle if implemented with document-level listeners; prefer a small local button/menu pattern.
- Selection fallback logic can drift if add/delete/reload paths are handled in different places; keep the fallback logic explicit and centralized.
- Family-change seeding must not silently undo later manual tool toggles except at the moment the family itself changes.

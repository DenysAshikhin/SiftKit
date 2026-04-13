# Settings Mockup Page Design

**Date:** 2026-04-13

**Goal:** Add an isolated dashboard mockup page at `/mockup` that uses the real settings labels and representative values, reorganized into a wider grouped layout with logical icons and styled hover help popovers.

## Scope

- Add a URL-only mockup page at `/mockup`.
- Keep the existing dashboard behavior at `/` unchanged.
- Make the mockup visual-only and isolated from live config loading and saving.
- Reuse the real current settings field names and representative current values.
- Group settings into clearer sections that use desktop width effectively.
- Add styled hover help UI for explanatory field popovers.

## Non-Goals

- No live API reads or writes.
- No persistence.
- No backend route changes.
- No production feature flag or long-term routing framework.
- No redesign of runs, metrics, or chat views.

## Recommended Approach

Use a client-side pathname switch inside the existing dashboard app. When `window.location.pathname === '/mockup'`, render a dedicated mockup page component instead of the normal dashboard tabs.

This is the smallest clean change because it:

- preserves the existing Vite setup
- avoids backend/static-server work
- keeps the mockup removable later
- avoids mixing the experiment into normal tab navigation

## Page Structure

The `/mockup` page should render inside the existing dashboard shell and reuse the visual language already present in the app.

### Layout

- Keep the existing top header.
- Replace the normal tabbed content area with a mockup workspace.
- Use a two-column layout:
  - left rail for section navigation and status summary
  - wide right pane for grouped settings cards
- Keep the layout responsive so narrower widths collapse naturally into a single-column flow.

### Left Rail

Show section anchors with logical icons and short summaries:

- `General`
- `Model Runtime`
- `Sampling`
- `Interactive`
- `Managed llama.cpp`

Each rail item should show:

- icon
- section name
- one-line description

This rail is visual-only and does not need scroll syncing or deep navigation behavior.

### Main Pane

Render grouped cards using the real settings labels and representative values copied from the existing settings page:

- `General`
  - `Version`
  - `Backend`
  - `Policy Mode`
  - `Raw log retention`
  - `Prompt prefix`
- `Model Runtime`
  - `Runtime model id`
  - `llama.cpp Base URL`
  - `Model path (.gguf)`
  - `NumCtx`
  - `MaxTokens`
  - `Threads`
  - `GpuLayers`
  - `Flash attention`
- `Sampling`
  - `Temperature`
  - `TopP`
  - `TopK`
  - `MinP`
  - `PresencePenalty`
  - `RepetitionPenalty`
  - `ParallelSlots`
  - `Reasoning`
- `Interactive`
  - `MinCharsForSummary`
  - `MinLinesForSummary`
  - `Interactive IdleTimeoutMs`
  - `MaxTranscriptChars`
  - `Wrapped commands`
  - `Interactive enabled`
  - `Interactive transcript retention`
- `Managed llama.cpp`
  - `Startup script path`
  - `Shutdown script path`
  - `StartupTimeoutMs`
  - `HealthcheckTimeoutMs`
  - `HealthcheckIntervalMs`
  - `Managed llama verbose logging`
  - `Additional llama.cpp args`

### Field Presentation

- Use denser multi-column grids for short numeric/text fields.
- Use full-width rows for long path/text values.
- Use visually distinct toggle rows for booleans.
- Show a visual-only action bar with disabled or inert `Reload` and `Save Settings` buttons to communicate intended structure without implying real behavior.

## Help Popovers

Add styled hover help triggers to selected field labels. These must be visual and explanatory, not browser-default titles.

Expected behavior:

- small help trigger next to the field label
- on hover or keyboard focus, show a styled popover
- popover explains what the setting controls and what tradeoff it affects
- popover should be readable on the current dark theme

Priority fields for help text:

- `NumCtx`
- `MaxTokens`
- `Threads`
- `GpuLayers`
- `Temperature`
- `TopP`
- `TopK`
- `MinP`
- `PresencePenalty`
- `RepetitionPenalty`
- `ParallelSlots`
- `Reasoning`
- `Wrapped commands`
- `Interactive IdleTimeoutMs`
- `HealthcheckTimeoutMs`
- `HealthcheckIntervalMs`

## Component Shape

Keep diffs minimal by extracting only the pieces that are necessary for readability.

Preferred split:

- small route/path helper in `App.tsx` or nearby
- dedicated mockup component file for the new page
- optional small data/constants helper for grouped section definitions if that keeps `App.tsx` concise
- style additions in the existing dashboard stylesheet

Avoid introducing a general routing library or a large component hierarchy.

## Styling Direction

- Reuse the dashboard’s existing dark background and card language.
- Make the mockup feel more deliberate than the current settings stack.
- Use icon badges, section cards, and stronger grouping.
- Use the available horizontal space instead of a narrow single-column form.
- Tooltip/popover styling should look native to the dashboard, not like browser defaults.

## Testing Strategy

Follow TDD.

### Required tests

- verify that `/mockup` path renders the mockup page instead of the normal settings tab view
- verify the mockup page exposes the expected grouped section structure
- verify help-popover metadata or trigger definitions exist for the documented tooltip fields if extracted into data helpers

Tests should stay narrow and avoid requiring browser automation if simple render/helper tests are sufficient.

## Risks

- `App.tsx` is already large, so mockup logic should not significantly increase inline complexity
- styles could drift into the existing settings view if selectors are not clearly scoped
- hover-only help can be inaccessible if focus styles are omitted

## Acceptance Criteria

- visiting `/mockup` shows the new isolated settings mockup page
- visiting `/` still shows the normal dashboard
- mockup page uses grouped sections and a left rail
- mockup page uses the real settings labels
- mockup page uses styled help popovers for selected fields
- no live config fetch/save happens on `/mockup`

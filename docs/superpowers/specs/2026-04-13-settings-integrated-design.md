# Integrated Settings Redesign

**Date:** 2026-04-13

**Goal:** Replace the current scrolling `Settings` tab with a fully integrated section-based editor that shows one section at a time, uses the real live config, adds styled help popovers, guards navigation with a save/discard modal, and exposes a backend restart action.

## Scope

- Replace the existing `Settings` tab UI.
- Keep the existing top-level dashboard tabs.
- Show only one settings section at a time.
- Use the real live config object and existing save flow.
- Add a pending-changes confirmation modal for section switches, tab changes, and page unload/navigation.
- Add a `Restart Backend` button to the settings action area.
- Add styled hover/focus help popovers to selected settings fields.

## Non-Goals

- No routing library.
- No full dashboard redesign outside the `Settings` tab.
- No multi-page wizard flow.
- No separate mockup route as the main experience.

## Recommended Approach

Keep the current `Settings` tab, but replace the long scrolling form with a section rail + single-section pane.

Use one shared draft config state for all settings. The visible pane changes based on the active section key. Before switching sections, leaving the tab, restarting the backend, or unloading the page, check for unsaved changes and require a modal decision.

## Interaction Model

- The existing `Settings` tab remains the entry point.
- The left rail lists:
  - `General`
  - `Model Runtime`
  - `Sampling`
  - `Interactive`
  - `Managed llama.cpp`
- Clicking a rail item instantly swaps the visible section pane.
- Only one section is visible at a time.
- The draft config spans all sections.

## Pending Changes Guard

If draft changes are pending, show a modal when the user:

- switches settings sections
- leaves the `Settings` tab
- reloads or navigates away from the page
- clicks `Restart Backend`

Modal actions:

- `Save` -> persist the full settings draft, then continue with the requested action
- `Discard` -> drop unsaved changes, then continue
- `Cancel` -> stay on the current section/tab/page and do nothing else

For browser unload/navigation, use the browser-supported confirmation mechanism where custom modal rendering is not possible, but reuse the same dirty-state logic as the in-app modal.

## Layout

Inside the `Settings` tab:

- left rail: section buttons with icon, title, short description
- right pane: one active section card only
- action bar in the pane:
  - `Reload`
  - `Save Settings`
  - `Restart Backend`
  - saved timestamp / busy state / inline status

The redesign should avoid vertical page-length scrolling. The visible section pane can internally scroll only if unavoidable on very small screens, but desktop layout should fit one section at a time.

## Section Content

### General

- `Version`
- `Backend`
- `Policy Mode`
- `Raw log retention`
- `Prompt prefix`

### Model Runtime

- `Runtime model id`
- `llama.cpp Base URL`
- `Model path (.gguf)`
- `NumCtx`
- `MaxTokens`
- `Threads`
- `Flash attention`

### Sampling

- `Temperature`
- `TopP`
- `TopK`
- `MinP`
- `PresencePenalty`
- `RepetitionPenalty`
- `ParallelSlots`
- `Reasoning`

### Interactive

- `MinCharsForSummary`
- `MinLinesForSummary`
- `Interactive IdleTimeoutMs`
- `MaxTranscriptChars`
- `Wrapped commands`
- `Interactive enabled`
- `Interactive transcript retention`

### Managed llama.cpp

- `Startup script path`
- `Shutdown script path`
- `StartupTimeoutMs`
- `HealthcheckTimeoutMs`
- `HealthcheckIntervalMs`
- `Managed llama verbose logging`
- `Additional llama.cpp args`

## Help Popovers

Add styled hover/focus help popovers for:

- `NumCtx`
- `MaxTokens`
- `Threads`
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

Popover requirements:

- keyboard-focus accessible
- visually integrated with the dark dashboard theme
- no browser-default title tooltip dependency

## Restart Backend

Add a `Restart Backend` button to the settings action bar.

Behavior:

- if no unsaved changes: restart immediately
- if unsaved changes exist: show the same save/discard/cancel modal
- on `Save`: save full config, then restart backend
- on `Discard`: restart without applying the draft
- on `Cancel`: abort

After successful restart:

- refresh backend health state
- refresh config state
- surface status via the existing toast/error model

Backend integration should reuse the existing managed llama lifecycle behavior wherever possible. If restart is unsupported for the current runtime mode, return a clear disabled state or error.

## Component Shape

Keep diffs minimal and explicit.

Preferred structure:

- `App.tsx` remains the integration point for state and effects
- extract settings section metadata into a typed helper
- extract section rendering helpers or a focused settings view component if that reduces `App.tsx` size
- add a small modal component/helper only if needed for clarity

Avoid dynamic function passing patterns and avoid adding a routing library.

## Testing Strategy

Follow TDD.

### Required coverage

- section metadata exposes the expected order and field grouping
- dirty-state navigation guard logic chooses modal behavior correctly
- tab/section switch logic keeps one active section at a time
- restart action path respects pending-change decisions
- build remains green

Prefer narrow unit-style tests around pure helpers/state transitions over brittle DOM-heavy tests unless a render-level test is required.

## Risks

- `App.tsx` is already large, so uncontrolled inline growth would hurt maintainability
- pending-change handling across tab switch + unload + restart can diverge if centralized poorly
- restart behavior can be misleading if backend capability is not checked clearly

## Acceptance Criteria

- current `Settings` tab is replaced by the new integrated section-based editor
- only one settings section is visible at a time
- real live config values are shown and edited
- switching sections with pending changes requires save/discard/cancel
- leaving the tab with pending changes requires save/discard/cancel
- reload/navigation away is guarded by dirty-state warning
- `Restart Backend` exists and follows the same pending-change decision flow
- styled help popovers work for the designated fields

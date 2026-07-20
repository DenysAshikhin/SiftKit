# SiftKit Dashboard — Rail UI Redesign

**Date:** 2026-07-20
**Status:** Approved direction (Rail), spec pending user review
**Visual reference:** `docs/mockups/rail-dashboard.html` (interactive mockup; the source of truth for look and layout)

## Goal

Replace the current dashboard shell and screen layouts with the "Rail" design: minimal chrome, all navigation always visible, dense information layout, and a settings experience that makes ~60 config fields scannable. No functionality is removed; this is a restructure and re-skin of the presentation layer.

## Non-goals

- No changes to the API layer (`api.ts`), controllers/hooks business logic, config schema, or server.
- No light theme. The dashboard stays dark-only.
- No new features beyond presentation (no command palette, no settings search).

## Decisions

1. **Navigation**: the hamburger menu and popover are deleted. A fixed 66px left icon rail shows all five sections (Logs, Metrics, Bench, Chat, Settings) with icon + label, active state, SiftKit logo mark on top, and a server-health dot at the bottom.
2. **Top bar**: 44px. Breadcrumb-style title (`SiftKit / <Section>`), right-aligned contextual actions (`Delete logs`, `⟳ Refresh`). The 2.7rem `<h1>` and "SiftKit Local Dashboard" wordmark are removed.
3. **Charts**: `recharts` becomes the chart library (new dependency in `dashboard/package.json`). `InteractiveGraph` is deleted and replaced by a reusable typed wrapper component that preserves current behavior: per-graph `storageId` series-visibility persistence (`metric-graph-persistence.ts`) and hover tooltips. No legacy fallback to the old SVG component.
4. **Chart palette** (validated for CVD + contrast on `#121a23`): Daily Runs → runs `#17997e`, completed `#3d8fd6`, failed `#d95f5f`; Token Usage → input `#3d8fd6`, output `#b8822e`. Legends always present; text in ink tokens, never series color.
5. **Design tokens** (replace current `:root` values in `global.css`):
   `--bg #0e141b`, `--panel #121a23`, `--panel2 #0b1118`, `--ink #dfe9f3`, `--dim #879bb0`, `--line #223040`, `--acc #2fbfa0`, `--ok #4fca8f`, `--bad #ef7d7d`, `--run #e6b566`. Glass blur, radial gradients, and pill color-per-kind noise are removed. Type: "Segoe UI"/system stack for UI, `ui-monospace` stack for values, ids, and code. Base font 0.85rem in dense panes.
6. **Status encoding**: colored 6px dot + text (`● completed`), replacing the double-chip (kind chip + status chip) rows. Kind appears as plain dim text.
7. **Old mockup route**: `/mockup` (`settings-mockup.tsx`, `settings-mockup-data.ts`, related CSS) is deleted. The new UI supersedes it; no compat kept.

## Screens

### Logs (RunsTab)

- Two panes: 292px list + flexible detail (current `panel-grid` 340px+1fr replaced).
- List tools: search input, one wrapping chip row combining type filters (All/Summary/Repo Search/Planner/Chat) and status filters (Done/Failed/Running). Chips are outline pills; active = accent border/text.
- Runs grouped under uppercase group headers with counts (`REPO SEARCH · 2`). Each row: title (ellipsized) + meta line `● status · duration · time`. Selected row: accent left border + raised background.
- Detail pane: title, mono meta line (id, kind, status, started, duration), Final Output card (accent-tinted border, markdown body), step/event cards as today (Simplified Flow / Raw Events toggle kept for repo-search runs).

### Metrics

- Grid of recharts cards (Daily Runs, Daily Token Usage, and remaining existing graphs — idle summaries, task runs series) plus the tool-metrics table with right-aligned tabular numerals.

### Benchmark

- Stat tiles row (last session, cases passed, prompt tok/s, generation tok/s) above the existing session list/detail content, restyled to the token system.

### Chat

- Session lane (240px): `+ New session`, session rows with state indicator — animated typing dots (streaming), spinner (tool running), red dot (failed), green dot (completed).
- Per-session header: preset selector + setting chips (web search, per-step thinking, simple flow) reflecting live per-session state; chips use accent when on.
- Transcript: user/assistant bubbles; tool calls render as inline cards with mono header (`tool_name · args · ✓ 1.1s · 8.2k tok loaded`) and collapsible output; running tool shows spinner + elapsed; thinking traces render as dim italic left-bordered lines.
- Streaming assistant text shows a blinking caret; Send flips to Stop while generating.
- Backend/restart failures render as an inline error banner with `Retry` and `Open logs` actions.
- Composer: thin context-usage bar (accent; amber ≥ 85%) + mono `used/total` label.
- All animations gated behind `prefers-reduced-motion`.

### Settings

- Layout: 190px section rail (General, Tool Policy, Presets, Interactive, Web Search, Model Presets) + content pane. Header row: section title, dirty pill (`N unsaved`), Reload, Restart backend, Save settings. Existing dirty-check/confirm-modal flow (`settings-flow.ts`) is unchanged.
- **General / Interactive / Web Search**: field grid (4-column, `full/half/quarter` spans mapped to `w4/w2/1`), label-over-value, inline dim hints replacing hover-only help when the help text is ≤ 60 characters; longer help stays as the existing hover popover. API keys masked with Show toggle (existing behavior, restyled).
- **Tool Policy**: replaced three duplicated per-mode checkbox lists with a single matrix table — rows = 23 tools grouped (Text & JSON, Repository, Object pipeline, Formatting, Web), columns = summary / read-only / full with checkboxes. Same underlying `OperationModeAllowedTools` updates.
- **Presets**: master-detail — preset list (label + kind/mode/origin badges, custom presets marked) with `+ Add preset`; editor card with name/kind/mode controls and the tool whitelist rendered as toggle chips. Tools blocked by the mode policy render struck-through and disabled, with an explanatory hint (uses existing `getEffectivePresetTools`).
- **Model Presets**: toolbar (preset selector + active pill, Add, Delete, llama.cpp/EXL3 segmented control) above six collapsible `<details>` group cards. Collapsed header shows a live mono summary of key values; open card shows a flat field grid (no per-field boxes). Groups and membership:

| Group | Fields | Summary example |
|---|---|---|
| Identity & launch | Preset name, Model, Executable path*, Model path (.gguf)*, Model directory (EXL3)†, External inference server, Base URL (+Test), Bind host, Port | `Qwen3.5-35B Q4_K_L · managed · 127.0.0.1:8097` |
| Memory & compute | NumCtx, GpuLayers*, Threads*, NcpuMoe*, Flash attention*, ParallelSlots, BatchSize*, UBatchSize, CacheRam*, KV cache quant | `ctx 128k · GPU 999 · batch 512/512 · KV f16` |
| Sampling | MaxTokens, Temperature, TopP, TopK, MinP, PresencePenalty, RepetitionPenalty | `temp 0.7 · top-p 0.8 · top-k 20 · max 15k` |
| Reasoning | Reasoning, Reasoning content, Preserve thinking, Maintain per step thinking, ReasoningBudget, ReasoningBudgetMessage | `off · per-step thinking on · budget 10k` |
| Speculative decoding | Enable, Speculative type, Combine with MTP*, ngram size/hit fields*, SpeculativeDraftMax/Min | `on · ngram-map-k · N12 M4` |
| Lifecycle & health | StartupTimeoutMs, HealthcheckTimeoutMs, HealthcheckIntervalMs, SleepIdleSeconds, Verbose logging | `startup 120s · probe 5s/1s · idle unload 600s` |

  `*` llama.cpp-only, `†` EXL3-only; visibility driven by the existing `getPresetFieldAvailability` compatibility helpers, matching current conditional logic (speculative sub-fields appear only for their selected type; EXL3 offers draft-mtp only). Identity & launch opens by default; open/collapsed state is component state, not persisted. Group summaries recompute from the draft preset and swap correctly when the backend toggles.

## Architecture

- `App.tsx`: shell rewrite (rail + topbar + view slots). Tab state, URL param sync, toasts, modals, and all controller wiring unchanged.
- New presentational components: `Rail`, `TopBar`, `StatusDot`, `FilterChips`, `ToolCallCard`, `MetricChart` (recharts wrapper), `SettingsFieldGrid`, `ToolPolicyMatrix`, `PresetLibrary`, `ModelPresetGroups` (with pure summary-builder functions per group). Reused across tabs; no dynamic function-passing beyond standard typed React props already in use.
- CSS: token overhaul in `global.css`; per-area styles rewritten in the existing split files (`layout.css`, `runs.css`, `metrics.css`, `chat.css`, `settings.css`). Old rules that no longer apply are deleted, not shadowed.
- Deleted: `settings-mockup.tsx`, `settings-mockup-data.ts`, `InteractiveGraph.tsx`, `dashboard-route.ts` mockup branch, related CSS blocks.

## Error handling

Unchanged flows (toasts, settings confirm modal, restart-failure modal) restyled to tokens. Chat backend failure banner is a restyle of the existing failure surface, adding no new error paths.

## Testing

- Existing hook tests (`dashboard/tests/hooks/*`) must stay green — controllers are untouched.
- New unit tests for pure helpers: model-preset group summary builders (llama + EXL3 variants), tool-policy matrix row derivation, context-bar warn threshold.
- Component tests (vitest + jsdom) for: rail navigation switching views, settings section switching preserving dirty state, EXL3 toggle hiding/showing backend-specific fields, chat session-state indicators, whitelist chip blocked-by-mode rendering.
- TDD: tests for each new component/helper written before implementation, per repo policy.

## Milestones (for the implementation plan)

1. Tokens + shell (rail, topbar) with all existing tab content rendering inside.
2. Logs restyle.
3. recharts wrapper + Metrics/Benchmark.
4. Chat states + transcript cards.
5. Settings: field grid + General/Interactive/Web Search.
6. Tool Policy matrix + Presets master-detail.
7. Model Presets collapsible groups.
8. Delete mockup route/legacy CSS, final sweep.

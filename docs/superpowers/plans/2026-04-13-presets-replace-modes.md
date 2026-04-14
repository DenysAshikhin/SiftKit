# Presets Replace Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hardcoded dashboard/CLI modes with configurable presets persisted in settings.

**Architecture:** Add a preset model to runtime config, store preset ids in chat sessions, bridge presets onto the existing execution families, and expose dynamic CLI preset discovery/execution. Keep diffs minimal by reusing existing summary/chat/plan/repo-search flows under a preset resolver layer.

**Tech Stack:** TypeScript, React dashboard, Node status server, SQLite-backed runtime config/session storage, node:test.

---

### Task 1: Add shared preset model and persistence

**Files:**
- Create: `src/presets.ts`
- Modify: `src/status-server/config-store.ts`
- Modify: `src/state/runtime-db.ts`
- Test: `tests/presets.test.ts`

- [ ] Add failing tests for builtin preset defaults, normalization, and surface filtering.
- [ ] Extend runtime config persistence with presets JSON.
- [ ] Expose helpers to resolve builtin presets, normalize preset arrays, and find presets by id.

### Task 2: Move session state from mode to preset id

**Files:**
- Modify: `src/state/chat-sessions.ts`
- Modify: `src/status-server/routes/chat.ts`
- Modify: `dashboard/src/types.ts`
- Test: `tests/chat-sessions-db.test.ts`

- [ ] Add failing tests for preset id persistence and old-mode fallback mapping.
- [ ] Add `preset_id` session storage with migration-safe fallback from legacy `mode`.
- [ ] Update session create/update/read flows to expose `presetId`.

### Task 3: Apply presets to execution families

**Files:**
- Modify: `src/status-server/chat.ts`
- Modify: `src/status-server/routes/chat.ts`
- Modify: `src/summary/types.ts`
- Modify: `src/summary/planner/mode.ts`
- Modify: `src/summary/planner/tools.ts`
- Modify: `src/repo-search/types.ts`
- Modify: `src/repo-search/execute.ts`
- Test: `tests/preset-execution.test.ts`

- [ ] Add failing tests for prompt override and tool allowlist behavior.
- [ ] Thread preset prompt/tool settings into summary, chat, plan, and repo-search flows.
- [ ] Reject tool use when a preset disallows the execution family’s tool set.

### Task 4: Replace dashboard mode UI with presets and add preset settings editor

**Files:**
- Modify: `dashboard/src/App.tsx`
- Modify: `dashboard/src/api.ts`
- Modify: `dashboard/src/types.ts`
- Modify: `dashboard/src/settings-sections.ts`
- Modify: `dashboard/src/styles.css`
- Test: `tests/settings-sections.test.ts`

- [ ] Add failing tests for preset settings metadata.
- [ ] Add a `Presets` settings section with editable preset fields.
- [ ] Replace `Chat / Plan / Repo Search` mode buttons with preset selection filtered by `web`.

### Task 5: Add dynamic CLI preset discovery and execution

**Files:**
- Modify: `src/cli/args.ts`
- Modify: `src/cli/dispatch.ts`
- Modify: `src/cli/help.ts`
- Create: `src/cli/run-preset.ts`
- Create: `src/cli/run-preset-list.ts`
- Test: `tests/cli-help.test.ts`
- Test: `tests/cli-preset.test.ts`

- [ ] Add failing tests for `preset list`, `run --preset`, and help discoverability.
- [ ] Add preset list and preset execution commands driven from runtime config.
- [ ] Keep internal execution routed through existing summary/chat/plan/repo-search handlers.

### Task 6: Verify and close out

**Files:**
- Modify: `package.json`

- [ ] Register new focused tests in `package.json`.
- [ ] Run focused preset/session/CLI/dashboard tests.
- [ ] Run `npm run build`.

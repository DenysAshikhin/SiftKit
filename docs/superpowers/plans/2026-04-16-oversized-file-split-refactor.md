# Oversized File Split Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the repo's oversized hand-written files into focused modules while preserving behavior and increasing reuse through shared helpers, components, and stateful repository/orchestration classes only where state ownership is real.

**Architecture:** Start with shared runtime test infrastructure because it unlocks smaller test files and lower-risk follow-on refactors. Then extract pure modules and small stateful boundaries from the status-server and repo-search backends. Finish by splitting the dashboard monolith into tab components, hooks, and CSS slices that mirror the UI domains.

**Tech Stack:** TypeScript, React, CSS, Node.js test runner, better-sqlite3

---

### Task 1: Runtime Test Helpers Split

**Files:**
- Create: `tests/helpers/runtime-constants.ts`
- Create: `tests/helpers/runtime-config.ts`
- Create: `tests/helpers/runtime-http.ts`
- Create: `tests/helpers/runtime-process.ts`
- Create: `tests/helpers/runtime-servers.ts`
- Modify: `tests/_runtime-helpers.ts`
- Test: `tests/runtime-status-server.test.ts`

- [ ] Add failing tests or characterization coverage around existing helper consumers.
- [ ] Extract constants/config/http/process/server helpers into focused modules.
- [ ] Keep `tests/_runtime-helpers.ts` as a compatibility barrel during migration.
- [ ] Run targeted runtime/status tests after each extraction slice.

### Task 2: Oversized Runtime Test File Split

**Files:**
- Create: `tests/runtime-status-server.lifecycle.test.ts`
- Create: `tests/runtime-status-server.requests.test.ts`
- Create: `tests/runtime-status-server.config.test.ts`
- Create: `tests/dashboard-status-server.runs.test.ts`
- Create: `tests/dashboard-status-server.metrics.test.ts`
- Create: `tests/dashboard-status-server.sse.test.ts`
- Create: `tests/runtime-planner-mode.tools.test.ts`
- Create: `tests/runtime-planner-mode.integration.test.ts`
- Create: `tests/repo-search-loop.safety.test.ts`
- Create: `tests/repo-search-loop.budget.test.ts`
- Create: `tests/repo-search-loop.finish.test.ts`
- Modify: `tests/runtime-status-server.test.ts`
- Modify: `tests/dashboard-status-server.test.ts`
- Modify: `tests/runtime-planner-mode.test.ts`
- Modify: `tests/mock-repo-search-loop.test.ts`

- [ ] Move tests by cohesive behavior group without changing assertions.
- [ ] Replace duplicate local helpers with shared helpers from Task 1.
- [ ] Keep suite names descriptive and focused.
- [ ] Run the affected test file after each move.

### Task 3: Dashboard Runs Backend Split

**Files:**
- Create: `src/status-server/dashboard-runs/types.ts`
- Create: `src/status-server/dashboard-runs/schema.ts`
- Create: `src/status-server/dashboard-runs/mapper.ts`
- Create: `src/status-server/dashboard-runs/metrics.ts`
- Create: `src/status-server/dashboard-runs/logging.ts`
- Create: `src/status-server/dashboard-runs/repository.ts`
- Modify: `src/status-server/dashboard-runs.ts`
- Test: `tests/dashboard-status-server*.test.ts`

- [ ] Add or keep failing/characterization coverage for persisted runs and metrics aggregation behavior.
- [ ] Extract pure mapping and metrics functions first.
- [ ] Introduce `DashboardRunsRepository` only for SQLite ownership.
- [ ] Leave `dashboard-runs.ts` as a thin compatibility entry while callers are migrated.

### Task 4: Repo Search Engine Split

**Files:**
- Create: `src/repo-search/engine/types.ts`
- Create: `src/repo-search/engine/command-runner.ts`
- Create: `src/repo-search/engine/read-overlap.ts`
- Create: `src/repo-search/engine/scorecard.ts`
- Create: `src/repo-search/engine/task-pack.ts`
- Modify: `src/repo-search/engine.ts`
- Test: `tests/mock-repo-search-loop*.test.ts`

- [ ] Add or keep failing/characterization coverage around loop completion, tool execution, and overlap tracking.
- [ ] Extract pure modules before any orchestration object.
- [ ] Introduce a session/runner class only if remaining state in `engine.ts` is still tangled after pure extractions.
- [ ] Run targeted repo-search tests after each extraction slice.

### Task 5: Dashboard App and CSS Split

**Files:**
- Create: `dashboard/src/app/AppShell.tsx`
- Create: `dashboard/src/tabs/RunsTab.tsx`
- Create: `dashboard/src/tabs/MetricsTab.tsx`
- Create: `dashboard/src/tabs/ChatTab.tsx`
- Create: `dashboard/src/tabs/SettingsTab.tsx`
- Create: `dashboard/src/components/InteractiveGraph.tsx`
- Create: `dashboard/src/hooks/useDashboardState.ts`
- Create: `dashboard/src/hooks/useChatState.ts`
- Create: `dashboard/src/hooks/useRunFilters.ts`
- Create: `dashboard/src/lib/format.ts`
- Create: `dashboard/src/lib/chat-steps.ts`
- Create: `dashboard/src/styles/theme.css`
- Create: `dashboard/src/styles/layout.css`
- Create: `dashboard/src/styles/runs.css`
- Create: `dashboard/src/styles/metrics.css`
- Create: `dashboard/src/styles/chat.css`
- Create: `dashboard/src/styles/settings.css`
- Modify: `dashboard/src/App.tsx`
- Modify: `dashboard/src/styles.css`

- [ ] Add characterization coverage for dashboard behavior before moving JSX or selectors.
- [ ] Extract pure formatting/helpers first, then hooks, then tab roots.
- [ ] Keep existing props/data flow stable while shrinking `App.tsx`.
- [ ] Convert `styles.css` into an import hub that mirrors the new tab/component boundaries.

### Task 6: Verification

**Files:**
- Modify: `docs/superpowers/plans/2026-04-16-oversized-file-split-refactor.md`

- [ ] Run targeted tests for each completed slice.
- [ ] Run dashboard build after frontend extraction.
- [ ] Re-check tracked files over 1500 lines and note any remaining follow-up work.

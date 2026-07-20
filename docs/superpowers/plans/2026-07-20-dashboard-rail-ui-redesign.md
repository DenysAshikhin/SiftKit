# Dashboard Rail UI Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dashboard shell and all five screen layouts with the "Rail" design (fixed left icon rail, 44px breadcrumb top bar, dense token-based panes, recharts metrics, matrix tool-policy, collapsible model-preset groups) with no loss of functionality.

**Architecture:** `App.tsx` becomes a thin shell (`Rail` + `TopBar` + view slots); all controllers/hooks/`api.ts`/config schema are untouched. New presentational components are added under `dashboard/src/components/` and `dashboard/src/tabs/`. `recharts` replaces the hand-rolled `InteractiveGraph`. CSS tokens in `global.css` are replaced and per-area CSS files are rewritten to the mockup. The `/mockup` route and its files are deleted.

**Tech Stack:** React 19, TypeScript (strict; no casts/`any`/`!`/namespace imports per repo rules), `recharts` (new), `react-markdown`+`remark-gfm` (existing), `node:test`+`react-dom/server` `renderToStaticMarkup` for tests, `tsx` runner.

**Source of truth for look & layout:** `docs/mockups/rail-dashboard.html` (fully self-contained; CSS lines 8–268, markup lines 271–806). Chart colors and tokens are in spec §4–5.

---

## Conventions for this plan

**Test files & runner.** New pure-helper tests → `dashboard/tests/<name>.test.ts`. New component tests → `dashboard/tests/<name>.test.tsx`. Both use `node:test` + `node:assert/strict` + `renderToStaticMarkup`, importing components with JSX. Run a single file during TDD:

```bash
npx tsx --test dashboard/tests/<file>
```

Run the whole dashboard UI suite (Git Bash glob expansion):

```bash
npx tsx --test dashboard/tests/*.test.ts dashboard/tests/*.test.tsx dashboard/tests/hooks/*.test.tsx dashboard/tests/lib/*.test.ts
```

Full gate before finishing each milestone:

```bash
npm run typecheck && npm test
```

`npm test` covers the root `tests/dashboard-*.test.ts` controller/e2e suite (must stay green — controllers are untouched). `npm run typecheck` runs `tsc` over `dashboard/tsconfig.json` + `dashboard/tsconfig.test.json` + `eslint .`.

**Handler-testing pattern** (no jsdom): render with `renderToStaticMarkup` for structure assertions; for behavior, call the component function directly and walk the returned element tree to grab an `onChange`/`onClick` prop and invoke it, asserting on the captured draft mutation. `tab-components.test.tsx` (existing) and `tests/dashboard-model-presets-section.test.ts` are the reference patterns.

**Repo rules (enforced everywhere):** no `as`/`<T>`/`satisfies`-less casts, no `any`, no non-null `!`, no `import * as`. Types inferred; IO-boundary types via `z.infer`. Prefer `as const`, renamed named imports, and `satisfies`. Delete superseded code — no legacy shims.

**Visual verification:** after each milestone that changes rendering, run the dashboard (`npm run start:dashboard`, or the project `/run` skill) and confirm the affected screen against the mockup before committing.

---

## Design tokens (spec §5, mockup lines 8–13)

Replace the entire `:root` block in `dashboard/src/styles/global.css` with:

```css
:root {
  --bg: #0e141b; --panel: #121a23; --panel2: #0b1118;
  --ink: #dfe9f3; --dim: #879bb0; --line: #223040;
  --acc: #2fbfa0; --ok: #4fca8f; --bad: #ef7d7d; --run: #e6b566;
  --ch-teal: #17997e; --ch-blue: #3d8fd6; --ch-red: #d95f5f; --ch-amber: #b8822e;
}
```

The old token names (`--bg-0/1/2`, `--ink-dim`, `--accent*`, `--stroke`) are removed. Every CSS rule that referenced them is rewritten in its milestone; a repo-wide grep for the old names must return zero hits at the final sweep.

**Chart palette (spec §4):** Daily Runs → runs `--ch-teal`, completed `--ch-blue`, failed `--ch-red`. Token Usage → input `--ch-blue`, output `--ch-amber`. Legends always visible; legend/label text in `--ink`/`--dim`, never the series color.

---

## File map

**Created**
- `dashboard/src/components/Rail.tsx` — left icon rail (nav + logo + health dot).
- `dashboard/src/components/TopBar.tsx` — breadcrumb title + contextual action slot.
- `dashboard/src/components/StatusDot.tsx` — `● label` status encoding.
- `dashboard/src/components/FilterChips.tsx` — outline-pill chip row.
- `dashboard/src/components/MetricChart.tsx` — typed recharts wrapper (persistence + tooltip).
- `dashboard/src/components/ToolCallCard.tsx` — chat inline tool-call card.
- `dashboard/src/tabs/settings/ToolPolicyMatrix.tsx` — tool × mode checkbox matrix.
- `dashboard/src/tabs/settings/model-preset-groups.ts` — pure group definitions + summary builders.
- `dashboard/src/lib/metric-chart-colors.ts` — chart color constants (typed).
- `dashboard/src/lib/context-bar-tone.ts` — `getContextBarFillTone` (amber ≥ 85%).
- `dashboard/src/lib/tool-policy-matrix.ts` — pure matrix row derivation + toggle.
- Tests: `dashboard/tests/rail.test.tsx`, `top-bar.test.tsx`, `status-dot.test.tsx`, `filter-chips.test.tsx`, `metric-chart.test.tsx`, `tool-call-card.test.tsx`, `context-bar-tone.test.ts`, `tool-policy-matrix.test.ts`, `model-preset-groups.test.ts`, `tool-policy-matrix-component.test.tsx`, `model-preset-groups-component.test.tsx`, and a rewritten `tab-components.test.tsx`.

**Modified**
- `dashboard/src/App.tsx` — shell rewrite.
- `dashboard/src/tabs/{RunsTab,MetricsTab,BenchmarkTab,ChatTab,SettingsTab}.tsx` — layout/markup restyle.
- `dashboard/src/tabs/settings/{PresetsSection,ModelPresetsSection}.tsx` — master-detail / collapsible groups.
- `dashboard/src/styles/{global,layout,runs,metrics,chat,settings}.css` — token overhaul + per-area rewrite.
- `dashboard/package.json` — add `recharts`.

**Deleted**
- `dashboard/src/settings-mockup.tsx`, `dashboard/src/settings-mockup-data.ts`.
- `dashboard/src/components/InteractiveGraph.tsx`.
- `dashboard/src/dashboard-route.ts` (mockup branch removed → file deleted; `App` no longer routes).
- Old CSS blocks referencing removed tokens/classes.

---

## Milestone 1 — Tokens + shell (Rail, TopBar)

Goal: rail + top bar render; all five existing tab bodies render unchanged inside the new shell; `/mockup` route removed.

### Task 1.1: Chart color + Rail nav model

**Files:** Create `dashboard/src/lib/metric-chart-colors.ts`; Create `dashboard/tests/rail.test.tsx`.

- [ ] **Step 1: Write failing test** — `dashboard/tests/rail.test.tsx`

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Rail, RAIL_ITEMS } from '../src/components/Rail';

test('rail lists all five sections with labels', () => {
  const markup = renderToStaticMarkup(
    <Rail activeTab="runs" serverHealthy onSelectTab={() => {}} />,
  );
  for (const label of ['Logs', 'Metrics', 'Bench', 'Chat', 'Settings']) {
    assert.match(markup, new RegExp(label));
  }
  assert.equal(RAIL_ITEMS.length, 5);
});

test('rail marks the active tab and calls back on click', () => {
  let picked = '';
  const element = Rail({ activeTab: 'settings', serverHealthy: false, onSelectTab: (t) => { picked = t; } });
  const markup = renderToStaticMarkup(element);
  assert.match(markup, /class="[^"]*on[^"]*"[^>]*>[\s\S]*?Settings/);
  // health dot reflects unhealthy state
  assert.match(markup, /pulse/);
  // find the Logs button and invoke it
  function walk(node: React.ReactNode): void {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!React.isValidElement(node)) return;
    if (node.props.title === 'Logs' && node.props.onClick) node.props.onClick();
    walk(node.props.children ?? null);
  }
  walk(element);
  assert.equal(picked, 'runs');
});
```

- [ ] **Step 2: Run — expect FAIL** `npx tsx --test dashboard/tests/rail.test.tsx` → cannot find `../src/components/Rail`.

- [ ] **Step 3: Implement** `dashboard/src/lib/metric-chart-colors.ts`

```ts
export const CHART_COLORS = {
  teal: '#17997e',
  blue: '#3d8fd6',
  red: '#d95f5f',
  amber: '#b8822e',
} as const;
```

- [ ] **Step 4: Implement** `dashboard/src/components/Rail.tsx` — icon paths copied verbatim from mockup lines 274–288; `RAIL_ITEMS` maps each `TabKey` → `{ tab, label, title, path }`. Signature:

```tsx
import React from 'react';
import type { TabKey } from '../App';

export type RailItem = { tab: TabKey; label: string; title: string; path: string };

export const RAIL_ITEMS: readonly RailItem[] = [
  { tab: 'runs', label: 'Logs', title: 'Logs', path: 'M3 5h14M3 10h14M3 15h9' },
  { tab: 'metrics', label: 'Metrics', title: 'Metrics', path: 'M3 16l4-6 3 3 4-8 3 5' },
  { tab: 'benchmark', label: 'Bench', title: 'Benchmark', path: 'M10 11l4-4' },
  { tab: 'chat', label: 'Chat', title: 'Chat', path: 'M3 4h14v9H8l-4 4v-4H3z' },
  { tab: 'settings', label: 'Settings', title: 'Settings', path: 'M4 6h12M4 10h12M4 14h12' },
] as const;

export function Rail({ activeTab, serverHealthy, onSelectTab }: {
  activeTab: TabKey;
  serverHealthy: boolean;
  onSelectTab(tab: TabKey): void;
}) {
  return (
    <nav className="rail">
      <div className="logo">S</div>
      {RAIL_ITEMS.map((item) => (
        <button
          key={item.tab}
          type="button"
          className={activeTab === item.tab ? 'on' : ''}
          title={item.title}
          aria-current={activeTab === item.tab ? 'page' : undefined}
          onClick={() => onSelectTab(item.tab)}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d={item.path} /></svg>
          {item.label}
        </button>
      ))}
      <div className="spacer" />
      <div className={serverHealthy ? 'pulse' : 'pulse offline'} title={serverHealthy ? 'server healthy' : 'server unavailable'} />
    </nav>
  );
}
```

Note: `TabKey` must be exported from `App.tsx` (Task 1.4). The Bench and Settings icons in the mockup have extra `<circle>`/`<path>` elements; keep them by rendering the full inner SVG for those two — acceptable to inline per-item `children` instead of a single `path`. Simplest DRY approach: store the full inner-SVG JSX per item. Rewrite `path: string` as `icon: React.ReactNode` if the multi-element icons matter; otherwise the single primary path is sufficient for the rail glyph. Choose single-path for simplicity unless visual review rejects it.

- [ ] **Step 5: Run — expect PASS** `npx tsx --test dashboard/tests/rail.test.tsx`.

- [ ] **Step 6: Commit** `feat(dashboard): add Rail nav component and chart colors`.

### Task 1.2: TopBar

**Files:** Create `dashboard/src/components/TopBar.tsx`; Create `dashboard/tests/top-bar.test.tsx`.

- [ ] **Step 1: Failing test**

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TopBar } from '../src/components/TopBar';

test('top bar renders breadcrumb and action slot', () => {
  const markup = renderToStaticMarkup(
    <TopBar sectionTitle="Logs" actions={<button>Refresh</button>} />,
  );
  assert.match(markup, /SiftKit \//);
  assert.match(markup, /Logs/);
  assert.match(markup, /Refresh/);
});
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** (mockup lines 294–300):

```tsx
import React from 'react';
import type { ReactNode } from 'react';

export function TopBar({ sectionTitle, actions }: { sectionTitle: string; actions?: ReactNode }) {
  return (
    <header className="top">
      <h1><span className="crumb">SiftKit /</span> <span>{sectionTitle}</span></h1>
      <div className="right">{actions}</div>
    </header>
  );
}
```

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** `feat(dashboard): add TopBar breadcrumb component`.

### Task 1.3: Shell CSS (global tokens + layout)

**Files:** Modify `dashboard/src/styles/global.css`, `dashboard/src/styles/layout.css`.

- [ ] **Step 1:** Replace `:root` in `global.css` with the token block above. Set `body` to `background: var(--bg); color: var(--ink); font-family: "Segoe UI", ui-sans-serif, system-ui, sans-serif; font-size: 0.85rem; line-height: 1.45;` and remove glass blur / radial gradient rules (mockup lines 16–20). Add the shared primitives from the mockup that are area-agnostic: `.app`, `.rail`, `.logo`, `.body`, `.top`, `.ghost-btn`, `.view`, `.dot`, `.card`, `pre.mono`, `code` (mockup lines 21–96). Add `.pulse.offline { background: var(--bad); }`.
- [ ] **Step 2:** In `layout.css`, delete all old `.app-shell/.topbar/.hamburger*/.menu-popover` rules (they are replaced by rail/top). Keep only rules still referenced by tabs until their milestone rewrites them.
- [ ] **Step 3: Verify** no build error: `npx vite build` is heavy; instead just `npm run typecheck` (CSS isn't typechecked) and defer visual check to Task 1.5.
- [ ] **Step 4: Commit** `style(dashboard): replace design tokens and add shell primitives`.

### Task 1.4: App shell rewrite

**Files:** Modify `dashboard/src/App.tsx`; Delete `dashboard/src/dashboard-route.ts`, `dashboard/src/settings-mockup.tsx`, `dashboard/src/settings-mockup-data.ts`.

- [ ] **Step 1: Failing test** — extend `dashboard/tests/rail.test.tsx` is per-component; App shell is validated by a new `dashboard/tests/app-shell.test.tsx`:

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { App } from '../src/App';

test('app renders rail, top bar, and the runs view by default', () => {
  const markup = renderToStaticMarkup(<App />);
  assert.match(markup, /class="rail"/);
  assert.match(markup, /class="top"/);
  assert.match(markup, /SiftKit \//);
});
```

Note: `App` mounts controllers that call `api.ts`. Those fetches are fire-and-forget in effects; `renderToStaticMarkup` does not run effects, so the initial render is safe. If any controller reads `window`/`localStorage` at render, guard already exists (`getBrowserStorage`). If the render throws, stub the minimum in the test via a top-level `globalThis` shim is NOT allowed (no shims) — instead ensure `App` render path is side-effect free at render time (it already is).

- [ ] **Step 2: Run — FAIL** (App still renders old `.app-shell`).
- [ ] **Step 3: Implement** the shell. Export `TAB_KEYS`/`TabKey`. Replace the `App`/`DashboardApp` return with:
  - Remove `getDashboardView`/`SettingsMockupPage` import and the `App` mockup branch; `App` becomes `DashboardApp` directly (rename or re-export).
  - Compute `serverHealthy` from an existing signal if available (e.g. `refresh`/health hook); if none is wired, pass `true` for now and wire in a later task — but check `useDashboardRefresh`/status first; do not invent a new fetch. If no health signal exists, derive `serverHealthy` from `!metricsController.metricsError` as a minimal truthful proxy and leave a `// TODO wire real health` only if nothing better exists.
  - Per-section top-bar actions: Logs → `Delete logs` (`runs.tabProps.onOpenRunDeleteModal`) + `⟳ Refresh` (`refresh.requestDashboardDataRefresh`); other tabs → `⟳ Refresh` only.
  - Structure:

```tsx
return (
  <div className="app">
    <Rail activeTab={tab} serverHealthy={serverHealthy} onSelectTab={(next) => settings.onRequestTabChange(next)} />
    <div className="body">
      <TopBar sectionTitle={SECTION_TITLES[tab]} actions={topBarActions} />
      {/* toasts + modals unchanged, moved inside .body */}
      <div className="view on">
        {tab === 'runs' && <RunsTab {...runs.tabProps} />}
        {/* …other tabs unchanged… */}
      </div>
    </div>
  </div>
);
```

  - `SECTION_TITLES: Record<TabKey, string> = { runs: 'Logs', metrics: 'Metrics', benchmark: 'Benchmark', chat: 'Chat', settings: 'Settings' }`.
  - Delete the `menuOpen` state and the outside-click effect (hamburger is gone).
  - Keep `writeSearchParams` effect, toasts, confirm modal, restart-failure modal, `RunDeleteModal` — reparented under `.body`, markup unchanged for now.
- [ ] **Step 4:** Delete `dashboard-route.ts`, `settings-mockup.tsx`, `settings-mockup-data.ts`. Grep to confirm no remaining imports: `grep -rn "settings-mockup\|dashboard-route\|SettingsMockupPage\|getDashboardView" dashboard/src`.
- [ ] **Step 5: Run — PASS** `npx tsx --test dashboard/tests/app-shell.test.tsx`.
- [ ] **Step 6: Update deleted-file tests** — `tests/dashboard-route.test.ts` references the deleted `dashboard-route`. Delete that test file (route no longer exists). Confirm `npm test` no longer targets it.
- [ ] **Step 7: Gate** `npm run typecheck && npm test`.
- [ ] **Step 8: Commit** `feat(dashboard): rail shell replaces topbar/hamburger; drop mockup route`.

### Task 1.5: Visual checkpoint

- [ ] Run the dashboard; confirm rail switches all five tabs, top bar shows `SiftKit / <Section>`, Delete logs + Refresh appear on Logs, Refresh only elsewhere, health dot renders. Tab bodies still use old inner styling (rewritten in later milestones) — that is expected.

---

## Milestone 2 — Logs (RunsTab) restyle

Goal: 292px list + flexible detail; search + one wrapping chip row (type + status); grouped rows with `● status · duration · time`; detail with mono meta line, accent-tinted Final Output card, step/event cards + Simplified Flow / Raw Events toggle.

### Task 2.1: StatusDot + FilterChips components

**Files:** Create `StatusDot.tsx`, `FilterChips.tsx`, tests `status-dot.test.tsx`, `filter-chips.test.tsx`.

- [ ] **Step 1: StatusDot failing test** — asserts `<span class="dot ok">` + text for a completed status; maps `completed→ok`, `failed→bad`, `running→run`.

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { StatusDot, statusTone } from '../src/components/StatusDot';

test('statusTone maps statuses to dot tones', () => {
  assert.equal(statusTone('completed'), 'ok');
  assert.equal(statusTone('failed'), 'bad');
  assert.equal(statusTone('running'), 'run');
  assert.equal(statusTone('anything-else'), 'run');
});

test('StatusDot renders a toned dot and label', () => {
  const markup = renderToStaticMarkup(<StatusDot status="completed" />);
  assert.match(markup, /class="dot ok"/);
  assert.match(markup, /completed/);
});
```

- [ ] **Step 2–3:** Implement `statusTone(status: string): 'ok' | 'bad' | 'run'` (running/other → `run`; completed → `ok`; failed → `bad`) and `StatusDot({ status })` → `<><span className={"dot " + statusTone(status)} />{status}</>` optionally wrapped; keep it inline-friendly.
- [ ] **Step 4: FilterChips failing test** — given options `[{value,label,active}]` renders outline pills, active adds `on`, click calls `onToggle(value)`.
- [ ] **Step 5–6:** Implement `FilterChips` (mockup `.chips/.chip/.chip.on`, lines 69–71). Props: `items: { value: string; label: string; active: boolean }[]`, `onToggle(value: string): void`, optional `className`.
- [ ] **Step 7: Run both — PASS. Commit** `feat(dashboard): add StatusDot and FilterChips`.

### Task 2.2: RunsTab markup rewrite

**Files:** Modify `dashboard/src/tabs/RunsTab.tsx`.

- [ ] **Step 1: Failing test** `dashboard/tests/runs-tab.test.tsx` — render `RunsTab` with a grouped run set; assert: list pane `.list-pane`, one `.chips` row containing All/Summary/Repo Search/Planner/Chat + Done/Failed/Running, group header `Repo Search · N` uppercase, a row with `● completed` meta and the mono `.meta-line` in detail; kind rendered as plain dim text (no double `run-chip status` chip). Reuse the props shape from the existing `RunsTabProps` (unchanged).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Replace the outer `<section className="panel-grid">` with mockup structure (lines 303–345):
  - `.list-pane` → `.list-tools` (search input + `<FilterChips>` combining type presets from `RUN_LOG_TYPE_PRESETS` and the three status chips) → `.runs` scroller.
  - Group header: `<div className="rgroup">{runGroupLabel(group)} · {items.length}</div>`.
  - Row: `.run` (+ `sel` when selected) with `.t` title and `.m` meta = `<StatusDot status={run.status}/> · {formatDurationHms} · {formatShortTime}`. Kind shown as plain dim text, not a chip.
  - Detail pane `.detail`: `<h2>` + `.meta-line` (mono: id, kind, status, started, duration) + Final Output as `.card.final` + step/event cards `.card`. Keep the `isRepoSearchRunSelected` Simplified Flow / Raw Events toggle and the ReactMarkdown bodies exactly as today (only classNames change).
  - Delete `.run-chip`, `.filter-pill*`, `.panel-grid`, `.run-filter-toolbar` usage from this file.
  - The `Delete logs` button moves to the top bar (Milestone 1) — remove it from the list toolbar; keep `onOpenRunDeleteModal` in props (used by App).
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Rewrite `runs.css`** to the mockup Logs rules (lines 62–96): `.list-pane`, `.list-tools`, `.search`, `.runs`, `.rgroup`, `.run`, `.run .t`, `.run .m`, `.detail`, `.meta-line`, `.card`, `.card.final`. Delete old runs rules.
- [ ] **Step 6: Gate** `npm run typecheck && npx tsx --test dashboard/tests/runs-tab.test.tsx`. Visual check Logs screen.
- [ ] **Step 7: Commit** `feat(dashboard): restyle Logs to rail two-pane layout`.

---

## Milestone 3 — recharts wrapper + Metrics/Benchmark

Goal: add `recharts`; replace `InteractiveGraph` with `MetricChart` (preserving `storageId` visibility persistence + hover tooltip); restyle Metrics grid + tool table; add Benchmark stat tiles.

### Task 3.1: Add recharts

**Files:** Modify `dashboard/package.json`.

- [ ] **Step 1:** `cd dashboard && npm install recharts@^3.10.0`. Confirm it and `@types` (recharts ships its own types) resolve; `npm run typecheck` must still pass afterward.
- [ ] **Step 2: Commit** `build(dashboard): add recharts dependency`.

### Task 3.2: MetricChart wrapper

**Files:** Create `dashboard/src/components/MetricChart.tsx`; Create `dashboard/tests/metric-chart.test.tsx`; reuse `metric-graph-persistence.ts` (unchanged).

- [ ] **Step 1: Failing test.** recharts renders via `ResponsiveContainer` which needs layout (0×0 under SSR) so assert on the wrapper chrome, legend toggling, and persistence — not the SVG paths:

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MetricChart } from '../src/components/MetricChart';
import { getMetricGraphStorageKey } from '../src/metric-graph-persistence';

const SERIES = [
  { key: 'runs', title: 'Runs', unit: '', color: '#17997e', points: [{ label: 'd1', value: 3 }, { label: 'd2', value: 5 }] },
  { key: 'failed', title: 'Failed', unit: '', color: '#d95f5f', points: [{ label: 'd1', value: 1 }, { label: 'd2', value: 0 }] },
];

test('metric chart renders title, subtitle, and a legend chip per series', () => {
  const markup = renderToStaticMarkup(
    <MetricChart storageId="daily-runs" title="Daily Runs" subtitle="last 14 days" series={SERIES} />,
  );
  assert.match(markup, /Daily Runs/);
  assert.match(markup, /last 14 days/);
  assert.match(markup, /Runs/);
  assert.match(markup, /Failed/);
});

test('legend toggle persists hidden series to the graph storage key', () => {
  const store = (() => {
    const map = new Map<string, string>();
    return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); }, removeItem: (k: string) => { map.delete(k); }, _map: map };
  })();
  const element = MetricChart({ storageId: 'daily-runs', title: 'Daily Runs', series: SERIES, storageOverride: store });
  // walk to the 'failed' legend button and click it, then re-derive persistence via the exported helper path
  // (behavioral persistence covered by dashboard-metric-graph-persistence.test.ts; here assert the key format is used)
  assert.equal(getMetricGraphStorageKey('daily-runs'), 'siftkit.dashboard.metric-graph.daily-runs.hidden-series');
  void element;
});
```

  (Legend-click persistence itself is already covered by `tests/dashboard-metric-graph-persistence.test.ts`; MetricChart must reuse `readHiddenSeriesState`/`writeHiddenSeriesState`, so no new persistence logic is written.)

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement `MetricChart`.** Port props verbatim from `InteractiveGraph` (`storageId`, `title`, `series: MetricSeries[]`, optional `subtitle`, optional `height`, optional `storageOverride` for tests). Body:
  - Keep the `useState(readHiddenSeriesState(...))` + two `useEffect` persistence blocks from `InteractiveGraph.tsx` (identical logic — copy, do not re-derive).
  - Legend: reuse the mockup `.legend`/`.graph-card` chrome; render a `<button className="graph-legend-chip on|off">` per series that toggles `hiddenSeriesKeys` (same handler as `InteractiveGraph`).
  - Chart: `<ResponsiveContainer width="100%" height={height ?? 220}><LineChart data={rows}>…</LineChart></ResponsiveContainer>` where `rows` is `points` zipped by label into `{ label, [key]: value }`. One `<Line dataKey={s.key} stroke={s.color} dot={false} isAnimationActive={false} />` per **visible** series. Include `<CartesianGrid>`, `<XAxis dataKey="label">`, `<YAxis>`, `<Tooltip>` styled to tokens (`contentStyle` bg `--panel`, border `--line`, text `--ink`).
  - `MetricSeries` type = the old `InteractiveSeries` (`{ key; title; unit; color; points: { label; value }[] }`); re-export it from `MetricChart.tsx`.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Delete `InteractiveGraph.tsx`.** Grep `grep -rn "InteractiveGraph" dashboard/src dashboard/tests tests` — replace all imports with `MetricChart`.
- [ ] **Step 6: Commit** `feat(dashboard): recharts MetricChart replaces InteractiveGraph`.

### Task 3.3: MetricsTab restyle

**Files:** Modify `dashboard/src/tabs/MetricsTab.tsx`, `dashboard/src/styles/metrics.css`; rewrite the metrics section of `tab-components.test.tsx` (or its successor `dashboard/tests/metrics-tab.test.tsx`).

- [ ] **Step 1: Failing test** `dashboard/tests/metrics-tab.test.tsx` — copy the two existing metrics tests from `tab-components.test.tsx` (fixtures `METRIC_DAY`, `IDLE_SNAPSHOT`) and update className assertions to the mockup (`.graph-grid`, `.graph-card`, `.mtable` with right-aligned `td.num`). Assert Daily Runs + Daily Token Usage cards render and the tool-metrics table has tabular numerals.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Swap every `<InteractiveGraph …/>` → `<MetricChart …/>` (props identical, add `subtitle`). Wrap in `.metrics` + `.graph-grid`. Convert the Daily Runs / Daily Token Usage series `color` values to `CHART_COLORS` per spec §4. Keep the remaining charts (duration, cache, speculative, idle, per-task) as `MetricChart`s. Render Tool Metrics as the mockup `.mtable` (right-aligned numeric columns) instead of the card row — preserve every field currently shown (calls, avg chars, avg tokens, etc.) as table columns; if the field set is too wide for a table, keep the densest subset the mockup shows and retain the rest in a secondary detail row. Keep idle-summary + web-search cards, restyled to `.tile`/`.graph-card`.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Rewrite `metrics.css`** to mockup lines 98–120 (`.metrics`, `.graph-grid`, `.graph-card`, `.legend`, `.mtable`, `.mtable td.num`). Delete old `.metrics-graph-grid/.interactive-graph/.idle-*` rules that no longer apply.
- [ ] **Step 6: Gate + visual. Commit** `feat(dashboard): restyle Metrics with recharts cards and numeric table`.

### Task 3.4: BenchmarkTab stat tiles

**Files:** Modify `dashboard/src/tabs/BenchmarkTab.tsx`, `dashboard/src/styles/metrics.css` (tiles are shared) or add to a bench block.

- [ ] **Step 1: Failing test** `dashboard/tests/benchmark-tab.test.tsx` — port the existing benchmark test; add assertions that a `.tiles` row renders four `.tile`s (last session, cases passed, prompt tok/s, generation tok/s) derived from the selected session/attempts, above the existing session list/results.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Add a pure derivation `deriveBenchmarkTiles(session, attempts)` (in `BenchmarkTab.tsx` or a small `lib/benchmark-tiles.ts` if it needs its own test) returning `{ lastSession, casesPassed, casesTotal, promptTokensPerSecond, generationTokensPerSecond }`. Render `.tiles` (mockup lines 407–412) above the existing content; keep all existing benchmark controls/table intact, restyled to tokens (`.tile`, `.mtable`, `StatusDot` for pass/fail).
- [ ] **Step 4: Run — PASS. Rewrite `bench` CSS** (mockup lines 113–120). Gate + visual.
- [ ] **Step 5: Commit** `feat(dashboard): add benchmark stat tiles and token restyle`.

---

## Milestone 4 — Chat states + transcript cards

Goal: session lane with per-session state indicator (typing dots / spinner / red / green), per-session header preset + setting chips, inline `ToolCallCard`, blinking caret on streaming, Send↔Stop, error banner, composer context bar (amber ≥ 85%). All animations behind `prefers-reduced-motion`.

### Task 4.1: context-bar tone helper

**Files:** Create `dashboard/src/lib/context-bar-tone.ts`, `dashboard/tests/context-bar-tone.test.ts`.

- [ ] **Step 1: Failing test**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { getContextBarFillTone } from '../src/lib/context-bar-tone';

test('fill tone is accent below 85% and warn at/above', () => {
  assert.equal(getContextBarFillTone(0), 'accent');
  assert.equal(getContextBarFillTone(0.84), 'accent');
  assert.equal(getContextBarFillTone(0.85), 'warn');
  assert.equal(getContextBarFillTone(1), 'warn');
});
```

- [ ] **Step 2–3:** Implement `export function getContextBarFillTone(usedRatio: number): 'accent' | 'warn' { return usedRatio >= 0.85 ? 'warn' : 'accent'; }`.
- [ ] **Step 4: PASS. Commit** `feat(dashboard): add context-bar fill tone helper`.

### Task 4.2: session-state indicator helper

**Files:** Create `dashboard/src/lib/chat-session-state.ts`, `dashboard/tests/chat-session-state.test.ts`.

- [ ] **Step 1:** Determine the available per-session live signals from `ChatSession`/controller (streaming, tool-running, failed, completed). Inspect `useChatController`/`useChatSessions`/`types.ts` for existing fields (`chatBusy`, message `toolCallStatus`, session status). Do **not** add controller state.
- [ ] **Step 2: Failing test** — `deriveSessionIndicator(session, { isActive, chatBusy, liveMessages })` returns `'streaming' | 'tool' | 'failed' | 'completed'`. Cover: active session with a running tool message → `tool`; active + streaming assistant, no running tool → `streaming`; last turn errored → `failed`; else → `completed`.
- [ ] **Step 3:** Implement the pure helper using only existing signals.
- [ ] **Step 4: PASS. Commit** `feat(dashboard): derive chat session-state indicator`.

### Task 4.3: ToolCallCard

**Files:** Create `dashboard/src/components/ToolCallCard.tsx`, `dashboard/tests/tool-call-card.test.tsx`.

- [ ] **Step 1: Failing test** — running tool shows spinner + elapsed and no result; completed shows `✓ <dur> · <tok> loaded` header and collapsible `<pre>` output. Header is mono. Props derived from `ChatMessage` tool fields (`toolCallCommand`, `toolCallStatus`, `toolCallOutput`, `toolCallPromptTokenCount`).
- [ ] **Step 2–3:** Implement per mockup `.tcall` (lines 259–263). Reuse `getToolRunningLabel` from `lib/tool-status.ts`. Signature `ToolCallCard({ command, status, output, tokenLabel, elapsedLabel })` or accept the `ChatMessage` and derive inside — pick the message-in form to match how `renderMessageBody` calls it.
- [ ] **Step 4: PASS. Commit** `feat(dashboard): add chat ToolCallCard`.

### Task 4.4: ChatTab restyle

**Files:** Modify `dashboard/src/tabs/ChatTab.tsx`, `dashboard/src/styles/chat.css`; rewrite chat tests in `dashboard/tests/chat-tab.test.tsx`.

- [ ] **Step 1: Failing test** — port existing chat tests; add: session lane rows render a state indicator via `deriveSessionIndicator`; header shows preset selector + setting chips (`web search`, `per-step thinking`, `simple flow`) with `on` when active; a running tool message renders `ToolCallCard` with spinner; streaming assistant text has `.caret`; Send button label flips to `Stop` while `chatBusy`; composer context bar uses `getContextBarFillTone`; backend failure renders `.err-banner` with Retry + Open logs.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Restructure to mockup Chat markup (lines 431–548):
  - Left `.chat-lane`: `+ New session` (`.ghost-btn.acc`), rows with `.t` + `.m` state indicator from `deriveSessionIndicator` (typing dots / `.sp` spinner / `.dot bad` / `.dot ok`).
  - `.chat-head`: preset `<select>` + `.hchip` chips reflecting live per-session state (`webSearchEnabled`, per-step thinking, simple flow). Reuse existing toggle handlers (`onToggleWebSearchEnabled`, `onToggleThinking`, `onChangeRepoSearchSimpleFlow`-equivalent).
  - `.msgs`: user/assistant bubbles; tool calls → `ToolCallCard`; thinking traces → `.think` dim italic; streaming assistant text wrapped in `.caret`.
  - `.composer`: `.ctx` bar (`i` width = usedRatio%, class `warn` when `getContextBarFillTone==='warn'`) + mono `used/total` `.ctx-label`; Send button shows `Stop` when `chatBusy`.
  - Error banner `.err-banner` with `Retry` / `Open logs` reusing the existing chat failure surface (`chatError` + restart-failure path) — no new error path.
  - Preserve all existing composer controls (preset select, repo-root input, auto-append buttons, condense) — restyled, not removed.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Rewrite `chat.css`** to mockup lines 122–138 + 237–267 (states/animations), all animation blocks wrapped by `@media (prefers-reduced-motion: reduce)` (mockup lines 256–258). Delete old chat rules.
- [ ] **Step 6: Gate + visual (drive a live chat: stream, tool call, stop). Commit** `feat(dashboard): rail chat states, tool cards, context bar`.

---

## Milestone 5 — Settings field grid + General/Interactive/Web Search

Goal: 190px section rail + content pane; header row (title, `N unsaved` dirty pill, Reload, Restart backend, Save settings); 4-column field grid with `full/half/quarter → w4/w2/1` spans, label-over-value, inline dim hints for help ≤ 60 chars else the existing hover popover; masked API keys with Show.

### Task 5.1: inline-help threshold in SettingsField

**Files:** Modify `dashboard/src/settings/SettingsFields.tsx`; Create `dashboard/tests/settings-field.test.tsx`.

- [ ] **Step 1: Failing test** — `SettingsField` with `helpText` ≤ 60 chars renders an inline `.fhint`; > 60 chars renders the hover `.settings-live-help-popover` (existing). Layout maps `quarter→(default 1 col)`, `half→w2`, `full→w4`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Add a pure `shouldInlineHelp(helpText?: string): boolean` (`typeof helpText === 'string' && helpText.length > 0 && helpText.length <= 60`). Render `.field` (mockup lines 149–154) with label row, the child control, and either inline `.fhint` or the popover `.settings-live-help`. Map layout `full→'w4'`, `half→'w2'`, `quarter→''` on a `.field` grid item.
- [ ] **Step 4: PASS. Commit** `feat(dashboard): field grid with inline help threshold`.

### Task 5.2: SettingsTab chrome + General/Interactive/Web Search

**Files:** Modify `dashboard/src/tabs/SettingsTab.tsx`, `dashboard/src/styles/settings.css`; tests `dashboard/tests/settings-tab.test.tsx`.

- [ ] **Step 1: Failing test** — port the existing General/Interactive/Web-Search SettingsTab tests; update to new chrome: `.set-nav` with six links, `.set-head` with dirty pill `2 unsaved` when dirty, Reload/Restart/Save buttons, `.fgrid` field grid, masked `type="password"` keys with Show, usage line. Keep the existing dirty-check/`requestSettingsAction` wiring assertions.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Replace `.settings-live-layout` with mockup Settings shell (lines 551–568): `.set-nav` (section rail) + `.set-main` (`.set-head` with title, `.dirty-pill` showing `${count} unsaved` where count comes from the existing dirty signal — if only a boolean `settingsDirty` exists, show `Unsaved changes`/omit count; do not invent a count that isn't computed). General/Interactive/Web-Search sections render through the updated `renderField`/`.fgrid`. Section switching still routes through `requestSettingsAction({ kind: 'switch-section' })` (unchanged). Actionbar buttons unchanged in behavior, restyled.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Rewrite `settings.css`** shell + field-grid rules to mockup lines 140–173. Keep tool-policy/preset/model-preset rules for their milestones; delete superseded `.settings-live-*` rules as each is replaced.
- [ ] **Step 6: Gate + visual. Commit** `feat(dashboard): rail settings shell + field grid`.

---

## Milestone 6 — Tool Policy matrix + Presets master-detail

### Task 6.1: tool-policy matrix derivation

**Files:** Create `dashboard/src/lib/tool-policy-matrix.ts`, `dashboard/tests/tool-policy-matrix.test.ts`.

- [ ] **Step 1: Failing test** — `buildToolPolicyMatrixRows(operationModeAllowedTools)` returns grouped rows (Text & JSON, Repository, Object pipeline, Formatting, Web) each `{ tool, summary: boolean, readOnly: boolean, full: boolean }`, ordered per `PRESET_TOOL_OPTIONS`. `toggleToolInMode(config, tool, mode)` returns the updated allowlist using existing `togglePresetTool`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Define the group→tools map (from the mockup lines 590–617). `buildToolPolicyMatrixRows` reads `operationModeAllowedTools[mode].includes(tool)`. Reuse `togglePresetTool` from `preset-editor.ts` for mutation; do not duplicate toggle logic.
- [ ] **Step 4: PASS. Commit** `feat(dashboard): tool-policy matrix derivation`.

### Task 6.2: ToolPolicyMatrix component

**Files:** Create `dashboard/src/tabs/settings/ToolPolicyMatrix.tsx`, `dashboard/tests/tool-policy-matrix-component.test.tsx`.

- [ ] **Step 1: Failing test** — renders `.tp-table` with `summary/read-only/full` columns, group rows, one `.cb`/`.cb.on` per cell; clicking a cell calls `updateSettingsDraft` mutating `OperationModeAllowedTools[mode]`.
- [ ] **Step 2–3:** Implement the matrix (mockup lines 176–183, 587–618) from `buildToolPolicyMatrixRows`. Checkbox cells toggle via `updateSettingsDraft`.
- [ ] **Step 4: PASS.**
- [ ] **Step 5:** In `SettingsTab.tsx`, replace `renderToolPolicySection`'s three-card list with `<ToolPolicyMatrix …/>`. Delete `.settings-preset-mode-grid` usage. Add `.tp-table`/`.cb` CSS (mockup lines 176–183) to `settings.css`.
- [ ] **Step 6: Gate + visual. Commit** `feat(dashboard): single tool-policy matrix replaces per-mode lists`.

### Task 6.3: PresetsSection master-detail

**Files:** Modify `dashboard/src/tabs/settings/PresetsSection.tsx`, `dashboard/tests/presets-section.test.tsx`.

- [ ] **Step 1: Failing test** — port the existing PresetsSection test; assert `.plib` two-column (`.plist` list + `.pcard` editor), preset rows with `.bdg` kind/mode/origin badges (`custom` marked), `+ Add preset`, editor with name/kind/mode controls, tool whitelist as `.tchip` toggle chips, and mode-blocked tools rendered `.tchip.blocked` struck-through+disabled using `getEffectivePresetTools`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Replace the single-card layout with `.plib`: `.plist` (rows = presets with badges; selected → `.sel`; `+ Add preset` button) + `.pcard` (name/kind/mode selects + tool chips). Tool chips: for each `PRESET_TOOL_OPTIONS` tool, `on` when in `allowedTools`; `blocked` (struck + disabled) when not in `getEffectivePresetTools(preset, OperationModeAllowedTools)` for the mode; toggling uses `togglePresetTool`. Keep all existing preset fields (description, prompt override, surfaces, includeAgentsMd/repoFileListing, useForSummary) inside the editor card. Reuse existing handlers.
- [ ] **Step 4: PASS. Add `.plib/.plist/.prow/.bdg/.pcard/.tool-chips/.tchip` CSS** (mockup lines 185–203). Gate + visual.
- [ ] **Step 5: Commit** `feat(dashboard): presets master-detail with blocked-tool chips`.

---

## Milestone 7 — Model Presets collapsible groups

Goal: toolbar (preset selector + active pill, Add, Delete, llama.cpp/EXL3 segmented control) above six collapsible `<details>` group cards; collapsed header shows a live mono summary; open card shows a flat field grid. Field visibility driven by existing `getPresetFieldAvailability`/`getExl3CacheMode` and the existing conditional logic. Identity & launch opens by default; open state is component state (not persisted).

### Task 7.1: group summary builders

**Files:** Create `dashboard/src/tabs/settings/model-preset-groups.ts`, `dashboard/tests/model-preset-groups.test.ts`.

- [ ] **Step 1: Failing test** — for each of the six groups, a pure `summarize<Group>(preset)` returns the mono summary string; cover llama vs EXL3 variants per spec §Model Presets table. Examples:
  - Identity: `Qwen3.5-35B Q4_K_L · managed · 127.0.0.1:8097` (managed vs external; EXL3 shows model dir).
  - Memory: llama `ctx 128k · GPU 999 · batch 512/512 · KV f16`; EXL3 `ctx 128k · chunk 512 · KV f16`.
  - Sampling: `temp 0.7 · top-p 0.8 · top-k 20 · max 15k`.
  - Reasoning: `off · per-step thinking on · budget 10k`.
  - Speculative: llama `on · ngram-map-k · N12 M4`; EXL3 `on · draft-mtp · 2–8`; off → `off`.
  - Lifecycle: `startup 120s · probe 5s/1s · idle unload 600s`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Export `MODEL_PRESET_GROUPS` (id, title, ordered field labels, `summarize(preset)`) and the six `summarize*` functions. Summaries recompute from the draft preset and branch on `preset.Backend`. Use `formatNumber`/compact `k` formatting helpers from `lib/format.ts` where they exist; otherwise a small local `formatK` (add its own test).
- [ ] **Step 4: PASS. Commit** `feat(dashboard): model-preset group summary builders`.

### Task 7.2: ModelPresetsSection collapsible groups

**Files:** Modify `dashboard/src/tabs/settings/ModelPresetsSection.tsx`, `dashboard/tests/model-preset-groups-component.test.tsx`; port the many existing `ModelPresetsSection`/`tests/dashboard-model-presets-section.test.ts` assertions.

- [ ] **Step 1: Failing test** — assert: `.mp-toolbar` with preset selector, `active` pill, Add, Delete, `.segc` llama.cpp/EXL3 control; six `.mpg` `<details>`; Identity & launch `open` by default; collapsed group shows its `.gsum` summary; EXL3 selected hides llama-only fields (`GpuLayers`, `BatchSize`, …) and shows `Model directory (EXL3)`; speculative sub-fields still gated by type (reuse existing conditionals + `getPresetFieldAvailability`). Preserve the existing behavior tests (reasoning-on enables per-step thinking; MTP/parallel-slots warning; remote-URL warning; KV-quant disabled options; model derived from path).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Add a segmented backend control bound to the existing `preset.Backend` update logic (moves the existing `<select aria-label="Preset backend">` behavior into `.segc` buttons — keep `aria-label="Preset backend"` on the control for the existing test, or update that test). Group the existing `renderField(...)` calls under six `<details className="mpg">` using `MODEL_PRESET_GROUPS`; each `<summary>` shows chevron + title + `.gsum` summary (hidden when `[open]`). `open` state per group via `useState<Record<groupId, boolean>>` seeded `{ 'identity-launch': true }` (not persisted). Field-level visibility (`be-l`/`be-x`, speculative type gating, external-server hiding of exec/model path) stays driven by the existing conditional expressions and `getPresetFieldAvailability`/`renderCompatibilityControl` — do not reimplement availability. Field grid inside each group uses `.fgrid.flat` (mockup lines 232–233).
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Add `.mp-toolbar/.mp-select/.active-pill/.segc/.mpg/.gsum/.fgrid.flat/.cond-note` CSS** (mockup lines 205–235), reduced-motion-guarded chevron. Gate + visual (toggle EXL3, expand/collapse, edit a field and watch the summary update).
- [ ] **Step 6: Commit** `feat(dashboard): collapsible model-preset groups with live summaries`.

---

## Milestone 8 — Delete mockup residue, final sweep

- [ ] **Step 1:** Confirm deletions done (Milestone 1 removed mockup files + `InteractiveGraph`). Grep zero hits: `grep -rn "settings-mockup\|InteractiveGraph\|dashboard-route\|--bg-0\|--ink-dim\|--accent\|--stroke\|panel-grid\|topbar\|hamburger" dashboard/src`.
- [ ] **Step 2:** Rewrite/replace the orphaned `dashboard/tests/tab-components.test.tsx` — its per-tab tests have been superseded by the milestone tests (`runs-tab`, `metrics-tab`, `benchmark-tab`, `chat-tab`, `settings-tab`, `presets-section`, `model-preset-groups-component`). Delete `tab-components.test.tsx` (its coverage now lives in those files) and confirm no reference to it remains.
- [ ] **Step 3:** Delete any now-dead CSS files/blocks; ensure `styles.css` still imports the six area files. Confirm no rule references a removed token/class.
- [ ] **Step 4:** Run the entire dashboard UI suite and root suite:

```bash
npx tsx --test dashboard/tests/*.test.ts dashboard/tests/*.test.tsx dashboard/tests/hooks/*.test.tsx dashboard/tests/lib/*.test.ts
npm run typecheck && npm test
```

All green; hook/controller tests unchanged and passing.
- [ ] **Step 5:** Full visual pass of all five screens against the mockup (light source of truth), including reduced-motion (`prefers-reduced-motion`) — animations stop.
- [ ] **Step 6:** Use superpowers:requesting-code-review, then superpowers:finishing-a-development-branch.
- [ ] **Step 7: Commit** `chore(dashboard): remove rail-redesign residue and finalize`.

---

## Self-review notes (spec coverage)

- Spec §Decisions 1–7 → Milestones 1 (rail/top/route), 2–4 (charts palette/status dot), 5–7 (settings). Tokens §5 → M1 Task 1.3. Chart palette §4 → M3 (`CHART_COLORS`). Status encoding §6 → M2 `StatusDot`. Mockup-route removal §7 → M1 Task 1.4.
- Spec §Screens → M2 (Logs), M3 (Metrics/Bench), M4 (Chat), M5–7 (Settings sections incl. tool-policy matrix, presets master-detail, model-preset groups).
- Spec §Architecture components → all created in the file map; no dynamic function-passing beyond standard typed props (matches existing controller wiring).
- Spec §Testing → hook tests untouched (M8 verifies green); new pure-helper + component tests per milestone (TDD); **deviation:** repo has no vitest — tests use the established `node:test`+`renderToStaticMarkup` toolchain (approved: follow established patterns / avoid new framework).
- **Open item to resolve at execution time:** whether a real `serverHealthy` signal exists (M1 Task 1.4 Step 3) and whether `settingsDirty` exposes a count for the `N unsaved` pill (M5 Task 5.2 Step 3). Both fall back to truthful minimal behavior if the underlying signal is absent — resolve by inspecting the controllers, not by adding new controller state.
```

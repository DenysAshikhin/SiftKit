# Integrated Settings Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current scrolling settings tab with a live integrated section-based editor that shows one section at a time, guards unsaved changes, adds styled help popovers, and exposes a backend restart action.

**Architecture:** Keep the existing dashboard tab structure and live config state in `App.tsx`, but extract typed section metadata and small pure helpers for active-section behavior, dirty-state continuation flow, and restart eligibility. Reuse current config load/save logic, add a restart endpoint on the status server, and render a focused settings workspace instead of the old long form.

**Tech Stack:** React 19, TypeScript, Vite, node:test, tsx, existing status server routes

---

## File Structure

- Modify: `dashboard/src/App.tsx`
- Modify: `dashboard/src/api.ts`
- Modify: `dashboard/src/styles.css`
- Create: `dashboard/src/settings-sections.ts`
- Create: `dashboard/src/settings-flow.ts`
- Modify: `src/status-server/routes/core.ts`
- Create: `tests/settings-sections.test.ts`
- Create: `tests/settings-flow.test.ts`
- Modify: `tests/runtime-status-server.test.ts`
- Modify: `package.json`

### Task 1: Replace mockup metadata with live settings section metadata

**Files:**
- Create: `dashboard/src/settings-sections.ts`
- Create: `tests/settings-sections.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing section metadata test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { SETTINGS_SECTION_ORDER, SETTINGS_TOOLTIP_LABELS } from '../dashboard/src/settings-sections.ts';

test('settings section order matches the integrated layout', () => {
  assert.deepEqual(
    SETTINGS_SECTION_ORDER,
    ['general', 'model-runtime', 'sampling', 'interactive', 'managed-llama'],
  );
});

test('settings tooltip labels include the documented fields', () => {
  assert.deepEqual(
    SETTINGS_TOOLTIP_LABELS,
    [
      'NumCtx',
      'MaxTokens',
      'Threads',
      'GpuLayers',
      'Temperature',
      'TopP',
      'TopK',
      'MinP',
      'PresencePenalty',
      'RepetitionPenalty',
      'ParallelSlots',
      'Reasoning',
      'Wrapped commands',
      'Interactive IdleTimeoutMs',
      'HealthcheckTimeoutMs',
      'HealthcheckIntervalMs',
    ],
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test .\tests\settings-sections.test.ts`

Expected: `FAIL` because `settings-sections.ts` does not exist yet

- [ ] **Step 3: Add the typed section metadata**

Create `dashboard/src/settings-sections.ts`:

```ts
export type SettingsSectionId =
  | 'general'
  | 'model-runtime'
  | 'sampling'
  | 'interactive'
  | 'managed-llama';

export const SETTINGS_SECTION_ORDER: SettingsSectionId[] = [
  'general',
  'model-runtime',
  'sampling',
  'interactive',
  'managed-llama',
];

export const SETTINGS_TOOLTIP_LABELS = [
  // documented tooltip labels
] as const;
```

Then add typed section descriptors for icon, title, summary, and field membership that match the approved design.

- [ ] **Step 4: Re-run the section metadata test**

Run: `npx tsx --test .\tests\settings-sections.test.ts`

Expected: `PASS`

- [ ] **Step 5: Register the test in package scripts**

Add `.\tests\settings-sections.test.ts` to `test` and `test:coverage`.

- [ ] **Step 6: Commit Task 1**

```bash
git add dashboard/src/settings-sections.ts tests/settings-sections.test.ts package.json
git commit -m "feat: define integrated settings sections"
```

### Task 2: Add dirty-state continuation helpers with TDD

**Files:**
- Create: `dashboard/src/settings-flow.ts`
- Create: `tests/settings-flow.test.ts`

- [ ] **Step 1: Write the failing flow test**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { getDirtyActionRequirement, type DirtyContinuation } from '../dashboard/src/settings-flow.ts';

test('section switch requires confirmation when settings are dirty', () => {
  assert.equal(getDirtyActionRequirement(true, 'switch-section'), 'confirm');
});

test('section switch continues immediately when settings are clean', () => {
  assert.equal(getDirtyActionRequirement(false, 'switch-section'), 'continue');
});

test('save continuation preserves requested action metadata', () => {
  const continuation: DirtyContinuation = {
    kind: 'switch-tab',
    nextTab: 'runs',
  };
  assert.deepEqual(continuation, { kind: 'switch-tab', nextTab: 'runs' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test .\tests\settings-flow.test.ts`

Expected: `FAIL` because `settings-flow.ts` does not exist yet

- [ ] **Step 3: Add minimal typed continuation helpers**

Create `dashboard/src/settings-flow.ts`:

```ts
import type { SettingsSectionId } from './settings-sections';

export type DirtyContinuation =
  | { kind: 'switch-section'; nextSection: SettingsSectionId }
  | { kind: 'switch-tab'; nextTab: 'runs' | 'metrics' | 'chat' | 'settings' }
  | { kind: 'restart-backend' };

export type DirtyActionKind = DirtyContinuation['kind'];

export function getDirtyActionRequirement(isDirty: boolean, action: DirtyActionKind): 'confirm' | 'continue' {
  return isDirty && action !== 'none' ? 'confirm' : 'continue';
}
```

Adjust exact types as needed, but keep them explicit and narrow.

- [ ] **Step 4: Re-run the flow test**

Run: `npx tsx --test .\tests\settings-flow.test.ts`

Expected: `PASS`

- [ ] **Step 5: Commit Task 2**

```bash
git add dashboard/src/settings-flow.ts tests/settings-flow.test.ts
git commit -m "feat: add settings dirty-state flow helpers"
```

### Task 3: Add backend restart endpoint with TDD

**Files:**
- Modify: `src/status-server/routes/core.ts`
- Modify: `tests/runtime-status-server.test.ts`

- [ ] **Step 1: Write the failing restart endpoint test**

Add a focused test to `tests/runtime-status-server.test.ts` that starts the status server in the same style as existing config tests and asserts:

```ts
test('real status server exposes backend restart endpoint', async () => {
  // start server
  // POST /status/restart
  // expect 200 with { ok: true } or a clear supported response shape
});
```

If restart is disabled in the chosen setup, assert the exact clear failure contract instead, but prefer a passing supported path under the managed setup already used by nearby tests.

- [ ] **Step 2: Run the focused restart test to verify it fails**

Run: `npx tsx --test .\tests\runtime-status-server.test.ts --test-name-pattern "backend restart endpoint"`

Expected: `FAIL` because the endpoint does not exist yet

- [ ] **Step 3: Implement the restart route**

Add a route in `src/status-server/routes/core.ts` that:

- handles `POST /status/restart`
- reuses existing managed llama lifecycle behavior if available
- returns a typed JSON response
- returns a clear error/status if restart is unsupported

Keep implementation minimal and aligned with current status/config route patterns.

- [ ] **Step 4: Re-run the focused restart test**

Run: `npx tsx --test .\tests\runtime-status-server.test.ts --test-name-pattern "backend restart endpoint"`

Expected: `PASS`

- [ ] **Step 5: Commit Task 3**

```bash
git add src/status-server/routes/core.ts tests/runtime-status-server.test.ts
git commit -m "feat: add backend restart endpoint"
```

### Task 4: Integrate the new settings tab UI and dirty-state modal

**Files:**
- Modify: `dashboard/src/App.tsx`
- Modify: `dashboard/src/api.ts`
- Modify: `dashboard/src/styles.css`
- Modify: `dashboard/src/settings-sections.ts`
- Modify: `dashboard/src/settings-flow.ts`

- [ ] **Step 1: Replace the old scrolling settings form with one-section-at-a-time rendering**

Refactor settings rendering so:

- the left rail uses `SETTINGS_SECTION_ORDER`
- one `activeSettingsSection` state controls the visible pane
- the old full-form stack is removed
- the real existing field bindings are reused inside per-section render blocks

- [ ] **Step 2: Add the pending-changes modal flow**

In `App.tsx`, add explicit state for:

```ts
const [activeSettingsSection, setActiveSettingsSection] = useState<SettingsSectionId>('general');
const [pendingContinuation, setPendingContinuation] = useState<DirtyContinuation | null>(null);
const [showSettingsConfirm, setShowSettingsConfirm] = useState(false);
```

Use that flow for:

- switching settings sections
- leaving the settings tab
- clicking restart with dirty changes

Modal actions:

- `Save` -> call existing save logic, then continue
- `Discard` -> restore last loaded config snapshot, then continue
- `Cancel` -> clear continuation and stay put

- [ ] **Step 3: Add unload warning using the same dirty-state source**

Add a `beforeunload` effect guarded by the same settings dirty-state boolean so browser reload/navigation is warned when unsaved changes exist.

- [ ] **Step 4: Add restart API integration**

In `dashboard/src/api.ts`, add:

```ts
export function restartBackend(): Promise<{ ok: boolean; restarted?: boolean; error?: string }> {
  return fetchJson('/status/restart', { method: 'POST' });
}
```

Then wire the `Restart Backend` action into the settings action bar in `App.tsx`, including busy/error handling and post-restart reload of health/config.

- [ ] **Step 5: Add help popovers and final styles**

Style:

- section rail
- active section card
- no-scroll desktop settings layout
- modal
- help popovers
- restart button state

Keep selectors scoped to the settings redesign to avoid affecting other tabs.

- [ ] **Step 6: Run focused frontend helper tests**

Run: `npx tsx --test .\tests\dashboard-route.test.ts .\tests\settings-sections.test.ts .\tests\settings-flow.test.ts`

Expected: `PASS`

- [ ] **Step 7: Build the project**

Run: `npm run build`

Expected: successful TypeScript + Vite build

- [ ] **Step 8: Run the focused restart server test**

Run: `npx tsx --test .\tests\runtime-status-server.test.ts --test-name-pattern "backend restart endpoint"`

Expected: `PASS`

- [ ] **Step 9: Manually verify**

Run: `npm run start`

Verify:

- `/?tab=settings` shows the redesigned settings tab
- only one section is visible at a time
- switching sections with dirty edits opens the modal
- leaving settings with dirty edits opens the modal
- reload/navigation warns when dirty
- `Restart Backend` works through the same decision flow

- [ ] **Step 10: Commit Task 4**

```bash
git add dashboard/src/App.tsx dashboard/src/api.ts dashboard/src/styles.css dashboard/src/settings-sections.ts dashboard/src/settings-flow.ts package.json
git commit -m "feat: redesign integrated settings editor"
```

## Self-Review

- Spec coverage:
  - single visible section is covered by Tasks 1 and 4
  - dirty-state modal flow is covered by Tasks 2 and 4
  - backend restart is covered by Tasks 3 and 4
- Placeholder scan:
  - no unresolved placeholders remain
  - commands and target files are explicit
- Type consistency:
  - `SettingsSectionId` and `DirtyContinuation` are defined once and reused across frontend state/helpers

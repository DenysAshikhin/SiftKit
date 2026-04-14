# Presets Single-Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the presets settings card stack with a top-level preset selector, a single selected-preset editor, and a toggleable allowed-tools dropdown.

**Architecture:** Keep the existing settings state in `dashboard/src/App.tsx`, but extract the brittle selection and tool-toggle behavior into a small typed helper module with direct unit tests. Then update the presets section markup in `App.tsx` to render one preset at a time and add minimal CSS for the selector row and dropdown menu.

**Tech Stack:** React 19, TypeScript, Vite, node:test, tsx.

---

## File Structure

- Create: `dashboard/src/preset-editor.ts`
- Modify: `dashboard/src/App.tsx`
- Modify: `dashboard/src/styles.css`
- Create: `tests/preset-editor.test.ts`
- Modify: `package.json`

### Task 1: Add preset editor helper coverage first

**Files:**
- Create: `dashboard/src/preset-editor.ts`
- Create: `tests/preset-editor.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing helper tests**

Create `tests/preset-editor.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRESET_TOOL_OPTIONS,
  getFallbackPresetId,
  getPresetToolsSummary,
  togglePresetTool,
} from '../dashboard/src/preset-editor.ts';
import type { DashboardPreset, DashboardPresetToolName } from '../dashboard/src/types.ts';

function createPreset(id: string, overrides: Partial<DashboardPreset> = {}): DashboardPreset {
  return {
    id,
    label: id,
    description: '',
    executionFamily: 'summary',
    promptPrefix: '',
    allowedTools: ['find_text'],
    surfaces: ['cli'],
    useForSummary: false,
    builtin: false,
    deletable: true,
    repoRootRequired: false,
    maxTurns: null,
    thinkingInterval: null,
    thinkingEnabled: null,
    ...overrides,
  };
}

test('PRESET_TOOL_OPTIONS exposes every supported tool exactly once', () => {
  assert.deepEqual(PRESET_TOOL_OPTIONS, [
    'find_text',
    'read_lines',
    'json_filter',
    'run_repo_cmd',
  ] satisfies DashboardPresetToolName[]);
});

test('getFallbackPresetId keeps the selected preset when still present', () => {
  const presets = [createPreset('summary'), createPreset('chat')];
  assert.equal(getFallbackPresetId(presets, 'chat'), 'chat');
});

test('getFallbackPresetId selects the next preset after deleting the current one', () => {
  const presets = [createPreset('summary'), createPreset('chat'), createPreset('plan')];
  assert.equal(getFallbackPresetId(presets, 'chat', 'chat'), 'plan');
});

test('getFallbackPresetId selects the previous preset when the deleted preset was last', () => {
  const presets = [createPreset('summary'), createPreset('chat'), createPreset('plan')];
  assert.equal(getFallbackPresetId(presets, 'plan', 'plan'), 'chat');
});

test('getPresetToolsSummary returns a comma-separated list in supported-option order', () => {
  assert.equal(getPresetToolsSummary(['run_repo_cmd', 'find_text']), 'find_text, run_repo_cmd');
});

test('togglePresetTool adds missing tools and removes existing ones', () => {
  assert.deepEqual(togglePresetTool(['find_text'], 'read_lines'), ['find_text', 'read_lines']);
  assert.deepEqual(togglePresetTool(['find_text', 'read_lines'], 'find_text'), ['read_lines']);
});
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `npx tsx --test .\tests\preset-editor.test.ts`

Expected: `FAIL` because `dashboard/src/preset-editor.ts` does not exist yet

- [ ] **Step 3: Add the minimal helper module**

Create `dashboard/src/preset-editor.ts`:

```ts
import type { DashboardPreset, DashboardPresetToolName } from './types';

export const PRESET_TOOL_OPTIONS: DashboardPresetToolName[] = [
  'find_text',
  'read_lines',
  'json_filter',
  'run_repo_cmd',
];

export function getFallbackPresetId(
  presets: DashboardPreset[],
  selectedPresetId: string | null,
  removedPresetId?: string,
): string | null {
  if (presets.length === 0) {
    return null;
  }
  if (selectedPresetId && selectedPresetId !== removedPresetId && presets.some((preset) => preset.id === selectedPresetId)) {
    return selectedPresetId;
  }
  if (!removedPresetId) {
    return presets[0]?.id ?? null;
  }
  const removedIndex = presets.findIndex((preset) => preset.id === removedPresetId);
  if (removedIndex >= 0) {
    return presets[removedIndex]?.id ?? presets[removedIndex - 1]?.id ?? presets[0]?.id ?? null;
  }
  return presets[0]?.id ?? null;
}

export function togglePresetTool(
  allowedTools: DashboardPresetToolName[],
  tool: DashboardPresetToolName,
): DashboardPresetToolName[] {
  if (allowedTools.includes(tool)) {
    return PRESET_TOOL_OPTIONS.filter((option) => option !== tool && allowedTools.includes(option));
  }
  return PRESET_TOOL_OPTIONS.filter((option) => option === tool || allowedTools.includes(option));
}

export function getPresetToolsSummary(allowedTools: DashboardPresetToolName[]): string {
  return PRESET_TOOL_OPTIONS.filter((tool) => allowedTools.includes(tool)).join(', ');
}
```

- [ ] **Step 4: Re-run the helper test**

Run: `npx tsx --test .\tests\preset-editor.test.ts`

Expected: `PASS`

- [ ] **Step 5: Register the new test**

Add `.\tests\preset-editor.test.ts` to `test` and `test:coverage` in `package.json`.

- [ ] **Step 6: Commit Task 1**

```bash
git add dashboard/src/preset-editor.ts tests/preset-editor.test.ts package.json
git commit -m "test: add preset editor helper coverage"
```

### Task 2: Replace the preset card stack with a single selected-preset editor

**Files:**
- Modify: `dashboard/src/App.tsx`
- Modify: `dashboard/src/styles.css`
- Reuse: `dashboard/src/preset-editor.ts`

- [ ] **Step 1: Add a second failing helper assertion for selection fallback from add/delete flows**

Extend `tests/preset-editor.test.ts`:

```ts
test('getFallbackPresetId defaults to the first preset when selection is missing', () => {
  const presets = [createPreset('summary'), createPreset('chat')];
  assert.equal(getFallbackPresetId(presets, 'missing'), 'summary');
});
```

- [ ] **Step 2: Run the helper test to verify the new assertion fails if behavior is missing**

Run: `npx tsx --test .\tests\preset-editor.test.ts`

Expected: `FAIL` only if the helper behavior is incomplete; otherwise skip code changes and keep moving

- [ ] **Step 3: Update `App.tsx` to render one preset at a time**

Add local state and imports near the existing preset logic:

```ts
import {
  PRESET_TOOL_OPTIONS,
  getFallbackPresetId,
  getPresetToolsSummary,
  togglePresetTool,
} from './preset-editor';
```

```ts
const [selectedSettingsPresetId, setSelectedSettingsPresetId] = useState<string | null>(null);
const [presetToolsMenuOpen, setPresetToolsMenuOpen] = useState<boolean>(false);
```

Then derive the selected preset and keep it valid when config reloads:

```ts
const selectedSettingsPreset = dashboardConfig
  ? dashboardConfig.Presets.find((preset) => preset.id === selectedSettingsPresetId) ?? dashboardConfig.Presets[0] ?? null
  : null;

useEffect(() => {
  if (!dashboardConfig) {
    setSelectedSettingsPresetId(null);
    return;
  }
  setSelectedSettingsPresetId((previous) => getFallbackPresetId(dashboardConfig.Presets, previous));
}, [dashboardConfig]);
```

Replace the repeated `dashboardConfig.Presets.map(...)` block with:

```tsx
<div className="settings-preset-library">
  <div className="settings-preset-toolbar">
    <label className="settings-preset-selector">
      <span className="settings-preset-inline-label">
        <SettingsInlineHelpLabel label="Preset" helpText="Pick which preset to edit." />
      </span>
      <select
        value={selectedSettingsPreset?.id ?? ''}
        onChange={(event) => setSelectedSettingsPresetId(event.target.value)}
      >
        {dashboardConfig.Presets.map((preset) => (
          <option key={preset.id} value={preset.id}>{preset.label}</option>
        ))}
      </select>
    </label>
    <div className="settings-preset-library-actions">
      <button type="button" onClick={onAddPreset}>Add Preset</button>
      <button
        type="button"
        onClick={() => selectedSettingsPreset && onDeletePreset(selectedSettingsPreset.id)}
        disabled={!selectedSettingsPreset?.deletable}
      >
        Delete
      </button>
    </div>
  </div>
  {selectedSettingsPreset ? (
    <article className="settings-preset-card">
      {/* existing field grid, rewritten to use selectedSettingsPreset */}
    </article>
  ) : null}
</div>
```

Update `onAddPreset` and `onDeletePreset` to also update `selectedSettingsPresetId` and close the tools dropdown.

- [ ] **Step 4: Replace the read-only tools input with a dropdown menu**

In the preset form, replace the `Allowed tools` field with:

```tsx
<label>
  <span className="settings-preset-inline-label">
    <SettingsInlineHelpLabel label="Allowed tools" helpText="Tools permitted for this preset. Toggle each option directly." />
  </span>
  <div className="settings-preset-tools">
    <button
      type="button"
      className="settings-preset-tools-trigger"
      onClick={() => setPresetToolsMenuOpen((value) => !value)}
    >
      {getPresetToolsSummary(selectedSettingsPreset.allowedTools) || 'No tools selected'}
    </button>
    {presetToolsMenuOpen ? (
      <div className="settings-preset-tools-menu">
        {PRESET_TOOL_OPTIONS.map((tool) => (
          <label key={tool} className="settings-preset-tools-option">
            <input
              type="checkbox"
              checked={selectedSettingsPreset.allowedTools.includes(tool)}
              onChange={() => updatePresetDraft(selectedSettingsPreset.id, (next) => {
                next.allowedTools = togglePresetTool(next.allowedTools, tool);
              })}
            />
            <span>{tool}</span>
          </label>
        ))}
      </div>
    ) : null}
  </div>
</label>
```

- [ ] **Step 5: Add the minimal styles**

Add CSS for:

```css
.settings-preset-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: end; }
.settings-preset-selector { display: grid; gap: 8px; min-width: 0; }
.settings-preset-tools { position: relative; display: grid; gap: 8px; }
.settings-preset-tools-trigger { width: 100%; text-align: left; }
.settings-preset-tools-menu { position: absolute; top: calc(100% + 6px); left: 0; right: 0; z-index: 2; }
.settings-preset-tools-option { display: flex; gap: 8px; align-items: center; }
```

Keep the existing card/grid styles unless a small responsive adjustment is needed.

- [ ] **Step 6: Run the helper test again**

Run: `npx tsx --test .\tests\preset-editor.test.ts`

Expected: `PASS`

- [ ] **Step 7: Run a focused build**

Run: `npm run build`

Expected: `PASS`

- [ ] **Step 8: Commit Task 2**

```bash
git add dashboard/src/App.tsx dashboard/src/styles.css dashboard/src/preset-editor.ts tests/preset-editor.test.ts package.json
git commit -m "feat: switch presets settings to single editor"
```

### Task 3: Verify the full change

**Files:**
- Modify: none

- [ ] **Step 1: Run focused verification**

Run: `npx tsx --test .\tests\preset-editor.test.ts .\tests\settings-sections.test.ts .\tests\settings-runtime.test.ts .\tests\settings-flow.test.ts`

Expected: `PASS`

- [ ] **Step 2: Run the dashboard build again**

Run: `npm run build`

Expected: `PASS`

- [ ] **Step 3: Review diff scope**

Run: `git diff -- dashboard/src/App.tsx dashboard/src/styles.css dashboard/src/preset-editor.ts tests/preset-editor.test.ts package.json`

Expected: only the preset single-editor UI, helper logic, CSS, and test registration changes

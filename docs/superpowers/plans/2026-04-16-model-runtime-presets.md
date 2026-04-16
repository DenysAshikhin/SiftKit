# Model Runtime Presets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the split model plus managed llama settings flow with one named model/runtime preset editor that saves the selected preset into active runtime config.

**Architecture:** Reuse the existing managed llama preset storage and selection helpers instead of introducing a second preset system. Add one explicit preset `Model` field to the managed preset data model, centralize save-time syncing from the selected preset into runtime/server config, and retitle/restructure the settings UI around a single `Model Presets` section.

**Tech Stack:** React 19, TypeScript, node:test, tsx, existing dashboard settings state/helpers

---

## File Structure

- Modify: `dashboard/src/types.ts`
- Modify: `dashboard/src/managed-llama-presets.ts`
- Modify: `dashboard/src/settings-runtime.ts`
- Modify: `dashboard/src/settings-sections.ts`
- Modify: `dashboard/src/tabs/settings/ManagedLlamaSection.tsx`
- Modify: `dashboard/src/tabs/SettingsTab.tsx`
- Modify: `dashboard/src/App.tsx`
- Modify: `dashboard/tests/tab-components.test.tsx`
- Modify: `tests/settings-sections.test.ts`
- Modify: `tests/dashboard-managed-presets.test.ts`
- Modify: `tests/settings-runtime.test.ts`

### Task 1: Add model-aware managed preset sync helpers

**Files:**
- Modify: `dashboard/src/types.ts`
- Modify: `dashboard/src/managed-llama-presets.ts`
- Modify: `dashboard/src/settings-runtime.ts`
- Modify: `tests/dashboard-managed-presets.test.ts`
- Modify: `tests/settings-runtime.test.ts`

- [ ] **Step 1: Write the failing runtime sync tests**

Add tests that assert:

```ts
test('applyManagedLlamaPresetSelection mirrors preset model into runtime config', () => {
  const config = createConfig();
  applyManagedLlamaPresetSelection(config, 'qwen-27b');
  assert.equal(config.Runtime.Model, 'qwen-27b.gguf');
  assert.equal(config.Model, 'qwen-27b.gguf');
});

test('syncDerivedSettingsFields uses the selected managed preset model when present', () => {
  const config = createConfig();
  config.Server.LlamaCpp.ActivePresetId = 'qwen-27b';
  config.Server.LlamaCpp.Presets[1].Model = 'Qwen 27B Custom';
  syncDerivedSettingsFields(config);
  assert.equal(config.Runtime.Model, 'Qwen 27B Custom');
});
```

- [ ] **Step 2: Run the focused helper tests to verify they fail**

Run: `npx tsx --test .\tests\dashboard-managed-presets.test.ts .\tests\settings-runtime.test.ts`

Expected: `FAIL` because the preset model field does not exist and sync still derives only from `ModelPath`.

- [ ] **Step 3: Add the minimal typed model field and sync logic**

Update `dashboard/src/types.ts` so `DashboardManagedLlamaPreset` and `DashboardConfig.Server.LlamaCpp` carry:

```ts
Model: string;
```

Update `dashboard/src/managed-llama-presets.ts` so `buildPresetFromServer`, `copyPresetToServer`, and preset cloning preserve `Model`.

Update `dashboard/src/settings-runtime.ts` so sync prefers:

```ts
const activePreset = config.Server.LlamaCpp.Presets.find(
  (preset) => preset.id === config.Server.LlamaCpp.ActivePresetId,
);
const runtimeModelId = String(activePreset?.Model || config.Server.LlamaCpp.Model || deriveRuntimeModelId(config.Server.LlamaCpp.ModelPath)).trim();
config.Runtime.Model = runtimeModelId;
config.Model = runtimeModelId;
```

- [ ] **Step 4: Re-run the focused helper tests**

Run: `npx tsx --test .\tests\dashboard-managed-presets.test.ts .\tests\settings-runtime.test.ts`

Expected: `PASS`

- [ ] **Step 5: Commit Task 1**

```bash
git add dashboard/src/types.ts dashboard/src/managed-llama-presets.ts dashboard/src/settings-runtime.ts tests/dashboard-managed-presets.test.ts tests/settings-runtime.test.ts
git commit -m "feat: sync managed model presets into runtime config"
```

### Task 2: Rename the settings section and document the new field set

**Files:**
- Modify: `dashboard/src/settings-sections.ts`
- Modify: `tests/settings-sections.test.ts`

- [ ] **Step 1: Write the failing settings metadata assertions**

Change `tests/settings-sections.test.ts` to require:

```ts
assert.deepEqual(
  SETTINGS_SECTION_ORDER,
  ['general', 'tool-policy', 'presets', 'interactive', 'model-presets'],
);
```

and require these labels in `SETTINGS_TOOLTIP_LABELS`:

```ts
'Model preset',
'Preset name',
'Model',
'Executable path',
'Model path (.gguf)',
```

Also remove the expectation for the old `Managed preset` label.

- [ ] **Step 2: Run the focused metadata test to verify it fails**

Run: `npx tsx --test .\tests\settings-sections.test.ts`

Expected: `FAIL` because the section id/title/labels still use `managed-llama` wording and no `Model` field exists.

- [ ] **Step 3: Implement the metadata changes**

Update `dashboard/src/settings-sections.ts` to:

- rename section id `managed-llama` to `model-presets`
- change the title to `Model Presets`
- change the summary to explain named model/runtime combinations
- rename the library field label to `Model preset`
- add the `Model` field descriptor
- keep the rest of the llama.cpp field descriptors and help text aligned with the spec

- [ ] **Step 4: Re-run the focused metadata test**

Run: `npx tsx --test .\tests\settings-sections.test.ts`

Expected: `PASS`

- [ ] **Step 5: Commit Task 2**

```bash
git add dashboard/src/settings-sections.ts tests/settings-sections.test.ts
git commit -m "feat: relabel settings for model runtime presets"
```

### Task 3: Rework the settings section component around one model preset editor

**Files:**
- Modify: `dashboard/src/tabs/settings/ManagedLlamaSection.tsx`
- Modify: `dashboard/src/tabs/SettingsTab.tsx`
- Modify: `dashboard/tests/tab-components.test.tsx`

- [ ] **Step 1: Write the failing component test expectations**

Update `dashboard/tests/tab-components.test.tsx` so the settings and section tests assert:

```ts
assert.match(markup, /Model Presets/);
assert.match(markup, /Preset name/);
assert.match(markup, /Model/);
assert.doesNotMatch(markup, /Managed llama\.cpp/);
```

Add a managed/model preset section assertion that the selected preset model value renders.

- [ ] **Step 2: Run the focused component test to verify it fails**

Run: `npx tsx --test .\dashboard\tests\tab-components.test.tsx`

Expected: `FAIL` because the UI still renders the old title/labels and has no editable model field.

- [ ] **Step 3: Implement the preset editor UI changes**

Update `dashboard/src/tabs/settings/ManagedLlamaSection.tsx` to:

- switch its section id usage to `model-presets`
- change the selector field to use label `Model preset`
- add an editable `Model` input near `Preset name`
- keep `Add Preset`, `Delete`, and the existing llama.cpp fields
- keep path pickers and existing direct field bindings

Update `dashboard/src/tabs/SettingsTab.tsx` to:

- target `model-presets` instead of `managed-llama`
- change the General section button text to `Open Model Presets`
- keep the one-section-at-a-time layout

- [ ] **Step 4: Re-run the focused component test**

Run: `npx tsx --test .\dashboard\tests\tab-components.test.tsx`

Expected: `PASS`

- [ ] **Step 5: Commit Task 3**

```bash
git add dashboard/src/tabs/settings/ManagedLlamaSection.tsx dashboard/src/tabs/SettingsTab.tsx dashboard/tests/tab-components.test.tsx
git commit -m "feat: merge model and llama settings into preset editor"
```

### Task 4: Wire app state so save persists the selected model preset

**Files:**
- Modify: `dashboard/src/App.tsx`
- Modify: `dashboard/src/settings-runtime.ts`
- Modify: `dashboard/src/managed-llama-presets.ts`

- [ ] **Step 1: Write the failing save-flow behavior test or helper assertions**

If an App-level test is too expensive, add/extend helper coverage so it proves:

```ts
test('syncDerivedSettingsFields keeps draft edits local until save and mirrors selected preset on save path', () => {
  const config = createConfig();
  config.Server.LlamaCpp.Presets[1].Model = 'Draft Model';
  config.Server.LlamaCpp.ActivePresetId = 'qwen-27b';
  syncDerivedSettingsFields(config);
  assert.equal(config.Runtime.Model, 'Draft Model');
});
```

The goal is to cover the save-path helper used by `updateSettingsDraft` and `onSaveDashboardSettings`.

- [ ] **Step 2: Run the relevant tests to verify red before implementation**

Run: `npx tsx --test .\tests\dashboard-managed-presets.test.ts .\tests\settings-runtime.test.ts .\dashboard\tests\tab-components.test.tsx .\tests\settings-sections.test.ts`

Expected: at least one failing assertion tied to the new preset model/save behavior until the App wiring is complete.

- [ ] **Step 3: Implement the minimal app wiring**

Update `dashboard/src/App.tsx` so:

- selected model preset edits still go through `updateManagedLlamaDraft`
- `selectedManagedLlamaPreset` resolution still uses `ActivePresetId`
- save keeps calling `updateDashboardConfig(dashboardConfig)`, after `syncDerivedSettingsFields` has already mirrored the selected preset model/runtime values into active config
- no extra override layer is introduced

Keep unsaved changes behavior unchanged: draft only until `Save Settings`, then `Restart Backend`.

- [ ] **Step 4: Re-run the relevant tests**

Run: `npx tsx --test .\tests\dashboard-managed-presets.test.ts .\tests\settings-runtime.test.ts .\dashboard\tests\tab-components.test.tsx .\tests\settings-sections.test.ts`

Expected: `PASS`

- [ ] **Step 5: Commit Task 4**

```bash
git add dashboard/src/App.tsx dashboard/src/settings-runtime.ts dashboard/src/managed-llama-presets.ts dashboard/src/tabs/settings/ManagedLlamaSection.tsx dashboard/src/tabs/SettingsTab.tsx dashboard/src/settings-sections.ts dashboard/tests/tab-components.test.tsx tests/settings-sections.test.ts tests/dashboard-managed-presets.test.ts tests/settings-runtime.test.ts
git commit -m "feat: save named model runtime presets from settings"
```

### Task 5: Final verification

**Files:**
- Modify: none

- [ ] **Step 1: Run the focused regression suite**

Run: `npx tsx --test .\tests\dashboard-managed-presets.test.ts .\tests\settings-runtime.test.ts .\tests\settings-sections.test.ts .\dashboard\tests\tab-components.test.tsx`

Expected: `PASS`

- [ ] **Step 2: Build the project**

Run: `npm run build`

Expected: successful TypeScript and dashboard build

- [ ] **Step 3: Manual dashboard smoke check**

Run: `npm run start`

Verify in the browser:

1. `Settings` shows `Model Presets`
2. the preset dropdown switches the editor
3. `Add Preset` clones the current preset
4. `Preset name` and `Model` are editable
5. save persists the selected preset values
6. restart uses the saved preset only after save

- [ ] **Step 4: Commit verification-only follow-up if needed**

```bash
git add .
git commit -m "test: verify model runtime presets flow"
```

## Self-Review

- Spec coverage:
  - merged model plus llama settings page is covered by Tasks 2 and 3
  - custom named presets are covered by Tasks 1 and 3
  - save-then-restart behavior is covered by Tasks 1 and 4
- Placeholder scan:
  - file paths, test commands, and behavior targets are explicit
  - no `TODO` or unresolved placeholders remain
- Type consistency:
  - `Model` is introduced once on the managed preset/server config types and then reused by sync/helpers/UI

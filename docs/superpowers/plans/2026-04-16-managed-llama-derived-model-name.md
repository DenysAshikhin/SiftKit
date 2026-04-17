# Managed Llama Derived Model Name Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide the managed llama `Model` field and derive its value from the configured `.gguf` model path filename.

**Architecture:** Keep the change local to `ManagedLlamaSection` by deriving `preset.Model` inside the existing `ModelPath` change handler and by removing the separate rendered `Model` input. Extend the existing `tab-components` test to lock the hidden-field and derived-name behavior.

**Tech Stack:** React, TypeScript, `node:test`, `tsx`

---

### Task 1: Lock the desired managed llama behavior with a failing test

**Files:**
- Modify: `dashboard/tests/tab-components.test.tsx`
- Test: `dashboard/tests/tab-components.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
test('managed llama model name is derived from model path and model field is hidden', () => {
  let updatedPreset: DashboardManagedLlamaPreset | null = null;

  const markup = renderToStaticMarkup(
    <ManagedLlamaSection
      dashboardConfig={DASHBOARD_CONFIG}
      selectedManagedLlamaPreset={MANAGED_PRESET}
      settingsActionBusy={false}
      settingsPathPickerBusyTarget={null}
      renderField={(_, __, children) => <div>{children}</div>}
      updateSettingsDraft={() => {}}
      updateManagedLlamaDraft={(updater) => {
        updatedPreset = { ...MANAGED_PRESET };
        updater(updatedPreset);
      }}
      onAddManagedLlamaPreset={() => {}}
      onDeleteManagedLlamaPreset={() => {}}
      onPickManagedLlamaPath={async () => {}}
    />,
  );

  assert.doesNotMatch(markup, /value="test-model"/);
  assert.ok(updatedPreset);
  assert.equal(updatedPreset.Model, 'Qwen3.5-27B-Q4_K_M.gguf');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test dashboard/tests/tab-components.test.tsx`
Expected: FAIL because the `Model` input still renders and `Model` is not derived from `ModelPath`.

- [ ] **Step 3: Write minimal implementation**

```tsx
const nextModelPath = event.target.value.trim();
preset.ModelPath = nextModelPath || null;
preset.Model = nextModelPath.split(/[\\/]/).pop() || '';
```

Remove the standalone `renderField('model-presets', 'Model', ...)` block.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test dashboard/tests/tab-components.test.tsx`
Expected: PASS

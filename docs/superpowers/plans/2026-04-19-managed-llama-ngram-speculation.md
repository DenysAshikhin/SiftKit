# Managed Llama N-Gram Speculation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose llama.cpp n-gram speculative decoding controls in the SiftKit model preset UI and pass them through the managed llama launcher when enabled.

**Architecture:** Extend the existing managed llama preset/config shape with a small speculative settings block, keep normalization and preset syncing aligned with current managed preset behavior, and emit speculative server flags only when the checkbox is enabled. The settings UI will follow the existing pattern: one top-level toggle with advanced fields conditionally revealed.

**Tech Stack:** TypeScript, React, node:test, existing SiftKit config normalization and managed llama launcher code

---

### Task 1: Add failing coverage for speculative preset persistence and launcher args

**Files:**
- Modify: `tests/managed-llama-args.test.ts`
- Modify: `tests/dashboard-managed-presets.test.ts`
- Modify: `dashboard/tests/tab-components.test.tsx`

- [ ] **Step 1: Write the failing launcher arg tests**

```ts
test('buildManagedLlamaArgs omits speculative flags when speculative decoding is disabled', () => {
  const config = createConfig(0) as {
    Server: {
      LlamaCpp: {
        ModelPath: string | null;
        SpeculativeEnabled?: boolean;
      };
    };
  };
  config.Server.LlamaCpp.SpeculativeEnabled = false;

  const args = buildManagedLlamaArgs(getManagedLlamaConfig(config));

  assert.equal(args.includes('--spec-type'), false);
});

test('buildManagedLlamaArgs includes ngram speculative flags when enabled', () => {
  const config = createConfig(0) as {
    Server: {
      LlamaCpp: {
        ModelPath: string | null;
        SpeculativeEnabled?: boolean;
        SpeculativeType?: string;
        SpeculativeNgramSizeN?: number;
        SpeculativeNgramSizeM?: number;
        SpeculativeNgramMinHits?: number;
        SpeculativeDraftMax?: number;
        SpeculativeDraftMin?: number;
      };
    };
  };
  Object.assign(config.Server.LlamaCpp, {
    SpeculativeEnabled: true,
    SpeculativeType: 'ngram-map-k',
    SpeculativeNgramSizeN: 8,
    SpeculativeNgramSizeM: 16,
    SpeculativeNgramMinHits: 2,
    SpeculativeDraftMax: 16,
    SpeculativeDraftMin: 4,
  });

  const args = buildManagedLlamaArgs(getManagedLlamaConfig(config));

  assert.deepEqual(args.slice(args.indexOf('--spec-type'), args.indexOf('--spec-type') + 12), [
    '--spec-type', 'ngram-map-k',
    '--spec-ngram-size-n', '8',
    '--spec-ngram-size-m', '16',
    '--spec-ngram-min-hits', '2',
    '--draft-max', '16',
    '--draft-min', '4',
  ]);
});
```

- [ ] **Step 2: Write the failing preset sync tests**

```ts
test('applyManagedLlamaPresetSelection mirrors speculative settings from the selected preset', () => {
  const config = createConfig();
  Object.assign(config.Server.LlamaCpp.Presets[1], {
    SpeculativeEnabled: true,
    SpeculativeType: 'ngram-simple',
    SpeculativeNgramSizeN: 12,
    SpeculativeNgramSizeM: 32,
    SpeculativeNgramMinHits: 1,
    SpeculativeDraftMax: 32,
    SpeculativeDraftMin: 4,
  });

  applyManagedLlamaPresetSelection(config, 'qwen-27b');

  assert.equal(config.Server.LlamaCpp.SpeculativeEnabled, true);
  assert.equal(config.Server.LlamaCpp.SpeculativeType, 'ngram-simple');
  assert.equal(config.Server.LlamaCpp.SpeculativeDraftMax, 32);
});
```

- [ ] **Step 3: Write the failing UI render tests**

```ts
test('managed llama section hides speculative controls while the toggle is disabled', () => {
  const markup = renderToStaticMarkup(
    <ManagedLlamaSection ... selectedManagedLlamaPreset={{ ...preset, SpeculativeEnabled: false }} />
  );

  assert.match(markup, /Enable n-gram speculation/);
  assert.doesNotMatch(markup, /Speculative type/);
});

test('managed llama section shows speculative controls when the toggle is enabled', () => {
  const markup = renderToStaticMarkup(
    <ManagedLlamaSection ... selectedManagedLlamaPreset={{ ...preset, SpeculativeEnabled: true }} />
  );

  assert.match(markup, /Speculative type/);
  assert.match(markup, /SpeculativeDraftMax/);
});
```

- [ ] **Step 4: Run the targeted tests to verify they fail**

Run:

```powershell
npx tsx --test tests\managed-llama-args.test.ts tests\dashboard-managed-presets.test.ts dashboard\tests\tab-components.test.tsx
```

Expected: `FAIL` with missing speculative preset properties and missing speculative launcher/UI behavior.

### Task 2: Implement speculative fields across config and preset state

**Files:**
- Modify: `src/config/types.ts`
- Modify: `src/config/defaults.ts`
- Modify: `src/config/normalization.ts`
- Modify: `src/status-server/config-store.ts`
- Modify: `dashboard/src/types.ts`
- Modify: `dashboard/src/managed-llama-presets.ts`

- [ ] **Step 1: Add speculative fields to the shared config and dashboard types**

```ts
export type ManagedLlamaSpeculativeType =
  | 'ngram-simple'
  | 'ngram-map-k'
  | 'ngram-map-k4v'
  | 'ngram-mod'
  | 'ngram-cache';
```

Add:

```ts
SpeculativeEnabled?: boolean | null;
SpeculativeType?: ManagedLlamaSpeculativeType | null;
SpeculativeNgramSizeN?: number | null;
SpeculativeNgramSizeM?: number | null;
SpeculativeNgramMinHits?: number | null;
SpeculativeDraftMax?: number | null;
SpeculativeDraftMin?: number | null;
```

- [ ] **Step 2: Add default values for the new fields**

Use:

```ts
SpeculativeEnabled: false,
SpeculativeType: 'ngram-map-k',
SpeculativeNgramSizeN: 8,
SpeculativeNgramSizeM: 16,
SpeculativeNgramMinHits: 2,
SpeculativeDraftMax: 16,
SpeculativeDraftMin: 4,
```

- [ ] **Step 3: Add the fields to managed preset normalization and copy lists**

Extend:

```ts
MANAGED_LLAMA_DEFAULT_BACKFILL_KEYS
MANAGED_LLAMA_PRESET_KEYS
MANAGED_LLAMA_FIELD_KEYS
```

so presets round-trip, clone, and selection-copy preserve the speculative values.

- [ ] **Step 4: Run the focused preset/config tests**

Run:

```powershell
npx tsx --test tests\dashboard-managed-presets.test.ts
```

Expected: `PASS`

### Task 3: Implement launcher arg support for speculative decoding

**Files:**
- Modify: `src/status-server/managed-llama.ts`
- Modify: `tests/managed-llama-args.test.ts`

- [ ] **Step 1: Add conditional speculative flags to `buildManagedLlamaArgs`**

Add after the core sampling flags:

```ts
if (managed.SpeculativeEnabled) {
  args.push(
    '--spec-type', managed.SpeculativeType,
    '--spec-ngram-size-n', String(managed.SpeculativeNgramSizeN),
    '--spec-ngram-size-m', String(managed.SpeculativeNgramSizeM),
    '--spec-ngram-min-hits', String(managed.SpeculativeNgramMinHits),
    '--draft-max', String(managed.SpeculativeDraftMax),
    '--draft-min', String(managed.SpeculativeDraftMin),
  );
}
```

- [ ] **Step 2: Run the launcher tests**

Run:

```powershell
npx tsx --test tests\managed-llama-args.test.ts
```

Expected: `PASS`

### Task 4: Implement the settings UI toggle and conditional advanced fields

**Files:**
- Modify: `dashboard/src/tabs/settings/ManagedLlamaSection.tsx`
- Modify: `dashboard/tests/tab-components.test.tsx`

- [ ] **Step 1: Add the speculative toggle field**

Render:

```tsx
{renderField('model-presets', 'Enable n-gram speculation', (
  <label className="settings-live-toggle-control">
    <input
      type="checkbox"
      checked={selectedManagedLlamaPreset.SpeculativeEnabled}
      onChange={(event) => updateManagedLlamaDraft((preset) => { preset.SpeculativeEnabled = event.target.checked; })}
    />
    <span>{selectedManagedLlamaPreset.SpeculativeEnabled ? 'Enabled' : 'Disabled'}</span>
  </label>
))}
```

- [ ] **Step 2: Reveal advanced fields only when enabled**

Render conditionally:

```tsx
selectedManagedLlamaPreset.SpeculativeEnabled ? renderField(...)
```

for:
- `Speculative type`
- `SpeculativeNgramSizeN`
- `SpeculativeNgramSizeM`
- `SpeculativeNgramMinHits`
- `SpeculativeDraftMax`
- `SpeculativeDraftMin`

- [ ] **Step 3: Run the UI tests**

Run:

```powershell
npx tsx --test dashboard\tests\tab-components.test.tsx
```

Expected: `PASS`

### Task 5: Run the full targeted verification set

**Files:**
- Modify: `tests/managed-llama-args.test.ts`
- Modify: `tests/dashboard-managed-presets.test.ts`
- Modify: `dashboard/tests/tab-components.test.tsx`
- Modify: `src/config/types.ts`
- Modify: `src/config/defaults.ts`
- Modify: `src/config/normalization.ts`
- Modify: `src/status-server/config-store.ts`
- Modify: `src/status-server/managed-llama.ts`
- Modify: `dashboard/src/types.ts`
- Modify: `dashboard/src/managed-llama-presets.ts`
- Modify: `dashboard/src/tabs/settings/ManagedLlamaSection.tsx`

- [ ] **Step 1: Run all targeted tests together**

Run:

```powershell
npx tsx --test tests\managed-llama-args.test.ts tests\dashboard-managed-presets.test.ts dashboard\tests\tab-components.test.tsx
```

Expected: `PASS`

- [ ] **Step 2: Run additional config regression coverage**

Run:

```powershell
npx tsx --test tests\config.test.ts tests\runtime-db-config-cutover.test.ts
```

Expected: `PASS`

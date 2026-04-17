# Managed Llama NcpuMoe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `NcpuMoe` managed llama setting that is editable in the dashboard and emitted as `--n-cpu-moe` when non-zero.

**Architecture:** Extend the existing managed llama numeric field pipeline end-to-end rather than introducing a new abstraction. Keep behavior aligned with `Threads`: store the numeric value in presets/config, show it in the settings UI, default it to `0`, and omit the launcher flag when it is `0`.

**Tech Stack:** TypeScript, React, `node:test`, `tsx`

---

### Task 1: Lock the desired NcpuMoe behavior with failing tests

**Files:**
- Modify: `tests/dashboard-managed-presets.test.ts`
- Modify: `dashboard/tests/tab-components.test.tsx`
- Test: `tests/dashboard-managed-presets.test.ts`
- Test: `dashboard/tests/tab-components.test.tsx`

- [ ] **Step 1: Write the failing tests**

```ts
test('applyManagedLlamaPresetSelection mirrors NcpuMoe into the active server settings', () => {
  const config = createConfig();
  Object.assign(config.Server.LlamaCpp.Presets[1], { NcpuMoe: 8 });

  applyManagedLlamaPresetSelection(config, 'qwen-27b');

  assert.equal(config.Server.LlamaCpp.NcpuMoe, 8);
});
```

```tsx
assert.match(markup, /NcpuMoe/);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/dashboard-managed-presets.test.ts dashboard/tests/tab-components.test.tsx`
Expected: FAIL because `NcpuMoe` does not exist in presets/config yet and the dashboard does not render the field.

- [ ] **Step 3: Write minimal implementation**

```ts
if (managed.NcpuMoe !== 0) {
  args.push('--n-cpu-moe', String(managed.NcpuMoe));
}
```

```tsx
{renderField('model-presets', 'NcpuMoe', (
  <input type="number" value={selectedManagedLlamaPreset.NcpuMoe} onChange={(event) => updateManagedLlamaDraft((preset) => { preset.NcpuMoe = parseIntegerInput(event.target.value, preset.NcpuMoe); })} />
))}
```

Also add the field to the managed llama dashboard/backend types, defaults, config getter, and normalization/backfill key lists.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/dashboard-managed-presets.test.ts dashboard/tests/tab-components.test.tsx`
Expected: PASS

### Task 2: Verify launcher arg behavior and compile cleanly

**Files:**
- Modify: `tests/managed-llama-blank-startup.test.ts`
- Modify: `src/status-server/managed-llama.ts`
- Test: `tests/managed-llama-blank-startup.test.ts`

- [ ] **Step 1: Write the failing test**

```js
test('default managed llama config leaves NcpuMoe disabled', () => {
  const config = getDefaultConfig();
  assert.equal(config.Server.LlamaCpp.NcpuMoe, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test tests/managed-llama-blank-startup.test.ts`
Expected: FAIL because the default config does not include `NcpuMoe`.

- [ ] **Step 3: Write minimal implementation**

Add `NcpuMoe: 0` to the managed llama default config and preserve it through config load/store and arg building.

- [ ] **Step 4: Run verification**

Run: `npm test tests/managed-llama-blank-startup.test.ts tests/dashboard-managed-presets.test.ts dashboard/tests/tab-components.test.tsx`
Expected: PASS

Run: `npm run build`
Expected: PASS

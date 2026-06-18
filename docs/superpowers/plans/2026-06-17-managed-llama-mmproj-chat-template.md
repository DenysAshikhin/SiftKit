# Managed llama.cpp mmproj + custom chat-template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-preset managed llama.cpp launcher settings for a multimodal projector (`--mmproj`), its CPU/GPU offload toggle (`--no-mmproj-offload`), and a custom chat template (`--chat-template-file`).

**Architecture:** Three new fields on `ManagedLlamaSettings` flow through the existing managed-llama pipeline: config types → defaults → normalization → `buildManagedLlamaArgs` (CLI flags) → spawn-time existence validation → native file picker → dashboard settings UI. Image *sending* is out of scope; this only configures the launched `llama-server`. The runtime HTTP client and launch snapshot are untouched.

**Tech Stack:** TypeScript (Node), `node:test` + `node:assert/strict` for backend, React + `renderToStaticMarkup` for dashboard component tests.

Spec: `docs/superpowers/specs/2026-06-17-managed-llama-mmproj-chat-template-design.md`

---

## File Structure

**Modify (backend):**
- `src/config/types.ts` — add three fields to `ManagedLlamaSettings`.
- `src/config/defaults.ts` — default values in the managed preset literal.
- `src/config/normalization.ts` — `ManagedLlamaConfig` type + `resolveManagedLlamaSettings`.
- `src/status-server/managed-llama.ts` — `buildManagedLlamaArgs` flags + spawn-time existence guard + new `assertManagedLlamaFileExists` helper.
- `src/status-server/file-picker.ts` — two new picker targets + dialog options.
- `src/status-server/routes/dashboard.ts` — accept new picker targets in route guard.

**Modify (dashboard):**
- `dashboard/src/tabs/settings/ManagedLlamaSection.tsx` — mmproj/chat-template fields + offload checkbox + widened picker-target union.
- `dashboard/src/App.tsx` — widened picker-target union + handler branches.

**Modify (tests):**
- `tests/config.test.ts`, `tests/managed-llama-args.test.ts`, `tests/dashboard-managed-file-picker.test.ts`, `dashboard/tests/tab-components.test.tsx`.

**Field/flag contract (used across all tasks):**

| Field | Type | Default | Flag |
|---|---|---|---|
| `MmprojPath` | `string \| null` | `null` | `--mmproj <path>` when set |
| `MmprojOffloadToGpu` | `boolean` | `false` | `--no-mmproj-offload` when `MmprojPath` set **and** `false` |
| `ChatTemplateFilePath` | `string \| null` | `null` | `--chat-template-file <path>` when set |

New picker targets: `'managed-llama-mmproj'`, `'managed-llama-chat-template'`.

---

## Task 1: Config schema, defaults, normalization

**Files:**
- Modify: `src/config/types.ts:46-92` (`ManagedLlamaSettings`)
- Modify: `src/config/defaults.ts:31-73` (managed preset literal)
- Modify: `src/config/normalization.ts:51-97` (`ManagedLlamaConfig` type), `:303-359` (`resolveManagedLlamaSettings`)
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/config.test.ts` (use the existing import of `getDefaultConfig`/`normalizeConfigObject` already present in that file; if a helper to read the active preset exists, reuse it — otherwise inline as below):

```ts
test('getDefaultConfig seeds mmproj + chat-template launcher defaults', () => {
  const llama = getDefaultConfig().Server.LlamaCpp;
  const preset = llama.Presets.find((p) => p.id === llama.ActivePresetId) ?? llama.Presets[0];

  assert.equal(preset.MmprojPath, null);
  assert.equal(preset.MmprojOffloadToGpu, false);
  assert.equal(preset.ChatTemplateFilePath, null);
});

test('normalizeConfigObject preserves and trims mmproj + chat-template fields', () => {
  const base = getDefaultConfig();
  const llama = base.Server.LlamaCpp;
  const preset = llama.Presets.find((p) => p.id === llama.ActivePresetId) ?? llama.Presets[0];
  preset.MmprojPath = '  D:\\models\\mmproj.gguf  ';
  preset.MmprojOffloadToGpu = true;
  preset.ChatTemplateFilePath = '  D:\\templates\\chat.jinja  ';

  const normalized = normalizeConfigObject(base);
  const normLlama = normalized.Server.LlamaCpp;
  const normPreset = normLlama.Presets.find((p) => p.id === normLlama.ActivePresetId) ?? normLlama.Presets[0];

  assert.equal(normPreset.MmprojPath, 'D:\\models\\mmproj.gguf');
  assert.equal(normPreset.MmprojOffloadToGpu, true);
  assert.equal(normPreset.ChatTemplateFilePath, 'D:\\templates\\chat.jinja');
});
```

If `getDefaultConfig` / `normalizeConfigObject` are not already imported in `tests/config.test.ts`, add them from `../src/status-server/config-store` (match the import style already used in that file).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/config.test.ts`
Expected: FAIL — TS error "Property 'MmprojPath' does not exist on type ..." and/or assertion failures.

- [ ] **Step 3: Add the fields to `ManagedLlamaSettings`**

In `src/config/types.ts`, inside the `ManagedLlamaSettings` type, after `VerboseLogging: boolean;` (line ~91) add:

```ts
  MmprojPath: string | null;
  MmprojOffloadToGpu: boolean;
  ChatTemplateFilePath: string | null;
```

- [ ] **Step 4: Add defaults**

In `src/config/defaults.ts`, in the managed preset object literal, after `VerboseLogging: false,` (line ~72) add:

```ts
    MmprojPath: null,
    MmprojOffloadToGpu: false,
    ChatTemplateFilePath: null,
```

- [ ] **Step 5: Extend the normalization type**

In `src/config/normalization.ts`, in the `ManagedLlamaConfig`/settings type (the block ending `VerboseLogging: boolean;` at line ~96) add:

```ts
  MmprojPath: string | null;
  MmprojOffloadToGpu: boolean;
  ChatTemplateFilePath: string | null;
```

- [ ] **Step 6: Normalize the values**

In `resolveManagedLlamaSettings`, after `VerboseLogging: Boolean(input.VerboseLogging),` (line ~358) add:

```ts
    MmprojPath: getNullableTrimmedString(input.MmprojPath) || getNullableTrimmedString(defaults.MmprojPath),
    MmprojOffloadToGpu: Boolean(input.MmprojOffloadToGpu),
    ChatTemplateFilePath: getNullableTrimmedString(input.ChatTemplateFilePath)
      || getNullableTrimmedString(defaults.ChatTemplateFilePath),
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx tsx --test tests/config.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/config/types.ts src/config/defaults.ts src/config/normalization.ts tests/config.test.ts
git commit -m "feat(config): add managed llama mmproj + chat-template settings"
```

---

## Task 2: Emit launcher flags in buildManagedLlamaArgs

**Files:**
- Modify: `src/status-server/managed-llama.ts:653-698` (`buildManagedLlamaArgs`)
- Test: `tests/managed-llama-args.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/managed-llama-args.test.ts` (reuses the `createConfig` / `activePreset` / `getManagedLlamaConfig` helpers already at the top of the file):

```ts
test('buildManagedLlamaArgs emits --mmproj and --no-mmproj-offload when mmproj is set and offload is off', () => {
  const config = createConfig(0);
  Object.assign(activePreset(config), {
    MmprojPath: 'D:\\models\\mmproj.gguf',
    MmprojOffloadToGpu: false,
  });

  const args = buildManagedLlamaArgs(getManagedLlamaConfig(config));
  const mmprojIndex = args.indexOf('--mmproj');

  assert.deepEqual(args.slice(mmprojIndex, mmprojIndex + 2), ['--mmproj', 'D:\\models\\mmproj.gguf']);
  assert.equal(args.includes('--no-mmproj-offload'), true);
});

test('buildManagedLlamaArgs omits --no-mmproj-offload when offload to GPU is enabled', () => {
  const config = createConfig(0);
  Object.assign(activePreset(config), {
    MmprojPath: 'D:\\models\\mmproj.gguf',
    MmprojOffloadToGpu: true,
  });

  const args = buildManagedLlamaArgs(getManagedLlamaConfig(config));

  assert.equal(args.includes('--mmproj'), true);
  assert.equal(args.includes('--no-mmproj-offload'), false);
});

test('buildManagedLlamaArgs omits mmproj flags entirely when no mmproj path is set', () => {
  const config = createConfig(0);
  Object.assign(activePreset(config), { MmprojPath: null, MmprojOffloadToGpu: false });

  const args = buildManagedLlamaArgs(getManagedLlamaConfig(config));

  assert.equal(args.includes('--mmproj'), false);
  assert.equal(args.includes('--no-mmproj-offload'), false);
});

test('buildManagedLlamaArgs emits --chat-template-file when a template path is set', () => {
  const config = createConfig(0);
  activePreset(config).ChatTemplateFilePath = 'D:\\templates\\chat.jinja';

  const args = buildManagedLlamaArgs(getManagedLlamaConfig(config));
  const idx = args.indexOf('--chat-template-file');

  assert.deepEqual(args.slice(idx, idx + 2), ['--chat-template-file', 'D:\\templates\\chat.jinja']);
});

test('buildManagedLlamaArgs omits --chat-template-file when unset', () => {
  const config = createConfig(0);
  activePreset(config).ChatTemplateFilePath = null;

  const args = buildManagedLlamaArgs(getManagedLlamaConfig(config));

  assert.equal(args.includes('--chat-template-file'), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/managed-llama-args.test.ts`
Expected: FAIL — `--mmproj` / `--chat-template-file` not found in args.

- [ ] **Step 3: Emit the flags**

In `src/status-server/managed-llama.ts`, inside `buildManagedLlamaArgs`, immediately before `return args;` (after the `if (managed.VerboseLogging)` block, line ~696) add:

```ts
  if (managed.MmprojPath) {
    args.push('--mmproj', managed.MmprojPath);
    if (!managed.MmprojOffloadToGpu) {
      args.push('--no-mmproj-offload');
    }
  }
  if (managed.ChatTemplateFilePath) {
    args.push('--chat-template-file', managed.ChatTemplateFilePath);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/managed-llama-args.test.ts`
Expected: PASS (all new + existing tests).

- [ ] **Step 5: Commit**

```bash
git add src/status-server/managed-llama.ts tests/managed-llama-args.test.ts
git commit -m "feat(managed-llama): emit --mmproj/--no-mmproj-offload/--chat-template-file flags"
```

---

## Task 3: Validate aux file existence at spawn time

**Files:**
- Modify: `src/status-server/managed-llama.ts:774-806` (`getManagedExecutableInvocation`) + new exported helper near `resolveManagedExecutablePath` (line ~524)
- Test: `tests/managed-llama-args.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/managed-llama-args.test.ts`. Add these imports at the top of the file (alongside the existing `node:fs`/`node:os`/`node:path` usage — add whichever are not already imported):

```ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
```

Add `assertManagedLlamaFileExists` to the existing import from `../src/status-server/managed-llama`. Then:

```ts
test('assertManagedLlamaFileExists passes for an existing file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-mmproj-'));
  const filePath = path.join(dir, 'mmproj.gguf');
  fs.writeFileSync(filePath, 'x');

  assert.doesNotThrow(() => assertManagedLlamaFileExists('mmproj', filePath));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('assertManagedLlamaFileExists throws a clear error for a missing file', () => {
  assert.throws(
    () => assertManagedLlamaFileExists('chat template', 'D:\\nope\\missing.jinja'),
    /Configured llama\.cpp chat template file does not exist: D:\\nope\\missing\.jinja/u,
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/managed-llama-args.test.ts`
Expected: FAIL — `assertManagedLlamaFileExists is not a function` / not exported.

- [ ] **Step 3: Add the helper**

In `src/status-server/managed-llama.ts`, after `resolveManagedExecutablePath` (ends line ~531) add:

```ts
export function assertManagedLlamaFileExists(kind: 'mmproj' | 'chat template', filePath: string): void {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Configured llama.cpp ${kind} file does not exist: ${filePath}`);
  }
}
```

- [ ] **Step 4: Call the helper at spawn time**

In `getManagedExecutableInvocation`, after the existing `ModelPath` existence check (the `if (!managed.ModelPath || !fs.existsSync(managed.ModelPath))` block, ends line ~784) and before `const extension = ...` add:

```ts
  if (managed.MmprojPath) {
    assertManagedLlamaFileExists('mmproj', managed.MmprojPath);
  }
  if (managed.ChatTemplateFilePath) {
    assertManagedLlamaFileExists('chat template', managed.ChatTemplateFilePath);
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsx --test tests/managed-llama-args.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/status-server/managed-llama.ts tests/managed-llama-args.test.ts
git commit -m "feat(managed-llama): fail loudly when configured mmproj/chat-template files are missing"
```

---

## Task 4: File picker targets + route guard

**Files:**
- Modify: `src/status-server/file-picker.ts:4` (`ManagedFilePickerTarget`), `:103-119` (`getManagedFilePickerDialogOptions`)
- Modify: `src/status-server/routes/dashboard.ts:973-977` (target guard)
- Test: `tests/dashboard-managed-file-picker.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/dashboard-managed-file-picker.test.ts`:

```ts
test('getManagedFilePickerDialogOptions configures the mmproj picker filters', () => {
  const options = getManagedFilePickerDialogOptions('managed-llama-mmproj', null);

  assert.equal(options.title, 'Select mmproj file');
  assert.equal(options.filter, 'GGUF files (*.gguf)|*.gguf|All files (*.*)|*.*');
  assert.equal(options.initialPath, null);
});

test('getManagedFilePickerDialogOptions configures the chat-template picker filters', () => {
  const options = getManagedFilePickerDialogOptions(
    'managed-llama-chat-template',
    'D:\\templates\\chat.jinja',
  );

  assert.equal(options.title, 'Select chat template');
  assert.equal(options.filter, 'Jinja/JSON templates (*.jinja;*.json)|*.jinja;*.json|All files (*.*)|*.*');
  assert.equal(options.initialPath, 'D:\\templates\\chat.jinja');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/dashboard-managed-file-picker.test.ts`
Expected: FAIL — TS error on the new target literals and/or wrong title/filter (the current fallthrough returns the GGUF-model options).

- [ ] **Step 3: Widen the target union**

In `src/status-server/file-picker.ts`, replace the `ManagedFilePickerTarget` type (line 4):

```ts
export type ManagedFilePickerTarget =
  | 'managed-llama-executable'
  | 'managed-llama-model'
  | 'managed-llama-mmproj'
  | 'managed-llama-chat-template';
```

- [ ] **Step 4: Add the dialog options**

In `getManagedFilePickerDialogOptions`, before the final `return { ... GGUF models ... }` fallthrough (line ~114) add:

```ts
  if (target === 'managed-llama-mmproj') {
    return {
      title: 'Select mmproj file',
      filter: 'GGUF files (*.gguf)|*.gguf|All files (*.*)|*.*',
      initialPath,
    };
  }
  if (target === 'managed-llama-chat-template') {
    return {
      title: 'Select chat template',
      filter: 'Jinja/JSON templates (*.jinja;*.json)|*.jinja;*.json|All files (*.*)|*.*',
      initialPath,
    };
  }
```

- [ ] **Step 5: Widen the route guard**

In `src/status-server/routes/dashboard.ts`, replace the guard at line ~974:

```ts
    if (
      target !== 'managed-llama-executable'
      && target !== 'managed-llama-model'
      && target !== 'managed-llama-mmproj'
      && target !== 'managed-llama-chat-template'
    ) {
      sendJson(res, 400, { error: 'Expected a valid file picker target.' });
      return;
    }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx tsx --test tests/dashboard-managed-file-picker.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/status-server/file-picker.ts src/status-server/routes/dashboard.ts tests/dashboard-managed-file-picker.test.ts
git commit -m "feat(file-picker): add mmproj and chat-template picker targets"
```

---

## Task 5: Dashboard UI fields + offload checkbox

**Files:**
- Modify: `dashboard/src/tabs/settings/ManagedLlamaSection.tsx` (props type lines 22-34; fields after "Model path" block lines ~185-199)
- Modify: `dashboard/src/App.tsx:152` (busy-target state), `:822-846` (`onPickManagedLlamaPath`)
- Test: `dashboard/tests/tab-components.test.tsx` (fixture at line 134; add render assertions)

- [ ] **Step 1: Write the failing tests**

First, in `dashboard/tests/tab-components.test.tsx`, add the three fields to the `MANAGED_PRESET` fixture (after `VerboseLogging: false,` at line ~182) so it satisfies `DashboardManagedLlamaPreset`:

```ts
  MmprojPath: null,
  MmprojOffloadToGpu: false,
  ChatTemplateFilePath: null,
```

Then add these tests (mirror the existing `capturedFields` render pattern used elsewhere in the file):

```ts
test('ManagedLlamaSection renders mmproj and chat-template path fields in managed mode', () => {
  const capturedFields: string[] = [];
  renderToStaticMarkup(
    <ManagedLlamaSection
      dashboardConfig={DASHBOARD_CONFIG}
      selectedManagedLlamaPreset={MANAGED_PRESET}
      settingsActionBusy={false}
      settingsPathPickerBusyTarget={null}
      renderField={(_, label, children) => { capturedFields.push(label); return <div>{children}</div>; }}
      updateSettingsDraft={() => {}}
      updateManagedLlamaDraft={() => {}}
      onAddManagedLlamaPreset={() => {}}
      onDeleteManagedLlamaPreset={() => {}}
      onPickManagedLlamaPath={async () => {}}
      onTestLlamaCppBaseUrl={async () => {}}
    />,
  );

  assert.equal(capturedFields.includes('mmproj path'), true);
  assert.equal(capturedFields.includes('Custom chat template (.jinja)'), true);
  // Offload checkbox hidden until a mmproj path is set.
  assert.equal(capturedFields.includes('Offload mmproj to GPU'), false);
});

test('ManagedLlamaSection shows the offload checkbox once a mmproj path is set', () => {
  const capturedFields: string[] = [];
  renderToStaticMarkup(
    <ManagedLlamaSection
      dashboardConfig={DASHBOARD_CONFIG}
      selectedManagedLlamaPreset={{ ...MANAGED_PRESET, MmprojPath: 'D:\\models\\mmproj.gguf' }}
      settingsActionBusy={false}
      settingsPathPickerBusyTarget={null}
      renderField={(_, label, children) => { capturedFields.push(label); return <div>{children}</div>; }}
      updateSettingsDraft={() => {}}
      updateManagedLlamaDraft={() => {}}
      onAddManagedLlamaPreset={() => {}}
      onDeleteManagedLlamaPreset={() => {}}
      onPickManagedLlamaPath={async () => {}}
      onTestLlamaCppBaseUrl={async () => {}}
    />,
  );

  assert.equal(capturedFields.includes('Offload mmproj to GPU'), true);
});

test('ManagedLlamaSection hides mmproj fields when an external server is enabled', () => {
  const capturedFields: string[] = [];
  renderToStaticMarkup(
    <ManagedLlamaSection
      dashboardConfig={DASHBOARD_CONFIG}
      selectedManagedLlamaPreset={{ ...MANAGED_PRESET, ExternalServerEnabled: true, MmprojPath: 'D:\\models\\mmproj.gguf' }}
      settingsActionBusy={false}
      settingsPathPickerBusyTarget={null}
      renderField={(_, label, children) => { capturedFields.push(label); return <div>{children}</div>; }}
      updateSettingsDraft={() => {}}
      updateManagedLlamaDraft={() => {}}
      onAddManagedLlamaPreset={() => {}}
      onDeleteManagedLlamaPreset={() => {}}
      onPickManagedLlamaPath={async () => {}}
      onTestLlamaCppBaseUrl={async () => {}}
    />,
  );

  assert.equal(capturedFields.includes('mmproj path'), false);
  assert.equal(capturedFields.includes('Custom chat template (.jinja)'), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from repo root): `npm --prefix dashboard test`
(If the dashboard suite uses a different command, use the `test` script defined in `dashboard/package.json`.)
Expected: FAIL — fields not captured; also a TS error until the props union is widened in Step 3.

- [ ] **Step 3: Widen the picker-target union in the section props**

In `dashboard/src/tabs/settings/ManagedLlamaSection.tsx`, update both occurrences of the union (`settingsPathPickerBusyTarget` field at line ~26 and the `onPickManagedLlamaPath` param at line ~32):

```ts
  settingsPathPickerBusyTarget: 'ExecutablePath' | 'ModelPath' | 'MmprojPath' | 'ChatTemplateFilePath' | null;
```
```ts
  onPickManagedLlamaPath(target: 'ExecutablePath' | 'ModelPath' | 'MmprojPath' | 'ChatTemplateFilePath'): Promise<void>;
```

- [ ] **Step 4: Add the UI fields**

In `ManagedLlamaSection.tsx`, immediately after the "Model path (.gguf)" `renderField(...)` block (closes with `)) : null}` at line ~199) add:

```tsx
      {!selectedManagedLlamaPreset.ExternalServerEnabled ? renderField('model-presets', 'mmproj path', (
        <div className="settings-live-nav-control">
          <input
            value={selectedManagedLlamaPreset.MmprojPath || ''}
            onChange={(event) => updateManagedLlamaDraft((preset) => {
              const value = event.target.value.trim();
              preset.MmprojPath = value || null;
            })}
          />
          <button type="button" onClick={() => { void onPickManagedLlamaPath('MmprojPath'); }} disabled={settingsActionBusy}>
            {settingsPathPickerBusyTarget === 'MmprojPath' ? 'Opening...' : 'Browse...'}
          </button>
        </div>
      )) : null}
      {!selectedManagedLlamaPreset.ExternalServerEnabled && selectedManagedLlamaPreset.MmprojPath ? renderField('model-presets', 'Offload mmproj to GPU', (
        <label className="settings-live-toggle-control">
          <input
            type="checkbox"
            checked={selectedManagedLlamaPreset.MmprojOffloadToGpu}
            onChange={(event) => updateManagedLlamaDraft((preset) => { preset.MmprojOffloadToGpu = event.target.checked; })}
          />
          <span>{selectedManagedLlamaPreset.MmprojOffloadToGpu ? 'GPU' : 'CPU (--no-mmproj-offload)'}</span>
        </label>
      )) : null}
      {!selectedManagedLlamaPreset.ExternalServerEnabled ? renderField('model-presets', 'Custom chat template (.jinja)', (
        <div className="settings-live-nav-control">
          <input
            value={selectedManagedLlamaPreset.ChatTemplateFilePath || ''}
            onChange={(event) => updateManagedLlamaDraft((preset) => {
              const value = event.target.value.trim();
              preset.ChatTemplateFilePath = value || null;
            })}
          />
          <button type="button" onClick={() => { void onPickManagedLlamaPath('ChatTemplateFilePath'); }} disabled={settingsActionBusy}>
            {settingsPathPickerBusyTarget === 'ChatTemplateFilePath' ? 'Opening...' : 'Browse...'}
          </button>
        </div>
      )) : null}
```

- [ ] **Step 5: Widen the App.tsx picker state and handler**

In `dashboard/src/App.tsx` line ~152, widen the busy-target state type:

```ts
  const [settingsPathPickerBusyTarget, setSettingsPathPickerBusyTarget] = useState<'ExecutablePath' | 'ModelPath' | 'MmprojPath' | 'ChatTemplateFilePath' | null>(null);
```

Replace the `onPickManagedLlamaPath` function body (lines ~822-846) so it resolves the initial path, picker kind, and draft write for all four targets:

```ts
  async function onPickManagedLlamaPath(target: 'ExecutablePath' | 'ModelPath' | 'MmprojPath' | 'ChatTemplateFilePath'): Promise<void> {
    if (!dashboardConfig || !selectedManagedLlamaPreset) {
      return;
    }
    const initialPathByTarget = {
      ExecutablePath: selectedManagedLlamaPreset.ExecutablePath,
      ModelPath: selectedManagedLlamaPreset.ModelPath,
      MmprojPath: selectedManagedLlamaPreset.MmprojPath,
      ChatTemplateFilePath: selectedManagedLlamaPreset.ChatTemplateFilePath,
    };
    const pickerKindByTarget = {
      ExecutablePath: 'managed-llama-executable',
      ModelPath: 'managed-llama-model',
      MmprojPath: 'managed-llama-mmproj',
      ChatTemplateFilePath: 'managed-llama-chat-template',
    } as const;
    setSettingsPathPickerBusyTarget(target);
    setSettingsError(null);
    try {
      const response = await pickManagedFile(pickerKindByTarget[target], initialPathByTarget[target]);
      if (response.cancelled || !response.path) {
        return;
      }
      updateManagedLlamaDraft((preset) => {
        if (target === 'ExecutablePath') {
          preset.ExecutablePath = response.path;
          return;
        }
        if (target === 'ModelPath') {
          preset.ModelPath = response.path;
          preset.Model = deriveRuntimeModelId(preset.ModelPath) || preset.Model;
          return;
        }
        if (target === 'MmprojPath') {
          preset.MmprojPath = response.path;
          return;
        }
        preset.ChatTemplateFilePath = response.path;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSettingsError(message);
    } finally {
      setSettingsPathPickerBusyTarget(null);
    }
  }
```

Note: confirm the `catch`/`finally` bodies match the original (lines 847+) — preserve the original error-handling and `setSettingsPathPickerBusyTarget(null)` reset exactly; only the target/kind/draft branching changes. The `pickManagedFile` kind argument type derives from `ManagedFilePickerTarget`, so no extra cast is needed.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm --prefix dashboard test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/tabs/settings/ManagedLlamaSection.tsx dashboard/src/App.tsx dashboard/tests/tab-components.test.tsx
git commit -m "feat(dashboard): mmproj + chat-template settings fields and offload toggle"
```

---

## Task 6: Full typecheck + test sweep

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the backend and dashboard**

Run: `npx tsc --noEmit -p tsconfig.json` and `npx tsc --noEmit -p dashboard/tsconfig.json`
Expected: no errors. (Use the project's actual typecheck scripts if they differ — check `package.json`.)

- [ ] **Step 2: Run the affected test suites**

Run:
```bash
npx tsx --test tests/config.test.ts tests/managed-llama-args.test.ts tests/dashboard-managed-file-picker.test.ts
npm --prefix dashboard test
```
Expected: all PASS.

- [ ] **Step 3: Run the full backend test suite to catch fixture regressions**

Run the repo's full test command (check `package.json` `scripts.test`, e.g. `npm test`).
Expected: PASS. If any other test constructs a full `ManagedLlamaSettings`/preset literal, add the three new fields (`MmprojPath: null`, `MmprojOffloadToGpu: false`, `ChatTemplateFilePath: null`) to satisfy the type.

- [ ] **Step 4: Commit any fixture fixes**

```bash
git add -A
git commit -m "test: backfill mmproj/chat-template fields in managed-llama fixtures"
```

---

## Self-Review Notes

- **Spec coverage:** `--mmproj` (Task 2), `--no-mmproj-offload` default-CPU toggle (Task 1 default + Task 2 emission + Task 5 checkbox), `--chat-template-file` (Task 2), file pickers (Task 4), UI gating to managed mode (Task 5), missing-file fail-loud (Task 3), normalization/defaults (Task 1). All spec sections mapped.
- **Type consistency:** field names `MmprojPath` / `MmprojOffloadToGpu` / `ChatTemplateFilePath` and picker targets `managed-llama-mmproj` / `managed-llama-chat-template` are used identically across every task. Helper `assertManagedLlamaFileExists(kind, filePath)` signature matches between Task 3 definition and call site.
- **Out of scope (confirmed):** no image-content changes to the request pipeline; `RuntimeLlamaCppConfig` and the launch snapshot are deliberately untouched.

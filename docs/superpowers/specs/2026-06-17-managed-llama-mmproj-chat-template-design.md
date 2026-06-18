# Managed llama.cpp: mmproj + custom chat-template support

Date: 2026-06-17
Status: Approved design (pending spec review)

## Goal

Add per-preset managed llama.cpp launcher settings so a vision-capable
(multimodal) model and/or a custom chat template can be loaded:

1. **mmproj file** — multimodal projector (`--mmproj <path>`).
2. **mmproj GPU offload toggle** — by default keep the projector on CPU
   (`--no-mmproj-offload`); a checkbox can move it to GPU.
3. **Custom chat template file** — `--chat-template-file <path>`.

**Out of scope:** sending images in summary/repo-search requests. This change
only configures the launched `llama-server`; SiftKit's own request pipeline is
unchanged. Image-content support may be added later as a separate effort.

All three settings are launcher-only and therefore relevant only when
`ExternalServerEnabled` is `false` (same gating as `ExecutablePath` /
`ModelPath`).

## Config schema

Add three fields to `ManagedLlamaSettings` (`src/config/types.ts`). They
propagate to the dashboard preset type automatically via the existing
`DashboardManagedLlamaPreset` re-export.

| Field | Type | Default | Effect |
|---|---|---|---|
| `MmprojPath` | `string \| null` | `null` | emits `--mmproj <path>` when set |
| `MmprojOffloadToGpu` | `boolean` | `false` | when `MmprojPath` set **and** this is `false`, emits `--no-mmproj-offload` |
| `ChatTemplateFilePath` | `string \| null` | `null` | emits `--chat-template-file <path>` when set |

### Defaults (`src/config/defaults.ts`)
`MmprojPath: null`, `MmprojOffloadToGpu: false`, `ChatTemplateFilePath: null`.

### Normalization (`src/config/normalization.ts`)
- Add the three fields to the `ManagedLlamaConfig` type.
- In `resolveManagedLlamaSettings`:
  - `MmprojPath`: `getNullableTrimmedString(input.MmprojPath) || getNullableTrimmedString(defaults.MmprojPath)` (mirrors `ModelPath`).
  - `ChatTemplateFilePath`: same pattern.
  - `MmprojOffloadToGpu`: `Boolean(input.MmprojOffloadToGpu)` (mirrors `VerboseLogging`).

`RuntimeLlamaCppConfig` and the runtime launch snapshot
(`config-store.ts` → `Runtime.LlamaCpp`) are **not** modified — these flags are
launch-only and the runtime HTTP client does not need them.

## Arg building + launch validation

`src/status-server/managed-llama.ts`

### `buildManagedLlamaArgs`
Append after the existing optional flags (`-fa`, `--verbose`):

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

`--no-mmproj-offload` is never emitted without `--mmproj`.

### `getManagedExecutableInvocation`
Add existence guards mirroring the existing `ModelPath` check — throw a clear
error when a path is configured but missing:

- `MmprojPath` set and not `fs.existsSync` → `Configured llama.cpp mmproj file does not exist: <path>`
- `ChatTemplateFilePath` set and not `fs.existsSync` → `Configured llama.cpp chat template file does not exist: <path>`

## File picker

`src/status-server/file-picker.ts`

Extend `ManagedFilePickerTarget`:
`'managed-llama-executable' | 'managed-llama-model' | 'managed-llama-mmproj' | 'managed-llama-chat-template'`.

`getManagedFilePickerDialogOptions`:
- `managed-llama-mmproj` → title `Select mmproj file`, filter `GGUF files (*.gguf)|*.gguf|All files (*.*)|*.*`.
- `managed-llama-chat-template` → title `Select chat template`, filter `Jinja/JSON templates (*.jinja;*.json)|*.jinja;*.json|All files (*.*)|*.*`.

`src/status-server/routes/dashboard.ts`: accept the two new target values in
the picker route validation.

## Dashboard UI

`dashboard/src/tabs/settings/ManagedLlamaSection.tsx`,
`dashboard/src/App.tsx`

- Widen the picker-target union from `'ExecutablePath' | 'ModelPath'` to include
  `'MmprojPath' | 'ChatTemplateFilePath'` in:
  - `App.tsx`: `settingsPathPickerBusyTarget` state, `onPickManagedLlamaPath`
    (initial-path selector, `pickManagedFile` kind map, draft writer).
  - `ManagedLlamaSection` props (`settingsPathPickerBusyTarget`,
    `onPickManagedLlamaPath`).
- Within the existing `!ExternalServerEnabled` region (after "Model path"):
  - **mmproj path** input + Browse button (target `MmprojPath`).
  - **Custom chat template (.jinja)** input + Browse button
    (target `ChatTemplateFilePath`).
- **Offload mmproj to GPU** checkbox — rendered only when `MmprojPath` is set
  (gated like "Reasoning content"). Unchecked (default) ⇒ CPU
  (`--no-mmproj-offload`); checked ⇒ GPU offload.

## Testing (TDD — tests written before implementation)

- `tests/managed-llama-args.test.ts`
  - mmproj set + offload off ⇒ `--mmproj <path>` **and** `--no-mmproj-offload`.
  - mmproj set + offload on ⇒ `--mmproj <path>`, **no** `--no-mmproj-offload`.
  - mmproj unset (offload either value) ⇒ neither flag.
  - chat-template set ⇒ `--chat-template-file <path>`; unset ⇒ absent.
- `tests/config.test.ts` — defaults present; normalize round-trip preserves the
  three fields; trims/blank handling for the path fields.
- file-picker test — dialog options (title + filter) for the two new targets.
- `dashboard/tests/tab-components.test.tsx` — mmproj/chat-template fields render
  under managed mode; offload checkbox hidden until `MmprojPath` is set; hidden
  when `ExternalServerEnabled`.

## Error handling summary

- Missing configured mmproj/chat-template files fail loudly at spawn with an
  explicit message (consistent with `ModelPath`/`ExecutablePath`).
- No silent fallbacks; an unset path simply omits its flag.

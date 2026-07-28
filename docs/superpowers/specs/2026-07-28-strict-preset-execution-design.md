# Strict Preset Execution Design

## Goal

Make preset execution deterministic: every run uses one explicit preset exactly once, incompatible Chat operations perform an explicit persisted preset switch, and dashboard preset editing uses named operations instead of callback mutators.

## Product Decisions

- A compatible selected Chat-session preset remains selected.
- A Chat, Plan, or Repo Search operation with an incompatible selected preset explicitly switches to the corresponding built-in `chat`, `plan`, or `repo-search` preset.
- The selected preset switch is included in the existing returned session payload. Streaming endpoints continue emitting progress, warnings, and results, then include the updated session in the terminal `done` event.
- Explicit unknown preset IDs supplied to session create/update or execution boundaries are rejected. They never become persisted session state.
- Missing built-in transition presets fail with a clear error. No execution path selects an arbitrary first compatible preset.
- `executeRepoSearchRequest` owns preset prompt composition. Callers do not resend a selected preset's prompt prefix.
- Dashboard preset edits use named operations. Domain updater callbacks are not passed through component or controller boundaries.

## Strict Preset Resolution

Add strict preset helpers in `src/presets.ts`:

```ts
export function requirePresetById(
  presets: readonly SiftPreset[],
  presetId: string,
): SiftPreset;

export function requirePresetKind(
  presets: readonly SiftPreset[],
  presetId: string,
  allowedKinds: readonly PresetKind[],
): SiftPreset;
```

`requirePresetById` throws `Preset '<id>' was not found.`. `requirePresetKind` first requires the exact ID, then throws a message naming the incompatible kind and allowed kinds.

Chat route code uses one explicit operation selector:

```ts
type ChatPresetOperation = 'chat' | 'plan' | 'repo-search';

type SelectedChatOperationPreset = {
  preset: SiftPreset;
  session: ChatSession;
};
```

The selector keeps the current preset when its kind supports the requested operation. Otherwise it requires the operation's exact built-in preset and returns a session copy whose `presetId` and derived `mode` fields describe that built-in. This is an explicit state transition, not a fallback lookup.

Compatibility rules are:

- `chat`: `chat` or `summary`
- `plan`: `plan`
- `repo-search`: `repo-search`

Session creation uses the requested preset when present. An omitted preset uses the explicit built-in `chat` default. An unknown requested preset fails. Session updates reject unknown preset IDs and persist only a required exact preset.

Delete:

- `resolveRepoSearchRoutePreset`
- arbitrary compatible-preset searches
- `preset?.id || ...` and `chatPreset?.id || ...` execution defaults
- persistence expressions that select among the resolved preset, stale session preset, and hardcoded ID

## Complete Preset-Fallthrough Audit

Strictness applies beyond the Chat route:

- `getPresetKind` and `getPresetExecutionOperationMode` require an exact preset instead of returning `chat` or `summary` for a missing ID.
- Delete the unused `getPresetExecutionFamily` fallback helper.
- `SummaryRequestRunner`, `executeRepoSearchRequest`, `StatusPresetRunner`, and prompt-context construction use `requirePresetById` at explicit-ID boundaries.
- Dashboard `getPresetFamily` derives the family only from the exact configured session preset. It returns `null` while configuration is unavailable or when server state is invalid; it never consults the legacy `mode` field.
- Dashboard `getDefaultWebPresetId` returns `null` when no web preset exists instead of returning the hardcoded `chat` ID. Session creation waits for an explicit configured preset.
- `useChatController` does not choose a preset by session mode or the first web preset when the session preset is missing.
- Remove `buildFallbackPromptContext`; the dashboard shows prompt-context loading/unavailable state until the server supplies the authoritative context instead of synthesizing guessed prompt, kind, tools, or context flags.
- Session `mode` remains a derived response/display field for the existing UI contract, but it is never used to recover or select a preset.

Configured-default selection is not an ID fallthrough: `resolveSummaryPreset` may continue selecting the preset explicitly marked `useForSummary`. The dashboard passes its configured default web preset explicitly when creating a session; the server uses built-in `chat` only when the create request omits an ID. Unknown non-empty IDs always fail.

## Streaming and Session Updates

The operation selector runs before engine execution. The selected session copy is the session used to build prompts and the session passed to persistence after a successful run.

Non-streaming endpoints return the existing response shape built from the selected session after messages are appended.

Streaming endpoints retain their current event order:

1. startup-context `warning` events
2. model/tool progress events
3. answer/result events
4. terminal `done`

The `done` payload is built from the persisted selected session, so the dashboard receives the switched `presetId` and `mode` without a second request. Failures keep the existing error-stream behavior and do not persist a partially completed turn.

## Single Prompt Owner

`executeRepoSearchRequest` resolves the required preset and composes the final system prompt once.

For repo-agent, plan, and repo-search:

```text
preset prompt prefix
additional request prefix, when genuinely supplied by the public request
task or agent system prompt
preset system context
```

For direct Chat:

```text
preset prompt prefix
base Chat system prompt
preset system context
```

The internal repo execution request renames `promptPrefix` to `additionalPromptPrefix` so callers cannot confuse the preset-owned prefix with a genuine request addition. The public HTTP field may remain `promptPrefix`; its route normalizer maps it to `additionalPromptPrefix`.

`StatusPresetRunner` and Chat plan/search routes pass only `presetId`. Direct Chat routes call `buildChatSystemContent` without injecting the preset prefix; the executor adds it.

`buildChatPromptContext` uses the same composition rules so displayed and submitted system prompts remain identical.

## Explicit Dashboard Preset Editing

Remove `updatePresetDraft(presetId, updater)` from `useSettingsController` and `PresetsSectionProps`.

Expose named operations:

```ts
setPresetLabel(presetId: string, value: string): void;
setPresetKind(presetId: string, value: PresetKind): void;
setPresetOperationMode(presetId: string, value: PresetOperationMode): void;
togglePresetTool(presetId: string, tool: PresetToolName): void;
setPresetDescription(presetId: string, value: string): void;
setPresetPromptPrefix(presetId: string, value: string): void;
setPresetSurfaceEnabled(presetId: string, surface: PresetSurface, enabled: boolean): void;
setPresetAgentsMdEnabled(presetId: string, enabled: boolean): void;
setPresetRepoFileListingEnabled(presetId: string, enabled: boolean): void;
setPresetAutoloadFile(presetId: string, index: number, value: string): void;
addPresetAutoloadFile(presetId: string): void;
removePresetAutoloadFile(presetId: string, index: number): void;
setDefaultSummaryPreset(presetId: string, enabled: boolean): void;
```

React state-setter callbacks remain private implementation details inside the controller. Components receive named operations only; no domain mutation callback crosses the controller/component boundary.

## Error Handling

- Unknown preset: fail with the exact requested ID.
- Incompatible preset at a strict execution boundary: fail with actual and allowed preset kinds.
- Missing required built-in during an explicit Chat operation switch: fail before model execution.
- Invalid autoload files remain nonfatal startup-context warnings.
- No resolver accepts an empty ID and silently substitutes another preset.

## Testing

Follow TDD with focused behavior tests:

- Repo execution composes a preset prefix exactly once when no additional prefix exists.
- A genuine additional prefix follows the preset prefix exactly once.
- Direct Chat receives its preset prefix through the executor, not its caller.
- Compatible custom Chat/Plan/Repo Search presets remain selected.
- Incompatible session presets switch to the exact built-in operation preset.
- Stream terminal `done` payloads contain the switched `presetId` and `mode`.
- Unknown create/update/execution preset IDs fail.
- Missing built-in transition presets fail; no arbitrary compatible preset is selected.
- Source-contract tests find no `resolveRepoSearchRoutePreset`, `?.id ||` preset defaults, or preset-prefix forwarding from preset-aware callers.
- Dashboard tests cover unavailable configuration and unknown session preset state without deriving a family, preset, or synthetic prompt context.
- Preset editor component tests exercise every named operation and confirm no updater callback prop remains.

Run focused tests after each red-green cycle, then full typecheck, coverage, tests, build, and `git diff --check`.

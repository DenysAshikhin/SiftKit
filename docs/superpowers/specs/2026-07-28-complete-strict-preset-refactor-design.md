# Complete Strict Preset Refactor Design

## Goal

Finish the preset refactor so configuration never repairs or substitutes presets, every model prompt has one composition owner, dashboard settings never pass mutation callbacks, and Chat Plan/Repo Search routes share one execution and persistence path while preserving all SSE progress.

## Product Decisions

- A new configuration is created with the complete built-in preset catalog.
- A persisted catalog must contain every complete built-in preset and may contain complete custom presets.
- Persisted catalogs are never supplemented, repaired, or translated.
- Invalid, duplicate, missing, or incomplete presets fail with a specific configuration error.
- Exactly one preset has `useForSummary: true`, and that preset has `presetKind: 'summary'`.
- `executionFamily` is removed from contracts, persisted JSON, dashboard state, and tests.
- `presetKind` and `operationMode` are required and are never derived from other fields.
- `ChatSession.mode` remains a derived response/persistence field for current UI behavior. It never selects a preset and is never accepted as a preset update input. Rename its mapper to describe derivation rather than legacy compatibility.
- Summary prompts use the same preset/context composition rules as repo and Chat prompts.
- Dashboard components submit typed data operations. No component or controller boundary accepts an updater function.
- Chat Plan and Repo Search use one shared execution/persistence class. Streaming and non-streaming endpoints differ only in transport and progress-writer selection.
- Streaming continues forwarding every current progress event. The terminal `done` event contains the persisted, authoritative session returned by the shared runner.
- No compatibility shim, dual path, generic command bus, endpoint framework, or function-valued strategy is added.

## Strict Preset Catalog

### Runtime schema

`@siftkit/contracts` remains the source of runtime validation and inferred preset types.

`SiftPresetSchema` becomes strict and removes `executionFamily`. Add `SiftPresetCollectionSchema` for array-level structural validation:

- normalized non-empty IDs;
- unique IDs;
- complete preset objects;
- exactly one `useForSummary`;
- the summary default has `presetKind: 'summary'`.

Catalog-specific built-in invariants remain in the application because built-in IDs and defaults are application policy:

- `summary`, `chat`, `plan`, `repo-search`, and `repo-agent` all exist;
- each required built-in has `builtin: true` and `deletable: false`;
- custom presets have `builtin: false` and `deletable: true`;
- a custom preset cannot reuse a built-in ID.

### `PresetCatalog`

Create a reusable `PresetCatalog` class in `src/preset-catalog.ts`.

Construction paths are explicit:

```ts
PresetCatalog.createDefault(): PresetCatalog
PresetCatalog.parse(input: OptionalJsonValue): PresetCatalog
PresetCatalog.fromPresets(presets: readonly SiftPreset[]): PresetCatalog
```

`createDefault` is the only path that creates built-ins. `parse` and `fromPresets` validate the supplied collection without adding, changing, or dropping records.

The catalog owns:

```ts
list(): SiftPreset[]
requireById(presetId: string): SiftPreset
requireKind(presetId: string, allowedKinds: readonly PresetKind[]): SiftPreset
requireSummaryDefault(): SiftPreset
forSurface(surface: PresetSurface): SiftPreset[]
deriveChatSessionMode(presetId: string): 'chat' | 'plan' | 'repo-search'
```

Returned presets are cloned so callers cannot mutate catalog state.

Delete permissive preset normalization:

- `normalizePresets`;
- `normalizePresetRecord`;
- `normalizeUserPreset`;
- `getLegacyExecutionFamily`;
- fallback-based kind and operation-mode derivation;
- automatic summary-default repair;
- the compatibility addition of `json_get` to incomplete tool policies;
- fallback tool/surface/default-field repair at persisted boundaries.

Default config creation uses `PresetCatalog.createDefault().list()`. Config file, database, HTTP update, summary, repo, Chat, and dashboard boundaries use `PresetCatalog.parse` or `fromPresets`.

No migration translates legacy `executionFamily` records. A persisted legacy catalog fails with the exact Zod/configuration issue path.

## Summary Prompt Composition

`PresetSystemPromptComposer` remains the sole owner of preset-prefix, additional-prefix, base-instruction, and startup-context ordering:

```text
preset instructions
additional request instructions
base execution instructions
startup context
user input
```

The summary prompt builders currently combine instructions and input in one string. Split them into explicit sections:

```ts
buildSummarySystemInstructions(options): string
buildSummaryInputSection(options): string
buildSummaryPrompt(options): string
```

`buildSummaryPrompt` constructs the final request:

```ts
const instructions = composer.compose(
  buildSummarySystemInstructions(options),
  options.additionalPromptPrefix,
);
return [instructions, buildSummaryInputSection(options)].filter(Boolean).join('\n\n');
```

Apply the same structure to compact, chunk, merge, and planner summary prompts. Each independent model request receives the preset instructions and startup context exactly once. The raw context is never flattened into a field named `promptPrefix`.

`SummaryRequestRunner` resolves the exact preset through `PresetCatalog`, builds `PresetSystemContext`, reports warnings, and passes structured composition inputs to the summary core. It does not concatenate prompt text.

## Dashboard Settings Mutation

### Data actions

Create `dashboard/src/settings-draft-editor.ts` with:

```ts
export class DashboardSettingsDraftEditor {
  constructor(config: DashboardConfig);
  apply(action: DashboardSettingsDraftAction): void;
  getConfig(): DashboardConfig;
}
```

`DashboardSettingsDraftAction` is a discriminated union of data, not functions. It covers:

- general configuration;
- operation-mode tool policy;
- interactive settings;
- web-search settings;
- preset fields, surfaces, tools, summary selection, and autoload files;
- active model-preset selection;
- model runtime strings, nullable strings, integers, floats, booleans, reasoning, speculative type, and coupled reasoning/speculative transitions;
- adding and deleting regular and model presets.

Every action branch is explicit. Fields are grouped only where they share the same runtime type and assignment rules. Coupled behavior such as clearing `PreserveThinking` when `ReasoningContent` is disabled has its own action.

The class clones once, applies one action, enforces preset/model existence and index validity, synchronizes derived runtime fields, and returns the resulting config.

Delete `DashboardPresetDraftEditor` after moving its behavior into the unified editor. Delete callback-based helpers such as `updateActiveModelPreset` if they have no non-callback consumer.

### React boundary

`useSettingsController` has one internal data commit:

```ts
function applySettingsAction(action: DashboardSettingsDraftAction): void
```

It is the only function that calls `setDashboardConfig` for draft edits and clears `settingsSavedAtUtc`.

The controller exposes section-scoped objects with named methods:

```ts
generalActions
toolPolicyActions
presetActions
interactiveActions
webSearchActions
modelPresetActions
```

Named methods create typed action values and call `applySettingsAction`. They never accept a function.

`SettingsTab`, `ToolPolicyMatrix`, `PresetsSection`, and `ModelPresetsSection` consume only the relevant named action object. Remove:

- `updateSettingsDraft`;
- `updatePresetDraft`;
- `updateModelPresetDraft`;
- inline `(next) => { ... }` domain mutation callbacks;
- thirteen repeated preset `setDashboardConfig` blocks.

React DOM event handlers remain ordinary event handlers; the prohibition applies to domain/config mutation functions passed as values.

## Shared Chat Repo Operation

Create `src/status-server/chat-repo-operation-runner.ts`.

`ChatRepoOperationRunner` owns the behavior duplicated by non-stream Plan, streamed Plan, and streamed Repo Search:

- exact preset transition through `ChatOperationPresetSelector`;
- selected-session repo-root update;
- operation-specific prompt construction;
- effective tool selection;
- model and turn-limit selection;
- engine invocation;
- operation-specific assistant markdown;
- speculative and token metrics;
- persisted thinking/tool turns;
- authoritative session persistence;
- repo-search response metadata.

It exposes explicit methods rather than accepting formatter or selector functions:

```ts
runPlan(request: ChatRepoOperationRequest): Promise<ChatRepoOperationResult>
runRepoSearch(request: ChatRepoOperationRequest): Promise<ChatRepoOperationResult>
```

Both methods use a private operation switch over data. `ChatRepoOperationRequest` carries concrete collaborators such as the engine service and progress writer, never function-valued strategies.

The result is transport-neutral:

```ts
type ChatRepoOperationResult = {
  updatedSession: ChatSession;
  repoSearch: {
    requestId: string;
    transcriptPath: string | null;
    artifactPath: string | null;
    scorecard: RepoSearchScorecard;
  };
};
```

HTTP endpoints retain:

- request/body parsing;
- session lookup;
- repo-root validation;
- model-lock acquisition/release;
- model readiness errors;
- JSON or SSE framing.

The non-stream Plan endpoint calls `runPlan` with `RepoSearchToolLogProgressWriter` and sends JSON from the result.

The streamed Plan endpoint calls `runPlan` with `ChatStreamProgressWriter`. The streamed Repo Search endpoint calls `runRepoSearch` with `ChatStreamProgressWriter`. Both forward all writer events unchanged and emit `done` from `updatedSession` plus `repoSearch`.

No base endpoint, generic route framework, callback formatter, or compatibility wrapper is introduced.

## Error Handling

- Invalid preset JSON reports schema paths and never returns default presets.
- Missing or duplicate built-ins report their exact IDs.
- Zero or multiple summary defaults report the conflicting IDs.
- Unknown preset IDs and incompatible kinds retain exact fail-loud errors.
- Missing sessions, invalid repo roots, lock failures, and model readiness failures retain current HTTP statuses.
- Runner failures propagate to the endpoint. JSON endpoints return the existing error response; SSE endpoints emit the existing `error` event and close.
- Startup-context file warnings remain nonfatal and continue through CLI, logs, and SSE.
- Settings actions throw for unknown preset/model IDs and invalid autoload indices; controller error boundaries surface programming errors rather than silently ignoring them.

## Testing

Follow TDD for every task.

### Preset catalog

- Contract tests reject `executionFamily`, missing fields, malformed IDs, and unknown keys.
- Catalog tests cover valid defaults, complete custom presets, duplicate IDs, missing built-ins, invalid built-in flags, custom/built-in collisions, zero/multiple summary defaults, wrong-kind summary default, exact lookup, kind validation, surfaces, and derived Chat mode.
- Config/database/HTTP tests prove invalid persisted catalogs fail and defaults are created only for a new config.
- Delete tests that expect legacy migration or silent repair.

### Prompt composition

- Unit tests assert exact section order and one occurrence of every section.
- Summary integration tests capture direct, compact, chunk, merge, and planner requests.
- Tests assert startup context follows base instructions and precedes user input.
- Warning and no-warning branches remain covered.

### Settings

- Editor tests cover every discriminated action and every rejection branch.
- Controller/component tests prove named action objects are wired to each section.
- Source-contract tests assert updater-function props and callback mutation helpers are absent.
- Dashboard typecheck provides end-to-end action-type coverage.

### Chat operations

- Runner tests prove Plan and Repo Search select/persist the authoritative preset and produce equivalent metadata.
- HTTP/SSE E2E tests compare non-stream and stream Plan results.
- Stream tests assert every intermediate event remains present and ordered, warnings are forwarded, and terminal `done` contains the persisted switched session.
- Repo Search stream tests assert the same persistence and terminal guarantees.
- Error tests cover engine failure, session disappearance after lock acquisition, invalid repo root, and client disconnect.

### Completion

- Run focused tests after every task.
- Run branch coverage and add cases for every new strict validation and operation branch.
- Run full typecheck/lint, tests, production build, `git diff --check`, and obsolete-symbol scans.
- The final scan must find no `executionFamily`, `normalizePresets`, legacy preset derivation, domain updater callbacks, manual summary context concatenation, or duplicated Chat repo execution/persistence blocks.

## Out of Scope

- Removing `ChatSession.mode`; it remains derived and non-authoritative.
- Changing SSE event names or payloads other than sourcing terminal data from the shared runner.
- Generalizing all status-server endpoints.
- Changing model-runtime preset semantics beyond replacing callback mutation.
- Supporting old partial preset records or translating legacy `executionFamily`.

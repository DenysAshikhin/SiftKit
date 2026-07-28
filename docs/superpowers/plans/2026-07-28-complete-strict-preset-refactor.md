# Complete Strict Preset Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make preset configuration fail-loud and complete, centralize preset/context prompt composition, replace dashboard mutation callbacks with typed actions, and share Chat Plan/Repo Search execution and persistence.

**Architecture:** `@siftkit/contracts` validates complete preset records and collection structure. `PresetCatalog` adds application policy for built-ins and provides all lookup/derivation operations. Summary prompt builders receive structured composition data. `DashboardSettingsDraftEditor` is the only dashboard draft mutator. `ChatRepoOperationRunner` owns transport-neutral Plan/Repo Search execution and persistence while route classes retain HTTP/SSE framing.

**Tech Stack:** TypeScript 5.9, Zod 4, Node test runner, React 19, SQLite, SSE.

## Global Constraints

- Follow strict red-green-refactor TDD for every behavior change.
- Do not retain `executionFamily`, preset repair, migration, shims, updater callbacks, or duplicate execution paths.
- Do not use type assertions, `any`, non-null assertions, namespace imports, or function-valued domain strategies.
- Keep explicit class methods, reuse existing helpers, and avoid endpoint/framework generalization.
- Preserve all existing SSE event names, ordering, warnings, statuses, locks, and disconnect behavior.
- Do not modify or stage the pre-existing `package-lock.json` change.

---

### Task 1: Strict preset contract and catalog

**Files:**
- Modify: `packages/contracts/src/config.ts`
- Create: `src/preset-catalog.ts`
- Modify: `src/presets.ts`
- Modify: `src/config/defaults.ts`
- Modify: `src/config/normalization.ts`
- Modify: `src/status-server/config-store.ts`
- Modify: `src/state/runtime-db.ts`
- Modify: preset consumers under `src/cli`, `src/repo-search`, `src/status-server`, and test helpers
- Test: `tests/contracts-config.test.ts`
- Replace: `tests/presets.test.ts`
- Modify: config/database/HTTP preset tests

**Interfaces:**
- Produces: `SiftPresetCollectionSchema`.
- Produces: `PresetCatalog.createDefault()`, `PresetCatalog.parse(input)`, `PresetCatalog.fromPresets(presets)`.
- Produces: `list`, `requireById`, `requireKind`, `requireSummaryDefault`, `forSurface`, and `deriveChatSessionMode`.
- Retains in `src/presets.ts`: operation-mode tool policy defaults and `resolvePresetAllowedTools`.

- [ ] **Step 1: Write contract tests that fail on `executionFamily`, unknown fields, missing fields, malformed IDs, duplicate IDs, invalid summary counts, and a non-summary default**

Use complete literal preset fixtures. Assert `safeParse(...).success === false` and exact issue paths such as `[0, 'id']`, `[1, 'id']`, and `[index, 'presetKind']`.

- [ ] **Step 2: Run the contract tests and verify RED**

Run: `npm test -- contracts-config`

Expected: FAIL because `executionFamily` is accepted and collection validation does not exist.

- [ ] **Step 3: Make the contract strict**

Define:

```ts
export const SiftPresetSchema = z.object({
  id: z.string().trim().min(1).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  label: z.string(),
  description: z.string(),
  presetKind: PresetKindSchema,
  operationMode: PresetOperationModeSchema,
  promptPrefix: z.string(),
  allowedTools: z.array(PresetToolNameSchema),
  surfaces: z.array(PresetSurfaceSchema),
  useForSummary: z.boolean(),
  builtin: z.boolean(),
  deletable: z.boolean(),
  includeAgentsMd: z.boolean(),
  includeRepoFileListing: z.boolean(),
  autoloadFiles: z.array(z.string()),
  repoRootRequired: z.boolean(),
  maxTurns: z.number().int().positive().nullable(),
}).strict();
```

Add `SiftPresetCollectionSchema` with `superRefine` for duplicate IDs, exactly one summary default, and summary-default kind.

- [ ] **Step 4: Run the contract tests and verify GREEN**

Run: `npm test -- contracts-config`

Expected: PASS.

- [ ] **Step 5: Write failing `PresetCatalog` tests**

Cover cloned defaults, complete custom presets, every required built-in, built-in/custom flags, collisions, exact lookup errors, kind errors, surface filtering, summary lookup, Chat mode derivation, and input immutability.

- [ ] **Step 6: Run catalog tests and verify RED**

Run: `npm test -- presets`

Expected: FAIL because `PresetCatalog` does not exist.

- [ ] **Step 7: Implement `PresetCatalog` and reduce `src/presets.ts`**

Use the contract schema as the only record/collection parser. Build defaults only inside `createDefault`. Clone all array fields on input/output. Throw explicit errors naming missing IDs, invalid built-in flags, and invalid custom flags.

- [ ] **Step 8: Run catalog tests and verify GREEN**

Run: `npm test -- presets`

Expected: PASS.

- [ ] **Step 9: Write failing persisted-boundary tests**

Prove new config creation persists all defaults, while malformed JSON, missing built-ins, duplicate built-ins, incomplete presets, and `executionFamily` fail through config normalization, SQLite reads, and HTTP PUT.

- [ ] **Step 10: Run boundary tests and verify RED**

Run: `npm test -- config-normalization config-store dashboard-status-server`

Expected: FAIL because normalization and SQLite reads still repair catalogs.

- [ ] **Step 11: Replace every normalization call with catalog parsing**

Use `PresetCatalog.createDefault().list()` only in `getDefaultConfigObject`. Parse the original supplied `Presets` before config default merging. Let SQLite JSON/schema failures propagate. Remove preset rewriting from runtime migrations. Update repo, summary, Chat, CLI, and dashboard consumers to construct a catalog explicitly.

- [ ] **Step 12: Run focused preset/config tests and typecheck**

Run: `npm test -- presets contracts-config config-normalization config-store dashboard-status-server chat-operation-preset preset-runner repo-search-chat-execute`

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 13: Commit the strict catalog slice**

```powershell
git add packages/contracts/src/config.ts src/preset-catalog.ts src/presets.ts src/config/defaults.ts src/config/normalization.ts src/status-server/config-store.ts src/state/runtime-db.ts src tests dashboard
git commit -m "refactor: enforce strict preset catalogs"
```

### Task 2: Structured summary prompt composition

**Files:**
- Modify: `src/summary/prompt.ts`
- Modify: `src/summary/planner/prompts.ts`
- Modify: `src/summary/planner/mode.ts`
- Modify: `src/summary/chunking.ts`
- Modify: `src/summary/core-runner.ts`
- Modify: `src/summary/request-runner.ts`
- Test: `tests/runtime-summarize.test.ts`
- Test: `tests/summary-request-runner.test.ts`
- Test: `tests/summary-planner-runtime.test.ts`
- Test: `tests/runtime-planner-token-aware.test.ts`

**Interfaces:**
- Consumes: `PresetCatalog` and `PresetSystemPromptComposer`.
- Produces: `buildSummarySystemInstructions`, `buildSummaryInputSection`, and `buildSummaryPrompt`.
- Produces planner system-instruction and input-section builders using the same composer inputs.

- [ ] **Step 1: Write failing exact-order prompt tests**

Assert:

```text
preset instructions
additional request instructions
base execution instructions
startup context
user input
```

Assert each sentinel appears exactly once for compact, direct, chunk, merge, and planner requests.

- [ ] **Step 2: Run prompt tests and verify RED**

Run: `npm test -- runtime-summarize summary-request-runner summary-planner-runtime runtime-planner-token-aware`

Expected: FAIL because summary startup context is flattened into `promptPrefix`.

- [ ] **Step 3: Split prompt builders and thread structured composition inputs**

Replace summary-core `promptPrefix` with `presetPromptPrefix`, `additionalPromptPrefix`, and `systemContext`. Build every final prompt through `PresetSystemPromptComposer`; append only the input section afterward. Planner system messages use the same composer and keep the initial user prompt separate.

- [ ] **Step 4: Run prompt tests and verify GREEN**

Run: `npm test -- runtime-summarize summary-request-runner summary-planner-runtime runtime-planner-token-aware preset-system-prompt preset-system-context`

Expected: PASS with warning/no-warning branches covered.

- [ ] **Step 5: Commit the prompt slice**

```powershell
git add src/summary tests/runtime-summarize.test.ts tests/summary-request-runner.test.ts tests/summary-planner-runtime.test.ts tests/runtime-planner-token-aware.test.ts
git commit -m "refactor: compose summary preset prompts once"
```

### Task 3: Typed dashboard settings actions

**Files:**
- Create: `dashboard/src/settings-draft-editor.ts`
- Delete: `dashboard/src/preset-draft-editor.ts`
- Modify: `dashboard/src/preset-editor.ts`
- Modify: `dashboard/src/model-runtime-presets.ts`
- Modify: `dashboard/src/hooks/useSettingsController.ts`
- Modify: `dashboard/src/tabs/SettingsTab.tsx`
- Modify: `dashboard/src/tabs/settings/ToolPolicyMatrix.tsx`
- Modify: `dashboard/src/tabs/settings/PresetsSection.tsx`
- Modify: `dashboard/src/tabs/settings/ModelPresetsSection.tsx`
- Replace: `dashboard/tests/preset-draft-editor.test.ts`
- Modify: dashboard controller/component/source-contract tests

**Interfaces:**
- Produces: discriminated `DashboardSettingsDraftAction`.
- Produces: `DashboardSettingsDraftEditor.apply(action)` and `getConfig()`.
- Produces: `generalActions`, `toolPolicyActions`, `presetActions`, `interactiveActions`, `webSearchActions`, and `modelPresetActions`.

- [ ] **Step 1: Write failing editor tests for every action and rejection branch**

Use table-driven literal expectations for general fields, operation tools, interactive fields, web search, all preset fields, summary selection, autoload indices, active model selection, every model runtime value category, coupled reasoning/speculative transitions, and add/delete operations.

- [ ] **Step 2: Run editor tests and verify RED**

Run: `npm test -- settings-draft-editor`

Expected: FAIL because the unified editor does not exist.

- [ ] **Step 3: Implement the discriminated action union and unified editor**

Clone once in the constructor, use an explicit `switch (action.type)`, enforce IDs/indices, and call `syncDerivedSettingsFields` in `getConfig`. Remove `executionFamily` assignment and callback helpers.

- [ ] **Step 4: Run editor tests and verify GREEN**

Run: `npm test -- settings-draft-editor`

Expected: PASS.

- [ ] **Step 5: Write failing controller/component/source-contract tests**

Require each section-scoped action object, assert visible controls invoke the named methods with typed data, and scan dashboard production source for updater-function props and removed callback helper names.

- [ ] **Step 6: Run dashboard tests and verify RED**

Run: `npm test -- dashboard-settings-controller settings-tab presets-section model-preset-groups-component tool-policy-matrix-component`

Expected: FAIL while callback props remain.

- [ ] **Step 7: Refactor the controller and components**

Make `applySettingsAction(action)` the sole draft `setDashboardConfig` call. Named methods construct data actions. Keep React DOM handlers local but pass only section-scoped action objects through component boundaries.

- [ ] **Step 8: Run dashboard tests and typecheck**

Run: `npm test -- dashboard-settings-controller settings-tab presets-section model-preset-groups-component tool-policy-matrix-component settings-draft-editor`

Run: `npm run typecheck:dashboard-test`

Run: `npm --prefix dashboard run build`

Expected: PASS.

- [ ] **Step 9: Commit the dashboard slice**

```powershell
git add dashboard tests/dashboard-settings-controller.test.ts tests/dashboard-model-presets-section.test.ts
git commit -m "refactor: use typed dashboard settings actions"
```

### Task 4: Shared Chat Plan/Repo Search runner

**Files:**
- Create: `src/status-server/chat-repo-operation-runner.ts`
- Modify: `src/status-server/chat-operation-preset.ts`
- Modify: `src/status-server/routes/chat.ts`
- Test: `tests/chat-repo-operation-runner.test.ts`
- Modify: `tests/status-server-chat.test.ts`
- Modify: `tests/streamed-repo-search-endpoint.test.ts`

**Interfaces:**
- Consumes: `PresetCatalog`, `ChatOperationPresetSelector`, `StatusEngineService`, and a concrete progress writer.
- Produces: `runPlan(request)` and `runRepoSearch(request)`.
- Produces: `{ updatedSession, repoSearch: { requestId, transcriptPath, artifactPath, scorecard } }`.

- [ ] **Step 1: Write failing runner tests**

For Plan and Repo Search, assert exact preset transition, repo root, prompt, allowed tools, model/max turns, persisted user/assistant/thinking/tool turns, metrics, authoritative reloaded session, and equivalent metadata. Add engine failure coverage.

- [ ] **Step 2: Run runner tests and verify RED**

Run: `npm test -- chat-repo-operation-runner`

Expected: FAIL because the runner does not exist.

- [ ] **Step 3: Implement the transport-neutral runner**

Use explicit public methods and a private operation data switch. Capture metrics, execute through `StatusEngineService`, append/persist messages once, reload the authoritative session, and return the normalized metadata. Do not accept formatter, selector, persistence, or callback strategies.

- [ ] **Step 4: Run runner tests and verify GREEN**

Run: `npm test -- chat-repo-operation-runner`

Expected: PASS.

- [ ] **Step 5: Write failing HTTP/SSE equivalence and event-order tests**

Compare JSON Plan and SSE Plan terminal sessions. Assert every intermediate tool/thinking/answer/warning event remains ordered, Repo Search persists its selected preset, and `done` contains the persisted session.

- [ ] **Step 6: Run route tests and verify RED**

Run: `npm test -- status-server-chat streamed-repo-search-endpoint`

Expected: FAIL until all three routes use the shared runner.

- [ ] **Step 7: Replace duplicated route blocks**

Keep parsing, repo validation, locking, readiness, HTTP status handling, SSE open/error/end, and progress writer construction in the endpoints. Delegate execution/persistence to `runPlan` or `runRepoSearch`; serialize only the returned result.

- [ ] **Step 8: Run route and runner tests**

Run: `npm test -- chat-repo-operation-runner status-server-chat streamed-repo-search-endpoint chat-operation-preset`

Expected: PASS.

- [ ] **Step 9: Commit the shared runner slice**

```powershell
git add src/status-server/chat-repo-operation-runner.ts src/status-server/chat-operation-preset.ts src/status-server/routes/chat.ts tests
git commit -m "refactor: share chat repo operation execution"
```

### Task 5: Coverage and completion gates

**Files:**
- Modify only files required by failing verification.

- [ ] **Step 1: Run branch coverage**

Run: `npm run test:coverage`

Expected: PASS with every new validation/action/operation branch exercised; add behavior tests for uncovered branches.

- [ ] **Step 2: Run full static and runtime validation**

Run: `npm run typecheck`

Run: `npm test`

Run: `npm run build`

Run: `git diff --check`

Expected: all commands exit 0.

- [ ] **Step 3: Scan for obsolete symbols and duplicate ownership**

Run:

```powershell
rg -n "executionFamily|normalizePresets|normalizePresetRecord|normalizeUserPreset|getLegacyExecutionFamily|updateSettingsDraft|updatePresetDraft|updateModelPresetDraft|updateActiveModelPreset|promptPrefix:\s*systemContext|mapPresetIdToLegacyMode" packages src dashboard tests
```

Expected: no matches.

Inspect `src/status-server/routes/chat.ts` to confirm there is one engine invocation/persistence implementation for Plan/Repo Search, inside `ChatRepoOperationRunner`.

- [ ] **Step 4: Verify repository state**

Run: `git status --short --branch`

Expected: only intentional refactor commits/files plus the pre-existing unstaged `package-lock.json`.
